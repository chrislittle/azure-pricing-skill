'use strict';
// Application Gateway for Containers (Standard and WAF): gateway hours, frontends, associations,
// capacity units. Meters: serviceName 'Application Gateway', regional (about 24 regions).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'app-gateway-containers',
  label: 'Application Gateway for Containers',
  family: 'networking',
  calculator: ['application-gateway'],
  keywords: ['application gateway for containers', 'kubernetes ingress', 'aks ingress', 'gateway api', 'layer 7 load balancer for containers', 'agc', 'container ingress'],
  fields: {
    capacityUnits: { req: true, ask: 'On average, how many capacity units will it use? Work it out from busy-time numbers: the larger of (simultaneous connections / 2,500) and (Mbps / 2.22), rounded up. One capacity unit covers about 2,500 persistent connections or 2.22 Mbps of throughput. If unknown, suggest 5 (the value in Microsoft\'s own pricing example) and record it as an assumption.' },
    waf: { def: false, ask: 'Will it face the internet and need a web application firewall (WAF) to block common attacks? Yes -> true. WAF has higher rates on every meter.' },
    gateways: { def: 1, int: true, ask: 'How many Application Gateway for Containers resources (one per Kubernetes cluster entry point)? Use 1 if unknown.' },
    frontends: { int: true, ask: 'How many frontends (public entry points, each with its own DNS name)? Leave out to use one per gateway; each gateway allows up to 5.' },
    associations: { int: true, ask: 'How many associations (links from a gateway to a subnet of the cluster network)? Leave out to use one per gateway; each gateway has exactly one today.' },
    hours: { def: 730, ask: 'Hours a month it exists (730 = all month).' }
  },
  context: ['production', 'internetFacing'],
  examples: [
    { type: 'app-gateway-containers', capacityUnits: 5 },
    { type: 'app-gateway-containers', waf: true, gateways: 2, frontends: 3, associations: 2, capacityUnits: 12, hours: 600 }
  ],
  readback: c => {
    const hrs = n(c.hours ?? HOURS) === HOURS ? 'all month' : `${fmtN(c.hours)} hours a month`;
    return `Application Gateway for Containers${c.waf ? ' with web application firewall' : ''}: ${fmtN(n(c.gateways ?? 1))} gateway(s), ${fmtN(n(c.frontends ?? c.gateways ?? 1))} frontend(s), ${fmtN(n(c.associations ?? c.gateways ?? 1))} association(s), ${fmtN(n(c.capacityUnits))} capacity units on average, ${hrs}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The AKS cluster and its nodes, and bandwidth (data transfer out) charges.'
  ]),
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const product = c.waf ? 'Application Gateway for Containers WAF' : 'Application Gateway for Containers';
    const rs = await rows(`serviceName eq 'Application Gateway' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq '${product}'`, ctx);
    if (!rs.length) throw new PricingError(`Application Gateway for Containers is not priced in ${ctx.region}.`);
    const m = (name, what) => single(rs.filter(r => r.meterName === name), `${product} ${what}`);
    const G = 'Networking', S = 'Application Gateway', gws = n(c.gateways ?? 1), fe = n(c.frontends ?? gws), asc = n(c.associations ?? gws), cu = n(c.capacityUnits);
    if (gws < 1) throw new PricingError('gateways must be at least 1.');
    if (asc > gws) throw new PricingError('Each Application Gateway for Containers resource supports one association today, so associations cannot exceed gateways.');
    if (fe > gws * 5) throw new PricingError('Each Application Gateway for Containers resource supports up to 5 frontends.');
    const w = c.waf ? ' (WAF)' : '';
    const lines = [];
    if (gws) lines.push(meterLine(G, S, `Application Gateway for Containers${w}: ${fmtN(gws)} gateway(s) x ${fmtN(hours)} hours`, m('Standard AGC', 'gateway hours'), gws * hours, ctx, { unit: 'hours' }));
    if (fe) lines.push(meterLine(G, S, `Frontends${w}: ${fmtN(fe)} x ${fmtN(hours)} hours`, m('Standard Frontend', 'frontend hours'), fe * hours, ctx, { unit: 'hours' }));
    if (asc) lines.push(meterLine(G, S, `Associations${w}: ${fmtN(asc)} x ${fmtN(hours)} hours`, m('Standard Association', 'association hours'), asc * hours, ctx, { unit: 'hours' }));
    if (cu) lines.push(meterLine(G, S, `Capacity units${w}: ${fmtN(cu)} on average x ${fmtN(hours)} hours`, m('Standard Capacity Units', 'capacity unit hours'), cu * hours, ctx, { unit: 'capacity unit-hours' }));
    const notes = ['Billing is per hour for the gateway resource, each frontend, each association and the capacity units used; there is no data-processed charge.',
      'A capacity unit covers about 2,500 persistent connections or 2.22 Mbps of throughput; the busiest of the measures sets the units billed.'];
    if (c.waf) notes.push('With WAF enabled every meter is billed at the higher WAF rate and the firewall itself uses more capacity units.');
    return { lines, notes, facts: { waf: !!c.waf, gateways: gws, frontends: fe, associations: asc, capacityUnits: cu, hours } };
  }
};
