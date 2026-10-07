'use strict';
const { query, dedupe, round2 } = require('../api');
const SLUG = 'container-storage';
const CALC_REGION = { eastus2: 'us-east-2', westeurope: 'europe-west' };
const calcCache = new Map();
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calcProduct() {
  if (calcCache.has(SLUG)) return calcCache.get(SLUG);
  let last;
  for (const v of ['v2', 'v3']) {
    const res = await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
    if (res.ok) { const j = await res.json(); calcCache.set(SLUG, j); return j; }
    last = new Error(`calculator ${v} HTTP ${res.status}`);
  }
  throw last;
}
async function usdPrice(region) {
  const d = await calcProduct();
  const p = d.offers['storage-orchestration']?.prices?.pergibpermonth?.[CALC_REGION[region]] || d.offers['storage-orchestration-costs']?.prices?.pergb?.[CALC_REGION[region]];
  if (!p) throw new Error(`no Container Storage calculator price ${region}`);
  return { value: p.value, sourceOffer: 'storage-orchestration' };
}
async function retailPrice(currency) {
  const rows = dedupe(await query(`serviceName eq 'Storage' and productName eq 'Azure Container Storage' and skuName eq 'Orchestration' and armRegionName eq 'Global'`, currency));
  const row = rows.find(r => r.type === 'Consumption' && r.meterName === 'Provisioned Capacity Unit');
  if (!row) throw new Error('no Azure Container Storage retail meter');
  return { value: row.retailPrice, meterId: row.meterId };
}
async function price(o) {
  if ((o.version || 'v2') === 'v2') return { monthlyList: 0, lines: [line('Azure Container Storage v2 orchestration charge is $0', 0)] };
  const pools = o.poolCount || 1;
  const billTiB = Math.max(0, (o.poolTiB || 0) - 5) * pools;
  const p = (o.currency || 'USD') === 'USD' ? await usdPrice(o.region) : await retailPrice(o.currency);
  const lines = billTiB ? [line(`v1 orchestration: ${pools} pools * max(0, ${o.poolTiB} TiB - 5 TiB free per pool) * 1024 GiB/TiB * ${p.value}`, billTiB * 1024 * p.value, p)] : [line(`v1 orchestration: ${pools} pool(s) of ${o.poolTiB} TiB are within 5 TiB free per-pool allowance`, 0, p)];
  return { monthlyList: lines[0].monthlyList, lines };
}
module.exports = { type: 'container-storage', source: 'both', cases: [
  { name: 'v1 exactly free allowance', region: 'eastus2', currency: 'USD',
    component: { type: 'container-storage', version: 'v1', poolTiB: 5 },
    // Azure Container Storage v1 orchestration charges only capacity above 5 TiB.
    expected: () => price({ region: 'eastus2', version: 'v1', poolTiB: 5 }) },
  { name: 'v1 just above free allowance', region: 'eastus2', currency: 'USD',
    component: { type: 'container-storage', version: 'v1', poolTiB: 5.5 },
    // Boundary case: only 0.5 TiB above the 5 TiB free allowance is billed per GiB-month.
    expected: () => price({ region: 'eastus2', version: 'v1', poolTiB: 5.5 }) },
  { name: 'v1 large pool', region: 'eastus2', currency: 'USD',
    component: { type: 'container-storage', version: 'v1', poolTiB: 20 },
    // Calculator v3 storage-orchestration is per GiB-month for pool capacity above 5 TiB.
    expected: () => price({ region: 'eastus2', version: 'v1', poolTiB: 20 }) },
  { name: 'v1 three pools free allowance', region: 'eastus2', currency: 'USD',
    component: { type: 'container-storage', version: 'v1', poolCount: 3, poolTiB: 8 },
    // Free allowance is per storage pool: 3 pools * 8 TiB = 24 TiB, billable is 3 * (8-5) = 9 TiB => $55.30 at $0.006/GiB-month.
    expected: () => price({ region: 'eastus2', version: 'v1', poolCount: 3, poolTiB: 8 }) },
  { name: 'v2 no orchestration charge', region: 'eastus2', currency: 'USD',
    component: { type: 'container-storage', poolTiB: 20 },
    // Version 2.0 and later are free of orchestration charges per calculator note.
    expected: () => price({ region: 'eastus2', poolTiB: 20 }) },
  { name: 'westeurope non us v1', region: 'westeurope', currency: 'USD',
    component: { type: 'container-storage', version: 'v1', poolTiB: 10 },
    // Non-US calculator region still uses the v3 storage-orchestration GiB-month price for billable capacity.
    expected: () => price({ region: 'westeurope', version: 'v1', poolTiB: 10 }) },
  { name: 'eur global retail meter', region: 'westeurope', currency: 'EUR',
    component: { type: 'container-storage', version: 'v1', poolTiB: 10 },
    // EUR case uses Retail API Global meter Azure Container Storage / Orchestration / Provisioned Capacity Unit.
    expected: () => price({ region: 'westeurope', currency: 'EUR', version: 'v1', poolTiB: 10 }) },
] };
