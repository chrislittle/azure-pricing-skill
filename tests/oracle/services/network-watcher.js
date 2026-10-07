'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'network-watcher';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function offer(name, region) { return (await calc.offerPrice(SLUG, name, region)).value; }
function graduated(bands, qty) { let prev = 0, cost = 0, out = []; for (const b of bands) { if (qty <= prev) break; const units = Math.min(qty, b.limit) - prev, c = units * b.price.value; cost += c; out.push({ fromUnits: prev, toUnits: b.limit > 1e100 ? null : b.limit, units, unitPrice: b.price.value, cost: round2(c) }); prev = b.limit; } return { cost, bands: out }; }
function graduatedRetail(rows, qty) { const sorted = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits); let cost = 0, out = []; for (let i = 0; i < sorted.length; i++) { const start = sorted[i].tierMinimumUnits, end = i + 1 < sorted.length ? sorted[i + 1].tierMinimumUnits : Infinity; if (qty <= start) break; const units = Math.min(qty, end) - start, c = units * sorted[i].retailPrice; cost += c; out.push({ fromUnits: start, toUnits: end === Infinity ? null : end, units, unitPrice: sorted[i].retailPrice, cost: round2(c) }); } return { cost, bands: out, meterId: sorted[0] && sorted[0].meterId }; }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`); return hits[0]; }
async function retailRows(region, currency) { return dedupe(await query(`serviceName eq 'Network Watcher' and armRegionName eq '${region}'`, currency)); }
async function networkWatcher(o) {
  const region = o.region, currency = o.currency || 'USD', lines = [];
  if (currency === 'USD') {
    const data = await calc.product(SLUG), reg = calc.calcRegion(data, region);
    function addGrad(offerName, qty, desc) { if (qty) { const t = graduated(data.graduatedOffers[offerName][reg].prices, qty); lines.push(line(`${desc}: ${qty} through calculator graduated bands`, t.cost, { sourceOffer: offerName, bands: t.bands })); } }
    addGrad('virtual-network-flow-logs-collected', o.vnetFlowLogsGB, 'VNet flow logs collected');
    addGrad('network-logs', o.nsgFlowLogsGB, 'NSG network logs collected');
    addGrad('connection-monitor', o.connectionMonitorTests, 'Connection Monitor tests');
    addGrad('network-diagnostics', o.diagnosticChecks, 'Diagnostic tool checks');
    if (o.trafficAnalyticsGB) { const name = o.trafficAnalyticsInterval === '10min' ? 'traffic-analytics-processing-10-minute' : 'traffic-analytics-processing-60-minute'; const p = await offer(name, region); lines.push(line(`Traffic Analytics ${o.trafficAnalyticsInterval || '60min'}: ${o.trafficAnalyticsGB} GB * ${p}`, o.trafficAnalyticsGB * p, { sourceOffer: name })); }
  } else {
    const rows = await retailRows(region, currency);
    function addRetail(meter, qty, desc) { if (qty) { const t = graduatedRetail(rows.filter(r => r.meterName === meter), qty); lines.push(line(`${desc}: ${qty} through Retail API graduated bands`, t.cost, { meterId: t.meterId, bands: t.bands })); } }
    addRetail('Standard VNet Flow Logs Collected', o.vnetFlowLogsGB, 'VNet flow logs collected');
    addRetail('Standard Network Logs Collected', o.nsgFlowLogsGB, 'NSG network logs collected');
    addRetail('Standard Connection Monitor Test', o.connectionMonitorTests, 'Connection Monitor tests');
    addRetail('Standard Diagnostic Tool API', o.diagnosticChecks, 'Diagnostic tool checks');
    if (o.trafficAnalyticsGB) { const meter = o.trafficAnalyticsInterval === '10min' ? 'Standard Traffic Analytics Processing at 10-Minute Interval' : 'Standard Traffic Analytics Processing'; const r = pick(rows, x => x.meterName === meter, meter); lines.push(line(`Traffic Analytics ${o.trafficAnalyticsInterval || '60min'}: ${o.trafficAnalyticsGB} GB * ${r.retailPrice}`, o.trafficAnalyticsGB * r.retailPrice, { meterId: r.meterId })); }
  }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'network-watcher', source: 'both', cases: [
  { name: 'flow logs at 5 GB free boundary', region: 'eastus2', currency: 'USD', component: { type: 'network-watcher', vnetFlowLogsGB: 5 },
    // Calculator VNet flow logs in East US 2 have first 5 GB at zero price.
    expected: () => networkWatcher({ region: 'eastus2', vnetFlowLogsGB: 5 }) },
  { name: 'flow logs just above free boundary', region: 'eastus2', currency: 'USD', component: { type: 'network-watcher', vnetFlowLogsGB: 6, nsgFlowLogsGB: 6 },
    // VNet flow logs and older NSG network logs each have separate 5 GB free grants in most regions.
    expected: () => networkWatcher({ region: 'eastus2', vnetFlowLogsGB: 6, nsgFlowLogsGB: 6 }) },
  { name: 'us gov vnet flow logs no free grant', region: 'usgovvirginia', currency: 'USD', component: { type: 'network-watcher', vnetFlowLogsGB: 10 },
    // Calculator US Gov Virginia VNet flow-log band starts at a paid price, so all 10 GB are charged.
    expected: () => networkWatcher({ region: 'usgovvirginia', vnetFlowLogsGB: 10 }) },

  { name: 'New Zealand North vnet flow logs no free grant', region: 'newzealandnorth', currency: 'USD', component: { type: 'network-watcher', vnetFlowLogsGB: 10 },
    // Calculator New Zealand North VNet flow-log band starts at a paid price, so all 10 GB are charged.
    expected: () => networkWatcher({ region: 'newzealandnorth', vnetFlowLogsGB: 10 }) },
  { name: 'India South Central vnet flow logs no free grant', region: 'indiasouthcentral', currency: 'USD', component: { type: 'network-watcher', vnetFlowLogsGB: 10 },
    // Calculator India South Central VNet flow-log band starts at a paid price, so all 10 GB are charged.
    expected: () => networkWatcher({ region: 'indiasouthcentral', vnetFlowLogsGB: 10 }) },
  { name: 'connection monitor free boundary', region: 'eastus2', currency: 'USD', component: { type: 'network-watcher', vnetFlowLogsGB: 0, connectionMonitorTests: 10 },
    // Connection Monitor tests are free through 10 units in calculator graduated bands in most regions.
    expected: () => networkWatcher({ region: 'eastus2', connectionMonitorTests: 10 }) },
  { name: 'connection monitor above graduated bands', region: 'eastus2', currency: 'USD', component: { type: 'network-watcher', vnetFlowLogsGB: 0, connectionMonitorTests: 240011 },
    // Large test counts walk the calculator graduated tiers after the first 10 free units.
    expected: () => networkWatcher({ region: 'eastus2', connectionMonitorTests: 240011 }) },
  { name: 'traffic analytics and diagnostics non-US', region: 'westeurope', currency: 'USD', component: { type: 'network-watcher', vnetFlowLogsGB: 20, trafficAnalyticsGB: 20, trafficAnalyticsInterval: '10min', diagnosticChecks: 1001 },
    // West Europe: VNet flow logs and diagnostics use graduated calculator bands; 10-minute Traffic Analytics is flat per GB.
    expected: () => networkWatcher({ region: 'westeurope', vnetFlowLogsGB: 20, trafficAnalyticsGB: 20, trafficAnalyticsInterval: '10min', diagnosticChecks: 1001 }) },
  { name: 'EUR current Network Watcher meters', region: 'westeurope', currency: 'EUR', component: { type: 'network-watcher', vnetFlowLogsGB: 6, nsgFlowLogsGB: 6, trafficAnalyticsGB: 2, trafficAnalyticsInterval: '60min', connectionMonitorTests: 11, diagnosticChecks: 1001 },
    // Retail API EUR rows cover VNet/NSG flow-log free tiers, 60-minute Traffic Analytics, Connection Monitor, and diagnostics; deprecated NPM/SCM is omitted.
    expected: () => networkWatcher({ region: 'westeurope', currency: 'EUR', vnetFlowLogsGB: 6, nsgFlowLogsGB: 6, trafficAnalyticsGB: 2, trafficAnalyticsInterval: '60min', connectionMonitorTests: 11, diagnosticChecks: 1001 }) },
] };
