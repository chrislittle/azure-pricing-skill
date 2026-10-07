'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'synapse-analytics';
const HOURS_PER_MONTH = 730;
const SPARK_VCORES = { small: 4, medium: 8, large: 16, xlarge: 32, xxlarge: 64, xxxlarge: 80 };
const RUNTIME = {
  azure: { move: 'data-movement-azure-hosted', activity: 'integration-runtime-azure-hosted', external: 'external-integration-runtime-azure-hosted', orchestration: 'orchestration-azure-hosted' },
  'self-hosted': { move: 'data-movement-self-hosted', activity: 'integration-runtime-self-hosted', external: 'external-integration-runtime-self-hosted', orchestration: 'orchestration-self-hosted' },
  'managed-vnet': { move: 'data-movement-azure-hosted-vnet', activity: 'integration-runtime-azure-hosted-vnet', external: 'external-integration-runtime-azure-hosted-vnet', orchestration: 'orchestration-azure-hosted-vnet' },
};
const COMMIT_UNIT = { payg: 'perhour', ri1y: 'perhouroneyearreserved', ri3y: 'perhourthreeyearreserved' };
const SSIS_SIZES = [
  { name: 'D1 v2', vcpu: 1, memory: 3.5 }, { name: 'D2 v2', vcpu: 2, memory: 7 }, { name: 'D3 v2', vcpu: 4, memory: 14 }, { name: 'D4 v2', vcpu: 8, memory: 28 },
  { name: 'D2 v3', vcpu: 2, memory: 8 }, { name: 'D4 v3', vcpu: 4, memory: 16 }, { name: 'D8 v3', vcpu: 8, memory: 32 }, { name: 'D16 v3', vcpu: 16, memory: 64 }, { name: 'D32 v3', vcpu: 32, memory: 128 }, { name: 'D64 v3', vcpu: 64, memory: 256 },
  { name: 'E2 v3', vcpu: 2, memory: 16 }, { name: 'E4 v3', vcpu: 4, memory: 32 }, { name: 'E8 v3', vcpu: 8, memory: 64 }, { name: 'E16 v3', vcpu: 16, memory: 128 }, { name: 'E32 v3', vcpu: 32, memory: 256 }, { name: 'E64 v3', vcpu: 64, memory: 432 },
  { name: 'A4 v2', vcpu: 4, memory: 8 }, { name: 'A8 v2', vcpu: 8, memory: 16 },
];
const cache = new Map();

