'use strict';
// Azure DocumentDB (MongoDB-compatible clusters, formerly Azure Cosmos DB for MongoDB vCore).
// Meters: serviceName 'Azure Cosmos DB', productName 'Azure DocumentDB' (pay as you go) and
// 'Azure DocumentDB Reservations'. M30 and larger are priced per vCORE per hour
// (the "Coordinator Node 1 vCore" meter x the vCores of the tier, like the calculator); burstable tiers have one meter per node. Storage is per GB
// provisioned per node. High availability adds a standby for every shard with the same compute and storage.
const { rows, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);
const haOf = c => c.highAvailability ?? String(c.tier || 'm30').toLowerCase() !== 'free';

// Cluster tier -> compute meter skuName, vCores per node, memory (pricing page "Price per Node" table).
const TIERS = {
  free: { sku: 'Free - Burstable', vcores: 1, mem: 'free tier', label: 'Free' },
  m10: { sku: 'Burstable 1 vCore', vcores: 1, mem: '2 GiB', label: 'M10 (burstable)' },
  m20: { sku: 'Burstable 2 vCore', vcores: 2, mem: '4 GiB', label: 'M20 (burstable)' },
  m25: { sku: 'B2MS', vcores: 2, mem: '8 GiB', label: 'M25 (burstable)' },
  m30: { sku: 'Coordinator Node 1 vCore', perVcore: true, vcores: 2, mem: '8 GiB', label: 'M30', ri: true },
  m40: { sku: 'Coordinator Node 1 vCore', perVcore: true, vcores: 4, mem: '16 GiB', label: 'M40', ri: true },
  m50: { sku: 'Coordinator Node 1 vCore', perVcore: true, vcores: 8, mem: '32 GiB', label: 'M50', ri: true },
  m60: { sku: 'Coordinator Node 1 vCore', perVcore: true, vcores: 16, mem: '64 GiB', label: 'M60', ri: true },
  m80: { sku: 'Coordinator Node 1 vCore', perVcore: true, vcores: 32, mem: '128 GiB', label: 'M80', ri: true },
  m200: { sku: 'Coordinator Node 1 vCore', perVcore: true, vcores: 64, mem: '256 GiB', label: 'M200', ri: true },
  m300: { sku: 'Coordinator Node 1 vCore', perVcore: true, vcores: 96, mem: '384 GiB', label: 'M300', ri: true },
  'm200-autoscale': { sku: '1 vCore - autoscale', perVcore: true, vcores: 64, mem: '256 GiB at full size', label: 'M200 Autoscale (priced at the 64-vCore maximum)' }
};
// Storage sizes (GiB) a node can be provisioned with; the bill is for the size, not the data stored.
const SIZES = [32, 64, 128, 256, 512, 1024, 2048, 4095, 8192, 16384, 32767];

