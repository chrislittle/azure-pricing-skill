'use strict';

const { query, dedupe, round2 } = require('../api');

const DAYS_PER_BILLING_MONTH = 31;

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

function priceScope(region) {
  return String(region || '').toLowerCase().startsWith('usgov') ? 'US Gov' : 'Global';
}

async function updateManager({ region = 'eastus2', arcServers = 0, benefitServers = 0, azureVMs = 0, days = DAYS_PER_BILLING_MONTH, currency = 'USD' }) {
  const rows = dedupe(await query(`serviceName eq 'Azure Update Manager' and armRegionName eq '${priceScope(region)}'`, currency));
  const basic = pickOne(rows, r => r.skuName === 'Basic' && r.meterName === 'Basic Server', 'basic server');
  const charged = Math.max(0, arcServers - benefitServers);
  const lines = [];
  if (charged) {
    lines.push(line(`Arc servers without included benefit: ${charged} * ${days}/${DAYS_PER_BILLING_MONTH} month * ${basic.retailPrice}`, charged * (days / DAYS_PER_BILLING_MONTH) * basic.retailPrice, { meterId: basic.meterId }));
  }
  if (benefitServers) lines.push(line(`Arc servers with included benefit: ${benefitServers} free`, 0));
  if (azureVMs) lines.push(line(`Azure VMs managed by Update Manager: ${azureVMs} free`, 0));
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'update-manager',
  source: 'retail-api',
  cases: [
    {
      name: 'one Arc server full month',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'update-manager', arcServers: 1 },
      // Retail API Azure Update Manager Basic Server is a Global server-month meter; full month is 31/31 days.
      expected: async () => updateManager({ region: 'eastus2', arcServers: 1 }),
    },
    {
      name: 'benefit servers are free',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'update-manager', arcServers: 10, benefitServers: 10 },
      // Servers covered by Defender for Servers P2, ESU, Software Assurance, or WS PAYG through Arc use the zero-cost benefit path.
      expected: async () => updateManager({ region: 'eastus2', arcServers: 10, benefitServers: 10 }),
    },
    {
      name: 'mixed charged and benefit servers',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'update-manager', arcServers: 10, benefitServers: 4, azureVMs: 5 },
      // Charge only Arc servers without an included benefit; Azure VMs are free.
      expected: async () => updateManager({ region: 'eastus2', arcServers: 10, benefitServers: 4, azureVMs: 5 }),
    },
    {
      name: 'partial month days',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'update-manager', arcServers: 3, days: 10 },
      // Component bills per day out of 31: three charged servers * 10/31 of the Basic Server month.
      expected: async () => updateManager({ region: 'eastus2', arcServers: 3, days: 10 }),
    },
    {
      name: 'non-US region uses global meter',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'update-manager', arcServers: 2, benefitServers: 1 },
      // Azure Update Manager Retail API price is Global, so West Europe uses the same Basic Server row.
      expected: async () => updateManager({ region: 'westeurope', arcServers: 2, benefitServers: 1 }),
    },
    {
      name: 'US Gov basic Arc servers',
      region: 'usgovvirginia',
      currency: 'USD',
      component: { type: 'update-manager', arcServers: 3, benefitServers: 1, days: 31 },
      // Retail API has a separate Azure Update Manager US Gov Basic Server meter; charge only Arc servers without benefits.
      expected: async () => updateManager({ region: 'usgovvirginia', arcServers: 3, benefitServers: 1, days: 31 }),
    },
    {
      name: 'EUR basic Arc servers',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'update-manager', arcServers: 4, benefitServers: 1, days: 15 },
      // EUR Retail API Global Basic Server meter prorated by days for charged Arc servers only.
      expected: async () => updateManager({ region: 'westeurope', arcServers: 4, benefitServers: 1, days: 15, currency: 'EUR' }),
    },
  ],
};
