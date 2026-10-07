'use strict';
// Azure Data Share (snapshot-based sharing). Meters: serviceName 'Azure Data Share', regional:
// a per-snapshot charge for each dataset and a per vCore-hour charge for snapshot execution.
// In-place sharing has no Data Share charge; storage and data transfer are billed by the data stores.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'data-share',
  label: 'Azure Data Share',
  family: 'analytics',
  calculator: ['data-share'],
  keywords: ['data share', 'share data', 'share datasets', 'data sharing', 'snapshot sharing', 'external data sharing', 'partner data'],
  fields: {
    datasetSnapshots: { req: true, int: true, min: 0, ask: 'How many times a month will your shared datasets be copied to the people you share with? Count each dataset in each copy (a snapshot): for example 3 datasets shared with 2 recipients on a daily schedule = 3 x 2 x 30 = 180. If unknown, suggest 30 (one dataset, daily) and record it as an assumption. Sharing in place (no copy) costs nothing here, so use 0.' },
    executionHours: { req: true, min: 0, ask: 'How many hours in total per month will the copies spend running? For example 180 copies of 5 minutes each = 15 hours. The service charges for the time each copy runs, rounded up to the minute, and usually this is the larger part of the bill. If unknown, suggest 15 hours and record it as an assumption. Use 0 only if nothing is copied (in-place sharing).' },
    vCores: { def: 2, int: true, min: 1, ask: 'How many virtual cores does each copy use while it runs? The service picks the number itself from the source and target and the data pattern; people who already share data can read it from the snapshot history. If unknown, use 2 (the pricing calculator default) and record it as an assumption.' }
  },
  context: [],
  examples: [
    { type: 'data-share', datasetSnapshots: 30, executionHours: 15 },
    { type: 'data-share', datasetSnapshots: 180, executionHours: 15, vCores: 2 }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.datasetSnapshots))} dataset snapshots a month`];
    parts.push(n(c.executionHours) ? `${fmtN(n(c.executionHours))} hours of snapshot execution on ${fmtN(n(c.vCores ?? 2))} virtual core(s)` : 'no snapshot execution time');
    return `Data Share: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('data-share-stores') ? [] : ['Storage for the shared data on both sides and any data transfer between regions (egress) are billed by the data stores, not by Data Share.'],
  price: async (c, ctx) => {
    const snaps = n(c.datasetSnapshots), hours = n(c.executionHours), vc = n(c.vCores ?? 2);
    if (snaps < 0 || hours < 0) throw new PricingError('Quantities cannot be negative.');
    if (!Number.isInteger(snaps)) throw new PricingError('datasetSnapshots must be a whole number.');
    if (hours > 0 && (!Number.isInteger(vc) || vc < 1)) throw new PricingError('vCores must be a whole number of at least 1 when snapshot execution hours are given.');
    const rs = await rows(`serviceName eq 'Azure Data Share' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) {
      const all = await rows(`serviceName eq 'Azure Data Share' and priceType eq 'Consumption'`, ctx);
      const where = [...new Set(all.map(r => r.armRegionName))].filter(Boolean).sort();
      throw new PricingError(`Azure Data Share is not priced in ${ctx.region}. Data Share does not have to be in the same region as your data; price it in a region where it is offered, such as ${where.slice(0, 8).join(', ')}.`);
    }
    const m = (name, what) => single(rs.filter(r => r.meterName === name), `Data Share ${what}`);
    const G = 'Analytics', S = 'Azure Data Share', lines = [];
    lines.push(meterLine(G, S, `Dataset snapshots, ${fmtN(snaps)}/month`, m('Dataset Snapshots', 'dataset snapshots'), snaps, ctx, { unit: 'snapshots' }));
    if (hours) lines.push(meterLine(G, S, `Snapshot execution, ${fmtN(vc)} virtual core(s) x ${fmtN(hours)} hours`, m('Snapshot Execution vCore', 'snapshot execution'), vc * hours, ctx, { unit: 'vCore hours' }));
    return {
      lines,
      notes: ['Data Share charges per dataset snapshot (a copy of one dataset to the recipient) plus the vCore time the copies take to run, prorated by the minute and rounded up. In-place sharing has no Data Share charge.'],
      facts: { datasetSnapshots: snaps, executionHours: hours, vCores: vc }
    };
  }
};
