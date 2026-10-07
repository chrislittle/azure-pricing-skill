'use strict';
// Azure NetApp Files: capacity pools by service level (Standard, Premium, Ultra, Flexible, Elastic zone-redundant preview),
// double encryption, storage with cool access, backup, volume restore, cross-region replication, and reserved capacity.
// Meters: serviceName 'Azure NetApp Files', regional. Capacity is billed per provisioned GiB-hour; the Flexible service
// level adds throughput per MiB/s-hour above 128 MiB/s per capacity pool. Reservations are whole-term prices for
// 100 TiB or 1 PiB blocks of Standard, Premium or Ultra capacity.
const { rows, single, line, meterInfo, regionFilter, meterLine, PricingError, fmtN, HOURS, q, termMonths } = require('../kit');

const n = v => Number(v || 0);
const SVC = 'Azure NetApp Files';
const GIB_PER_TIB = 1024;
const PIB_TIB = 1024;
const BLOCK_TIB = 100;
const FREE_MIBPS_PER_POOL = 128;
const LEVEL = { standard: 'Standard', premium: 'Premium', ultra: 'Ultra', flexible: 'Flexible', elastic: 'Elastic zone-redundant (preview)' };
const SCHEDULE = { '10min': { meter: 'Minutes', label: 'every 10 minutes' }, hourly: { meter: 'Hours', label: 'hourly' }, daily: { meter: 'Days', label: 'daily' } };

