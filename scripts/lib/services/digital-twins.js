'use strict';
// Azure Digital Twins: pay-per-use, no instance or hourly charge. Three regional meters per 1,000:
// API operations, messages (event routing) and query units. Prices differ by region.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'digital-twins',
  label: 'Azure Digital Twins',
  family: 'iot',
  calculator: ['digital-twins'],
  keywords: ['digital twin', 'twins', 'building model', 'iot graph', 'twin graph', 'smart building', 'digital model'],
  fields: {
    operations: { req: true, int: true, min: 0, ask: 'Roughly how many calls a month will your apps make to read, create, update or delete twins, relationships and models (not counting queries; those are asked next)? Each started 1 KB of reply counts as one operation, so a 2.5 KB reply counts as 3. If unknown, suggest 1,000,000 and record it as an assumption.' },
    responseKb: { def: 1, min: 0, ask: 'About how big is a typical reply to those calls, in kilobytes (a twin with many properties is bigger)? Each started 1 KB counts as one operation. If unknown, use 1.' },
    queries: { def: 0, int: true, min: 0, ask: 'How many queries a month will your apps run against the twin graph? Each query call also counts as operations (by reply size) on top of its query units. If none, 0.' },
    queryUnitsPerQuery: { def: 2.45, min: 0, ask: 'Typical query units per query (a heavier query or bigger result uses more; the "query-charge" response header shows it). If unknown, use 2.45 (Microsoft\'s own example) and record it as an assumption.' },
    queryResponseKb: { def: 1, min: 0, ask: 'About how big is a typical query reply in kilobytes? Each started 1 KB counts as one operation. If unknown, use 1.' },
    queryUnits: { def: 0, int: true, min: 0, ask: 'Only if the person already knows their total query units a month: that number, added to queries x units per query. Otherwise 0.' },
    messages: { def: 0, int: true, min: 0, ask: 'Will twin changes or telemetry be sent out through event routes to Event Grid, Event Hubs or Service Bus (or data history)? Most solutions do. If yes, how many messages a month; if unknown, suggest about one per twin update and record it as an assumption. 0 only if they confirm there are no event routes.' },
    messageKb: { def: 1, min: 0, ask: 'About how big is a typical event message in kilobytes? Each started 1 KB counts as one message. If unknown, use 1.' }
  },
  examples: [
    { type: 'digital-twins', operations: 1000000 },
    { type: 'digital-twins', operations: 5000000, responseKb: 1.5, queries: 200000, queryUnitsPerQuery: 2.45, queryResponseKb: 2.3, queryUnits: 10000, messages: 2000000, messageKb: 1.5 }
  ],
  readback: c => {
    const kb = v => fmtN(n(v) || 1);
    const parts = [`${fmtN(n(c.operations))} API calls a month with replies of about ${kb(c.responseKb)} KB (each started 1 KB counts as one operation)`];
    if (n(c.queries)) parts.push(`${fmtN(c.queries)} queries a month using about ${fmtN(n(c.queryUnitsPerQuery))} query units each, with replies of about ${kb(c.queryResponseKb)} KB (also counted as operations)`);
    if (n(c.queryUnits)) parts.push(`${fmtN(c.queryUnits)} extra query units a month`);
    if (n(c.messages)) parts.push(`${fmtN(c.messages)} messages sent out a month of about ${kb(c.messageKb)} KB each`);
    return `Digital Twins: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('twins-endpoints') ? [] : ['The services that receive Digital Twins events (Event Hubs, Event Grid, Service Bus), Azure Data Explorer if you keep data history, Azure Functions that feed data in, and any IoT Hub that feeds it are priced separately.'],  price: async (c, ctx) => {
    for (const k of ['operations', 'responseKb', 'queries', 'queryUnitsPerQuery', 'queryResponseKb', 'queryUnits', 'messages', 'messageKb']) if (n(c[k]) < 0 || Number.isNaN(Number(c[k] ?? 0))) throw new PricingError(`Digital Twins "${k}" must be a number of 0 or more.`);
    const rs = await rows(`serviceName eq 'Digital Twins' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) {
      const all = await rows(`serviceName eq 'Digital Twins' and priceType eq 'Consumption'`, ctx);
      const regs = [...new Set(all.map(r => r.armRegionName))].sort();
      throw new PricingError(`Digital Twins is not priced in ${ctx.region}.${regs.length ? ` It is offered in: ${regs.join(', ')}.` : ''}`);
    }
    const blocks = (kb) => Math.max(1, Math.ceil(n(kb) || 1));
    const callOps = n(c.operations) * blocks(c.responseKb);
    const queryOps = n(c.queries) * blocks(c.queryResponseKb);
    const ops = callOps + queryOps;
    const qus = n(c.queries) * n(c.queryUnitsPerQuery ?? 2.45) + n(c.queryUnits);
    const msgs = n(c.messages) * blocks(c.messageKb);
    const m = (name, what) => single(rs.filter(r => r.meterName === name), `Digital Twins ${what}`);
    const G = 'IoT', S = 'Digital Twins', lines = [];
    lines.push(meterLine(G, S, `Digital Twins API operations, ${fmtN(ops)}/month (${fmtN(n(c.operations))} calls x ${fmtN(blocks(c.responseKb))} KB blocks${queryOps ? `, plus ${fmtN(n(c.queries))} query calls x ${fmtN(blocks(c.queryResponseKb))} KB blocks` : ''})`, m('Standard Operations', 'operations'), ops, ctx));
    if (msgs) lines.push(meterLine(G, S, `Digital Twins messages sent through event routes, ${fmtN(msgs)}/month (${fmtN(n(c.messages))} x ${fmtN(blocks(c.messageKb))} KB blocks)`, m('Standard Message', 'messages'), msgs, ctx));
    if (qus) lines.push(meterLine(G, S, `Digital Twins query units, ${fmtN(Math.round(qus))}/month`, m('Standard Query Units', 'query units'), qus, ctx));
    return {
      lines,
      notes: ['Digital Twins has no instance or hourly charge; you pay per 1,000 API operations, per 1,000 messages sent and per 1,000 query units.', 'Operations are counted in 1 KB blocks of the reply, messages in 1 KB blocks of the payload, and every query call counts as operations as well as query units.', 'A query unit measures how much computation a query needs (complexity and result size); it is not the number of queries.'],
      facts: { operations: ops, messages: msgs, queryUnits: qus, queries: n(c.queries) }
    };
  }
};