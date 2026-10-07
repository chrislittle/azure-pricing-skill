'use strict';
// Azure Data Lake Storage Gen2 (storage account with hierarchical namespace): capacity by access tier and
// redundancy, metadata, and the separate operation classes (write, read, iterative write/read, other) plus data retrieval.
// Meters: serviceName 'Storage', product 'Azure Data Lake Storage Gen2 Hierarchical Namespace' (premium: 'Premium ADLS Gen2 Hierarchical Namespace').
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const TIERS = { hot: 'Hot', cool: 'Cool', cold: 'Cold', archive: 'Archive', premium: 'Premium' };

module.exports = {
  type: 'data-lake-storage',
  label: 'Azure Data Lake Storage Gen2',
  family: 'storage',
  calculator: ['storage'],
  keywords: ['data lake', 'adls gen2', 'hierarchical namespace', 'data lake storage', 'analytics storage', 'lakehouse storage', 'big data storage', 'datalake'],
  fields: {
    dataGB: { req: true, ask: 'About how many GB will the data lake hold? If unknown, suggest 10,000 GB (10 TB) and record it as an assumption.' },
    tier: { def: 'hot', enum: ['hot', 'cool', 'cold', 'archive', 'premium'], ask: 'How often is the data used? hot (frequent, default), cool (about monthly), cold (rarely), archive (almost never, hours to retrieve) or premium (fast SSD for heavy analytics). Default hot.' },
    redundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS', 'RA-GRS', 'GZRS', 'RA-GZRS'], ask: 'Copies of the data: LRS (default), ZRS (across zones), GRS (plus a second region), RA-GRS, GZRS or RA-GZRS. Premium only offers LRS or ZRS; archive only LRS, GRS or RA-GRS.' },
    metadataGB: { def: 0, ask: 'GB of file system metadata (folder and file listing). It is usually small; use 0 if unknown and record it as an assumption.' },
    writeOps: { def: 0, int: true, ask: 'Roughly how many write operations a month (uploading or appending data)? Every 4 MB of a request counts as one operation, so a 40 MB upload is 10. Use 0 if unknown.' },
    readOps: { def: 0, int: true, ask: 'Roughly how many read operations a month (downloading or reading data)? Every 4 MB of a request counts as one operation. Use 0 if unknown.' },
    iterativeWriteOps: { def: 0, int: true, ask: 'Roughly how many directory rename or move operations a month (RenameDirectory, RenamePath)? Analytics jobs that commit by renaming create many. Use 0 if unknown.' },
    iterativeReadOps: { def: 0, int: true, ask: 'Roughly how many directory listing operations a month (List Filesystem, List Path)? Use 0 if unknown.' },
    otherOps: { def: 0, int: true, ask: 'Roughly how many other operations a month (get properties, delete is free)? Use 0 if unknown.' },
    queryScannedGB: { def: 0, ask: 'Hot or cool only: GB scanned by query acceleration (filtering pushed down into storage) a month. Use 0 if not used.' },
    queryReturnedGB: { def: 0, ask: 'Hot or cool only: GB returned by query acceleration a month. Use 0 if not used.' },
    geoReplicationGB: { def: 0, ask: 'Only for GRS, RA-GRS, GZRS or RA-GZRS: GB copied to the second region a month, roughly the new and changed data written. Use 0 if unknown.' },
    dataRetrievalGB: { def: 0, ask: 'Cool, cold or archive only: GB read back out of the tier a month. Use 0 if unknown.' }
  },
  examples: [
    { type: 'data-lake-storage', dataGB: 20000, writeOps: 50000000, readOps: 200000000, iterativeReadOps: 10000000, otherOps: 20000000 },
    { type: 'data-lake-storage', dataGB: 100000, tier: 'cool', redundancy: 'ZRS', metadataGB: 0, writeOps: 5000000, readOps: 10000000, dataRetrievalGB: 5000 },
    { type: 'data-lake-storage', dataGB: 8000, tier: 'cool', redundancy: 'GRS', iterativeReadOps: 3000000, queryScannedGB: 500, queryReturnedGB: 50, geoReplicationGB: 400 },
    { type: 'data-lake-storage', dataGB: 5000, tier: 'premium', writeOps: 100000000, readOps: 300000000, iterativeWriteOps: 2000000, iterativeReadOps: 40000000 }
  ],
  readback: c => `Data Lake Storage Gen2 (${c.tier || 'hot'}, ${c.redundancy || 'LRS'}): ${fmtN(n(c.dataGB))} GB stored` +
    [['metadataGB', 'GB metadata'], ['writeOps', 'write operations'], ['readOps', 'read operations'], ['iterativeWriteOps', 'iterative write operations'], ['iterativeReadOps', 'iterative read operations'], ['otherOps', 'other operations'], ['dataRetrievalGB', 'GB retrieved']]
      .map(([k, l]) => n(c[k]) ? `, ${fmtN(n(c[k]))} ${l}` : '').join('') + ' a month',
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Archive priority-read and high-priority retrieval, early-deletion charges for cool, cold and archive, and rehydration charges.',
    'Delete operations (free) and data transfer out.'
  ]),
  price: async (c, ctx) => {
    const tier = c.tier || 'hot', red = c.redundancy || 'LRS', T = TIERS[tier];
    if (tier === 'archive' && !['LRS', 'GRS', 'RA-GRS'].includes(red)) throw new PricingError('Archive storage does not support ZRS, GZRS or RA-GZRS; choose LRS, GRS or RA-GRS.');
    if (['queryScannedGB', 'queryReturnedGB'].some(k => n(c[k])) && !['hot', 'cool'].includes(tier)) throw new PricingError('Query acceleration is only priced for hot and cool tiers.');
    if (n(c.geoReplicationGB) && !/GRS|GZRS/.test(red)) throw new PricingError('Geo-replication transfer only applies to geo-redundant (GRS, RA-GRS, GZRS, RA-GZRS) accounts.');
    if (tier === 'premium' && !['LRS', 'ZRS'].includes(red)) throw new PricingError('Premium Data Lake Storage is only available as LRS or ZRS.');
    const product = tier === 'premium' ? 'Premium ADLS Gen2 Hierarchical Namespace' : 'Azure Data Lake Storage Gen2 Hierarchical Namespace';
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq '${product}' and skuName eq '${T} ${red}'`, ctx);
    if (!rs.length) throw new PricingError(`Data Lake Storage ${tier} ${red} is not priced in ${ctx.region}.`);
    const m = (re, excl, what) => { const x = single(rs.filter(q => re.test(q.meterName) && !(excl && excl.test(q.meterName))), `Data Lake ${tier} ${red} ${what}`); if (!x.length) throw new PricingError(`Data Lake Storage ${tier} ${red} has no ${what} price in ${ctx.region}.`); return x; };
    const G = 'Storage', S = 'Data Lake Storage Gen2', lines = [];
    const L = (desc, meter, qty, unit) => lines.push(meterLine(G, S, `${desc} (${tier}, ${red})`, meter, qty, ctx, { unit }));
    const gb = n(c.dataGB);
    if (gb) L(`Data Lake capacity: ${fmtN(gb)} GB`, m(/Data Stored$/, null, 'capacity'), gb, 'GB-month');
    const unpriced = [];
    const soft = (re, what) => { const x = rs.filter(q => re.test(q.meterName)); if (!x.length) { unpriced.push(what); return null; } return single(x, `Data Lake ${tier} ${red} ${what}`); };
    if (n(c.metadataGB)) { const mx = soft(/(Index|MetaData Storage)$/, 'file system metadata'); if (mx) L(`File system metadata: ${fmtN(n(c.metadataGB))} GB`, mx, n(c.metadataGB), 'GB-month'); }
    const ops = [
      ['writeOps', 'write operations', /Write Operations$/, /Iterative/, 'write operations'],
      ['readOps', 'read operations', /Read Operations$/, /Iterative|Priority/, 'read operations'],
      ['iterativeWriteOps', 'iterative write operations', /Iterative Write Operations$/, null, 'iterative write operations'],
      ['iterativeReadOps', 'iterative read operations', /Iterative Read Operations$/, null, 'iterative read operations'],
      ['otherOps', 'other operations', /Other Operations$/, null, 'other operations'],
      ['dataRetrievalGB', 'data retrieval', /Data Retrieval$/, /Priority/, 'data retrieval']
    ];
    for (const [k, label, re, excl, what] of ops) {
      const q = n(c[k]);
      if (!q) continue;
      const soft_ = ['iterativeWriteOps', 'iterativeReadOps', 'otherOps'].includes(k) && ['cool', 'cold'].includes(tier);
      const meter = soft_ ? soft(re, what) : m(re, excl, what);
      if (meter) L(`Data Lake ${label}: ${fmtN(q)}${k === 'dataRetrievalGB' ? ' GB' : ''}`, meter, q, k === 'dataRetrievalGB' ? 'GB' : 'ops');
    }
    for (const [k, re, what, lbl] of [['queryScannedGB', /Data Scanned for Query Acceleration$/, 'query acceleration scanned', 'Query acceleration data scanned'], ['queryReturnedGB', /Data Returned for Query Acceleration$/, 'query acceleration returned', 'Query acceleration data returned']]) {
      if (n(c[k])) L(`${lbl}: ${fmtN(n(c[k]))} GB`, m(re, null, what), n(c[k]), 'GB');
    }
    if (n(c.geoReplicationGB)) {
      const gr = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Storage - Bandwidth' and skuName eq 'Geo-Replication v2'`, ctx);
      if (!gr.length) throw new PricingError(`Geo-replication transfer is not priced in ${ctx.region}.`);
      lines.push(meterLine(G, S, `Geo-replication transfer: ${fmtN(n(c.geoReplicationGB))} GB`, single(gr, 'geo-replication transfer'), n(c.geoReplicationGB), ctx, { unit: 'GB' }));
    }
    if (!lines.length && !unpriced.length) throw new PricingError('Nothing to price: set dataGB or another quantity.');
    if (!lines.length) throw new PricingError('Nothing to price: the requested operations are not on the Retail price sheet for this tier; use the Azure Pricing Calculator.');
    const notes = unpriced.length ? [`Not priced (no ${tier} meter on the Azure Retail Prices API, check the Azure Pricing Calculator): ${unpriced.join(', ')}.`] : [];
    return { lines, notes: [...notes, 'Operations are billed per 10,000 (iterative writes per 100); iterative operations act on directories (rename, list) and cost more than plain reads and writes.', 'Capacity is billed on average GB stored in the month, in graduated tiers for hot storage.'], facts: { tier, redundancy: red, dataGB: gb, minimumRetentionDays: { cool: 30, cold: 90, archive: 180 }[tier] || 0 } };
  }
};