async function product() {
  if (cache.has(SLUG)) return cache.get(SLUG);
  let last;
  for (const v of ['v2', 'v3']) {
    try {
      const res = await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
      if (!res.ok) { last = new Error(`calculator ${v} HTTP ${res.status}`); continue; }
      const j = await res.json(); cache.set(SLUG, j); return j;
    } catch (e) { last = e; }
  }
  throw last;
}
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function price(data, offer, region, unit) {
  const r = calc.calcRegion(data, region);
  const table = data.offers[offer] && data.offers[offer].prices && data.offers[offer].prices[unit];
  if (!table) throw new Error(`Synapse calculator missing ${offer}/${unit}`);
  const p = table[r] || table.global;
  if (!p) throw new Error(`Synapse calculator missing ${offer}/${unit}/${r}`);
  return p.value;
}
function graduated(data, offer, region, unit, qty) {
  const r = calc.calcRegion(data, region);
  const table = data.offers[offer] && data.offers[offer].graduatedPrices && data.offers[offer].graduatedPrices[unit] && (data.offers[offer].graduatedPrices[unit][r] || data.offers[offer].graduatedPrices[unit].global);
  if (!table) throw new Error(`Synapse calculator missing graduated ${offer}/${unit}`);
  let prev = 0, cost = 0;
  for (const band of table.prices) {
    const units = Math.max(0, Math.min(qty, band.limit) - prev);
    if (units) cost += units * band.price.value;
    prev = band.limit;
    if (qty <= band.limit) break;
  }
  return cost;
}
async function retailRows(region, currency = 'USD') { return dedupe(await query(`serviceName eq 'Azure Synapse Analytics' and armRegionName eq '${region}'`, currency)); }
async function synapseLinkRows(currency = 'USD') { return dedupe(await query(`serviceName eq 'Azure Synapse Analytics'`, currency)); }
function one(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one Synapse Retail API row for ${what}, found ${hits.length}`); return hits[0]; }
function selectSsisSize(rows, edition, license, vcpu, memory) {
  const needVcpu = vcpu || 4;
  const needMemory = memory || 16;
  if (needVcpu > 64) throw new Error(`SSIS Azure-SSIS IR supports at most 64 vCPU per node; requested ${needVcpu}`);
  const priced = SSIS_SIZES.filter(sz => sz.vcpu >= needVcpu && sz.memory >= needMemory)
    .map(sz => {
      const meterName = `${sz.name} ${license}`;
      const matches = rows.filter(r => r.productName.startsWith(`Azure Synapse SSIS ${edition}`) && r.skuName === sz.name && r.meterName === meterName && r.type === 'Consumption');
      return matches.length === 1 ? { size: sz, row: matches[0] } : null;
    }).filter(Boolean);
  const isV3 = c => /[DE]\d+ v3$/.test(c.size.name);
  const v3 = priced.filter(isV3);
  const candidates = v3.length ? v3 : priced;
  candidates.sort((a, b) => a.row.retailPrice - b.row.retailPrice || a.size.vcpu - b.size.vcpu || a.size.memory - b.size.memory);
  if (!candidates.length) throw new Error(`no SSIS ${edition} ${license} node fits ${needVcpu} vCPU/${needMemory} GiB`);
  return candidates[0];
}
async function retailSynapse({ region, currency = 'USD', dedicatedDwu = 0, dedicatedHours = HOURS_PER_MONTH, dedicatedStorageTB = 0, geoBackupTB = 0, serverlessTB = 0, sparkNodes = 0, sparkNodeSize = 'medium', sparkHours = HOURS_PER_MONTH, dataFlowVcoreHours = 0, dataFlowType = 'basic', pipelineRuns = 0, pipelineRuntime = 'azure', dataMovementHours = 0, pipelineActivityHours = 0, externalActivityHours = 0, pipelineOperations = 0, synapseLinkVcores = 0, synapseLinkHours = HOURS_PER_MONTH, ssisNodes = 0, ssisNodeVcpu = 4, ssisNodeMemoryGiB = 16, ssisEdition = 'standard', ssisLicense = 'included', ssisHours = HOURS_PER_MONTH }) {
  const rows = await retailRows(region, currency);
  const lines = [];
  if (currency !== 'USD' && dedicatedDwu) {
    const sku = `DW${dedicatedDwu}c`;
    const m = one(rows, r => r.productName === 'Azure Synapse Analytics Dedicated SQL Pool' && r.skuName === sku && r.type === 'Consumption', `${sku} dedicated SQL pool`);
    lines.push(line(`${currency} dedicated SQL pool ${sku}: ${dedicatedHours} hours * ${m.retailPrice}`, dedicatedHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (currency !== 'USD' && dedicatedStorageTB) {
    const m = one(rows, r => r.productName === 'Azure Synapse Analytics SQL Provisioned Storage' && r.meterName === 'Standard Data Stored' && r.type === 'Consumption', 'dedicated SQL storage');
    lines.push(line(`${currency} dedicated SQL storage: ${dedicatedStorageTB} TB * ${m.retailPrice}`, dedicatedStorageTB / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (currency !== 'USD' && geoBackupTB) {
    const m = one(rows, r => r.productName === 'Azure Synapse Analytics SQL Disaster Recovery Storage' && r.meterName === 'Standard RA-GRS Data Stored' && r.type === 'Consumption', 'geo backup storage');
    lines.push(line(`${currency} geo-backup: ${geoBackupTB} TB * 1024 GB/TB * ${m.retailPrice}`, geoBackupTB * 1024 / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (currency !== 'USD' && serverlessTB) {
    const m = one(rows, r => r.productName === 'Azure Synapse Analytics Serverless SQL Pool' && r.meterName === 'Standard Data Processed' && r.type === 'Consumption', 'serverless SQL');
    lines.push(line(`${currency} serverless SQL: ${serverlessTB} TB * ${m.retailPrice}`, serverlessTB / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (currency !== 'USD' && sparkNodes) {
    const m = one(rows, r => r.productName === 'Azure Synapse Analytics Serverless Apache Spark Pool - Memory Optimized' && r.meterName === 'vCore' && r.type === 'Consumption', 'memory optimized Spark');
    const vcores = SPARK_VCORES[sparkNodeSize || 'medium'];
    lines.push(line(`${currency} Spark memory optimized: ${sparkNodes} * ${vcores} vCores * ${sparkHours} hours * ${m.retailPrice}`, sparkNodes * vcores * sparkHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (dataFlowVcoreHours && (dataFlowType === 'compute-optimized' || currency !== 'USD')) {
    const names = { basic: 'Azure Synapse Analytics Data Flow - Basic', standard: 'Azure Synapse Analytics Data Flow - Standard', 'compute-optimized': 'Azure Synapse Analytics Data Flow - Compute Optimized' };
    const m = one(rows, r => r.productName === names[dataFlowType] && r.meterName === 'vCore' && r.type === 'Consumption', `${dataFlowType} data flow`);
    lines.push(line(`${currency} ${dataFlowType} data flow: ${dataFlowVcoreHours} vCore-hours * ${m.retailPrice}`, dataFlowVcoreHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  const rt = RUNTIME[pipelineRuntime || 'azure'];
  const pipelineNames = {
    [rt.orchestration]: pipelineRuntime === 'managed-vnet' ? 'Azure Hosted Managed VNET IR Orchestration Activity Run' : pipelineRuntime === 'self-hosted' ? 'Self Hosted IR Orchestration Activity Run' : 'Azure Hosted IR Orchestration Activity Run',
    [rt.move]: pipelineRuntime === 'managed-vnet' ? 'Azure Hosted Managed VNET IR Data Movement' : pipelineRuntime === 'self-hosted' ? 'Self Hosted IR Data Movement' : 'Azure Hosted IR Data Movement',
    [rt.activity]: pipelineRuntime === 'managed-vnet' ? 'Azure Hosted Managed VNET IR Pipeline Activity' : pipelineRuntime === 'self-hosted' ? 'Self Hosted IR Pipeline Activity' : 'Azure Hosted IR Pipeline Activity',
    [rt.external]: pipelineRuntime === 'managed-vnet' ? 'Azure Hosted Managed VNET IR External Pipeline Activity' : pipelineRuntime === 'self-hosted' ? 'Self Hosted IR External Pipeline Activity' : 'Azure Hosted IR External Pipeline Activity',
  };
  if (currency !== 'USD' && pipelineRuns) { const m = one(rows, r => r.productName === 'Azure Synapse Analytics Pipelines' && r.meterName === pipelineNames[rt.orchestration] && r.type === 'Consumption', 'pipeline orchestration'); lines.push(line(`${currency} pipeline orchestration: ${pipelineRuns}/1000 * ${m.retailPrice}`, pipelineRuns / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId })); }
  if (currency !== 'USD' && dataMovementHours) { const m = one(rows, r => r.productName === 'Azure Synapse Analytics Pipelines' && r.meterName === pipelineNames[rt.move] && r.type === 'Consumption', 'data movement'); lines.push(line(`${currency} data movement: ${dataMovementHours} * ${m.retailPrice}`, dataMovementHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId })); }
  if (currency !== 'USD' && pipelineActivityHours) { const m = one(rows, r => r.productName === 'Azure Synapse Analytics Pipelines' && r.meterName === pipelineNames[rt.activity] && r.type === 'Consumption', 'pipeline activity'); lines.push(line(`${currency} pipeline activity: ${pipelineActivityHours} * ${m.retailPrice}`, pipelineActivityHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId })); }
  if (currency !== 'USD' && externalActivityHours) { const m = one(rows, r => r.productName === 'Azure Synapse Analytics Pipelines' && r.meterName === pipelineNames[rt.external] && r.type === 'Consumption', 'external activity'); lines.push(line(`${currency} external activity: ${externalActivityHours} * ${m.retailPrice}`, externalActivityHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId })); }
  if (currency !== 'USD' && pipelineOperations) { const billableUnits = Math.max(0, pipelineOperations / 50000 - 20); const m = one(rows, r => r.productName === 'Azure Synapse Analytics Pipelines' && r.meterName === 'Operations' && r.type === 'Consumption' && r.retailPrice > 0, 'pipeline operations'); lines.push(line(`${currency} pipeline operations: first 1M free, ${billableUnits} billable 50K units * ${m.retailPrice}`, billableUnits * m.retailPrice, { meterId: m.meterId })); }
  if (ssisNodes) {
    const edition = ssisEdition === 'enterprise' ? 'Enterprise' : 'Standard';
    const license = ssisLicense === 'hybrid' ? 'AHB' : 'License Included';
    const pick = selectSsisSize(rows, edition, license, ssisNodeVcpu, ssisNodeMemoryGiB);
    const m = pick.row;
    lines.push(line(`${currency} SSIS ${edition} ${license}: ${ssisNodes} nodes * ${pick.size.name} (${pick.size.vcpu} vCPU/${pick.size.memory} GiB) * ${ssisHours} hours * ${m.retailPrice}`, ssisNodes * ssisHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (synapseLinkVcores) {
    const linkRows = await synapseLinkRows(currency);
    const m = one(linkRows, r => r.armRegionName === 'Global' && r.productName === 'Azure Synapse Link for SQL' && r.skuName === 'Azure Synapse Link for SQL (SQL Database)' && r.meterName === 'vCore' && r.type === 'Consumption', 'Synapse Link for SQL global vCore');
    lines.push(line(`${currency} Synapse Link for SQL: ${synapseLinkVcores} vCores * ${synapseLinkHours} hours * ${m.retailPrice}`, synapseLinkVcores * synapseLinkHours * m.retailPrice, { meterId: m.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}
async function calcSynapse(opts) {
  const data = await product();
  const lines = [];
  const region = opts.region;
  if (opts.dedicatedDwu) {
    const offer = `gen2-${opts.dedicatedDwu}`;
    const unit = COMMIT_UNIT[opts.commitment || 'payg'];
    const p = price(data, offer, region, unit);
    const hours = (opts.commitment || 'payg') === 'payg' ? (opts.dedicatedHours || HOURS_PER_MONTH) : HOURS_PER_MONTH;
    lines.push(line(`Dedicated SQL pool ${opts.dedicatedDwu} DWU ${opts.commitment || 'payg'}: ${hours} billable hours * ${p}`, hours * p, { sourceOffer: offer, sourceUnit: unit }));
  }
  if (opts.dedicatedStorageTB) {
    const p = price(data, 'data-stored-sql-data-warehouse', region, 'pertb');
    lines.push(line(`Dedicated SQL storage: ${opts.dedicatedStorageTB} TB * ${p}`, opts.dedicatedStorageTB * p, { sourceOffer: 'data-stored-sql-data-warehouse' }));
  }
  if (opts.geoBackupTB) {
    const p = price(data, 'disaster-recovery-sql-data-warehouse', region, 'permonth');
    lines.push(line(`Geo-backup storage: ${opts.geoBackupTB} TB * 1024 GB/TB * ${p}`, opts.geoBackupTB * 1024 * p, { sourceOffer: 'disaster-recovery-sql-data-warehouse' }));
  }
  if (opts.serverlessTB) {
    const p = price(data, 'serverless', region, 'pertb');
    lines.push(line(`Serverless SQL: ${opts.serverlessTB} TB processed * ${p}`, opts.serverlessTB * p, { sourceOffer: 'serverless' }));
  }
  if (opts.sparkNodes) {
    const offer = 'spark-memory-optimized';
    const unit = 'perhour';
    const p = price(data, offer, region, unit);
    const vcores = SPARK_VCORES[opts.sparkNodeSize || 'medium'];
    lines.push(line(`Spark memory-optimized ${opts.sparkNodeSize || 'medium'}: ${opts.sparkNodes} nodes * ${vcores} vCores * ${opts.sparkHours || HOURS_PER_MONTH} hours * ${p}`, opts.sparkNodes * vcores * (opts.sparkHours || HOURS_PER_MONTH) * p, { sourceOffer: offer }));
  }
  if (opts.dataFlowVcoreHours && opts.dataFlowType !== 'compute-optimized') {
    const p = price(data, opts.dataFlowType || 'basic', region, 'perhour');
    lines.push(line(`Data flow ${opts.dataFlowType || 'basic'}: ${opts.dataFlowVcoreHours} vCore-hours * ${p}`, opts.dataFlowVcoreHours * p, { sourceOffer: opts.dataFlowType || 'basic' }));
  }
  const rt = RUNTIME[opts.pipelineRuntime || 'azure'];
  if (opts.pipelineRuns) {
    const p = price(data, rt.orchestration, region, 'per1k');
    lines.push(line(`Pipeline orchestration: ${opts.pipelineRuns} runs / 1000 * ${p}`, opts.pipelineRuns / 1000 * p, { sourceOffer: rt.orchestration }));
  }
  if (opts.dataMovementHours) {
    const p = price(data, rt.move, region, 'perhour');
    lines.push(line(`Data movement ${opts.pipelineRuntime || 'azure'}: ${opts.dataMovementHours} DIU-hours * ${p}`, opts.dataMovementHours * p, { sourceOffer: rt.move }));
  }
  if (opts.pipelineActivityHours) {
    const p = price(data, rt.activity, region, 'perhour');
    lines.push(line(`Pipeline activity ${opts.pipelineRuntime || 'azure'}: ${opts.pipelineActivityHours} hours * ${p}`, opts.pipelineActivityHours * p, { sourceOffer: rt.activity }));
  }
  if (opts.externalActivityHours) {
    const p = price(data, rt.external, region, 'perhour');
    lines.push(line(`External activity ${opts.pipelineRuntime || 'azure'}: ${opts.externalActivityHours} hours * ${p}`, opts.externalActivityHours * p, { sourceOffer: rt.external }));
  }
  if (opts.pipelineOperations) {
    const units50k = opts.pipelineOperations / 50000;
    const cost = graduated(data, 'operations-pipelines', region, 'per50k', units50k);
    lines.push(line(`Pipeline operations: ${opts.pipelineOperations} operations = ${units50k} 50K-units; first 20 units (1M ops) free`, cost, { sourceOffer: 'operations-pipelines' }));
  }
  return { monthlyList: totalOf(lines), lines };
}
async function oracle(opts) {
  const c = await calcSynapse(opts);
  const r = await retailSynapse(opts);
  const lines = [...c.lines, ...r.lines];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'synapse',
  source: 'both',
  cases: [
    { name: 'dedicated 1000 DWU payg with storage', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 1000, dedicatedHours: 730, dedicatedStorageTB: 2, geoBackupTB: 1 },
      // Calculator v3 gen2-1000 per-hour plus SQL data stored and SQL disaster-recovery TB-month offers.
      expected: async () => oracle({ region: 'eastus2', dedicatedDwu: 1000, dedicatedHours: 730, dedicatedStorageTB: 2, geoBackupTB: 1 }) },
    { name: 'dedicated 100 DWU one year reserved part-time', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 100, dedicatedHours: 100, commitment: 'ri1y' },
      // Calculator v3 gen2-100 perhouroneyearreserved is a reserved hourly commitment, billed for a full 730-hour month.
      expected: async () => oracle({ region: 'eastus2', dedicatedDwu: 100, dedicatedHours: 100, commitment: 'ri1y' }) },
    { name: 'dedicated 300 DWU three year reserved', region: 'westeurope', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 300, dedicatedHours: 730, commitment: 'ri3y' },
      // Calculator v3 gen2-300 perhourthreeyearreserved is region-specific; monthly = 730 hours times that rate.
      expected: async () => oracle({ region: 'westeurope', dedicatedDwu: 300, dedicatedHours: 730, commitment: 'ri3y' }) },
    { name: 'serverless sql and memory spark', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 0, serverlessTB: 12.5, sparkNodes: 3, sparkNodeSize: 'medium', sparkHours: 40 },
      // Calculator serverless is per TB processed; Spark memory-optimized is per vCore-hour, medium = 8 vCores.
      expected: async () => oracle({ region: 'eastus2', serverlessTB: 12.5, sparkNodes: 3, sparkNodeSize: 'medium', sparkHours: 40 }) },
    { name: 'xxxlarge spark pool', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 0, sparkNodes: 3, sparkNodeSize: 'xxxlarge', sparkHours: 10 },
      // Calculator Spark memory-optimized is per vCore-hour; xxxlarge is 80 vCores and Spark pools have at least 3 nodes.
      expected: async () => oracle({ region: 'eastus2', sparkNodes: 3, sparkNodeSize: 'xxxlarge', sparkHours: 10 }) },
    { name: 'data flow basic and azure pipeline at free ops boundary', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 0, dataFlowVcoreHours: 8, dataFlowType: 'basic', pipelineRuns: 1000, pipelineRuntime: 'azure', dataMovementHours: 4, pipelineActivityHours: 10, externalActivityHours: 10, pipelineOperations: 1000000 },
      // Calculator basic data flow and Azure IR offers; operations-pipelines graduated table charges $0 through 20 x 50K units = 1M ops.
      expected: async () => oracle({ region: 'eastus2', dataFlowVcoreHours: 8, dataFlowType: 'basic', pipelineRuns: 1000, pipelineRuntime: 'azure', dataMovementHours: 4, pipelineActivityHours: 10, externalActivityHours: 10, pipelineOperations: 1000000 }) },
    { name: 'standard data flow and managed vnet above ops free grant', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 0, dataFlowVcoreHours: 16, dataFlowType: 'standard', pipelineRuns: 2000, pipelineRuntime: 'managed-vnet', dataMovementHours: 2, pipelineActivityHours: 3, externalActivityHours: 4, pipelineOperations: 1050000 },
      // Calculator managed-VNET IR offers plus operations-pipelines: 1,050,000 ops = 21 units, so 1 unit is charged at $0.25.
      expected: async () => oracle({ region: 'eastus2', dataFlowVcoreHours: 16, dataFlowType: 'standard', pipelineRuns: 2000, pipelineRuntime: 'managed-vnet', dataMovementHours: 2, pipelineActivityHours: 3, externalActivityHours: 4, pipelineOperations: 1050000 }) },
    { name: 'synapse link for sql', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 0, synapseLinkVcores: 4, synapseLinkHours: 300 },
      // Retail API global Azure Synapse Link for SQL vCore meter is $0.25/vCore-hour; 4 vCores * 300 hours = $300.
      expected: async () => oracle({ region: 'eastus2', synapseLinkVcores: 4, synapseLinkHours: 300 }) },
    { name: 'eur main dimensions', region: 'westeurope', currency: 'EUR', component: { type: 'synapse', dedicatedDwu: 1000, dedicatedHours: 200, dedicatedStorageTB: 1, geoBackupTB: 1, serverlessTB: 3, dataFlowVcoreHours: 100, dataFlowType: 'standard', pipelineRuns: 5000, pipelineRuntime: 'azure', dataMovementHours: 100, pipelineOperations: 2000000 },
      // EUR Retail API rows independently price dedicated SQL, storage, geo-backup, serverless SQL, standard data flow, Azure IR movement and operations after the 1M free grant.
      expected: async () => retailSynapse({ region: 'westeurope', currency: 'EUR', dedicatedDwu: 1000, dedicatedHours: 200, dedicatedStorageTB: 1, geoBackupTB: 1, serverlessTB: 3, dataFlowVcoreHours: 100, dataFlowType: 'standard', pipelineRuns: 5000, pipelineRuntime: 'azure', dataMovementHours: 100, pipelineOperations: 2000000 }) },
    { name: 'ssis standard included 4 vcpu 8 gib selects d4 v3', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 0, ssisNodes: 1, ssisNodeVcpu: 4, ssisNodeMemoryGiB: 8, ssisEdition: 'standard', ssisLicense: 'included', ssisHours: 100 },
      // Retail API Synapse SSIS node size is selected from the Learn-listed Azure-SSIS IR sizes by vCPU/memory, then billed per node-hour.
      expected: async () => oracle({ region: 'eastus2', ssisNodes: 1, ssisNodeVcpu: 4, ssisNodeMemoryGiB: 8, ssisEdition: 'standard', ssisLicense: 'included', ssisHours: 100 }) },
    { name: 'ssis standard 40 vcpu 64 gib selects d64 v3', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 0, ssisNodes: 1, ssisNodeVcpu: 40, ssisNodeMemoryGiB: 64, ssisEdition: 'standard', ssisLicense: 'included', ssisHours: 10 },
      // Learn-listed Azure-SSIS IR sizes have no 40-vCPU node; cheapest Dv3/Ev3 node fitting 40 vCPU and 64 GiB is D64 v3.
      expected: async () => oracle({ region: 'eastus2', ssisNodes: 1, ssisNodeVcpu: 40, ssisNodeMemoryGiB: 64, ssisEdition: 'standard', ssisLicense: 'included', ssisHours: 10 }) },
    { name: 'ssis 80 vcpu refused', region: 'eastus2', currency: 'USD', component: { type: 'synapse', dedicatedDwu: 0, ssisNodes: 1, ssisNodeVcpu: 80, ssisNodeMemoryGiB: 128, ssisEdition: 'standard', ssisLicense: 'included', ssisHours: 10 },
      // The Learn Azure-SSIS IR list tops out at 64 vCPU after E80ids v4 removal.
      expectEngineError: /64|vCPU|SSIS/i },
    { name: 'eur ssis enterprise hybrid', region: 'westeurope', currency: 'EUR', component: { type: 'synapse', dedicatedDwu: 0, ssisNodes: 2, ssisNodeVcpu: 4, ssisNodeMemoryGiB: 16, ssisEdition: 'enterprise', ssisLicense: 'hybrid', ssisHours: 50 },
      // EUR Retail API SSIS Enterprise AHB hourly meter for the cheapest Learn-listed size fitting 4 vCPU/16 GiB times two nodes and 50 hours.
      expected: async () => retailSynapse({ region: 'westeurope', currency: 'EUR', ssisNodes: 2, ssisNodeVcpu: 4, ssisNodeMemoryGiB: 16, ssisEdition: 'enterprise', ssisLicense: 'hybrid', ssisHours: 50 }) },
  ],
};
