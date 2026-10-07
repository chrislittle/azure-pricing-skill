'use strict';
// Azure Cache for Redis (Basic, Standard, Premium, Enterprise, Enterprise Flash) with 1- and 3-year reservations.
// Meters: serviceName 'Redis Cache', regional, one product per tier ('Azure Redis Cache Standard', ...).
// Basic/Standard/Premium list a price per NODE ("C3 Cache Instance") and, on some SKUs, a per-cache price that is
// the same money ("C3 Cache" = both nodes of a Standard cache). Enterprise meters are priced per capacity unit (data node): an Enterprise cache has at least 2 data nodes (x1 scale factor = capacity 2, up to x10) and Enterprise Flash at least 3 (x1 = capacity 3, or x3 = 9).
// The Enterprise software license (Redis IP, billed through Azure Marketplace) is a separate charge; only E1 has a Retail API meter.
// Azure Managed Redis (same service name, other products) is the separate `managed-redis` type.
const { rows, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);

const TIERS = {
  basic: { product: 'Azure Redis Cache Basic', label: 'Basic', sizes: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'], nodes: 1 },
  standard: { product: 'Azure Redis Cache Standard', label: 'Standard', sizes: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'], nodes: 2 },
  premium: { product: 'Azure Redis Cache Premium', label: 'Premium', sizes: ['p1', 'p2', 'p3', 'p4', 'p5'], nodes: 2 },
  enterprise: { product: 'Azure Redis Cache Enterprise', label: 'Enterprise', sizes: ['e1', 'e5', 'e10', 'e20', 'e50', 'e100', 'e200', 'e400'], dataNodes: 2, scales: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  'enterprise-flash': { product: 'Azure Redis Cache Enterprise Flash', label: 'Enterprise Flash', sizes: ['f300', 'f700', 'f1500'], dataNodes: 3, scales: [1, 3] }
};
const SIZE_GB = { c0: '250 MB', c1: '1 GB', c2: '2.5 GB', c3: '6 GB', c4: '13 GB', c5: '26 GB', c6: '53 GB',
  p1: '6 GB', p2: '13 GB', p3: '26 GB', p4: '53 GB', p5: '120 GB',
  e1: '1 GB', e5: '4 GB', e10: '12 GB', e20: '25 GB', e50: '50 GB', e100: '100 GB', e200: '200 GB', e400: '400 GB',
  f300: '384 GB', f700: '715 GB', f1500: '1.5 TB' };
const PREMIUM_GB = { p1: 6, p2: 13, p3: 26, p4: 53, p5: 120 };
const ALL_SIZES = [...new Set(Object.values(TIERS).flatMap(t => t.sizes))];

module.exports = {
  type: 'redis',
  label: 'Azure Cache for Redis',
  family: 'data-platform',
  calculator: ['redis-cache'],
  keywords: ['redis', 'cache', 'caching', 'session store', 'in-memory', 'azure cache for redis', 'leaderboard', 'fast lookup'],
  fields: {
    tier: { def: 'standard', enum: Object.keys(TIERS), ask: 'Is this a throwaway or test cache that can lose its data (basic, one server, no uptime guarantee), a normal production cache that survives a server failure (standard), one that also needs bigger sizes, saving data to disk, splitting across servers (clustering) or a private network (premium), or one that needs Redis search/JSON modules or active geo-replication (enterprise; enterprise-flash for very large caches on cheaper flash storage)? If unknown, suggest standard and record it as an assumption. Important: Azure Cache for Redis is being retired. Since 1 April 2026 new caches in the enterprise and enterprise-flash tiers cannot be created at all (remaining ones are migrated on 31 March 2027), and basic, standard and premium cannot be created by new customers (a tenant with no Azure Cache for Redis before 1 April 2026) and retire on 30 September 2028. New projects should look at the managed-redis type instead; use this type only for an existing cache or a migration estimate.' },
    size: { req: true, enum: ALL_SIZES, ask: 'How much data must the cache hold in memory? Basic/standard: 250 MB = c0, 1 GB = c1, 2.5 GB = c2, 6 GB = c3, 13 GB = c4, 26 GB = c5, 53 GB = c6. Premium: 6 GB = p1, 13 GB = p2, 26 GB = p3, 53 GB = p4, 120 GB = p5 (per shard). Enterprise: 1 GB = e1, 4 GB = e5, 12 GB = e10, 25 GB = e20, 50 GB = e50, 100 GB = e100, 200 GB = e200, 400 GB = e400. Enterprise Flash: 384 GB = f300, 715 GB = f700, 1.5 TB = f1500. Pick the next size up from what they need. If unknown, suggest c1 (basic/standard) and record it as an assumption.' },
    shards: { def: 1, int: true, min: 1, max: 30, ask: 'Premium only: does the data need to be split across several servers (clustering) for more memory or throughput? How many shards? Each shard is a full cache of the chosen size. Up to 10 is generally available; 11 to 30 is in preview (20 with two replicas, 15 with three). If not clustering, 1.' },
    replicasPerShard: { def: 1, int: true, min: 1, max: 3, ask: 'Premium only: how many copies (replicas) of each shard for extra resilience? 1 is the normal setup (a primary and one replica); up to 3 can be added at the price of one more server each.' },
    caches: { def: 1, int: true, min: 1, ask: 'How many separate caches of this size will be run in this region (for example separate environments)? For active geo-replication (enterprise) do not use this: add one redis component per region so each is priced at its own region rates.' },
    scaleFactor: { def: 1, int: true, min: 1, max: 10, ask: 'Enterprise and enterprise-flash only: how many times bigger than the base size (scale out) should the cache be for more memory and throughput? Enterprise can be scaled x1 to x10 (x1 = 2 data nodes, x10 = 20); enterprise-flash x1 or x3 (3 or 9 data nodes). E1 cannot scale out. If unsure, 1.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Pay as you go, or compare a 1- or 3-year reservation? Reservations exist for Premium, for Enterprise sizes e1, e10, e20, e50 and e100, and for all enterprise-flash sizes; they only pay off if the cache runs all month.' },
    hours: { def: 730, ask: 'Only if the cache runs part-time: how many hours a month is it running? Leave at 730 for always on.' }
  },
  context: ['production', 'zoneResilience', 'steadyUsage'],
  examples: [
    { type: 'redis', tier: 'standard', size: 'c1' },
    { type: 'redis', tier: 'premium', size: 'p2', shards: 3, replicasPerShard: 2, caches: 2, commitment: 'ri1y', hours: 730 },
    { type: 'redis', tier: 'enterprise', size: 'e10', scaleFactor: 2, commitment: 'ri3y' },
    { type: 'redis', tier: 'enterprise-flash', size: 'f300', caches: 2 },
    { type: 'redis', tier: 'basic', size: 'c0', hours: 200 }
  ],
  readback: c => {
    const tier = TIERS[(c.tier || 'standard').toLowerCase()] || TIERS.standard;
    const size = String(c.size || '').toLowerCase();
    const caches = n(c.caches ?? 1), shards = n(c.shards ?? 1), replicas = n(c.replicasPerShard ?? 1), scale = n(c.scaleFactor ?? 1);
    const parts = [`${fmtN(caches)} cache${caches === 1 ? '' : 's'} of size ${size.toUpperCase()} (${SIZE_GB[size] || 'memory size per list'})`];
    if (tier.label === 'Standard') parts.push('each with a primary and a replica server');
    if (tier.label === 'Premium') parts.push(`${fmtN(shards)} shard${shards === 1 ? '' : 's'}, each with a primary plus ${fmtN(replicas)} replica${replicas === 1 ? '' : 's'} (about ${fmtN((PREMIUM_GB[size] || 0) * shards)} GB of data in total per cache)`);
    if (tier.dataNodes) parts.push(`scale factor x${fmtN(scale)} (${fmtN(tier.dataNodes * scale)} data nodes per cache)`);
    const commit = c.commitment || 'payg';
    parts.push(commit === 'ri1y' ? '1-year reservation' : commit === 'ri3y' ? '3-year reservation' : `pay as you go, ${fmtN(c.hours ?? HOURS)} hours a month`);
    return `Azure Cache for Redis ${tier.label}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => {
    const comps = (spec.options || []).flatMap(o => o.components || []).filter(c => c.type === 'redis');
    const tierOf = c => String(c.tier || 'standard').toLowerCase();
    const out = ['Data transfer out of the region and between regions or zones (billed separately under bandwidth)'];
    if (comps.some(c => tierOf(c) === 'premium')) out.push('The storage account for data persistence (Premium)');
    if (comps.some(c => tierOf(c).startsWith('enterprise'))) out.push('A cache in each extra region for active geo-replication, which must be priced as its own component at that region\'s rates');
    if (comps.some(c => ['enterprise', 'enterprise-flash'].includes(String(c.tier || '').toLowerCase()) && !(String(c.tier).toLowerCase() === 'enterprise' && String(c.size).toLowerCase() === 'e1'))) out.push('The Redis Enterprise software license (billed through Azure Marketplace, on top of the infrastructure price shown, and a large extra charge: the Retail Prices API has no price for it, so check the Azure pricing calculator)');
    return out;
  },  price: async (c, ctx) => {
    const tierKey = (c.tier || 'standard').toLowerCase();
    const tier = TIERS[tierKey];
    if (!tier) throw new PricingError(`Unknown tier "${c.tier}". Use ${Object.keys(TIERS).join(', ')}.`);
    const size = String(c.size || '').toLowerCase();
    if (!tier.sizes.includes(size)) throw new PricingError(`Size "${c.size}" is not offered in the ${tier.label} tier. Use ${tier.sizes.join(', ')}.`);
    const SKU = size.toUpperCase();
    const caches = n(c.caches ?? 1), shards = n(c.shards ?? 1), replicas = n(c.replicasPerShard ?? 1), scale = n(c.scaleFactor ?? 1);
    const hours = c.hours ?? HOURS;
    const commit = c.commitment || 'payg';
    if (!['payg', 'ri1y', 'ri3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y or ri3y.`);
    if (tierKey !== 'premium' && (shards !== 1 || replicas !== 1)) throw new PricingError(`Clustering (shards) and extra replicas are Premium features. For ${tier.label} choose a bigger size instead.`);
    const shardMax = replicas >= 3 ? 15 : replicas === 2 ? 20 : 30;
    if (tierKey === 'premium' && shards > shardMax) throw new PricingError(`Premium with ${replicas} replica(s) per shard supports up to ${shardMax} shards (up to 10 is generally available, more is in preview).`);
    if (!tier.dataNodes && scale !== 1) throw new PricingError(`Scale out with scaleFactor is only for Enterprise and Enterprise Flash; for ${tier.label} use clustering (Premium) or a bigger size.`);
    if (tier.dataNodes && !tier.scales.includes(scale)) throw new PricingError(`The ${tier.label} scale factor must be ${tier.scales.join(', ')}.`);
    if (size === 'e1' && scale !== 1) throw new PricingError('E1 cannot scale out; use a bigger size.');
    if (tierKey === 'premium' && (replicas < 1 || replicas > 3)) throw new PricingError('Premium supports 1 to 3 replicas per shard.');
    const G = 'Databases', S = 'Redis Cache';
    const all = await rows(`serviceName eq 'Redis Cache' and productName eq '${tier.product}' and ${regionFilter(ctx)} and skuName eq '${SKU}'`, ctx);
    const pg = all.filter(r => r.type === 'Consumption');
    if (!pg.length) throw new PricingError(`${tier.label} ${SKU} is not priced in ${ctx.region}.`);
    const lines = [], notes = [];
    // Basic/Standard/Premium: nodes per cache. Enterprise: the meter is per data node (capacity unit), see TIERS.dataNodes.
    const perCacheNodes = tierKey === 'premium' ? shards * (1 + replicas) : tier.dataNodes ? tier.dataNodes * scale : tier.nodes || 1;
    const facts = { tier: tierKey, size, shards, replicasPerShard: replicas, caches, scaleFactor: scale, nodes: perCacheNodes * caches, hours, commitment: commit };
    const instance = pg.filter(r => r.meterName === `${SKU} Cache Instance`);
    const whole = pg.filter(r => r.meterName === `${SKU} Cache`);
    // Per-node meter when it exists; otherwise the per-cache meter, which already covers 2 nodes (Standard, Premium) or 1 (Basic).
    const nodeRows = instance.length ? instance : whole;
    const nodesPerMeterUnit = instance.length ? 1 : (tier.nodes || 1);
    if (!nodeRows.length) throw new PricingError(`No ${tier.label} ${SKU} price found in ${ctx.region}.`);
    if (commit === 'payg') {
      const qty = perCacheNodes * caches * hours / nodesPerMeterUnit;
      const what = tierKey === 'premium'
        ? `${fmtN(caches)} cache(s) x ${fmtN(shards)} shard(s) x ${fmtN(1 + replicas)} servers (primary + ${fmtN(replicas)} replica)`
        : tier.dataNodes ? `${fmtN(caches)} cache(s) x ${fmtN(tier.dataNodes * scale)} data nodes (scale factor x${fmtN(scale)})` : tier.nodes === 2 ? `${fmtN(caches)} cache(s) x 2 servers (primary + replica)` : `${fmtN(caches)} cache(s)`;
      lines.push(meterLine(G, S, `Azure Cache for Redis ${tier.label} ${SKU} (${SIZE_GB[size]}): ${what}, ${fmtN(hours)} hours`, nodeRows, qty, ctx, { unit: 'hours' }));
      if (perCacheNodes * caches > 1 && tierKey !== 'enterprise' && tierKey !== 'enterprise-flash') {
        notes.push(`${tier.label} is billed per server (node) per hour: ${fmtN(perCacheNodes * caches)} servers in total.`);
      }
    } else {
      const term = commit === 'ri1y' ? '1 Year' : '3 Years';
      const res = all.filter(r => r.type === 'Reservation' && r.reservationTerm === term);
      const rr = res.find(r => r.meterName === `${SKU} Cache Instance`) || res.find(r => r.meterName === `${SKU} Cache`) || res[0];
      if (!rr) throw new PricingError(`${tier.label} ${SKU} has no ${term} reservation price in ${ctx.region}. Reservations exist only for Premium, Enterprise sizes e1, e10, e20, e50 and e100, and all Enterprise Flash sizes.`);
      const months = termMonths(term);
      const monthly = rr.retailPrice / months;
      // Premium reservations are per server; Enterprise reservations are per data node (capacity unit).
      const units = perCacheNodes * caches;
      lines.push(line(G, S, `Azure Cache for Redis ${tier.label} ${SKU} (${SIZE_GB[size]}): ${term} reservation, ${fmtN(units)} reserved ${tierKey === 'premium' ? 'server(s)' : 'data node(s)'}`, units, 'reservation / month', monthly, monthly * units, meterInfo(rr), { termTotal: rr.retailPrice }));
      notes.push(`${term} reservation: ${rr.retailPrice} is the whole-term price per ${tierKey === 'premium' ? 'server' : 'data node'}, divided by ${months} months. It is billed whether or not the cache runs, so the hours setting is ignored.`);
      if (hours < HOURS) facts.commitmentUnderused = true;
    }
    if (tierKey === 'basic') notes.push('Basic is a single server with no replica and no uptime guarantee.');
    if (tier.dataNodes) {
      notes.push(`${tier.label} is billed per data node (capacity unit): ${fmtN(tier.dataNodes)} data nodes at scale factor x1, ${fmtN(perCacheNodes)} here per cache. The extra quorum node is not charged. Modules and active geo-replication are included, so each geo-replicated cache is another full price in its own region.`);
      if (size === 'e1') {
        const swH = commit === 'payg' ? hours : HOURS;
        const sw = await rows(`serviceName eq 'Redis Cache' and productName eq '${tier.product}' and ${regionFilter(ctx)} and skuName eq 'E1 Internal' and priceType eq 'Consumption'`, ctx);
        if (sw.length) lines.push(meterLine(G, S, `Redis Enterprise E1 software license: ${fmtN(caches)} cache(s), ${fmtN(swH)} hours`, sw, caches * swH, ctx, { unit: 'hours' }));
        else notes.push('The Redis Enterprise software license (Azure Marketplace) has no price in the price list for this region, so it is not included.');
      } else {
        facts.softwareLicenseNotPriced = true;
        notes.push('NOT INCLUDED: the Redis Enterprise software license, which is billed through Azure Marketplace on top of the infrastructure price above and is a large extra charge. The Retail Prices API has no price for it, so look it up in the Azure pricing calculator and add it; the real total is much higher than this estimate.');
      }
      if (commit !== 'payg') notes.push('The software license is pay as you go only; reservations cover the infrastructure part.');
      notes.push('Azure Cache for Redis Enterprise tiers can no longer be created (blocked since 1 April 2026; remaining caches are migrated to Azure Managed Redis on 31 March 2027). Use the managed-redis type for a new design.');
    }
    return { lines, notes, facts };
  }
};
