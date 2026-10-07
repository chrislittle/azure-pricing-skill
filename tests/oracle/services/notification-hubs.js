'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'notification-hubs';
const MILLION = 1000000;
const FORCED_ZONE_REGIONS = new Set(['francecentral', 'italynorth', 'norwayeast', 'polandcentral', 'swedencentral', 'switzerlandnorth', 'qatarcentral', 'southafricanorth', 'koreacentral']);

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

async function calculatorOffer(offer, region) {
  const p = await calc.offerPrice(SLUG, offer, region);
  return p.value;
}

async function calculatorGraduated(tier, region, pushes) {
  const data = await calc.product(SLUG);
  const calcRegion = calc.calcRegion(data, region);
  const table = data.graduatedOffers[tier][calcRegion];
  if (!table) throw new Error(`calculator has no ${tier} graduated prices for ${calcRegion}`);
  const qty = pushes / MILLION;
  let previous = 0;
  let cost = 0;
  const bands = [];
  for (const band of table.prices) {
    const limit = band.limit;
    const units = Math.max(0, Math.min(qty, limit) - previous);
    if (units > 0) {
      const unitPrice = band.price.value;
      const bandCost = units * unitPrice;
      cost += bandCost;
      bands.push({ fromMillion: previous, toMillion: limit === Number.MAX_VALUE ? null : limit, millionPushes: units, unitPrice, cost: round2(bandCost) });
    }
    previous = limit;
    if (qty <= limit) break;
  }
  return { cost, bands };
}

