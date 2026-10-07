'use strict';
// Azure Maps (current Gen2 pricing: Maps tiles/images and Location Insights transactions).
// Meters: serviceName 'Azure Maps', priced globally (armRegionName 'Global'); the same prices are
// also repeated under individual regions. Every transaction meter is per 1,000 and has a free
// first band (5,000 or 1,000 transactions a month depending on the API) as graduated tier rows.
// Not priced: Gen1 (S0/S1, retired 2026-09-15), Azure Maps Creator (retired 2025-09-30), Data Registry
// (retired 2025-09-30), Spatial and Elevation (no longer in the current Azure Maps REST API list).
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

// field -> [skuName, meterName, plain description]
const GEN2 = {
  baseMapTileTransactions: ['Maps', 'Maps Base Map Tiles', 'base map tile transactions (15 tiles each)'],
  imageryTileTransactions: ['Maps', 'Maps Imagery Tiles', 'imagery tile transactions (15 tiles each)'],
  staticMapImageTransactions: ['Maps', 'Maps Static Map Images', 'static map image requests'],
  trafficTileTransactions: ['Maps', 'Maps Traffic Tiles', 'traffic tile transactions (15 tiles each)'],
  weatherTileTransactions: ['Maps', 'Maps Weather Tiles', 'weather tile transactions (15 tiles each)'],
  searchTransactions: ['Location Insights', 'Location Insights Search', 'search requests'],
  routingTransactions: ['Location Insights', 'Location Insights Routing', 'routing requests'],
  trafficTransactions: ['Location Insights', 'Location Insights Traffic', 'traffic incident requests'],
  weatherTransactions: ['Location Insights', 'Location Insights Weather', 'weather requests'],
  geolocationTransactions: ['Location Insights', 'Location Insights Geolocation', 'IP geolocation requests'],
  timezoneTransactions: ['Location Insights', 'Location Insights Timezone', 'time zone requests']
};

const askTx = what => `How many ${what} a month? One transaction is one request; if unknown, ask for a rough monthly volume and record it as an assumption (0 if not used).`;
const askTile = what => `How many ${what} a month, counted in transactions? Azure Maps counts 1 transaction for every 15 tiles, so if you only know tile counts divide by 15. 0 if not used.`;
const num = ask => ({ def: 0, int: true, min: 0, ask });

module.exports = {
  type: 'azure-maps',
  label: 'Azure Maps',
  family: 'web-other',
  calculator: ['azure-maps'],
  keywords: ['maps', 'geocoding', 'address search', 'routing', 'directions', 'geolocation', 'store locator', 'map tiles'],
  fields: {
    baseMapTileTransactions: num(askTile('base map tile transactions (the normal road map shown in an app or website)')),
    imageryTileTransactions: num(askTile('satellite or aerial imagery tile transactions')),
    staticMapImageTransactions: num(askTx('static map image requests (a picture of a map)')),
    trafficTileTransactions: num(askTile('traffic tile transactions (traffic layer on a map)')),
    weatherTileTransactions: num(askTile('weather tile transactions (weather radar or satellite layer on a map)')),
    searchTransactions: num(askTx('address or place searches (geocoding, autocomplete, reverse geocoding)') + ' Batch calls count each query; autocomplete counts 1 per 10 requests.'),
    routingTransactions: num(askTx('route or directions requests') + ' A route matrix counts 1 per 4 cells.'),
    trafficTransactions: num(askTx('traffic incident data requests (not map tiles)')),
    weatherTransactions: num(askTx('weather data requests (forecasts, current conditions, alerts)')),
    geolocationTransactions: num(askTx('IP-address-to-country/region lookups')),
    timezoneTransactions: num(askTx('time zone lookups'))
  },
  context: [],
  examples: [
    { type: 'azure-maps', searchTransactions: 200000, baseMapTileTransactions: 600000 },
    {
      type: 'azure-maps', searchTransactions: 1000000, routingTransactions: 250000, baseMapTileTransactions: 2000000, imageryTileTransactions: 100000,
      staticMapImageTransactions: 50000, trafficTileTransactions: 300000, weatherTileTransactions: 80000, trafficTransactions: 120000,
      weatherTransactions: 90000, geolocationTransactions: 400000, timezoneTransactions: 30000
    }
  ],
  readback: c => {
    const parts = [];
    for (const [k, [, , what]] of Object.entries(GEN2)) if (n(c[k])) parts.push(`${fmtN(c[k])} ${what}`);
    return `Azure Maps (current Gen2 pricing), per month: ${parts.length ? parts.join(', ') : 'no usage given'}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.length) ? [] : [
    'Volume discounts above the published price bands (negotiated with Microsoft sales)',
    'Retired Azure Maps features are not priced: Gen1 S0/S1 (retired 2026-09-15), Creator indoor maps and Data Registry (retired 2025-09-30), plus Spatial and Elevation'
  ],
  price: async (c, ctx) => {
    const rs = await rows(`serviceName eq 'Azure Maps' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError('Azure Maps prices were not found.');
    const lines = [];
    for (const [k, [sku, meter, what]] of Object.entries(GEN2)) {
      if (!n(c[k])) continue;
      const m = single(rs.filter(r => r.skuName === sku && r.meterName === meter && r.unitOfMeasure === '1K'), meter);
      lines.push(meterLine('Web', 'Azure Maps', `${what.charAt(0).toUpperCase() + what.slice(1)} (${meter.replace(/^(Maps|Location Insights) /, '')}), ${fmtN(c[k])}/month`, m, n(c[k]), ctx, { unit: 'transactions' }));
    }
    if (!lines.length) throw new PricingError('No Azure Maps usage given: set at least one transaction count above 0.');
    const notes = [
      'Azure Maps bills per 1,000 transactions. Each API has its own free monthly allowance (the first 5,000 or 1,000 transactions depending on the API); the free band is already applied.',
      'Tile requests count 1 transaction per 15 tiles; Get Copyright, Get Attribution and Terra maps are not billed. Azure Maps is priced globally, so the account region does not change the price.'
    ];
    if (/^usgov/.test(ctx.region)) notes.push('US Government regions also list free (0-price) Geospatial Analytics meters; they are not part of this estimate.');
    return { lines, notes, facts: { transactions: Object.keys(GEN2).reduce((t, k) => t + n(c[k]), 0) } };
  }
};
