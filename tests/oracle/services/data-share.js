'use strict';

const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'data-share';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function offer(name, region) { return (await calc.offerPrice(SLUG, name, region)).value; }
async function rows(region, currency) { return dedupe(await query(`serviceName eq 'Azure Data Share' and armRegionName eq '${region}'`, currency)); }
async function dataShare({ region, currency = 'USD', datasetSnapshots, executionHours = 0, vCores = 2 }) {
  let snap, exec, sx = {}, ex = {};
  if (currency === 'USD' && !region.startsWith('usgov')) {
    snap = await offer('data-share-dataset-movement', region);
    exec = await offer('data-share-snapshot-execution', region);
    sx = { sourceOffer: 'data-share-dataset-movement' }; ex = { sourceOffer: 'data-share-snapshot-execution' };
  } else {
    const rs = await rows(region, currency);
    const sm = rs.find(r => r.meterName === 'Dataset Snapshots');
    const em = rs.find(r => r.meterName === 'Snapshot Execution vCore');
    snap = sm.retailPrice; exec = em.retailPrice; sx = { meterId: sm.meterId }; ex = { meterId: em.meterId };
  }
  const lines = [
    line(`${currency} dataset snapshots: ${datasetSnapshots} * ${snap}`, datasetSnapshots * snap, sx),
    line(`${currency} snapshot execution: ${executionHours} hours * ${vCores} vCores * ${exec}`, executionHours * vCores * exec, ex),
  ];
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'data-share', source: 'both', cases: [
  { name: 'daily one dataset snapshots only', region: 'eastus2', currency: 'USD', component: { type: 'data-share', datasetSnapshots: 30, executionHours: 0, vCores: 2 },
    // Calculator dataset-movement offer is per dataset snapshot; snapshot execution is per vCore-hour and is zero here.
    expected: async () => dataShare({ region: 'eastus2', datasetSnapshots: 30, executionHours: 0, vCores: 2 }) },
  { name: 'execution hours with default two vcores', region: 'eastus2', currency: 'USD', component: { type: 'data-share', datasetSnapshots: 180, executionHours: 15, vCores: 2 },
    // Calculator bills dataset snapshots plus dataset movement as executionHours * vCores.
    expected: async () => dataShare({ region: 'eastus2', datasetSnapshots: 180, executionHours: 15, vCores: 2 }) },
  { name: 'four vcore large snapshots', region: 'eastus2', currency: 'USD', component: { type: 'data-share', datasetSnapshots: 1000, executionHours: 40, vCores: 4 },
    // Calculator dataset movement scales linearly with vCore-hours.
    expected: async () => dataShare({ region: 'eastus2', datasetSnapshots: 1000, executionHours: 40, vCores: 4 }) },
  { name: 'zero snapshots in-place sharing', region: 'eastus2', currency: 'USD', component: { type: 'data-share', datasetSnapshots: 0, executionHours: 0, vCores: 2 },
    // Pricing page treats in-place sharing with no copied snapshots as zero for these meters.
    expected: async () => dataShare({ region: 'eastus2', datasetSnapshots: 0, executionHours: 0, vCores: 2 }) },
  { name: 'non-US west europe snapshots', region: 'westeurope', currency: 'USD', component: { type: 'data-share', datasetSnapshots: 90, executionHours: 7.5, vCores: 2 },
    // Calculator West Europe snapshot and movement offers are region-specific.
    expected: async () => dataShare({ region: 'westeurope', datasetSnapshots: 90, executionHours: 7.5, vCores: 2 }) },
  { name: 'EUR retail west europe execution', region: 'westeurope', currency: 'EUR', component: { type: 'data-share', datasetSnapshots: 90, executionHours: 7.5, vCores: 2 },
    // Retail API EUR Dataset Snapshots and Snapshot Execution vCore meters are multiplied directly.
    expected: async () => dataShare({ region: 'westeurope', currency: 'EUR', datasetSnapshots: 90, executionHours: 7.5, vCores: 2 }) },
  { name: 'US Gov Virginia retail execution', region: 'usgovvirginia', currency: 'USD', component: { type: 'data-share', datasetSnapshots: 24, executionHours: 6, vCores: 2 },
    // Retail API US Gov Virginia Dataset Snapshots is per snapshot; Snapshot Execution vCore is per vCore-hour.
    expected: async () => dataShare({ region: 'usgovvirginia', datasetSnapshots: 24, executionHours: 6, vCores: 2 }) },
] };
