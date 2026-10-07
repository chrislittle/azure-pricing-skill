'use strict';
// Azure Notification Hubs (push notifications). Meters: serviceName 'Notification Hubs', regional.
// A namespace is billed a monthly base charge per tier; pushes are billed in graduated bands per 1 million and the
// included pushes are shared by all namespaces of the same tier in a subscription. Zone redundancy and Private Link
// are per-namespace monthly add-ons.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

// Regions where Notification Hubs always turns zone redundancy on (Learn: Reliability in Azure Notification Hubs).
const FORCED_ZR = new Set(['francecentral', 'italynorth', 'norwayeast', 'polandcentral', 'swedencentral', 'switzerlandnorth', 'qatarcentral', 'southafricanorth', 'koreacentral', 'chinanorth3']);

module.exports = {
  type: 'notification-hubs',
  label: 'Azure Notification Hubs',
  family: 'messaging',
  calculator: ['notification-hubs'],
  keywords: ['push notifications', 'mobile push', 'apns', 'fcm', 'notifications', 'mobile app', 'device registration'],
  fields: {
    tier: { def: 'basic', enum: ['free', 'basic', 'standard'], ask: 'How big is the app? Just trying it out with up to 500 devices and 1 million pushes a month, no SLA -> free; up to 200,000 devices -> basic; up to millions of devices or needing rich delivery telemetry -> standard.' },
    namespaces: { def: 1, int: true, min: 1, ask: 'How many namespaces (usually one per app and environment, such as one for production and one for test)? If unknown use 1 and record it as an assumption.' },
    pushes: { req: true, int: true, min: 0, ask: 'How many push notifications do you send a month in total (each message to each device counts as one push)? If unknown, suggest 5 million and record it as an assumption.' },
    zoneRedundant: { def: false, ask: 'Must push sending keep working if one datacenter in the region fails? Yes -> zone redundancy, an extra monthly charge for each namespace; it can only be chosen when the namespace is created. (In France Central, Italy North, Norway East, Poland Central, Sweden Central, Switzerland North, Qatar Central, South Africa North and Korea Central it is always on and charged, whatever the answer.)' },
    privateLink: { def: false, ask: 'Must the namespace be reachable only over a private network connection (Private Link)? Yes -> true.' }
  },
  context: ['production'],
  examples: [
    { type: 'notification-hubs', tier: 'basic', pushes: 25000000 },
    { type: 'notification-hubs', tier: 'standard', namespaces: 2, pushes: 150000000, zoneRedundant: true, privateLink: true }
  ],
  readback: (c, spec) => `Notification Hubs ${c.tier || 'basic'} tier: ${fmtN(n(c.namespaces ?? 1))} namespace(s), ${fmtN(n(c.pushes))} pushes a month${c.zoneRedundant || FORCED_ZR.has(String((spec && spec.region) || '').toLowerCase().replace(/\s+/g, '')) ? ', zone redundant' : ''}${c.privateLink ? ', with Private Link' : ''}`,
  notIncluded: () => ['The Apple (APNs) and Google (FCM) accounts and any back-end that sends the notifications', 'The "1P Direct Send" pushes meter is left out on purpose: it is in the Retail API but not in the calculator or on the pricing page (first-party use)'],
  price: async (c, ctx) => {
    const tier = (c.tier || 'basic').toLowerCase();
    if (!['free', 'basic', 'standard'].includes(tier)) throw new PricingError(`Unknown tier "${c.tier}". Use free, basic or standard.`);
    const ns = c.namespaces ?? 1;
    if (!Number.isInteger(ns) || ns < 1) throw new PricingError('namespaces must be a whole number of 1 or more.');
    const pushes = n(c.pushes);
    if (tier === 'free' && pushes > 1000000) throw new PricingError('The free tier includes only 1 million pushes a month and cannot be exceeded; use the basic or standard tier.');
    const rs = await rows(`serviceName eq 'Notification Hubs' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Notification Hubs is not priced in ${ctx.region}.`);
    const Tier = tier.charAt(0).toUpperCase() + tier.slice(1);
    if (!rs.some(r => r.meterName === `${Tier} Unit`)) throw new PricingError(`The ${tier} tier of Notification Hubs is not offered in ${ctx.region}; choose ${['free', 'basic', 'standard'].filter(t => t !== tier && rs.some(r => r.meterName === `${t.charAt(0).toUpperCase() + t.slice(1)} Unit`)).join(' or ') || 'another region'}${rs.some(r => /Unit$/.test(r.meterName) && !/^(Availability|Private)/.test(r.meterName)) ? ' instead, or another region' : ''}.`);
    const S = 'Notification Hubs', G = 'Integration';
    const lines = [meterLine(G, S, `${Tier} tier, ${fmtN(ns)} namespace(s) base charge`, single(rs.filter(r => r.meterName === `${Tier} Unit`), `${Tier} namespace`), ns, ctx, { unit: 'namespaces / month' })];
    let included = 10;
    if (tier !== 'free') {
      const pr = single(rs.filter(r => r.meterName === `${Tier} Pushes`), `${Tier} pushes`);
      // The included allowance is the start of the first paid band (US Government regions have none).
      included = Math.min(...pr.filter(r => r.retailPrice > 0).map(r => r.tierMinimumUnits));
      lines.push(meterLine(G, S, `${Tier} tier pushes, ${fmtN(pushes)}/month (${included > 0 ? `first ${fmtN(included)} million included` : 'no pushes included in this region'})`, pr, pushes, ctx, { unit: 'pushes' }));
    }
    const zr = !!c.zoneRedundant || FORCED_ZR.has(ctx.region);
    if (zr) lines.push(meterLine(G, S, `Zone redundancy, ${fmtN(ns)} namespace(s)`, single(rs.filter(r => r.meterName === 'Availability Zones Unit'), 'zone redundancy'), ns, ctx, { unit: 'namespaces / month' }));
    if (c.privateLink) lines.push(meterLine(G, S, `Private Link, ${fmtN(ns)} namespace(s)`, single(rs.filter(r => r.meterName === 'Private Link Unit'), 'Private Link'), ns, ctx, { unit: 'namespaces / month' }));
    const inc = included > 0 ? `The first ${fmtN(included)} million pushes a month are included and shared by all ${Tier} namespaces in the subscription` : 'No pushes are included in this region';
    const notes = {
      free: ['Free tier: 1 million pushes and 500 active devices included; over the limit, new device registrations stop and extra pushes are dropped. It has no SLA.'],
      basic: [`Basic tier: each namespace has a monthly base charge. ${inc}; pushes beyond it are billed per million. Up to 200,000 active devices.`],
      standard: [`Standard tier: each namespace has a monthly base charge. ${inc}; pushes beyond it are billed per million, at a lower rate in the higher bands. Up to 10 million active devices.`]
    }[tier];
    if (FORCED_ZR.has(ctx.region)) notes.push(`Zone redundancy is always on in ${ctx.region} and cannot be turned off, so its monthly charge per namespace is included.`);
    return { lines, notes, facts: { tier, namespaces: ns, pushes, zoneRedundant: zr, privateLink: !!c.privateLink } };
  }
};
