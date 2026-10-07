'use strict';
// Azure App Configuration (Free, Developer, Standard, Premium). Meters: serviceName 'App Configuration', regional.
// Each store is billed per day; requests above a daily allowance are billed in blocks (10K, or 1K on Developer).
// Standard replicas are billed like a store; a Premium store already includes one replica, extra ones are billed per day.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
// Requests included in the daily charge per store (and per replica).
const INCLUDED = { developer: 3000, standard: 200000, premium: 800000 };
const FREE_REQUESTS_PER_DAY = 1000;

module.exports = {
  type: 'app-configuration',
  label: 'Azure App Configuration',
  family: 'integration',
  calculator: ['app-configuration'],
  keywords: ['app configuration', 'feature flags', 'settings', 'configuration store', 'config management', 'key-value settings'],
  mayBeZero: true,
  fields: {
    tier: { def: 'standard', enum: ['free', 'developer', 'standard', 'premium'], ask: 'What is it for? Just trying it out (1,000 requests a day, no SLA) -> free; low-volume development or testing -> developer; normal production or test environments -> standard; very high request volumes, no request limits, or a multi-region setup with an included replica -> premium. If unknown, suggest standard and record it as an assumption.' },
    stores: { def: 1, int: true, min: 1, ask: 'How many configuration stores (usually one per environment such as production and test, or one per app if they need to be isolated)? If unknown, use 1 and record it as an assumption.' },
    requestsPerDay: { req: true, ask: 'Roughly how many requests a day does each store receive (every read or write call to App Configuration counts, and an app that loads settings or checks for changes sends several)? If unknown, suggest 200,000 and record it as an assumption.' },
    replicas: { def: 0, int: true, min: 0, ask: 'Standard and premium only: in how many regions besides the main one should each store be replicated, for resiliency or lower latency? Count every replica region in total. Standard: each is billed like an extra store. Premium: the first replica is included in the Premium price and each additional one is billed at half the store price. Most people need 0.' },
    replicaRequestsPerDay: { def: null, ask: 'Only if replicas are used: how many requests a day each replica receives? If unknown, use the same as the main store and record it as an assumption.' },
    snapshotOverageMB: { def: 0, min: 0, ask: 'Only if they keep configuration snapshots beyond what the tier includes (snapshots cannot normally exceed the tier quota): how many MB above the included snapshot storage, on average, per store (replica snapshot storage is not included)? Most people need 0.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Hours a month the stores exist (730 = all month). Billing is per day pro rata, so a part month is charged for the time used (hours / 24 days).' }
  },
  context: ['production'],
  examples: [
    { type: 'app-configuration', tier: 'standard', requestsPerDay: 100000 },
    { type: 'app-configuration', tier: 'standard', stores: 2, requestsPerDay: 500000, replicas: 1, replicaRequestsPerDay: 300000, snapshotOverageMB: 100, hours: 730 },
    { type: 'app-configuration', tier: 'premium', stores: 1, requestsPerDay: 2000000, replicas: 2, replicaRequestsPerDay: 1500000, snapshotOverageMB: 50 },
    { type: 'app-configuration', tier: 'developer', requestsPerDay: 5000 },
    { type: 'app-configuration', tier: 'free', requestsPerDay: 500 }
  ],
  readback: c => {
    const rep = n(c.replicas);
    return `App Configuration ${c.tier || 'standard'} tier: ${fmtN(n(c.stores ?? 1))} store(s), ${fmtN(n(c.requestsPerDay))} requests a day per store${rep ? `, ${fmtN(rep)} replica region(s) per store${(c.tier || 'standard') === 'premium' ? ' (the first replica is included in the Premium price)' : ''} with ${fmtN(n(c.replicaRequestsPerDay ?? c.requestsPerDay))} requests a day each` : ''}${n(c.snapshotOverageMB) ? `, ${fmtN(c.snapshotOverageMB)} MB of snapshot storage above the included amount per store` : ''}, ${(c.hours ?? 730) === 730 ? 'running all month' : `${fmtN(c.hours ?? 730)} hours a month`}`;
  },
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!['free', 'developer', 'standard', 'premium'].includes(tier)) throw new PricingError(`Unknown tier "${c.tier}". Use free, developer, standard or premium.`);
    const stores = c.stores ?? 1, rpd = n(c.requestsPerDay), rep = n(c.replicas), hours = c.hours ?? 730, snap = n(c.snapshotOverageMB);
    const rrpd = c.replicaRequestsPerDay == null ? rpd : n(c.replicaRequestsPerDay);
    if (!Number.isInteger(stores) || stores < 1) throw new PricingError('stores must be a whole number of 1 or more.');
    if (tier === 'free' && stores > 3) throw new PricingError('The free tier allows at most 3 configuration stores per region per subscription; use developer or standard.');
    if (!Number.isInteger(rep) || rep < 0) throw new PricingError('replicas must be a whole number of 0 or more.');
    if (rpd < 0 || rrpd < 0 || snap < 0) throw new PricingError('requestsPerDay, replicaRequestsPerDay and snapshotOverageMB cannot be negative.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (rep && (tier === 'free' || tier === 'developer')) throw new PricingError('Replicas (geo-replication) need the standard or premium tier.');
    if (tier === 'free' && rpd > FREE_REQUESTS_PER_DAY) throw new PricingError(`The free tier stops serving after ${fmtN(FREE_REQUESTS_PER_DAY)} requests a day; use developer or standard.`);
    if (tier === 'free' && snap) throw new PricingError('The free tier has a fixed snapshot storage limit and cannot be extended; use developer or standard.');
    const rs = await rows(`serviceName eq 'App Configuration' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`App Configuration is not priced in ${ctx.region}.`);
    const Tier = tier.charAt(0).toUpperCase() + tier.slice(1);
    const m = (name, what) => {
      const hit = rs.filter(r => r.skuName === Tier && r.meterName === `${Tier} ${name}`);
      if (!hit.length) {
        const here = [...new Set(rs.filter(r => r.meterName === `${r.skuName} Instance`).map(r => r.skuName))].map(s => s.toLowerCase());
        throw new PricingError(`The ${tier} tier has no ${what} price in ${ctx.region}${here.length ? `; tiers priced there: ${here.join(', ')}` : ''}.`);
      }
      return single(hit, `${Tier} ${what}`);
    };
    const days = hours / 24;
    const G = 'Integration', S = 'App Configuration', lines = [];
    lines.push(meterLine(G, S, `${Tier} tier: ${fmtN(stores)} store(s) x ${fmtN(Math.round(days * 100) / 100)} days`, m('Instance', 'store'), stores * days, ctx, { unit: 'store-days' }));
    const inc = INCLUDED[tier] || 0;
    const over = Math.max(0, rpd - inc) * days * stores;
    if (tier !== 'free' && over > 0) lines.push(meterLine(G, S, `Requests above the ${fmtN(inc)} a day included per store: ${fmtN(Math.round(over))} a month`, m('Overage Operations', 'request overage'), over, ctx, { unit: 'requests' }));
    let billedReplicas = 0;
    if (rep) {
      billedReplicas = tier === 'premium' ? Math.max(0, rep - 1) : rep;
      if (billedReplicas > 0) lines.push(meterLine(G, S, `${Tier} replicas: ${fmtN(billedReplicas)} billed replica(s) per store x ${fmtN(stores)} store(s) x ${fmtN(Math.round(days * 100) / 100)} days`, m('Replica Instance', 'replica'), billedReplicas * stores * days, ctx, { unit: 'replica-days' }));
      const rOver = Math.max(0, rrpd - inc) * days * stores * rep;
      if (rOver > 0) lines.push(meterLine(G, S, `Replica requests above the ${fmtN(inc)} a day included per replica: ${fmtN(Math.round(rOver))} a month`, m('Replica Overage Operations', 'replica request overage'), rOver, ctx, { unit: 'requests' }));
    }
    if (snap > 0) lines.push(meterLine(G, S, `Snapshot storage above the included amount: ${fmtN(snap)} MB per store x ${fmtN(stores)} store(s) x ${fmtN(Math.round(days * 100) / 100)} days`, m('Snapshots Overage', 'snapshot storage overage'), snap * stores * days, ctx, { unit: 'MB-days' }));
    const notes = {
      free: [`Free tier: no charge, limited to ${fmtN(FREE_REQUESTS_PER_DAY)} requests a day (extra requests are refused until midnight UTC), 10 MB of storage and no SLA. It is for evaluation only.`],
      developer: ['Developer tier: low daily charge per store that includes the first 3,000 requests a day; extra requests are billed per 1,000. No SLA; meant for development and testing.'],
      standard: ['Standard tier: each store has a daily charge that includes the first 200,000 requests a day; extra requests are billed per 10,000. Each replica is billed like another store and has its own 200,000 daily requests.'],
      premium: ['Premium tier: each store has a daily charge that already includes one replica, with 800,000 requests a day included for the store and 800,000 for that replica. Extra requests are billed per 10,000, and replicas beyond the first are billed per day.']
    }[tier].slice();
    if (tier === 'premium') notes.push('Zone redundancy is automatic and has no extra cost. The Premium SLA applies only when the store has at least one replica.');
    if (snap > 0 && rep) notes.push('Snapshot storage overage on replicas is not included.');
    notes.push('Requests are billed per day: the daily allowance does not carry over, so the overage uses the average daily requests you give. Experimentation events are not charged on any tier.');
    return { lines, notes, facts: { tier, stores, requestsPerDay: rpd, replicas: rep, billedReplicas, hours, overageRequestsPerDay: Math.max(0, rpd - inc) } };
  }
};
