'use strict';
// Azure Load Balancer, Gateway tier (gateway hours, chain hours, data processed) and the
// cross-region (Global tier) Standard load balancer (rules per hour; no data-processed charge).
// Meters: serviceName 'Load Balancer', regionless (armRegionName 'Global').
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
// Home regions where a Global-tier load balancer can be deployed (Learn: cross-region-overview).
const GLOBAL_HOMES = ['centralus', 'eastasia', 'eastus2', 'northeurope', 'southeastasia', 'uksouth', 'usgovvirginia', 'westeurope', 'westus'];

module.exports = {
  type: 'gateway-load-balancer',
  label: 'Azure Load Balancer: Gateway and cross-region (Global) tiers',
  family: 'networking',
  calculator: ['load-balancer'],
  keywords: ['gateway load balancer', 'network virtual appliance', 'firewall appliance', 'cross-region load balancer', 'global load balancer', 'nva', 'service chaining'],
  fields: {
    kind: { req: true, enum: ['gateway', 'global'], ask: 'Do they need to insert network appliances such as third-party firewalls into the traffic path (a Gateway Load Balancer -> gateway), or one public address that spreads traffic across several Azure regions (a cross-region load balancer -> global)? Map the answer to gateway or global. A plain regional Standard load balancer is the separate load-balancer component.' },
    gatewayLoadBalancers: { def: 1, int: true, ask: 'Gateway only: how many Gateway Load Balancers (one per set of appliances)? Use 1 if unknown and record it as an assumption.' },
    chains: { def: 1, int: true, ask: 'Gateway only: how many Standard load balancer front-ends or VM network IP configurations send their traffic through the appliances (each link is called a chain)?' },
    dataGB: { def: 0, ask: 'Gateway only: roughly how many GB a month of traffic is processed by the Gateway Load Balancer? If unknown, suggest 1,000 GB and record it as an assumption. Cross-region load balancers have no data-processed charge.' },
    rules: { def: 5, int: true, ask: 'Global only: how many load-balancing rules does the cross-region load balancer have in total (outbound rules count too)? The first 5 are covered by one hourly price.' },
    hours: { def: 730, ask: 'Hours a month the load balancer exists (730 = all month).' }
  },
  context: ['multiRegionUsers'],
  examples: [
    { type: 'gateway-load-balancer', kind: 'gateway', dataGB: 2000 },
    { type: 'gateway-load-balancer', kind: 'gateway', gatewayLoadBalancers: 2, chains: 6, dataGB: 10000, hours: 500 },
    { type: 'gateway-load-balancer', kind: 'global', rules: 8 }
  ],
  readback: c => {
    const hrs = n(c.hours ?? HOURS) === HOURS ? 'all month' : `${fmtN(c.hours)} hours a month`;
    if (c.kind === 'global') return `Cross-region (Global tier) load balancer: ${fmtN(n(c.rules ?? 5))} load-balancing rules, ${hrs}`;
    return `Gateway Load Balancer: ${fmtN(n(c.gatewayLoadBalancers ?? 1))} gateway(s), ${fmtN(n(c.chains ?? 1))} chain(s), ${fmtN(n(c.dataGB))} GB processed a month, ${hrs}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The regional Standard load balancers and public IP addresses that sit behind it, and the appliance or backend VMs.',
    'Bandwidth: data-processed charges are in addition to internet or inter-region data transfer.'
  ]),
  price: async (c, ctx) => {
    const kind = c.kind;
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const rs = await rows(`serviceName eq 'Load Balancer' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    const m = (sku, name, what) => single(rs.filter(r => r.skuName === sku && r.meterName === name), what);
    const G = 'Networking', S = 'Load Balancer', lines = [], notes = [];
    if (kind === 'gateway') {
      const gws = n(c.gatewayLoadBalancers ?? 1), chains = n(c.chains ?? 1);
      lines.push(meterLine(G, S, `Gateway Load Balancer: ${fmtN(gws)} gateway(s) x ${fmtN(hours)} hours`, m('Gateway', 'Gateway', 'Gateway hour'), gws * hours, ctx, { unit: 'hours' }));
      if (chains) lines.push(meterLine(G, S, `Gateway Load Balancer chains: ${fmtN(chains)} x ${fmtN(hours)} hours`, m('Gateway', 'Gateway Chain', 'Gateway chain hour'), chains * hours, ctx, { unit: 'hours' }));
      if (n(c.dataGB)) lines.push(meterLine(G, S, `Gateway Load Balancer data processed, ${fmtN(c.dataGB)} GB/month`, m('Gateway', 'Gateway Data Processed', 'Gateway data processed'), n(c.dataGB), ctx, { unit: 'GB' }));
      notes.push('A chain is the link between a Gateway Load Balancer and a Standard load balancer front-end or a VM network IP configuration that sends its traffic through it; each chain is billed per hour.');
      notes.push('Data processed is billed in addition to bandwidth charges.');
      return { lines, notes, facts: { kind, gatewayLoadBalancers: gws, chains, dataGB: n(c.dataGB) } };
    }
    if (kind !== 'global') throw new PricingError('kind must be "gateway" or "global".');
    if (!GLOBAL_HOMES.includes(ctx.region)) throw new PricingError(`A cross-region (Global tier) load balancer can only be deployed in one of its home regions (${GLOBAL_HOMES.join(', ')}); ${ctx.region} is not one of them.`);
    const rules = n(c.rules ?? 5);
    if (rules < 1) throw new PricingError('A cross-region load balancer needs at least 1 rule.');
    lines.push(meterLine(G, S, `Cross-region load balancer: first ${fmtN(Math.min(rules, 5))} rules (one price covers up to 5) x ${fmtN(hours)} hours`, m('Global', 'Global Included LB Rules and Outbound Rules', 'Global included rules'), hours, ctx, { unit: 'hours' }));
    if (rules > 5) lines.push(meterLine(G, S, `Cross-region load balancer: ${fmtN(rules - 5)} additional rules x ${fmtN(hours)} hours`, m('Global', 'Global Overage LB Rules and Outbound Rules', 'Global overage rules'), (rules - 5) * hours, ctx, { unit: 'rule-hours' }));
    notes.push('The first 5 rules share one hourly price; each additional rule is billed per rule per hour. Inbound NAT rules are free.');
    notes.push('There is no additional data-processed charge for packets routed from a Global-tier load balancer to a regional load balancer; the regional load balancers are billed on their own.');
    return { lines, notes, facts: { kind, rules, hours } };
  }
};
