'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'event-hubs';
const HOURS_PER_MONTH = 730;

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calcOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }

async function retailRows(region, currency) {
  return dedupe(await query(`serviceName eq 'Event Hubs' and armRegionName eq '${region}'`, currency));
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function calculatorEventHubs({ region, tier, units = 1, ingressEvents = 0, capture = false, retainedGb = 0, geoReplicationGb = 0, geoReplication = false, geoSecondaryRegion = '', hours = HOURS_PER_MONTH }) {
  const lines = [];
  if (tier === 'basic') {
    const hour = await calcOffer('basic-perhour', region);
    const events = await calcOffer('basic-permillionevents', region);
    lines.push(line(`Basic throughput units: ${units} * ${hours} hours * ${hour}`, units * hours * hour, { sourceOffer: 'basic-perhour' }));
    lines.push(line(`Basic ingress events: ${ingressEvents} / 1M * ${events}`, (ingressEvents / 1e6) * events, { sourceOffer: 'basic-permillionevents' }));
  }
  if (tier === 'standard') {
    const hour = await calcOffer('standard-perhour', region);
    const events = await calcOffer('standard-permillionevents', region);
    lines.push(line(`Standard throughput units: ${units} * ${hours} hours * ${hour}`, units * hours * hour, { sourceOffer: 'standard-perhour' }));
    lines.push(line(`Standard ingress events: ${ingressEvents} / 1M * ${events}`, (ingressEvents / 1e6) * events, { sourceOffer: 'standard-permillionevents' }));
    if (capture) {
      const cap = await calcOffer('standard-percapturehour', region);
      lines.push(line(`Standard Capture: ${units} throughput units * ${hours} hours * ${cap}`, units * hours * cap, { sourceOffer: 'standard-percapturehour' }));
    }
  }
  if (tier === 'premium') {
    const pu = await calcOffer('premium-perhour', region);
    lines.push(line(`Premium processing units: ${units} * ${hours} hours * ${pu}`, units * hours * pu, { sourceOffer: 'premium-perhour' }));
    const billable = Math.max(0, retainedGb - units * 1024);
    if (retainedGb) {
      const retention = await calcOffer('premium-pergbpermonth', region);
      lines.push(line(`Premium extended retention: max(0, ${retainedGb} - ${units} * 1,024 included GB) * ${retention}`, billable * retention, { sourceOffer: 'premium-pergbpermonth' }));
    }
  }
  if (tier === 'dedicated') {
    const cu = await calcOffer('dedicated-perhour', region);
    lines.push(line(`Dedicated capacity units: ${units} * ${hours} hours * ${cu}`, units * hours * cu, { sourceOffer: 'dedicated-perhour' }));
    const billable = Math.max(0, retainedGb - units * 10240);
    if (retainedGb) {
      const retention = await calcOffer('dedicated-pergbpermonth', region);
      lines.push(line(`Dedicated extended retention: max(0, ${retainedGb} - ${units} * 10,240 included GB) * ${retention}`, billable * retention, { sourceOffer: 'dedicated-pergbpermonth' }));
    }
  }
  if (geoReplication) {
    // Microsoft pricing states geo-replication runs a secondary Premium/Dedicated namespace with the same unit count, billed in addition.
    const secondaryRegion = geoSecondaryRegion || region;
    const secOffer = tier === 'premium' ? 'premium-perhour' : tier === 'dedicated' ? 'dedicated-perhour' : null;
    if (secOffer) {
      const sec = await calcOffer(secOffer, secondaryRegion);
      lines.push(line(`Geo-replication secondary ${tier} units in ${secondaryRegion}: ${units} * ${hours} hours * ${sec}`, units * hours * sec, { sourceOffer: secOffer }));
    }
  }
  if (geoReplicationGb) {
    const geo = await calcOffer('geo-replication-zone1-pergb', region);
    lines.push(line(`Geo-replication Zone 1 data transfer: ${geoReplicationGb} GB * ${geo}`, geoReplicationGb * geo, { sourceOffer: 'geo-replication-zone1-pergb' }));
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailEventHubs({ region, currency = 'EUR', tier, units = 1, ingressEvents = 0, capture = false, retainedGb = 0, geoReplicationGb = 0, geoReplication = false, hours = HOURS_PER_MONTH }) {
  const rows = await retailRows(region, currency);
  const lines = [];
  const sku = tier[0].toUpperCase() + tier.slice(1);
  if (tier === 'basic' || tier === 'standard') {
    const tu = pickOne(rows, r => r.skuName === sku && r.meterName === `${sku} Throughput Unit`, `${sku} throughput unit`);
    const events = pickOne(rows, r => r.skuName === sku && r.meterName === `${sku} Ingress Events`, `${sku} ingress events`);
    lines.push(line(`EUR ${sku} throughput units: ${units} * ${hours} hours * ${tu.retailPrice}`, units * hours * tu.retailPrice, { meterId: tu.meterId }));
    lines.push(line(`EUR ${sku} ingress events: ${ingressEvents} / ${unitSize(events.unitOfMeasure)} * ${events.retailPrice}`, (ingressEvents / unitSize(events.unitOfMeasure)) * events.retailPrice, { meterId: events.meterId }));
    if (capture) {
      const cap = pickOne(rows, r => r.skuName === 'Standard' && r.meterName === 'Standard Capture', 'standard capture');
      lines.push(line(`EUR Standard Capture: ${units} * ${hours} * ${cap.retailPrice}`, units * hours * cap.retailPrice, { meterId: cap.meterId }));
    }
  }
  if (tier === 'premium') {
    const pu = pickOne(rows, r => r.skuName === 'Premium' && r.meterName === 'Premium Processing Unit', 'premium processing unit');
    lines.push(line(`EUR Premium processing units: ${units} * ${hours} * ${pu.retailPrice}`, units * hours * pu.retailPrice, { meterId: pu.meterId }));
    if (retainedGb) {
      const ret = pickOne(rows, r => r.skuName === 'Premium' && r.meterName === 'Premium Extended Retention', 'premium retention');
      lines.push(line(`EUR Premium retention: max(0, ${retainedGb} - ${units} * 1,024) GB * ${ret.retailPrice}`, Math.max(0, retainedGb - units * 1024) * ret.retailPrice, { meterId: ret.meterId }));
    }
  }
  if (tier === 'dedicated') {
    const cu = pickOne(rows, r => r.skuName === 'Dedicated' && r.meterName === 'Dedicated Capacity Unit', 'dedicated capacity unit');
    lines.push(line(`EUR Dedicated capacity units: ${units} * ${hours} * ${cu.retailPrice}`, units * hours * cu.retailPrice, { meterId: cu.meterId }));
    if (retainedGb) {
      const ret = pickOne(rows, r => r.skuName === 'Dedicated' && r.meterName === 'Dedicated Extended Retention', 'dedicated retention');
      lines.push(line(`EUR Dedicated retention: max(0, ${retainedGb} - ${units} * 10,240) GB * ${ret.retailPrice}`, Math.max(0, retainedGb - units * 10240) * ret.retailPrice, { meterId: ret.meterId }));
    }
  }
  if (geoReplication) {
    const meterName = tier === 'premium' ? 'Premium Processing Unit' : tier === 'dedicated' ? 'Dedicated Capacity Unit' : null;
    if (meterName) {
      const sec = pickOne(rows, r => r.meterName === meterName && r.unitOfMeasure === '1 Hour', `${tier} secondary units`);
      lines.push(line(`EUR Geo-replication secondary ${tier} units: ${units} * ${hours} * ${sec.retailPrice}`, units * hours * sec.retailPrice, { meterId: sec.meterId }));
    }
  }
  if (geoReplicationGb) {
    const geo = pickOne(rows, r => r.skuName === 'Geo Replication Zone 1', 'geo-replication');
    lines.push(line(`EUR Geo-replication data transfer: ${geoReplicationGb} GB * ${geo.retailPrice}`, geoReplicationGb * geo.retailPrice, { meterId: geo.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'event-hubs',
  source: 'both',
  cases: [
    {
      name: 'basic throughput and ingress',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-hubs', tier: 'basic', units: 1, ingressEvents: 2000000 },
      // Calculator Basic bills throughput units per hour and ingress events per million.
      expected: async () => calculatorEventHubs({ region: 'eastus2', tier: 'basic', units: 1, ingressEvents: 2000000 }),
    },
    {
      name: 'standard with capture and part-time hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-hubs', tier: 'standard', units: 2, ingressEvents: 5000000, capture: true, hours: 365 },
      // Calculator Standard bills throughput unit-hours, ingress per million, and Capture per throughput unit-hour.
      expected: async () => calculatorEventHubs({ region: 'eastus2', tier: 'standard', units: 2, ingressEvents: 5000000, capture: true, hours: 365 }),
    },
    {
      name: 'premium retention within included 1 TB per processing unit',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-hubs', tier: 'premium', units: 1, retainedGb: 1024 },
      // Calculator Premium includes 1,024 GB retained per processing unit; exactly one included TB has no retention overage.
      expected: async () => calculatorEventHubs({ region: 'eastus2', tier: 'premium', units: 1, retainedGb: 1024 }),
    },
    {
      name: 'premium retention just above included grant with geo replication',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-hubs', tier: 'premium', units: 1, retainedGb: 1025, geoReplication: true, geoReplicationGb: 100 },
      // Calculator Premium charges one GB above the included 1 TB plus Zone 1 geo-replication data transfer.
      expected: async () => calculatorEventHubs({ region: 'eastus2', tier: 'premium', units: 1, retainedGb: 1025, geoReplication: true, geoReplicationGb: 100 }),
    },
    {
      name: 'dedicated retention just above included 10 TB',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'event-hubs', tier: 'dedicated', units: 1, retainedGb: 10241, hours: 730 },
      // Calculator Dedicated includes 10,240 GB retained per capacity unit; this charges one extra GB.
      expected: async () => calculatorEventHubs({ region: 'eastus2', tier: 'dedicated', units: 1, retainedGb: 10241, hours: 730 }),
    },
    {
      name: 'non-US west europe premium regional prices',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'event-hubs', tier: 'premium', units: 2, retainedGb: 3000, geoReplication: true, geoReplicationGb: 50, geoSecondaryRegion: 'switzerlandnorth' },
      // Calculator West Europe Premium processing-unit and extended-retention offers differ from East US 2.
      expected: async () => calculatorEventHubs({ region: 'westeurope', tier: 'premium', units: 2, retainedGb: 3000, geoReplication: true, geoReplicationGb: 50, geoSecondaryRegion: 'switzerlandnorth' }),
    },
    {
      name: 'dedicated germany north hourly capacity only',
      region: 'germanynorth',
      currency: 'USD',
      component: { type: 'event-hubs', tier: 'dedicated', units: 1, hours: 24 },
      // Calculator and Retail API have Dedicated Capacity Unit hourly rows in Germany North; no ingress or retention overage is included here.
      expected: async () => calculatorEventHubs({ region: 'germanynorth', tier: 'dedicated', units: 1, hours: 24 }),
    },
    {
      name: 'dedicated switzerland north hourly capacity only',
      region: 'switzerlandnorth',
      currency: 'USD',
      component: { type: 'event-hubs', tier: 'dedicated', units: 1, hours: 24 },
      // Calculator and Retail API have Dedicated Capacity Unit hourly rows in Switzerland North; ignore supplemental day rows and bill the hourly meter.
      expected: async () => calculatorEventHubs({ region: 'switzerlandnorth', tier: 'dedicated', units: 1, hours: 24 }),
    },
    {
      name: 'EUR retail API standard with capture',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'event-hubs', tier: 'standard', units: 2, ingressEvents: 5000000, capture: true },
      // Retail API EUR rows expose Standard Throughput Unit, Standard Ingress Events per 1M, and Standard Capture per hour.
      expected: async () => retailEventHubs({ region: 'westeurope', currency: 'EUR', tier: 'standard', units: 2, ingressEvents: 5000000, capture: true }),
    },
  ],
};
