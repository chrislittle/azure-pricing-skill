'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'service-bus';
const HOURS_PER_MONTH = 730;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

async function calcOffer(offer, region) {
  return (await calc.offerPrice(SLUG, offer, region)).value;
}

async function graduatedCalc(offer, region, qty) {
  const data = await calc.product(SLUG);
  const calcRegion = calc.calcRegion(data, region);
  const table = data.graduatedOffers[offer][calcRegion];
  if (!table) throw new Error(`calculator has no ${offer} graduated prices for ${calcRegion}`);
  let previous = 0;
  let cost = 0;
  const bands = [];
  for (const band of table.prices) {
    const units = Math.max(0, Math.min(qty, band.limit) - previous);
    if (units) {
      cost += units * band.price.value;
      bands.push({ from: previous, to: band.limit === Number.MAX_VALUE ? null : band.limit, units, unitPrice: band.price.value });
    }
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

async function retailRows(region, currency) {
  return dedupe(await query(`serviceName eq 'Service Bus' and armRegionName eq '${region}'`, currency));
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function calculatorServiceBus({ region, tier, operations = 0, messagingUnits = 1, brokeredConnections = 0, hybridListeners = 0, hybridDataGb = 0, relayHours = 0, relayMessages = 0, geoReplicationGb = 0, geoReplicas = geoReplicationGb ? 1 : 0, geoZone = 1, hours = HOURS_PER_MONTH }) {
  const lines = [];
  if (tier === 'basic') {
    const price = await calcOffer('messages-basic', region);
    lines.push(line(`Basic messaging operations: ${operations} / 1M * ${price}`, (operations / 1e6) * price, { sourceOffer: 'messages-basic' }));
  }
  if (tier === 'standard') {
    const base = await calcOffer('messages-standard', region);
    lines.push(line(`Standard base unit: ${hours} hours * ${base}`, hours * base, { sourceOffer: 'messages-standard' }));
    // US Gov calculator bands start after the free grants (pricing page: First 87M / Next 2,400M), so the grants come off the quantity
    const gov = region.startsWith('usgov');
    const g = await graduatedCalc('messages-standard', region, Math.max(0, operations - (gov ? 13e6 : 0)) / 1e6);
    lines.push(line(`Standard messaging operations: graduated ${operations / 1e6} million operations (first 13M free)`, g.cost, { sourceOffer: 'messages-standard', bands: g.bands }));
    if (brokeredConnections) {
      const c = await graduatedCalc('connections-standard', region, Math.max(0, brokeredConnections - (region.startsWith('usgov') ? 1000 : 0)));
      lines.push(line(`Standard brokered connections: graduated ${brokeredConnections} peak connections (first 1,000 free)`, c.cost, { sourceOffer: 'connections-standard', bands: c.bands }));
    }
  }
  if (tier === 'premium') {
    const price = await calcOffer('messages-premium', region);
    lines.push(line(`Premium messaging units: ${messagingUnits} * ${hours} hours * ${price}`, messagingUnits * hours * price, { sourceOffer: 'messages-premium' }));
    // Pricing page: total cost = replicas (primary + secondaries) * MUs configured on primary * hours * rate
    if (geoReplicas) lines.push(line(`Premium geo-replication secondary messaging units: ${geoReplicas} * ${messagingUnits} * ${hours} hours * ${price}`, geoReplicas * messagingUnits * hours * price, { sourceOffer: 'messages-premium' }));
    if (geoReplicationGb) {
      const geo = await calcOffer(`geo-replication-zone${geoZone}`, region);
      lines.push(line(`Premium geo-replication Zone ${geoZone}: ${geoReplicationGb} GB * ${geo}`, geoReplicationGb * geo, { sourceOffer: `geo-replication-zone${geoZone}` }));
    }
  }
  if (hybridListeners) {
    const listener = await calcOffer('hybrid-connect-standard-perlistener', region);
    lines.push(line(`Hybrid Connections listeners: ${hybridListeners} * ${hours}/730 * ${listener}`, hybridListeners * (hours / HOURS_PER_MONTH) * listener, { sourceOffer: 'hybrid-connect-standard-perlistener' }));
  }
  if (hybridDataGb) {
    const gb = await calcOffer('hybrid-connect-standard-pergb', region);
    lines.push(line(`Hybrid Connections data: max(0, ${hybridDataGb} - 5 GB * ${Math.max(1, hybridListeners)} listener(s)) * ${gb}`, Math.max(0, hybridDataGb - 5 * Math.max(1, hybridListeners)) * gb, { sourceOffer: 'hybrid-connect-standard-pergb' }));
  }
  if (relayHours) {
    const price = await calcOffer('relays-standard-per100hour', region);
    lines.push(line(`WCF Relay hours: ${relayHours} / 100 * ${price}`, (relayHours / 100) * price, { sourceOffer: 'relays-standard-per100hour' }));
  }
  if (relayMessages) {
    const price = await calcOffer('relays-standard-per10000messages', region);
    lines.push(line(`WCF Relay messages: ${relayMessages} / 10,000 * ${price}`, (relayMessages / 10000) * price, { sourceOffer: 'relays-standard-per10000messages' }));
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailServiceBus({ region, currency = 'EUR', tier, operations = 0, messagingUnits = 1, brokeredConnections = 0, hybridListeners = 0, hybridDataGb = 0, relayHours = 0, relayMessages = 0, geoReplicationGb = 0, hours = HOURS_PER_MONTH }) {
  const rows = await retailRows(region, currency);
  const lines = [];
  if (tier === 'basic') {
    const m = pickOne(rows, r => r.skuName === 'Basic' && r.meterName === 'Basic Messaging Operations', 'basic messaging operations');
    lines.push(line(`EUR Basic operations: ${operations} / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (operations / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (tier === 'standard') {
    const base = pickOne(rows, r => r.skuName === 'Standard' && r.meterName === 'Standard Base Unit' && r.unitOfMeasure === '1/Hour', 'standard base hour');
    lines.push(line(`EUR Standard base unit: ${hours} hours * ${base.retailPrice}`, hours * base.retailPrice, { meterId: base.meterId }));
    const ops = rows.filter(r => r.skuName === 'Standard' && r.meterName === 'Standard Messaging Operations');
    lines.push(line(`EUR Standard operations: graduated ${operations / 1e6} million operations (first 13M free)`, tiered(ops, operations / unitSize(ops[0].unitOfMeasure)), { meterId: ops[0].meterId }));
    if (brokeredConnections) {
      const conn = rows.filter(r => r.skuName === 'Standard' && r.meterName === 'Standard Brokered Connection');
      lines.push(line(`EUR brokered connections: graduated ${brokeredConnections} connections`, tiered(conn, brokeredConnections), { meterId: conn[0].meterId }));
    }
  }
  if (tier === 'premium') {
    const m = pickOne(rows, r => r.skuName === 'Premium' && r.meterName === 'Premium Messaging Unit', 'premium messaging unit');
    lines.push(line(`EUR Premium messaging units: ${messagingUnits} * ${hours} hours * ${m.retailPrice}`, messagingUnits * hours * m.retailPrice, { meterId: m.meterId }));
    if (geoReplicationGb) {
      const geo = pickOne(rows, r => r.skuName === 'Geo Replication Zone 1', 'geo replication zone 1');
      lines.push(line(`EUR Premium geo-replication: ${geoReplicationGb} GB * ${geo.retailPrice}`, geoReplicationGb * geo.retailPrice, { meterId: geo.meterId }));
    }
  }
  if (hybridListeners) {
    const listener = pickOne(rows, r => r.skuName === 'Hybrid Connections' && r.meterName === 'Hybrid Connections Listener Unit', 'hybrid listener');
    lines.push(line(`EUR Hybrid listener hours: ${hybridListeners} * ${hours} * ${listener.retailPrice}`, hybridListeners * hours * listener.retailPrice, { meterId: listener.meterId }));
  }
  if (hybridDataGb) {
    const data = rows.filter(r => r.skuName === 'Hybrid Connections' && r.meterName === 'Hybrid Connections Data Transfer');
    lines.push(line(`EUR Hybrid data: graduated ${hybridDataGb} GB (first 5 GB free)`, tiered(data, hybridDataGb), { meterId: data[0].meterId }));
  }
  if (relayHours) {
    const h = pickOne(rows, r => r.skuName === 'WCF Relay' && r.meterName === 'WCF Relay', 'WCF relay hours');
    lines.push(line(`EUR WCF Relay hours: ${relayHours} / ${unitSize(h.unitOfMeasure)} * ${h.retailPrice}`, (relayHours / unitSize(h.unitOfMeasure)) * h.retailPrice, { meterId: h.meterId }));
  }
  if (relayMessages) {
    const msg = pickOne(rows, r => r.skuName === 'WCF Relay' && r.meterName === 'WCF Relay Message', 'WCF relay messages');
    lines.push(line(`EUR WCF Relay messages: ${relayMessages} / ${unitSize(msg.unitOfMeasure)} * ${msg.retailPrice}`, (relayMessages / unitSize(msg.unitOfMeasure)) * msg.retailPrice, { meterId: msg.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'service-bus',
  source: 'both',
  cases: [
    {
      name: 'basic operations per million',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'basic', operations: 2000000 },
      // Calculator offer messages-basic prices Basic messaging operations per 1M operations, with no Standard 13M grant.
      expected: async () => calculatorServiceBus({ region: 'eastus2', tier: 'basic', operations: 2000000 }),
    },
    {
      name: 'standard at 13M free operations boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'standard', operations: 13000000, brokeredConnections: 1000 },
      // Calculator Standard uses the hourly base offer plus graduated messages-standard: first 13 million operations and first 1,000 connections are free.
      expected: async () => calculatorServiceBus({ region: 'eastus2', tier: 'standard', operations: 13000000, brokeredConnections: 1000 }),
    },
    {
      name: 'standard just above free operations and connections',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'standard', operations: 14000000, brokeredConnections: 1001 },
      // Calculator graduated offers charge only 1M operations above the 13M grant and one brokered connection above the 1,000 grant.
      expected: async () => calculatorServiceBus({ region: 'eastus2', tier: 'standard', operations: 14000000, brokeredConnections: 1001 }),
    },
    {
      name: 'hybrid connections free data boundary and relay meters',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'standard', operations: 0, hybridListeners: 2, hybridDataGb: 6, relayHours: 250, relayMessages: 25000, hours: 365 },
      // Calculator hybrid listener is monthly prorated by hours, hybrid data has first 5 GB free, and WCF Relay bills per 100 hours and 10K messages.
      expected: async () => calculatorServiceBus({ region: 'eastus2', tier: 'standard', operations: 0, hybridListeners: 2, hybridDataGb: 6, relayHours: 250, relayMessages: 25000, hours: 365 }),
    },
    {
      name: 'premium messaging units and geo replication',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'premium', operations: 0, messagingUnits: 2, geoReplicationGb: 100, hours: 730 },
      // Calculator Premium bills dedicated messaging units per hour plus Zone 1 geo-replication GB; Basic/Standard operation grants do not apply.
      expected: async () => calculatorServiceBus({ region: 'eastus2', tier: 'premium', messagingUnits: 2, geoReplicationGb: 100, hours: 730 }),
    },
    {
      name: 'non-US brazil south standard regional prices',
      region: 'brazilsouth',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'standard', operations: 120000000, brokeredConnections: 1500 },
      // Calculator Brazil South uses regional Standard base pricing and the same graduated operation/connection grants.
      expected: async () => calculatorServiceBus({ region: 'brazilsouth', tier: 'standard', operations: 120000000, brokeredConnections: 1500 }),
    },
    {
      name: 'EUR retail API standard with hybrid and relay',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'service-bus', tier: 'standard', operations: 14000000, brokeredConnections: 1001, hybridListeners: 1, hybridDataGb: 6, relayHours: 100, relayMessages: 10000 },
      // Retail API EUR rows expose Standard base hour, graduated Standard operations/connections, Hybrid Connection listener/data, and WCF Relay meters.
      expected: async () => retailServiceBus({ region: 'westeurope', currency: 'EUR', tier: 'standard', operations: 14000000, brokeredConnections: 1001, hybridListeners: 1, hybridDataGb: 6, relayHours: 100, relayMessages: 10000 }),
    },
    {
      name: 'premium geo replication zone 2 multi-zone region',
      region: 'malaysiawest',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'premium', operations: 0, messagingUnits: 1, geoReplicationGb: 100 },
      // malaysiawest exposes all three zone meters; the zone follows the primary region's geography (Asia = Zone 2)
      expected: async () => calculatorServiceBus({ region: 'malaysiawest', tier: 'premium', messagingUnits: 1, geoReplicationGb: 100, geoZone: 2 }),
    },
    {
      name: 'premium geo replication with two secondaries',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'premium', operations: 0, messagingUnits: 4, geoReplicas: 2, geoReplicationGb: 50 },
      expected: async () => calculatorServiceBus({ region: 'eastus2', tier: 'premium', messagingUnits: 4, geoReplicas: 2, geoReplicationGb: 50 }),
    },
    {
      name: 'premium geo replication zone 3 brazil south',
      region: 'brazilsouth',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'premium', operations: 0, messagingUnits: 1, geoReplicationGb: 100 },
      // Brazil South is a Zone 3 geo-replication data-transfer region; Premium also bills one secondary MU copy when geoReplicationGb is present.
      expected: async () => calculatorServiceBus({ region: 'brazilsouth', tier: 'premium', messagingUnits: 1, geoReplicationGb: 100, geoZone: 3 }),
    },
    {
      name: 'standard top operation and connection price bands',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'standard', operations: 3000000000, brokeredConnections: 600000 },
      // Calculator Standard top bands apply above 2,500M operations at $0.20/M and above 500,000 brokered connections at $0.015 each.
      expected: async () => calculatorServiceBus({ region: 'eastus2', tier: 'standard', operations: 3000000000, brokeredConnections: 600000 }),
    },
    {
      name: 'us gov standard grants removed from bands',
      region: 'usgovvirginia',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'standard', operations: 14000000, brokeredConnections: 1001 },
      // US Gov bands start at the first billable operation: 1M * 0.8 and 1 connection * 0.0375 after the 13M and 1,000 grants
      expected: async () => calculatorServiceBus({ region: 'usgovvirginia', tier: 'standard', operations: 14000000, brokeredConnections: 1001 }),
    },
    {
      name: 'us gov standard top operation and connection bands',
      region: 'usgovvirginia',
      currency: 'USD',
      component: { type: 'service-bus', tier: 'standard', operations: 3000000000, brokeredConnections: 600000 },
      // US Gov calculator graduated bands are expressed after the free grants: top operations above 2,487M bill at $0.20/M and top connections above 499,000 bill at $0.0188.
      expected: async () => calculatorServiceBus({ region: 'usgovvirginia', tier: 'standard', operations: 3000000000, brokeredConnections: 600000 }),
    },
  ],
};
