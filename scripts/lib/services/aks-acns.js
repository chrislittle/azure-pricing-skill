'use strict';
// Advanced Container Networking Services (ACNS) for Azure Kubernetes Service: per node per hour while the feature
// is enabled on the node. Meters: serviceName 'Advanced Container Networking Services', regionless (Global).
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'aks-acns',
  label: 'Advanced Container Networking Services (AKS)',
  family: 'networking-core',
  calculator: ['advanced-container-networking-services'],
  keywords: ['acns', 'container networking', 'hubble', 'network observability', 'kubernetes network policy', 'cilium', 'aks networking'],
  fields: {
    nodes: { req: true, ask: 'How many Kubernetes nodes (virtual machines) in their AKS clusters will have Advanced Container Networking Services turned on? It is billed per node, so count every node in every cluster that uses it. For autoscaled clusters use the average number of nodes over the month. The nodes themselves are separate vm components.' },
    hours: { def: 730, ask: 'Hours a month each node has the feature on (730 = all month).' }
  },
  context: ['production'],
  examples: [
    { type: 'aks-acns', nodes: 3 },
    { type: 'aks-acns', nodes: 40, hours: 500 }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    return `Advanced Container Networking Services: ${fmtN(n(c.nodes))} AKS node(s), ${hrs === HOURS ? 'all month' : `${fmtN(hrs)} hours a month`}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The AKS cluster, its virtual machine nodes and disks (price them as aks and vm components)'
  ],
  price: async (c, ctx) => {
    const nodes = n(c.nodes);
    const hours = c.hours ?? HOURS;
    if (nodes < 0) throw new PricingError('nodes cannot be negative.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (/^usgov/i.test(ctx.region || '')) throw new PricingError('Advanced Container Networking Services has no published US Gov price, so it cannot be priced here.');
    const rs = await rows(`serviceName eq 'Advanced Container Networking Services' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    const m = single(rs.filter(r => r.meterName === 'Standard Node'), 'Advanced Container Networking Services node hours');
    const lines = [meterLine('Networking', 'Advanced Container Networking Services', `Advanced Container Networking Services, ${fmtN(nodes)} node(s) x ${fmtN(hours)} hours`, m, nodes * hours, ctx, { unit: 'node-hours' })];
    const notes = ['Advanced Container Networking Services is an add-on to AKS billed per node per hour on every node where it is enabled; the price is the same in every region.'];
    return { lines, notes, facts: { nodes, hours } };
  }
};
