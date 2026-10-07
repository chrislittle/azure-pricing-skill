'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const SLUG = 'azure-storage-discovery';
const CALC_REGION = { eastus2: 'us-east-2', westeurope: 'europe-west' };
const calcCache = new Map();
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function graduatedFromLimits(prices, qty) {
  let prev = 0, cost = 0; const bands = [];
  for (const tier of prices) {
    const limit = tier.limit;
    if (qty <= prev) break;
    const units = Math.min(qty, limit) - prev;
    const c = units * tier.price.value;
    cost += c; bands.push({ fromUnits: prev, toUnits: limit > 1e300 ? null : limit, units, unitPrice: tier.price.value, cost: round2(c) });
    prev = limit;
  }
  return { cost, bands };
}
function graduatedFromRows(rows, qty) {
  const rs = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  let cost = 0; const bands = [];
  for (let i = 0; i < rs.length; i++) {
    const start = rs[i].tierMinimumUnits;
    const end = i + 1 < rs.length ? rs[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    const units = Math.min(qty, end) - start;
    const c = units * rs[i].retailPrice;
    cost += c; bands.push({ fromUnits: start, toUnits: end === Infinity ? null : end, units, unitPrice: rs[i].retailPrice, cost: round2(c) });
  }
  return { cost, bands };
}
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
async function calcBands(offer, unit, region) {
  const d = await calcProduct();
  const prices = d.offers[offer]?.graduatedPrices?.[unit]?.[CALC_REGION[region]]?.prices;
  if (!prices) throw new Error(`no Storage Discovery calculator graduated offer ${offer}`);
  return prices;
}
async function retailRows(o, meter) {
  const rows = dedupe(await query(`serviceName eq 'Storage' and productName eq 'Storage Discovery' and skuName eq 'Standard' and armRegionName eq '${o.region}'`, o.currency || 'USD'));
  return rows.filter(r => r.type === 'Consumption' && r.meterName === meter);
}
async function price(o) {
  if ((o.plan || 'standard') === 'free') return { monthlyList: 0, lines: [line('Storage Discovery free plan has no standard analysis charges', 0)] };
  const accounts = o.storageAccounts || 0;
  const objectMillions = Math.max(1, (o.objects || 0) / 1e6);
  const lines = [];
  if ((o.currency || 'USD') === 'USD') {
    const acctBands = graduatedFromLimits(await calcBands('storage-account-analyzed-standard', 'perunit', o.region), accounts);
    const objBands = graduatedFromLimits(await calcBands('total-objects-analyzed-standard', 'permillion', o.region), objectMillions);
    lines.push(line(`Storage accounts analyzed ${accounts} through 1,000/10,000 graduated tiers`, acctBands.cost, { sourceOffer: 'storage-account-analyzed-standard', bands: acctBands.bands }));
    lines.push(line(`Objects analyzed ${o.objects}/1M=${objectMillions} through 25,000M/100,000M tiers`, objBands.cost, { sourceOffer: 'total-objects-analyzed-standard', bands: objBands.bands }));
  } else {
    const acctRows = await retailRows(o, 'Standard Storage Account');
    const objRows = await retailRows(o, 'Standard Objects Analyzed');
    const acct = graduatedFromRows(acctRows, accounts);
    const obj = graduatedFromRows(objRows, Math.max(unitSize(objRows[0].unitOfMeasure), (o.objects || 0)) / unitSize(objRows[0].unitOfMeasure));
    lines.push(line(`Storage accounts analyzed ${accounts} through Retail API graduated tiers`, acct.cost, { meterId: acctRows[0]?.meterId, bands: acct.bands }));
    lines.push(line(`Objects analyzed ${o.objects}/1M=${objectMillions} through Retail API graduated tiers`, obj.cost, { meterId: objRows[0]?.meterId, bands: obj.bands }));
  }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'storage-discovery', source: 'both', cases: [
  { name: 'free plan zero', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-discovery', plan: 'free', storageAccounts: 100, objects: 10000000 },
    // Free plan is capacity insights only; no standard storage-account or object-analysis charges.
    expected: () => price({ region: 'eastus2', plan: 'free', storageAccounts: 100, objects: 10000000 }) },
  { name: 'standard object minimum below one million', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-discovery', plan: 'standard', storageAccounts: 1, objects: 500000 },
    // Calculator says less than 1M analyzed objects incur a minimum charge, so 500,000 objects is billed as 1 million.
    expected: () => price({ region: 'eastus2', plan: 'standard', storageAccounts: 1, objects: 500000 }) },
  { name: 'account tier boundary at 1000', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-discovery', plan: 'standard', storageAccounts: 1000, objects: 1000000 },
    // Graduated account tier: first 1,000 accounts at the first price; this is exactly the boundary.
    expected: () => price({ region: 'eastus2', plan: 'standard', storageAccounts: 1000, objects: 1000000 }) },
  { name: 'account tier just above 1000', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-discovery', plan: 'standard', storageAccounts: 1001, objects: 1000000 },
    // The 1,001st account enters the second graduated band (1,000 to 10,000).
    expected: () => price({ region: 'eastus2', plan: 'standard', storageAccounts: 1001, objects: 1000000 }) },
  { name: 'object tier just above 25000 million', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-discovery', plan: 'standard', storageAccounts: 10, objects: 25001000000 },
    // Object analysis bands are in million-object units; 25,001M crosses into the second band.
    expected: () => price({ region: 'eastus2', plan: 'standard', storageAccounts: 10, objects: 25001000000 }) },
  { name: 'westeurope non us standard', region: 'westeurope', currency: 'USD',
    component: { type: 'storage-discovery', plan: 'standard', storageAccounts: 12000, objects: 100000000 },
    // Non-US calculator region europe-west uses the same graduated tiers and regional price table.
    expected: () => price({ region: 'westeurope', plan: 'standard', storageAccounts: 12000, objects: 100000000 }) },
  { name: 'eur via retail api graduated tiers', region: 'westeurope', currency: 'EUR',
    component: { type: 'storage-discovery', plan: 'standard', storageAccounts: 1001, objects: 2000000 },
    // EUR case uses Retail API graduated meters Standard Storage Account and Standard Objects Analyzed.
    expected: () => price({ region: 'westeurope', currency: 'EUR', plan: 'standard', storageAccounts: 1001, objects: 2000000 }) },
] };
