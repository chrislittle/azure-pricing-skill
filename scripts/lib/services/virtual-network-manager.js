'use strict';
// Azure Virtual Network Manager: central management of virtual networks. Meters: serviceName 'Virtual Network',
// productName 'Azure Virtual Network Manager', regionless (Global). Two billing models: per managed virtual network
// per hour (default for instances created since February 2025) or per managed subscription per hour (older instances).
// Separate charges for IP address management (per active managed IP per hour) and network verifier reachability runs.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'virtual-network-manager',
  label: 'Azure Virtual Network Manager',
  family: 'networking-core',
  calculator: ['virtual-network-manager'],
  keywords: ['virtual network manager', 'avnm', 'network groups', 'security admin rules', 'ip address management', 'ipam', 'hub and spoke', 'network verifier'],
  fields: {
    billingModel: { def: 'virtual-network', enum: ['virtual-network', 'subscription'], ask: 'Do not ask unless they have an older Virtual Network Manager created before February 2025 that is still billed per subscription (then subscription). New instances are billed per virtual network (virtual-network).' },
    virtualNetworks: { req: true, int: true, min: 0, ask: 'How many virtual networks will have a Virtual Network Manager configuration (connectivity, security admin rules, routing...) deployed on them? A network with several configurations still counts once. Use 0 (skip it) if you are billed per subscription instead.' },
    subscriptions: { def: 0, int: true, min: 0, ask: 'Only for the older per-subscription billing: how many subscriptions contain a virtual network with an active configuration?' },
    managedIps: { def: 0, int: true, min: 0, ask: 'Only if they use IP address management (IPAM): roughly how many IP addresses on network interfaces in virtual networks tied to an IP address pool are active? Each active IP is billed per hour. Not the pool size.' },
    reachabilityRuns: { def: 0, int: true, min: 0, ask: 'Only if they use the network verifier: how many reachability analysis runs a month?' },
    hours: { def: 730, ask: 'Hours a month the networks, subscriptions and IPs are managed (730 = all month).' }
  },
  context: ['production', 'privateOnly'],
  examples: [
    { type: 'virtual-network-manager', virtualNetworks: 10 },
    { type: 'virtual-network-manager', virtualNetworks: 120, managedIps: 5000, reachabilityRuns: 200, hours: 730 },
    { type: 'virtual-network-manager', billingModel: 'subscription', virtualNetworks: 0, subscriptions: 6 }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    const time = hrs === HOURS ? 'all month' : `${fmtN(hrs)} hours a month`;
    const parts = [];
    if (c.billingModel === 'subscription') parts.push(`${fmtN(n(c.subscriptions))} managed subscription(s), billed per subscription, ${time}`);
    else parts.push(`${fmtN(n(c.virtualNetworks))} managed virtual network(s), ${time}`);
    if (n(c.managedIps)) parts.push(`${fmtN(c.managedIps)} active IP addresses under IP address management`);
    if (n(c.reachabilityRuns)) parts.push(`${fmtN(c.reachabilityRuns)} network verifier reachability runs a month`);
    return `Virtual Network Manager: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Virtual network peering traffic created by connectivity configurations (see the vnet-peering component)'
  ],
  price: async (c, ctx) => {
    const model = (c.billingModel || 'virtual-network').toLowerCase();
    if (!['virtual-network', 'subscription'].includes(model)) throw new PricingError(`Unknown billingModel "${c.billingModel}". Use virtual-network or subscription.`);
    const vnets = n(c.virtualNetworks), subs = n(c.subscriptions);
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    for (const k of ['virtualNetworks', 'subscriptions', 'managedIps', 'reachabilityRuns']) if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    if (model === 'virtual-network' && subs) throw new PricingError('subscriptions applies only to billingModel "subscription"; give virtualNetworks instead.');
    if (model === 'subscription' && vnets) throw new PricingError('virtualNetworks applies only to billingModel "virtual-network"; give subscriptions instead.');
    const gov = /^usgov/i.test(ctx.region || '');
    const rs = await rows(`serviceName eq 'Virtual Network' and productName eq 'Azure Virtual Network Manager' and armRegionName eq '${gov ? 'US Gov' : 'Global'}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError('Virtual Network Manager prices were not returned.');
    const m = (name, what) => {
      const hit = rs.filter(r => r.meterName === name);
      if (gov && !hit.length) throw new PricingError(`Virtual Network Manager ${what} has no published US Gov price, so it cannot be priced here.`);
      return single(hit, `Virtual Network Manager ${what}`);
    };
    const G = 'Networking', S = 'Virtual Network Manager', lines = [];
    if (model === 'subscription') {
      if (subs) lines.push(meterLine(G, S, `Managed subscriptions (older per-subscription billing), ${fmtN(subs)} x ${fmtN(hours)} hours`, m('Standard Subscription', 'managed subscriptions'), subs * hours, ctx, { unit: 'subscription-hours' }));
    } else if (vnets) {
      lines.push(meterLine(G, S, `Managed virtual networks, ${fmtN(vnets)} x ${fmtN(hours)} hours`, m('Standard Virtual Network', 'managed virtual networks'), vnets * hours, ctx, { unit: 'vnet-hours' }));
    }
    if (n(c.managedIps)) lines.push(meterLine(G, S, `IP address management, ${fmtN(c.managedIps)} active IPs x ${fmtN(hours)} hours`, m('Managed IP Management', 'managed IPs'), n(c.managedIps) * hours, ctx, { unit: 'IP-hours' }));
    if (n(c.reachabilityRuns)) lines.push(meterLine(G, S, `Network verifier reachability analysis runs, ${fmtN(c.reachabilityRuns)}`, m('Reachability Analysis Diagnostic Tool API', 'reachability analysis'), n(c.reachabilityRuns), ctx, { unit: 'runs' }));
    if (!lines.length) throw new PricingError('Nothing to price: set the managed virtual networks (or subscriptions), managed IPs or reachability runs.');
    const notes = [
      model === 'subscription'
        ? 'Older instances are billed per hour for each subscription that contains a virtual network with an active configuration; they can opt in to per-virtual-network billing.'
        : 'Billing is per hour for each virtual network that has a Virtual Network Manager configuration deployed; several configurations on one network are charged once.',
      'IP address management and the network verifier are charged separately from the manager itself. ' + (gov ? 'US Gov regions have their own, higher, prices (the per-subscription billing model, the network verifier and some other items are not offered there).' : 'Prices are the same in every commercial region; US Gov regions are priced higher.')
    ];
    return { lines, notes, facts: { billingModel: model, virtualNetworks: vnets, subscriptions: subs, managedIps: n(c.managedIps), reachabilityRuns: n(c.reachabilityRuns), hours } };
  }
};
