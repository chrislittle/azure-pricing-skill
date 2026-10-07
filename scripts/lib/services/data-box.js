'use strict';
// Azure Data Box (calculator slug databox): offline data transfer devices and the Data Box Gateway virtual device.
// Meters: serviceName 'Data Box', regional, flat fees per order / per device / per day. Data transferred into
// Azure is not charged here; the storage it lands in is billed by the storage service.
// Data Box 120 and 525 (the current devices) carry no service or shipping fee with Microsoft-managed shipping, so
// they are priced by extra days and the lost-or-damaged fee only (as the calculator does).
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const DEVICES = ['data-box-disk', 'data-box-120', 'data-box-525', 'data-box-gateway'];
const NAMES = { 'data-box-disk': 'Data Box Disk', 'data-box-120': 'Data Box 120 TB', 'data-box-525': 'Data Box 525 TB', 'data-box-gateway': 'Data Box Gateway' };
const INCLUDED_DAYS = { 'data-box-120': 10, 'data-box-525': 20 };
const SKU = { 'data-box-120': '120 TB', 'data-box-525': '525 TB' };

module.exports = {
  type: 'data-box',
  label: 'Azure Data Box',
  family: 'storage-other',
  calculator: ['databox'],
  keywords: ['data box', 'offline data transfer', 'ship data to azure', 'bulk data migration', 'data migration', 'import data', 'appliance', 'disk shipping'],
  fields: {
    device: { req: true, enum: DEVICES, ask: 'How much data do you need to move to Azure, and how? Up to about 35 TB (up to five 8 TB solid-state disks you plug in yourself) -> data-box-disk; up to about 120 TB in one rugged device -> data-box-120; up to about 525 TB -> data-box-525; or a virtual appliance that copies data from your network to Azure over the internet -> data-box-gateway.' },
    devices: { def: 1, int: true, min: 1, ask: 'How many devices (data-box-120, data-box-525 or gateway) or how many disk orders (data-box-disk, up to five disks per order) do you need? If unknown, suggest 1 and record it as an assumption.' },
    disksPerOrder: { def: 5, int: true, min: 1, max: 5, ask: 'Data Box Disk only: how many disks in each order (1 to 5)? If unknown, suggest 5.' },
    daysKept: { def: 0, int: true, min: 0, ask: 'Data Box 120 and 525: how many days will you keep each device, not counting the delivery day and the return day? Ten days are included for the 120 TB device and twenty for the 525 TB device. Data Box Disk: how many days will you keep each disk, counting the delivery day (the first three days cost one daily fee in total)? Leave 0 to assume only the included days.' },
    shipping: { def: 'microsoft-managed', enum: ['microsoft-managed', 'self-managed'], ask: 'Data Box Disk only: will Microsoft ship the disks (microsoft-managed) or will you arrange your own shipping to and from an Azure datacenter (self-managed, where offered, which removes the shipping fee)? If unknown, suggest microsoft-managed.' },
    lostOrDamaged: { def: 0, int: true, min: 0, ask: 'Only if you expect to lose or damage devices (or disks): how many? A device that is lost or materially damaged is charged a lost-or-damaged fee. Normally 0.' },
    days: { def: 31, int: true, min: 0, max: 31, ask: 'Data Box Gateway only: on how many days of the month does the virtual appliance run (31 = a full month, which is what the Azure pricing calculator assumes)?' }
  },
  context: ['production'],
  examples: [
    { type: 'data-box', device: 'data-box-disk', devices: 1 },
    { type: 'data-box', device: 'data-box-disk', devices: 2, disksPerOrder: 4, daysKept: 7, shipping: 'microsoft-managed', lostOrDamaged: 1 },
    { type: 'data-box', device: 'data-box-120', devices: 2, daysKept: 14 },
    { type: 'data-box', device: 'data-box-525', devices: 1, daysKept: 25, lostOrDamaged: 1 },
    { type: 'data-box', device: 'data-box-gateway', devices: 2, days: 31 }
  ],
  readback: c => {
    const d = c.device;
    const dev = n(c.devices) || 1;
    if (d === 'data-box-disk') {
      const per = n(c.disksPerOrder) || 5;
      const days = n(c.daysKept);
      return `Data Box Disk: ${fmtN(dev)} order(s) of ${fmtN(per)} disk(s)${days ? `, each disk kept ${fmtN(days)} days counting delivery` : ''}, ${c.shipping === 'self-managed' ? 'self-managed shipping' : 'Microsoft-managed shipping'}${n(c.lostOrDamaged) ? `, ${fmtN(c.lostOrDamaged)} disk(s) lost or damaged` : ''}`;
    }
    if (d === 'data-box-gateway') return `Data Box Gateway virtual appliance: ${fmtN(dev)} appliance(s) running ${fmtN(n(c.days ?? 31))} days a month`;
    const inc = INCLUDED_DAYS[d];
    const kept = n(c.daysKept) || inc;
    return `${NAMES[d] || d}: ${fmtN(dev)} device(s) kept ${fmtN(kept)} days each (${fmtN(inc)} included, not counting delivery and return days)${n(c.lostOrDamaged) ? `, ${fmtN(c.lostOrDamaged)} device(s) lost or damaged` : ''}`;
  },
  notIncluded: () => ['The Azure storage the data lands in and any later transactions or egress (data ingress itself has no Data Box charge), and shipping charges where the carrier bills outside Azure'],
  price: async (c, ctx) => {
    const d = c.device;
    if (!DEVICES.includes(d)) throw new PricingError(`device must be one of ${DEVICES.join(', ')}.`);
    const dev = c.devices == null ? 1 : n(c.devices);
    if (!Number.isInteger(dev) || dev < 1) throw new PricingError('devices must be a whole number of at least 1.');
    const lost = n(c.lostOrDamaged);
    if (!Number.isInteger(lost) || lost < 0) throw new PricingError('lostOrDamaged must be a whole number, 0 or more.');
    const daysKept = n(c.daysKept);
    if (!Number.isInteger(daysKept) || daysKept < 0) throw new PricingError('daysKept must be a whole number, 0 or more.');
    if (d === 'data-box-gateway' && lost) throw new PricingError('lostOrDamaged does not apply to Data Box Gateway (it is a virtual device).');
    const rs = await rows(`serviceName eq 'Data Box' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const prod = name => rs.filter(r => r.productName === name);
    const G = 'Storage', S = 'Data Box';
    const lines = [], notes = [];
    const facts = { device: d, devices: dev, daysKept, lostOrDamaged: lost, extraDays: 0 };
    const need = (p, name, what) => { const m = p.filter(r => r.meterName === name); if (!m.length) throw new PricingError(`${what} is not priced in ${ctx.region}.`); return single(m, what); };

    if (d === 'data-box-gateway') {
      const days = c.days == null ? 31 : n(c.days);
      if (days < 0 || days > 31) throw new PricingError('days must be between 0 and 31.');
      const m = need(prod('Data Box Gateway'), 'Standard Service Fee', 'Data Box Gateway service fee');
      lines.push(meterLine(G, S, `Data Box Gateway virtual appliance: ${fmtN(dev)} appliance(s) x ${fmtN(days)} days`, m, dev * days, ctx, { unit: 'days' }));
      notes.push('Data Box Gateway is billed per day for each appliance. Storage and data transfer are charged as applicable by the storage service.');
      facts.days = days;
    } else if (d === 'data-box-disk') {
      const per = c.disksPerOrder == null ? 5 : n(c.disksPerOrder);
      if (!Number.isInteger(per) || per < 1 || per > 5) throw new PricingError('disksPerOrder must be a whole number from 1 to 5.');
      const ship = c.shipping || 'microsoft-managed';
      if (!['microsoft-managed', 'self-managed'].includes(ship)) throw new PricingError('shipping must be "microsoft-managed" or "self-managed".');
      const p = prod('Data Box Disk');
      if (!p.length) throw new PricingError(`Data Box Disk is not priced in ${ctx.region}.`);
      const disks = dev * per;
      if (daysKept > 45) throw new PricingError('Data Box Disk can be kept for at most 45 days; daysKept must be 45 or less.');
      if (lost > disks) throw new PricingError(`lostOrDamaged (${lost}) cannot exceed the number of disks ordered (${disks}).`);
      lines.push(meterLine(G, S, `Data Box Disk order processing fee: ${fmtN(dev)} order(s)`, need(p, 'Standard Service Fee', 'Data Box Disk order processing fee'), dev, ctx, { unit: 'orders' }));
      // Pricing-page footnote: the first three days (including delivery) are charged as one daily fee unit; each day after that adds another. (The calculator's days input is simply billable days.)
      const units = Math.max(1, (daysKept || 3) - 2);
      lines.push(meterLine(G, S, `Data Box Disk daily usage fee: ${fmtN(disks)} disk(s) x ${fmtN(units)} daily fee unit(s)${daysKept ? ` for ${fmtN(daysKept)} days kept` : ' (the three-day grace period)'}`, need(p, 'Standard Daily Use Fee', 'Data Box Disk daily usage fee'), disks * units, ctx, { unit: 'disk-days' }));
      if (ship === 'microsoft-managed') lines.push(meterLine(G, S, `Data Box Disk shipping: ${fmtN(dev)} order(s)`, need(p, 'Device Standard Shipping', 'Data Box Disk shipping'), dev, ctx, { unit: 'orders' }));
      if (lost) lines.push(meterLine(G, S, `Lost or damaged Data Box Disk fee: ${fmtN(lost)} disk(s)`, need(p, 'Standard Lost or Damaged Disk', 'Data Box Disk lost or damaged fee'), lost, ctx, { unit: 'disks' }));
      notes.push('Data Box Disk: the first three days (including the delivery day) are a grace period charged as a single daily usage fee per disk; each day after that adds another daily fee. The order processing fee is per order.');
      if (ship === 'self-managed') notes.push('Self-managed shipping is available only in some regions; with it the shipping fee is 0.');
      Object.assign(facts, { disksPerOrder: per, disks, shipping: ship });
    } else {
      const sku = SKU[d], inc = INCLUDED_DAYS[d];
      const p = prod('Data Box V2').filter(r => r.skuName === sku);
      if (!p.length) throw new PricingError(`${NAMES[d]} is not priced in ${ctx.region}.`);
      if (lost > dev) throw new PricingError(`lostOrDamaged (${lost}) cannot exceed the number of devices (${dev}).`);
      const extra = daysKept > inc ? daysKept - inc : 0;
      facts.extraDays = extra * dev;
      facts.includedDays = inc;
      if (extra) lines.push(meterLine(G, S, `${NAMES[d]} extra day fee: ${fmtN(dev)} device(s) x ${fmtN(extra)} day(s) beyond the ${fmtN(inc)} included`, need(p, `${sku} Extra Day Fee`, `${NAMES[d]} extra day fee`), dev * extra, ctx, { unit: 'device-days' }));
      if (lost) lines.push(meterLine(G, S, `Lost or damaged ${NAMES[d]} fee: ${fmtN(lost)} device(s)`, need(p, `${sku} Lost or Damaged Device`, `${NAMES[d]} lost or damaged fee`), lost, ctx, { unit: 'devices' }));
      if (!lines.length) {
        // Nothing to charge inside the included period: show the extra-day rate as a zero-quantity line so the rate is visible.
        lines.push(meterLine(G, S, `${NAMES[d]}: ${fmtN(dev)} device(s) kept within the ${fmtN(inc)} included days, no extra day fee`, need(p, `${sku} Extra Day Fee`, `${NAMES[d]} extra day fee`), 0, ctx, { unit: 'device-days' }));
      }
      notes.push(`${NAMES[d]} has no service fee or shipping fee with Microsoft-managed shipping; ${fmtN(inc)} days of use are included, not counting the delivery day and the day the carrier scans the package for return. Each day beyond that bills the extra day fee. The Retail API lists a ${sku} service-fee meter in about 14 regions; the published pricing page says it is waived with Microsoft-managed shipping, so it is not charged here.`);
    }
    notes.push('Data copied into Azure is not charged by Data Box; the storage account that receives it bills for storage and operations.');
    return { lines, notes, facts };
  }
};
