'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS = 730;
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
async function expected(region, c, currency='USD') {
  const sku = c.tier === 'global' ? 'Global' : 'Standard';
  const meter = c.tier === 'global' ? 'Global Static Public IP' : 'Standard Static IP Addresses';
  const rows = dedupe(await query(`serviceName eq 'Virtual Network' and armRegionName eq '${region}' and productName eq 'Public IP Prefix' and skuName eq '${sku}'`, currency));
  const row=pick(rows,x=>x.type==='Consumption'&&x.meterName===meter, meter);
  const count = c.addresses * (c.prefixes ?? 1); const h=c.hours ?? HOURS;
  const l=line(`${sku} public IP prefix (${count} addresses) @ ${h} h`, row, h*count, h*count*row.retailPrice/unitSize(row.unitOfMeasure));
  return { monthlyList: l.monthlyList, lines:[l] };
}
module.exports = { type: 'public-ip-prefix', source: 'both', cases: [
  { name: 'standard two addresses', region: 'eastus2', currency: 'USD', component: { type: 'public-ip-prefix', addresses: 2, prefixes: 1, tier: 'standard' },
    // Public IP Prefix uses productName Public IP Prefix / Standard Static IP Addresses at $0.006 per address-hour.
    expected: () => expected('eastus2', { addresses: 2, prefixes: 1, tier: 'standard' }) },
  { name: 'standard four addresses two prefixes', region: 'eastus2', currency: 'USD', component: { type: 'public-ip-prefix', addresses: 4, prefixes: 2, tier: 'standard' },
    // Standard prefix meter is multiplied by the total addresses across all prefixes.
    expected: () => expected('eastus2', { addresses: 4, prefixes: 2, tier: 'standard' }) },
  { name: 'standard eight part-time', region: 'eastus2', currency: 'USD', component: { type: 'public-ip-prefix', addresses: 8, prefixes: 1, tier: 'standard', hours: 100 },
    // Part-time case uses the same Public IP Prefix hourly meter for only 100 hours.
    expected: () => expected('eastus2', { addresses: 8, prefixes: 1, tier: 'standard', hours: 100 }) },
  { name: 'standardv2 same price', region: 'westeurope', currency: 'USD', component: { type: 'public-ip-prefix', addresses: 32, prefixes: 1, tier: 'standardv2' },
    // Standard v2 prefixes are priced at the same Standard Static IP Addresses prefix meter.
    expected: () => expected('westeurope', { addresses: 32, prefixes: 1, tier: 'standardv2' }) },
  { name: 'global sixteen addresses', region: 'eastus2', currency: 'USD', component: { type: 'public-ip-prefix', addresses: 16, prefixes: 1, tier: 'global' },
    // Global tier uses Public IP Prefix / Global Static Public IP at $0.012 per address-hour.
    expected: () => expected('eastus2', { addresses: 16, prefixes: 1, tier: 'global' }) },
  { name: 'non-US standard', region: 'westeurope', currency: 'USD', component: { type: 'public-ip-prefix', addresses: 4, prefixes: 1, tier: 'standard' },
    // Standard Public IP Prefix meter is pinned to westeurope for the non-US case.
    expected: () => expected('westeurope', { addresses: 4, prefixes: 1, tier: 'standard' }) },
  { name: 'EUR global', region: 'westeurope', currency: 'EUR', component: { type: 'public-ip-prefix', addresses: 2, prefixes: 1, tier: 'global' },
    // EUR case uses Retail Prices API currencyCode EUR for the Public IP Prefix Global meter.
    expected: () => expected('westeurope', { addresses: 2, prefixes: 1, tier: 'global' }, 'EUR') },
] };
