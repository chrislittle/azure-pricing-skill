'use strict';
// Azure SignalR Service (Free, Standard, Premium). Meters: serviceName 'SignalR', regional.
// Units are billed per day (1/Day) and each Standard/Premium unit includes 1 million messages a day;
// only messages above that daily allowance are billed, per million. Free is one unit at $0.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, DAYS } = require('../kit');

const n = v => Number(v || 0);
const INCLUDED_MSGS = 1000000;
const FREE_MSGS = 20000;
const STEPS = [1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100];

module.exports = {
  type: 'signalr',
  label: 'Azure SignalR Service',
  family: 'web-other',
  calculator: ['signalr-service'],
  keywords: ['signalr', 'real-time', 'websocket', 'live updates', 'chat', 'push to browser', 'notifications', 'dashboard'],
  mayBeZero: true,
  fields: {
    tier: { def: 'standard', enum: ['free', 'standard', 'premium'], ask: 'Is this just a trial (up to 20 simultaneous connections, no SLA) -> free; a normal production app -> standard; production that must survive a datacenter failure or use several regions -> premium. If unknown, suggest standard and record it as an assumption.' },
    units: { req: true, int: true, min: 1, max: 1000, ask: 'How many units? One unit handles 1,000 simultaneous connections, so divide the busiest number of connected users or devices by 1,000 and round up, and add 5 per hub for each application server (they count toward the 1,000). Only 1 to 10, then 20, 30 and so on up to 100 units can be deployed (free is always 1). If unknown, suggest 1 and record it as an assumption.' },
    messagesPerDay: { def: 0, min: 0, ask: 'Roughly how many messages a day go from the service out to connected clients? Count each message to each client, and every 2 KB of a larger message as one more. Each unit already includes 1 million a day. With replicas, give the total across the main service and all replicas; it is split evenly between them. If unknown, use 0 and record it as an assumption.' },
    replicas: { def: 0, int: true, min: 0, max: 8, ask: 'Premium only: how many extra copies (geo-replicas) in other regions? Each replica is billed separately, with its own units and its own 1 million message allowance a day. Size each replica for the full traffic if it must take over from a failed region. Use 0 if none.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Hours a month the service exists (730 = all month). Billing is per second, so a part month is charged for the time used (hours / 24 days).' }
  },
  context: ['production', 'zoneResilience', 'multiRegionUsers', 'idlePeriods'],
  examples: [
    { type: 'signalr', tier: 'standard', units: 1 },
    { type: 'signalr', tier: 'premium', units: 5, messagesPerDay: 8000000, hours: 730 },
    { type: 'signalr', tier: 'premium', units: 2, replicas: 1, messagesPerDay: 6000000 },
    { type: 'signalr', tier: 'free', units: 1, messagesPerDay: 10000 }
  ],
  readback: c => `SignalR ${c.tier || 'standard'} tier: ${fmtN(n(c.units))} unit(s)${n(c.replicas) ? ` in the main service and each of ${fmtN(n(c.replicas))} replica(s)` : ''}, ${fmtN(n(c.messagesPerDay))} messages a day${n(c.replicas) ? ' in total, split evenly across the main service and its replicas' : ''}, ${(c.hours ?? 730) === 730 ? 'running all month' : `${fmtN(c.hours)} hours a month`}`,
  notIncluded: () => ['The web app or API that connects to SignalR Service, and data transfer between replica regions'],
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!['free', 'standard', 'premium'].includes(tier)) throw new PricingError(`Unknown tier "${c.tier}". Use free, standard or premium.`);
    if (c.units == null || c.units === '') throw new PricingError('units is required: how many units (1,000 connections each)?');
    const units = n(c.units), replicas = n(c.replicas), msgs = n(c.messagesPerDay), hours = c.hours ?? 730;
    if (!Number.isInteger(units) || units < 1) throw new PricingError('units must be a whole number of 1 or more.');
    if (units > 100) throw new PricingError('Above 100 units needs Premium_P2, which this tool does not price; use 100 units or fewer.');
    if (!STEPS.includes(units)) throw new PricingError(`SignalR units can only be ${STEPS.join(', ')}; ${units} cannot be deployed. Use ${STEPS.find(s => s >= units)}.`);
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 8) throw new PricingError('replicas must be a whole number from 0 to 8.');
    if (replicas && tier !== 'premium') throw new PricingError('Replicas (geo-replication) need the premium tier.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (msgs < 0) throw new PricingError('messagesPerDay cannot be negative.');
    if (tier === 'free' && units !== 1) throw new PricingError('The free tier is always 1 unit; use standard or premium for more.');
    if (tier === 'free' && msgs > FREE_MSGS) throw new PricingError(`The free tier allows ${fmtN(FREE_MSGS)} messages a day and cannot be exceeded; use standard or premium.`);
    const rs = (await rows(`serviceName eq 'SignalR' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx)).filter(r => r.unitOfMeasure !== '1 Hour');
    if (!rs.length) throw new PricingError(`Azure SignalR Service is not priced in ${ctx.region}.`);
    const days = hours / 24;
    const G = 'Web', S = 'SignalR';
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
      premium: ['Premium tier: each unit is billed per day (a higher rate than Standard) and handles 1,000 simultaneous connections and 1 million messages a day; it adds zone redundancy, geo-replication and autoscale. Only messages above the allowance are billed, per million.']
    }[tier].slice();
    if (replicas) notes.push('Each replica is priced here at the main region\'s rates, as its own units and its own message allowance; cross-region data transfer between replicas is not included.');
    notes.push('Only messages sent from the service to clients count; messages from clients to the service are free. A message larger than 2 KB counts as one message for every 2 KB.');
    return { lines, notes, facts: { tier, units, messagesPerDay: msgs, hours, replicas, overageMessagesPerDay: overDay } };
  }
};
