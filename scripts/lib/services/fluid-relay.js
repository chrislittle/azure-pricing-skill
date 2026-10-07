'use strict';
// Azure Fluid Relay (Basic and Standard). Meters: serviceName 'Azure Fluid Relay', regional. Four volume meters per tier:
// operations in and out (per million), client connectivity minutes (per million) and storage (GB per month).
// Basic is offered only in a few regions.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'fluid-relay',
  label: 'Azure Fluid Relay',
  family: 'web-other',
  calculator: ['fluid-relay'],
  keywords: ['fluid relay', 'fluid framework', 'real-time collaboration', 'co-editing', 'collaborative app', 'shared whiteboard'],
  fields: {
    tier: { def: 'standard', enum: ['basic', 'standard'], ask: 'Is this a test or single-region app that can live without an SLA, or one that must keep its data in the same region -> basic (offered only in a few regions); a production app that needs multi-region routing and resiliency -> standard. If unknown, suggest standard and record it as an assumption.' },
    operationsIn: { req: true, int: true, min: 0, ask: 'How many changes do users send to collaborative sessions in a month (typing, moving shapes, joins and leaves; Fluid calls these operations or ops)? Every 2 KB of a larger message counts as one more. If unknown, suggest 10 million and record it as an assumption.' },
    operationsOut: { req: true, int: true, min: 0, ask: 'How many operations does the service send out to users a month? Every change is sent to every person in the session, so this is roughly operations in x the average number of people in a session (never less than operations in). If unknown, estimate that and record it as an assumption.' },
    clientMinutes: { req: true, int: true, min: 0, ask: 'Total minutes users spend connected to sessions in a month, counted per user (3 users in a session for an hour = 180 minutes). If unknown, estimate users per session x session minutes x sessions a month and record it as an assumption.' },
    storageGB: { def: 0, min: 0, ask: 'How many GB of session data (documents) do you keep stored in the service?' }
  },
  context: ['production'],
  examples: [
    { type: 'fluid-relay', tier: 'standard', operationsIn: 10000000, operationsOut: 30000000, clientMinutes: 6000000 },
    { type: 'fluid-relay', tier: 'standard', operationsIn: 50000000, operationsOut: 200000000, clientMinutes: 30000000, storageGB: 100 }
  ],
  readback: c => `Fluid Relay ${c.tier || 'standard'} tier: ${fmtN(n(c.operationsIn))} operations in a month, ${fmtN(n(c.operationsOut))} operations out, ${fmtN(n(c.clientMinutes))} client connectivity minutes, ${fmtN(n(c.storageGB))} GB stored`,
  notIncluded: () => ['The web app that hosts the Fluid client, and Azure Functions or other back end that creates user tokens'],
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!['basic', 'standard'].includes(tier)) throw new PricingError(`Unknown tier "${c.tier}". Use basic or standard.`);
    for (const k of ['operationsIn', 'operationsOut', 'clientMinutes', 'storageGB']) if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    const rs = await rows(`serviceName eq 'Azure Fluid Relay' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Fluid Relay is not priced in ${ctx.region}.`);
    const Tier = tier.charAt(0).toUpperCase() + tier.slice(1);
    const m = (name, what) => single(rs.filter(r => r.meterName === `${Tier} ${name}`), `${Tier} ${what}`);
    if (!rs.some(r => r.skuName === Tier)) {
      const other = tier === 'basic' ? 'Standard' : 'Basic';
      let basicIn = '';
      if (tier === 'basic') {
        const all = await rows("serviceName eq 'Azure Fluid Relay' and skuName eq 'Basic' and priceType eq 'Consumption'", ctx);
        basicIn = ` Basic is offered in ${[...new Set(all.map(r => r.armRegionName))].sort().join(', ')}.`;
      }
      throw new PricingError(`The ${tier} tier of Azure Fluid Relay is not offered in ${ctx.region}.${basicIn}${rs.some(r => r.skuName === other) ? ` Price the ${other.toLowerCase()} tier instead.` : ''}`);
    }
    const G = 'Web', S = 'Azure Fluid Relay';
    const cand = [
      [n(c.operationsIn), () => meterLine(G, S, `${Tier} tier: operations in, ${fmtN(n(c.operationsIn))}/month`, m('Operations In', 'operations in'), n(c.operationsIn), ctx, { unit: 'operations' })],
      [n(c.operationsOut), () => meterLine(G, S, `${Tier} tier: operations out, ${fmtN(n(c.operationsOut))}/month`, m('Operations Out', 'operations out'), n(c.operationsOut), ctx, { unit: 'operations' })],
      [n(c.clientMinutes), () => meterLine(G, S, `${Tier} tier: client connectivity, ${fmtN(n(c.clientMinutes))} minutes/month`, m('Client Connectivity Minutes', 'client connectivity minutes'), n(c.clientMinutes), ctx, { unit: 'minutes' })],
      [n(c.storageGB), () => meterLine(G, S, `${Tier} tier: session storage, ${fmtN(n(c.storageGB))} GB`, m('Storage', 'storage'), n(c.storageGB), ctx, { unit: 'GB / month' })]
    ];
    const used = cand.filter(x => x[0] > 0);
    const lines = (used.length ? used : cand.slice(0, 1)).map(x => x[1]());
    const notes = [
      'Operations in: each message a client sends counts as one operation, including heartbeats and other session control messages; every 2 KB of a larger message counts as one more.',
      'Operations out: each message the service sends to each client counts as one (in a 3-user session, one operation in produces 3 out).',
      'Client connectivity is billed per user: 3 users connected for an hour is 180 minutes. Storage is billed per GB per month for session data.'
    ];
    if (tier === 'basic') notes.push('Basic is a single-region offering with no cross-region resiliency or routing and no SLA, and it is available in only a few regions.');
    return { lines, notes, facts: { tier, operationsIn: n(c.operationsIn), operationsOut: n(c.operationsOut), clientMinutes: n(c.clientMinutes), storageGB: n(c.storageGB) } };
  }
};
