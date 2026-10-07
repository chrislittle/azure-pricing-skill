'use strict';
// Microsoft Entra Domain Services (managed Active Directory domain).
// Meters: serviceName 'Microsoft Entra Domain Services', regional, per hour per replica set.
// One meter per SKU x forest type ("<Sku> User Forest" / "<Sku> Resource Forest"); Standard has no resource forest.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'entra-domain-services',
  label: 'Microsoft Entra Domain Services',
  family: 'identity',
  calculator: ['active-directory-ds'],
  keywords: ['active directory', 'domain services', 'managed domain', 'domain controller', 'ldap', 'kerberos', 'group policy', 'domain join'],
  fields: {
    sku: { req: true, def: 'enterprise', enum: ['standard', 'enterprise', 'premium'], ask: 'How many users, groups and computers will be in the directory, and roughly how many sign-ins per hour at peak? Take the larger size of the two: up to 25,000 objects or 3,000 sign-ins an hour -> standard; up to 100,000 objects or 10,000 an hour -> enterprise (the usual default); up to 500,000 objects or 70,000 an hour -> premium. These are Microsoft guidance, not hard limits. Standard cannot have extra replica sets or a resource forest.' },
    forestType: { def: 'user', enum: ['user', 'resource'], ask: 'Should the domain also trust an existing on-premises Active Directory forest so those users can sign in to it (a one-way or two-way trust)? Only if they need that -> resource; otherwise user (a normal synchronised domain). Resource needs enterprise or premium.' },
    replicaSets: { def: 1, int: true, min: 1, max: 5, ask: 'How many replica sets (copies of the domain, each in its own region, for resilience)? 1 is a single domain; each extra region adds one. Up to 5, and more than 1 needs enterprise or premium.' },
    hours: { def: 730, ask: 'How many hours a month does the managed domain exist? Leave at 730 for all month; it is billed for every hour it exists, even if unused.' }
  },
  context: ['production'],
  examples: [
    { type: 'entra-domain-services', sku: 'enterprise' },
    { type: 'entra-domain-services', sku: 'premium', forestType: 'resource', replicaSets: 3, hours: 730 }
  ],
  readback: c => {
    const sets = n(c.replicaSets ?? 1) || 1;
    const hours = n(c.hours ?? HOURS);
    return `Entra Domain Services ${c.sku || 'enterprise'} SKU, ${c.forestType === 'resource' ? 'resource forest (trusts an on-premises forest)' : 'user forest (synchronised users)'}, ${fmtN(sets)} replica set(s), ${hours < HOURS ? `${fmtN(hours)} hours a month` : 'running all month'}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.length) ? [] : [
    ...(types.has('load-balancer') ? [] : ['The Standard Load Balancer that Domain Services always deploys for itself is priced separately (add a load-balancer component)']),
    ...(types.has('public-ip') ? [] : ['The Standard public IP address that Domain Services always deploys for itself is priced separately (add a public-ip component)']),
    'The virtual network, VMs joined to the domain, and any VPN or ExpressRoute link to an on-premises directory'
  ],
  price: async (c, ctx) => {
    const sku = (c.sku || 'enterprise').toLowerCase();
    const forest = (c.forestType || 'user').toLowerCase();
    const sets = c.replicaSets ?? 1;
    const hours = c.hours ?? HOURS;
    if (!['standard', 'enterprise', 'premium'].includes(sku)) throw new PricingError(`Unknown sku "${c.sku}". Use standard, enterprise or premium.`);
    if (!['user', 'resource'].includes(forest)) throw new PricingError(`Unknown forestType "${c.forestType}". Use user or resource.`);
    if (!Number.isInteger(sets) || sets < 1 || sets > 5) throw new PricingError('replicaSets must be a whole number from 1 to 5 (the first domain counts as one).');
    if (sku === 'standard' && sets > 1) throw new PricingError('Extra replica sets need the enterprise or premium sku.');
    if (sku === 'standard' && forest === 'resource') throw new PricingError('A resource forest is not available on the standard sku; use enterprise or premium.');
    const Sku = sku.charAt(0).toUpperCase() + sku.slice(1);
    const rs = await rows(`serviceName eq 'Microsoft Entra Domain Services' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Microsoft Entra Domain Services is not priced in ${ctx.region}.`);
    const want = `${Sku} ${forest === 'resource' ? 'Resource' : 'User'} Forest`;
    if (forest === 'resource' && !rs.some(r => r.meterName === want) && rs.some(r => r.meterName === `${Sku} User Forest`)) throw new PricingError(`A resource forest is not offered in ${ctx.region}; the user-forest rate is the same, so use forestType user or another region.`);
    const meter = single(rs.filter(r => r.meterName === want), `Domain Services ${Sku} ${forest} forest`);
    const lines = [meterLine('Security', 'Microsoft Entra Domain Services', `Domain Services ${Sku}, ${forest} forest, ${fmtN(sets)} replica set(s) x ${fmtN(hours)} hours`, meter, sets * hours, ctx, { unit: 'hours' })];
    const notes = ['Domain Services bills per hour for each replica set at the SKU rate; the first domain is replica set 1 and every extra replica set is billed the same hourly rate.',
      'There is no per-user or per-object charge: the price depends only on the SKU, forest type, replica sets and hours.'];
    return { lines, notes, facts: { sku, forestType: forest, replicaSets: sets, hours } };
  }
};
