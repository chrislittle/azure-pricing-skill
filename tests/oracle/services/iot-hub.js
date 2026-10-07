'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'iot-hub';
const SIZE_CAPS = { 1: 400000, 2: 6000000, 3: 300000000 };

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function billableMessagesPerDay(messagesPerDay, messageSizeKb = 4) {
  return messagesPerDay * Math.ceil(messageSizeKb / 4);
}

function offerFor(tier, size) {
  if (tier === 'basic') return `basic-b${size}`;
  if (tier === 'standard') return `standard-s${size}`;
  return 'standard-free';
}

async function calculatorOffer(offer, region) {
  const p = await calc.offerPrice(SLUG, offer, region);
  return p.value;
}

async function retailRows(region, currency) {
  return dedupe(await query(`serviceName eq 'IoT Hub' and armRegionName eq '${region}'`, currency));
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function retailMeter(region, currency, productName, skuName, meterName) {
  const rows = await retailRows(region, currency);
  return pickOne(rows, r => r.productName === productName && r.skuName === skuName && r.meterName === meterName && r.type === 'Consumption', `${productName} ${skuName} ${meterName}`);
}

async function calculatorHubLine({ region, tier, size = 'auto', units = 0, messagesPerDay, messageSizeKb = 4 }) {
  if (tier === 'free') {
    const price = await calculatorOffer('standard-free', region);
    return line(`IoT Hub Free unit: 1 * ${price}`, price, { sourceOffer: 'standard-free' });
  }

  const billable = billableMessagesPerDay(messagesPerDay, messageSizeKb);
  const candidates = size === 'auto' ? ['1', '2', '3'] : [String(size)];
  let best;
  for (const s of candidates) {
    const offer = offerFor(tier, s);
    const price = await calculatorOffer(offer, region);
    const needed = units > 0 ? units : Math.max(1, Math.ceil(billable / SIZE_CAPS[s]));
    const monthlyList = needed * price;
    if (!best || monthlyList < best.monthlyList) best = { size: s, offer, price, needed, monthlyList };
  }
  return line(`${tier} size ${best.size}: ${best.needed} units for ${billable}/day billable messages * ${best.price}`, best.monthlyList, { sourceOffer: best.offer });
}

async function calculatorDeviceUpdate({ region, deviceUpdate, deviceUpdateDevices = 0, deviceUpdateInstances = 1 }) {
  const lines = [];
  if (deviceUpdate === 'free') {
    const instancePrice = await calculatorOffer('freeedition-instances', region);
    const devicePrice = await calculatorOffer('freeedition-devices', region);
    lines.push(line(`Device Update Free instances: ${deviceUpdateInstances} * ${instancePrice}`, deviceUpdateInstances * instancePrice, { sourceOffer: 'freeedition-instances' }));
    lines.push(line(`Device Update Free devices: ${deviceUpdateDevices} * ${devicePrice}`, deviceUpdateDevices * devicePrice, { sourceOffer: 'freeedition-devices' }));
  } else if (deviceUpdate === 'standard') {
    const instancePrice = await calculatorOffer('update-device-standard-instances', region);
    const devicePrice = await calculatorOffer('update-device-standard', region);
    lines.push(line(`Device Update Standard instances: ${deviceUpdateInstances} * ${instancePrice}`, deviceUpdateInstances * instancePrice, { sourceOffer: 'update-device-standard-instances' }));
    lines.push(line(`Device Update Standard devices: ${deviceUpdateDevices} * ${devicePrice}`, deviceUpdateDevices * devicePrice, { sourceOffer: 'update-device-standard' }));
  }
  return lines;
}

async function retailDpsLine({ region, currency, provisioningOperations }) {
  if (!provisioningOperations) return null;
  const m = await retailMeter(region, currency, 'IoT Hub Device Provisioning', 'S1', 'S1 Operations');
  return line(`DPS operations: ${provisioningOperations} / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (provisioningOperations / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId });
}

async function calculatorIoTHub(opts) {
  const lines = [await calculatorHubLine(opts)];
  const dps = await retailDpsLine(opts);
  if (dps) lines.push(dps);
  lines.push(...await calculatorDeviceUpdate(opts));
  return { monthlyList: totalOf(lines), lines };
}

async function retailHubLine({ region, currency, tier, size = 'auto', units = 0, messagesPerDay, messageSizeKb = 4 }) {
  if (tier === 'free') {
    const m = await retailMeter(region, currency, 'IoT Hub', 'Free', 'Free Unit');
    return line(`Retail API IoT Hub Free unit: 1 * ${m.retailPrice}`, m.retailPrice, { meterId: m.meterId });
  }

  const rows = await retailRows(region, currency);
  const billable = billableMessagesPerDay(messagesPerDay, messageSizeKb);
  const prefix = tier === 'basic' ? 'B' : 'S';
  const candidates = size === 'auto' ? ['1', '2', '3'] : [String(size)];
  let best;
  for (const s of candidates) {
    const sku = `${prefix}${s}`;
    const m = pickOne(rows, r => r.productName === 'IoT Hub' && r.skuName === sku && r.meterName === `${sku} Unit` && r.type === 'Consumption', `IoT Hub ${sku}`);
    const needed = units > 0 ? units : Math.max(1, Math.ceil(billable / SIZE_CAPS[s]));
    const monthlyList = needed * m.retailPrice;
    if (!best || monthlyList < best.monthlyList) best = { s, needed, m, monthlyList };
  }
  return line(`Retail API ${tier} size ${best.s}: ${best.needed} units for ${billable}/day billable messages * ${best.m.retailPrice}`, best.monthlyList, { meterId: best.m.meterId });
}

async function retailDeviceUpdate({ region, currency, deviceUpdate, deviceUpdateDevices = 0, deviceUpdateInstances = 1 }) {
  if (deviceUpdate === 'none') return [];
  const rows = await retailRows(region, currency);
  const sku = deviceUpdate === 'standard' ? 'Standard' : 'Free';
  const inst = pickOne(rows, r => r.productName === 'Device Update for IoT Hub' && r.skuName === sku && r.meterName === `${sku} 1 DU instance` && r.type === 'Consumption', `${sku} Device Update instance`);
  const dev = pickOne(rows, r => r.productName === 'Device Update for IoT Hub' && r.skuName === sku && r.meterName === `${sku} 1 Device Unit` && r.type === 'Consumption', `${sku} Device Update device`);
  return [
    line(`Retail API Device Update ${sku} instances: ${deviceUpdateInstances} * ${inst.retailPrice}`, deviceUpdateInstances * inst.retailPrice, { meterId: inst.meterId }),
    line(`Retail API Device Update ${sku} devices: ${deviceUpdateDevices} * ${dev.retailPrice}`, deviceUpdateDevices * dev.retailPrice, { meterId: dev.meterId }),
  ];
}

async function retailIoTHub(opts) {
  const lines = [await retailHubLine(opts)];
  const dps = await retailDpsLine(opts);
  if (dps) lines.push(dps);
  lines.push(...await retailDeviceUpdate(opts));
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'iot-hub',
  source: 'both',
  cases: [
    {
      name: 'free tier just below daily grant',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'free', messagesPerDay: 7999, messageSizeKb: 4 },
      // Calculator IoT Hub Free unit is $0/month; 7,999 messages/day is within the public 8,000/day grant.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'free', messagesPerDay: 7999, messageSizeKb: 4, deviceUpdate: 'none' }),
    },
    {
      name: 'free tier just above daily grant still has zero list price',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'free', messagesPerDay: 8001, messageSizeKb: 4 },
      // Calculator exposes only the $0 Free unit price; the 8,001/day case documents the grant boundary as a validation concern, not extra billable overage.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'free', messagesPerDay: 8001, messageSizeKb: 4, deviceUpdate: 'none' }),
    },
    {
      name: 'basic b1 explicit size with 4 KB messages',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'basic', size: '1', messagesPerDay: 400000, messageSizeKb: 4 },
      // Calculator basic-b1 offer is a monthly unit; 400,000 4 KB messages/day fits one B1 unit.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'basic', size: '1', messagesPerDay: 400000, messageSizeKb: 4, deviceUpdate: 'none' }),
    },
    {
      name: 'basic auto just above one b1 needs two b1 units',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'basic', size: 'auto', messagesPerDay: 400001, messageSizeKb: 4 },
      // Calculator basic-b1 is $10/month; just above 400,000/day needs two B1 units, which is still cheaper than one B2.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'basic', size: 'auto', messagesPerDay: 400001, messageSizeKb: 4, deviceUpdate: 'none' }),
    },
    {
      name: 'standard s2 with larger message blocks and provisioning',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'standard', size: '2', messagesPerDay: 2000000, messageSizeKb: 6, provisioningOperations: 2500 },
      // Calculator standard-s2 is monthly; 6 KB messages count as two 4 KB blocks, plus Retail API DPS S1 Operations per 1K.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'standard', size: '2', messagesPerDay: 2000000, messageSizeKb: 6, provisioningOperations: 2500, deviceUpdate: 'none' }),
    },
    {
      name: 'standard auto chooses s2 over many s1 units',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'standard', size: 'auto', messagesPerDay: 5000000, messageSizeKb: 4 },
      // Calculator standard-s2 one unit at $250 is cheaper than 13 standard-s1 units at $25 each for 5,000,000 messages/day.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'standard', size: 'auto', messagesPerDay: 5000000, messageSizeKb: 4, deviceUpdate: 'none' }),
    },
    {
      name: 'standard auto chooses s3 over many s2 units',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'standard', size: 'auto', messagesPerDay: 70000000, messageSizeKb: 4 },
      // Calculator standard-s3 one unit at $2,500 is cheaper than 12 standard-s2 units at $250 each for 70,000,000 messages/day.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'standard', size: 'auto', messagesPerDay: 70000000, messageSizeKb: 4, deviceUpdate: 'none' }),
    },
    {
      name: 'standard s3 explicit two units',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'standard', size: '3', units: 2, messagesPerDay: 100000000, messageSizeKb: 4 },
      // Calculator standard-s3 offer is a monthly unit; explicit units override auto-sizing, so charge two S3 units.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'standard', size: '3', units: 2, messagesPerDay: 100000000, messageSizeKb: 4, deviceUpdate: 'none' }),
    },
    {
      name: 'standard device update free edition',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'standard', size: '1', messagesPerDay: 100000, deviceUpdate: 'free', deviceUpdateDevices: 10, deviceUpdateInstances: 1 },
      // Calculator freeedition-instances and freeedition-devices offers are both $0 for the free Device Update tier.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'standard', size: '1', messagesPerDay: 100000, deviceUpdate: 'free', deviceUpdateDevices: 10, deviceUpdateInstances: 1 }),
    },
    {
      name: 'standard device update production',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'standard', size: '1', messagesPerDay: 100000, deviceUpdate: 'standard', deviceUpdateDevices: 1000, deviceUpdateInstances: 2 },
      // Calculator Device Update Standard charges per DU instance and per device-month.
      expected: async () => calculatorIoTHub({ region: 'eastus2', currency: 'USD', tier: 'standard', size: '1', messagesPerDay: 100000, deviceUpdate: 'standard', deviceUpdateDevices: 1000, deviceUpdateInstances: 2 }),
    },
    {
      name: 'brazil south basic regional price',
      region: 'brazilsouth',
      currency: 'USD',
      component: { type: 'iot-hub', tier: 'basic', size: '2', messagesPerDay: 1000000, messageSizeKb: 4 },
      // Calculator Brazil South basic-b2 regional offer is $100/month, double East US 2.
      expected: async () => calculatorIoTHub({ region: 'brazilsouth', currency: 'USD', tier: 'basic', size: '2', messagesPerDay: 1000000, messageSizeKb: 4, deviceUpdate: 'none' }),
    },
    {
      name: 'eur standard with dps and device update',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'iot-hub', tier: 'standard', size: '1', messagesPerDay: 100000, provisioningOperations: 10000, deviceUpdate: 'standard', deviceUpdateDevices: 100, deviceUpdateInstances: 1 },
      // Retail API EUR meters: S1 Unit per month, DPS S1 Operations per 1K, Device Update per instance-month and device-month.
      expected: async () => retailIoTHub({ region: 'eastus2', currency: 'EUR', tier: 'standard', size: '1', messagesPerDay: 100000, provisioningOperations: 10000, deviceUpdate: 'standard', deviceUpdateDevices: 100, deviceUpdateInstances: 1 }),
    },
    {
      name: 'west europe eur standard auto with provisioning',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'iot-hub', tier: 'standard', size: 'auto', messagesPerDay: 5000000, messageSizeKb: 4, provisioningOperations: 10000, deviceUpdate: 'none' },
      // Retail API West Europe EUR meters: auto-size selects one S2 unit, plus DPS S1 Operations per 1K.
      expected: async () => retailIoTHub({ region: 'westeurope', currency: 'EUR', tier: 'standard', size: 'auto', messagesPerDay: 5000000, messageSizeKb: 4, provisioningOperations: 10000, deviceUpdate: 'none' }),
    },
  ],
};
