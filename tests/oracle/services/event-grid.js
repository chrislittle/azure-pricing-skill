'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'event-grid';
const HOURS_PER_MONTH = 730;

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calcOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }

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
  return dedupe(await query(`serviceName eq 'Event Grid' and armRegionName eq '${region}'`, currency));
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function calculatorEventGrid({ region, tier, operations = 0, mqttOperations = 0, throughputUnits = 0, hours = HOURS_PER_MONTH }) {
  const lines = [];
  if (tier === 'basic') {
    const g = await graduatedCalc('event-grid', region, operations / 100000);
    lines.push(line(`Basic operations: graduated ${operations / 100000} * 100K operations (first 100K free)`, g.cost, { sourceOffer: 'event-grid', bands: g.bands }));
  } else {
    const ev = await graduatedCalc('event-grid-standard-event-operations', region, operations / 1e6);
    lines.push(line(`Standard event operations: graduated ${operations / 1e6} million operations (first 1M free)`, ev.cost, { sourceOffer: 'event-grid-standard-event-operations', bands: ev.bands }));
    if (mqttOperations) {
      const mqtt = await graduatedCalc('event-grid-standard-mqtt-operations', region, mqttOperations / 1e6);
      lines.push(line(`Standard MQTT operations: graduated ${mqttOperations / 1e6} million operations (first 1M free)`, mqtt.cost, { sourceOffer: 'event-grid-standard-mqtt-operations', bands: mqtt.bands }));
    }
    if (throughputUnits) {
      const tu = await calcOffer('event-grid-standard-throughput', region);
      lines.push(line(`Standard throughput units: ${throughputUnits} * ${hours} hours * ${tu}`, throughputUnits * hours * tu, { sourceOffer: 'event-grid-standard-throughput' }));
    }
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailEventGrid({ region, currency = 'EUR', tier, operations = 0, mqttOperations = 0, throughputUnits = 0, hours = HOURS_PER_MONTH }) {
  const rows = await retailRows(region, currency);
  const lines = [];
  if (tier === 'basic') {
    const ops = rows.filter(r => r.meterName === 'Standard Operations');
    lines.push(line(`EUR Basic/Event Grid operations: graduated ${operations / unitSize(ops[0].unitOfMeasure)} * ${ops[0].unitOfMeasure} (first 100K free)`, tiered(ops, operations / unitSize(ops[0].unitOfMeasure)), { meterId: ops[0].meterId }));
  } else {
    const ev = rows.filter(r => r.meterName === 'Standard Event Operations');
    lines.push(line(`EUR Standard event operations: graduated ${operations / unitSize(ev[0].unitOfMeasure)} million operations (first 1M free)`, tiered(ev, operations / unitSize(ev[0].unitOfMeasure)), { meterId: ev[0].meterId }));
    if (mqttOperations) {
      const mqtt = rows.filter(r => r.meterName === 'Standard MQTT Operations');
      lines.push(line(`EUR Standard MQTT operations: graduated ${mqttOperations / unitSize(mqtt[0].unitOfMeasure)} million operations (first 1M free)`, tiered(mqtt, mqttOperations / unitSize(mqtt[0].unitOfMeasure)), { meterId: mqtt[0].meterId }));
    }
    if (throughputUnits) {
      const tu = pickOne(rows, r => r.meterName === 'Standard Throughput Unit', 'standard throughput unit');
      lines.push(line(`EUR Standard throughput units: ${throughputUnits} * ${hours} hours * ${tu.retailPrice}`, throughputUnits * hours * tu.retailPrice, { meterId: tu.meterId }));
    }
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'event-grid',
  source: 'both',
  cases: [
    {
      name: 'basic at 100K free operations boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-grid', tier: 'basic', operations: 100000 },
      // Calculator graduated event-grid offer uses 100K-operation units; the first one is free.
      expected: async () => calculatorEventGrid({ region: 'eastus2', tier: 'basic', operations: 100000 }),
    },
    {
      name: 'basic just above 100K free operations',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-grid', tier: 'basic', operations: 200000 },
      // Calculator event-grid charges one 100K unit above the first free 100K operations.
      expected: async () => calculatorEventGrid({ region: 'eastus2', tier: 'basic', operations: 200000 }),
    },
    {
      name: 'standard at 1M free event operations',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-grid', tier: 'standard', operations: 1000000, throughputUnits: 1, hours: 0 },
      // Calculator Standard event operations have a first 1M free grant; throughput is zeroed by hours for this boundary case.
      expected: async () => calculatorEventGrid({ region: 'eastus2', tier: 'standard', operations: 1000000, throughputUnits: 1, hours: 0 }),
    },
    {
      name: 'standard event and mqtt just above free grants',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-grid', tier: 'standard', operations: 2000000, mqttOperations: 2000000, throughputUnits: 1, hours: 365 },
      // Calculator Standard charges one paid 1M unit for event operations, one for MQTT operations, plus part-time throughput unit hours.
      expected: async () => calculatorEventGrid({ region: 'eastus2', tier: 'standard', operations: 2000000, mqttOperations: 2000000, throughputUnits: 1, hours: 365 }),
    },
    {
      name: 'non-US brazil south throughput regional price',
      region: 'brazilsouth',
      currency: 'USD',
      component: { type: 'event-grid', tier: 'standard', operations: 3000000, mqttOperations: 1000000, throughputUnits: 2, hours: 730 },
      // Calculator Brazil South Standard throughput-unit offer differs from East US 2 while operation grants remain graduated.
      expected: async () => calculatorEventGrid({ region: 'brazilsouth', tier: 'standard', operations: 3000000, mqttOperations: 1000000, throughputUnits: 2, hours: 730 }),
    },
    {
      name: 'default tier is basic at free boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-grid', operations: 100000 },
      // Public questions default tier is basic; omitting tier should use Basic and the first 100K operations are free.
      expected: async () => calculatorEventGrid({ region: 'eastus2', tier: 'basic', operations: 100000 }),
    },
    {
      name: 'standard throughput units maximum 40',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-grid', tier: 'standard', operations: 1000000, throughputUnits: 40, hours: 730 },
      // Public questions constrain Standard throughputUnits to an integer from 1 to 40; this covers the valid maximum.
      expected: async () => calculatorEventGrid({ region: 'eastus2', tier: 'standard', operations: 1000000, throughputUnits: 40, hours: 730 }),
    },
    {
      name: 'EUR retail API standard operations and throughput',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'event-grid', tier: 'standard', operations: 2000000, mqttOperations: 2000000, throughputUnits: 1, hours: 365 },
      // Retail API EUR Event Grid rows expose free tierMinimumUnits=1 for event/MQTT operation meters and hourly throughput unit pricing.
      expected: async () => retailEventGrid({ region: 'westeurope', currency: 'EUR', tier: 'standard', operations: 2000000, mqttOperations: 2000000, throughputUnits: 1, hours: 365 }),
    },
  ],
};
