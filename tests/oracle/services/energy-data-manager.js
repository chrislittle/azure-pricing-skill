'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS_PER_MONTH = 730;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function energyDataManager({ region, currency = 'USD', tier, instances = 1, hours = HOURS_PER_MONTH, additionalPartitions = 0, analyticsHours = 0 }) {
  const rows = dedupe(await query(`serviceName eq 'Energy Data Manager' and productName eq 'Azure Data Manager for Energy' and armRegionName eq '${region}'`, currency));
  const label = tier === 'developer' ? 'Developer' : 'Standard';
  const instance = pickOne(rows, r => r.skuName === label && r.meterName === `${label} Instance` && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption', `${label} Instance`);
  const partition = pickOne(rows, r => r.skuName === label && r.meterName === `${label} Additional Data Partition` && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption', `${label} Additional Data Partition`);
  const lines = [
    line(`${label} instance: ${instances} instance(s) * ${hours} hours * ${instance.retailPrice}`, (instances * hours / unitSize(instance.unitOfMeasure)) * instance.retailPrice, { meterId: instance.meterId }),
  ];
  if (additionalPartitions) {
    lines.push(line(`${label} additional partitions: ${instances} instance(s) * ${additionalPartitions} * ${hours} hours * ${partition.retailPrice}`, (instances * additionalPartitions * hours / unitSize(partition.unitOfMeasure)) * partition.retailPrice, { meterId: partition.meterId }));
  }
  if (analyticsHours) {
    const analyticsRows = rows.filter(r => r.skuName === label && r.meterName === `${label} Analytics Capacity` && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption');
    if (analyticsRows.length) {
      const analytics = analyticsRows[0];
      lines.push(line(`${label} analytics capacity: ${instances} instance(s) * ${analyticsHours} hours * ${analytics.retailPrice}`, (instances * analyticsHours / unitSize(analytics.unitOfMeasure)) * analytics.retailPrice, { meterId: analytics.meterId }));
    } else {
      lines.push(line(`${label} analytics capacity unavailable in ${region}: ${analyticsHours} requested hours`, 0, { unavailable: true }));
    }
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'energy-data-manager',
  source: 'retail-api',
  cases: [
    {
      name: 'developer east us one month',
      region: 'eastus',
      currency: 'USD',
      component: { type: 'energy-data-manager', tier: 'developer', hours: 730, additionalPartitions: 0, analyticsHours: 0 },
      // Retail API Developer Instance hourly meter in East US; East US 2 is not sold for this service.
      expected: async () => energyDataManager({ region: 'eastus', tier: 'developer', hours: 730 }),
    },
    {
      name: 'developer zero hours',
      region: 'eastus',
      currency: 'USD',
      component: { type: 'energy-data-manager', tier: 'developer', instances: 1, hours: 0, additionalPartitions: 2, analyticsHours: 0 },
      // Retail API meters are hourly; zero provisioned hours yields zero instance and partition cost even when additional partitions are configured.
      expected: async () => energyDataManager({ region: 'eastus', tier: 'developer', instances: 1, hours: 0, additionalPartitions: 2, analyticsHours: 0 }),
    },
    {
      name: 'standard east us with one extra partition',
      region: 'eastus',
      currency: 'USD',
      component: { type: 'energy-data-manager', tier: 'standard', instances: 2, hours: 730, additionalPartitions: 1, analyticsHours: 0 },
      // Retail API Standard Instance plus Standard Additional Data Partition, both hourly for the whole month.
      expected: async () => energyDataManager({ region: 'eastus', tier: 'standard', instances: 2, hours: 730, additionalPartitions: 1 }),
    },
    {
      name: 'developer part-time with analytics',
      region: 'eastus',
      currency: 'USD',
      component: { type: 'energy-data-manager', tier: 'developer', hours: 100, additionalPartitions: 2, analyticsHours: 50 },
      // Retail API hourly meters: instance and partitions use component hours; analytics uses analyticsHours.
      expected: async () => energyDataManager({ region: 'eastus', tier: 'developer', hours: 100, additionalPartitions: 2, analyticsHours: 50 }),
    },
    {
      name: 'westus2 without analytics because analytics is unavailable',
      region: 'westus2',
      currency: 'USD',
      component: { type: 'energy-data-manager', tier: 'developer', instances: 1, hours: 100, additionalPartitions: 1, analyticsHours: 0 },
      // Retail API West US 2 publishes Developer Instance and Additional Data Partition rows but no Analytics Capacity row; omit analytics in this sold region.
      expected: async () => energyDataManager({ region: 'westus2', tier: 'developer', instances: 1, hours: 100, additionalPartitions: 1, analyticsHours: 0 }),
    },
    {
      name: 'standard maximum additional partitions',
      region: 'eastus',
      currency: 'USD',
      component: { type: 'energy-data-manager', tier: 'standard', hours: 24, additionalPartitions: 9, analyticsHours: 24 },
      // Standard includes one partition; nine additional partitions reaches the 10-partition total, each billed hourly alongside analytics capacity.
      expected: async () => energyDataManager({ region: 'eastus', tier: 'standard', hours: 24, additionalPartitions: 9, analyticsHours: 24 }),
    },
    {
      name: 'west europe regional standard prices',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'energy-data-manager', tier: 'standard', hours: 730, additionalPartitions: 2, analyticsHours: 100 },
      // Retail API West Europe rows have region-specific Standard Instance and partition prices; analytics capacity remains an hourly meter.
      expected: async () => energyDataManager({ region: 'westeurope', tier: 'standard', hours: 730, additionalPartitions: 2, analyticsHours: 100 }),
    },
    {
      name: 'eur developer west europe',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'energy-data-manager', tier: 'developer', hours: 100, additionalPartitions: 1, analyticsHours: 25 },
      // EUR Retail API Developer Instance, Additional Data Partition, and Analytics Capacity rows are queried natively in a sold region.
      expected: async () => energyDataManager({ region: 'westeurope', currency: 'EUR', tier: 'developer', hours: 100, additionalPartitions: 1, analyticsHours: 25 }),
    },
  ],
};
