'use strict';
// Azure Stack Edge (calculator slug azure-stack-edge): hardware-as-a-service edge devices billed per day (hourly for Pro 2),
// plus one-off shipping, return, destruction and loss fees. Retail meters are Global ('US Gov' for Azure Government),
// except the original base device, which also has a few regional meters.
const { rows, single, meterLine, PricingError, fmtN, DAYS } = require('../kit');

const n = v => Number(v || 0);
const DEVICES = {
  'pro-fpga':   { name: 'Azure Stack Edge (FPGA)',            product: 'Azure Stack Edge',        service: 'Standard Monthly Service Fee', per: 'day', shipMeter: 'Device Standard Shipping', loss: true },
  'pro-1gpu':   { name: 'Azure Stack Edge Pro 1 GPU',          product: 'Azure Stack Edge Pro',    service: 'Standard Monthly Service Fee - 1 GPU', per: 'day', family: 'pro' },
  'pro-2gpu':   { name: 'Azure Stack Edge Pro 2 GPU',          product: 'Azure Stack Edge Pro',    service: 'Standard Monthly Service Fee - 2 GPU', per: 'day', family: 'pro' },
  'pro-r':      { name: 'Azure Stack Edge Pro R',              product: 'Azure Stack Edge Pro R',  service: 'Standard Monthly Service Fee - 1 Node', per: 'day', family: 'pror', suffix: ' - 1 Node' },
  'pro-r-ups':  { name: 'Azure Stack Edge Pro R with UPS',     product: 'Azure Stack Edge Pro R',  service: 'Standard Monthly Service Fee - 1 Node + UPS', per: 'day', family: 'pror', suffix: ' - 1 Node + UPS' },
  'pro2-64g':   { name: 'Azure Stack Edge Pro 2 (64G2T)',      product: 'Azure Stack Edge Pro 2',  rank: 0, per: 'hour', family: 'pro2' },
  'pro2-128g':  { name: 'Azure Stack Edge Pro 2 (128G4T1GPU)', product: 'Azure Stack Edge Pro 2',  rank: 1, per: 'hour', family: 'pro2' },
  'pro2-256g':  { name: 'Azure Stack Edge Pro 2 (256G6T2GPU)', product: 'Azure Stack Edge Pro 2',  rank: 2, per: 'hour', family: 'pro2' },
  'mini-r':     { name: 'Azure Stack Edge Mini R',             product: 'Azure Stack Edge Mini R', service: 'Standard Monthly Service Fee', per: 'day', family: 'minir' }
};
const SHIP_AREA = { us: 'US', americas: 'Americas', emea: 'EMEA', apac: 'APAC' };

