'use strict';
const { query, dedupe, round2 } = require('../api');
const SLUG = 'managed-lustre';
const HOURS = 730;
const STEP = { '40': 48, '125': 16, '250': 8, '500': 4 };
const OFFER = { '40': 'managed-lustre-ssd-lite-tier', '125': 'managed-lustre-ssd-standard-tier', '250': 'managed-lustre-ssd-premium-tier', '500': 'managed-lustre-ssd-ultra-tier' };
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
async function calcPrice(tier, region) {
  const d = await calcProduct();
  const p = d.offers[OFFER[tier]]?.prices?.perhour?.[CALC_REGION[region]];
  if (!p) throw new Error(`no Managed Lustre calculator price ${tier} ${region}`);
  return p.value;
}
async function retailPrice(o) {
  const sku = `AMLFS-Durable-Premium-${o.throughputTier || '125'}`;
  const rows = dedupe(await query(`serviceName eq 'Storage' and productName eq 'Azure Managed Lustre' and skuName eq '${sku}' and armRegionName eq '${o.region}'`, o.currency || 'USD'));
  const row = rows.find(r => r.type === 'Consumption' && r.meterName === 'Provisioned Capacity');
  if (!row) throw new Error(`no Managed Lustre meter ${sku}`);
  return { value: row.retailPrice, meterId: row.meterId };
}
async function price(o) {
  const tier = o.throughputTier || '125';
  const hours = o.hours ?? HOURS;
  const roundedTiB = Math.ceil((o.capacityTiB || 0) / STEP[tier]) * STEP[tier];
  const p = (o.currency || 'USD') === 'USD'
    ? { value: await calcPrice(tier, o.region), sourceOffer: OFFER[tier] }
    : await retailPrice(o);
  const cost = roundedTiB * 1024 * hours * p.value;
  const lines = [line(`${tier} MB/s/TiB tier: ${o.capacityTiB} TiB rounded to ${roundedTiB} TiB * 1024 GiB/TiB * ${hours} h * ${p.value}`, cost, p)];
  return { monthlyList: lines[0].monthlyList, lines };
}
module.exports = { type: 'managed-lustre', source: 'both', cases: [
  { name: '40 tier minimum 48 tib', region: 'eastus2', currency: 'USD',
    component: { type: 'managed-lustre', throughputTier: '40', capacityTiB: 48, hours: 730 },
    // Lite 40 MB/s/TiB bills 48 TiB increments; calculator price is per GiB-hour.
    expected: () => price({ region: 'eastus2', throughputTier: '40', capacityTiB: 48, hours: 730 }) },
  { name: '125 tier two increments', region: 'eastus2', currency: 'USD',
    component: { type: 'managed-lustre', throughputTier: '125', capacityTiB: 32, hours: 730 },
    // Standard 125 tier bills in 16-TiB increments; 32 TiB is exactly two increments.
    expected: () => price({ region: 'eastus2', throughputTier: '125', capacityTiB: 32, hours: 730 }) },
  { name: '250 tier part time', region: 'eastus2', currency: 'USD',
    component: { type: 'managed-lustre', throughputTier: '250', capacityTiB: 8, hours: 100 },
    // Premium 250 tier is per GiB-hour, so part-month filesystems multiply by supplied hours.
    expected: () => price({ region: 'eastus2', throughputTier: '250', capacityTiB: 8, hours: 100 }) },
  { name: '500 tier minimum size', region: 'eastus2', currency: 'USD',
    component: { type: 'managed-lustre', throughputTier: '500', capacityTiB: 4, hours: 730 },
    // Ultra 500 tier has 4 TiB increments; 4 TiB is exactly one increment.
    expected: () => price({ region: 'eastus2', throughputTier: '500', capacityTiB: 4, hours: 730 }) },
  { name: 'westeurope non us standard', region: 'westeurope', currency: 'USD',
    component: { type: 'managed-lustre', throughputTier: '125', capacityTiB: 16, hours: 730 },
    // Non-US europe-west calculator per-GiB-hour price differs from East US 2.
    expected: () => price({ region: 'westeurope', throughputTier: '125', capacityTiB: 16, hours: 730 }) },
  { name: 'eur 250 via retail api', region: 'westeurope', currency: 'EUR',
    component: { type: 'managed-lustre', throughputTier: '250', capacityTiB: 16, hours: 24 },
    // EUR case uses Retail API Azure Managed Lustre AMLFS-Durable-Premium-250 Provisioned Capacity.
    expected: () => price({ region: 'westeurope', currency: 'EUR', throughputTier: '250', capacityTiB: 16, hours: 24 }) },
] };
