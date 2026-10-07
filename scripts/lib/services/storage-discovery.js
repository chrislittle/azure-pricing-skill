'use strict';
// Azure Storage Discovery: a workspace analyses storage accounts and the objects in them. The Standard plan bills a
// graduated fee per storage account and a graduated fee per million objects analysed; the Free plan is not billed.
// Meters: serviceName 'Storage', productName 'Storage Discovery', skuName 'Standard', regional.
const { rows, single, line, meterInfo, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'storage-discovery',
  label: 'Azure Storage Discovery',
  family: 'storage-other',
  calculator: ['azure-storage-discovery'],
  keywords: ['storage discovery', 'storage insights', 'storage inventory', 'storage analytics across accounts', 'storage estate', 'capacity trends', 'blob inventory'],
  fields: {
    plan: { def: 'standard', enum: ['free', 'standard'], ask: 'Which Storage Discovery plan: free (capacity insights only, 15 days of history) or standard (adds transaction, resource configuration and security configuration insights, with 18 months of history)? If they need only capacity trends, free; otherwise standard.' },
    storageAccounts: { req: true, int: true, min: 0, ask: 'How many storage accounts will one Discovery workspace analyze? Count every storage account in the subscriptions or resource groups the workspace covers. If unknown, suggest 20 and record it as an assumption.' },
    objects: { req: true, min: 0, ask: 'Roughly how many objects (blobs) are stored in those accounts in total? 1 million small files is 1,000,000. If unknown, suggest 10,000,000 and record it as an assumption.' }
  },
  context: [],
  examples: [
    { type: 'storage-discovery', storageAccounts: 50, objects: 100000000 },
    { type: 'storage-discovery', plan: 'standard', storageAccounts: 2000, objects: 50000000000 }
  ],
  readback: c => `Azure Storage Discovery ${c.plan === 'free' ? 'free' : 'standard'} plan, one workspace: ${fmtN(n(c.storageAccounts))} storage accounts and ${fmtN(n(c.objects))} objects analyzed`,
  notIncluded: () => [],
  price: async (c, ctx) => {
    const plan = c.plan || 'standard';
    if (!['free', 'standard'].includes(plan)) throw new PricingError('plan must be free or standard.');
    const acc = n(c.storageAccounts), obj = n(c.objects);
    if (!Number.isInteger(acc) || acc < 0) throw new PricingError('storageAccounts must be a whole number, 0 or more.');
    if (!(obj >= 0)) throw new PricingError('objects must be 0 or more.');
    const rs = await rows(`serviceName eq 'Storage' and productName eq 'Storage Discovery' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Storage Discovery is not priced in ${ctx.region}.`);
    const a = single(rs.filter(r => r.meterName === 'Standard Storage Account'), 'Storage Discovery storage accounts');
    const o = single(rs.filter(r => r.meterName === 'Standard Objects Analyzed'), 'Storage Discovery objects analyzed');
    // Every workspace is billed on its own, so tier bands are not shared with other components in the option.
    const own = { ...ctx, ledger: undefined };
    const billedObj = Math.max(obj, 1000000);
    const G = 'Storage', S = 'Storage';
    const lines = plan === 'free'
      ? [line(G, S, `Storage Discovery free plan: ${fmtN(acc)} storage accounts and ${fmtN(obj)} objects, no charge`, 0, 'workspace', 0, 0, meterInfo(a[0]))]
      : [
        meterLine(G, S, `Storage Discovery standard plan: ${fmtN(acc)} storage accounts analyzed${a.length > 1 ? ' (graduated)' : ''}`, a, acc, own, { unit: 'storage accounts' }),
        meterLine(G, S, `Storage Discovery standard plan: ${fmtN(obj)} objects analyzed${billedObj > obj ? ' (1 million minimum)' : ''}${o.length > 1 ? ' (graduated)' : ''}`, o, billedObj, own, { unit: 'objects' })
      ];
    return {
      lines,
      notes: [
        'The standard plan charges a fee per storage account and a fee per million objects in scope of the workspace; the average cost per account and per object falls as the numbers grow.',
        'The Azure pricing calculator applies a minimum charge of 1 million objects on the standard plan, so fewer objects are billed as 1 million.',
        'Every workspace is billed individually: a storage account included in two paid workspaces is charged in both. Add one component per workspace.'
      ],
      facts: { plan, storageAccounts: acc, objects: obj }
    };
  }
};
