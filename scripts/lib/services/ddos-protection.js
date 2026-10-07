'use strict';
// Azure DDoS Protection: Network Protection (one plan per tenant covering 100 public IP resources, per-resource overage beyond that)
// and IP Protection (per protected public IP resource).
// Meters: serviceName 'Azure DDOS Protection', regional. A "Network Protection Data Processed" meter exists in the
// Retail API but is not listed on the Microsoft pricing page, so it is not priced here.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const INCLUDED = 100;

module.exports = {
  type: 'ddos-protection',
  label: 'Azure DDoS Protection',
  family: 'network-security',
  calculator: ['ddos-protection'],
  keywords: ['ddos', 'denial of service', 'attack protection', 'network protection', 'ip protection', 'public ip protection'],
  fields: {
    tier: { req: true, enum: ['network', 'ip'], ask: 'Which protection fits? A handful of critical addresses (about 14 or fewer) -> ip (billed per address). Many addresses, a whole network, or they want rapid-response support and cost credits during an attack -> network (one plan for the whole tenant). If unknown, suggest ip for a small estate and record it as an assumption.' },
    publicIps: { req: true, int: true, min: 0, ask: 'How many public IP addresses (resources) should be protected? Count each public IP used by VMs, load balancers, application gateways, firewalls and so on. If unknown, suggest 10 and record it as an assumption.' },
    hours: { def: 730, ask: 'How many hours a month is protection switched on (730 = all month)? Network Protection bills from when the plan is created, IP Protection from when the address is enabled.' }
  },
  context: ['production', 'internetFacing'],
  examples: [
    { type: 'ddos-protection', tier: 'ip', publicIps: 5 },
    { type: 'ddos-protection', tier: 'network', publicIps: 130, hours: 730 },
    { type: 'ddos-protection', tier: 'network', publicIps: 40 }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    const when = hrs === HOURS ? 'protection on all month' : `protection on ${fmtN(hrs)} hours a month`;
    return c.tier === 'ip'
      ? `Azure DDoS IP Protection: ${fmtN(n(c.publicIps))} public IP resource(s) protected individually, ${when}`
      : `Azure DDoS Network Protection: one tenant-wide plan covering ${fmtN(n(c.publicIps))} public IP resource(s) (100 included, extra billed each), ${when}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    ...(((spec && spec.options) || []).some(o => { const cs = o.components || []; return cs.some(c => c.type === 'ddos-protection' && c.tier === 'ip') && cs.some(c => c.type === 'ddos-protection' && c.tier === 'network'); }) ? ['This option has both IP Protection and Network Protection components: a public IP already covered by a Network Protection plan is not billed again as IP Protection, so check for double counting.'] : []),
    ...(((spec && spec.options) || []).some(o => (o.components || []).filter(c => c.type === 'ddos-protection' && (c.tier || 'network') === 'network').length > 1) ? ['This option has more than one Network Protection component: one plan covers the whole tenant (100 public IP resources), so a second plan is usually double billing; use publicIps on one component instead.'] : []),
    'The protected resources themselves (public IPs, load balancers, application gateways, VMs) are priced separately.'
  ],
  price: async (c, ctx) => {
    const tier = c.tier || 'network';
    if (tier !== 'network' && tier !== 'ip') throw new PricingError('tier must be "network" (Network Protection) or "ip" (IP Protection).');
    const ips = n(c.publicIps), hours = c.hours ?? HOURS;
    if (ips < 0) throw new PricingError('publicIps cannot be negative.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const rs = await rows(`serviceName eq 'Azure DDOS Protection' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const m = (name, what) => {
      const hit = rs.filter(r => r.meterName === name);
      if (!hit.length) throw new PricingError(`Azure DDoS Protection (${what}) is not priced in ${ctx.region}; a Network Protection plan is tenant-wide and covers virtual networks in any region, so price it in a nearby region where it is listed.`);
      return single(hit, `Azure DDoS Protection ${what}`);
    };
    const G = 'Networking', S = 'Azure DDOS Protection', lines = [], notes = [];
    if (tier === 'ip') {
      lines.push(meterLine(G, S, `DDoS IP Protection: ${fmtN(ips)} public IP resource(s) x ${fmtN(hours)} hours`, m('IP Protection Resource', 'IP Protection'), ips * hours, ctx, { unit: 'hours' }));
      notes.push('IP Protection is billed per protected public IP resource and scales linearly with the number of addresses; if the virtual network also has a DDoS protection plan, Network Protection billing applies instead.');
    } else {
      const over = Math.max(0, ips - INCLUDED);
      lines.push(meterLine(G, S, `DDoS Network Protection plan: 1 plan x ${fmtN(hours)} hours (includes ${INCLUDED} public IP resources)`, m('Network Protection Plan', 'Network Protection plan'), hours, ctx, { unit: 'hours' }));
      if (over) lines.push(meterLine(G, S, `DDoS Network Protection overage: ${fmtN(over)} public IP resource(s) beyond ${INCLUDED} x ${fmtN(hours)} hours`, m('Network Protection Resource', 'overage resource'), over * hours, ctx, { unit: 'hours' }));
      notes.push('One Network Protection plan can protect virtual networks across every subscription in the tenant; the fixed monthly charge covers up to 100 public IP resources, and each additional resource is billed per month.');
    }
    if (tier === 'network') notes.push('An Application Gateway with WAF inside a virtual network protected by Network Protection is billed at the non-WAF rate; apply that discount to the gateway estimate.');
    return { lines, notes, facts: { tier, publicIps: ips, overageIps: tier === 'network' ? Math.max(0, ips - INCLUDED) : 0, hours } };
  }
};
