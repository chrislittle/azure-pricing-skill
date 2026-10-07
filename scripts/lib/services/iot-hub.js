'use strict';
// Azure IoT Hub (Free, Basic B1-B3, Standard S1-S3 units), Device Provisioning Service (S1 operations)
// and Device Update for IoT Hub (Free / Standard device units and instances).
// Meters: serviceName 'IoT Hub', regional (prices differ by region, e.g. Brazil South is double US).
// Hub units are per unit per month; each unit allows a fixed number of messages a day, counted in
// 4 KB blocks (0.5 KB on the Free tier).
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

// Messages per day per unit, and the most units a hub can have (IoT Hub scaling and quotas docs).
const SIZES = { 1: { perUnit: 400000, maxUnits: 200 }, 2: { perUnit: 6000000, maxUnits: 200 }, 3: { perUnit: 300000000, maxUnits: 10 } };
const FREE = { perDay: 8000, devices: 500, chunkKb: 0.5 };
const TIER_LETTER = { basic: 'B', standard: 'S' };

module.exports = {
  type: 'iot-hub',
  label: 'Azure IoT Hub',
  family: 'iot',
  calculator: ['iot-hub'],
  keywords: ['iot', 'internet of things', 'devices', 'sensors', 'telemetry', 'device messages', 'device provisioning', 'device update'],
  fields: {
    messagesPerDay: { req: true, int: true, min: 0, ask: 'Roughly how many messages a day will your devices and apps exchange with IoT Hub in total (for example 1,000 devices sending one reading a minute is 1,440,000 a day)? Include commands sent down to devices, twin reads and updates, and method calls (a call and its reply are two messages) if you use them. If unknown, suggest 100,000 and record it as an assumption.' },
    messageSizeKb: { def: 4, ask: 'About how big is a typical message in kilobytes? Billing counts in 4 KB blocks, so anything up to 4 KB counts as one message and a 6 KB message counts as two. If unknown, use 4.' },
    tier: { def: 'standard', enum: ['free', 'basic', 'standard'], ask: 'Do you only need devices to send data up to the cloud (basic), or also need to send commands or settings down to devices, use device twins or IoT Edge (standard)? Just trying it out for free (limited to 8,000 messages a day counted in 0.5 KB blocks, so a 4 KB message counts as 8; one free hub per subscription) -> free. If unknown, use standard.' },
    needsTwoWay: { def: false, ask: 'Only ask if the tier answer did not already settle it (standard means yes, free means yes): will you send commands or settings from the cloud to devices, use device twins, device management or IoT Edge? (Basic tier cannot do these.)' },
    size: { def: 'auto', enum: ['auto', '1', '2', '3'], ask: 'Leave on auto and the cheapest size that fits the message volume is picked. Only set 1, 2 or 3 if the person names a size (1 = 400,000 messages a day per unit, 2 = 6 million, 3 = 300 million).' },
    units: { def: 0, int: true, min: 0, ask: 'Only if the person already knows how many units they want: the number of units. Otherwise leave 0 and the number of units needed for the daily message volume is worked out.' },
    provisioningOperations: { def: 0, int: true, min: 0, ask: 'Will devices register themselves automatically with the Device Provisioning Service? If so, roughly how many provisioning operations a month (each device registration is an operation, retries add more)? If none, 0.' },
    deviceUpdate: { def: 'none', enum: ['none', 'free', 'standard'], ask: 'Do they need to push firmware or software updates to devices over the air with Device Update for IoT Hub? No -> none; just trying it (one instance, up to 10 devices) -> free; production -> standard.' },
    deviceUpdateDevices: { def: 0, int: true, min: 0, ask: 'Device Update only: how many devices will receive updates?' },
    deviceUpdateInstances: { def: 1, int: true, min: 1, ask: 'Device Update standard only: how many Device Update instances? Each instance maps to one IoT hub, so for this hub use 1 unless the person says otherwise.' }
  },
  context: ['production'],
  examples: [
    { type: 'iot-hub', messagesPerDay: 200000 },
    { type: 'iot-hub', tier: 'standard', needsTwoWay: true, messagesPerDay: 3000000, messageSizeKb: 6, size: '1', provisioningOperations: 50000, deviceUpdate: 'standard', deviceUpdateDevices: 5000, deviceUpdateInstances: 2 }
  ],
  readback: c => {
    const tier = c.tier || 'standard';
    const parts = [`${fmtN(n(c.messagesPerDay))} messages a day of about ${fmtN(n(c.messageSizeKb) || 4)} KB each`];
    if (tier === 'free') parts.push('1 free unit (8,000 messages a day, counted in 0.5 KB blocks)');
    else if (n(c.units)) parts.push(` unit(s)`);
    else parts.push('units worked out from the daily volume');
    if (c.size && c.size !== 'auto') parts.push(`size ${c.size}`);
    if (c.needsTwoWay) parts.push('needs cloud-to-device commands, twins or IoT Edge');
    if (n(c.provisioningOperations)) parts.push(`${fmtN(c.provisioningOperations)} Device Provisioning Service operations a month`);
    if (c.deviceUpdate && c.deviceUpdate !== 'none') parts.push(`Device Update ${c.deviceUpdate}: ${fmtN(n(c.deviceUpdateDevices))} devices, ${fmtN(n(c.deviceUpdateInstances) || 1)} instance(s)`);
    return `IoT Hub ${tier} tier: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('iot-routing-targets') ? [] : ['The services IoT Hub routes data to (Event Hubs, Storage, Stream Analytics, and so on) are priced separately.'],
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!['free', 'basic', 'standard'].includes(tier)) throw new PricingError(`IoT Hub tier "${c.tier}" is not valid; use free, basic or standard.`);
    for (const k of ['messagesPerDay', 'messageSizeKb', 'units', 'provisioningOperations', 'deviceUpdateDevices', 'deviceUpdateInstances']) if (n(c[k]) < 0 || Number.isNaN(Number(c[k] ?? 0))) throw new PricingError(`IoT Hub "${k}" must be a number of 0 or more.`);
    for (const k of ['units', 'deviceUpdateDevices', 'deviceUpdateInstances', 'provisioningOperations', 'messagesPerDay']) if (!Number.isInteger(n(c[k]))) throw new PricingError(`IoT Hub "${k}" must be a whole number.`);
    const msgs = n(c.messagesPerDay);
    const sizeKb = n(c.messageSizeKb) || 4;
    const chunk = tier === 'free' ? FREE.chunkKb : 4;
    const billable = msgs * Math.max(1, Math.ceil(sizeKb / chunk));
    const dpsOps = n(c.provisioningOperations);
    const du = c.deviceUpdate || 'none';
    if (!['none', 'free', 'standard'].includes(du)) throw new PricingError(`Device Update "${du}" is not valid; use none, free or standard.`);
    const duDevices = n(c.deviceUpdateDevices), duInstances = du === 'none' ? 0 : (n(c.deviceUpdateInstances) || 1);
    if (du === 'free' && (duDevices > 10 || duInstances > 1)) throw new PricingError('Device Update free tier is limited to 1 instance and 10 devices; use "standard" for more.');
    if (du !== 'none' && !duDevices) throw new PricingError('Device Update needs the number of devices (deviceUpdateDevices).');

    const rs = await rows(`serviceName eq 'IoT Hub' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`IoT Hub is not priced in ${ctx.region}.`);
    const unitRows = (letter, size) => rs.filter(r => r.productName === 'IoT Hub' && r.meterName === `${letter}${size} Unit`);

    let edition, units, perUnit;
    if (tier === 'free') {
      edition = 'Free'; units = 1; perUnit = FREE.perDay;
      if (n(c.units) > 1) throw new PricingError('The Free tier allows one unit (and one free hub per subscription).');
      if (c.size && c.size !== 'auto') throw new PricingError('The Free tier has no sizes; leave size on auto.');
    } else {
      const letter = TIER_LETTER[tier];
      const need = s => Math.max(1, Math.ceil(billable / SIZES[s].perUnit));
      let size;
      if (c.size && c.size !== 'auto') {
        size = Number(c.size);
        if (!SIZES[size]) throw new PricingError(`IoT Hub size "${c.size}" is not valid; use 1, 2 or 3.`);
      } else {
        const fits = [1, 2, 3].filter(s => need(s) <= SIZES[s].maxUnits).map(s => {
          const u = n(c.units) || need(s);
          const p = unitRows(letter, s).find(r => r.retailPrice > 0);
          return { s, u, cost: p ? p.retailPrice * u : Infinity, enough: u * SIZES[s].perUnit >= billable };
        });
        if (!fits.length) throw new PricingError(`${fmtN(billable)} billable messages a day is more than one IoT Hub can take (up to ${SIZES[3].maxUnits} units of size 3 = ${fmtN(SIZES[3].maxUnits * SIZES[3].perUnit)}). Split the load across several hubs.`);
        const ok = fits.filter(o => o.enough);
        size = (ok.length ? ok.sort((a, b) => a.cost - b.cost) : fits.sort((a, b) => b.s - a.s))[0].s;
      }
      units = n(c.units) || need(size);
      perUnit = SIZES[size].perUnit;
      if (units > SIZES[size].maxUnits) throw new PricingError(`IoT Hub size ${size} allows at most ${SIZES[size].maxUnits} units; ${units} requested. Try a larger size.`);
      edition = `${letter}${size}`;
    }

    const G = 'IoT', S = 'IoT Hub', lines = [];
    const hubRows = single(rs.filter(r => r.productName === 'IoT Hub' && r.meterName === `${edition} Unit`), `IoT Hub ${edition} unit`);
    const tierName = tier === 'free' ? 'Free' : `${tier === 'basic' ? 'Basic' : 'Standard'} ${edition}`;
    lines.push(meterLine(G, S, `IoT Hub ${tierName}: ${fmtN(units)} unit(s) (each allows ${fmtN(perUnit)} messages a day), running all month`, hubRows, units, ctx, { unit: 'units / month' }));

    if (dpsOps) {
      const dpsRows = rs.filter(r => r.productName === 'IoT Hub Device Provisioning' && r.meterName === 'S1 Operations');
      if (!dpsRows.length) throw new PricingError(`Device Provisioning Service is not offered in ${ctx.region}; pick another region or remove it.`);
      const dps = single(dpsRows, 'Device Provisioning Service operations');
      lines.push(meterLine(G, S, `Device Provisioning Service: ${fmtN(dpsOps)} operations/month`, dps, dpsOps, ctx));
    }
    if (du !== 'none') {
      const sku = du === 'free' ? 'Free' : 'Standard';
      if (!rs.some(r => r.productName === 'Device Update for IoT Hub')) throw new PricingError(`Device Update for IoT Hub is not offered in ${ctx.region}; pick another region or remove it.`);
      const dev = single(rs.filter(r => r.productName === 'Device Update for IoT Hub' && r.meterName === `${sku} 1 Device Unit`), `Device Update ${sku} device units`);
      const inst = single(rs.filter(r => r.productName === 'Device Update for IoT Hub' && r.meterName === `${sku} 1 DU instance`), `Device Update ${sku} instances`);
      lines.push(meterLine(G, S, `Device Update ${sku}: ${fmtN(duDevices)} devices`, dev, duDevices, ctx, { unit: 'devices / month' }));
      lines.push(meterLine(G, S, `Device Update ${sku}: ${fmtN(duInstances)} instance(s)`, inst, duInstances, ctx, { unit: 'instances / month' }));
    }

    const notes = [`Billed per unit per month, not per hour. IoT Hub counts messages in ${tier === 'free' ? '0.5' : '4'} KB blocks, so ${fmtN(msgs)} messages of ${fmtN(sizeKb)} KB are ${fmtN(billable)} billable messages a day against ${fmtN(units * perUnit)} allowed.`];
    if (tier === 'free') notes.push('Free tier messages are counted in 0.5 KB blocks. Only one Free hub is allowed per Azure subscription, and it cannot be upgraded to Basic or Standard.');
    else notes.push('A hub is one edition only; you cannot mix units of different editions in the same hub.');
    notes.push('Device identity registry operations and creating or listing jobs and configurations are not charged, but the twin updates, method calls and configuration pushes they send to devices count as messages.');
    if (dpsOps) notes.push('Device Provisioning Service is billed per 1,000 operations.');
    if (du === 'standard') notes.push('Device Update Standard is billed per device per month plus a monthly charge per instance; an instance maps 1:1 with an IoT hub.');
    if (du !== 'none' && duInstances > 1) notes.push('A Device Update instance maps 1:1 with an IoT hub; more than one instance for a single hub is unusual, so check this.');
    if (tier !== 'free' && (!c.size || c.size === 'auto')) { const gone = [1, 2, 3].filter(s => !unitRows(TIER_LETTER[tier], s).length); if (gone.length) notes.push(`Size ${gone.join(' and ')} is not offered in ${ctx.region}, so it was not considered.`); }
    if (du === 'free') notes.push('Device Update Free covers one instance and up to 10 devices and cannot be upgraded to Standard.');
    return {
      lines, notes,
      facts: { tier, messageSizeKb: sizeKb, edition, units, capacityPerDay: units * perUnit, billableMessagesPerDay: billable, undersized: billable > units * perUnit, needsTwoWay: !!c.needsTwoWay, provisioningOperations: dpsOps, deviceUpdate: du }
    };
  }
};
