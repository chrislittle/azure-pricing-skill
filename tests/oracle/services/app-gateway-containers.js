'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS = 730;
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice||String(a.meterId).localeCompare(String(b.meterId))); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
async function expected(region, c, currency = 'USD') {
  const product = c.waf ? 'Application Gateway for Containers WAF' : 'Application Gateway for Containers';
  const rows = dedupe(await query(`serviceName eq 'Application Gateway' and armRegionName eq '${region}' and productName eq '${product}' and skuName eq 'Standard'`, currency)).filter(x => x.type === 'Consumption');
  const h = c.hours ?? HOURS; const lines = [];
  for (const [meter, count, label] of [ ['Standard AGC',c.gateways ?? 1,'AGC'], ['Standard Frontend',c.frontends ?? 1,'frontend'], ['Standard Association',c.associations ?? 1,'association'], ['Standard Capacity Units',c.capacityUnits,'capacity unit'] ]) {
    const row = pick(rows, x => x.meterName === meter, `${product} ${meter}`);
    lines.push(line(`${product} ${label} x${count} @ ${h} h`, row, h * count, h * count * row.retailPrice / unitSize(row.unitOfMeasure)));
  }
  return { monthlyList: total(lines), lines };
}
module.exports = { type: 'app-gateway-containers', source: 'both', cases: [
  { name: 'Learn example standard = 136.51', region: 'eastus2', currency: 'USD', component: { type: 'app-gateway-containers', capacityUnits: 5, gateways: 1, frontends: 1, associations: 1 },
    // Learn example arithmetic from retail/calculator rates: (0.017 AGC + 0.01 frontend + 0.12 association + 5*0.008 CU) * 730 = 136.51.
    expected: () => expected('eastus2', { capacityUnits: 5, gateways: 1, frontends: 1, associations: 1 }) },
  { name: 'standard two gateways', region: 'eastus2', currency: 'USD', component: { type: 'app-gateway-containers', capacityUnits: 12, gateways: 2, frontends: 3, associations: 2 },
    // Standard AGC/Frontend/Association/Capacity Unit meters are all hourly and multiplied by count and 730 h.
    expected: () => expected('eastus2', { capacityUnits: 12, gateways: 2, frontends: 3, associations: 2 }) },
  { name: 'waf meters', region: 'eastus2', currency: 'USD', component: { type: 'app-gateway-containers', waf: true, capacityUnits: 5, gateways: 1, frontends: 1, associations: 1 },
    // WAF uses the separate Application Gateway for Containers WAF product with higher hourly AGC/frontend/association/CU rates.
    expected: () => expected('eastus2', { waf: true, capacityUnits: 5, gateways: 1, frontends: 1, associations: 1 }) },
  { name: 'part-time standard', region: 'eastus2', currency: 'USD', component: { type: 'app-gateway-containers', capacityUnits: 2, gateways: 1, frontends: 1, associations: 1, hours: 100 },
    // Same four hourly standard meters, using explicit 100 hours instead of 730.
    expected: () => expected('eastus2', { capacityUnits: 2, gateways: 1, frontends: 1, associations: 1, hours: 100 }) },
  { name: 'non-US region', region: 'westeurope', currency: 'USD', component: { type: 'app-gateway-containers', capacityUnits: 5, gateways: 1, frontends: 2, associations: 1 },
    // Retail API rows are pinned to westeurope; calculator v2 exposes the same offer names in USD.
    expected: () => expected('westeurope', { capacityUnits: 5, gateways: 1, frontends: 2, associations: 1 }) },
  { name: 'EUR currency WAF', region: 'westeurope', currency: 'EUR', component: { type: 'app-gateway-containers', waf: true, capacityUnits: 3, gateways: 2, frontends: 1, associations: 2 },
    // EUR case uses Retail Prices API currencyCode EUR because calculator data is USD-only.
    expected: () => expected('westeurope', { waf: true, capacityUnits: 3, gateways: 2, frontends: 1, associations: 2 }, 'EUR') },
] };
