'use strict';
const { query, dedupe, round2 } = require('../api');
const SLUG = 'azure-elastic-san';
const CALC_REGION = { eastus2: 'us-east-2', westeurope: 'europe-west' };
const calcCache = new Map();
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
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
async function calcPrice(offer, region) {
  const d = await calcProduct();
  const p = d.offers[offer]?.prices?.pergb?.[CALC_REGION[region]];
  if (!p) throw new Error(`no calculator price ${offer} ${region}`);
  return p.value;
}
async function retailPrice(o, meter) {
  const sku = (o.redundancy || 'lrs').toUpperCase() === 'ZRS' ? 'Premium ZRS' : 'Premium LRS';
  const rows = dedupe(await query(`serviceName eq 'Storage' and productName eq 'Azure Elastic SAN' and skuName eq '${sku}' and armRegionName eq '${o.region}'`, o.currency || 'USD'));
  const row = rows.find(r => r.type === 'Consumption' && r.meterName === meter);
  if (!row) throw new Error(`no Elastic SAN meter ${sku} ${meter}`);
  return { value: row.retailPrice, meterId: row.meterId };
}
async function unitPrice(o, kind) {
  const red = o.redundancy || 'lrs';
  if ((o.currency || 'USD') === 'USD') return { value: await calcPrice(`premium-${red}-${kind}-unit`, o.region), sourceOffer: `premium-${red}-${kind}-unit` };
  return retailPrice(o, kind === 'base' ? `Premium ${red.toUpperCase()} Provisioned Base Unit` : `Premium ${red.toUpperCase()} Provisioned Capacity Unit`);
}
async function elastic(o) {
  const lines = [];
  const base = o.baseTiB || 0, add = o.additionalTiB || 0;
  if (base) { const p = await unitPrice(o, 'base'); lines.push(line(`${o.redundancy || 'lrs'} base ${base} TiB * 1024 GiB/TiB * ${p.value}`, base * 1024 * p.value, p)); }
  if (add) { const p = await unitPrice(o, 'scale'); lines.push(line(`${o.redundancy || 'lrs'} additional ${add} TiB * 1024 GiB/TiB * ${p.value}`, add * 1024 * p.value, p)); }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'elastic-san', source: 'both', cases: [
  { name: 'lrs base unit only', region: 'eastus2', currency: 'USD',
    component: { type: 'elastic-san', redundancy: 'lrs', baseTiB: 1, additionalTiB: 0 },
    // Calculator v3 premium-lrs-base-unit is per GiB-month; one base TiB is 1024 GiB.
    expected: () => elastic({ region: 'eastus2', redundancy: 'lrs', baseTiB: 1 }) },
  { name: 'lrs base plus capacity units', region: 'eastus2', currency: 'USD',
    component: { type: 'elastic-san', redundancy: 'lrs', baseTiB: 2, additionalTiB: 8 },
    // Base and scale capacity are separate per-GiB-month calculator offers.
    expected: () => elastic({ region: 'eastus2', redundancy: 'lrs', baseTiB: 2, additionalTiB: 8 }) },
  { name: 'zrs base and capacity units', region: 'eastus2', currency: 'USD',
    component: { type: 'elastic-san', redundancy: 'zrs', baseTiB: 1, additionalTiB: 1 },
    // ZRS uses the premium-zrs base and scale calculator offers.
    expected: () => elastic({ region: 'eastus2', redundancy: 'zrs', baseTiB: 1, additionalTiB: 1 }) },
  { name: 'westeurope lrs non us', region: 'westeurope', currency: 'USD',
    component: { type: 'elastic-san', redundancy: 'lrs', baseTiB: 3, additionalTiB: 2 },
    // Non-US calculator region europe-west has different LRS base/scale per-GiB-month prices.
    expected: () => elastic({ region: 'westeurope', redundancy: 'lrs', baseTiB: 3, additionalTiB: 2 }) },
  { name: 'eur zrs via retail api', region: 'westeurope', currency: 'EUR',
    component: { type: 'elastic-san', redundancy: 'zrs', baseTiB: 2, additionalTiB: 3 },
    // EUR case uses Retail API meters Premium ZRS Provisioned Base Unit and Capacity Unit.
    expected: () => elastic({ region: 'westeurope', currency: 'EUR', redundancy: 'zrs', baseTiB: 2, additionalTiB: 3 }) },
] };
