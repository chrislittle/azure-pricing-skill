'use strict';
// Azure Functions Elastic Premium (EP1-EP3). Meters (serviceName 'Functions', product 'Premium Functions'):
// 'Premium vCPU Duration' per vCPU-hour and 'Premium Memory Duration' per GiB-hour; no execution charge.
const { rows, single, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS } = require('../kit');

const SIZES = { ep1: { label: 'EP1', vcpu: 1, mem: 3.5 }, ep2: { label: 'EP2', vcpu: 2, mem: 7 }, ep3: { label: 'EP3', vcpu: 4, mem: 14 } };
const COMMIT = { sp1y: '1 Year', sp3y: '3 Years' };

module.exports = {
  type: 'functions-premium',
  label: 'Azure Functions Premium plan (Elastic Premium)',
  family: 'compute-other',
  calculator: ['functions'],
  keywords: ['functions premium', 'elastic premium', 'ep1', 'ep2', 'ep3', 'premium plan', 'always ready', 'pre-warmed', 'prewarmed', 'serverless functions no cold start', 'vnet functions'],
  fields: {
    size: { req: true, enum: Object.keys(SIZES), ask: 'How much processing power and memory should each instance have? 1 vCPU and 3.5 GB (ep1), 2 vCPU and 7 GB (ep2), or 4 vCPU and 14 GB (ep3). If unknown, suggest ep1 and record it as an assumption.' },
    alwaysReadyInstances: { req: true, int: true, min: 1, ask: 'How many instances should always be running (always ready)? A Premium plan always has at least one, billed every hour. Use 1 unless they need more constant capacity or zone redundancy (2 or more).' },
    prewarmedInstances: { def: 0, int: true, min: 0, ask: 'Extra instances kept ready only while the app is busy scaling out (pre-warmed, so new load has no cold start). They are billed only while allocated, not while the app is idle. Default 0.' },
    prewarmedHours: { def: 730, ask: 'Hours a month the pre-warmed instances are allocated (730 = all month).' },
    scaleOutInstances: { def: 0, ask: 'On average, how many extra instances does the plan scale out to above the always-ready ones? Default 0.' },
    scaleOutHours: { def: 0, ask: 'Hours a month those extra scale-out instances are running. Default 0.' },
    hours: { def: HOURS, ask: 'Hours a month the always-ready instances run (730 = all month).' },
    commitment: { def: 'payg', enum: ['payg', 'sp1y', 'sp3y'], ask: 'Pay-as-you-go, or compare a 1- or 3-year Azure savings plan for the always-ready instances? Only worth it if they run all month for a year or more.' }
  },
  context: ['production', 'steadyUsage'],
  examples: [
    { type: 'functions-premium', size: 'ep1', alwaysReadyInstances: 1 },
    { type: 'functions-premium', size: 'ep2', alwaysReadyInstances: 2, prewarmedInstances: 1, prewarmedHours: 100, scaleOutInstances: 3, scaleOutHours: 120, commitment: 'sp1y' }
  ],
  readback: c => {
    const s = SIZES[c.size || 'ep1'];
    const ar = c.alwaysReadyInstances ?? 1, pw = c.prewarmedInstances ?? 0, so = c.scaleOutInstances ?? 0;
    const hrs = c.hours ?? HOURS, commit = ({ sp1y: '1-year savings plan', sp3y: '3-year savings plan' })[c.commitment] || 'pay-as-you-go';
    return `Functions Premium ${s ? s.label : c.size}: ${fmtN(ar)} always-ready instance(s) ${c.commitment && c.commitment !== 'payg' ? 'all month' : hrs === HOURS ? 'all month' : `for ${fmtN(hrs)} hours`}${pw ? `, ${fmtN(pw)} pre-warmed for ${fmtN(c.prewarmedHours ?? HOURS)} hours` : ''}${so ? `, ${fmtN(so)} scale-out instance(s) for ${fmtN(c.scaleOutHours ?? 0)} hours` : ''}, ${commit}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The storage account every function app needs, and Application Insights or Log Analytics for monitoring',
    'Virtual network, private endpoints and data sent out to the internet'
  ]),
  price: async (c, ctx) => {
    const s = SIZES[c.size || 'ep1'];
    if (!s) throw new PricingError(`Unknown size "${c.size}". Use ep1, ep2 or ep3.`);
    const ar = c.alwaysReadyInstances ?? 1, pw = c.prewarmedInstances ?? 0, pwh = c.prewarmedHours ?? HOURS;
    const so = c.scaleOutInstances ?? 0, soh = c.scaleOutHours ?? 0, hours = c.hours ?? HOURS, commit = c.commitment || 'payg';
    if (!Number.isInteger(ar) || ar < 1) throw new PricingError('A Premium plan always has at least one always-ready instance: alwaysReadyInstances must be a whole number of 1 or more.');
    if (pw < 0 || so < 0 || pwh < 0 || soh < 0 || hours < 0 || [pwh, soh, hours].some(h => h > 744)) throw new PricingError('Quantities cannot be negative and hours cannot exceed 744 a month.');
    if (commit !== 'payg' && !COMMIT[commit]) throw new PricingError(`Unknown commitment "${commit}". Use payg, sp1y or sp3y.`);
    const rs = await rows(`serviceName eq 'Functions' and ${regionFilter(ctx)} and productName eq 'Premium Functions' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Functions Premium is not offered in ${ctx.region}; choose a nearby region where it is available.`);
    const cpu = single(rs.filter(r => r.meterName === 'Premium vCPU Duration'), 'Premium vCPU duration');
    const mem = single(rs.filter(r => r.meterName === 'Premium Memory Duration'), 'Premium memory duration');
    const G = 'Compute', S = 'Azure Functions';
    const lines = [], notes = [];
    const burstH = pw * pwh + so * soh;
    const baseH = ar * hours;
    const desc = (what, inst) => `Premium ${s.label} ${what}, ${inst}`;
    const add = (m, qty, d, unit) => { if (qty > 0) lines.push(meterLine(G, S, d, m, qty, ctx, { unit })); };
    if (commit === 'payg') {
      const h = baseH + burstH;
      add(cpu, h * s.vcpu, desc('vCPU', `${fmtN(s.vcpu)} vCPU x ${fmtN(h)} instance-hours`), 'vCPU-hours');
      add(mem, h * s.mem, desc('memory', `${fmtN(s.mem)} GB x ${fmtN(h)} instance-hours`), 'GiB-hours');
    } else {
      for (const [m, per, what, unit] of [[cpu, s.vcpu, 'vCPU', 'vCPU-hours'], [mem, s.mem, 'memory', 'GiB-hours']]) {
        const sp = (m[0].savingsPlan || []).find(x => x.term === COMMIT[commit]);
        if (!sp) throw new PricingError(`No ${COMMIT[commit]} savings plan rate for Premium ${what} in ${ctx.region}.`);
        const q = ar * HOURS * per;
        lines.push(line(G, S, `${desc(what, `${fmtN(ar)} always-ready x ${fmtN(per)} ${what === 'vCPU' ? 'vCPU' : 'GB'}`)}, ${COMMIT[commit]} savings plan rate`, q, unit, sp.unitPrice, sp.unitPrice * q, meterInfo(m[0])));
        add(m, burstH * per, desc(what, `${fmtN(per)} ${what === 'vCPU' ? 'vCPU' : 'GB'} x ${fmtN(burstH)} pre-warmed and scale-out instance-hours`), unit);
      }
      notes.push(`${COMMIT[commit]} savings plan: applied here to the always-ready instances only, billed for every hour of the month; pre-warmed and scale-out instances stay at pay-as-you-go. The Azure pricing calculator applies the savings plan rate to all instance-hours, so its total can be lower.`);
      if (hours < HOURS) {
        const payg = hours * (s.vcpu * cpu[0].retailPrice + s.mem * mem[0].retailPrice) * ar;
        notes.push(`You gave ${fmtN(hours)} always-ready hours, but a savings plan bills every hour of the month, so 730 hours are priced; pay-as-you-go for ${fmtN(hours)} hours would cost about ${payg.toFixed(2)} for the always-ready instances.`);
      }
    }
    if (hours < HOURS && commit === 'payg') notes.push('Microsoft states every Premium plan always has at least one active (billed) instance, so fewer than 730 always-ready hours only fits a plan you delete or stop for the rest of the month.');
    notes.push('A Premium plan has no per-execution charge: you pay for the vCPU and memory of the instances that are allocated, including always-ready and pre-warmed ones even when idle.');
    return { lines, notes, facts: { size: c.size || 'ep1', alwaysReady: ar, prewarmed: pw, scaleOut: so, vcpus: ar * s.vcpu, instanceHours: baseH + burstH, commitment: commit } };
  }
};
