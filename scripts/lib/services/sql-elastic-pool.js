'use strict';
// Azure SQL Database elastic pools: vCore (General Purpose, Business Critical, Hyperscale) and eDTU (Basic, Standard, Premium).
// Meters: serviceName 'SQL Database'. vCore compute 'SQL Database Single/Elastic Pool <tier> - <hardware>' per vCore-hour,
// the SQL Server license as a separate Global meter, storage and backup products, and reservations (whole-term price per vCore).
// eDTU pools bill a price per pool per day for the pool size ("N DTU Pack").
const { rows, single, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

const VCORE_TIERS = { 'general-purpose': 'General Purpose', 'business-critical': 'Business Critical', hyperscale: 'Hyperscale' };
const DTU_TIERS = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };

// Hardware: Retail product per tier, and the pool sizes (vCores) the calculator offers.
const HW = {
  'standard-series': { label: 'standard-series (Gen5)',
    gp: { p: 'SQL Database Single/Elastic Pool General Purpose - Compute Gen5', sizes: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80, 128] },
    bc: { p: 'SQL Database Single/Elastic Pool Business Critical - Compute Gen5', sizes: [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80, 128] },
    hs: { p: 'SQL Database SingleDB/Elastic Pool Hyperscale - Compute Gen5', sizes: [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 80] } },
  'premium-series': { label: 'premium-series',
    hs: { p: 'SQL Database Single/Elastic Pool Hyperscale - Premium Series Compute', sizes: [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 64, 80, 128, 160, 192] } },
  'premium-series-memory-optimized': { label: 'premium-series memory optimized',
    hs: { p: 'SQL Database Single/Elastic Pool Hyperscale - Premium Series Memory Optimized Compute', sizes: [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32, 40, 64, 80] } },
  'dc-series': { label: 'DC-series (confidential)',
    gp: { p: 'SQL Database Single/Elastic Pool General Purpose - Compute DC-Series', sizes: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 32, 40], noReservation: true },
    bc: { p: 'SQL Database Single/Elastic Pool Business Critical - Compute DC-Series', sizes: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 32, 40], noReservation: true } },
  fsv2: { label: 'Fsv2-series',
    gp: { p: 'SQL Database Single/Elastic Pool General Purpose - Compute FSv2 Series', sizes: [8, 10, 12, 14, 16, 18, 20, 24, 32, 36, 72], noReservation: true } }
};
const TIER_KEY = { 'general-purpose': 'gp', 'business-critical': 'bc', hyperscale: 'hs' };

// eDTU pools: [GB included, largest size in GB, databases allowed per pool], from the calculator's elastic pool offers.
const EDTU = {
  basic: { 50: [5, 5, 100], 100: [10, 10, 200], 200: [20, 20, 500], 300: [29, 29, 500], 400: [39, 39, 500], 800: [78, 78, 500], 1200: [117, 117, 500], 1600: [156, 156, 500] },
  standard: { 50: [50, 500, 100], 100: [100, 750, 200], 200: [200, 1024, 500], 300: [300, 1280, 500], 400: [400, 1536, 500], 800: [800, 2048, 500], 1200: [1200, 2560, 500], 1600: [1600, 3072, 500], 2000: [2000, 3584, 500], 2500: [2500, 4096, 500], 3000: [3000, 4096, 500] },
  premium: { 125: [250, 1024, 50], 250: [500, 1024, 100], 500: [750, 1024, 100], 1000: [1024, 1024, 100], 1500: [1536, 1536, 100], 2000: [2048, 2048, 100], 2500: [2560, 2560, 100], 3000: [3072, 3072, 100], 3500: [3584, 3584, 100], 4000: [4096, 4096, 100] }
};

const RED = { LRS: 'LRS', ZRS: 'ZRS', GRS: 'RA-GRS', GZRS: 'RA-GZRS' };
const ALL_TIERS = [...Object.keys(VCORE_TIERS), ...Object.keys(DTU_TIERS)];

async function licenseRow(product, ctx) {
  for (const region of /^usgov/.test(ctx.region) ? ['US Gov', 'Global'] : ['Global']) {
    const rs = (await rows(`productName eq '${product}' and armRegionName eq '${region}' and priceType eq 'Consumption'`, ctx)).filter(r => r.meterName === 'vCore');
    if (rs.length) return single(rs, product)[0];
  }
  throw new PricingError(`${product} is not priced in ${ctx.region}.`);
}

