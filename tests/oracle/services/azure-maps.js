'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'azure-maps';
const THOUSAND = 1000;
const API_FIELDS = {
  searchTransactions: ['location-search', 'Location Insights', 'Location Insights Search'],
  routingTransactions: ['location-routing', 'Location Insights', 'Location Insights Routing'],
  baseMapTileTransactions: ['maps-base-map-tiles', 'Maps', 'Maps Base Map Tiles'],
  imageryTileTransactions: ['maps-imagery-tiles', 'Maps', 'Maps Imagery Tiles'],
  staticMapImageTransactions: ['maps-static-map-images', 'Maps', 'Maps Static Map Images'],
  trafficTileTransactions: ['maps-traffic-tiles', 'Maps', 'Maps Traffic Tiles'],
  weatherTileTransactions: ['maps-weather-tiles', 'Maps', 'Maps Weather Tiles'],
  trafficTransactions: ['location-traffic', 'Location Insights', 'Location Insights Traffic'],
  weatherTransactions: ['location-weather', 'Location Insights', 'Location Insights Weather'],
  geolocationTransactions: ['location-geolocation', 'Location Insights', 'Location Insights Geolocation'],
  timezoneTransactions: ['location-timezone', 'Location Insights', 'Location Insights Timezone'],
};

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

function tierWalk(table, qty) {
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
      bands.push({ fromUnits: previous, toUnits: limit === Number.MAX_VALUE ? null : limit, units, unitPrice, cost: round2(bandCost) });
    }
    previous = limit;
    if (qty <= limit) break;
  }
  return { cost, bands };
}

async function calculatorGraduated(offer, region, transactions) {
  const data = await calc.product(SLUG);
  const calcRegion = calc.calcRegion(data, region);
  const table = data.graduatedOffers[offer][calcRegion];
  if (!table) throw new Error(`calculator has no ${offer} graduated prices for ${calcRegion}`);
  return tierWalk(table, transactions / THOUSAND);
}

async function calculatorAzureMaps(opts) {
  const { region } = opts;
  const lines = [];
  for (const [field, [offer]] of Object.entries(API_FIELDS)) {
    const qty = opts[field] || 0;
    if (!qty) continue;
    const g = await calculatorGraduated(offer, region, qty);
    lines.push(line(`${field}: ${qty} transactions / 1K through ${offer} graduated bands`, g.cost, { sourceOffer: offer, bands: g.bands }));
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailRows(region, currency) {
  return dedupe(await query(`serviceName eq 'Azure Maps' and armRegionName eq '${region}'`, currency));
}

function pickRows(rows, pred, what) {
  const hits = rows.filter(pred);
  if (!hits.length) throw new Error(`expected Retail API rows for ${what}, found ${hits.length}`);
  return hits;
}

function retailTiered(rows, transactions) {
  const qty = transactions / unitSize(rows[0].unitOfMeasure);
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

async function retailAzureMaps(opts) {
  const { region, currency } = opts;
  const rows = await retailRows(region, currency);
  const lines = [];
  for (const [field, [, skuName, meterName]] of Object.entries(API_FIELDS)) {
    const qty = opts[field] || 0;
    if (!qty) continue;
    const meterRows = pickRows(rows, r => r.type === 'Consumption' && r.skuName === skuName && r.meterName === meterName, meterName);
    const g = retailTiered(meterRows, qty);
    lines.push(line(`Retail API ${field}: ${qty} transactions / ${meterRows[0].unitOfMeasure} through ${meterName} bands`, g.cost, { meterId: meterRows[0].meterId, bands: g.bands }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'azure-maps',
  source: 'both',
  cases: [
    {
      name: 'search just below free grant',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-maps', searchTransactions: 4999 },
      // Calculator location-search graduated offer is per 1K transactions; first 5 units (5,000 transactions) are free.
      expected: async () => calculatorAzureMaps({ region: 'eastus2', searchTransactions: 4999 }),
    },
    {
      name: 'search just above free grant plus routing boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-maps', searchTransactions: 5001, routingTransactions: 1001 },
      // Calculator search free grant is 5K and routing free grant is 1K; charge only fractional 1K units above each boundary.
      expected: async () => calculatorAzureMaps({ region: 'eastus2', searchTransactions: 5001, routingTransactions: 1001 }),
    },
    {
      name: 'all current transaction dimensions',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-maps', searchTransactions: 10000, routingTransactions: 2000, baseMapTileTransactions: 6000, imageryTileTransactions: 2000, staticMapImageTransactions: 2000, trafficTileTransactions: 6000, weatherTileTransactions: 2000, trafficTransactions: 2000, weatherTransactions: 2000, geolocationTransactions: 6000, timezoneTransactions: 6000 },
      // Calculator graduated offers are per 1K transactions; tile fields are already normalized transactions (15 tiles = 1 transaction).
      expected: async () => calculatorAzureMaps({ region: 'eastus2', searchTransactions: 10000, routingTransactions: 2000, baseMapTileTransactions: 6000, imageryTileTransactions: 2000, staticMapImageTransactions: 2000, trafficTileTransactions: 6000, weatherTileTransactions: 2000, trafficTransactions: 2000, weatherTransactions: 2000, geolocationTransactions: 6000, timezoneTransactions: 6000 }),
    },
    {
      name: 'tile transaction counts after 15-tile normalization',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-maps', baseMapTileTransactions: 6000, imageryTileTransactions: 2000, trafficTileTransactions: 6000, weatherTileTransactions: 2000 },
      // Azure Maps bills map tiles as transactions after the caller divides raw tile requests by 15; use the normalized transaction counts directly.
      expected: async () => calculatorAzureMaps({ region: 'eastus2', baseMapTileTransactions: 6000, imageryTileTransactions: 2000, trafficTileTransactions: 6000, weatherTileTransactions: 2000 }),
    },
    {
      name: 'west europe mixed maps transactions',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'azure-maps', searchTransactions: 10000, baseMapTileTransactions: 10000, weatherTransactions: 2000 },
      // Calculator West Europe exposes the same Azure Maps graduated offers; this verifies non-US calculator region mapping.
      expected: async () => calculatorAzureMaps({ region: 'westeurope', searchTransactions: 10000, baseMapTileTransactions: 10000, weatherTransactions: 2000 }),
    },
    {
      name: 'eur search from Retail API',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'azure-maps', searchTransactions: 10000 },
      // Retail API EUR rows: Location Insights Search is graduated per 1K in native EUR; no FX conversion.
      expected: async () => retailAzureMaps({ region: 'eastus2', currency: 'EUR', searchTransactions: 10000 }),
    },
  ],
};
