'use strict';
// Azure Queue Storage (general-purpose v2): capacity, Class 1 (write/delete) and Class 2 (read) operations per 10K,
// and geo-replication data transfer for geo-redundant accounts. Meters: serviceName 'Storage', product 'Queues v2'.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const GEO = ['GRS', 'RA-GRS', 'GZRS', 'RA-GZRS'];

module.exports = {
  type: 'queue-storage',
  label: 'Azure Queue Storage',
  family: 'storage',
  calculator: ['storage'],
  keywords: ['queue storage', 'azure queues', 'message queue', 'storage queue', 'async messaging', 'work queue', 'decoupling'],
  fields: {
    dataGB: { req: true, ask: 'About how many GB of messages sit in the queues at once (average stored)? Queues usually hold little; if unknown, suggest 10 GB and record it as an assumption.' },
    writeOps: { def: 0, ask: 'Roughly how many queue "write" operations a month - adding, updating, deleting messages and creating or listing queues (each message usually costs one add and one delete)? In millions is fine; give the full number.' },
    readOps: { def: 0, ask: 'Roughly how many queue "read" operations a month - getting or peeking at messages? Use 0 if unknown.' },
    redundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS', 'RA-GRS', 'GZRS', 'RA-GZRS'], ask: 'Copies of the data: LRS (3 copies in one datacenter, default), ZRS (across zones), GRS (plus a second region), RA-GRS (GRS with read access to the second region), GZRS or RA-GZRS (zones plus second region). Default LRS.' },
    geoReplicationGB: { def: 0, ask: 'Geo-redundant only: GB written a month that are copied to the second region. Use 0 if unknown.' }
  },
  examples: [
    { type: 'queue-storage', dataGB: 50, writeOps: 200000000, readOps: 100000000 },
    { type: 'queue-storage', dataGB: 200, writeOps: 50000000, readOps: 80000000, redundancy: 'RA-GRS', geoReplicationGB: 100 },
    { type: 'queue-storage', dataGB: 100, readOps: 30000000, redundancy: 'GZRS' }
  ],
  readback: c => `Queue Storage (${c.redundancy || 'LRS'}): ${fmtN(n(c.dataGB))} GB stored, ${fmtN(n(c.writeOps))} write operations and ${fmtN(n(c.readOps))} read operations a month` + (n(c.geoReplicationGB) ? `, ${fmtN(n(c.geoReplicationGB))} GB geo-replicated` : ''),
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Internet or inter-region data transfer out, and the "additional IO" charges some operations may add.',
    'Legacy general-purpose v1 or blob-only accounts.'
  ]),
  price: async (c, ctx) => {
    const red = c.redundancy || 'LRS', gb = n(c.dataGB), w = n(c.writeOps), r = n(c.readOps), geo = n(c.geoReplicationGB);
    if (w && (red === 'GZRS' || red === 'RA-GZRS')) throw new PricingError(`No price is published for write (Class 1) queue operations on ${red}; use ZRS, GRS or RA-GRS, or set writeOps to 0.`);
    if (geo && !GEO.includes(red)) throw new PricingError('geoReplicationGB only applies to GRS, RA-GRS, GZRS or RA-GZRS.');
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Queues v2' and skuName eq 'Standard ${red}'`, ctx);
    if (!rs.length) throw new PricingError(`Queue Storage ${red} is not priced in ${ctx.region}.`);
    const m = (re, what) => { const x = single(rs.filter(q => re.test(q.meterName)), `Queue Storage ${red} ${what}`); if (!x.length) throw new PricingError(`Queue Storage ${red} ${what} is not priced in ${ctx.region}.`); return x; };
    const G = 'Storage', S = 'Queue Storage', lines = [];
    if (gb) lines.push(meterLine(G, S, `Queue capacity (${red}): ${fmtN(gb)} GB`, m(/Data Stored$/, 'capacity'), gb, ctx, { unit: 'GB-month' }));
    if (w) lines.push(meterLine(G, S, `Queue write operations, Class 1 (${red}): ${fmtN(w)}`, m(/Class 1 Operations$/, 'write operations'), w, ctx, { unit: 'ops' }));
    if (r) lines.push(meterLine(G, S, `Queue read operations, Class 2 (${red}): ${fmtN(r)}`, m(/Class 2 Operations$/, 'read operations'), r, ctx, { unit: 'ops' }));
    if (geo) {
      const g = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Storage - Bandwidth' and skuName eq 'Geo-Replication v2'`, ctx);
      const gm = single(g, 'Geo-replication data transfer');
      if (!gm.length) throw new PricingError(`Geo-replication data transfer is not priced in ${ctx.region}.`);
      lines.push(meterLine(G, 'Storage - Bandwidth', `Geo-replication data transfer: ${fmtN(geo)} GB`, gm, geo, ctx, { unit: 'GB' }));
    }
    if (!lines.length) throw new PricingError('Nothing to price: set dataGB, writeOps or readOps.');
    return { lines, notes: ['Class 1 operations are writes (put, update, delete message, create or list queues); Class 2 are reads (get or peek messages). Operations are billed per 10,000.', 'Capacity is billed on average GB stored in the month.'], facts: { redundancy: red, dataGB: gb, writeOps: w, readOps: r } };
  }
};
