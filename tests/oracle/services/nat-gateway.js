'use strict';
const { query, dedupe, round2 } = require('../api');
const HOURS = 730;
const SLUG = 'virtual-network-nat';
const cache = new Map();
async function product(slug) { if (cache.has(slug)) return cache.get(slug); for (const v of ['v2','v3']) { const res = await fetch('https://azure.microsoft.com/api/' + v + '/pricing/' + slug + '/calculator/?culture=en-us', { headers: { accept: 'application/json' } }); if (res.ok) { const j = await res.json(); cache.set(slug, j); return j; } } throw new Error('calculator has no price data for ' + slug); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function calcRegion(region) { return region === 'westeurope' ? 'europe-west' : region === 'usgovvirginia' ? 'usgov-virginia' : 'us-east-2'; }
function unit(o, offer, unit, region = 'us-east-2') { return o.offers[offer].prices[unit][region] || o.offers[offer].prices[unit].global; }
function flowLogMonths(hours) { return Math.min(hours, 720) / 720; }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length < 1) throw new Error('no Retail API row for ' + what); return hits[0]; }
async function nat(o) { const region = o.region || 'eastus2', calcReg = calcRegion(region), currency = o.currency || 'USD', hours = o.hours ?? HOURS, lines = []; if (currency === 'USD') { const d = await product(SLUG); const resource = unit(d, 'nat-gateway-resource', 'perhour', calcReg).value; lines.push(line('NAT gateway resource: ' + o.gateways + ' * ' + hours + ' h * ' + resource, o.gateways * hours * resource, { sourceOffer: 'nat-gateway-resource' })); if (o.dataProcessedGB) { const data = unit(d, 'nat-gateway-data', 'pergb', calcReg).value; lines.push(line('NAT data processed: ' + o.dataProcessedGB + ' GB * ' + data, o.dataProcessedGB * data, { sourceOffer: 'nat-gateway-data' })); } if (o.sku === 'standardv2' && o.flowLogs) { const flow = unit(d, 'nat-gateway-flow-logs', 'permonth', calcReg).value; lines.push(line('NAT standardv2 flow logs: ' + o.gateways + ' * ' + Math.min(hours, 720) + '/720 month * ' + flow, o.gateways * flow * flowLogMonths(hours), { sourceOffer: 'nat-gateway-flow-logs' })); } } else { const rows = dedupe(await query("serviceName eq 'NAT Gateway'", currency)); const resource = pick(rows, r => r.skuName === 'Standard' && r.meterName === 'Standard Gateway' && r.armRegionName === 'Global', 'Standard Gateway').retailPrice; lines.push(line('NAT gateway resource: ' + o.gateways + ' * ' + hours + ' h * ' + resource, o.gateways * hours * resource)); if (o.dataProcessedGB) { const data = pick(rows, r => r.skuName === 'Standard' && r.meterName === 'Standard Data Processed' && r.armRegionName === 'Global', 'Standard Data Processed').retailPrice; lines.push(line('NAT data processed: ' + o.dataProcessedGB + ' GB * ' + data, o.dataProcessedGB * data)); } if (o.sku === 'standardv2' && o.flowLogs) { const flow = pick(rows, r => r.skuName === 'StandardV2' && r.meterName === 'StandardV2 Log Enabled' && r.armRegionName === 'Global', 'StandardV2 Log Enabled').retailPrice; lines.push(line('NAT standardv2 flow logs: ' + o.gateways + ' * ' + Math.min(hours, 720) + '/720 month * ' + flow, o.gateways * flow * flowLogMonths(hours))); } } return { monthlyList: totalOf(lines), lines }; }
module.exports = { type: 'nat-gateway', source: 'both', cases: [
  { name: 'standard gateway no data', region: 'eastus2', currency: 'USD', component: { type: 'nat-gateway', gateways: 1, sku: 'standard', dataProcessedGB: 0 },
    // Calculator v3 nat-gateway-resource is per gateway-hour; no data meter is charged at 0 GB.
    expected: () => nat({ region: 'eastus2', gateways: 1, sku: 'standard', dataProcessedGB: 0 }) },
  { name: 'standard gateway with data', region: 'eastus2', currency: 'USD', component: { type: 'nat-gateway', gateways: 2, sku: 'standard', dataProcessedGB: 500 },
    // Calculator v3 adds NAT Gateway data processed per GB to each hourly gateway resource.
    expected: () => nat({ region: 'eastus2', gateways: 2, sku: 'standard', dataProcessedGB: 500 }) },
  { name: 'standardv2 flow logs full month', region: 'eastus2', currency: 'USD', component: { type: 'nat-gateway', gateways: 1, sku: 'standardv2', dataProcessedGB: 1000, flowLogs: true },
    // StandardV2 with flow logs uses nat-gateway-flow-logs per month plus resource hours and data GB.
    expected: () => nat({ region: 'eastus2', gateways: 1, sku: 'standardv2', dataProcessedGB: 1000, flowLogs: true }) },
  { name: 'non-US part-time standardv2', region: 'westeurope', currency: 'USD', component: { type: 'nat-gateway', gateways: 3, sku: 'standardv2', dataProcessedGB: 123, flowLogs: true, hours: 365 },
    // West Europe calculator v3 per-hour resource and per-month flow-log offer are prorated by min(365,720)/720 for flow logs.
    expected: () => nat({ region: 'westeurope', gateways: 3, sku: 'standardv2', dataProcessedGB: 123, flowLogs: true, hours: 365 }) },

  { name: 'standardv2 flow logs 72-hour pricing-page example', region: 'eastus2', currency: 'USD', component: { type: 'nat-gateway', gateways: 1, sku: 'standardv2', dataProcessedGB: 0, flowLogs: true, hours: 72 },
    // Pricing page example: StandardV2 flow logs are $4 x gateways x 72/720 = $0.40, plus resource hours.
    expected: () => nat({ region: 'eastus2', gateways: 1, sku: 'standardv2', dataProcessedGB: 0, flowLogs: true, hours: 72 }) },
  { name: 'standardv2 flow logs 720-hour cap boundary', region: 'eastus2', currency: 'USD', component: { type: 'nat-gateway', gateways: 1, sku: 'standardv2', dataProcessedGB: 0, flowLogs: true, hours: 720 },
    // Flow-log monthly fee reaches the full $4 charge at 720 hours.
    expected: () => nat({ region: 'eastus2', gateways: 1, sku: 'standardv2', dataProcessedGB: 0, flowLogs: true, hours: 720 }) },
  { name: 'standardv2 flow logs 744-hour capped month', region: 'eastus2', currency: 'USD', component: { type: 'nat-gateway', gateways: 1, sku: 'standardv2', dataProcessedGB: 0, flowLogs: true, hours: 744 },
    // Flow-log fee is capped at min(hours,720)/720, while gateway resource hours continue using the provided hours.
    expected: () => nat({ region: 'eastus2', gateways: 1, sku: 'standardv2', dataProcessedGB: 0, flowLogs: true, hours: 744 }) },
  { name: 'US Gov standard gateway and data', region: 'usgovvirginia', currency: 'USD', component: { type: 'nat-gateway', gateways: 1, sku: 'standard', dataProcessedGB: 10, hours: 72 },
    // Calculator v3 US Gov Virginia NAT gateway resource and data meters use the usgov-virginia regional prices.
    expected: () => nat({ region: 'usgovvirginia', gateways: 1, sku: 'standard', dataProcessedGB: 10, hours: 72 }) },
  { name: 'zero-hour standardv2 flow logs', region: 'eastus2', currency: 'USD', component: { type: 'nat-gateway', gateways: 2, sku: 'standardv2', dataProcessedGB: 0, flowLogs: true, hours: 0 },
    // At zero hours both the hourly gateway resource and min(hours,720)/720 flow-log month fraction are zero.
    expected: () => nat({ region: 'eastus2', gateways: 2, sku: 'standardv2', dataProcessedGB: 0, flowLogs: true, hours: 0 }) },
  { name: 'EUR standardv2 with flow logs', region: 'westeurope', currency: 'EUR', component: { type: 'nat-gateway', gateways: 1, sku: 'standardv2', dataProcessedGB: 50, flowLogs: true },
    // Retail API EUR Global NAT Gateway rows provide gateway-hour, data-processed GB, and StandardV2 log-enabled monthly meters.
    expected: () => nat({ currency: 'EUR', region: 'westeurope', gateways: 1, sku: 'standardv2', dataProcessedGB: 50, flowLogs: true }) },
] };


