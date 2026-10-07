'use strict';
// Page blobs: standard (general-purpose v2 capacity + operations + geo transfer) and premium (fixed-size P-tier
// page blobs billed per month by provisioned size, plus premium snapshots). Also covers unmanaged-disk VHDs.
// Meters: serviceName 'Storage', products 'Standard Page Blob v2', 'Premium Page Blob'.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const SIZES = ['P4', 'P6', 'P10', 'P15', 'P20', 'P30', 'P40', 'P50', 'P60', 'P70', 'P80'];
const GEO = ['GRS', 'RA-GRS', 'GZRS', 'RA-GZRS'];

module.exports = {
  type: 'page-blob',
  label: 'Page blobs and unmanaged disks (Azure Storage)',
  family: 'storage',
  calculator: ['storage'],
  keywords: ['page blob', 'unmanaged disk', 'vhd', 'premium page blob', 'legacy vm disk', 'random access blob', 'storage account disk'],
  fields: {
    tier: { req: true, enum: ['standard', 'premium'], ask: 'Standard storage (pay for the GB stored plus operations, default) or Premium SSD page blobs (fixed disk-like sizes P4 to P80, a set price per month)? Map the answer to standard or premium; suggest standard and record it as an assumption.' },
    purpose: { def: 'page-blob', enum: ['page-blob', 'unmanaged-disk'], ask: 'Is it for general page blob storage (page-blob, default) or for virtual machine disks stored as VHD files in a storage account (unmanaged-disk)?' },
    redundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS', 'RA-GRS', 'GZRS', 'RA-GZRS'], ask: 'Copies of the data: LRS (default), ZRS (across zones), GRS (plus a second region), RA-GRS, GZRS or RA-GZRS. Premium only offers LRS or ZRS.' },
    dataGB: { def: 0, ask: 'Standard only: about how many GB of page blob data will be stored?' },
    writeOps: { def: 0, int: true, ask: 'Standard only: roughly how many write operations a month? Use 0 if unknown.' },
    additionalWriteIO: { def: 0, int: true, ask: 'Standard only: extra write IO units a month. Each write bigger than 64 KB bills one additional IO per extra 64 KB, up to 15 per request (a 1 MB write is 15). Use 0 if writes are small or unknown.' },
    readOps: { def: 0, int: true, ask: 'Standard only: roughly how many read operations a month? Use 0 if unknown.' },
    additionalReadIO: { def: 0, int: true, ask: 'Standard only: extra read IO units a month. Each read bigger than 64 KB bills one additional IO per extra 64 KB, up to 15 per request. Use 0 if reads are small or unknown.' },
    geoReplicationGB: { def: 0, ask: 'Geo-redundant standard only: GB written a month that are copied to the second region. Use 0 if unknown.' },
    diskSize: { def: 'P30', enum: SIZES, ask: 'Premium only: which size? P10 = 128 GiB, P20 = 512 GiB, P30 = 1 TiB, P40 = 2 TiB, P50 = 4 TiB. Round up to the next size (a blob under 128 GiB is billed as P10 unless a smaller tier is set on it); suggest P30 and record it as an assumption.' },
    diskCount: { def: 1, int: true, ask: 'Premium only: how many page blobs or disks of that size?' },
    snapshotGB: { def: 0, ask: 'Premium only: GB of snapshots kept. Use 0 if none.' }
  },
  examples: [
    { type: 'page-blob', tier: 'standard', dataGB: 500, writeOps: 20000000, readOps: 50000000, additionalWriteIO: 100000000 },
    { type: 'page-blob', tier: 'standard', purpose: 'unmanaged-disk', dataGB: 1000, writeOps: 30000000, readOps: 60000000 },
    { type: 'page-blob', tier: 'standard', redundancy: 'RA-GRS', dataGB: 2000, writeOps: 10000000, geoReplicationGB: 300 },
    { type: 'page-blob', tier: 'premium', diskSize: 'P40', diskCount: 4, snapshotGB: 500, purpose: 'unmanaged-disk' }
  ],
  readback: c => c.tier === 'premium'
    ? `Premium page blobs (${c.redundancy || 'LRS'}): ${fmtN(n(c.diskCount ?? 1))} x ${c.diskSize || 'P30'}` + (n(c.snapshotGB) ? `, ${fmtN(n(c.snapshotGB))} GB snapshots` : '') + (c.purpose === 'unmanaged-disk' ? ' (unmanaged disks)' : '')
    : `Standard page blobs (${c.redundancy || 'LRS'}): ${fmtN(n(c.dataGB))} GB stored, ${fmtN(n(c.writeOps))} write and ${fmtN(n(c.readOps))} read operations a month` + (n(c.geoReplicationGB) ? `, ${fmtN(n(c.geoReplicationGB))} GB geo-replicated` : '') + (c.purpose === 'unmanaged-disk' ? ' (unmanaged disks)' : ''),
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Delete operations, data transfer out, and the virtual machines. Additional IO is only priced if you give additionalWriteIO or additionalReadIO.'
  ]),
  price: async (c, ctx) => {
    const red = c.redundancy || 'LRS', G = 'Storage', lines = [], notes = [];
    if (c.tier === 'premium') {
      if (!['LRS', 'ZRS'].includes(red)) throw new PricingError('Premium page blobs are only available as LRS or ZRS.');
      const size = c.diskSize || 'P30';
      if (red === 'ZRS' && ['P70', 'P80'].includes(size)) throw new PricingError(`Premium page blob ${size} is not offered as ZRS; use LRS or a smaller size.`);
      const cnt = n(c.diskCount ?? 1), snap = n(c.snapshotGB);
      const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Premium Page Blob' and (skuName eq '${size} ${red}' or skuName eq 'Snapshots ${red}')`, ctx);
      const d = single(rs.filter(r => r.skuName === `${size} ${red}`), `Premium page blob ${size} ${red}`);
      if (!d.length) throw new PricingError(`Premium page blob ${size} ${red} is not priced in ${ctx.region}.`);
      lines.push(meterLine(G, 'Premium Page Blob', `Premium page blob ${size} (${red}): ${fmtN(cnt)} per month`, d, cnt, ctx, { unit: 'disks' }));
      if (snap) {
        const s = single(rs.filter(r => r.skuName === `Snapshots ${red}`), `Premium page blob snapshots ${red}`);
        if (!s.length) throw new PricingError(`Premium page blob snapshots (${red}) are not priced in ${ctx.region}.`);
        lines.push(meterLine(G, 'Premium Page Blob', `Premium page blob snapshots (${red}): ${fmtN(snap)} GB`, s, snap, ctx, { unit: 'GB-month' }));
      }
      notes.push('Premium page blobs are billed per month by the size tier provisioned, whatever part is used, and have no per-operation charge.');
      return { lines, notes, facts: { tier: 'premium', purpose: c.purpose || 'page-blob', diskSize: size, redundancy: red, count: cnt } };
    }
    const disk = c.purpose === 'unmanaged-disk', aw = n(c.additionalWriteIO), ar = n(c.additionalReadIO);
    const gb = n(c.dataGB), w = n(c.writeOps), r = n(c.readOps), geo = n(c.geoReplicationGB);
    if (geo && !GEO.includes(red)) throw new PricingError('geoReplicationGB only applies to GRS, RA-GRS, GZRS or RA-GZRS.');
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Standard Page Blob v2' and skuName eq 'Standard ${red}'`, ctx);
    if (!rs.length) throw new PricingError(`Standard page blobs (${red}) are not priced in ${ctx.region}.`);
    const m2 = (a, b, what) => rs.some(q => a.test(q.meterName)) ? m(a, what) : m(b, what);
    const m = (re, what) => { const x = single(rs.filter(q => re.test(q.meterName)), `Page blob ${red} ${what}`); if (!x.length) throw new PricingError(`Page blob ${red} ${what} is not priced in ${ctx.region}.`); return x; };
    const S = 'Page Blob Storage';
    if (gb) lines.push(meterLine(G, S, `Page blob capacity (${red}): ${fmtN(gb)} GB`, m(/^(?!Disk).*Data Stored$/, 'capacity'), gb, ctx, { unit: 'GB-month' }));
    if (w) lines.push(meterLine(G, S, `Page blob write operations (${red}): ${fmtN(w)}`, (disk ? m2(/^(\w+ )?Disk Write Operations$/, /^(\w+ )?Disk (Read|Delete) Operations$/, 'write operations') : m( /^(?!Disk|GRS Disk)(\w+ )?Write Operations$/, 'write operations')), w, ctx, { unit: 'ops' }));
    if (r) lines.push(meterLine(G, S, `Page blob read operations (${red}): ${fmtN(r)}`, (disk ? m2(/^(\w+ )?Disk Read Operations$/, /^(\w+ )?Disk Delete Operations$/, 'read operations') : m( /^(?!Disk)(\w+ )?Read Operations$/, 'read operations')), r, ctx, { unit: 'ops' }));
    if (aw && disk && /ZRS/.test(red)) throw new PricingError('Additional write IO has no unmanaged-disk meter for ZRS, GZRS or RA-GZRS; use LRS, GRS or RA-GRS.');
    if (aw) lines.push(meterLine(G, S, `Page blob additional write IO (${red}): ${fmtN(aw)}`, m(disk ? /^(\w+ )?Disk Write Additional IO$/ : /^(?!Disk)(\w+ )?Write Additional IO$/, 'additional write IO'), aw, ctx, { unit: 'ops' }));
    if (ar) lines.push(meterLine(G, S, `Page blob additional read IO (${red}): ${fmtN(ar)}`, m(disk ? /^Disk Read Additional IO$/ : /^(?!Disk)(\w+ )?Read Additional IO$/, 'additional read IO'), ar, ctx, { unit: 'ops' }));
    if (geo) {
      const g = single(await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Storage - Bandwidth' and skuName eq 'Geo-Replication v2'`, ctx), 'Geo-replication data transfer');
      if (!g.length) throw new PricingError(`Geo-replication data transfer is not priced in ${ctx.region}.`);
      lines.push(meterLine(G, 'Storage - Bandwidth', `Geo-replication data transfer: ${fmtN(geo)} GB`, g, geo, ctx, { unit: 'GB' }));
    }
    if (!lines.length) throw new PricingError('Nothing to price: set dataGB, writeOps, readOps or additional IO.');
    if (disk && (aw || ar)) notes.push('Unmanaged-disk additional IO uses Retail-only meters; the Azure Pricing Calculator has no separate unmanaged additional-IO dimension.');
    if (disk && w) notes.push('Unmanaged-disk transactions are $0.0015 per 10,000 on any redundancy.');
    notes.push('Standard page blobs are billed on GB stored plus operations per 10,000; additional IO is priced only when additionalWriteIO or additionalReadIO is set.');
    return { lines, notes, facts: { tier: 'standard', purpose: c.purpose || 'page-blob', redundancy: red, dataGB: gb } };
  }
};
