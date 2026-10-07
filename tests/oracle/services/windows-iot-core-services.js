'use strict';

const { query, dedupe, round2 } = require('../api');

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function retailWindowsIoT({ currency, devices }) {
  const rows = dedupe(await query(`serviceName eq 'Windows 10 IoT Core Services' and productName eq 'Windows 10 IoT Core Services' and armRegionName eq 'Global'`, currency));
  const meter = pickOne(rows, r => r.skuName === 'Standard' && r.meterName === 'Standard Device' && r.type === 'Consumption', 'standard device');
  const lines = [
    line(`Windows 10 IoT Core Services devices: ${devices} * ${meter.retailPrice}`, devices * meter.retailPrice, { meterId: meter.meterId }),
  ];
  return { monthlyList: round2(lines.reduce((s, l) => s + l.monthlyList, 0)), lines };
}

module.exports = {
  type: 'windows-iot-core-services',
  source: 'retail-api',
  cases: [
    {
      name: 'single device',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'windows-iot-core-services', devices: 1 },
      // Retail API Global Standard Device meter is charged per device-month.
      expected: async () => retailWindowsIoT({ currency: 'USD', devices: 1 }),
    },
    {
      name: 'one hundred devices',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'windows-iot-core-services', devices: 100 },
      // Retail API Global Standard Device meter: 100 devices times the per-device monthly price.
      expected: async () => retailWindowsIoT({ currency: 'USD', devices: 100 }),
    },
    {
      name: 'large fleet',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'windows-iot-core-services', devices: 1000 },
      // Retail API Global Standard Device meter has no graduated tiers in the current API data.
      expected: async () => retailWindowsIoT({ currency: 'USD', devices: 1000 }),
    },
    {
      name: 'west europe uses global meter',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'windows-iot-core-services', devices: 250 },
      // Retail API exposes this product only as armRegionName Global, so West Europe uses the same global device-month meter.
      expected: async () => retailWindowsIoT({ currency: 'USD', devices: 250 }),
    },
    {
      name: 'two devices linear price',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'windows-iot-core-services', devices: 2 },
      // Retail API Standard Device meter is linear; two devices cost twice the single-device meter price.
      expected: async () => retailWindowsIoT({ currency: 'USD', devices: 2 }),
    },
    {
      name: 'eur device price',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'windows-iot-core-services', devices: 100 },
      // Retail API EUR Global Standard Device meter is charged per device-month.
      expected: async () => retailWindowsIoT({ currency: 'EUR', devices: 100 }),
    },
  ],
};
