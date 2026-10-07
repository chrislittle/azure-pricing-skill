'use strict';
// Azure Data Manager for Energy (OSDU platform): a flat hourly instance fee per tier, an hourly fee per
// extra data partition (per instance), and an hourly Analytics Capacity meter (Developer tier only).
// Meters: serviceName 'Energy Data Manager', regional (sold in only some regions; prices differ).
// Data storage is billed separately since 1 August 2026 through the standard Azure storage meters (the `blob` type).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const MAX_PARTITIONS = { developer: 5, standard: 10 };

module.exports = {
  type: 'energy-data-manager',
  label: 'Azure Data Manager for Energy',
  family: 'integration',
  calculator: ['energy-data-services'],
  testRegions: ['eastus', 'westeurope'],
  keywords: ['osdu', 'energy data', 'oil and gas', 'seismic', 'subsurface', 'well data', 'energy data services', 'data manager for energy'],
  fields: {
    tier: { req: true, enum: ['developer', 'standard'], ask: 'Is this for production use or for testing and proof of concept? Production (high availability, disaster recovery, financially backed SLA) -> standard; testing, evaluation or early development only -> developer. If unknown, suggest standard and record it as an assumption.' },
    instances: { def: 1, int: true, min: 1, max: 100, ask: 'How many separate Data Manager for Energy instances will they run (for example one for production and one for test is 2)? Each instance is billed separately. If unknown, use 1.' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours a month will each instance exist? The instance fee is charged every hour it exists, even when idle (730 = all month). If unknown, use 730.' },
    additionalPartitions: { def: 0, int: true, min: 0, max: 9, ask: 'How many data partitions does each instance need beyond the one that is included (a partition is a separate data container, for example one per business unit or per data owner)? Developer allows up to 5 partitions in total and standard up to 10. If unknown, use 0.' },
    analyticsHours: { def: 0, min: 0, max: 744, ask: 'Only if they use the Analytics Consumption Zone (preview, developer tier only): how many hours a month will analytics capacity be provisioned for each instance? If none, 0.' }
  },
  context: ['production'],
  examples: [
    { type: 'energy-data-manager', tier: 'developer', hours: 730 },
    { type: 'energy-data-manager', tier: 'standard', instances: 2, hours: 730, additionalPartitions: 3 },
    { type: 'energy-data-manager', tier: 'developer', instances: 2, hours: 500, additionalPartitions: 4, analyticsHours: 200 }
  ],
  readback: c => {
    const h = c.hours ?? HOURS, i = c.instances == null ? 1 : n(c.instances);
    const parts = [`${fmtN(i)} instance(s)`, `${fmtN(h)} hours a month each${h === HOURS ? ' (all month)' : ''}`, `${fmtN(n(c.additionalPartitions))} extra data partition(s) per instance beyond the 1 included`];
    if (n(c.analyticsHours)) parts.push(`${fmtN(c.analyticsHours)} hours of analytics capacity per instance${c.tier === 'standard' ? ' (warning: Microsoft says analytics is Developer-only, so this is not supported on Standard)' : ''}`);
    return `Data Manager for Energy ${c.tier || 'standard'} tier: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('energy-data-extras') ? [] : [
    ...([...types].includes('blob') ? [] : ['Data storage: since 1 August 2026 the data in an instance is billed at standard Hot GZRS blob storage rates (reserved capacity does not apply). Add a "blob" component (tier Hot, redundancy GZRS, capacity = data size).']),
    'Data transfer: Microsoft says standard Azure data transfer rates are currently not charged on Data Manager for Energy; this may change.',
    'Private endpoints and the Azure services that consume the data.'
  ],
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!MAX_PARTITIONS[tier]) throw new PricingError('tier must be "developer" or "standard".');
    const hours = c.hours ?? HOURS, extra = n(c.additionalPartitions), analytics = n(c.analyticsHours), inst = c.instances == null ? 1 : n(c.instances);
    if (!Number.isInteger(inst) || inst < 1) throw new PricingError('instances must be a whole number of at least 1.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (analytics < 0 || analytics > 744) throw new PricingError('analyticsHours must be between 0 and 744.');
    if (!Number.isInteger(extra) || extra < 0) throw new PricingError('additionalPartitions must be a whole number, 0 or more.');
    if (extra + 1 > MAX_PARTITIONS[tier]) throw new PricingError(`The ${tier} tier allows at most ${MAX_PARTITIONS[tier]} data partitions in total (1 included + ${MAX_PARTITIONS[tier] - 1} additional).`);
    const rs = await rows(`serviceName eq 'Energy Data Manager' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Data Manager for Energy is not sold in ${ctx.region}. Choose another region, for example eastus, westeurope or northeurope.`);
    const T = tier === 'developer' ? 'Developer' : 'Standard';
    const m = (name, what) => {
      const r = rs.filter(x => x.meterName === `${T} ${name}`);
      if (!r.length) throw new PricingError(`The ${tier} tier ${what} is not offered in ${ctx.region}.${what === 'instance' && tier === 'standard' ? ' Choose the developer tier or another region.' : ' Choose another region or set it to 0.'}`);
      return single(r, `Data Manager for Energy ${T} ${what}`);
    };
    const G = 'Integration', S = 'Energy Data Manager', lines = [];
    lines.push(meterLine(G, S, `Data Manager for Energy ${T} instance (includes 1 data partition): ${fmtN(inst)} x ${fmtN(hours)} hours`, m('Instance', 'instance'), inst * hours, ctx, { unit: 'hours' }));
    if (extra) lines.push(meterLine(G, S, `Additional data partitions: ${fmtN(extra)} per instance x ${fmtN(inst)} instance(s) x ${fmtN(hours)} hours`, m('Additional Data Partition', 'additional data partition'), extra * inst * hours, ctx, { unit: 'partition-hours' }));
    if (analytics) lines.push(meterLine(G, S, `Analytics capacity: ${fmtN(analytics)} hours x ${fmtN(inst)} instance(s)`, m('Analytics Capacity', 'analytics capacity'), analytics * inst, ctx, { unit: 'hours' }));
    const notes = ['The instance fee is charged for every hour the instance exists, even when it is idle; one data partition is included, extra partitions are billed per hour each, per instance.'];
    if (tier === 'developer') notes.push('The Developer tier has no financially backed SLA, no availability zones or disaster recovery, and allows at most 5 data partitions.');
    if (analytics && tier !== 'developer') notes.push('Warning: Microsoft says the Analytics Consumption Zone (preview) is available only on Developer tier instances, although a Standard analytics capacity meter exists.');
    if (analytics) notes.push('The Analytics Capacity meter is new and its billing unit is not publicly documented; it is priced here as the per-hour rate listed in the Retail Prices API.');
    notes.push('Data storage is billed separately at standard Azure blob storage rates (see "not included").');
    return { lines, notes, facts: { tier, instances: inst, hours, additionalPartitions: extra, analyticsHours: analytics, region: ctx.region } };
  }
};