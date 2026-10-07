'use strict';
// Azure Event Grid: Basic (pay per operation) and Standard (namespaces: throughput units, event operations, MQTT operations).
// Meters: serviceName 'Event Grid', regional. Free grants are read from the Retail tier rows (they are absent in a few regions).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const hrs = c => c.hours ?? HOURS;

module.exports = {
  type: 'event-grid',
  label: 'Azure Event Grid',
  family: 'messaging',
  calculator: ['event-grid'],
  keywords: ['event grid', 'events', 'event routing', 'pub sub', 'webhooks', 'mqtt', 'iot messaging', 'event driven'],
  fields: {
    tier: { def: 'basic', enum: ['basic', 'standard'], ask: 'Do any devices send MQTT messages, or do apps need to pull events from a queue-like endpoint instead of having them pushed? If yes, use standard; if not (Azure service events, custom topics, pushing to webhooks or functions), use basic. If unknown, use basic and record it as an assumption.' },
    operations: { req: true, ask: 'Roughly how many events a month will be published and delivered? Basic counts each event published, each delivery attempt and each advanced-filter match as an operation, so one event delivered to 3 subscribers is about 4 operations (event type and subject-begins-with filters are free). Standard counts event operations (published events and deliveries). Events larger than 64 KB count once per 64 KB, so a 256 KB event is 4 operations. If unknown, suggest 5,000,000 and record it as an assumption.' },
    mqttOperations: { def: 0, ask: 'Standard only: if devices talk to Event Grid over MQTT, how many MQTT operations a month (each published message, delivery or connect/subscribe is an operation)?' },
    throughputUnits: { def: 1, int: true, min: 1, max: 40, ask: 'Standard only: how many throughput units for the namespace (1 to 40)? Each unit adds capacity and is billed per hour; start with 1.' },
    hours: { def: 730 }
  },
  context: ['production'],
  examples: [
    { type: 'event-grid', tier: 'basic', operations: 20000000 },
    { type: 'event-grid', tier: 'standard', operations: 50000000, mqttOperations: 100000000, throughputUnits: 2 }
  ],
  readback: c => {
    const tier = c.tier || 'basic';
    if (tier === 'basic') return `Event Grid basic: ${fmtN(n(c.operations))} operations a month`;
    const parts = [`${fmtN(n(c.operations))} event operations a month`];
    if (n(c.mqttOperations)) parts.push(`${fmtN(c.mqttOperations)} MQTT operations a month`);
    parts.push(`${fmtN(c.throughputUnits ?? 1)} throughput unit(s), ${hrs(c) < HOURS ? `${fmtN(hrs(c))} hours a month` : 'running all month'}`);
    return `Event Grid standard (namespace): ${parts.join(', ')}`;
  },
  price: async (c, ctx) => {
    const tier = (c.tier || 'basic').toLowerCase();
    const rs = await rows(`serviceName eq 'Event Grid' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Event Grid is not priced in ${ctx.region}.`);
    const pick = (meterName, what) => {
      const m = rs.filter(r => r.meterName === meterName);
      if (!m.length) throw new PricingError(tier === 'basic'
        ? `Event Grid basic is not offered in ${ctx.region}; use the standard tier (namespaces) or another region.`
        : `Event Grid namespaces (standard) are not offered in ${ctx.region}; use the basic tier or another region.`);
      return single(m, `Event Grid ${what}`);
    };
    // 'first N free' only where the Retail meter really has a zero-price first band
    const free = (m, size, label) => { const z = m.find(r => Number(r.retailPrice) === 0 && Number(r.tierMinimumUnits) === 0); const next = z && m.filter(r => Number(r.tierMinimumUnits) > 0).sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits)[0]; return next ? `, first ${fmtN(next.tierMinimumUnits * size)} free` : ''; };
    const G = 'Integration', S = 'Event Grid', lines = [], notes = [];
    const opsLine = (label, qty, m, size) => meterLine(G, S, `${label}: ${fmtN(qty)}/month${free(m, size)}`, m, qty, ctx);
    if (tier === 'basic') {
      if (n(c.mqttOperations)) throw new PricingError('MQTT operations need the standard tier (namespaces).');
      const m = pick('Standard Operations', 'basic operations');
      lines.push(opsLine('Event Grid basic operations', n(c.operations), m, 100000));
      notes.push('Basic bills per operation (event published, delivery attempt, advanced filter match); event type and subject-begins-with filters are free. Events larger than 64 KB are billed in 64 KB multiples.');
    } else if (tier === 'standard') {
      const tu = c.throughputUnits ?? 1;
      if (!Number.isInteger(tu) || tu < 1 || tu > 40) throw new PricingError('throughputUnits must be a whole number from 1 to 40.');
      const hours = hrs(c);
      lines.push(meterLine(G, S, `Event Grid namespace: ${fmtN(tu)} throughput unit(s) x ${fmtN(hours)} hours`, pick('Standard Throughput Unit', 'throughput unit'), tu * hours, ctx, { unit: 'hours' }));
      lines.push(opsLine('Event operations', n(c.operations), pick('Standard Event Operations', 'event operations'), 1000000));
      if (n(c.mqttOperations)) lines.push(opsLine('MQTT operations', n(c.mqttOperations), pick('Standard MQTT Operations', 'MQTT operations'), 1000000));
      notes.push('Namespace throughput units are billed every hour whether or not they are used. Messages larger than 64 KB are billed in 64 KB multiples.');    } else throw new PricingError(`Unknown Event Grid tier "${tier}". Use basic or standard.`);
    return { lines, notes, facts: { tier, operations: n(c.operations), mqttOperations: n(c.mqttOperations), throughputUnits: tier === 'standard' ? (c.throughputUnits ?? 1) : 0 } };
  }
};