module.exports = {
  type: 'stack-edge',
  label: 'Azure Stack Edge',
  family: 'hybrid',
  calculator: ['azure-stack-edge'],
  keywords: ['stack edge', 'azure stack edge', 'edge appliance', 'edge compute', 'data box edge', 'rugged edge device', 'ase pro', 'edge gpu'],
  fields: {
    device: { req: true, enum: Object.keys(DEVICES), ask: 'Which Azure Stack Edge device? Latest compact 1U model with 64 GB memory -> pro2-64g, with 128 GB and one GPU -> pro2-128g, with 256 GB and two GPUs -> pro2-256g; 2U rack-mount with one GPU -> pro-1gpu or two GPUs -> pro-2gpu; the original model (no GPU) -> pro-fpga; rugged, portable for harsh or military use -> pro-r (or pro-r-ups if it comes with a battery unit); small rugged field device -> mini-r. If unsure what hardware you need, ask what the edge workload is and record the pick as an assumption.' },
    devices: { def: 1, int: true, min: 1, ask: 'How many devices do you need? If unknown, suggest 1.' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours per month will each device be on subscription (730 is a full month, the usual answer)? Billing starts when the device is delivered to you, whether or not you have activated it, and stops when you start the return.' },
    shipArea: { def: 'us', enum: Object.keys(SHIP_AREA), ask: 'Where will the device be shipped to? United States -> us; Canada, Mexico and the rest of the Americas -> americas; Europe, Middle East and Africa -> emea; Asia Pacific -> apac.' },
    shipments: { def: 1, int: true, min: 0, ask: 'How many one-way shipping charges per device? A single outbound shipment is 1. Use 0 to leave shipping out.' },
    returnWithoutDrives: { def: 0, int: true, min: 0, ask: 'Only if you plan to return devices without the drives (for example to keep the data): how many? Normally 0. Not offered for the Pro 2.' },
    dataDestruction: { def: 0, int: true, min: 0, ask: 'Only if you want Microsoft to destroy the data on the devices when they come back: how many? Normally 0. Not offered for the Pro 2.' },
    secureDestruction: { def: 0, int: true, min: 0, ask: 'Only if you need the whole device physically destroyed (secure device destruction): how many? Normally 0. Not offered for the Pro 2.' },
    lostDevices: { def: 0, int: true, min: 0, ask: 'Only if you expect to lose or irreparably damage devices: how many? Normally 0.' }
  },
  context: ['production'],
  examples: [
    { type: 'stack-edge', device: 'pro-1gpu', devices: 1 },
    { type: 'stack-edge', device: 'pro2-128g', devices: 2, shipArea: 'emea' },
    { type: 'stack-edge', device: 'pro-r-ups', devices: 1, hours: 365, shipArea: 'apac', secureDestruction: 1 },
    { type: 'stack-edge', device: 'mini-r', devices: 3, shipArea: 'americas', returnWithoutDrives: 1, lostDevices: 1 }
  ],
  readback: c => {
    const d = DEVICES[c.device];
    const extras = [['returnWithoutDrives', 'returned without drives'], ['dataDestruction', 'with data destruction'], ['secureDestruction', 'with secure destruction'], ['lostDevices', 'lost or damaged']]
      .filter(([k]) => n(c[k])).map(([k, t]) => `${fmtN(c[k])} ${t}`);
    return `${d ? d.name : c.device}: ${fmtN(n(c.devices) || 1)} device(s) x ${fmtN(c.hours == null ? 730 : n(c.hours))} hours a month, ${fmtN(c.shipments == null ? 1 : n(c.shipments))} shipment(s) per device to ${SHIP_AREA[c.shipArea || 'us'] || c.shipArea}${extras.length ? ', ' + extras.join(', ') : ''}`;
  },
  notIncluded: () => ['Customs, duties and import taxes on cross-border shipping (the pricing page says shipping and customs are charged in addition), and any Azure storage, Kubernetes or Azure Arc services used with the device'],
  price: async (c, ctx) => {
    const dev = DEVICES[c.device];
    if (!dev) throw new PricingError(`device must be one of ${Object.keys(DEVICES).join(', ')}.`);
    const count = c.devices == null ? 1 : n(c.devices);
    if (!Number.isInteger(count) || count < 1) throw new PricingError('devices must be a whole number of at least 1.');
    const hours = c.hours == null ? 730 : n(c.hours);
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744.');
    const area = c.shipArea || 'us';
    if (!SHIP_AREA[area]) throw new PricingError(`shipArea must be one of ${Object.keys(SHIP_AREA).join(', ')}.`);
    const ints = {};
    for (const k of ['shipments', 'returnWithoutDrives', 'dataDestruction', 'secureDestruction', 'lostDevices']) {
      const v = c[k] == null ? (k === 'shipments' ? 1 : 0) : n(c[k]);
      if (!Number.isInteger(v) || v < 0) throw new PricingError(`${k} must be a whole number, 0 or more.`);
      ints[k] = v;
    }
    const gov = /^usgov|^usdod/.test(ctx.region);
    const all = await rows(`serviceName eq 'Azure Stack Edge' and priceType eq 'Consumption' and (armRegionName eq '${gov ? 'US Gov' : 'Global'}' or armRegionName eq '${ctx.region}')`, ctx);
    const p = all.filter(r => r.productName === dev.product);
    const pick = (name, what, rowsIn = p) => {
      let m = rowsIn.filter(r => r.meterName === name);
      if (!m.length) throw new PricingError(`${what} is not priced for ${dev.name} in ${ctx.region}.`);
      const regional = m.filter(r => r.armRegionName === ctx.region);
      if (regional.length) m = regional;
      return single(m, what);
    };
    const ranked = (name, what) => {
      const m = p.filter(r => r.meterName === name).sort((a, b) => a.retailPrice - b.retailPrice);
      if (m.length !== 3 || new Set(m.map(r => r.retailPrice)).size !== 3) throw new PricingError(`${what} is not priced for ${dev.name} in ${ctx.region}.`);
      return [m[dev.rank]];
    };
    const G = 'Hybrid', S = 'Azure Stack Edge';
    const lines = [];
    if (dev.per === 'hour') {
      lines.push(meterLine(G, S, `${dev.name} service fee: ${fmtN(count)} device(s) x ${fmtN(hours)} hours`, ranked('Standard Service Fee', 'Pro 2 service fee'), count * hours, ctx, { unit: 'hours' }));
    } else {
      // Daily meter: the calculator and pricing page count a full month (730 hours) as 30 days.
      lines.push(meterLine(G, S, `${dev.name} service fee: ${fmtN(count)} device(s) x ${fmtN(hours)} hours (${fmtN(Math.round(hours / 730 * 30 * 100) / 100)} days)`, pick(dev.service, 'service fee'), count * hours / 730 * 30, ctx, { unit: 'days' }));
    }
    const shipName = { 'pro-fpga': 'Device Standard Shipping', 'pro-1gpu': `Standard Shipping Fee - ${SHIP_AREA[area]}`, 'pro-2gpu': `Standard Shipping Fee - ${SHIP_AREA[area]}`,
      'pro-r': `Standard Shipping - ${SHIP_AREA[area] === 'Americas' ? 'Americas (non-US)' : SHIP_AREA[area]} - 1 Node`, 'pro-r-ups': `Standard Shipping - ${SHIP_AREA[area] === 'Americas' ? 'Americas (non-US)' : SHIP_AREA[area]} - 1 Node`,
      'pro2-64g': 'Standard Shipping Fee', 'pro2-128g': 'Standard Shipping Fee', 'pro2-256g': 'Standard Shipping Fee',
      'mini-r': `Standard Shipping - ${SHIP_AREA[area] === 'Americas' ? 'Americas (non-US)' : SHIP_AREA[area]}` }[c.device];
    if (ints.shipments) lines.push(meterLine(G, S, `${dev.name} shipping to ${SHIP_AREA[area]}: ${fmtN(count)} device(s) x ${fmtN(ints.shipments)}`, pick(shipName, 'shipping fee'), count * ints.shipments, ctx, { unit: 'shipments' }));
    const sfx = dev.suffix || '';
    const oneOff = (k, label, base) => {
      if (!ints[k]) return;
      if (dev.family === 'pro2') throw new PricingError(`${label} is not offered for ${dev.name}.`);
      // The original FPGA device uses the Azure Stack Edge Pro return and destruction fees (pricing page Pro tab).
      const src = dev.family === undefined ? all.filter(r => r.productName === 'Azure Stack Edge Pro') : p;
      lines.push(meterLine(G, S, `${dev.name} ${label}: ${fmtN(ints[k])}`, pick(base + sfx, label, src), ints[k], ctx, { unit: 'devices' }));
    };
    oneOff('returnWithoutDrives', 'return without drives fee', 'Standard Return without Drives Fee');
    oneOff('dataDestruction', 'data destruction fee', 'Standard Data Destruction Fee');
    oneOff('secureDestruction', 'secure device destruction fee', 'Standard Secure Device Destruction Fee');
    if (ints.lostDevices) {
      const m = dev.family === 'pro2' ? ranked('Standard Loss Fee', 'Pro 2 loss fee') : pick('Standard Loss Fee' + sfx, 'loss fee');
      lines.push(meterLine(G, S, `${dev.name} lost or damaged fee: ${fmtN(ints.lostDevices)}`, m, ints.lostDevices, ctx, { unit: 'devices' }));
    }
    return { lines, notes: ['Azure Stack Edge is a hardware-as-a-service subscription: the service fee covers the device, support and software, and is billed from delivery (whether or not it is activated) until you start the return, and daily-billed devices count a month as 30 days. Shipping, destruction and loss are one-off fees. Models are sold only in certain countries; check the Azure Stack Edge availability list for the model and country.'], facts: { device: c.device, devices: count, hours } };
  }
};

