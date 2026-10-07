'use strict';
// Azure Managed Redis (Memory Optimized M, Balanced B, Compute Optimized X, Flash Optimized A) with 1- and 3-year reservations.
// Meters: serviceName 'Redis Cache', regional, one product per tier ('Azure Managed Redis - Balanced', ...).
// The meter ("B5 Cache Instance") is the price of ONE node per hour; a high-availability cache runs two nodes and a
// cache without high availability runs one (Azure Managed Redis pricing page). Reservations are also priced per node.
const { rows, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);

const TIERS = {
  'memory-optimized': { product: 'Azure Managed Redis - Memory Optimized', label: 'Memory Optimized', gb: { m10: 12, m20: 24, m50: 60, m100: 120, m150: 175, m250: 235, m350: 360, m500: 480, m700: 720, m1000: 960, m1500: 1440, m2000: 1920 } },
  balanced: { product: 'Azure Managed Redis - Balanced', label: 'Balanced', gb: { b0: 0.5, b1: 1, b3: 3, b5: 6, b10: 12, b20: 24, b50: 60, b100: 120, b150: 175, b250: 235, b350: 360, b500: 480, b700: 720, b1000: 960 } },
  'compute-optimized': { product: 'Azure Managed Redis - Compute Optimized', label: 'Compute Optimized', gb: { x3: 3, x5: 6, x10: 12, x20: 24, x50: 60, x100: 120, x150: 175, x250: 235, x350: 360, x500: 480, x700: 720 } },
  'flash-optimized': { product: 'Azure Managed Redis - Flash Optimized', label: 'Flash Optimized', gb: { a250: 256, a500: 525, a700: 787, a1000: 1050, a1500: 1574, a2000: 2099, a4500: 4723 } }
};
const ALL_SIZES = [...new Set(Object.values(TIERS).flatMap(t => Object.keys(t.gb)))];

