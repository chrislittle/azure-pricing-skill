'use strict';
// Azure Chaos Studio. One meter: Essential Action-Minute (regional rows plus a regionless 'Global' row at the same price).
// Calculator rows are "actions x minutes that action runs".
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const REGIONS = 'australiaeast, brazilsouth, centralus, eastus, eastus2, japaneast, northcentralus, southeastasia, swedencentral, uksouth, westcentralus, westeurope, westus';

module.exports = {
  type: 'chaos-studio',
  label: 'Azure Chaos Studio',
  family: 'management',
  calculator: ['chaos-studio'],
  keywords: ['chaos', 'chaos engineering', 'fault injection', 'resilience testing', 'failure testing', 'chaos experiment'],
  fields: {
    experimentRuns: { req: true, int: true, min: 0, ask: 'How many times a month will you run a chaos experiment (a test that deliberately injects failures such as stopping a VM)? If unknown, suggest 10 and record it as an assumption.' },
    actionsPerRun: { def: 1, int: true, min: 0, ask: 'How many fault actions does one run contain (each fault you inject, such as "stop VM" or "add CPU pressure", is one action)? If unknown, suggest 1.' },
    minutesPerAction: { def: 10, int: true, min: 0, max: 720, ask: 'How many minutes does each fault action run for? Actions that run at the same time each count their own minutes. If unknown, suggest 10 and record it as an assumption. (An action can run up to 12 hours = 720 minutes.) If the actions differ a lot, add one component per kind of action.' }
  },
  context: [],
  examples: [
    { type: 'chaos-studio', experimentRuns: 4 },
    { type: 'chaos-studio', experimentRuns: 20, actionsPerRun: 6, minutesPerAction: 30 }
  ],
  readback: c => `Chaos Studio: ${fmtN(n(c.experimentRuns))} experiment runs a month, ${fmtN(c.actionsPerRun ?? 1)} fault action(s) per run, each action running ${fmtN(c.minutesPerAction ?? 10)} minutes = ${fmtN(n(c.experimentRuns) * n(c.actionsPerRun ?? 1) * n(c.minutesPerAction ?? 10))} action-minutes`,
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['The Azure resources the experiments run against (VMs, AKS clusters, etc.) are billed on their own, and an experiment can trigger charges for other services (for example autoscaling that deploys new resources)'],
  price: async (c, ctx) => {
    const runs = n(c.experimentRuns), mins = n(c.minutesPerAction ?? 10), acts = n(c.actionsPerRun ?? 1);
    if (runs < 0 || mins < 0 || acts < 0) throw new PricingError('experimentRuns, actionsPerRun and minutesPerAction must not be negative.');
    if (mins > 720) throw new PricingError('A fault action can run for at most 12 hours (720 minutes).');
    let rs = await rows(`serviceName eq 'Azure Chaos Studio' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    let viaGlobal = false;
    if (!rs.length) {
      rs = await rows(`serviceName eq 'Azure Chaos Studio' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
      viaGlobal = rs.length > 0 && !/^(usgov|usdod|usnat|ussec|china)/.test(ctx.region);
      if (!viaGlobal) rs = [];
    }
    if (!rs.length) throw new PricingError(`Chaos Studio is not priced in ${ctx.region}. Priced regions: ${REGIONS}.`);
    const m = single(rs.filter(r => r.meterName === 'Essential Action-Minute'), 'Chaos Studio action-minutes');
    const am = runs * acts * mins;
    const lines = [meterLine('Management', 'Azure Chaos Studio', `Chaos Studio fault actions: ${fmtN(runs)} runs x ${fmtN(acts)} action(s) x ${fmtN(mins)} minutes = ${fmtN(am)} action-minutes`, m, am, ctx, { unit: 'action-minutes' })];
    const notes = ['Chaos Studio is billed per action-minute: each fault action is charged for the minutes it runs, so actions running at the same time each add their own minutes.',
      'Running chaos experiments may involve additional charges for other services, for example if CPU load triggers autoscaling that deploys new resources.',
      'Chaos Studio Workspaces (preview) billing is not documented separately; this estimate uses the published action-minute meter.'];
    if (viaGlobal) notes.push(`Chaos Studio has no regional price for ${ctx.region}; the regionless global rate is used. Chaos Studio is offered in: ${REGIONS}.`);
    return { lines, notes, facts: { experimentRuns: runs, actionMinutes: am } };
  }
};
