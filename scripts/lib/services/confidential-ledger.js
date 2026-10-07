'use strict';
// Azure confidential ledger: a Standard ledger billed per hour plus additional storage, and the older Managed CCF
// (deprecated; priced only in a few regions) billed per hour by node count. Retail serviceName is lowercase 'Azure confidential ledger'.
const { rows, single, meterLine, regionFilter, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const NODES = [3, 5, 7, 9];

module.exports = {
  type: 'confidential-ledger',
  label: 'Azure confidential ledger',
  family: 'security',
  calculator: ['confidential-ledger'],
  keywords: ['confidential ledger', 'tamper-proof ledger', 'immutable ledger', 'append-only log', 'ccf', 'managed ccf', 'audit trail ledger', 'blockchain-backed storage'],
  fields: {
    service: { req: true, enum: ['standard', 'managed-ccf'], ask: 'Which service? A standard confidential ledger (an append-only, tamper-evident store for audit records, the normal choice) -> standard; the older Managed Confidential Consortium Framework network, which Microsoft is deprecating, only if the customer already runs one -> managed-ccf.' },
    instances: { def: 1, int: true, min: 1, ask: 'How many ledgers (standard) or networks (managed-ccf) will you run? If unknown, suggest 1.' },
    nodes: { def: 3, int: true, enum: NODES, ask: 'Managed CCF only: how many nodes per network (3, 5, 7 or 9; more nodes tolerate more failures and cost more)? If unknown, suggest 3.' },
    additionalStorageGB: { def: 0, min: 0, max: 2e9, ask: 'How many GB of ledger data will ALL ledgers or networks hold together (the sum across instances, not a per-ledger figure; for 2 ledgers of 500 GB each answer 1000)? The first 100 GB per ledger is included in the hourly price (pricing page) and only the excess is billed; the same grant is assumed for Managed CCF, whose included amount is not separately published. Leave 0 if unknown and note it as an assumption.' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours per month will it run (730 is a full month, which is the normal answer because a ledger stays on)?' }
  },
  context: ['production'],
  testRegions: ['westeurope', 'southeastasia'],
  examples: [
    { type: 'confidential-ledger', service: 'standard', instances: 1 },
    { type: 'confidential-ledger', service: 'standard', instances: 2, additionalStorageGB: 500 },
    { type: 'confidential-ledger', service: 'managed-ccf', instances: 1, nodes: 5, additionalStorageGB: 200 }
  ],
  readback: c => c.service === 'managed-ccf'
    ? `${fmtN(n(c.instances) || 1)} Managed CCF network(s) of ${fmtN(c.nodes == null ? 3 : c.nodes)} nodes, ${fmtN(c.hours == null ? 730 : c.hours)} hours a month${n(c.additionalStorageGB) ? `, ${fmtN(c.additionalStorageGB)} GB of ledger data in total (first 100 GB per ledger included)` : ''}`
    : `${fmtN(n(c.instances) || 1)} standard confidential ledger(s), ${fmtN(c.hours == null ? 730 : c.hours)} hours a month${n(c.additionalStorageGB) ? `, ${fmtN(c.additionalStorageGB)} GB of ledger data in total (first 100 GB per ledger included)` : ''}`,
  notIncluded: () => ['Azure resources that write to or read from the ledger, Key Vault or Entra ID costs, and networking or egress'],
  price: async (c, ctx) => {
    if (!['standard', 'managed-ccf'].includes(c.service)) throw new PricingError('service must be "standard" or "managed-ccf".');
    const count = c.instances == null ? 1 : n(c.instances);
    if (!Number.isInteger(count) || count < 1) throw new PricingError('instances must be a whole number of at least 1.');
    const hours = c.hours == null ? 730 : n(c.hours);
    if (!(hours >= 0) || hours > 744) throw new PricingError('hours must be between 0 and 744.');
    const total = n(c.additionalStorageGB);
    if (!(total >= 0)) throw new PricingError('additionalStorageGB must be 0 or more.');
    const gb = Math.max(0, total - 100 * count);
    const rs = await rows(`serviceName eq 'Azure confidential ledger' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const find = (meter, what) => {
      const m = rs.filter(r => r.meterName === meter);
      if (!m.length) throw new PricingError(`${what} is not offered in ${ctx.region}. ${c.service === 'managed-ccf' ? 'Managed CCF is only priced in a few regions (for example westeurope and southeastasia).' : 'Standard ledgers are available in about 18 regions, for example eastus, westeurope and uksouth.'}`);
      return single(m, what);
    };
    const G = 'Security', S = 'Azure confidential ledger';
    const lines = [];
    let nodes = null;
    if (c.service === 'managed-ccf') {
      nodes = c.nodes == null ? 3 : n(c.nodes);
      if (!NODES.includes(nodes)) throw new PricingError(`nodes must be one of ${NODES.join(', ')}.`);
      lines.push(meterLine(G, S, `Managed CCF network (${nodes} nodes): ${fmtN(count)} x ${fmtN(hours)} hours`, find(`MCCF - ${nodes} nodes Instance`, `Managed CCF ${nodes}-node instance`), count * hours, ctx, { unit: 'hours' }));
      if (gb) lines.push(meterLine(G, S, `Managed CCF additional storage: ${fmtN(gb)} GB`, find('MCCF - Additional Storage Data Stored', 'Managed CCF additional storage'), gb, ctx, { unit: 'GB-months' }));
    } else {
      lines.push(meterLine(G, S, `Standard confidential ledger: ${fmtN(count)} x ${fmtN(hours)} hours`, find('Standard Instance', 'Standard ledger instance'), count * hours, ctx, { unit: 'hours' }));
      if (gb) lines.push(meterLine(G, S, `Additional storage: ${fmtN(gb)} GB`, find('Additional Storage Data Stored', 'additional storage'), gb, ctx, { unit: 'GB-months' }));
    }
    return { lines, notes: ['Billed per hour for each ledger plus storage per GB-month. The pricing page includes the first 100 GB of storage per ledger, so only data above 100 GB x ledgers is billed (the same grant is assumed for Managed CCF, whose included amount is not separately published). The grant is pooled across ledgers, so very uneven ledgers (for example 0 GB and 300 GB) can be slightly under-billed. Microsoft has announced that Managed CCF is being deprecated.'], facts: { service: c.service, instances: count, nodes, hours } };
  }
};

