'use strict';
// Managed disk snapshots: incremental (billed at Standard HDD rates) and full (billed at the source disk's
// tier), plus instant access snapshots for Ultra Disk and Premium SSD v2 (hourly storage + restore fee).
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const PRODUCT = { 'standard-hdd': 'Standard HDD Managed Disks', 'standard-ssd': 'Standard SSD Managed Disks', 'premium-ssd': 'Premium SSD Managed Disks' };
const IA_PRODUCT = { 'premium-ssd-v2': 'Azure Premium SSD v2', ultra: 'Ultra Disks' };

module.exports = {
  type: 'disk-snapshot',
  label: 'Managed disk snapshots',
  family: 'storage',
  calculator: ['managed-disks'],
  keywords: ['disk snapshot', 'incremental snapshot', 'managed disk backup', 'vm snapshot', 'instant access snapshot', 'restore point', 'disk copy'],
  fields: {
    snapshotGB: { req: true, ask: 'About how many GB will the snapshots hold in total? Incremental snapshots are billed only for the changed data they store, full snapshots for the used size of the disk. If unknown, suggest the used size of the disks and record it as an assumption.' },
    snapshotType: { def: 'incremental', enum: ['incremental', 'full'], ask: 'Incremental (stores only changes since the last snapshot, the recommended default) or full (a complete copy each time)? Default incremental.' },
    sourceDiskType: { def: 'premium-ssd', enum: ['standard-hdd', 'standard-ssd', 'premium-ssd', 'premium-ssd-v2', 'ultra'], ask: 'What type of disk is being snapshotted: standard-hdd, standard-ssd, premium-ssd (Premium SSD), premium-ssd-v2 (Premium SSD v2) or ultra? Default premium-ssd. It decides the price only for full snapshots kept on the same storage as the disk, and which instant access rates apply.' },
    snapshotStorage: { def: 'standard-hdd', enum: ['standard-hdd', 'same-as-disk'], ask: 'Full snapshots only: stored on cheaper Standard HDD (default, the usual choice) or on the same type of storage as the disk (same-as-disk, costs more for SSD disks)? Default standard-hdd.' },
    redundancy: { def: 'LRS', enum: ['LRS', 'ZRS'], ask: 'Locally redundant (LRS) or zone-redundant (ZRS) snapshot storage? Default LRS.' },
    instantAccessGB: { def: 0, ask: 'Only for Ultra or Premium SSD v2 disks: GB of instant access snapshots kept for fast restore (they are billed hourly while they exist). Otherwise 0.' },
    instantAccessHours: { def: 730, ask: 'Hours a month the instant access snapshots are kept (730 = all month).' },
    restoreTB: { def: 0, ask: 'Only for instant access snapshots: TB (TiB for Premium SSD v2) of disk capacity restored from them in the month (each restore has a one-time fee per provisioned TB). Otherwise 0.' }
  },
  examples: [
    { type: 'disk-snapshot', snapshotGB: 2000 },
    { type: 'disk-snapshot', snapshotGB: 1500, snapshotType: 'full', sourceDiskType: 'premium-ssd', snapshotStorage: 'same-as-disk', redundancy: 'ZRS' },
    { type: 'disk-snapshot', snapshotGB: 3000, sourceDiskType: 'ultra', instantAccessGB: 1000, instantAccessHours: 48, restoreTB: 2 }
  ],
  readback: c => {
    const ia = n(c.instantAccessGB);
    const SRC = { 'standard-hdd': 'Standard HDD', 'standard-ssd': 'Standard SSD', 'premium-ssd': 'Premium SSD', 'premium-ssd-v2': 'Premium SSD v2', ultra: 'Ultra Disk' };
    return `${c.snapshotType === 'full' ? 'Full' : 'Incremental'} disk snapshots (${c.redundancy || 'LRS'}) of ${SRC[c.sourceDiskType || 'premium-ssd']} disks${c.snapshotType === 'full' && c.snapshotStorage === 'same-as-disk' ? ' stored on the same type of storage' : ''}: ${fmtN(n(c.snapshotGB))} GB stored` +
      (ia ? `; instant access snapshots ${fmtN(ia)} GB for ${fmtN(n(c.instantAccessHours ?? 730))} hours, ${fmtN(n(c.restoreTB))} TB restored` : '');
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The source disks themselves (priced by the disk component) and Azure Backup vault storage.',
    'Snapshot copies to another region, which add bandwidth charges.'
  ]),
  price: async (c, ctx) => {
    const type = c.snapshotType || 'incremental', src = c.sourceDiskType || 'premium-ssd', red = c.redundancy || 'LRS';
    const sameAsDisk = c.snapshotStorage === 'same-as-disk';
    if (sameAsDisk && type !== 'full') throw new PricingError('snapshotStorage same-as-disk only applies to full snapshots; incremental snapshots are always Standard HDD.');
    const gb = n(c.snapshotGB), iaGB = n(c.instantAccessGB), iaHours = c.instantAccessHours ?? 730, tb = n(c.restoreTB);
    if (iaHours < 0 || iaHours > 744) throw new PricingError('instantAccessHours must be between 0 and 744.');
    if (type === 'full' && !PRODUCT[src]) throw new PricingError('Full snapshots are not available for Premium SSD v2 or Ultra Disks; use incremental.');
    if ((iaGB || tb) && !IA_PRODUCT[src]) throw new PricingError('Instant access snapshots apply only to Ultra Disk and Premium SSD v2 sources.');
    const G = 'Storage', lines = [], notes = [];
    const promo = new Date() < new Date('2027-02-01T00:00:00Z');
    if (gb) {
      const product = type === 'full' && sameAsDisk ? PRODUCT[src] : PRODUCT['standard-hdd'];
      const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq '${product}' and skuName eq 'Snapshots ${red}'`, ctx);
      const m = single(rs.filter(r => /Snapshots$/.test(r.meterName)), `${product} ${red} snapshots`);
      if (!m.length) throw new PricingError(`${red} snapshots of ${product} are not priced in ${ctx.region}.`);
      lines.push(meterLine(G, product, `${type === 'full' ? 'Full' : 'Incremental'} snapshots (${red}): ${fmtN(gb)} GB`, m, gb, ctx, { unit: 'GB-month' }));
      notes.push(type === 'incremental' ? 'Incremental snapshots are stored on Standard HDD rates whatever the source disk type, and are billed for the data they hold.' : (sameAsDisk ? 'Full snapshots are priced on the same storage type as the source disk.' : 'Full snapshots are priced at Standard HDD rates, the default snapshot storage.'));
    }
    if (iaGB || tb) {
      const product = IA_PRODUCT[src];
      const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq '${product}' and skuName eq 'Instant Access Snapshots LRS'`, ctx);
      if (!rs.length) throw new PricingError(`Instant access snapshots for ${product} are not priced in ${ctx.region}.`);
      if (iaGB) lines.push(meterLine(G, product, `Instant access snapshots: ${fmtN(iaGB)} GB x ${fmtN(iaHours)} hours` + (promo ? ' (promotional, not charged)' : ''), single(rs.filter(r => !/Restored/.test(r.meterName)), 'instant access storage'), promo ? 0 : iaGB * iaHours, ctx, { unit: 'GB-hours' }));
      if (tb) lines.push(meterLine(G, product, `Instant access restore: ${fmtN(tb)} TB restored`, single(rs.filter(r => /Restored/.test(r.meterName)), 'instant access restore'), tb, ctx, { unit: 'TB' }));
      if (iaGB) notes.push(promo ? '"As part of a limited-time offering, you are not charged for the additional storage consumed by instant access incremental snapshots through January 2027." The storage line is therefore $0; from February 2027 it is charged at the Retail rate. The restore charge still applies.' : 'The limited-time offer that made instant access snapshot storage free ended in January 2027, so it is charged at the Retail rate.');
      notes.push('Instant access snapshots are billed for the extra storage they use while they exist, plus a one-time fee for each restore based on the provisioned size.');
    }
    if (!lines.length) throw new PricingError('Nothing to price: set snapshotGB or instantAccessGB.');
    return { lines, notes, facts: { fullOnPremiumTier: type === 'full' && sameAsDisk && ['premium-ssd', 'standard-ssd'].includes(src), snapshotType: type, sourceDiskType: src, redundancy: red, snapshotGB: gb, instantAccessGB: iaGB } };
  }
};