module.exports = {
  type: 'managed-redis',
  label: 'Azure Managed Redis',
  family: 'data-platform',
  calculator: ['managed-redis'],
  keywords: ['redis', 'cache', 'caching', 'managed redis', 'in-memory', 'session store', 'vector search', 'azure managed redis'],
  fields: {
    tier: { def: 'balanced', enum: Object.keys(TIERS), ask: 'What matters most? A normal mix of memory and processing power for most apps -> balanced; lots of data in memory per processor (big caches, analytics) -> memory-optimized; maximum speed and throughput for busy or mission-critical apps -> compute-optimized; very large data sets where slightly slower access is fine for a much lower cost per GB (data kept partly on fast flash disks) -> flash-optimized. If unknown, suggest balanced and record it as an assumption.' },
    size: { req: true, enum: ALL_SIZES, ask: 'How much data must the cache hold? Pick the next size up. Balanced: b0 = 0.5 GB, b1 = 1 GB, b3 = 3 GB, b5 = 6 GB, b10 = 12 GB, b20 = 24 GB, b50 = 60 GB, b100 = 120 GB, b150 = 175 GB, b250 = 235 GB (bigger: b350, b500, b700, b1000). Memory-optimized: m10 = 12 GB, m20 = 24 GB, m50 = 60 GB, m100 = 120 GB, m150 = 175 GB, m250 = 235 GB (bigger: m350 to m2000). Compute-optimized: x3 = 3 GB, x5 = 6 GB, x10 = 12 GB, x20 = 24 GB, x50 = 60 GB, x100 = 120 GB, x150 = 175 GB, x250 = 235 GB (bigger: x350 to x700). Flash-optimized: a250 = 256 GB, a500 = 525 GB, a700 = 787 GB, a1000 = 1 TB, a1500, a2000, a4500. If unknown, suggest b5 and record it as an assumption.' },
    highAvailability: { def: true, ask: 'Is this production (or anything that must stay up if a server fails)? Then keep high availability on, which runs two servers and doubles the compute price. Switch it off only for a throwaway development or test cache that may lose data.' },
    caches: { def: 1, int: true, min: 1, ask: 'How many caches of this size? Add one for each extra region when using active geo-replication (a group of linked caches) and for separate environments. Flash-optimized and the smallest balanced sizes (b0, b1) cannot use active geo-replication. Traffic between linked caches is currently not charged.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Pay as you go, or compare a 1- or 3-year reservation (a discount for committing)? Only worth it if it runs all month. Not every size has a reservation price in every region.' },
    hours: { def: 730, ask: 'Only if the cache runs part-time: how many hours a month is it running? Leave at 730 for always on.' }
  },
  context: ['production', 'zoneResilience', 'steadyUsage'],
  examples: [
    { type: 'managed-redis', size: 'b5' },
    { type: 'managed-redis', tier: 'memory-optimized', size: 'm150', highAvailability: true, caches: 2, commitment: 'ri1y' },
    { type: 'managed-redis', tier: 'compute-optimized', size: 'x10', highAvailability: false, hours: 300 },
    { type: 'managed-redis', tier: 'flash-optimized', size: 'a250', caches: 3 }
  ],
  readback: c => {
    const tier = TIERS[(c.tier || 'balanced').toLowerCase()] || TIERS.balanced;
    const size = String(c.size || '').toLowerCase();
    const caches = n(c.caches ?? 1);
    const ha = c.highAvailability !== false;
    const commit = c.commitment || 'payg';
    const parts = [`${fmtN(caches)} cache${caches > 1 ? 's' : ''} of size ${size.toUpperCase()} (about ${fmtN(tier.gb[size] || 0)} GB)`,
      ha ? 'high availability on (two servers each)' : 'high availability off (one server each, data can be lost)'];
    parts.push(commit === 'ri1y' ? '1-year reservation' : commit === 'ri3y' ? '3-year reservation' : `pay as you go, ${fmtN(c.hours ?? HOURS)} hours a month`);
    return `Azure Managed Redis ${tier.label}: ${parts.join(', ')}`;
  },
  notIncluded: () => ['Data transfer out to the internet or to other Azure services (geo-replication traffic between caches is currently not charged)'],
  price: async (c, ctx) => {
    const tierKey = (c.tier || 'balanced').toLowerCase();
    const tier = TIERS[tierKey];
    if (!tier) throw new PricingError(`Unknown tier "${c.tier}". Use ${Object.keys(TIERS).join(', ')}.`);
    const size = String(c.size || '').toLowerCase();
    if (!tier.gb[size]) throw new PricingError(`Size "${c.size}" is not in the ${tier.label} tier. Use ${Object.keys(tier.gb).join(', ')}.`);
    const SKU = size.toUpperCase();
    const caches = n(c.caches ?? 1), hours = c.hours ?? HOURS, ha = c.highAvailability !== false;
    const commit = c.commitment || 'payg';
    if (!['payg', 'ri1y', 'ri3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y or ri3y.`);
    const nodes = (ha ? 2 : 1) * caches;
    const all = await rows(`serviceName eq 'Redis Cache' and productName eq '${tier.product}' and ${regionFilter(ctx)} and skuName eq '${SKU}'`, ctx);
    const pg = all.filter(r => r.type === 'Consumption');
    if (!pg.length) throw new PricingError(`Azure Managed Redis ${tier.label} ${SKU} is not priced in ${ctx.region}.`);
    const G = 'Databases', S = 'Redis Cache';
    const label = `Azure Managed Redis ${tier.label} ${SKU} (about ${fmtN(tier.gb[size])} GB)`;
    const what = `${fmtN(caches)} cache(s) x ${ha ? '2 servers (high availability)' : '1 server (no high availability)'}`;
    const lines = [], notes = [];
    const reservable = all.some(r => r.type === 'Reservation' && r.reservationTerm === '1 Year');
    const facts = { tier: tierKey, size, highAvailability: ha, caches, nodes, hours, commitment: commit, reservable };
    if (commit === 'payg') {
      lines.push(meterLine(G, S, `${label}: ${what}, ${fmtN(hours)} hours`, pg, nodes * hours, ctx, { unit: 'hours' }));
    } else {
      if (!ha) notes.push('Reservations are bought per server; this estimate reserves one server per cache because high availability is off.');
      const term = commit === 'ri1y' ? '1 Year' : '3 Years';
      const rr = all.find(r => r.type === 'Reservation' && r.reservationTerm === term);
      if (!rr) throw new PricingError(`${tier.label} ${SKU} has no ${term} reservation price in ${ctx.region}. Reservation prices exist only for some sizes in some regions (the smaller Memory Optimized sizes are in few regions); use pay as you go, another size or another region.`);
      const months = termMonths(term);
      const monthly = rr.retailPrice / months;
      lines.push(line(G, S, `${label}: ${term} reservation, ${fmtN(nodes)} reserved server(s) (${what})`, nodes, 'reservation / month', monthly, monthly * nodes, meterInfo(rr), { termTotal: rr.retailPrice }));
      notes.push(`${term} reservation: ${rr.retailPrice} is the whole-term price per server, divided by ${months} months. It is billed whether or not the cache runs, so the hours setting is ignored.`);
      if (hours < HOURS) facts.commitmentUnderused = true;
    }
    notes.push('Azure Managed Redis is billed per server (node) per hour. High availability runs two servers per cache, so it doubles the compute price. The public IP address that Enterprise-class caches need is currently free of charge.');
    if (tierKey === 'flash-optimized' && commit !== 'payg') notes.push('Flash Optimized reservation prices come from the Azure pricing calculator and price list, but the Learn reservation page lists Flash Optimized as not reservable; confirm availability before buying.');
    return { lines, notes, facts };
  }
};
