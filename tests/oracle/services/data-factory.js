'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'data-factory';
const HOURS_PER_MONTH = 730;

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calcOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }

const IR = {
  azure: { orchestration: 'orchestration-cloud-v2', movement: 'datamovement-cloud-v2', pipeline: 'pipelineactivity-cloud-v2', external: 'pipelineactivity-external-cloud-v2' },
  'self-hosted': { orchestration: 'orchestration-self-hosted', movement: 'datamovement-self-hosted', pipeline: 'pipelineactivity-self-hosted-v2', external: 'pipelineactivity-external-self-hosted-v2' },
  'managed-vnet': { orchestration: 'orchestration-vnet-v2', movement: 'datamovement-vnet-v2', pipeline: 'pipelineactivity-vnet-v2', external: 'pipelineactivity-external-vnet-v2' },
};

const DATA_FLOW = {
  'general-purpose': 'data-flow-general-purpose-vcore-v2',
  'memory-optimized': 'data-flow-memory-optimized-vcore-v2',
};

function dataFlowOffer(type, commitment) {
  const base = DATA_FLOW[type];
  if (!base) throw new Error(`unsupported data flow type ${type}; public spec exposes general-purpose and memory-optimized`);
  if (commitment === '1-year') return `${base}-one-year`;
  if (commitment === '3-year') return `${base}-three-year`;
  return base;
}

async function retailDataFlowReservationCost({ region, dataFlowType, dataFlowCommitment, dataFlowVcores }) {
  const product = dataFlowType === 'memory-optimized' ? 'Azure Data Factory v2 Data Flow - Memory Optimized' : 'Azure Data Factory v2 Data Flow - General Purpose';
  const term = dataFlowCommitment === '1-year' ? '1 Year' : '3 Years';
  const months = dataFlowCommitment === '1-year' ? 12 : 36;
  const rows = dedupe(await query(`serviceName eq 'Azure Data Factory v2' and armRegionName eq '${region}'`, 'USD'));
  const matches = rows.filter(r => r.productName === product && r.type === 'Reservation' && r.reservationTerm === term);
  if (matches.length !== 1) throw new Error(`expected one reservation row for ${product} ${term} in ${region}, found ${matches.length}`);
  return { monthlyList: dataFlowVcores * matches[0].retailPrice / months, meterId: matches[0].meterId, retailPrice: matches[0].retailPrice, term, months };
}

