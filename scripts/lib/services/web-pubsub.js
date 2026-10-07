'use strict';
// Azure Web PubSub (Free, Standard, Premium). Meters: serviceName 'Web PubSub', regional.
// Units are billed per day (1/Day) and each Standard/Premium unit includes 1 million messages a day;
// only messages above that daily allowance are billed, per million. Free is one unit at $0.
// Premium above 100 units is Premium_P2 (100 to 1,000 units in steps of 100), billed on the same Premium Unit meter.
// The 'Premium Large Instance Add-on' meter (1/Day, only belgiumcentral, chilecentral, israelcentral, newzealandnorth and northcentralus)
// is not priced: neither Learn, the pricing page nor the calculator describes when it applies.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, DAYS } = require('../kit');

const n = v => Number(v || 0);
const INCLUDED_MSGS = 1000000;
const FREE_MSGS = 20000;
const STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const P2_STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

module.exports = {
  type: 'web-pubsub',
  label: 'Azure Web PubSub',
  family: 'web-other',
  calculator: ['web-pubsub'],
  keywords: ['web pubsub', 'websocket', 'publish subscribe', 'real-time', 'live updates', 'chat', 'push to browser', 'mqtt', 'socket.io'],
  mayBeZero: true,
  fields: {
    tier: { def: 'standard', enum: ['free', 'standard', 'premium'], ask: 'Is this just a trial (up to 20 simultaneous connections, no SLA) -> free; a normal production app -> standard; production that must survive a datacenter failure or use several regions -> premium. If unknown, suggest standard and record it as an assumption.' },
    units: { req: true, int: true, min: 1, max: 1000, ask: 'How many units? One unit handles 1,000 simultaneous connections, so divide the busiest number of connected users or devices by 1,000 and round up, then add headroom: plan for no more than 80% utilization in production. Only 1 to 10, then 20, 30 and so on up to 100 units can be deployed (premium can go on to 200, 300 and so on up to 1,000 as Premium_P2) (free is always 1). If unknown, suggest 1 and record it as an assumption.' },
    messagesPerDay: { def: 0, min: 0, ask: 'Roughly how many messages a day go out of the service, to connected clients or to your own back end such as Azure Functions? Count each message to each client, and every 2 KB of a larger message as one more. Each unit already includes 1 million a day. With replicas, give the total across the main service and all replicas; it is split evenly between them. If unknown, use 0 and record it as an assumption.' },
    replicas: { def: 0, int: true, min: 0, max: 8, ask: 'Premium only: how many extra copies (geo-replicas) in other regions? Each replica is billed separately, with its own units and its own 1 million message allowance a day. Size each replica for the full traffic if it must take over from a failed region. Use 0 if none.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Hours a month the service exists (730 = all month). Billing is per second, so a part month is charged for the time used (hours / 24 days).' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'web-pubsub', tier: 'standard', units: 1 },
    { type: 'web-pubsub', tier: 'premium', units: 5, messagesPerDay: 8000000, hours: 730 },
    { type: 'web-pubsub', tier: 'premium', units: 2, replicas: 1, messagesPerDay: 6000000 },
    { type: 'web-pubsub', tier: 'free', units: 1, messagesPerDay: 10000 }
  ],
  readback: c => `Web PubSub ${c.tier || 'standard'} tier: ${fmtN(n(c.units))} unit(s)${n(c.replicas) ? ` in the main service and each of ${fmtN(n(c.replicas))} replica(s)` : ''}, ${fmtN(n(c.messagesPerDay))} messages a day${n(c.replicas) ? ' in total, split evenly across the main service and its replicas' : ''}, ${(c.hours ?? 730) === 730 ? 'running all month' : `${fmtN(c.hours)} hours a month`}`,
  notIncluded: () => ['The web app or API that connects to Web PubSub, and data transfer between replica regions'],
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!['free', 'standard', 'premium'].includes(tier)) throw new PricingError(`Unknown tier "${c.tier}". Use free, standard or premium.`);
    if (c.units == null || c.units === '') throw new PricingError('units is required: how many units (1,000 connections each)?');
    const units = n(c.units), replicas = n(c.replicas), msgs = n(c.messagesPerDay), hours = c.hours ?? 730;
    if (!Number.isInteger(units) || units < 1) throw new PricingError('units must be a whole number of 1 or more.');
    if (units > 1000) throw new PricingError('Web PubSub supports at most 1,000 units (Premium_P2).');
    if (units > 100 && tier !== 'premium') throw new PricingError('Above 100 units needs the premium tier (Premium_P2, 100 to 1,000 units).');
    if (!(units > 100 ? P2_STEPS : STEPS).includes(units)) throw new PricingError(units > 100 ? `Premium_P2 units can only be 100, 200 and so on up to 1,000; ${units} cannot be deployed. Use ${P2_STEPS.find(s => s >= units)}.` : `Web PubSub units can only be 1 to 10, then 20, 30 and so on up to 100; ${units} cannot be deployed. Use ${STEPS.find(s => s >= units)}.`);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 8) throw new PricingError('replicas must be a whole number from 0 to 8.');
    if (replicas && tier !== 'premium') throw new PricingError('Replicas (geo-replication) need the premium tier.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (msgs < 0) throw new PricingError('messagesPerDay cannot be negative.');
    if (tier === 'free' && units !== 1) throw new PricingError('The free tier is always 1 unit; use standard or premium for more.');
    if (tier === 'free' && msgs > FREE_MSGS) throw new PricingError(`The free tier allows ${fmtN(FREE_MSGS)} messages a day and cannot be exceeded; use standard or premium.`);
    const rs = (await rows(`serviceName eq 'Web PubSub' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx)).filter(r => r.unitOfMeasure !== '1 Hour');
    if (!rs.length) throw new PricingError(`Azure Web PubSub is not priced in ${ctx.region}.`);
    const days = hours / 24;
    const G = 'Web', S = 'Web PubSub';
    const Tier = tier.charAt(0).toUpperCase() + tier.slice(1);
    const lines = [], inst = 1 + replicas;
    const unitMeter = single(rs.filter(r => r.meterName === (tier === 'free' ? 'Standard Unit - Free' : `${Tier} Unit`)), `${Tier} unit`);
    lines.push(meterLine(G, S, `${Tier} tier: ${replicas ? `${fmtN(inst)} instances (main + ${fmtN(replicas)} replica(s)) x ` : ''}${fmtN(units)} unit(s) x ${fmtN(Math.round(days * 100) / 100)} days`, unitMeter, inst * units * days, ctx, { unit: 'unit-days' }));
    const overDay = Math.max(0, msgs / inst - units * INCLUDED_MSGS) * inst, over = overDay * days;
    if (tier !== 'free' && over > 0) {
      lines.push(meterLine(G, S, `Messages above the ${fmtN(units * INCLUDED_MSGS)} a day included with ${fmtN(units)} unit(s)${replicas ? ' in each instance' : ''}: ${fmtN(Math.round(over))} a month`, single(rs.filter(r => r.meterName === `${Tier} Message`), `${Tier} messages`), over, ctx, { unit: 'messages' }));
    }
    const notes = {
      free: [`Free tier: 1 unit, up to 20 simultaneous connections and ${fmtN(FREE_MSGS)} messages a day, no charge. It has no SLA.`],
      standard: ['Standard tier: each unit is billed per day and handles 1,000 simultaneous connections and 1 million messages a day; only messages above that allowance are billed, per million.'],
      premium: ['Premium tier: each unit is billed per day (a higher rate than Standard) and handles 1,000 simultaneous connections and 1 million messages a day; it adds zone redundancy, geo-replication (each replica is billed separately) and autoscale. Only messages above the allowance are billed, per million.']
    }[tier].slice();
    if (replicas) notes.push('Each replica is priced here at the main region\'s rates, as its own units and its own message allowance; cross-region data transfer between replicas is not included.');
    if (tier === 'premium' && units > 100) notes.push('More than 100 units is the Premium_P2 size; it is billed per unit like Premium.');
    notes.push('Only outbound messages (sent out of the service to clients or to an upstream server) count; inbound messages are free. A message larger than 2 KB counts as one message for every 2 KB.');
    return { lines, notes, facts: { tier, units, messagesPerDay: msgs, hours, replicas, overageMessagesPerDay: overDay } };
  }
};