// Savings plan for databases price (per vCore-hour) carried on the same Retail row.
function spPrice(row, term, what, ctx) {
  const p = (row.savingsPlan || []).find(x => x.term === term);
  if (!p) throw new PricingError(`${what} has no ${term} savings plan price in ${ctx.region}; use payg, a reservation (ri1y, ri3y) where available, or another savings plan term.`);
  return p.unitPrice;
}

module.exports = {
  type: 'sql-elastic-pool',
  label: 'Azure SQL Database elastic pool (vCore and eDTU)',
  family: 'databases',
  calculator: ['azure-sql-database'],
  keywords: ['elastic pool', 'sql elastic pool', 'sql pool', 'shared database resources', 'multi-tenant database', 'saas database', 'many databases', 'edtu', 'pool of databases', 'hyperscale elastic pool', 'sql database pool'],
  fields: {
    tier: { def: 'general-purpose', enum: ALL_TIERS, ask: 'What kind of workload are the databases for? Most new pools use general-purpose (balanced, remote storage), business-critical (low latency, local SSD, built-in readable replica), or hyperscale (very large data, fast scaling). basic, standard and premium are the older eDTU model. If unknown, assume general-purpose and record it as an assumption.' },
    poolSize: { req: true, int: true, min: 2, ask: 'How big should the pool be? For general-purpose, business-critical or hyperscale this is the number of vCores shared by all databases (e.g. 4, 8, 16, 32). For basic/standard/premium it is the pool eDTU size (e.g. standard 100, 200, 400). If they cannot say: a dozen small databases with light use usually fit 4 vCores; suggest that and record it as an assumption.' },
    pools: { def: 1, int: true, min: 1, ask: 'How many separate pools of this size? (Use 1 unless the databases are split across several pools, e.g. one per region or customer group.)' },
    databases: { def: 0, int: true, min: 0, ask: 'Roughly how many databases will share each pool? (Used to check the pool limit and to see whether pooling pays off. 0 if unknown.)' },
    hardware: { def: 'standard-series', enum: Object.keys(HW), ask: 'Does the workload need confidential computing (dc-series), more CPU per memory (fsv2, general-purpose only) or the newer hyperscale hardware (premium-series, premium-series-memory-optimized)? Otherwise use standard-series.' },
    storageGb: { def: 32, min: 0, ask: 'How much data will each pool hold in total, in GB? (Billed per GB of storage you configure or use; ignored for eDTU pools.) If unknown, assume 100 GB per pool and record it as an assumption.' },
    extraStorageGb: { def: 0, min: 0, ask: 'Only for basic/standard/premium (eDTU) pools: do the databases need more space than the pool includes? How many extra GB per pool? Use 0 if unknown.' },
    zoneRedundant: { def: false, bool: true, ask: 'Does the pool need to survive the loss of one datacenter zone (zone redundancy)? Yes means a zone-redundant pool. For Hyperscale, ask about replicas instead.' },
    haReplicas: { def: 0, int: true, min: 0, max: 4, ask: 'Hyperscale only: how many high-availability replicas for the pool (0 to 4)? Each one bills the same compute as the primary pool.' },
    ahb: { def: false, bool: true, ask: 'General Purpose and Business Critical only: does the customer own SQL Server licenses with Software Assurance (Azure Hybrid Benefit)? If yes, the SQL license charge is removed. Hyperscale pools have no SQL license charge, and eDTU pools cannot use it.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Will the pool run steadily for a year or more? Pay-as-you-go is the default. A 1- or 3-year reservation (ri1y, ri3y) is cheaper for vCore pools that stay up; an Azure savings plan for databases (sp1y, sp3y) is an hourly spend commitment that also covers compute and the SQL license and is more flexible across services. DTU pools can use neither.' },
    backupStorageGb: { def: 0, min: 0, ask: 'How much point-in-time backup storage in total, across the pool? Leave 0 if unknown: backup up to 100% of provisioned storage is free for General Purpose and Business Critical.' },
    backupRedundancy: { def: 'GRS', enum: ['LRS', 'ZRS', 'GRS', 'GZRS'], ask: 'Backup copies kept in one zone/datacenter (LRS), across zones (ZRS), in a paired region (GRS, the default) or both (GZRS)?' },
    ltrStorageGb: { def: 0, min: 0, ask: 'Do they need long-term retention backups (weeks to years)? How many GB in total? Use 0 if not.' },
    hours: { def: 730, ask: 'Does the pool run all month (730 hours) or only part of it? A pool bills for every hour it exists.' }
  },
  context: ['production', 'steadyUsage'],
  examples: [
    { type: 'sql-elastic-pool', tier: 'general-purpose', poolSize: 4, storageGb: 200, databases: 20 },
    { type: 'sql-elastic-pool', tier: 'business-critical', poolSize: 8, zoneRedundant: true, storageGb: 500, commitment: 'ri1y', ahb: true, backupStorageGb: 700, backupRedundancy: 'GRS', ltrStorageGb: 300 },
    { type: 'sql-elastic-pool', tier: 'hyperscale', poolSize: 8, haReplicas: 1, storageGb: 1000, backupStorageGb: 600, backupRedundancy: 'ZRS', hours: 730 },
    { type: 'sql-elastic-pool', tier: 'standard', poolSize: 200, extraStorageGb: 300, pools: 2, databases: 50 }
  ],
  readback: c => {
    const tier = c.tier || 'general-purpose', pools = n(c.pools) || 1, hrs = c.hours ?? HOURS;
    const dtu = !!DTU_TIERS[tier];
    const size = dtu ? `${fmtN(c.poolSize)} eDTUs` : `${fmtN(c.poolSize)} vCores`;
    const hw = !dtu && c.hardware && c.hardware !== 'standard-series' ? `, ${(HW[c.hardware] || {}).label || c.hardware}` : '';
    return `${fmtN(pools)} Azure SQL elastic pool(s), ${(VCORE_TIERS[tier] || DTU_TIERS[tier] || tier)}, ${size} each${hw}` +
      `${c.zoneRedundant ? ', zone-redundant' : ''}${c.haReplicas ? `, ${c.haReplicas} HA replica(s)` : ''}` +
      `${!dtu && c.commitment && c.commitment !== 'payg' ? `, ${c.commitment.endsWith('1y') ? '1-year' : '3-year'} ${c.commitment.startsWith('sp') ? 'savings plan' : 'reservation'}` : ''}${!dtu && c.ahb ? ', Azure Hybrid Benefit' : ''}` +
      `${n(c.databases) ? `, about ${fmtN(c.databases)} database(s) per pool` : ''}, ${hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month`}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Hyperscale IO operation charges, geo-replicas and failover group secondaries, named replicas, M-series Business Critical pools, and dev/test reservations are not in this estimate.'],
  price: async (c, ctx) => {
    const tier = String(c.tier || 'general-purpose').toLowerCase();
    if (!ALL_TIERS.includes(tier)) throw new PricingError(`Unknown tier "${c.tier}". Use ${ALL_TIERS.join(', ')}.`);
    const size = n(c.poolSize), pools = n(c.pools) || 1, hours = c.hours ?? HOURS, dbs = n(c.databases);
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const commit = String(c.commitment || 'payg').toLowerCase();
    if (!['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'].includes(commit)) throw new PricingError(`Unknown commitment "${c.commitment}". Use payg, ri1y, ri3y, sp1y or sp3y.`);
    const lines = [], notes = [];
    const group = 'Database', svc = 'SQL Database';

    if (DTU_TIERS[tier]) {
      const T = DTU_TIERS[tier], tbl = EDTU[tier], row = tbl[size];
      if (!row) throw new PricingError(`${T} elastic pools come in ${Object.keys(tbl).join(', ')} eDTUs; ${size} is not offered.`);
      if (commit !== 'payg') throw new PricingError('Reserved capacity and savings plans are only available for vCore pools, not eDTU pools (basic, standard, premium).');
      if (c.zoneRedundant || n(c.haReplicas) || c.ahb) throw new PricingError('Zone redundancy, HA replicas and Azure Hybrid Benefit apply to vCore pools only.');
      if (dbs > row[2]) throw new PricingError(`A ${T} ${size}-eDTU pool holds at most ${fmtN(row[2])} databases; ${fmtN(dbs)} requested. Use more pools or a larger size.`);
      const extra = n(c.extraStorageGb);
      if (extra && row[1] <= row[0]) throw new PricingError(`A ${T} ${size}-eDTU pool has no extra storage option: its ${fmtN(row[0])} GB is the maximum.`);
      if (extra && row[0] + extra > row[1]) throw new PricingError(`A ${T} ${size}-eDTU pool allows at most ${fmtN(row[1])} GB (${fmtN(row[0])} GB included + up to ${fmtN(row[1] - row[0])} GB extra).`);
      const rs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database Elastic Pool - ${T}' and skuName eq '${size} DTU Pack' and priceType eq 'Consumption'`, ctx);
      if (!rs.length) throw new PricingError(`${T} ${size}-eDTU elastic pools are not priced in ${ctx.region}.`);
      const m = single(rs, `${T} ${size} eDTU pool`);
      lines.push(meterLine(group, svc, `${T} elastic pool, ${fmtN(size)} eDTUs (${fmtN(row[0])} GB included), ${fmtN(pools)} pool(s) x ${fmtN(hours)} hours`, m, pools * hours / 24, ctx, { unit: 'pool-days' }));
      if (extra) {
        const srs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database ${T} - Storage' and priceType eq 'Consumption'`, ctx);
        const st = single(srs.filter(r => r.meterName === 'Data Stored'), `${T} extra storage`);
        lines.push(meterLine(group, svc, `Extra storage, ${fmtN(extra)} GB x ${fmtN(pools)} pool(s)`, st, extra * pools, ctx, { unit: 'GB / month' }));
      }
      notes.push(`The ${T} ${fmtN(size)}-eDTU price covers the pool's eDTUs and ${fmtN(row[0])} GB of storage, shared by up to ${fmtN(row[2])} databases. The Retail meter is a price per pool per day, divided by 24 for each hour the pool exists.`,
        'eDTU pools cannot use reservations or Azure Hybrid Benefit; those apply to the vCore model only.');
      return { lines, notes, facts: { model: 'edtu', tier, poolSize: size, pools, databases: dbs, commitment: 'payg', hours, extraStorageGb: extra, ahb: false, zoneRedundant: false, storageGb: row[0] } };
    }

    // vCore pools
    const T = VCORE_TIERS[tier], tk = TIER_KEY[tier], hs = tier === 'hyperscale', bc = tier === 'business-critical';
    const hwKey = String(c.hardware || 'standard-series').toLowerCase(), hw = HW[hwKey];
    if (!hw) throw new PricingError(`Unknown hardware "${c.hardware}". Use ${Object.keys(HW).join(', ')}.`);
    const H = hw[tk];
    if (!H) throw new PricingError(`Hardware "${hwKey}" is not offered for ${T} elastic pools.`);
    if (!H.sizes.includes(size)) throw new PricingError(`${T} ${hw.label} elastic pools come in ${H.sizes.join(', ')} vCores; ${size} is not offered.`);
    const replicas = n(c.haReplicas), zr = !!c.zoneRedundant, ahb = !!c.ahb;
    if (hs && ahb) throw new PricingError('Azure Hybrid Benefit does not apply to Hyperscale elastic pools: Hyperscale has no SQL license charge, only a shared resource management charge that Azure Hybrid Benefit does not remove. Set ahb to false.');
    if (hs && n(c.storageGb) > 102400) throw new PricingError('A Hyperscale elastic pool holds at most 100 TB (102,400 GB).');
    if (replicas && !hs) throw new PricingError('haReplicas applies to Hyperscale pools only.');
    if (hs && zr) throw new PricingError('Hyperscale zone redundancy is configured with HA replicas, which bill as compute; set haReplicas instead of zoneRedundant.');
    if (zr && hwKey !== 'standard-series') throw new PricingError('Zone redundancy is priced for standard-series (Gen5) pools only.');
    if ((commit === 'ri1y' || commit === 'ri3y') && H.noReservation) throw new PricingError(`${hw.label} pools have no reservation price; use commitment payg.`);
    const sp = commit.startsWith('sp'), ri = commit.startsWith('ri');
    const gb = n(c.storageGb), copies = 1 + replicas, term = commit.endsWith('1y') ? '1 Year' : '3 Years', months = commit.endsWith('1y') ? 12 : 36;
    const tag = ri ? `, ${term.toLowerCase()} reserved capacity` : sp ? `, ${term.toLowerCase()} savings plan` : '';
    const hwText = hwKey === 'standard-series' ? 'Gen5' : hw.label;
    const replText = hs ? (replicas ? `, primary + ${replicas} HA replica(s)` : ', primary only (no HA replica)') : '';

    const rs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${H.p}' and priceType eq 'Consumption'`, ctx);
    const perV = rs.find(r => r.skuName === 'vCore' && r.meterName === 'vCore') || rs.find(r => r.skuName === '1 vCore' && r.meterName === 'vCore');
    if (!perV) throw new PricingError(`${T} ${hw.label} elastic pools are not priced in ${ctx.region}.`);
    const unit = parseInt(perV.skuName) ? perV.retailPrice / parseInt(perV.skuName) : perV.retailPrice;
    const qty = size * pools * copies;
    let rr = null;
    if (sp) {
      const price = spPrice(perV, term, `${T} ${hw.label} pool compute`, ctx);
      const sunit = parseInt(perV.skuName) ? price / parseInt(perV.skuName) : price;
      lines.push(line(group, svc, `${T} ${hwText} pool compute, ${fmtN(size)} vCores x ${fmtN(pools)} pool(s)${replText}, ${fmtN(hours)} hours${tag}`, qty * hours, 'vCore-hours', sunit, sunit * qty * hours, meterInfo(perV)));
      notes.push('A savings plan for databases is an hourly spend commitment; the price shown is the savings-plan rate for each hour of use. Per Learn, it applies to infrastructure and software IP costs for database services, which here includes compute, the zone-redundancy add-on and the SQL license; storage and backups stay pay-as-you-go. The commitment bills every hour of the term whether or not the pool runs.');
    } else if (ri) {
      rr = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${H.p}' and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx);
      const r = rr.find(x => x.skuName === 'vCore' && x.meterName === 'vCore');
      if (!r) throw new PricingError(`${T} ${hw.label} pools have no ${term} reservation price in ${ctx.region}.`);
      lines.push(line(group, svc, `${T} ${hwText} pool compute, ${fmtN(size)} vCores x ${fmtN(pools)} pool(s)${replText}${tag}`, qty * months, 'vCore-months', r.retailPrice / months, r.retailPrice * qty / months, meterInfo(r), { unitLabel: 'per vCore-month' }));
      notes.push(`A reservation discounts compute only; ${hs ? 'the shared resource management charge' : 'the SQL Server license (unless Azure Hybrid Benefit applies)'}, storage and backups stay pay-as-you-go.`+' A reservation bills every hour of the term, so it only suits pools that run all month.');
    } else {
      lines.push(line(group, svc, `${T} ${hwText} pool compute, ${fmtN(size)} vCores x ${fmtN(pools)} pool(s)${replText}, ${fmtN(hours)} hours`, qty * hours, 'vCore-hours', unit, unit * qty * hours, meterInfo(perV)));
    }
    if (zr) {
      const z = rs.find(r => r.skuName === '1 vCore Zone Redundancy' && r.meterName === 'Zone Redundancy vCore');
      if (z) {
        if (sp) { const zp = spPrice(z, term, 'The zone-redundancy add-on', ctx); lines.push(line(group, svc, `Zone redundancy add-on, ${fmtN(size)} vCores x ${fmtN(pools)} pool(s), ${fmtN(hours)} hours${tag}`, size * pools * hours, 'vCore-hours', zp, zp * size * pools * hours, meterInfo(z))); }
        else if (commit === 'payg') lines.push(line(group, svc, `Zone redundancy add-on, ${fmtN(size)} vCores x ${fmtN(pools)} pool(s), ${fmtN(hours)} hours`, size * pools * hours, 'vCore-hours', z.retailPrice, z.retailPrice * size * pools * hours, meterInfo(z)));
        else {
          const zr1 = rr.find(x => x.skuName === 'vCore ZR Zone Redundancy');
          if (!zr1) throw new PricingError(`No ${term} reservation price for the zone-redundancy add-on in ${ctx.region}.`);
          lines.push(line(group, svc, `Zone redundancy add-on, ${fmtN(size)} vCores x ${fmtN(pools)} pool(s)${tag}`, size * pools * months, 'vCore-months', zr1.retailPrice / months, zr1.retailPrice * size * pools / months, meterInfo(zr1), { unitLabel: 'per vCore-month' }));
        }
      } else notes.push(bc ? 'Business Critical zone redundancy has no separate compute meter; the zone-redundant configuration is included in the vCore price.' : 'No separate zone-redundancy meter is published for this pool in this region.');
    }
    if (hs) {
      const srm = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database - shared resource management' and priceType eq 'Consumption'`, ctx);
      if (!srm.length) throw new PricingError(`The Hyperscale elastic pool shared resource management charge is not priced in ${ctx.region}.`);
      const m = single(srm, 'Hyperscale shared resource management')[0];
      const mp = sp ? spPrice(m, term, 'The Hyperscale shared resource management charge', ctx) : m.retailPrice;
      lines.push(line(group, svc, `Hyperscale shared resource management, ${fmtN(size)} vCores x ${fmtN(pools)} pool(s)${copies > 1 ? ` x ${copies} copies` : ''}, ${fmtN(hours)} hours${sp ? tag : ' (pay-as-you-go even with a reservation)'}`, qty * hours, 'vCore-hours', mp, mp * qty * hours, meterInfo(m)));
      notes.push('Hyperscale elastic pools have no SQL Server license charge. They pay a shared resource management charge per vCore-hour for the primary pool and every HA replica pool; it is not eligible for reserved capacity or Azure Hybrid Benefit.');
    } else if (!ahb) {
      const l = await licenseRow(`SQL Database Single/Elastic Pool ${T} - SQL License`, ctx);
      const lp = sp ? spPrice(l, term, 'The SQL Server license', ctx) : l.retailPrice;
      lines.push(line(group, svc, `SQL Server license, ${fmtN(size)} vCores x ${fmtN(pools)} pool(s)${copies > 1 ? ` x ${copies} copies` : ''}, ${fmtN(hours)} hours${sp ? tag : ' (license included)'}`, qty * hours, 'vCore-hours', lp, lp * qty * hours, meterInfo(l)));
    }
    if (replicas) notes.push('Hyperscale HA replica pools each bill the same vCore compute and shared resource management charge as the primary pool.');

    // Storage and backups
    if (hs) {
      const srs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database Hyperscale - Storage' and priceType eq 'Consumption'`, ctx);
      const st = single(srs.filter(r => r.meterName === 'Hyperscale Data Stored'), 'Hyperscale pool storage');
      lines.push(meterLine(group, svc, `Hyperscale data storage, ${fmtN(gb)} GB x ${fmtN(pools)} pool(s) (billed on used size)`, st, gb * pools, ctx, { unit: 'GB / month' }));
    } else {
      const useZr = zr && !bc;
      const srs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database Single/Elastic Pool ${T} - Storage' and priceType eq 'Consumption'`, ctx);
      const st = single(srs.filter(r => r.meterName === (useZr ? 'General Purpose Zone Redundancy Data Stored' : `${T} Data Stored`)), `${T} pool storage`);
      lines.push(meterLine(group, svc, `Data storage, ${fmtN(gb)} GB x ${fmtN(pools)} pool(s)${useZr ? ' (zone-redundant storage)' : ''}`, st, gb * pools, ctx, { unit: 'GB / month' }));
    }
    const bred = String(c.backupRedundancy || 'GRS').toUpperCase();
    if ((c.backupStorageGb || c.ltrStorageGb) && !RED[bred]) throw new PricingError('backupRedundancy must be LRS, ZRS, GRS or GZRS.');
    const backup = n(c.backupStorageGb);
    if (backup) {
      const free = hs ? 0 : gb * pools, billable = Math.max(0, backup - free);
      if (billable > 0) {
        const brs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database Single/Elastic Pool PITR Backup Storage' and priceType eq 'Consumption'`, ctx);
        const m = single(brs.filter(r => r.meterName === `${RED[bred]} Data Stored`), 'SQL pool PITR backup');
        lines.push(meterLine(group, svc, `Point-in-time backup storage, ${fmtN(backup)} GB (${bred})${free ? `, ${fmtN(billable)} GB beyond the free ${fmtN(free)} GB` : ''}`, m, billable, ctx, { unit: 'GB / month' }));
      } else notes.push(`Backup storage of ${fmtN(backup)} GB is within the free allowance (100% of the ${fmtN(free)} GB of pool storage).`);
    }
    if (n(c.ltrStorageGb)) {
      const lrs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${hs ? 'SQL Database SingleDB Hyperscale - LTR Backup Storage' : 'SQL Database - LTR Backup Storage'}' and priceType eq 'Consumption'`, ctx);
      const m = single(lrs.filter(r => r.meterName === `Backup ${RED[bred]} Data Stored`), 'SQL pool LTR backup');
      lines.push(meterLine(group, svc, `Long-term retention backup storage, ${fmtN(c.ltrStorageGb)} GB (${bred})`, m, n(c.ltrStorageGb), ctx, { unit: 'GB / month' }));
    }
    if (hs && backup) notes.push('Hyperscale pool backup storage has no free allowance and is billed at the point-in-time backup rate.');
    notes.push(hs ? 'Pool compute is priced per vCore and shared by every database in the pool.' : 'Pool compute is priced per vCore and shared by every database in the pool; the SQL Server license is a separate global meter unless Azure Hybrid Benefit applies.');
    return { lines, notes, facts: { model: 'vcore', tier, poolSize: size, pools, databases: dbs, hardware: hwKey, commitment: commit, ahb, zoneRedundant: zr, haReplicas: replicas, storageGb: gb, hours } };
  }
};
