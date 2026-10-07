'use strict';
// Azure Storage Actions: storage tasks that run on Blob Storage objects. Each assignment run is billed a per-run
// fee plus per-million-object meters for objects targeted (scanned), objects operated on, and operations invoked.
// Meters: serviceName 'Storage', productName 'Storage Actions', skuName 'Azure Storage Tasks', regional.
// The blob operations the task performs (set tier, set tags...) are billed by the storage account, not here.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'storage-actions',
  label: 'Azure Storage Actions',
  family: 'storage-other',
  calculator: ['storage-actions'],
  keywords: ['storage actions', 'storage tasks', 'blob lifecycle', 'bulk blob operations', 'change blob tier', 'blob tagging', 'delete old blobs'],
  fields: {
    runsPerMonth: { req: true, int: true, min: 0, ask: 'How many times a month will the storage task run? Count each scheduled or one-time run: a task that runs daily is about 30 runs a month. If unknown, suggest 1 and record it as an assumption.' },
    objectsPerRun: { req: true, min: 0, ask: 'How many blobs (objects) does the task look at on each run? This is every blob in the storage account, or under the folder prefixes you select, minus any excluded prefixes. If unknown, suggest 1,000,000 and record it as an assumption.' },
    matchingObjectsPerRun: { def: 0, min: 0, ask: 'On each run, how many of those blobs meet the task condition and get changed (for example moved to a cooler tier or tagged)? Use 0 if the task only evaluates.' },
    operationsPerMatch: { def: 1, int: true, min: 1, ask: 'How many separate actions does the task apply to each matching blob (for example 1 to change the tier, 2 to change the tier and add a tag)?' }
  },
  context: [],
  examples: [
    { type: 'storage-actions', runsPerMonth: 1, objectsPerRun: 1000000 },
    { type: 'storage-actions', runsPerMonth: 30, objectsPerRun: 100000000, matchingObjectsPerRun: 1000000, operationsPerMatch: 2 }
  ],
  readback: c => `Azure Storage Actions: ${fmtN(n(c.runsPerMonth))} task run(s) a month, each looking at ${fmtN(n(c.objectsPerRun))} objects, changing ${fmtN(n(c.matchingObjectsPerRun))} matching objects with ${fmtN(n(c.operationsPerMatch ?? 1))} operation(s) each`,
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.includes('storage')) ? [] : [
    'Blob Storage operation charges on the storage account for what the task does (for example Set Blob Tier or Set Blob Tags), billed by the storage account',
    'Storage capacity and any early-deletion or tier-change charges on the blobs'
  ],
  price: async (c, ctx) => {
    const runs = n(c.runsPerMonth), perRun = n(c.objectsPerRun), match = n(c.matchingObjectsPerRun), ops = n(c.operationsPerMatch ?? 1);
    if (!Number.isInteger(runs) || runs < 0) throw new PricingError('runsPerMonth must be a whole number, 0 or more.');
    if (!(perRun >= 0) || !(match >= 0)) throw new PricingError('objectsPerRun and matchingObjectsPerRun must be 0 or more.');
    if (match > perRun) throw new PricingError('matchingObjectsPerRun cannot be more than objectsPerRun.');
    if (!Number.isInteger(ops) || ops < 1) throw new PricingError('operationsPerMatch must be a whole number, at least 1.');
    const rs = await rows(`serviceName eq 'Storage' and productName eq 'Storage Actions' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Storage Actions is not priced in ${ctx.region}.`);
    const m = (name, what) => single(rs.filter(r => r.meterName === name), what);
    const G = 'Storage', S = 'Storage Actions';
    const notes = [];
    const lines = [
      meterLine(G, S, `Task executions, ${fmtN(runs)} run(s) a month`, m('Azure Storage Tasks Task Execution', 'task executions'), runs, ctx, { unit: 'runs' }),
      meterLine(G, S, `Objects targeted (scanned and evaluated), ${fmtN(runs)} run(s) x ${fmtN(perRun)} objects`, m('Azure Storage Tasks Objects Targeted', 'objects targeted'), runs * perRun, ctx, { unit: 'objects' })
    ];
    if (match > 0) {
      const opOn = rs.filter(r => r.meterName === 'Azure Storage Tasks Objects Operated On');
      if (opOn.length) lines.push(meterLine(G, S, `Objects operated on, ${fmtN(runs)} run(s) x ${fmtN(match)} objects`, single(opOn, 'objects operated on'), runs * match, ctx, { unit: 'objects' }));
      else notes.push('The objects-operated-on meter is not listed for this region in the Azure Retail Prices API, so it is not charged in this estimate.');
      lines.push(meterLine(G, S, `Operations invoked, ${fmtN(runs)} run(s) x ${fmtN(match)} objects x ${fmtN(ops)} operation(s)`, m('Azure Storage Tasks Operations Invoked', 'operations invoked'), runs * match * ops, ctx, { unit: 'operations' }));
    }
    return {
      lines,
      notes: [
        ...notes,
        'Storage Actions meters apply only when a storage task assignment runs; each run is charged a per-run fee plus a charge for every object scanned and evaluated in its scope.',
        'The Learn cost page lists only the per-run, objects-targeted and operations-performed meters; the objects-operated-on meter is priced from the Azure Retail Prices API alone.',
        'Learn describes the objects-targeted meter as per condition. It is not clear whether several conditions in one task multiply the charge, so this estimate counts each object once; a task with several conditions may cost more.',
        'Objects and operations are billed per million. The Blob Storage operations the task performs are charged separately by the storage account.'
      ],
      facts: { runsPerMonth: runs, objectsPerRun: perRun, targetedObjectsPerMonth: runs * perRun, matchingObjectsPerMonth: runs * match, operationsPerMonth: runs * match * ops }
    };
  }
};


