'use strict';
// Azure HorizonDB (preview): cloud-native PostgreSQL clusters. Meters live under serviceName
// 'Azure Database for PostgreSQL' with productName 'Azure HorizonDB ...': one per-vCore hourly compute
// meter (billed for the primary and every standby replica), allocated storage per GB-month and backup storage per GB-month.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
// Regions Microsoft Learn lists for the preview (overview, Azure regions); the Retail API prices more.
const LEARN_REGIONS = ['canadacentral', 'centralus', 'eastus', 'westus2', 'westus3', 'germanywestcentral', 'swedencentral', 'australiaeast', 'koreacentral'];
const SIZES = [2, 4, 8, 16, 20, 32, 48, 64, 96, 128, 192];

module.exports = {
  type: 'horizondb',
  label: 'Azure HorizonDB',
  family: 'data-platform',
  calculator: ['horizondb'],
  keywords: ['horizondb', 'horizon db', 'postgresql', 'postgres', 'cloud native postgres', 'relational database', 'read replicas', 'vector database'],
  fields: {
    vcores: { req: true, ask: `How many vCores should each database server (compute replica) have? Each vCore comes with 8 GB of memory. Allowed sizes: ${SIZES.join(', ')}. If unknown, suggest 4 for a small production app and record it as an assumption.` },
    replicas: { def: 1, int: true, min: 1, max: 16, ask: 'How many compute replicas in total, counting the writable primary and every standby or read replica? Every replica is billed at the full vCore price. A cluster can have up to 16 (the primary plus 15 replicas). Zone resilience needs at least 2. If unknown, use 2 for production and 1 for dev/test.' },
    storageGb: { req: true, ask: 'How many GB of data and logs will the database hold? You pay for the allocated storage, which grows automatically; the storage is shared by all replicas, so it is counted once. If unknown, suggest 100 and record it as an assumption.' },
    backupGb: { def: 0, min: 0, ask: 'How many GB of backups do they expect to keep in TOTAL (not just the extra; a longer backup retention period means more)? Backup storage up to the database size is free, only the excess is charged. If unknown, use 0.' },
    extraBackupGb: { def: 0, min: 0, ask: 'Only if they already know the billable amount (as the Azure Pricing Calculator asks it): how many GB of backup storage beyond the free allowance? Leave 0 if they gave the total above.' },
    hours: { def: 730, ask: 'How many hours a month are the replicas running? (730 = all month; storage is billed all month either way.)' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'horizondb', vcores: 4, storageGb: 100 },
    { type: 'horizondb', vcores: 16, replicas: 3, storageGb: 2000, backupGb: 2500, hours: 730 }
  ],
  readback: c => {
    const rep = n(c.replicas) || 1, h = c.hours ?? HOURS;
    const backup = [n(c.backupGb) && `${fmtN(n(c.backupGb))} GB of backups kept in total (up to the database size is free)`, n(c.extraBackupGb) && `${fmtN(n(c.extraBackupGb))} GB of billable backup storage`].filter(Boolean).join(', ') || 'no backup storage beyond the free allowance';
    return `HorizonDB cluster: ${fmtN(n(c.vcores))} vCores per replica x ${fmtN(rep)} replica${rep === 1 ? '' : 's'} (primary included), ${h === HOURS ? 'running all month' : `${fmtN(h)} hours a month`}, ${fmtN(n(c.storageGb))} GB data and log storage, ${backup}`;
  },  notIncluded: (types, spec) => (spec.excluded || []).includes('horizondb-extras') ? [] : [
    'Microsoft Foundry model usage if AI models are enabled on the cluster (billed by Foundry at its own rates).',
    'Outbound data transfer, private endpoints and monitoring/log storage.'
  ],
  price: async (c, ctx) => {
    const vcores = n(c.vcores), replicas = c.replicas == null ? 1 : n(c.replicas), hours = c.hours ?? HOURS;
    if (!SIZES.includes(vcores)) throw new PricingError(`vcores must be one of ${SIZES.join(', ')}.`);
    if (!Number.isInteger(replicas) || replicas < 1) throw new PricingError('replicas must be a whole number of at least 1 (the primary counts as one).');
    if (replicas > 16) throw new PricingError('A HorizonDB cluster can have at most 16 compute replicas (the primary plus 15 replicas).');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const rs = await rows(`serviceName eq 'Azure Database for PostgreSQL' and contains(productName, 'HorizonDB') and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const comp = rs.filter(r => r.productName === 'Azure HorizonDB Compute' && r.meterName === '1 vCore');
    if (!rs.length || !comp.length) throw new PricingError(`Azure HorizonDB is not offered in ${ctx.region}. Learn lists these preview regions: ${LEARN_REGIONS.join(', ')}.`);
    const m = (product, meter, what) => single(rs.filter(r => r.productName === product && r.meterName === meter), `HorizonDB ${what}`);
    const G = 'Database', S = 'Azure Database for PostgreSQL', lines = [];
    lines.push(meterLine(G, S, `HorizonDB compute: ${fmtN(vcores)} vCores x ${fmtN(replicas)} replica(s) x ${fmtN(hours)} hours`, m('Azure HorizonDB Compute', '1 vCore', 'compute'), vcores * replicas * hours, ctx, { unit: 'vCore-hours' }));
    lines.push(meterLine(G, S, `HorizonDB data and log storage, ${fmtN(n(c.storageGb))} GB allocated`, m('Azure HorizonDB Storage', 'HorizonDB Storage Data Stored', 'storage'), n(c.storageGb), ctx, { unit: 'GB / month' }));
    const billableBackup = Math.max(0, n(c.backupGb) - n(c.storageGb)) + n(c.extraBackupGb);
    const how = [n(c.backupGb) && `${fmtN(n(c.backupGb))} GB kept, ${fmtN(n(c.storageGb))} GB free`, n(c.extraBackupGb) && `${fmtN(n(c.extraBackupGb))} GB entered as billable`].filter(Boolean).join(', plus ');
    if (billableBackup > 0) lines.push(meterLine(G, S, `HorizonDB backup storage above the free allowance: ${fmtN(billableBackup)} GB (${how})`, m('Azure HorizonDB Backup Storage', 'HorizonDB Backup Storage Data Stored', 'backup storage'), billableBackup, ctx, { unit: 'GB / month' }));
    const notes = [
      'Compute is billed per vCore per hour for the primary and for every standby or read replica; all replicas share one copy of the storage, which is billed once.',
      'Backup storage up to the size of the database is free; only the excess is charged per GB per month.',
      'Deleted HorizonDB databases keep incurring backup costs while the backups are kept for point-in-time recovery.',
      'Azure HorizonDB is in public preview: prices and regions may change.'
    ];
    if (!LEARN_REGIONS.includes(ctx.region)) notes.push(`Microsoft Learn lists the preview regions as ${LEARN_REGIONS.join(', ')}; ${ctx.region} is priced in the Retail Prices API but is not on that list, so check availability before promising it.`);
    return { lines, notes, facts: { vcores, replicas, hours, storageGb: n(c.storageGb), backupGb: n(c.backupGb), extraBackupGb: n(c.extraBackupGb), billableBackupGb: billableBackup } };
  }
};
