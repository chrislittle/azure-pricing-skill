'use strict';
// Azure SQL Database single databases in the DTU purchasing model (Basic, Standard S0-S12, Premium P1-P15)
// plus extra storage. Meters: serviceName 'SQL Database', products 'SQL Database Single Basic/Standard/Premium'
// (billed per database per day) and 'SQL Database Standard/Premium - Storage' (per GB per month).
// DTU single databases have no reservations and no Azure Hybrid Benefit.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const RED = { LRS: 'LRS', ZRS: 'ZRS', GRS: 'RA-GRS', GZRS: 'RA-GZRS' };

// dtus, GB of storage included in the price, and the largest size the level allows (published resource limits).
const LEVELS = {
  basic: { tier: 'Basic', sku: 'B', dtus: 5, included: 2, max: 2 },
  s0: { tier: 'Standard', sku: 'S0', dtus: 10, included: 250, max: 250 },
  s1: { tier: 'Standard', sku: 'S1', dtus: 20, included: 250, max: 250 },
  s2: { tier: 'Standard', sku: 'S2', dtus: 50, included: 250, max: 250 },
  s3: { tier: 'Standard', sku: 'S3', dtus: 100, included: 250, max: 1024 },
  s4: { tier: 'Standard', sku: 'S4', dtus: 200, included: 250, max: 1024 },
  s6: { tier: 'Standard', sku: 'S6', dtus: 400, included: 250, max: 1024 },
  s7: { tier: 'Standard', sku: 'S7', dtus: 800, included: 250, max: 1024 },
  s9: { tier: 'Standard', sku: 'S9', dtus: 1600, included: 250, max: 1024 },
  s12: { tier: 'Standard', sku: 'S12', dtus: 3000, included: 250, max: 1024 },
  p1: { tier: 'Premium', sku: 'P1', dtus: 125, included: 500, max: 1024 },
  p2: { tier: 'Premium', sku: 'P2', dtus: 250, included: 500, max: 1024 },
  p4: { tier: 'Premium', sku: 'P4', dtus: 500, included: 500, max: 1024 },
  p6: { tier: 'Premium', sku: 'P6', dtus: 1000, included: 500, max: 1024 },
  p11: { tier: 'Premium', sku: 'P11', dtus: 1750, included: 4096, max: 4096 },
  p15: { tier: 'Premium', sku: 'P15', dtus: 4000, included: 4096, max: 4096 }
};

