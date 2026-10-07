'use strict';
// Nutanix Cloud Clusters (NC2) on Azure: Azure bare-metal "Ready Nodes for Nutanix", billed per node-hour.
// Meters: serviceName 'Specialized Compute', productName 'Ready Nodes for Nutanix', regional.
// Only the Azure hardware is metered by Azure; the Nutanix NC2 software licence is bought from Nutanix.
const { rows, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);
const NODES = {
  an36: { name: 'AN36', sku: 'ANRN36', spec: '36 cores, 576 GB RAM' },
  an36p: { name: 'AN36P', sku: 'ANRN36P', spec: '36 cores, 768 GB RAM, NVMe/Optane storage' },
  an64: { name: 'AN64', sku: 'AN64', spec: '64 cores, 1 TB RAM, all-NVMe storage' }
};
const termWord = t => t.toLowerCase().replace(/^(\d+) years?$/, '$1-year');
const COMMIT = { payg: null, 'reservation-1y': '1 Year', 'reservation-3y': '3 Years' };

module.exports = {
  type: 'nutanix-nc2',
  label: 'Nutanix Cloud Clusters (NC2) on Azure',
  family: 'compute-other',
  calculator: ['nutanix-on-azure'],
  keywords: ['nutanix', 'nc2', 'ahv', 'bare metal', 'hyperconverged', 'nutanix cluster', 'hci'],
  fields: {
    nodes: { req: true, int: true, min: 3, max: 28, ask: 'How many bare-metal nodes does the Nutanix cluster need? A cluster needs at least 3 nodes (up to 28). If they only know their VM count, suggest 3 and record it as an assumption.' },
    nodeType: { def: 'an36p', enum: Object.keys(NODES), ask: 'Which node type? an36p (36 cores, 768 GB RAM), an64 (64 cores, 1 TB RAM, more storage) or an36 (36 cores, 576 GB, sold in very few regions). Each region sells only some node types (an36p and an64 are each sold in about 12 regions), so pick the type sold in the chosen region; the estimate lists the options if it is not sold. If unknown, suggest an36p and record it as an assumption.' },
    hours: { def: 730, ask: 'How many hours a month do the nodes exist? Nodes bill every hour they are provisioned (730 = all month). Reservations ignore this.' },
    commitment: { def: 'payg', enum: Object.keys(COMMIT), ask: 'Will the nodes run for a year or more? No -> payg; 1 year -> reservation-1y; 3 years -> reservation-3y. If unknown use payg.' }
  },
  context: ['production', 'steadyUsage'],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The Nutanix Cloud Clusters software licence: it is bought separately - from Azure Marketplace, a Nutanix partner, or an existing Nutanix licence - and is not included here.',
    'Connectivity (ExpressRoute or VPN) between on-premises and the cluster, and outbound data transfer.',
    'Azure services used alongside the cluster, such as Azure Virtual Network, Azure Storage for backups, and monitoring.'
  ]),
  examples: [
    { type: 'nutanix-nc2', nodes: 3, nodeType: 'an36p' },
    { type: 'nutanix-nc2', nodes: 4, nodeType: 'an36p', hours: 400 },
    { type: 'nutanix-nc2', nodes: 3, nodeType: 'an36p', commitment: 'reservation-1y' },
    { type: 'nutanix-nc2', nodes: 5, nodeType: 'an36p', commitment: 'reservation-3y' }
  ],
  readback: c => {
    const h = NODES[c.nodeType || 'an36p'] || { name: c.nodeType, spec: '' };
    const ct = COMMIT[c.commitment || 'payg'];
    const hrs = c.hours ?? HOURS;
    const when = ct ? `${termWord(ct)} reservation` : `pay as you go, ${hrs === HOURS ? 'running all month (730 hours)' : `${fmtN(hrs)} hours a month`}`;
    return `Nutanix Cloud Clusters on Azure: ${fmtN(n(c.nodes))} ${h.name} bare-metal node(s) (${h.spec}), ${when}; Nutanix software licence not included`;
  },
  price: async (c, ctx) => {
    const key = c.nodeType || 'an36p';
    const h = NODES[key];
    if (!h) throw new PricingError(`Unknown nodeType "${key}". Use one of: ${Object.keys(NODES).join(', ')}.`);
    const nodes = n(c.nodes), hours = c.hours ?? HOURS;
    if (!Number.isInteger(nodes) || nodes < 3) throw new PricingError('A Nutanix cluster on Azure needs a whole number of at least 3 bare-metal nodes.');
    if (nodes > 28) throw new PricingError('A Nutanix cluster on Azure supports at most 28 nodes; split the estimate into several clusters.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const commitment = c.commitment || 'payg';
    if (!(commitment in COMMIT)) throw new PricingError(`Unknown commitment "${commitment}". Use payg, reservation-1y or reservation-3y.`);
    const term = COMMIT[commitment];
    const rs = await rows(`serviceName eq 'Specialized Compute' and ${regionFilter(ctx)} and productName eq 'Ready Nodes for Nutanix' and skuName eq '${h.sku}'`, ctx);
    const payg = rs.filter(r => r.type === 'Consumption');
    if (payg.length !== 1) {
      const any = await rows(`serviceName eq 'Specialized Compute' and ${regionFilter(ctx)} and productName eq 'Ready Nodes for Nutanix' and priceType eq 'Consumption'`, ctx);
      const here = Object.values(NODES).filter(x => any.some(r => r.skuName === x.sku && r.retailPrice > 0)).map(x => x.name);
      throw new PricingError(here.length ? `Nutanix ${h.name} nodes are not sold in ${ctx.region}. Node types sold there: ${here.join(', ')}.` : `Nutanix Cloud Clusters on Azure is not offered in ${ctx.region}.`);
    }
    const label = `Nutanix ${h.name} bare-metal node`;
    const lines = [], notes = [];
    if (!term) lines.push(meterLine('Compute', 'Specialized Compute', `${label}: ${fmtN(nodes)} node(s) x ${fmtN(hours)} hours`, payg, nodes * hours, ctx, { unit: 'node-hours' }));
    else {
      const rr = rs.find(r => r.type === 'Reservation' && r.reservationTerm === term);
      if (!rr) throw new PricingError(`No ${term} reservation for ${h.name} nodes in ${ctx.region}.`);
      const months = termMonths(term), monthly = rr.retailPrice / months;
      lines.push(line('Compute', 'Specialized Compute', `${label}: ${fmtN(nodes)} node(s), ${termWord(term)} reservation`, nodes, 'node / month', monthly, monthly * nodes, meterInfo(rr), { termTotal: rr.retailPrice }));
      notes.push(`${term} reservation: ${fmtN(rr.retailPrice)} is the whole-term price per node, divided by ${months} months. It is billed whether or not the node is used.`);
    }
    notes.unshift('Azure bills the bare-metal nodes per hour while they are provisioned. A cluster needs at least 3 nodes. The Nutanix NC2 software licence is bought separately (Azure Marketplace, a Nutanix partner, or an existing licence) and is not in this estimate. Microsoft offers a free 30-day NC2 trial; ask your Azure specialist if this is a proof of concept.');
    return { lines, notes, facts: { nodeType: h.name, nodes, hours, commitment, paygHourly: payg[0].retailPrice } };
  }
};