async function calculatorNotificationHubs({ region, tier = 'basic', namespaces = 1, pushes = 0, zoneRedundant = false, privateLink = false }) {
  const lines = [];
  const unitPrice = await calculatorOffer(tier, region);
  lines.push(line(`${tier} namespace units: ${namespaces} * ${unitPrice}`, namespaces * unitPrice, { sourceOffer: tier }));

  if (tier === 'basic' || tier === 'standard') {
    const g = await calculatorGraduated(tier, region, pushes);
    lines.push(line(`${tier} pushes: ${pushes} pushes / 1M through graduated bands`, g.cost, { sourceOffer: tier, bands: g.bands }));
  }
  if (zoneRedundant || FORCED_ZONE_REGIONS.has(region)) {
    const price = await calculatorOffer('availability-zones', region);
    lines.push(line(`availability zones: ${namespaces} * ${price}`, namespaces * price, { sourceOffer: 'availability-zones' }));
  }
  if (privateLink) {
    const price = await calculatorOffer('private-link', region);
    lines.push(line(`private link: ${namespaces} * ${price}`, namespaces * price, { sourceOffer: 'private-link' }));
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailRows(region, currency) {
  return dedupe(await query(`serviceName eq 'Notification Hubs' and armRegionName eq '${region}'`, currency));
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

function tiered(rows, qty) {
  const tiers = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  let cost = 0;
  const bands = [];
  for (let i = 0; i < tiers.length; i++) {
    const start = tiers[i].tierMinimumUnits;
    const end = i + 1 < tiers.length ? tiers[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    const units = Math.min(qty, end) - start;
    const bandCost = units * tiers[i].retailPrice;
    cost += bandCost;
    bands.push({ fromUnits: start, toUnits: end === Infinity ? null : end, units, unitPrice: tiers[i].retailPrice, cost: round2(bandCost) });
  }
  return { cost, bands };
}

async function retailNotificationHubs({ region, currency, tier = 'basic', namespaces = 1, pushes = 0, zoneRedundant = false, privateLink = false }) {
  const rows = await retailRows(region, currency);
  const sku = { free: 'Free', basic: 'Basic', standard: 'Standard' }[tier];
  const unit = pickOne(rows, r => r.type === 'Consumption' && r.skuName === sku && r.meterName === `${sku} Unit`, `${sku} Unit`);
  const lines = [line(`Retail API ${sku} namespace units: ${namespaces} * ${unit.retailPrice}`, namespaces * unit.retailPrice, { meterId: unit.meterId })];

  if (tier === 'basic' || tier === 'standard') {
    const pushRows = rows.filter(r => r.type === 'Consumption' && r.skuName === sku && r.meterName === `${sku} Pushes`);
    const qty = pushes / unitSize(pushRows[0].unitOfMeasure);
    const g = tiered(pushRows, qty);
    lines.push(line(`Retail API ${sku} pushes: ${pushes} pushes / ${pushRows[0].unitOfMeasure} through graduated bands`, g.cost, { meterId: pushRows[0].meterId, bands: g.bands }));
  }
  if (zoneRedundant || FORCED_ZONE_REGIONS.has(region)) {
    const az = pickOne(rows, r => r.type === 'Consumption' && r.skuName === 'Availability Zones SKU' && r.meterName === 'Availability Zones Unit', 'Availability Zones Unit');
    lines.push(line(`Retail API availability zones: ${namespaces} * ${az.retailPrice}`, namespaces * az.retailPrice, { meterId: az.meterId }));
  }
  if (privateLink) {
    const pl = pickOne(rows, r => r.type === 'Consumption' && r.skuName === 'Private Link' && r.meterName === 'Private Link Unit', 'Private Link Unit');
    lines.push(line(`Retail API private link: ${namespaces} * ${pl.retailPrice}`, namespaces * pl.retailPrice, { meterId: pl.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'notification-hubs',
  source: 'both',
  cases: [
    {
      name: 'free namespace with pushes',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'free', namespaces: 1, pushes: 1000000 },
      // Calculator free offer is a $0 monthly namespace; no paid push meter is exposed for Free.
      expected: async () => calculatorNotificationHubs({ region: 'eastus2', tier: 'free', namespaces: 1, pushes: 1000000 }),
    },
    {
      name: 'basic just below included push boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'basic', namespaces: 1, pushes: 9999999 },
      // Calculator basic graduated pushes are per 1M: first 10 million are $0, plus the Basic namespace unit.
      expected: async () => calculatorNotificationHubs({ region: 'eastus2', tier: 'basic', namespaces: 1, pushes: 9999999 }),
    },
    {
      name: 'basic just above included push boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'basic', namespaces: 1, pushes: 10000001 },
      // Calculator basic graduated pushes: only pushes above 10M are charged at the paid per-million band.
      expected: async () => calculatorNotificationHubs({ region: 'eastus2', tier: 'basic', namespaces: 1, pushes: 10000001 }),
    },
    {
      name: 'standard pushes above 100 million boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'standard', namespaces: 1, pushes: 101000000 },
      // Calculator standard graduated pushes: 0-10M free, 10-100M at $10/M, then over 100M at $2.50/M.
      expected: async () => calculatorNotificationHubs({ region: 'eastus2', tier: 'standard', namespaces: 1, pushes: 101000000 }),
    },
    {
      name: 'standard multiple namespaces with zone redundancy and private link',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'standard', namespaces: 2, pushes: 20000000, zoneRedundant: true, privateLink: true },
      // Calculator monthly add-ons availability-zones and private-link apply per namespace, alongside graduated pushes.
      expected: async () => calculatorNotificationHubs({ region: 'eastus2', tier: 'standard', namespaces: 2, pushes: 20000000, zoneRedundant: true, privateLink: true }),
    },
    {
      name: 'two basic namespaces share one free push allowance',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'basic', namespaces: 2, pushes: 15000000 },
      // Calculator Basic namespace unit is per namespace, but Basic Pushes graduated bands apply to total monthly pushes, not once per namespace.
      expected: async () => calculatorNotificationHubs({ region: 'eastus2', tier: 'basic', namespaces: 2, pushes: 15000000 }),
    },
    {
      name: 'italy north standard forced zone redundancy with 5m pushes',
      region: 'italynorth',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'standard', namespaces: 1, pushes: 5000000, zoneRedundant: false },
      // Italy North is a forced availability-zone region; charge the AZ unit even when zoneRedundant is false. First 10M Standard pushes are free.
      expected: async () => calculatorNotificationHubs({ region: 'italynorth', tier: 'standard', namespaces: 1, pushes: 5000000, zoneRedundant: false }),
    },
    {
      name: 'us gov virginia standard has no free push band',
      region: 'usgovvirginia',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'standard', namespaces: 1, pushes: 5000000 },
      // Retail API US Gov Virginia Standard Pushes starts with a paid tier at 0M, so 5M pushes have no 10M free allowance.
      expected: async () => retailNotificationHubs({ region: 'usgovvirginia', currency: 'USD', tier: 'standard', namespaces: 1, pushes: 5000000 }),
    },
    {
      name: 'west europe standard namespace',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'notification-hubs', tier: 'standard', namespaces: 1, pushes: 20000000 },
      // Calculator West Europe exposes the same Notification Hubs offers; this verifies non-US region lookup.
      expected: async () => calculatorNotificationHubs({ region: 'westeurope', tier: 'standard', namespaces: 1, pushes: 20000000 }),
    },
    {
      name: 'eur basic with private link',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'notification-hubs', tier: 'basic', namespaces: 1, pushes: 12000000, privateLink: true },
      // Retail API EUR rows: Basic Unit and Private Link Unit are monthly; Basic Pushes are graduated per 1M.
      expected: async () => retailNotificationHubs({ region: 'eastus2', currency: 'EUR', tier: 'basic', namespaces: 1, pushes: 12000000, privateLink: true }),
    },
  ],
};
