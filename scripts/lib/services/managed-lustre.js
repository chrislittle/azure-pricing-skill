'use strict';
// Azure Managed Lustre: durable SSD file systems for HPC. Billed per provisioned GiB-hour of capacity, with a
// per-GiB rate that depends on the throughput tier (MB/s per TiB). Meters: serviceName 'Storage',
// productName 'Azure Managed Lustre', skuName AMLFS-Durable-Premium-<tier>, meterName 'Provisioned Capacity'.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const GIB_PER_TIB = 1024;
// Storage minimum, supported maximum and increment per tier (TiB), from the Azure Managed Lustre SKU table on Microsoft Learn.
const SIZES = {
  '40': { min: 48, max: 12816, def: 1536, step: 48 },
  '125': { min: 16, max: 4096, def: 512, step: 16 },
  '250': { min: 8, max: 2048, def: 256, step: 8 },
  '500': { min: 4, max: 1024, def: 128, step: 4 }
};

module.exports = {
  type: 'managed-lustre',
  label: 'Azure Managed Lustre',
  family: 'storage-other',
  calculator: ['managed-lustre'],
  keywords: ['lustre', 'hpc storage', 'parallel file system', 'ai training storage', 'high performance file system', 'scratch storage', 'gpu cluster storage'],
  fields: {
    throughputTier: { def: '125', enum: ['40', '125', '250', '500'], ask: 'How fast must the file system be per TiB of storage? Choose 40, 125, 250 or 500 MB/s per TiB: higher speeds cost more per TiB and allow smaller sizes. If unknown, suggest 125 and record it as an assumption.' },
    capacityTiB: { req: true, int: true, min: 4, ask: 'How much storage do you need, in TiB? The size must be a multiple of a fixed step for the speed you chose (40 -> 48 TiB, 125 -> 16 TiB, 250 -> 8 TiB, 500 -> 4 TiB) and must be an exact multiple of it (the portal rounds up, but this price check does not). If unknown, suggest the smallest size for the tier and record it as an assumption.' },
    hours: { def: 730, min: 0, max: 744, ask: 'It is billed from creation until deletion. If the file system exists only while jobs run, how many hours a month? Use 730 for all month.' }
  },
  context: ['production'],
  examples: [
    { type: 'managed-lustre', throughputTier: '125', capacityTiB: 16 },
    { type: 'managed-lustre', throughputTier: '500', capacityTiB: 40, hours: 200 }
  ],
  readback: c => `Azure Managed Lustre: ${fmtN(n(c.capacityTiB))} TiB at ${c.throughputTier || '125'} MB/s per TiB (up to ${fmtN(n(c.capacityTiB) * Number(c.throughputTier || 125))} MB/s in total), ${n(c.hours ?? HOURS) === HOURS ? 'running all month' : fmtN(n(c.hours)) + ' hours a month'}`,
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.includes('network')) ? [] : [
    'Virtual network and subnet for the file system, plus the client virtual machines that mount it',
    'Azure Blob Storage container if you import or export data (billed as Blob Storage)'
  ],
  price: async (c, ctx) => {
    const tier = String(c.throughputTier || '125');
    const sz = SIZES[tier];
    if (!sz) throw new PricingError(`throughputTier must be one of ${Object.keys(SIZES).join(', ')}.`);
    const tib = n(c.capacityTiB);
    if (!Number.isInteger(tib) || tib < sz.min) throw new PricingError(`At ${tier} MB/s per TiB the smallest file system is ${sz.min} TiB.`);
    if (tib % sz.step !== 0) throw new PricingError(`At ${tier} MB/s per TiB the size must be a multiple of ${sz.step} TiB (for example ${Math.ceil(tib / sz.step) * sz.step} TiB).`);
    if (tib > sz.max) throw new PricingError(`At ${tier} MB/s per TiB the largest supported file system is ${fmtN(sz.max)} TiB.`);
    const hours = c.hours ?? HOURS;
    if (!Number.isFinite(Number(hours)) || hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const rs = await rows(`serviceName eq 'Storage' and productName eq 'Azure Managed Lustre' and skuName eq 'AMLFS-Durable-Premium-${tier}' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Managed Lustre at ${tier} MB/s per TiB is not priced in ${ctx.region}.`);
    const m = single(rs.filter(r => r.meterName === 'Provisioned Capacity'), `Managed Lustre ${tier} MB/s capacity`);
    const lines = [meterLine('Storage', 'Azure Managed Lustre', `Managed Lustre file system, ${tier} MB/s per TiB, ${fmtN(tib)} TiB (${fmtN(tib * GIB_PER_TIB)} GiB) x ${fmtN(hours)} hours`, m, tib * GIB_PER_TIB * hours, ctx, { unit: 'GiB-hours' })];
    const notes = [
      'Billed on provisioned capacity per GiB-hour from creation until the file system is deleted, whether or not it is full.',
      `Throughput scales with size: ${fmtN(tib)} TiB at ${tier} MB/s per TiB gives up to ${fmtN(tib * Number(tier))} MB/s.`
    ];
    notes.push('The 20 MB/s per TiB tier listed on Learn is not priced here because the Retail Prices API has no meter for it; only 40, 125, 250 and 500 MB/s per TiB are offered.');
    if (tib > sz.def) notes.push(`A subscription can create up to ${fmtN(sz.def)} TiB at ${tier} MB/s per TiB by default; larger file systems need a support request.`);
    return { lines, notes, facts: { throughputTier: Number(tier), capacityTiB: tib, hours, maxMBps: tib * Number(tier) } };
  }
};

