'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const SLUG = 'storage-actions';
const CALC_REGION = { eastus2: 'us-east-2', westeurope: 'europe-west' };
const OFFER = {
  execution: 'azure-storage-tasks-execution',
  targeted: 'azure-storage-tasks-objects-targeted',
  operations: 'azure-storage-tasks-operations-invoked',
};
const calcCache = new Map();
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function calcProduct() {
  if (calcCache.has(SLUG)) return calcCache.get(SLUG);
  let last;
  for (const v of ['v2', 'v3']) {
    const res = await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
    if (res.ok) { const j = await res.json(); calcCache.set(SLUG, j); return j; }
    last = new Error(`calculator ${v} HTTP ${res.status}`);
  }
  throw last;
}
async function calcPrice(kind, region) {
  const unitKey = kind === 'execution' ? 'permillion' : 'permillion';
  const d = await calcProduct();
  const prices = d.offers[OFFER[kind]]?.prices || {};
  const p = (prices.permillion || prices.perunit || prices['1'])?.[CALC_REGION[region]];
  if (!p) throw new Error(`no Storage Actions calculator price ${kind} ${region}`);
  return p.value;
}
async function retailMeter(o, meter) {
  const rows = dedupe(await query(`serviceName eq 'Storage' and productName eq 'Storage Actions' and skuName eq 'Azure Storage Tasks' and armRegionName eq '${o.region}'`, o.currency || 'USD'));
  const row = rows.find(r => r.type === 'Consumption' && r.meterName === meter);
  if (!row) throw new Error(`no Storage Actions meter ${meter}`);
  return { value: row.retailPrice, meterId: row.meterId, unit: unitSize(row.unitOfMeasure) };
}
async function unit(o, kind) {
  if ((o.currency || 'USD') === 'USD') return { value: await calcPrice(kind, o.region), unit: kind === 'execution' ? 1 : 1e6, sourceOffer: OFFER[kind] };
  if (kind === 'execution') return retailMeter(o, 'Azure Storage Tasks Task Execution');
  if (kind === 'targeted') return retailMeter(o, 'Azure Storage Tasks Objects Targeted');
  return retailMeter(o, 'Azure Storage Tasks Operations Invoked');
}
async function price(o) {
  const runs = o.runsPerMonth || 0;
  const scanned = runs * (o.objectsPerRun || 0);
  const operations = runs * (o.matchingObjectsPerRun || 0) * (o.operationsPerMatch || 1);
  const ex = await unit(o, 'execution');
  const tg = await unit(o, 'targeted');
  const op = await unit(o, 'operations');
  const lines = [
    line(`Task executions ${runs} * ${ex.value}`, (runs / ex.unit) * ex.value, ex),
    line(`Objects targeted ${scanned} / ${tg.unit} * ${tg.value}`, (scanned / tg.unit) * tg.value, tg),
  ];
  if (operations) lines.push(line(`Operations invoked ${operations} / ${op.unit} * ${op.value}`, (operations / op.unit) * op.value, op));
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'storage-actions', source: 'both', cases: [
  { name: 'single run one million scan', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-actions', runsPerMonth: 1, objectsPerRun: 1000000, matchingObjectsPerRun: 0 },
    // Calculator v3 has per-task execution and per-million objects-targeted offers.
    expected: () => price({ region: 'eastus2', runsPerMonth: 1, objectsPerRun: 1000000, matchingObjectsPerRun: 0 }) },
  { name: 'daily scan no matches', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-actions', runsPerMonth: 30, objectsPerRun: 500000, matchingObjectsPerRun: 0 },
    // Objects targeted are runs * objectsPerRun, billed per million, plus each task execution.
    expected: () => price({ region: 'eastus2', runsPerMonth: 30, objectsPerRun: 500000, matchingObjectsPerRun: 0 }) },
  { name: 'matches with two operations', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-actions', runsPerMonth: 10, objectsPerRun: 2000000, matchingObjectsPerRun: 100000, operationsPerMatch: 2 },
    // Operations invoked are matching objects * operationsPerMatch * runs, billed per million.
    expected: () => price({ region: 'eastus2', runsPerMonth: 10, objectsPerRun: 2000000, matchingObjectsPerRun: 100000, operationsPerMatch: 2 }) },
  { name: 'zero runs boundary', region: 'eastus2', currency: 'USD',
    component: { type: 'storage-actions', runsPerMonth: 0, objectsPerRun: 1000000, matchingObjectsPerRun: 100000 },
    // Boundary case: zero task executions means zero targeted objects and zero operations.
    expected: () => price({ region: 'eastus2', runsPerMonth: 0, objectsPerRun: 1000000, matchingObjectsPerRun: 100000 }) },
  { name: 'westeurope non us', region: 'westeurope', currency: 'USD',
    component: { type: 'storage-actions', runsPerMonth: 3, objectsPerRun: 1500000, matchingObjectsPerRun: 10000, operationsPerMatch: 1 },
    // Non-US calculator region europe-west uses the same offer shape with regional prices.
    expected: () => price({ region: 'westeurope', runsPerMonth: 3, objectsPerRun: 1500000, matchingObjectsPerRun: 10000, operationsPerMatch: 1 }) },
  { name: 'eur via retail api', region: 'westeurope', currency: 'EUR',
    component: { type: 'storage-actions', runsPerMonth: 2, objectsPerRun: 1000000, matchingObjectsPerRun: 250000, operationsPerMatch: 3 },
    // EUR case uses Retail API Storage Actions meters for task execution, objects targeted, and operations invoked.
    expected: () => price({ region: 'westeurope', currency: 'EUR', runsPerMonth: 2, objectsPerRun: 1000000, matchingObjectsPerRun: 250000, operationsPerMatch: 3 }) },
] };
