'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice||a.tierMinimumUnits-b.tierMinimumUnits); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
function tier(rows, qty) { const t = rows.slice().sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits); let cost=0, bands=[]; for (let i=0;i<t.length;i++){ const start=t[i].tierMinimumUnits, end=i+1<t.length?t[i+1].tierMinimumUnits:Infinity; if(qty<=start) break; const units=Math.min(qty,end)-start; cost += units * t[i].retailPrice / unitSize(t[i].unitOfMeasure); bands.push({ fromUnits:start, toUnits:end===Infinity?null:end, units, unitPrice:t[i].retailPrice }); } return { cost, bands, row: t.find(x=>x.retailPrice>0) || t[0] }; }
const CONTINENT = { eastus2:'North America', westeurope:'Europe', southeastasia:'Asia', brazilsouth:'South America' };
const INTER = { 'North America':'NAM or EU', Europe:'NAM or EU', Asia:'ASIA', Oceania:'OCEANIA', 'Middle East And Africa':'MEA', 'South America':'LATAM' };
async function expected(region, c, currency = 'USD') {
  const lines=[];
  if ((c.internetEgressGB ?? 0) > 0) {
    const rows = dedupe(await query(`serviceName eq 'Bandwidth' and armRegionName eq '${region}'`, currency)).filter(x => x.type === 'Consumption');
    const product = c.routing === 'internet' ? 'Bandwidth - Routing Preference: Internet' : 'Rtn Preference: MGN';
    const erows = rows.filter(x => x.productName === product && x.skuName === 'Standard' && x.meterName === 'Standard Data Transfer Out');
    const t = tier(erows, c.internetEgressGB); const l=line(`Internet egress ${c.internetEgressGB} GB via ${c.routing || 'microsoft'} routing`, t.row, c.internetEgressGB, t.cost); l.bands=t.bands; lines.push(l);
  }
  if ((c.interRegionGB ?? 0) > 0) {
    const continent = CONTINENT[region];
    if (c.destination === 'other-continent') {
      const group = INTER[continent];
      const rows = dedupe(await query(`serviceName eq 'Bandwidth' and armRegionName eq 'Intercontinental' and productName eq 'Bandwidth Inter-Region' and skuName eq 'Inter Continent'`, currency)).filter(x => x.type === 'Consumption' && x.meterName === `Inter Continent Data Transfer Out - ${group} To Any`);
      const t = tier(rows, c.interRegionGB); const l = line(`Inter-continent transfer ${c.interRegionGB} GB from ${continent}`, t.row, c.interRegionGB, t.cost); l.bands=t.bands; lines.push(l);
    } else {
      const rows = dedupe(await query(`serviceName eq 'Bandwidth' and armRegionName eq '${continent}' and productName eq 'Bandwidth Inter-Region' and skuName eq 'Intra Continent'`, currency)).filter(x => x.type === 'Consumption');
      const r=pick(rows, x=>x.meterName==='Intra Continent Data Transfer Out', 'intra-continent transfer');
      lines.push(line(`Same-continent inter-region transfer ${c.interRegionGB} GB from ${continent}`, r, c.interRegionGB, c.interRegionGB * r.retailPrice / unitSize(r.unitOfMeasure)));
    }
  }
  if ((c.crossZoneGB ?? 0) > 0) lines.push({ desc:`Cross-zone transfer ${c.crossZoneGB} GB (free per Learn/pricing page)`, qty:c.crossZoneGB, monthlyList:0 });
  return { monthlyList: total(lines), lines };
}
module.exports = { type: 'data-transfer', source: 'both', cases: [
  { name: 'internet below 100GB free grant', region: 'eastus2', currency: 'USD', component: { type: 'data-transfer', interRegionGB: 0, internetEgressGB: 50 },
    // Standard Data Transfer Out has a $0 band at tierMinimumUnits 0 and paid band starting at 100 GB.
    expected: () => expected('eastus2', { interRegionGB: 0, internetEgressGB: 50 }) },
  { name: 'internet just above free grant', region: 'eastus2', currency: 'USD', component: { type: 'data-transfer', interRegionGB: 0, internetEgressGB: 150 },
    // Tiered egress: first 100 GB at $0, remaining 50 GB at the first paid MGN tier.
    expected: () => expected('eastus2', { interRegionGB: 0, internetEgressGB: 150 }) },
  { name: 'graduated multi-band MGN', region: 'eastus2', currency: 'USD', component: { type: 'data-transfer', interRegionGB: 0, internetEgressGB: 12000 },
    // Walk Standard Data Transfer Out graduated bands by tierMinimumUnits after the first 100 GB free grant.
    expected: () => expected('eastus2', { interRegionGB: 0, internetEgressGB: 12000 }) },
  { name: 'internet routing preference', region: 'eastus2', currency: 'USD', component: { type: 'data-transfer', interRegionGB: 0, internetEgressGB: 12000, routing: 'internet' },
    // Internet routing preference uses productName Bandwidth - Routing Preference: Internet with its own graduated bands.
    expected: () => expected('eastus2', { interRegionGB: 0, internetEgressGB: 12000, routing: 'internet' }) },
  { name: 'same-continent and free cross-zone non-US', region: 'westeurope', currency: 'USD', component: { type: 'data-transfer', interRegionGB: 1000, destination:'same-continent', crossZoneGB: 250, internetEgressGB: 0 },
    // Same-continent Europe uses Bandwidth Inter-Region/Intra Continent; cross-zone is $0 per Learn/pricing-page FAQ.
    expected: () => expected('westeurope', { interRegionGB: 1000, destination:'same-continent', crossZoneGB: 250, internetEgressGB: 0 }) },
  { name: 'other-continent Europe graduated', region: 'westeurope', currency: 'USD', component: { type: 'data-transfer', interRegionGB: 1000, destination:'other-continent', crossZoneGB: 0, internetEgressGB: 0 },
    // Intercontinental from Europe uses Inter Continent Data Transfer Out - NAM or EU To Any, with first 5 GB at $0.
    expected: () => expected('westeurope', { interRegionGB: 1000, destination:'other-continent', crossZoneGB: 0, internetEgressGB: 0 }) },
  { name: 'same-continent Asia', region: 'southeastasia', currency: 'USD', component: { type: 'data-transfer', interRegionGB: 1000, destination:'same-continent', internetEgressGB: 0 },
    // Asia intra-continent inter-region transfer uses the Asia pseudo-region Bandwidth Inter-Region meter.
    expected: () => expected('southeastasia', { interRegionGB: 1000, destination:'same-continent', internetEgressGB: 0 }) },
  { name: 'EUR other-continent', region: 'westeurope', currency: 'EUR', component: { type: 'data-transfer', interRegionGB: 1000, destination:'other-continent', internetEgressGB: 0 },
    // EUR case repeats the intercontinental graduated-band walk using Retail Prices API currencyCode EUR.
    expected: () => expected('westeurope', { interRegionGB: 1000, destination:'other-continent', internetEgressGB: 0 }, 'EUR') },
] };
