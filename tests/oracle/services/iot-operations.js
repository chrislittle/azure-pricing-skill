'use strict';

const { query, dedupe, round2 } = require('../api');

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function retailGlobalRows(serviceName, currency) {
  return dedupe(await query(`serviceName eq '${serviceName}' and armRegionName eq 'Global'`, currency));
}

async function retailIoTOperations({ currency, tier = 'basic', nodes, hours = 730, deviceRegistryAssets = 0, deviceRegistryDevices = 0 }) {
  const opRows = await retailGlobalRows('Azure IoT Operations', currency);
  const regRows = await retailGlobalRows('Azure Device Registry', currency);
  const nodeMeter = tier === 'basic'
    ? pickOne(opRows, r => r.skuName === 'Basic' && r.meterName === 'Basic Node' && r.type === 'Consumption', 'Basic Node')
    : pickOne(opRows, r => r.skuName === 'Essentials Azure IoT Operations' && r.meterName === 'Essentials Azure IoT Operations Node' && r.type === 'Consumption', 'Essentials Node');
  const assetMeter = pickOne(regRows, r => r.skuName === 'Asset' && r.meterName === 'Asset' && r.type === 'Consumption', 'Device Registry Asset');
  const deviceMeter = pickOne(regRows, r => r.skuName === 'Device Device' && r.meterName === 'Device Device' && r.type === 'Consumption', 'Device Registry Device');

  const lines = [
    line(`${tier} nodes: ${nodes} * ${hours} hours * ${nodeMeter.retailPrice}`, nodes * hours * nodeMeter.retailPrice, { meterId: nodeMeter.meterId }),
  ];
  if (deviceRegistryAssets) lines.push(line(`Device Registry assets: ${deviceRegistryAssets} * ${hours} hours * ${assetMeter.retailPrice}`, deviceRegistryAssets * hours * assetMeter.retailPrice, { meterId: assetMeter.meterId }));
  if (deviceRegistryDevices) lines.push(line(`Device Registry devices: ${deviceRegistryDevices} * ${hours} hours * ${deviceMeter.retailPrice}`, deviceRegistryDevices * hours * deviceMeter.retailPrice, { meterId: deviceMeter.meterId }));
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'iot-operations',
  source: 'retail-api',
  cases: [
    {
      name: 'essentials all month',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-operations', tier: 'essentials', nodes: 3, hours: 730 },
      // Retail API Global Essentials Azure IoT Operations Node meter is per node-hour.
      expected: async () => retailIoTOperations({ currency: 'USD', tier: 'essentials', nodes: 3, hours: 730 }),
    },
    {
      name: 'basic all month',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-operations', tier: 'basic', nodes: 3, hours: 730 },
      // Retail API Global Basic Node meter is per node-hour.
      expected: async () => retailIoTOperations({ currency: 'USD', tier: 'basic', nodes: 3, hours: 730 }),
    },
    {
      name: 'default tier is basic',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-operations', nodes: 3, hours: 730 },
      // Current public spec defaults tier to Basic; Retail API Basic Node meter is per node-hour.
      expected: async () => retailIoTOperations({ currency: 'USD', nodes: 3, hours: 730 }),
    },
    {
      name: 'essentials part-time hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-operations', tier: 'essentials', nodes: 2, hours: 100 },
      // Retail API node meter is hourly, so part-time use is nodes times 100 hours.
      expected: async () => retailIoTOperations({ currency: 'USD', tier: 'essentials', nodes: 2, hours: 100 }),
    },
    {
      name: 'essentials with device registry assets and devices',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-operations', tier: 'essentials', nodes: 3, hours: 730, deviceRegistryAssets: 100, deviceRegistryDevices: 50 },
      // Retail API Device Registry Global meters bill assets and devices per hour in addition to IoT Operations node-hours.
      expected: async () => retailIoTOperations({ currency: 'USD', tier: 'essentials', nodes: 3, hours: 730, deviceRegistryAssets: 100, deviceRegistryDevices: 50 }),
    },
    {
      name: 'basic with large registry',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'iot-operations', tier: 'basic', nodes: 5, hours: 730, deviceRegistryAssets: 1000, deviceRegistryDevices: 500 },
      // Retail API Basic node-hours plus Global Device Registry asset-hours and device-hours.
      expected: async () => retailIoTOperations({ currency: 'USD', tier: 'basic', nodes: 5, hours: 730, deviceRegistryAssets: 1000, deviceRegistryDevices: 500 }),
    },
    {
      name: 'west europe uses global meters',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'iot-operations', tier: 'essentials', nodes: 1, hours: 730, deviceRegistryAssets: 10, deviceRegistryDevices: 10 },
      // Retail API exposes IoT Operations and Device Registry meters as Global, so West Europe uses the same Global hourly meters.
      expected: async () => retailIoTOperations({ currency: 'USD', tier: 'essentials', nodes: 1, hours: 730, deviceRegistryAssets: 10, deviceRegistryDevices: 10 }),
    },
    {
      name: 'eur basic with registry',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'iot-operations', tier: 'basic', nodes: 2, hours: 100, deviceRegistryAssets: 20, deviceRegistryDevices: 10 },
      // Retail API EUR Global meters: Basic Node, Device Registry Asset and Device Device are all hourly.
      expected: async () => retailIoTOperations({ currency: 'EUR', tier: 'basic', nodes: 2, hours: 100, deviceRegistryAssets: 20, deviceRegistryDevices: 10 }),
    },
  ],
};