module.exports = {
  type: 'documentdb',
  label: 'Azure DocumentDB',
  family: 'data-platform',
  calculator: ['documentdb'],
  keywords: ['mongodb', 'mongo', 'document database', 'documentdb', 'nosql', 'cosmos db for mongodb', 'vcore', 'json documents'],
  fields: {
    tier: { def: 'm30', enum: Object.keys(TIERS), ask: 'How powerful should each database server (node) be? Just trying it out for free (one per subscription, 32 GB, no high availability) -> free. Small dev/test -> m10 (1 vCPU, 2 GB), m20 (2 vCPUs, 4 GB) or m25 (2 vCPUs, 8 GB); these can burst. Normal production sizes: m30 (2 vCPUs, 8 GB), m40 (4 vCPUs, 16 GB), m50 (8 vCPUs, 32 GB), m60 (16 vCPUs, 64 GB), m80 (32 vCPUs, 128 GB), m200 (64 vCPUs, 256 GB), m300 (96 vCPUs, 384 GB). For a workload that swings between 32 and 64 vCPUs and should scale by itself: m200-autoscale (billed at its 64-vCPU maximum here). If unknown, suggest m30 and record it as an assumption.' },
    storageGb: { req: true, ask: 'How many GB of database storage does each server need? Storage is bought in fixed sizes (32, 64, 128, 256, 512, 1,024, 2,048, 4,095 GB and larger) and billed for the size, not what is used, so the next size up is priced. If unknown, suggest 128 and record it as an assumption.' },
    shards: { def: 1, int: true, min: 1, ask: 'Does the data need to be spread over several servers (shards) for more storage or speed? How many? If everything fits on one server, 1.' },
    highAvailability: { ask: 'Defaults to on for every tier except free (the free tier has no high availability). Is this production, or anything that must stay up if a server fails? Then keep high availability on, which keeps a standby copy of every server and doubles the compute and storage price. Switch it off only for development/test.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Pay as you go, or compare a 1- or 3-year commitment (ri1y/ri3y = reservation, m30 to m300 only; sp1y/sp3y = savings plan for databases, 20% off, any paid tier)? Only worth it if it runs all month.' },
    hours: { def: 730, ask: 'Only if the cluster runs part-time: how many hours a month are the servers running? Leave at 730 for always on. Storage is billed all month either way.' }
  },
  context: ['production', 'zoneResilience', 'steadyUsage'],
  examples: [
    { type: 'documentdb', tier: 'm30', storageGb: 128 },
    { type: 'documentdb', tier: 'm50', storageGb: 1024, shards: 3, highAvailability: true, commitment: 'ri1y', hours: 730 },
    { type: 'documentdb', tier: 'm200-autoscale', storageGb: 1024, commitment: 'sp1y' },
    { type: 'documentdb', tier: 'm20', storageGb: 64, highAvailability: false, hours: 300 }
  ],
  readback: c => {
    const t = TIERS[(c.tier || 'm30').toLowerCase()] || TIERS.m30;
    const shards = n(c.shards ?? 1), ha = haOf(c);
    const parts = [`${fmtN(shards)} server${shards === 1 ? '' : 's'} (shard${shards === 1 ? '' : 's'}) of tier ${t.label} (${t.vcores} vCPU${t.vcores === 1 ? '' : 's'}, ${t.mem})`,
      `${fmtN(c.storageGb)} GB storage per server`,
      ha ? 'high availability on (a standby for every server)' : 'high availability off'];
    const commit = c.commitment || 'payg';
    parts.push(({ ri1y: '1-year reservation', ri3y: '3-year reservation', sp1y: '1-year savings plan', sp3y: '3-year savings plan' })[commit] || `pay as you go, ${fmtN(c.hours ?? HOURS)} hours a month`);
    return `Azure DocumentDB: ${parts.join(', ')}`;
  },
  notIncluded: () => ['Data transfer out of the region and between regions (billed separately under bandwidth)'],
  price: async (c, ctx) => {
    const tierKey = (c.tier || 'm30').toLowerCase();
    const t = TIERS[tierKey];
    if (!t) throw new PricingError(`Unknown tier "${c.tier}". Use ${Object.keys(TIERS).join(', ')}.`);
    const shards = n(c.shards ?? 1), hours = c.hours ?? HOURS, ha = haOf(c);
    const commit = c.commitment || 'payg';
    const storageAsked = n(c.storageGb);
    if (!(storageAsked > 0)) throw new PricingError('storageGb is required: the GB of storage each server needs.');
    if (shards < 1) throw new PricingError('shards must be at least 1.');
    if (!['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y, ri3y, sp1y or sp3y.`);
    if (commit.startsWith('ri') && !t.ri) throw new PricingError(`Reservations are available for tiers m30 to m300, not ${t.label}; a savings plan (sp1y/sp3y) works for every paid tier.`);
    if (tierKey === 'free' && (shards !== 1 || ha || storageAsked > 32 || commit !== 'payg')) throw new PricingError('The free tier is one server with up to 32 GB, no high availability and no reservation or savings plan.');
    const storage = SIZES.find(s => s >= storageAsked);
    if (!storage) throw new PricingError(`Storage above ${fmtN(SIZES[SIZES.length - 1])} GB per server is not offered.`);
    const all = await rows(`serviceName eq 'Azure Cosmos DB' and productName eq 'Azure DocumentDB' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const G = 'Databases', S = 'Azure Cosmos DB', lines = [], notes = [];
    const copies = shards * (ha ? 2 : 1);
    const where = `${fmtN(shards)} server(s)${ha ? ' x 2 (primary + standby)' : ''}`;
    const facts = { tier: tierKey, vcoresPerNode: t.vcores, shards, highAvailability: ha, nodes: copies, storageGb: storage, hours, commitment: commit };
    const compute = all.filter(r => r.skuName === t.sku && r.meterName === 'vCore');
    if (!compute.length) throw new PricingError(`${t.label} is not priced in ${ctx.region}.`);
    const units = copies * (t.perVcore ? t.vcores : 1), unit = t.perVcore ? 'vCore hours' : 'hours';
    const desc = `Azure DocumentDB ${t.label} compute: ${where}${t.perVcore ? `, ${fmtN(t.vcores)} vCores each` : ''}`;
    if (commit === 'payg') {
      lines.push(meterLine(G, S, `${desc}, ${fmtN(hours)} hours`, compute, units * hours, ctx, { unit }));
    } else if (commit.startsWith('sp')) {
      const term = commit === 'sp1y' ? '1 Year' : '3 Years';
      const sp = (compute[0].savingsPlan || []).find(x => x.term === term);
      if (!sp) throw new PricingError(`No ${term} savings plan rate for ${t.label} in ${ctx.region}.`);
      lines.push(line(G, S, `${desc}, ${term} savings plan rate`, units * HOURS, unit, sp.unitPrice, sp.unitPrice * units * HOURS, meterInfo(compute[0])));
      notes.push(`${term} savings plan (savings plan for databases): the committed hourly rate is billed for every hour of the month, so the hours setting is ignored.`);
    } else {
      const term = commit === 'ri1y' ? '1 Year' : '3 Years';
      const res = await rows(`serviceName eq 'Azure Cosmos DB' and productName eq 'Azure DocumentDB Reservations' and ${regionFilter(ctx)} and priceType eq 'Reservation'`, ctx);
      const rr = res.find(r => r.reservationTerm === term);
      if (!rr) throw new PricingError(`No ${term} reservation price for Azure DocumentDB in ${ctx.region}.`);
      const months = termMonths(term);
      const monthly = rr.retailPrice / months;
      lines.push(line(G, S, `${desc.replace('compute:', `compute: ${term} reservation,`)}`, units, 'vCore reservation / month', monthly, monthly * units, meterInfo(rr), { termTotal: rr.retailPrice }));
      notes.push(`${term} reservation: ${rr.retailPrice} is the whole-term price per vCore, divided by ${months} months. It is billed whether or not the cluster runs, so the hours setting is ignored.`);
    }
    if (commit !== 'payg' && hours < HOURS) facts.commitmentUnderused = true;
    if (tierKey === 'm200-autoscale') notes.push('Autoscale scales between M80 and M200 by load (minimum price up to 35% utilization, maximum above it). This estimate is the maximum: 64 vCores all month.');
    const stMeter = tierKey === 'free' ? 'General Purpose Storage Free Data Stored' : 'General Purpose Storage Data Stored';
    const st = all.filter(r => r.meterName === stMeter);
    if (!st.length) throw new PricingError(`No storage price found in ${ctx.region}.`);
    lines.push(meterLine(G, S, `Storage: ${fmtN(storage)} GB per server x ${fmtN(copies)} server(s)${ha ? ' (standby copies included)' : ''}`, st, storage * copies, ctx, { unit: 'GB / month' }));
    if (storage !== storageAsked) notes.push(`Storage is provisioned in fixed sizes, so ${fmtN(storageAsked)} GB per server is priced as ${fmtN(storage)} GB.`);
    notes.push('Compute is billed per server (node) per hour. Backups are included at no extra charge (35-day retention, 7 days for burstable tiers).');
    if (ha) notes.push('High availability keeps a standby for every server with the same compute and storage, so both are doubled.');
    if (tierKey === 'free') notes.push('The free tier is limited to one cluster per subscription, 32 GB, in selected regions, and has no high availability.');
    return { lines, notes, facts };
  }
};
