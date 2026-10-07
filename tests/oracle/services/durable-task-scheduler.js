'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'functions';
const HOURS_PER_MONTH = 730;
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;
const ACTIONS_PER_SECOND_PER_CU = 2000;

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function actions(c) { return c.actionsPerMonth != null ? c.actionsPerMonth : (c.orchestrationsPerMonth || 0) * (c.actionsPerOrchestration || 0); }
function derivedCUs(c) {
  if (c.capacityUnits != null) return c.capacityUnits;
  const monthlyRate = actions(c) / SECONDS_PER_MONTH;
  const peak = c.peakActionsPerSecond || 0;
  return Math.min(3, Math.max(1, Math.ceil(Math.max(monthlyRate, peak) / ACTIONS_PER_SECOND_PER_CU)));
}
async function dedicatedCalc({ region, capacityUnits, schedulers = 1, hours = HOURS_PER_MONTH, actionsPerMonth, orchestrationsPerMonth, actionsPerOrchestration, peakActionsPerSecond }) {
  const cu = derivedCUs({ capacityUnits, actionsPerMonth, orchestrationsPerMonth, actionsPerOrchestration, peakActionsPerSecond });
  const rate = (await calc.offerPrice(SLUG, 'durable-task-scheduler', region)).value;
  const lines = [line(`Dedicated Capacity Unit: ${schedulers} schedulers * ${cu} CUs * ${hours} hours * ${rate}`, schedulers * cu * hours * rate, { sourceOffer: 'durable-task-scheduler' })];
  return { monthlyList: totalOf(lines), lines };
}
async function retailRows(region, currency) {
  return dedupe(await query(`serviceName eq 'Durable Task Scheduler' and armRegionName eq '${region}'`, currency));
}
async function dedicatedRetail({ region, currency, capacityUnits = 1, schedulers = 1, hours = HOURS_PER_MONTH }) {
  const rows = await retailRows(region, currency);
  const hits = rows.filter(r => r.productName === 'Durable Task Scheduler' && r.skuName === 'Dedicated' && r.meterName === 'Dedicated Capacity Unit');
  if (hits.length !== 1) throw new Error(`expected one Durable Task Scheduler dedicated CU row, found ${hits.length}`);
  const r = hits[0];
  const lines = [line(`Dedicated Capacity Unit: ${schedulers} schedulers * ${capacityUnits} CUs * ${hours} hours / ${unitSize(r.unitOfMeasure)} * ${r.retailPrice}`, schedulers * capacityUnits * hours / unitSize(r.unitOfMeasure) * r.retailPrice, { meterId: r.meterId })];
  return { monthlyList: totalOf(lines), lines };
}
async function consumptionRetail({ region, currency, actionsPerMonth, orchestrationsPerMonth, actionsPerOrchestration }) {
  const count = actions({ actionsPerMonth, orchestrationsPerMonth, actionsPerOrchestration });
  const rows = await retailRows(region, currency);
  const hits = rows.filter(r => r.productName === 'Durable Task Scheduler' && r.skuName === 'Consumption' && r.meterName === 'Consumption Action');
  if (hits.length !== 1) throw new Error(`expected one Durable Task Scheduler consumption action row, found ${hits.length}`);
  const r = hits[0];
  const lines = [line(`Consumption Action: ${count} actions / ${unitSize(r.unitOfMeasure)} * ${r.retailPrice}`, count / unitSize(r.unitOfMeasure) * r.retailPrice, { meterId: r.meterId })];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'durable-task-scheduler',
  source: 'both',
  cases: [
    {
      name: 'one scheduler one CU all month', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'dedicated', capacityUnits: 1, schedulers: 1 },
      // Calculator durable-task-scheduler offer is an hourly Dedicated Capacity Unit price.
      expected: async () => dedicatedCalc({ region: 'eastus2', capacityUnits: 1, schedulers: 1 }),
    },
    {
      name: 'high availability three CUs', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'dedicated', capacityUnits: 3, schedulers: 1 },
      // Production HA guidance maps to 3 provisioned CUs; billing is provisioned CU-hours, not actions.
      expected: async () => dedicatedCalc({ region: 'eastus2', capacityUnits: 3, schedulers: 1 }),
    },
    {
      name: 'derived CUs from monthly actions', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'dedicated', actionsPerMonth: 5256000001, schedulers: 1 },
      // Derive CUs as ceil((monthly actions / 2,628,000 seconds) / 2,000 actions/sec), capped at 3.
      expected: async () => dedicatedCalc({ region: 'eastus2', actionsPerMonth: 5256000001, schedulers: 1 }),
    },
    {
      name: 'learn sizing example derives two CUs', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'dedicated', orchestrationsPerMonth: 500000000, actionsPerOrchestration: 15, schedulers: 1 },
      // Learn sizing example: 500M orchestrations * 15 actions = 7.5B actions/month, ceil(7.5B / 2,628,000 / 2,000) = 2 CUs = $1,000.
      expected: async () => dedicatedCalc({ region: 'eastus2', orchestrationsPerMonth: 500000000, actionsPerOrchestration: 15, schedulers: 1 }),
    },
    {
      name: 'derived CUs from peak actions per second', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'dedicated', peakActionsPerSecond: 4500, schedulers: 1 },
      // Peak 4,500 actions/sec requires ceil(4,500 / 2,000) = 3 CUs.
      expected: async () => dedicatedCalc({ region: 'eastus2', peakActionsPerSecond: 4500, schedulers: 1 }),
    },
    {
      name: 'two schedulers part-time', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'dedicated', capacityUnits: 2, schedulers: 2, hours: 100 },
      // Provisioned time: 2 schedulers * 2 CUs * 100 hours * hourly CU price.
      expected: async () => dedicatedCalc({ region: 'eastus2', capacityUnits: 2, schedulers: 2, hours: 100 }),
    },
    {
      name: 'consumption actions direct', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'consumption', actionsPerMonth: 1000 },
      // Consumption SKU has no base fee: Retail API Consumption Action meter is per action.
      expected: async () => consumptionRetail({ region: 'eastus2', currency: 'USD', actionsPerMonth: 1000 }),
    },
    {
      name: 'consumption actions from orchestrations', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'consumption', orchestrationsPerMonth: 10, actionsPerOrchestration: 7 },
      // If total actions are not supplied, actions = orchestrations per month * actions per orchestration.
      expected: async () => consumptionRetail({ region: 'eastus2', currency: 'USD', orchestrationsPerMonth: 10, actionsPerOrchestration: 7 }),
    },
    {
      name: 'consumption 20000 orchestrations seven actions', region: 'eastus2', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'consumption', orchestrationsPerMonth: 20000, actionsPerOrchestration: 7 },
      // Consumption Action is $0.003/action in East US 2: 20,000 orchestrations * 7 actions * $0.003 = $420.00.
      expected: async () => consumptionRetail({ region: 'eastus2', currency: 'USD', orchestrationsPerMonth: 20000, actionsPerOrchestration: 7 }),
    },
    {
      name: 'consumption 30000 actions west europe EUR', region: 'westeurope', currency: 'EUR',
      component: { type: 'durable-task-scheduler', sku: 'consumption', actionsPerMonth: 30000 },
      // EUR comes from Retail API Consumption Action meter in West Europe: 30,000 actions = €113.25.
      expected: async () => consumptionRetail({ region: 'westeurope', currency: 'EUR', actionsPerMonth: 30000 }),
    },
    {
      name: 'west europe non-us', region: 'westeurope', currency: 'USD',
      component: { type: 'durable-task-scheduler', sku: 'dedicated', capacityUnits: 1, schedulers: 2, hours: 50 },
      // Non-US region uses West Europe calculator Dedicated Capacity Unit rate.
      expected: async () => dedicatedCalc({ region: 'westeurope', capacityUnits: 1, schedulers: 2, hours: 50 }),
    },
    {
      name: 'east us 2 EUR retail', region: 'eastus2', currency: 'EUR',
      component: { type: 'durable-task-scheduler', sku: 'dedicated', capacityUnits: 1, schedulers: 1, hours: 25 },
      // EUR comes from Retail API Durable Task Scheduler Dedicated Capacity Unit meter.
      expected: async () => dedicatedRetail({ region: 'eastus2', currency: 'EUR', capacityUnits: 1, schedulers: 1, hours: 25 }),
    },
  ],
};
