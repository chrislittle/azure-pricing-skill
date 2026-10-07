'use strict';
// Azure Durable Task Scheduler. Meters (serviceName 'Durable Task Scheduler'):
// 'Dedicated Capacity Unit' (1 Hour) for the Dedicated SKU and 'Consumption Action' (unit "1") for the Consumption SKU.
// The Learn billing page words the Consumption price as "per million actions" while the Retail API unit is "1" and the
// pricing page says "per action"; we price per the Retail unit and say so in a note.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const SECONDS_PER_MONTH = 2628000;
const CU_ACTIONS_PER_SEC = 2000;
const CONSUMPTION_ACTIONS_PER_SEC = 500;

module.exports = {
  type: 'durable-task-scheduler',
  label: 'Azure Durable Task Scheduler',
  family: 'compute-other',
  calculator: ['functions'],
  keywords: ['durable task scheduler', 'durable functions backend', 'durable task', 'orchestrations', 'workflow state store', 'capacity unit', 'dts'],
  fields: {
    sku: { def: 'dedicated', enum: ['dedicated', 'consumption'], ask: 'Fixed capacity you reserve (dedicated, steady production load, 90-day retention, high availability possible) or pay per action with no base fee (consumption, dev/test and variable load, max 500 actions per second, 30-day retention)? Default dedicated.' },
    orchestrationsPerMonth: { ask: 'About how many orchestrations (workflow runs) a month?' },
    actionsPerOrchestration: { ask: 'About how many actions does one orchestration dispatch (the start, each activity call, each timer or sub-orchestration)? A start plus three activity calls is about 7.' },
    actionsPerMonth: { ask: 'If known, the total actions dispatched a month (overrides orchestrations x actions each).' },
    peakActionsPerSecond: { ask: 'Dedicated: the busiest moment, in actions per second. Each Capacity Unit handles 2,000.' },
    capacityUnits: { int: true, min: 1, max: 3, ask: 'Dedicated only: Capacity Units per scheduler (1 to 3). Leave empty to derive from the workload (shared across the schedulers): monthly actions / 2,628,000 seconds / 2,000 per CU, rounded up, or from the peak per second; use 3 for production high availability.' },
    schedulers: { def: 1, int: true, min: 1, ask: 'Dedicated: how many schedulers (separate instances, each with its own CUs)? Default 1.' },
    hours: { def: HOURS, ask: 'Dedicated: hours a month each scheduler exists (730 = all month). It is billed for provisioned time, not for use.' }
  },
  context: ['production'],
  examples: [
    { type: 'durable-task-scheduler' },
    { type: 'durable-task-scheduler', capacityUnits: 3, schedulers: 2, hours: 500 },
    { type: 'durable-task-scheduler', sku: 'consumption', orchestrationsPerMonth: 20000, actionsPerOrchestration: 7 }
  ],
  readback: c => {
    const a = c.actionsPerMonth ?? (c.orchestrationsPerMonth != null && c.actionsPerOrchestration != null ? c.orchestrationsPerMonth * c.actionsPerOrchestration : null);
    if (c.sku === 'consumption') return `Durable Task Scheduler Consumption: ${a == null ? 'no action volume given' : `${fmtN(a)} actions a month`}`;
    const sized = [a != null ? `${fmtN(a)} actions a month` : null, c.peakActionsPerSecond != null ? `peak ${fmtN(c.peakActionsPerSecond)} actions per second` : null].filter(Boolean).join(', ');
    return `Durable Task Scheduler Dedicated: ${fmtN(c.schedulers ?? 1)} scheduler(s) x ${c.capacityUnits == null ? `CUs sized from workload${sized ? ` (${sized})` : ' (none given, 1 assumed)'}` : fmtN(c.capacityUnits)} Capacity Unit(s)${(c.hours ?? HOURS) === HOURS ? ' all month' : ` for ${fmtN(c.hours)} hours`}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The compute that runs your orchestrations and activities (Functions, Container Apps, App Service or AKS): it is billed separately by that service'
  ]),
  price: async (c, ctx) => {
    const sku = c.sku || 'dedicated';
    if (!['dedicated', 'consumption'].includes(sku)) throw new PricingError('sku must be dedicated or consumption.');
    const actions = c.actionsPerMonth ?? (c.orchestrationsPerMonth != null && c.actionsPerOrchestration != null ? c.orchestrationsPerMonth * c.actionsPerOrchestration : null);
    if (actions != null && actions < 0) throw new PricingError('Action counts cannot be negative.');
    const rs = await rows(`serviceName eq 'Durable Task Scheduler' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Durable Task Scheduler is not offered in ${ctx.region}; choose a region where it is available (for example eastus2).`);
    const G = 'Compute', S = 'Durable Task Scheduler';
    const notes = [];
    if (sku === 'consumption') {
      if (actions == null) throw new PricingError('Consumption needs actionsPerMonth, or orchestrationsPerMonth and actionsPerOrchestration.');
      if (actions / SECONDS_PER_MONTH > CONSUMPTION_ACTIONS_PER_SEC) throw new PricingError(`That volume averages more than ${CONSUMPTION_ACTIONS_PER_SEC} actions per second, the Consumption limit; use Dedicated.`);
      const m = single(rs.filter(r => r.meterName === 'Consumption Action'), 'Durable Task Scheduler Consumption Action');
      notes.push('Consumption bills only the actions dispatched, with no base fee, up to 500 actions per second and 30-day retention, and at most 10 schedulers per region.');
      notes.push('Price unit: the Azure Retail Prices API and the pricing page quote this rate per action, but the Microsoft Learn billing page words it as "regional price per million actions". This estimate uses the Retail API unit (per action); confirm the price unit with Microsoft before quoting.');
      return { lines: [meterLine(G, S, `Consumption actions, ${fmtN(actions)} actions`, m, actions, ctx, { unit: 'actions' })], notes, facts: { sku, actions, capacityUnits: 0 } };
    }
    const sch = c.schedulers ?? 1, hours = c.hours ?? HOURS;
    if (!Number.isInteger(sch) || sch < 1) throw new PricingError('schedulers must be a whole number of 1 or more.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744.');
    let cu = c.capacityUnits;
    if (cu == null) {
      const need = Math.max(c.peakActionsPerSecond != null ? c.peakActionsPerSecond / CU_ACTIONS_PER_SEC : 0, actions != null ? actions / SECONDS_PER_MONTH / CU_ACTIONS_PER_SEC : 0) / sch;
      cu = Math.max(1, Math.ceil(need));
      notes.push(actions == null && c.peakActionsPerSecond == null ? 'No workload was given, so 1 Capacity Unit per scheduler is assumed; give monthly actions or a peak per second, or set capacityUnits.' : `Capacity Units per scheduler were derived from the workload spread over ${fmtN(sch)} scheduler(s) (monthly actions / 2,628,000 seconds / 2,000 per CU, or the peak per second, rounded up) as ${cu}; set capacityUnits to override.`);
    }
    if (!Number.isInteger(cu) || cu < 1 || cu > 3) throw new PricingError(cu > 3 ? 'A Dedicated scheduler supports up to 3 Capacity Units; use more schedulers to go further.' : 'capacityUnits must be a whole number from 1 to 3 per scheduler.');
    const m = single(rs.filter(r => r.meterName === 'Dedicated Capacity Unit'), 'Durable Task Scheduler Dedicated Capacity Unit');
    if (sch > 25) notes.push('25 schedulers per region and subscription is the default Dedicated quota; contact Microsoft support for more.');
    if (cu < 3) notes.push('A scheduler with fewer than 3 CUs has no high availability; Microsoft requires 3 CUs for HA.');
    notes.push('The Dedicated SKU bills provisioned Capacity Units per hour whether or not orchestrations run.', 'Compute that hosts your orchestrations and activities is billed separately by the host service.');
    const units = cu * sch;
    return { lines: [meterLine(G, S, `Dedicated Capacity Units, ${fmtN(sch)} scheduler(s) x ${fmtN(cu)} CU x ${fmtN(hours)} hours`, m, units * hours, ctx, { unit: 'CU-hours' })], notes, facts: { sku, capacityUnits: cu, schedulers: sch, totalCapacityUnits: units, hours } };
  }
};
