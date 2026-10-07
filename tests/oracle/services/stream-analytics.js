'use strict';

const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'stream-analytics';
const HOURS = 730;
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function offer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }
async function graduated(offerName, region, qty) {
  const data = await calc.product(SLUG);
  const r = calc.calcRegion(data, region);
  const table = data.graduatedOffers[offerName][r];
  if (!table) throw new Error(`no ${offerName} graduated calculator table for ${r}`);
  let previous = 0; let cost = 0; const bands = [];
  for (const band of table.prices) {
    const units = Math.max(0, Math.min(qty, band.limit) - previous);
    if (units) { cost += units * band.price.value; bands.push({ from: previous, to: band.limit > 1e100 ? null : band.limit, units, unitPrice: band.price.value }); }
    previous = band.limit;
    if (qty <= band.limit) break;
  }
  return { cost, bands };
}
function tiered(rows, qty) {
  const bands = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  let cost = 0;
  for (let i = 0; i < bands.length; i++) {
    const start = bands[i].tierMinimumUnits;
    const end = i + 1 < bands.length ? bands[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    cost += (Math.min(qty, end) - start) * bands[i].retailPrice;
  }
  return cost;
}
async function retailRows(region, currency) { return dedupe(await query(`serviceName eq 'Stream Analytics' and armRegionName eq '${region}'`, currency)); }
async function streamAnalytics({ region, tier, streamingUnits = 0, jobs = 1, hours = HOURS, edgeDevices = 0, edgeJobsPerDevice = 1, currency = 'USD' }) {
  const lines = [];
  if (currency === 'USD') {
    if (tier === 'standard-v2' || tier === 'dedicated-v2') {
      const qty = (tier === 'standard-v2' ? streamingUnits * jobs : streamingUnits) * hours;
      const g = await graduated(tier, region, qty);
      lines.push(line(`${tier} graduated streaming-unit/job hours: ${qty}`, g.cost, { sourceOffer: tier, bands: g.bands }));
    } else if (streamingUnits) {
      const p = await offer('streaming-unit', region);
      const qty = (tier === 'standard' ? streamingUnits * jobs : streamingUnits) * hours;
      lines.push(line(`${tier} streaming-unit hours: ${qty} * ${p}`, qty * p, { sourceOffer: 'streaming-unit' }));
    }
    if (edgeDevices) {
      const p = await offer('devices', region);
      lines.push(line(`IoT Edge jobs: ${edgeDevices} devices * ${edgeJobsPerDevice} jobs * ${p}`, edgeDevices * edgeJobsPerDevice * p, { sourceOffer: 'devices' }));
    }
  } else {
    const rows = await retailRows(region, currency);
    const sku = tier === 'standard-v2' ? 'Standard V2' : tier === 'dedicated-v2' ? 'Dedicated V2' : tier[0].toUpperCase() + tier.slice(1);
    if (tier === 'standard-v2' || tier === 'dedicated-v2') {
      const matches = rows.filter(r => r.skuName === sku && /Streaming Unit\/Job/.test(r.meterName));
      const qty = (tier === 'standard-v2' ? streamingUnits * jobs : streamingUnits) * hours;
      lines.push(line(`${currency} ${sku} graduated streaming-unit/job hours: ${qty}`, tiered(matches, qty), { meterId: matches[0].meterId }));
    } else if (streamingUnits) {
      const m = rows.find(r => r.skuName === sku && r.meterName === `${sku} Streaming Unit`);
      const qty = (tier === 'standard' ? streamingUnits * jobs : streamingUnits) * hours;
      lines.push(line(`${currency} ${sku} streaming-unit hours: ${qty} * ${m.retailPrice}`, qty * m.retailPrice, { meterId: m.meterId }));
    }
    if (edgeDevices) {
      const m = rows.find(r => r.productName === 'Stream Analytics on Edge' && r.meterName === 'S1 Device');
      lines.push(line(`${currency} Edge jobs: ${edgeDevices} * ${edgeJobsPerDevice} * ${m.retailPrice}`, edgeDevices * edgeJobsPerDevice * m.retailPrice, { meterId: m.meterId }));
    }
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = { type: 'stream-analytics', source: 'both', cases: [
  { name: 'standard one job full month', region: 'eastus2', currency: 'USD', component: { type: 'stream-analytics', tier: 'standard', streamingUnits: 3, jobs: 1 },
    // Calculator streaming-unit offer is per SU-hour: 3 SUs * 730 hours.
    expected: async () => streamAnalytics({ region: 'eastus2', tier: 'standard', streamingUnits: 3 }) },
  { name: 'standard v2 just below first graduated band', region: 'eastus2', currency: 'USD', component: { type: 'stream-analytics', tier: 'standard-v2', streamingUnits: 1, jobs: 1, hours: 729 },
    // Calculator Standard V2 graduated table first band covers the first 730 streaming-unit/job hours.
    expected: async () => streamAnalytics({ region: 'eastus2', tier: 'standard-v2', streamingUnits: 1, hours: 729 }) },
  { name: 'standard v2 across first graduated boundary', region: 'eastus2', currency: 'USD', component: { type: 'stream-analytics', tier: 'standard-v2', streamingUnits: 2, jobs: 1, hours: 730 },
    // Calculator Standard V2 graduated table charges 730 hours at band 1 and remaining hours at band 2.
    expected: async () => streamAnalytics({ region: 'eastus2', tier: 'standard-v2', streamingUnits: 2, hours: 730 }) },
  { name: 'dedicated old cluster', region: 'eastus2', currency: 'USD', component: { type: 'stream-analytics', tier: 'dedicated', streamingUnits: 36, hours: 100 },
    // Calculator legacy dedicated uses the streaming-unit offer for total cluster SU-hours.
    expected: async () => streamAnalytics({ region: 'eastus2', tier: 'dedicated', streamingUnits: 36, hours: 100 }) },
  { name: 'dedicated v2 second graduated band', region: 'eastus2', currency: 'USD', component: { type: 'stream-analytics', tier: 'dedicated-v2', streamingUnits: 12, hours: 730 },
    // Calculator Dedicated V2 graduated table uses total SU-hours for the cluster.
    expected: async () => streamAnalytics({ region: 'eastus2', tier: 'dedicated-v2', streamingUnits: 12, hours: 730 }) },
  { name: 'iot edge devices', region: 'eastus2', currency: 'USD', component: { type: 'stream-analytics', tier: 'standard', streamingUnits: 0, edgeDevices: 10, edgeJobsPerDevice: 2 },
    // Calculator devices offer is per device-job per month.
    expected: async () => streamAnalytics({ region: 'eastus2', tier: 'standard', edgeDevices: 10, edgeJobsPerDevice: 2 }) },
  { name: 'non-US west europe standard v2', region: 'westeurope', currency: 'USD', component: { type: 'stream-analytics', tier: 'standard-v2', streamingUnits: 1, jobs: 2, hours: 200 },
    // Calculator West Europe Standard V2 graduated rates differ by calculator region.
    expected: async () => streamAnalytics({ region: 'westeurope', tier: 'standard-v2', streamingUnits: 1, jobs: 2, hours: 200 }) },
  { name: 'EUR retail standard v2', region: 'westeurope', currency: 'EUR', component: { type: 'stream-analytics', tier: 'standard-v2', streamingUnits: 1, jobs: 2, hours: 200 },
    // Retail API EUR Standard V2 Streaming Unit/Job rows are graduated by tierMinimumUnits.
    expected: async () => streamAnalytics({ region: 'westeurope', currency: 'EUR', tier: 'standard-v2', streamingUnits: 1, jobs: 2, hours: 200 }) },
] };