module.exports = {
  type: 'sql-database-dtu',
  label: 'Azure SQL Database (DTU model, single databases)',
  family: 'databases',
  calculator: ['azure-sql-database'],
  keywords: ['sql database', 'dtu', 'database', 'sql server', 'basic standard premium', 'small database', 'dev test database', 'relational database'],
  fields: {
    level: { req: true, enum: Object.keys(LEVELS), ask: 'How big a database is it? Light use (a small app, a test database, a few users) -> basic (5 DTUs, 2 GB) or s0/s1; a typical small business app -> s2 or s3; busier or CPU-heavy apps -> s4 to s12; very high transaction rates or low latency -> p1 to p15. If unknown, suggest s0 for a test/development database or s3 for a small production app, and record it as an assumption. Never ask for the level name; map from what they describe.' },
    databases: { def: 1, int: true, min: 1, ask: 'How many separate databases of this size do you need? (Each database is billed on its own. Copies kept in another region for disaster recovery are counted separately in the next question.) If several light databases could share capacity, mention that an elastic pool may cost less.' },
    geoReplicas: { def: 0, int: true, min: 0, ask: 'Will each database have active geo-replica copies in other regions for disaster recovery? How many per database? Each geo-secondary is billed at the same price as the primary. Use 0 if none.' },
    extraStorageGb: { def: 0, int: true, min: 0, ask: 'Does each database need more space than the size includes (basic 2 GB, standard 250 GB, p1-p6 500 GB, p11/p15 4 TB)? How many extra GB per database? Extra space is only available from s3 up to 1 TB, and p1-p6 up to 1 TB. Use 0 if unknown.' },
    ltrStorageGb: { def: 0, min: 0, ask: 'Do they need to keep weekly, monthly or yearly backups for months or years (long-term retention)? Roughly how many GB in total, for example database size times the number of backups kept? Use 0 if not.' },
    backupRedundancy: { def: 'GRS', enum: ['LRS', 'ZRS', 'GRS', 'GZRS'], ask: 'For long-term backups: kept in one datacenter (LRS), across zones (ZRS), in a paired region (GRS, the default) or both (GZRS)?' },
    hours: { def: 730, ask: 'Does the database exist all the time, or only part of the month? (730 hours = always on. A database is billed for every hour it exists, even when idle.)' }
  },
  context: ['production', 'steadyUsage'],
  examples: [
    { type: 'sql-database-dtu', level: 's0' },
    { type: 'sql-database-dtu', level: 's3', databases: 3, extraStorageGb: 400, hours: 730 },
    { type: 'sql-database-dtu', level: 'p2', databases: 2, extraStorageGb: 300, hours: 400 }
  ],
  readback: c => {
    const L = LEVELS[c.level || 's0'] || {};
    const hrs = c.hours ?? HOURS;
    return `${fmtN(n(c.databases) || 1)} Azure SQL database(s), DTU model, ${L.tier || ''} ${L.sku || String(c.level || '').toUpperCase()} (${fmtN(L.dtus || 0)} DTUs, ${fmtN(L.included || 0)} GB included)` +
      `${n(c.extraStorageGb) ? `, plus ${fmtN(c.extraStorageGb)} GB extra storage each` : ''}${n(c.geoReplicas) ? `, ${fmtN(c.geoReplicas)} geo-replica(s) each` : ''}${n(c.ltrStorageGb) ? `, ${fmtN(c.ltrStorageGb)} GB long-term backups (${c.backupRedundancy || 'GRS'})` : ''}, ${hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month`}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Point-in-time backups are included in the DTU price. Elastic job agents, data egress to other regions, and failover group extras are not in this estimate.'],
  price: async (c, ctx) => {
    const key = String(c.level || '').toLowerCase();
    const L = LEVELS[key];
    if (!L) throw new PricingError(`Unknown level "${c.level}". Use ${Object.keys(LEVELS).join(', ')}.`);
    const dbs = (n(c.databases) || 1) * (1 + n(c.geoReplicas)), hours = c.hours ?? HOURS, extra = n(c.extraStorageGb);
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (extra && L.max <= L.included) throw new PricingError(`${key.toUpperCase()} has no extra storage option: its ${fmtN(L.included)} GB is the maximum size.`);
    if (extra && L.included + extra > L.max) throw new PricingError(`${key.toUpperCase()} allows at most ${fmtN(L.max)} GB per database (${fmtN(L.included)} GB included + up to ${fmtN(L.max - L.included)} GB extra).`);
    const product = `SQL Database Single ${L.tier}`;
    const rs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${product}' and skuName eq '${L.sku}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`${L.tier} ${L.sku} single databases are not priced in ${ctx.region}.`);
    const compute = single(rs, `SQL Database ${L.sku}`);
    const days = dbs * hours / 24;
    const lines = [meterLine('Database', 'SQL Database', `${L.tier} ${L.sku} single database (${fmtN(L.dtus)} DTUs, ${fmtN(L.included)} GB included), ${fmtN(dbs)} database(s)${n(c.geoReplicas) ? ` (including ${fmtN(n(c.geoReplicas))} geo-replica(s) each)` : ''} x ${fmtN(hours)} hours`, compute, days, ctx, { unit: 'database-days' })];
    if (extra) {
      const srs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database ${L.tier} - Storage' and priceType eq 'Consumption'`, ctx);
      const st = single(srs.filter(r => r.meterName === 'Data Stored'), `${L.tier} extra storage`);
      lines.push(meterLine('Database', 'SQL Database', `Extra storage, ${fmtN(extra)} GB x ${fmtN(dbs)} database(s)`, st, extra * dbs, ctx, { unit: 'GB / month' }));
    }
    const bred = String(c.backupRedundancy || 'GRS').toUpperCase();
    if (n(c.ltrStorageGb)) {
      if (!RED[bred]) throw new PricingError('backupRedundancy must be LRS, ZRS, GRS or GZRS.');
      const lrs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database - LTR Backup Storage' and priceType eq 'Consumption'`, ctx);
      const m = single(lrs.filter(r => r.meterName === `Backup ${RED[bred]} Data Stored`), 'SQL Database LTR backup');
      lines.push(meterLine('Database', 'SQL Database', `Long-term retention backup storage, ${fmtN(n(c.ltrStorageGb))} GB (${bred})`, m, n(c.ltrStorageGb), ctx, { unit: 'GB / month' }));
    }
    const notes = [`The ${L.tier} ${L.sku} price covers ${fmtN(L.dtus)} DTUs and ${fmtN(L.included)} GB of storage per database. The Retail meter is a price per database per day; it is divided by 24 for each hour the database exists.`,
      'DTU databases cannot use reservations or Azure Hybrid Benefit; those apply to the vCore model only. Point-in-time backup storage is part of the DTU price; only long-term retention backups are billed separately.'];
    return { lines, notes, facts: { level: key, tier: L.tier.toLowerCase(), dtus: L.dtus, databases: dbs, geoReplicas: n(c.geoReplicas), extraStorageGb: extra, ltrStorageGb: n(c.ltrStorageGb), hours } };
  }
};

