'use strict';
// Public IP Prefix: a contiguous range of static public IPv4 addresses, billed per address per hour.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const GLOBAL_HOMES = ['centralus', 'eastasia', 'eastus2', 'northeurope', 'southeastasia', 'uksouth', 'usgovvirginia', 'westeurope', 'westus'];

module.exports = {
  type: 'public-ip-prefix',
  label: 'Public IP Prefix',
  family: 'networking',
  calculator: ['ip-addresses'],
  keywords: ['public ip prefix', 'ip range', 'contiguous public ips', 'static public ip range', 'ip allowlist', 'firewall allowlist', 'nat gateway prefix'],
  fields: {
    addresses: { req: true, enum: [2, 4, 8, 16, 32, 64, 128, 256], ask: 'How many public IPv4 addresses must sit together in one block? A block comes in sizes of 2 (/31), 4 (/30), 8 (/29) or 16 (/28) addresses; 16 is the default maximum, and 32, 64, 128 or 256 (/27 to /24) need a quota increase. Pick the smallest size that covers the need and record it as an assumption.' },
    prefixes: { def: 1, int: true, ask: 'How many separate blocks of that size? Use 1 if unknown.' },
    tier: { def: 'standard', enum: ['standard', 'standardv2', 'global'], ask: 'Regional block (standard or standardv2, which cost the same) or one used for cross-region load balancing (global)? Default standard.' },
    hours: { def: 730, ask: 'Hours a month the prefix exists (730 = all month). Billing starts as soon as the prefix is created, even if no address is in use.' }
  },
  examples: [
    { type: 'public-ip-prefix', addresses: 16 },
    { type: 'public-ip-prefix', addresses: 8, prefixes: 3, tier: 'global', hours: 400 }
  ],
  readback: c => {
    const hrs = n(c.hours ?? HOURS) === HOURS ? 'all month' : `${fmtN(c.hours)} hours a month`;
    return `Public IP Prefix (${c.tier || 'standard'}): ${fmtN(n(c.prefixes ?? 1))} block(s) of ${fmtN(n(c.addresses))} addresses, ${hrs}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Prefixes derived from a Custom IP Prefix (bring your own IP) are free; this prices Microsoft-owned prefixes.',
    'IPv6 prefixes: this component prices IPv4 prefixes only (public IPv6 addresses have no charge, Microsoft Learn).',
    'Bandwidth (data transfer out) for traffic using the addresses.'
  ]),
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const tier = c.tier || 'standard';
    if (![2, 4, 8, 16, 32, 64, 128, 256].includes(n(c.addresses))) throw new PricingError('addresses must be a prefix size: 2, 4, 8, 16, 32, 64, 128 or 256.');
    if (tier === 'global' && !GLOBAL_HOMES.includes(ctx.region)) throw new PricingError(`Global-tier public IP prefixes can only be created in the home regions (${GLOBAL_HOMES.join(', ')}); ${ctx.region} is not one of them.`);
    const rs = await rows(`serviceName eq 'Virtual Network' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Public IP Prefix'`, ctx);
    const meter = tier === 'global' ? 'Global Static Public IP' : 'Standard Static IP Addresses';
    const m = single(rs.filter(r => r.meterName === meter), `Public IP Prefix ${tier} address hour`);
    if (!m.length) throw new PricingError(`Public IP Prefix (${tier}) is not priced in ${ctx.region}.`);
    const prefixes = n(c.prefixes ?? 1), ips = n(c.addresses) * prefixes;
    const lines = [meterLine('Networking', 'Public IP Prefix', `Public IP Prefix (${tier}): ${fmtN(prefixes)} x ${fmtN(n(c.addresses))} addresses x ${fmtN(hours)} hours`, m, ips * hours, ctx, { unit: 'address-hours' })];
    return { lines, notes: ['Each address in the prefix is billed per hour from the moment the prefix is created, whether or not it is assigned.', 'Prefixes derived from a Custom IP Prefix (bring your own IP) are not charged.'], facts: { tier, addresses: ips, prefixes } };
  }
};
