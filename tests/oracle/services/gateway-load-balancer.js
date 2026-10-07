'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS = 730;
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice||String(a.meterId).localeCompare(String(b.meterId))); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
async function rows(currency) { return dedupe(await query(`serviceName eq 'Load Balancer' and armRegionName eq 'Global' and productName eq 'Load Balancer'`, currency)).filter(x => x.type === 'Consumption'); }
async function expected(c, currency = 'USD') {
  const r = await rows(currency); const h = c.hours ?? HOURS; const lines = [];
  if (c.kind === 'gateway') {
    const gw = pick(r, x => x.skuName === 'Gateway' && x.meterName === 'Gateway', 'Gateway hourly');
    const chain = pick(r, x => x.skuName === 'Gateway' && x.meterName === 'Gateway Chain', 'Gateway chain hourly');
    const data = pick(r, x => x.skuName === 'Gateway' && x.meterName === 'Gateway Data Processed', 'Gateway data processed');
    lines.push(line(`Gateway Load Balancer x${c.gatewayLoadBalancers ?? 1} @ ${h} h`, gw, h * (c.gatewayLoadBalancers ?? 1), h * (c.gatewayLoadBalancers ?? 1) * gw.retailPrice / unitSize(gw.unitOfMeasure)));
    lines.push(line(`Gateway Load Balancer chains x${c.chains ?? 1} @ ${h} h`, chain, h * (c.chains ?? 1), h * (c.chains ?? 1) * chain.retailPrice / unitSize(chain.unitOfMeasure)));
    if ((c.dataGB ?? 0) > 0) lines.push(line(`Gateway Load Balancer data ${c.dataGB} GB`, data, c.dataGB, c.dataGB * data.retailPrice / unitSize(data.unitOfMeasure)));
  } else {
    const inc = pick(r, x => x.skuName === 'Global' && x.meterName === 'Global Included LB Rules and Outbound Rules', 'Global included rules');
    lines.push(line(`Cross-region load balancer first 5 rules @ ${h} h`, inc, h, h * inc.retailPrice / unitSize(inc.unitOfMeasure)));
    if ((c.rules ?? 5) > 5) { const o = pick(r, x => x.skuName === 'Global' && x.meterName === 'Global Overage LB Rules and Outbound Rules', 'Global overage rules'); const extra = c.rules - 5; lines.push(line(`Cross-region load balancer ${extra} extra rules @ ${h} h`, o, h * extra, h * extra * o.retailPrice / unitSize(o.unitOfMeasure))); }
  }
  return { monthlyList: total(lines), lines };
}
module.exports = { type: 'gateway-load-balancer', source: 'both', cases: [
  { name: 'gateway one chain plus data', region: 'eastus2', currency: 'USD', component: { type: 'gateway-load-balancer', kind: 'gateway', gatewayLoadBalancers: 1, chains: 1, dataGB: 1000 },
    // Retail meters: Gateway + Gateway Chain hourly for 730 h, plus Gateway Data Processed per GB.
    expected: () => expected({ kind: 'gateway', gatewayLoadBalancers: 1, chains: 1, dataGB: 1000 }) },
  { name: 'gateway part-time multiple appliances', region: 'eastus2', currency: 'USD', component: { type: 'gateway-load-balancer', kind: 'gateway', gatewayLoadBalancers: 2, chains: 3, dataGB: 2500, hours: 100 },
    // Retail meters: multiply each hourly Gateway/Chain meter by explicit 100 hours; data remains per GB.
    expected: () => expected({ kind: 'gateway', gatewayLoadBalancers: 2, chains: 3, dataGB: 2500, hours: 100 }) },
  { name: 'global included five rules', region: 'eastus2', currency: 'USD', component: { type: 'gateway-load-balancer', kind: 'global', rules: 5 },
    // Retail meter: Global Included LB Rules and Outbound Rules covers the first five rules for 730 h.
    expected: () => expected({ kind: 'global', rules: 5 }) },
  { name: 'global overage seven rules non-US', region: 'westeurope', currency: 'USD', component: { type: 'gateway-load-balancer', kind: 'global', rules: 7 },
    // Retail meters are Global: included-rule hourly meter plus two overage-rule hourly meters.
    expected: () => expected({ kind: 'global', rules: 7 }) },
  { name: 'gateway EUR currency', region: 'westeurope', currency: 'EUR', component: { type: 'gateway-load-balancer', kind: 'gateway', gatewayLoadBalancers: 1, chains: 2, dataGB: 500 },
    // Same Gateway retail meters queried with currencyCode EUR; calculator endpoint is USD-only.
    expected: () => expected({ kind: 'gateway', gatewayLoadBalancers: 1, chains: 2, dataGB: 500 }, 'EUR') },
] };