module.exports = {
  type: 'netapp-files',
  label: 'Azure NetApp Files',
  family: 'storage-other',
  calculator: ['netapp'],
  keywords: ['netapp', 'nfs', 'smb file share', 'enterprise file storage', 'sap hana storage', 'hpc file system', 'cool access', 'cross-region replication', 'oracle storage'],
  fields: {
    serviceLevel: { def: 'standard', enum: ['standard', 'premium', 'ultra', 'flexible', 'elastic'], ask: 'How fast must the file storage be? It is sold per TiB, and speed depends on the level: standard (16 MiB/s per TiB), premium (64 MiB/s per TiB), ultra (128 MiB/s per TiB). Choose flexible if capacity and speed do not match those ratios (you pay for speed separately), or elastic for the zone-redundant preview level. If unknown, suggest standard and record it as an assumption.' },
    capacityTiB: { req: true, int: true, min: 1, ask: 'How much storage do you need, in TiB (1 TiB = 1,024 GiB)? You pay for the size you set up (the capacity pool), not for the data you actually store, and the smallest pool is 1 TiB. If unknown, suggest 4 TiB and record it as an assumption.' },
    encryption: { def: 'single', enum: ['single', 'double'], ask: 'Do you need double encryption at rest (standard, premium or ultra only)? Yes -> double; otherwise single.' },
    capacityPools: { def: 1, int: true, min: 1, ask: 'Flexible only: how many capacity pools will the storage be split across? Each pool includes 128 MiB/s of throughput free.' },
    throughputMiBps: { def: 128, min: 0, ask: 'Flexible only: how much total throughput do you need, in MiB/s across all pools? Each pool includes 128 MiB/s free; the rest is billed. If unknown, leave 128.' },
    coolPercent: { def: 0, int: true, min: 0, max: 100, ask: 'Any level except elastic: what share of the data is rarely used (not read for weeks)? That share can move to a cheaper cool tier. Give a percentage from 0 to 100; 0 means no cool tiering.' },
    coolReadWritePercent: { def: 20, int: true, min: 0, max: 100, ask: 'Only with cool tiering: each month, what percentage of the data in the cool tier is read or written (and so moved back and forth, which is billed per GiB)? If unknown, use 20 and record it as an assumption.' },
    backupGiB: { def: 0, min: 0, ask: 'Azure NetApp Files backup (long-term copies kept outside the volume): how many GiB of backup data will be stored on average each month? Use 0 for none.' },
    restoreGiB: { def: 0, min: 0, ask: 'How many GiB of backup data do you expect to restore in a month? Use 0 if none.' },
    replicationGiB: { def: 0, min: 0, ask: 'Cross-region replication (a copy in another region for disaster recovery): how many GiB of data are sent to the other region each month? Use 0 if no replication. The copy itself needs its own capacity pool in the other region, which you add as a separate component.' },
    replicationSchedule: { def: 'hourly', enum: ['10min', 'hourly', 'daily'], ask: 'Only with replication: how often is data copied? 10min, hourly or daily. Faster schedules cost more per GiB.' },
    replicationDestination: { def: '', ask: 'Only with replication: the Azure region receiving the copy (for example westus2). Leave empty if not decided and the general replication price is used.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Will the storage run at this size for a year or three? A 1-year (ri1y) or 3-year (ri3y) reservation lowers the price of standard, premium or ultra capacity; it is sold in blocks of 100 TiB or 1 PiB. Otherwise payg.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Capacity is billed hourly. If the pool exists all month leave 730; if it will be resized or deleted part of the month, how many hours at this size?' }
  },
  context: ['production', 'steadyUsage', 'zoneResilience'],
  examples: [
    { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 4 },
    { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 100, coolPercent: 75, coolReadWritePercent: 20, backupGiB: 20480, restoreGiB: 1024, replicationGiB: 5120, replicationSchedule: 'hourly', replicationDestination: 'westus2' },
    { type: 'netapp-files', serviceLevel: 'flexible', capacityTiB: 10, capacityPools: 2, throughputMiBps: 512, coolPercent: 50, hours: 500 },
    { type: 'netapp-files', serviceLevel: 'premium', capacityTiB: 120, commitment: 'ri1y' }
  ],
  readback: c => {
    const lvl = c.serviceLevel || 'standard';
    const p = [`${fmtN(n(c.capacityTiB))} TiB ${LEVEL[lvl]} capacity pool${lvl === 'flexible' ? ` (${fmtN(n(c.capacityPools) || 1)} pool(s), ${fmtN(c.throughputMiBps ?? 128)} MiB/s throughput in total)` : ''}`];
    if ((c.encryption || 'single') === 'double') p.push('double encryption');
    if (n(c.coolPercent)) p.push(`${fmtN(c.coolPercent)}% of the data in the cool tier with ${fmtN(c.coolReadWritePercent ?? 20)}% of it read or written each month`);
    if (c.commitment && c.commitment !== 'payg') p.push(`${c.commitment === 'ri3y' ? '3-year' : '1-year'} reservation`);
    if (n(c.backupGiB)) p.push(`${fmtN(c.backupGiB)} GiB of backup storage`);
    if (n(c.restoreGiB)) p.push(`${fmtN(c.restoreGiB)} GiB restored from backup`);
    if (n(c.replicationGiB)) p.push(`${fmtN(c.replicationGiB)} GiB a month replicated ${SCHEDULE[c.replicationSchedule || 'hourly'].label}${c.replicationDestination ? ' to ' + c.replicationDestination : ' to another region'}`);
    p.push(n(c.hours ?? HOURS) === HOURS ? 'running all month' : `${fmtN(c.hours)} hours a month`);
    return `Azure NetApp Files: ${p.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.includes('network')) ? [] : [
    'Virtual network and the delegated subnet that Azure NetApp Files volumes need',
    'Capacity pool in the destination region for cross-region replication (add it as another Azure NetApp Files component)',
    'Network data transfer charges between regions or out of Azure'
  ],
  price: async (c, ctx) => {
    const lvl = (c.serviceLevel || 'standard').toLowerCase();
    if (!LEVEL[lvl]) throw new PricingError(`serviceLevel must be one of ${Object.keys(LEVEL).join(', ')}.`);
    const tib = n(c.capacityTiB);
    if (!Number.isInteger(tib) || tib < 1) throw new PricingError('capacityTiB must be a whole number of TiB, at least 1 (the smallest capacity pool).');
    const hours = c.hours ?? HOURS;
    if (!Number.isFinite(Number(hours)) || hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const double = (c.encryption || 'single') === 'double';
    if (double && !['standard', 'premium', 'ultra'].includes(lvl)) throw new PricingError('Double encryption is priced for the standard, premium and ultra service levels only.');
    const cool = n(c.coolPercent);
    if (cool && lvl === 'elastic') throw new PricingError('Cool access is not offered on the Elastic zone-redundant (preview) level in the Azure Pricing Calculator.');
    if (cool && double) throw new PricingError('Cool access is priced with single encryption only.');
    const commit = c.commitment || 'payg';
    if (commit !== 'payg' && !['standard', 'premium', 'ultra'].includes(lvl)) throw new PricingError('Reservations are sold for the standard, premium and ultra service levels only.');
    if (commit !== 'payg' && double) throw new PricingError('Reservations are priced here for single encryption only.');
    const pools = n(c.capacityPools ?? 1) || 1;
    const tput = n(c.throughputMiBps ?? FREE_MIBPS_PER_POOL);
    if (lvl === 'flexible') {
      if (pools > tib) throw new PricingError('Each Flexible capacity pool is at least 1 TiB, so capacityPools cannot be more than capacityTiB.');
      if (tput > 640 * tib) throw new PricingError('Flexible throughput is limited to 640 MiB/s per TiB of capacity.');
    }
    const repGiB = n(c.replicationGiB);

    const rs = await rows(`serviceName eq '${SVC}' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure NetApp Files is not priced in ${ctx.region}.`);
    const byName = (name, what) => single(rs.filter(r => r.meterName === name), what || name);
    const G = 'Storage', lines = [], notes = [];
    const capName = lvl === 'elastic' ? 'Elastic Zone Redundant Storage Capacity'
      : lvl === 'flexible' ? 'Flexible Service Level Capacity'
        : `${LEVEL[lvl]}${double ? ' Double Encrypted' : ''} Capacity`;
    const totalGiB = tib * GIB_PER_TIB;
    const coolGiB = totalGiB * cool / 100;
    const hotGiB = totalGiB - coolGiB;
    const hotTiB = hotGiB / GIB_PER_TIB;

    let payGiB = hotGiB;
    let reserved = null;
    if (commit !== 'payg') {
      const term = commit === 'ri3y' ? '3 Years' : '1 Year';
      const pibs = Math.floor(hotTiB / PIB_TIB);
      const blocks = Math.floor((hotTiB - pibs * PIB_TIB) / BLOCK_TIB);
      const wanted = [[pibs, '1 PiB'], [blocks, '100 TiB']].filter(([k]) => k > 0);
      if (!wanted.length) throw new PricingError(`A reservation needs at least ${BLOCK_TIB} TiB of ${LEVEL[lvl]} capacity not in the cool tier (sold in ${BLOCK_TIB} TiB or 1 PiB blocks).`);
      reserved = { term, pibs, blocks, coveredTiB: pibs * PIB_TIB + blocks * BLOCK_TIB };
      for (const [count, size] of wanted) {
        const rr = await rows(`serviceName eq '${SVC}' and ${regionFilter(ctx)} and priceType eq 'Reservation' and skuName eq '${LEVEL[lvl]} - ${size}'`, ctx);
        const row = rr.find(r => r.reservationTerm === term);
        if (!row) throw new PricingError(`No ${term} reservation price for ${LEVEL[lvl]} ${size} in ${ctx.region}.`);
        const monthly = row.retailPrice / termMonths(term);
        lines.push(line(G, SVC, `${LEVEL[lvl]} capacity reservation, ${size} block x ${count}, ${term === '3 Years' ? '3-year' : '1-year'}`, count, `${size} block / month`, monthly, monthly * count, meterInfo(row), { termTotal: row.retailPrice }));
      }
      payGiB = Math.max(0, hotTiB - reserved.coveredTiB) * GIB_PER_TIB;
      notes.push(`${reserved.term} reservation: the listed price is for the whole term, divided by ${termMonths(term)} months. It covers ${fmtN(reserved.coveredTiB)} TiB (${pibs ? fmtN(pibs) + ' x 1 PiB' : ''}${pibs && blocks ? ' + ' : ''}${blocks ? fmtN(blocks) + ' x 100 TiB' : ''}) and is billed whether or not the capacity is used; capacity above that is pay-as-you-go.`);
    }

    if (payGiB > 0) {
      const m = byName(capName, `${LEVEL[lvl]} capacity`);
      lines.push(meterLine(G, SVC, `${LEVEL[lvl]}${double ? ' double-encrypted' : ''} capacity pool${reserved ? ' (not covered by the reservation)' : ''}, ${fmtN(Math.round(payGiB / GIB_PER_TIB * 100) / 100)} TiB x ${fmtN(hours)} hours`, m, payGiB * hours, ctx, { unit: 'GiB-hours' }));
    }

    if (lvl === 'flexible') {
      const extra = Math.max(0, tput - FREE_MIBPS_PER_POOL * pools);
      if (extra > 0) {
        const m = byName('Flexible Service Level Throughput MiBps', 'Flexible throughput');
        lines.push(meterLine(G, SVC, `Flexible throughput above the free ${fmtN(FREE_MIBPS_PER_POOL * pools)} MiB/s (${fmtN(pools)} pool(s)): ${fmtN(extra)} MiB/s x ${fmtN(hours)} hours`, m, extra * hours, ctx, { unit: 'MiB/s-hours' }));
      }
      notes.push(`Each Flexible capacity pool includes ${FREE_MIBPS_PER_POOL} MiB/s of throughput at no charge; only throughput above that is billed, per MiB/s per hour.`);
    }

    if (cool) {
      const cc = byName('Standard Storage with Cool Access Capacity', 'cool access capacity');
      lines.push(meterLine(G, SVC, `Data in the cool tier: ${fmtN(Math.round(coolGiB / GIB_PER_TIB * 100) / 100)} TiB x ${fmtN(hours)} hours`, cc, coolGiB * hours, ctx, { unit: 'GiB-hours' }));
      const rw = n(c.coolReadWritePercent ?? 20);
      if (rw > 0) {
        const dt = byName('Standard Storage with Cool Access Data Transfer', 'cool access data transfer');
        lines.push(meterLine(G, SVC, `Data moved between the cool and hot tiers: ${fmtN(rw)}% of ${fmtN(Math.round(coolGiB))} GiB a month`, dt, coolGiB * rw / 100, ctx, { unit: 'GiB' }));
      }
      notes.push('Cool-tier data is billed at a lower rate and does not count toward the hot capacity pool. Data moved to the cool tier for the first time, and data read back or rewritten, is billed per GiB; the one-time first move is not included here.');
    }

    if (n(c.backupGiB)) lines.push(meterLine(G, SVC, `Backup storage, ${fmtN(c.backupGiB)} GiB a month`, byName('Backup Capacity', 'backup capacity'), n(c.backupGiB), ctx, { unit: 'GiB / month' }));
    if (n(c.restoreGiB)) lines.push(meterLine(G, SVC, `Backup restore, ${fmtN(c.restoreGiB)} GiB a month`, byName('Volume Restore Capacity', 'volume restore'), n(c.restoreGiB), ctx, { unit: 'GiB' }));

    if (repGiB > 0) {
      const sched = SCHEDULE[c.replicationSchedule || 'hourly'];
      if (!sched) throw new PricingError('replicationSchedule must be 10min, hourly or daily.');
      let srcLoc = rs[0].location, destLoc = null, dr = rs;
      if (c.replicationDestination) {
        dr = await rows(`serviceName eq '${SVC}' and armRegionName eq '${q(String(c.replicationDestination).toLowerCase())}' and priceType eq 'Consumption'`, ctx);
        if (!dr.length) throw new PricingError(`Azure NetApp Files is not priced in the replication destination "${c.replicationDestination}".`);
        destLoc = dr[0].location;
      }
      // Pair meters use short location names (e.g. "US Gov VA"), which can differ from the row's location.
      const PAIR = /^(?:Cross Region Replication|CRR) - (.+?) to (.+) (Minutes|Hours|Days)$/;
      const pairs = rs.map(r => PAIR.exec(r.meterName)).filter(Boolean);
      const shortOf = set => { const p = set.map(r => /^(?:Cross Region Replication|CRR) - (.+?) to /.exec(r.meterName)).find(Boolean); return p && p[1]; };
      const srcNames = [...new Set([srcLoc, ...pairs.map(p => p[1])])];
      const destNames = destLoc ? [...new Set([destLoc, shortOf(dr)].filter(Boolean))] : [];
      const pair = rs.filter(r => { const p = PAIR.exec(r.meterName); return p && p[3] === sched.meter && srcNames.includes(p[1]) && destNames.includes(p[2]); });
      const generic = dr.filter(r => r.meterName === `Cross Region Replication ${sched.meter}`);
      const m = pair.length ? single(pair, 'replication for this region pair') : single(generic, 'cross-region replication');      lines.push(meterLine(G, SVC, `Cross-region replication ${sched.label}${destLoc ? ` to ${destLoc}` : ''}, ${fmtN(repGiB)} GiB a month${pair.length ? '' : ' (general replication rate)'}`, m, repGiB, ctx, { unit: 'GiB' }));
      notes.push('Cross-region replication is billed per GiB transferred, with a higher rate for more frequent schedules; the destination capacity pool is billed at its own rate as a separate component.');
    }

    notes.unshift('Azure NetApp Files bills the provisioned capacity pool size every hour, whether or not it is filled with data. The smallest pool is 1 TiB.');
    return { lines, notes, facts: { serviceLevel: lvl, capacityTiB: tib, encryption: double ? 'double' : 'single', capacityPools: pools, throughputMiBps: tput, coolPercent: cool, hotTiB, commitment: commit, backupGiB: n(c.backupGiB), replicationGiB: repGiB, hours } };
  }
};
