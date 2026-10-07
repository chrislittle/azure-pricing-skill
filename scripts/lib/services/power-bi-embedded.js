'use strict';
// Power BI Embedded (A-series capacity nodes). Meters: serviceName 'Power BI Embedded', regional,
// one hourly meter per node size (A1-A8). A7 and A8 are only priced in a few regions.
// The retired Power BI Workspace Collection sessions meter is not priced.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
// vCores, memory and peak renders per hour are the calculator's published sizes.
const SIZES = {
  a1: { v: 1, gb: 3, renders: '1-300' },
  a2: { v: 2, gb: 5, renders: '301-600' },
  a3: { v: 4, gb: 10, renders: '601-1,200' },
  a4: { v: 8, gb: 25, renders: '1,201-2,400' },
  a5: { v: 16, gb: 50, renders: '2,401-4,800' },
  a6: { v: 32, gb: 100, renders: '4,801-9,600' },
  a7: { v: 64, gb: 200, renders: '9,601-19,200' },
  a8: { v: 128, gb: 400, renders: '19,201-38,400' }
};

module.exports = {
  type: 'power-bi-embedded',
  label: 'Power BI Embedded',
  family: 'analytics',
  calculator: ['power-bi-embedded'],
  keywords: ['power bi embedded', 'embed reports', 'embedded analytics', 'power bi capacity', 'a sku', 'embed dashboards', 'power bi'],
  fields: {
    size: { req: true, def: 'a1', enum: Object.keys(SIZES), ask: 'How busy will the embedded reports be at peak? Count the report views (renders) in the busiest hour: up to 300 -> a1; up to 600 -> a2; up to 1,200 -> a3; up to 2,400 -> a4; up to 4,800 -> a5; up to 9,600 -> a6; up to 19,200 -> a7; up to 38,400 -> a8 (a7 and a8 are only offered in Germany North, Germany West Central and US Gov Virginia; elsewhere use more nodes of a smaller size or ask the Microsoft account manager). If unknown, suggest a1 to start and record it as an assumption.' },
    viewers: { req: true, enum: ['customers', 'employees'], ask: 'Who will view the embedded reports: your customers or other outside parties (the app owns the data), or your own employees (they sign in with their own Power BI accounts)? For employees, an A SKU also needs a Power BI Pro or Premium Per User licence for each viewer. If unknown, ask; do not assume.' },
    nodes: { int: true, min: 0, def: 1, ask: 'How many capacities (nodes) of that size do you need? Most people need 1; each node is billed separately.' },
    hours: { min: 0, max: 744, def: HOURS, ask: 'How many hours a month will the capacity be running (730 = all month)? You pay only while it is running, so pausing it outside business hours saves money; for example 10 hours x 22 working days = 220.' }
  },
  context: ['idlePeriods'],
  examples: [
    { type: 'power-bi-embedded', size: 'a1', viewers: 'customers' },
    { type: 'power-bi-embedded', size: 'a4', viewers: 'employees', nodes: 2, hours: 220 }
  ],
  readback: c => {
    const size = String(c.size || 'a1').toLowerCase();
    const s = SIZES[size];
    const hrs = n(c.hours ?? HOURS);
    return `Power BI Embedded: ${fmtN(n(c.nodes ?? 1))} ${size.toUpperCase()} node(s)${s ? ` (${fmtN(s.v)} virtual core(s), ${fmtN(s.gb)} GB memory, about ${s.renders} peak renders an hour)` : ''}, ${hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month`}${c.viewers === 'employees' ? ', viewed by your own employees (each also needs a Power BI Pro or Premium Per User licence)' : c.viewers === 'customers' ? ', viewed by your customers' : ''}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('power-bi-licences') ? [] : ['Power BI Pro or Premium Per User licences are billed through Microsoft 365, not Azure. They are needed for the people who author or share content and, when employees view the embedded content with an A SKU, for every viewer.'],
  price: async (c, ctx) => {
    const size = String(c.size || 'a1').toLowerCase();
    if (!SIZES[size]) throw new PricingError(`Unknown size "${c.size}". Use ${Object.keys(SIZES).join(', ')}.`);
    const nodes = n(c.nodes ?? 1), hours = n(c.hours ?? HOURS);
    if (!Number.isInteger(nodes)) throw new PricingError('nodes must be a whole number.');
    if (nodes < 0) throw new PricingError('nodes cannot be negative.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const S = size.toUpperCase();
    const rs = await rows(`serviceName eq 'Power BI Embedded' and ${regionFilter(ctx)} and priceType eq 'Consumption' and meterName eq '${S} Node'`, ctx);
    if (!rs.length) {
      const any = await rows(`serviceName eq 'Power BI Embedded' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
      const have = [...new Set(any.filter(r => / Node$/.test(r.meterName)).map(r => r.meterName.replace(' Node', '')))].sort();
      const big = size === 'a7' || size === 'a8' ? ' A7 and A8 are only offered in Germany North, Germany West Central and US Gov Virginia; to use them elsewhere, contact your Microsoft account manager.' : '';
      throw new PricingError(`Power BI Embedded ${S} is not priced in ${ctx.region}.${have.length ? ` Sizes available there: ${have.join(', ')}.` : ' Power BI Embedded is not offered in that region; try a nearby one.'}${big}`);
    }
    const m = single(rs, `Power BI Embedded ${S} node`);
    const sz = SIZES[size];
    return {
      lines: [meterLine('Analytics', 'Power BI Embedded', `Power BI Embedded ${S} (${fmtN(sz.v)} virtual cores, ${fmtN(sz.gb)} GB), ${fmtN(nodes)} node(s) x ${fmtN(hours)} hours`, m, nodes * hours, ctx, { unit: 'node hours' })],
      notes: ['A Power BI Embedded node is billed per hour while it is running; pausing it stops the charge.', 'Power BI Pro licences for authors are not part of the Azure bill.'],
      facts: { size, viewers: c.viewers, nodes, hours, virtualCores: sz.v, memoryGB: sz.gb }
    };
  }
};
