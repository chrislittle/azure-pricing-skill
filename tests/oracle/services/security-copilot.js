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

async function securityCopilot({ region = 'westeurope', currency = 'USD', provisionedScus = 0, hours = HOURS_PER_MONTH, overageScuHours = 0, payAsYouGoScus = 0, m365E5Licenses = 0 }) {
  const rows = dedupe(await query(`serviceName eq 'Microsoft Security Copilot' and productName eq 'Microsoft Security Copilot'`, currency));
  const lines = [];
  const capacityRegion = rows.some(r => r.armRegionName === region && r.skuName === 'Provisioned') ? region : 'eastus';
  if (provisionedScus) {
    const meter = pickOne(rows, r => r.armRegionName === capacityRegion && r.skuName === 'Provisioned' && r.meterName === 'Provisioned Security Compute Unit' && r.unitOfMeasure === '1/Hour' && r.type === 'Consumption', `provisioned SCU in ${capacityRegion}`);
    lines.push(line(`provisioned SCUs: ${provisionedScus} * ${hours} hours * ${meter.retailPrice}`, (provisionedScus * hours / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId }));
  }
  if (overageScuHours) {
    const meter = pickOne(rows, r => r.armRegionName === capacityRegion && r.skuName === 'Overage' && r.meterName === 'Overage Security Compute Unit' && r.unitOfMeasure === '1/Hour' && r.type === 'Consumption', `overage SCU in ${capacityRegion}`);
    lines.push(line(`overage SCU-hours: ${overageScuHours} * ${meter.retailPrice}`, (overageScuHours / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId }));
  }
  if (payAsYouGoScus) {
    const allowanceScus = Math.min(10000, (m365E5Licenses / 1000) * 400);
    const billableScus = Math.max(0, payAsYouGoScus - allowanceScus);
    const meter = pickOne(rows, r => r.armRegionName === region && r.skuName === 'Pay As You Go' && r.meterName === 'Pay As You Go Security Compute Unit' && r.unitOfMeasure === '1' && r.type === 'Consumption', `pay-as-you-go SCU in ${region}`);
    lines.push(line(`pay-as-you-go SCUs after E5/E7 allowance: max(0, ${payAsYouGoScus} - ${allowanceScus}) * ${meter.retailPrice}`, (billableScus / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'security-copilot',
  source: 'retail-api',
  cases: [
    {
      name: 'one provisioned scu full month', region: 'westeurope', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 1 },
      // Learn says provisioned SCUs are billed by whole clock-hour blocks; Retail API Provisioned SCU meter is per SCU-hour.
      expected: async () => securityCopilot({ provisionedScus: 1 }),
    },
    {
      name: 'three provisioned scus part-time', region: 'westeurope', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 3, hours: 100 },
      // Provisioned capacity uses SCU-hours: 3 SCUs times 100 billable hours times the provisioned SCU-hour price.
      expected: async () => securityCopilot({ provisionedScus: 3, hours: 100 }),
    },
    {
      name: 'provisioned with overage', region: 'westeurope', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 2, hours: 730, overageScuHours: 12.5 },
      // Learn says overage units are billed on-demand to one decimal; Retail API Overage SCU meter is per SCU-hour.
      expected: async () => securityCopilot({ provisionedScus: 2, hours: 730, overageScuHours: 12.5 }),
    },
    {
      name: 'pay as you go east us 2', region: 'eastus2', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 0, payAsYouGoScus: 50 },
      // Pay-as-you-go component field is total SCUs consumed; Retail API Pay As You Go meter unit is one SCU, not SCU-hour.
      expected: async () => securityCopilot({ region: 'eastus2', provisionedScus: 0, payAsYouGoScus: 50 }),
    },
    {
      name: 'pay as you go west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 0, payAsYouGoScus: 10 },
      // Pay-as-you-go SCUs use the Retail API Pay As You Go Security Compute Unit meter without provisioned capacity.
      expected: async () => securityCopilot({ provisionedScus: 0, payAsYouGoScus: 10 }),
    },
    {
      name: 'm365 e5 allowance below included scus', region: 'eastus2', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 0, m365E5Licenses: 1000, payAsYouGoScus: 399 },
      // Learn says E5/E7 inclusion provides 400 SCUs per 1,000 paid licenses monthly, capped at 10,000; 399 SCUs is below the allowance so billable PAYG is zero.
      expected: async () => securityCopilot({ region: 'eastus2', provisionedScus: 0, m365E5Licenses: 1000, payAsYouGoScus: 399 }),
    },
    {
      name: 'm365 e5 allowance overage example', region: 'eastus2', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 0, m365E5Licenses: 4000, payAsYouGoScus: 2000 },
      // Learn example gives 4,000 licenses = 1,600 included SCUs; 2,000 consumed leaves 400 billable SCUs at the $6 PAYG meter = $2,400.
      expected: async () => securityCopilot({ region: 'eastus2', provisionedScus: 0, m365E5Licenses: 4000, payAsYouGoScus: 2000 }),
    },
    {
      name: 'm365 e5 allowance capped at ten thousand scus', region: 'eastus2', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 0, m365E5Licenses: 30000, payAsYouGoScus: 10001 },
      // E5/E7 inclusion is capped at 10,000 SCUs each month, so 30,000 licenses still leave one billable SCU when usage is 10,001.
      expected: async () => securityCopilot({ region: 'eastus2', provisionedScus: 0, m365E5Licenses: 30000, payAsYouGoScus: 10001 }),
    },
    {
      name: 'non-capacity region falls back to east us provisioned meter', region: 'centralus', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 1, hours: 100 },
      // Security Copilot provisioned capacity meters are published in capacity regions; for Central US the oracle uses the East US provisioned SCU-hour meter.
      expected: async () => securityCopilot({ region: 'centralus', provisionedScus: 1, hours: 100 }),
    },
    {
      name: 'provisioned scu maximum month hours', region: 'westeurope', currency: 'USD',
      component: { type: 'security-copilot', provisionedScus: 1, hours: 744 },
      // The public spec allows up to 744 whole clock-hours in a month; provisioned SCUs bill per SCU-hour.
      expected: async () => securityCopilot({ provisionedScus: 1, hours: 744 }),
    },
    {
      name: 'pay as you go eur east us 2', region: 'eastus2', currency: 'EUR',
      component: { type: 'security-copilot', provisionedScus: 0, payAsYouGoScus: 50 },
      // EUR Retail API Pay As You Go Security Compute Unit meter multiplied by total billable SCUs consumed.
      expected: async () => securityCopilot({ region: 'eastus2', currency: 'EUR', provisionedScus: 0, payAsYouGoScus: 50 }),
    },
    {
      name: 'eur provisioned and overage', region: 'westeurope', currency: 'EUR',
      component: { type: 'security-copilot', provisionedScus: 1, hours: 100, overageScuHours: 1.5 },
      // EUR Retail API provisioned and overage SCU-hour meters multiplied by provisioned hours and overage SCU-hours.
      expected: async () => securityCopilot({ currency: 'EUR', provisionedScus: 1, hours: 100, overageScuHours: 1.5 }),
    },
  ],
};

