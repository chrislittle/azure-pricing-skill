'use strict';
// Azure Table Storage (general-purpose v2). Default tables (service-scoped key) pay one price for every
// transaction ('Standard <redundancy>' sku); tables using account-scoped encryption keys pay per operation class
// ('Account Encrypted <redundancy>' sku). Meters: serviceName 'Storage', product 'Tables'.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const CLASSES = ['writeOps', 'batchWriteOps', 'readOps', 'listOps', 'scanOps'];
const OPS = [
  ['writeOps', 'write operations', /Write Operations$/, /Batch/, 'Write'],
  ['batchWriteOps', 'batch write operations', /Batch Write Operations$/, null, 'Batch write'],
  ['readOps', 'read operations', /Read Operations$/, null, 'Read'],
  ['listOps', 'list operations', /List Operations$/, null, 'List'],
  ['scanOps', 'scan operations', /Scan Operations$/, null, 'Scan']
];

module.exports = {
  type: 'table-storage',
  label: 'Azure Table Storage',
  family: 'storage',
  calculator: ['storage'],
  keywords: ['table storage', 'azure tables', 'nosql key value store', 'storage table', 'cheap nosql', 'entity storage', 'telemetry table'],
  fields: {
    dataGB: { req: true, ask: 'About how many GB of table data (entities) will be stored? If unknown, suggest 100 GB and record it as an assumption.' },
    encryption: { def: 'service', enum: ['service', 'account-key'], ask: 'Do the tables use Microsoft\'s default encryption key (service, the default) or a customer-managed key set up for the whole storage account (account-key, a less common option that costs far more per operation)? Default service.' },
    transactions: { def: 0, int: true, ask: 'Default encryption only: roughly how many table operations a month in total (reads, writes, deletes, lists and scans all count the same)? Use 0 if unknown.' },
    writeOps: { def: 0, int: true, ask: 'Roughly how many single-entity write operations a month (insert, update, merge)? Use 0 if none.' },
    batchWriteOps: { def: 0, int: true, ask: 'Roughly how many batch write operations a month (several entities written together)? Use 0 if none.' },
    readOps: { def: 0, int: true, ask: 'Roughly how many read operations a month (looking up an entity by its key)? Use 0 if unknown.' },
    listOps: { def: 0, int: true, ask: 'Roughly how many list operations a month (listing tables)? Use 0 if none.' },
    scanOps: { def: 0, int: true, ask: 'Roughly how many scan operations a month (queries that scan the table instead of using the key)? Use 0 if none.' },
    redundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS', 'RA-GRS', 'GZRS', 'RA-GZRS'], ask: 'Copies of the data: LRS (default), ZRS (across zones), GRS (plus a second region), RA-GRS (GRS with read access to the second region), GZRS or RA-GZRS. Default LRS.' }
  },
  examples: [
    { type: 'table-storage', dataGB: 1000, transactions: 600000000 },
    { type: 'table-storage', dataGB: 200, redundancy: 'GZRS', writeOps: 50000000, readOps: 200000000, listOps: 1000000 },
    { type: 'table-storage', dataGB: 1000, encryption: 'account-key', writeOps: 10000000, batchWriteOps: 20000000, readOps: 100000000, scanOps: 5000000, redundancy: 'RA-GRS' }
  ],
  readback: c => `Table Storage (${c.redundancy || 'LRS'}, ${c.encryption === 'account-key' ? 'account-scoped key' : 'default encryption'}): ${fmtN(n(c.dataGB))} GB stored` +
    (n(c.transactions) ? `, ${fmtN(n(c.transactions))} operations` : '') + OPS.map(([k, label]) => n(c[k]) ? `, ${fmtN(n(c[k]))} ${label}` : '').join('') + ' a month',
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Data transfer out, geo-replication data transfer, and Azure Cosmos DB for Table (a separate service).'
  ]),
  price: async (c, ctx) => {
    const red = c.redundancy || 'LRS', gb = n(c.dataGB), accountKey = c.encryption === 'account-key';
    if (accountKey && n(c.transactions)) throw new PricingError('transactions applies to default encryption; with account-key use the operation classes.');
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Tables' and skuName eq '${accountKey ? 'Account Encrypted' : 'Standard'} ${red}'`, ctx);
    if (!rs.length) throw new PricingError(`Table Storage ${red} is not priced in ${ctx.region}.`);
    const G = 'Storage', S = 'Table Storage', lines = [];
    const m = (re, excl, what) => { const x = single(rs.filter(q => re.test(q.meterName) && !(excl && excl.test(q.meterName))), `Table Storage ${red} ${what}`); if (!x.length) throw new PricingError(`Table Storage ${red} ${what} is not priced in ${ctx.region}.`); return x; };
    if (gb) lines.push(meterLine(G, S, `Table capacity (${red}): ${fmtN(gb)} GB`, m(/Data Stored$/, null, 'capacity'), gb, ctx, { unit: 'GB-month' }));
    if (accountKey) {
      for (const [k, label, re, excl, what] of OPS) {
        const q = n(c[k]);
        if (q) lines.push(meterLine(G, S, `Table ${label} (${red}, account-scoped key): ${fmtN(q)}`, m(re, excl, what), q, ctx, { unit: 'ops' }));
      }
    } else {
      const total = n(c.transactions) + CLASSES.reduce((a, k) => a + n(c[k]), 0);
      if (total) lines.push(meterLine(G, S, `Table operations (${red}): ${fmtN(total)}`, m(/^Read Operations$/, null, 'transaction'), total, ctx, { unit: 'ops' }));
    }
    if (!lines.length) throw new PricingError('Nothing to price: set dataGB or an operations count.');
    return { lines, notes: ['Operations are billed per 10,000. With default encryption every operation, including deletes, costs the same; with an account-scoped key each operation class has its own rate and deletes are free.', 'Capacity is billed on average GB stored in the month.'], facts: { redundancy: red, dataGB: gb, encryption: accountKey ? 'account-key' : 'service' } };
  }
};
