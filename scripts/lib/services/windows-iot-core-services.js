'use strict';
// Windows 10 IoT Core Services: one regionless per-device monthly meter (Global).
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'windows-iot-core-services',
  label: 'Windows 10 IoT Core Services',
  family: 'iot',
  calculator: ['windows-10-iot-core'],
  keywords: ['windows iot', 'iot core', 'device updates', 'windows device', 'embedded windows', 'iot devices windows'],
  fields: {
    devices: { req: true, int: true, min: 1, ask: 'How many Windows 10 IoT Core devices need the service (update control, device health and long-term servicing)? If unknown, suggest 100 and record it as an assumption.' }
  },
  examples: [
    { type: 'windows-iot-core-services', devices: 100 },
    { type: 'windows-iot-core-services', devices: 25000 }
  ],
  readback: c => `Windows 10 IoT Core Services: ${fmtN(n(c.devices))} devices, billed per device per month`,
  price: async (c, ctx) => {
    if (c.devices == null || c.devices === '') throw new PricingError('Windows 10 IoT Core Services needs the number of devices.');
    if (!Number.isInteger(n(c.devices)) || n(c.devices) < 1) throw new PricingError('Number of devices must be a whole number of at least 1.');
    const rs = await rows(`serviceName eq 'Windows 10 IoT Core Services' and priceType eq 'Consumption'`, ctx);
    const meter = single(rs.filter(r => r.meterName === 'Standard Device'), 'Windows 10 IoT Core Services device');
    return {
      lines: [meterLine('IoT', 'Windows 10 IoT Core Services', `Windows 10 IoT Core Services, ${fmtN(n(c.devices))} devices`, meter, n(c.devices), ctx, { unit: 'devices / month' })],
      notes: ['One price for every region (the meter is global), charged per device per month.', 'Devices added or removed mid-month are prorated by day; this estimate assumes every device is enrolled for the whole month.'],
      facts: { devices: n(c.devices) }
    };
  }
};
