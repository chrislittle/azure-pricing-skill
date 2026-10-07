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

async function cloudHsm({ region, clusters = 1, hours = HOURS_PER_MONTH, currency = 'USD' }) {
  const rows = dedupe(await query(`serviceName eq 'Azure Cloud HSM' and armRegionName eq '${region}' and productName eq 'Microsoft Azure Cloud HSM' and skuName eq 'Standard_B1'`, currency));
  const row = pickOne(rows, r => r.meterName === 'Standard_B1 vCore' && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption', `Cloud HSM Standard_B1 in ${region}`);
  const billableHours = clusters * hours;
  const lines = [
    line(`Cloud HSM Standard_B1 clusters: ${clusters} * ${hours} hours * ${row.retailPrice}`, (billableHours / unitSize(row.unitOfMeasure)) * row.retailPrice, { meterId: row.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'cloud-hsm',
  source: 'retail-api',
  cases: [
    {
      name: 'one always-on cluster',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'cloud-hsm', clusters: 1 },
      // Retail API Azure Cloud HSM Standard_B1 vCore meter is hourly; one all-month cluster is 730 hours.
      expected: async () => cloudHsm({ region: 'eastus2', clusters: 1 }),
    },
    {
      name: 'two always-on clusters',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'cloud-hsm', clusters: 2 },
      // Retail API hourly meter multiplied by two clusters and the 730-hour oracle month.
      expected: async () => cloudHsm({ region: 'eastus2', clusters: 2 }),
    },
    {
      name: 'part-time cluster hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'cloud-hsm', clusters: 1, hours: 100 },
      // Retail API hourly meter multiplied by the component's part-time 100 hours.
      expected: async () => cloudHsm({ region: 'eastus2', clusters: 1, hours: 100 }),
    },
    {
      name: 'zero hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'cloud-hsm', clusters: 1, hours: 0 },
      // Retail API hourly meter multiplied by the component's zero provisioned hours; no minimum monthly charge beyond hours used.
      expected: async () => cloudHsm({ region: 'eastus2', clusters: 1, hours: 0 }),
    },
    {
      name: 'multiple clusters part-time',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'cloud-hsm', clusters: 3, hours: 24 },
      // Retail API hourly meter multiplied by three clusters for one day: 3 * 24 billable hours.
      expected: async () => cloudHsm({ region: 'eastus2', clusters: 3, hours: 24 }),
    },
    {
      name: 'non-US region uses published regional meter',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'cloud-hsm', clusters: 1 },
      // Retail API West Europe Standard_B1 row is the source; Learn says a Cloud HSM cluster consists of three HSM nodes, billed as the cluster meter.
      expected: async () => cloudHsm({ region: 'westeurope', clusters: 1 }),
    },
    {
      name: 'EUR one always-on cluster',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'cloud-hsm', clusters: 1 },
      // EUR Retail API Standard_B1 vCore hourly row multiplied by 730 hours for one cluster.
      expected: async () => cloudHsm({ region: 'westeurope', clusters: 1, currency: 'EUR' }),
    },
    {
      name: 'US Gov region hourly premium',
      region: 'usgovvirginia',
      currency: 'USD',
      component: { type: 'cloud-hsm', clusters: 1 },
      // Retail API US Gov Virginia Standard_B1 vCore row is $6.00/hour; one all-month cluster is 730 billable hours.
      expected: async () => cloudHsm({ region: 'usgovvirginia', clusters: 1 }),
    },
  ],
};