async function calculatorDataFactory({ region, activityRuns = 0, integrationRuntime = 'azure', dataMovementDiuHours = 0, pipelineActivityHours = 0, externalActivityHours = 0, readWriteOperations = 0, monitoringOperations = 0, inactivePipelines = 0, dataFlowVcores = 0, dataFlowHours = 0, cdcHours = 0, dataFlowType = 'general-purpose', dataFlowCommitment = 'payg', ssisNodes = 0, ssisSize = 'd4v3', ssisEdition = 'standard', ssisLicense = 'license-included', airflowSize = 'small', airflowEnvironments = 0, hours = HOURS_PER_MONTH }) {
  const lines = [];
  const ir = IR[integrationRuntime];
  if (activityRuns) {
    const p = await calcOffer(ir.orchestration, region);
    lines.push(line(`${integrationRuntime} orchestration activity runs: ${activityRuns} / 1K * ${p}`, (activityRuns / 1000) * p, { sourceOffer: ir.orchestration }));
  }
  if (dataMovementDiuHours) {
    const p = await calcOffer(ir.movement, region);
    lines.push(line(`${integrationRuntime} data movement: ${dataMovementDiuHours} DIU-hours * ${p}`, dataMovementDiuHours * p, { sourceOffer: ir.movement }));
  }
  if (pipelineActivityHours) {
    const p = await calcOffer(ir.pipeline, region);
    lines.push(line(`${integrationRuntime} pipeline activity: ${pipelineActivityHours} hours * ${p}`, pipelineActivityHours * p, { sourceOffer: ir.pipeline }));
  }
  if (externalActivityHours) {
    const p = await calcOffer(ir.external, region);
    lines.push(line(`${integrationRuntime} external pipeline activity: ${externalActivityHours} hours * ${p}`, externalActivityHours * p, { sourceOffer: ir.external }));
  }
  if (readWriteOperations) {
    const p = await calcOffer('readwrite-operations-v2', region);
    lines.push(line(`Read/write operations: ${readWriteOperations} / 50K * ${p}`, (readWriteOperations / 50000) * p, { sourceOffer: 'readwrite-operations-v2' }));
  }
  if (monitoringOperations) {
    const p = await calcOffer('monitoring-operations-v2', region);
    lines.push(line(`Monitoring operations: ${monitoringOperations} / 50K * ${p}`, (monitoringOperations / 50000) * p, { sourceOffer: 'monitoring-operations-v2' }));
  }
  if (inactivePipelines) {
    const p = await calcOffer('inactive-v2', region);
    lines.push(line(`Inactive pipelines: ${inactivePipelines} pipeline-months * ${p}`, inactivePipelines * p, { sourceOffer: 'inactive-v2' }));
  }
  if (dataFlowVcores) {
    const offer = dataFlowOffer(dataFlowType, dataFlowCommitment);
    if (offer) {
      if (dataFlowCommitment === 'payg') {
        const p = await calcOffer(offer, region);
        lines.push(line(`${dataFlowType} data flow payg: ${dataFlowVcores} vCores * ${dataFlowHours} hours * ${p}`, dataFlowVcores * dataFlowHours * p, { sourceOffer: offer }));
      } else {
        const r = await retailDataFlowReservationCost({ region, dataFlowType, dataFlowCommitment, dataFlowVcores });
        lines.push(line(`${dataFlowType} data flow ${dataFlowCommitment} reservation: ${dataFlowVcores} vCores * ${r.retailPrice} / ${r.months} months`, r.monthlyList, { meterId: r.meterId }));
      }
    }
  }
  if (cdcHours) {
    const p = await calcOffer('data-flow-general-purpose-vcore-v2', region);
    lines.push(line(`CDC data flow: 4 vCores * ${cdcHours} hours * ${p}`, 4 * cdcHours * p, { sourceOffer: 'data-flow-general-purpose-vcore-v2' }));
  }
  if (ssisNodes) {
    const suffix = ssisLicense === 'ahb' ? '-ahb' : '';
    const offer = `${ssisEdition}-ssis-${ssisSize}${suffix}`;
    const p = await calcOffer(offer, region);
    lines.push(line(`SSIS ${ssisEdition} ${ssisSize} ${ssisLicense}: ${ssisNodes} nodes * ${hours} hours * ${p}`, ssisNodes * hours * p, { sourceOffer: offer }));
  }
  if (airflowEnvironments) {
    const offer = `managed-airflow-${airflowSize}-v2`;
    const p = await calcOffer(offer, region);
    lines.push(line(`Managed Airflow ${airflowSize}: ${airflowEnvironments} environments * ${hours} hours * ${p}`, airflowEnvironments * hours * p, { sourceOffer: offer }));
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailDataFactory({ region, currency = 'EUR', activityRuns = 0, integrationRuntime = 'azure', dataMovementDiuHours = 0, readWriteOperations = 0, monitoringOperations = 0 }) {
  const rows = dedupe(await query(`serviceName eq 'Azure Data Factory v2' and armRegionName eq '${region}'`, currency));
  const sku = integrationRuntime === 'azure' ? 'Cloud' : integrationRuntime === 'self-hosted' ? 'Self Hosted' : 'Azure Managed VNET';
  const lines = [];
  if (activityRuns) {
    const m = rows.find(r => r.skuName === sku && r.meterName.includes('Orchestration Activity Run'));
    lines.push(line(`EUR ${sku} orchestration: ${activityRuns} / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (activityRuns / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (dataMovementDiuHours) {
    const m = rows.find(r => r.skuName === sku && r.meterName.includes('Data Movement'));
    lines.push(line(`EUR ${sku} data movement: ${dataMovementDiuHours} * ${m.retailPrice}`, dataMovementDiuHours * m.retailPrice, { meterId: m.meterId }));
  }
  if (readWriteOperations) {
    const m = rows.find(r => r.skuName === 'Cloud' && r.meterName === 'Cloud Read Write Operations');
    lines.push(line(`EUR read/write operations: ${readWriteOperations} / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (readWriteOperations / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (monitoringOperations) {
    const m = rows.find(r => r.skuName === sku && r.meterName.includes('Monitoring Operations'));
    lines.push(line(`EUR monitoring operations: ${monitoringOperations} / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (monitoringOperations / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'data-factory',
  source: 'both',
  cases: [
    {
      name: 'azure ir orchestration movement and operations',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 2000, integrationRuntime: 'azure', dataMovementDiuHours: 100, pipelineActivityHours: 10, externalActivityHours: 10, readWriteOperations: 100000, monitoringOperations: 100000, inactivePipelines: 2 },
      // Calculator Azure IR v2 offers bill orchestration per 1K runs, data movement per DIU-hour, activity hours, operations per 50K, and inactive pipelines monthly.
      expected: async () => calculatorDataFactory({ region: 'eastus2', activityRuns: 2000, integrationRuntime: 'azure', dataMovementDiuHours: 100, pipelineActivityHours: 10, externalActivityHours: 10, readWriteOperations: 100000, monitoringOperations: 100000, inactivePipelines: 2 }),
    },
    {
      name: 'self-hosted ir activity and movement',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 2000, integrationRuntime: 'self-hosted', dataMovementDiuHours: 100, pipelineActivityHours: 10, externalActivityHours: 10 },
      // Calculator self-hosted IR uses separate orchestration, data-movement, pipeline, and external activity offers from Azure IR.
      expected: async () => calculatorDataFactory({ region: 'eastus2', activityRuns: 2000, integrationRuntime: 'self-hosted', dataMovementDiuHours: 100, pipelineActivityHours: 10, externalActivityHours: 10 }),
    },
    {
      name: 'managed vnet ir activity and movement',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 2000, integrationRuntime: 'managed-vnet', dataMovementDiuHours: 100, pipelineActivityHours: 10, externalActivityHours: 10 },
      // Calculator managed VNET IR uses managed-vnet orchestration, data movement, pipeline, and external activity offers.
      expected: async () => calculatorDataFactory({ region: 'eastus2', activityRuns: 2000, integrationRuntime: 'managed-vnet', dataMovementDiuHours: 100, pipelineActivityHours: 10, externalActivityHours: 10 }),
    },
    {
      name: 'general purpose data flow pay as you go',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'general-purpose', dataFlowCommitment: 'payg' },
      // Calculator general-purpose data flow pay-as-you-go bills only actual vCore-hours used.
      expected: async () => calculatorDataFactory({ region: 'eastus2', dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'general-purpose', dataFlowCommitment: 'payg' }),
    },
    {
      name: 'general purpose one year reservation bills full month',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'general-purpose', dataFlowCommitment: '1-year' },
      // Retail API 1-year reservation row is the annual per-vCore price; monthly oracle is vCores * reservationPrice / 12, not runtime hours.
      expected: async () => calculatorDataFactory({ region: 'eastus2', dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'general-purpose', dataFlowCommitment: '1-year' }),
    },
    {
      name: 'general purpose three year reservation bills full month',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'general-purpose', dataFlowCommitment: '3-year' },
      // Retail API 3-year reservation row is the three-year per-vCore price; monthly oracle is vCores * reservationPrice / 36, not runtime hours.
      expected: async () => calculatorDataFactory({ region: 'eastus2', dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'general-purpose', dataFlowCommitment: '3-year' }),
    },
    {
      name: 'memory optimized one year reservation bills full month',
      region: 'westcentralus', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, dataFlowVcores: 16, dataFlowHours: 10, dataFlowType: 'memory-optimized', dataFlowCommitment: '1-year' },
      // Memory-optimized reservations exist in limited regions; Retail API West Central US 1-year row is $2,188 per vCore-year, so 16 * 2188 / 12 = $2,917.33.
      expected: async () => calculatorDataFactory({ region: 'westcentralus', dataFlowVcores: 16, dataFlowHours: 10, dataFlowType: 'memory-optimized', dataFlowCommitment: '1-year' }),
    },
    {
      name: 'memory optimized data flow in supported region',
      region: 'westcentralus', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'memory-optimized', dataFlowCommitment: 'payg' },
      // Calculator memory-optimized data flow offers are published only for a subset of regions; West Central US has the pay-as-you-go vCore-hour price.
      expected: async () => calculatorDataFactory({ region: 'westcentralus', dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'memory-optimized', dataFlowCommitment: 'payg' }),
    },
    {
      name: 'general purpose data flow maximum vcore enum with cdc',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, dataFlowVcores: 272, dataFlowHours: 1, dataFlowType: 'general-purpose', dataFlowCommitment: 'payg', cdcHours: 2 },
      // Public questions allow dataFlowVcores values up to 272; CDC uses a 4-vCore general-purpose data-flow cluster per hour.
      expected: async () => calculatorDataFactory({ region: 'eastus2', dataFlowVcores: 272, dataFlowHours: 1, dataFlowType: 'general-purpose', dataFlowCommitment: 'payg', cdcHours: 2 }),
    },
    {
      name: 'ssis standard license included and airflow small',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, ssisNodes: 2, ssisSize: 'd4v3', ssisEdition: 'standard', ssisLicense: 'license-included', airflowSize: 'small', airflowEnvironments: 1, hours: 365 },
      // Calculator SSIS standard d4v3 license-included offer and Managed Airflow small offer bill per node/environment-hour.
      expected: async () => calculatorDataFactory({ region: 'eastus2', ssisNodes: 2, ssisSize: 'd4v3', ssisEdition: 'standard', ssisLicense: 'license-included', airflowSize: 'small', airflowEnvironments: 1, hours: 365 }),
    },
    {
      name: 'ssis enterprise ahb and airflow large',
      region: 'eastus2', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, ssisNodes: 1, ssisSize: 'e8v3', ssisEdition: 'enterprise', ssisLicense: 'ahb', airflowSize: 'large', airflowEnvironments: 1, hours: 730 },
      // Calculator SSIS enterprise e8v3 AHB offer removes included SQL licensing; Managed Airflow large bills hourly.
      expected: async () => calculatorDataFactory({ region: 'eastus2', ssisNodes: 1, ssisSize: 'e8v3', ssisEdition: 'enterprise', ssisLicense: 'ahb', airflowSize: 'large', airflowEnvironments: 1, hours: 730 }),
    },
    {
      name: 'non-US west europe regional data flow and airflow',
      region: 'westeurope', currency: 'USD',
      component: { type: 'data-factory', activityRuns: 0, dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'general-purpose', dataFlowCommitment: 'payg', airflowSize: 'large', airflowEnvironments: 1, hours: 730 },
      // Calculator West Europe general-purpose data flow and Airflow prices differ from East US 2.
      expected: async () => calculatorDataFactory({ region: 'westeurope', dataFlowVcores: 8, dataFlowHours: 10, dataFlowType: 'general-purpose', dataFlowCommitment: 'payg', airflowSize: 'large', airflowEnvironments: 1, hours: 730 }),
    },
    {
      name: 'EUR retail API azure ir operations',
      region: 'westeurope', currency: 'EUR',
      component: { type: 'data-factory', activityRuns: 2000, integrationRuntime: 'azure', dataMovementDiuHours: 100, readWriteOperations: 100000, monitoringOperations: 100000 },
      // Retail API EUR Azure Data Factory v2 rows expose Cloud orchestration, data movement, read/write, and monitoring meters.
      expected: async () => retailDataFactory({ region: 'westeurope', currency: 'EUR', activityRuns: 2000, integrationRuntime: 'azure', dataMovementDiuHours: 100, readWriteOperations: 100000, monitoringOperations: 100000 }),
    },
  ],
};
