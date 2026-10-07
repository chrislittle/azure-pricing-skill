'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS_PER_MONTH = 730;
const VCPU = {
  Standard_D2s_v5: 2,
  Standard_D4s_v5: 4,
  Standard_D8as_v5: 8,
  Standard_E8_4ds_v5: 8,
  'Standard_E8-4ds_v5': 8,
  Standard_DC4as_v5: 4,
  Standard_L8as_v3: 8,
  Standard_NC24ads_A100_v4: 24,
  Standard_NCC40ads_H100_v5: 40,
};
const ACTIVE_VCPU = { Standard_E8_4ds_v5: 4, 'Standard_E8-4ds_v5': 4 };
const LICENSE = {
  rhel: [{ max: 2, rate: 0.0288 }, { max: 4, rate: 0.0576 }, { max: Infinity, rate: 0.12 }],
  sles: [{ max: 2, rate: 0.065 }, { max: 4, rate: 0.13 }, { max: Infinity, rate: 0.15 }],
};
const SQL = {
  web: [{ max: 4, rate: 0.032 }, { max: Infinity, perVcpu: 0.016 }],
  standard: [{ max: 4, rate: 0.4 }, { max: Infinity, perVcpu: 0.2 }],
  enterprise: [{ max: 4, rate: 1.5 }, { max: Infinity, perVcpu: 0.75 }],
};
const SQL_SLES = {
  standard: [{ max: 4, rate: 0.6 }, { max: Infinity, perVcpu: 0.2 }],
};

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function displaySku(sku) { return sku.replace(/^Standard_/, ''); }
function meterCandidates(sku) {
  const s = displaySku(sku);
  const withSpaces = s.replace(/_/g, ' ');
  const lastUnderscoreSpace = s.replace(/_(v\d)$/i, ' $1');
  return [...new Set([s, withSpaces, lastUnderscoreSpace, s.replace(/_/g, '')])];
}
function apiCandidates(sku) {
  const s = displaySku(sku);
  const withSpaces = s.replace(/_/g, ' ');
  const lastUnderscoreSpace = s.replace(/_(v\d)$/i, ' $1');
  return [...new Set([`Standard_${s}`, `Standard_${s.replace(/_/g, '')}`, s, s.replace(/_/g, ''), withSpaces, lastUnderscoreSpace])];
}
async function rows(region, currency) {
  return dedupe(await query(`serviceName eq 'Virtual Machines' and armRegionName eq '${region}'`, currency));
}
function pickSpot(rows, sku, os) {
  const meters = meterCandidates(sku).map(s => `${s} Spot`);
  const apis = apiCandidates(sku).map(s => `${s} Spot`);
  const wantsWindows = os === 'windows';
  const isWindowsProduct = r => /Windows|Srs Win| Win$/.test(r.productName);
  const hits = rows.filter(r => meters.includes(r.meterName) && apis.includes(r.skuName) && r.type === 'Consumption' && (wantsWindows ? isWindowsProduct(r) : !isWindowsProduct(r)));
  if (hits.length !== 1) throw new Error(`expected one ${sku} Spot ${os} row, found ${hits.length}`);
  return hits[0];
}
function linuxLicense(os, vcpus, count, hours) {
  if (os === 'rhel-byos' || !LICENSE[os]) return null;
  const tier = LICENSE[os].find(t => vcpus <= t.max);
  const label = os === 'rhel' ? `Red Hat Enterprise Linux license, ${vcpus} vCPU tier` : `SUSE Linux Enterprise Server Standard, ${vcpus <= 2 ? '1-2' : vcpus <= 4 ? '3-4' : '5+'} vCPU VM`;
  return line(`${label}: ${count} VMs * ${hours} hours * ${tier.rate}`, count * hours * tier.rate, { source: 'linux-license-table' });
}
function sqlLicense(sqlLicense, vcpus, count, hours, os) {
  if (!sqlLicense || sqlLicense === 'none') return null;
  const table = os === 'sles' && SQL_SLES[sqlLicense] ? SQL_SLES[sqlLicense] : SQL[sqlLicense];
  const tier = table.find(t => vcpus <= t.max);
  const rate = tier.rate == null ? tier.perVcpu * vcpus : tier.rate;
  const label = os === 'sles' ? `SQL Server ${sqlLicense} on SLES combined license` : `SQL Server ${sqlLicense} license`;
  return line(`${label}: ${count} VMs * ${hours} hours * ${rate} (${vcpus} active vCPU tier)`, count * hours * rate, { source: 'sql-license-table' });
}
async function spotVm({ region, currency, sku, os = 'linux', sqlLicense: sql = 'none', count = 1, hours = HOURS_PER_MONTH }) {
  const computeOs = os === 'windows' ? 'windows' : 'linux';
  const r = pickSpot(await rows(region, currency), sku, computeOs);
  const lines = [line(`${sku} Spot ${os}: ${count} VMs * ${hours} hours / ${unitSize(r.unitOfMeasure)} * ${r.retailPrice}`, count * hours / unitSize(r.unitOfMeasure) * r.retailPrice, { meterId: r.meterId })];
  const vcpus = VCPU[sku];
  const linuxLine = linuxLicense(os, vcpus, count, hours);
  const sqlLine = sqlLicense(sql, ACTIVE_VCPU[sku] || vcpus, count, hours, os);
  if (linuxLine && !(os === 'sles' && sqlLine)) lines.push(linuxLine);
  if (sqlLine) lines.push(sqlLine);
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'spot-vm',
  source: 'retail-api',
  cases: [
    {
      name: 'linux D2s v5 all month', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D2s_v5', os: 'linux', count: 2 },
      // Retail API Spot meter is per VM-hour; Spot compute has no reservation or savings-plan term rows.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D2s_v5', os: 'linux', count: 2 }),
    },
    {
      name: 'windows D2s v5 part-time', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D2s_v5', os: 'windows', count: 1, hours: 100 },
      // Windows Spot uses the Windows Spot Consumption meter, multiplied by actual running hours.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D2s_v5', os: 'windows', count: 1, hours: 100 }),
    },
    {
      name: 'windows ahb uses linux spot compute', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D2s_v5', os: 'windows-ahb', count: 3, hours: 50 },
      // Azure Hybrid Benefit means the Windows license is not included; price the Linux Spot compute meter.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D2s_v5', os: 'windows-ahb', count: 3, hours: 50 }),
    },
    {
      name: 'rhel license add-on', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D2s_v5', os: 'rhel', count: 1, hours: 100 },
      // RHEL uses the Linux Spot compute meter plus the 1-2 vCPU RHEL hourly license add-on.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D2s_v5', os: 'rhel', count: 1, hours: 100 }),
    },
    {
      name: 'sles license add-on', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D2s_v5', os: 'sles', count: 1, hours: 100 },
      // SLES uses the Linux Spot compute meter plus the 1-2 vCPU SUSE license hourly add-on.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D2s_v5', os: 'sles', count: 1, hours: 100 }),
    },
    {
      name: 'rhel four vcpu license add-on', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D4s_v5', os: 'rhel', count: 1, hours: 100 },
      // RHEL 3-4 vCPU tier is an hourly OS add-on from Azure Linux VM pricing, in addition to Linux Spot compute.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D4s_v5', os: 'rhel', count: 1, hours: 100 }),
    },
    {
      name: 'sles eight vcpu license add-on', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D8as_v5', os: 'sles', count: 1, hours: 100 },
      // SLES 5+ vCPU tier is an hourly OS add-on from Azure Linux VM pricing, in addition to Linux Spot compute.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D8as_v5', os: 'sles', count: 1, hours: 100 }),
    },
    {
      name: 'sql standard license add-on', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D2s_v5', os: 'linux', sqlLicense: 'standard', count: 1, hours: 100 },
      // SQL Server Standard add-on bills at the 1-4 vCPU tier even for a 2-vCPU VM.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D2s_v5', os: 'linux', sqlLicense: 'standard', count: 1, hours: 100 }),
    },
    {
      name: 'sql web license add-on', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D4s_v5', os: 'linux', sqlLicense: 'web', count: 1, hours: 100 },
      // SQL Server Web add-on is licensed per active vCPU-hour, in addition to Linux Spot compute.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D4s_v5', os: 'linux', sqlLicense: 'web', count: 1, hours: 100 }),
    },
    {
      name: 'sql enterprise license add-on', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D4s_v5', os: 'linux', sqlLicense: 'enterprise', count: 1, hours: 100 },
      // SQL Server Enterprise add-on is licensed per active vCPU-hour, in addition to Linux Spot compute.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D4s_v5', os: 'linux', sqlLicense: 'enterprise', count: 1, hours: 100 }),
    },
    {
      name: 'sql standard constrained core active vcpus', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_E8-4ds_v5', os: 'linux', sqlLicense: 'standard', count: 1, hours: 100 },
      // SQL Server on constrained-core E8-4ds_v5 bills SQL for 4 active vCPUs, while compute still uses the E8-4ds v5 Spot meter.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_E8-4ds_v5', os: 'linux', sqlLicense: 'standard', count: 1, hours: 100 }),
    },
    {
      name: 'sles sql standard combined license', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D4s_v5', os: 'sles', sqlLicense: 'standard', count: 1, hours: 100 },
      // SQL Server Standard on SLES includes Linux Spot compute, the SLES OS add-on and SQL Standard per active vCPU-hour.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_D4s_v5', os: 'sles', sqlLicense: 'standard', count: 1, hours: 100 }),
    },
    {
      name: 'dc4as current product name', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_DC4as_v5', os: 'linux', count: 1, hours: 100 },
      // Current DCasv5 retail product names use DC4as v5 meter names; match exact Spot Consumption rows.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_DC4as_v5', os: 'linux', count: 1, hours: 100 }),
    },
    {
      name: 'nc24ads a100 current product name', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_NC24ads_A100_v4', os: 'linux', count: 1, hours: 100 },
      // Current NCads A100 v4 retail rows keep A100 underscores in meter and SKU names.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_NC24ads_A100_v4', os: 'linux', count: 1, hours: 100 }),
    },
    {
      name: 'l8as v3 west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_L8as_v3', os: 'linux', count: 1, hours: 200 },
      // Non-US region: current Lasv3 Linux Spot meter in West Europe, charged only while running.
      expected: async () => spotVm({ region: 'westeurope', currency: 'USD', sku: 'Standard_L8as_v3', os: 'linux', count: 1, hours: 200 }),
    },
    {
      name: 'ncc40ads h100 linux monthly', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_NCC40ads_H100_v5', os: 'linux', count: 1 },
      // NCCadsv5 retail rows remove underscores from meter names; Linux Spot is 730 * $1.289904 = $941.63.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_NCC40ads_H100_v5', os: 'linux', count: 1 }),
    },
    {
      name: 'ncc40ads h100 windows monthly', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_NCC40ads_H100_v5', os: 'windows', count: 1 },
      // NCCadsv5 Windows Spot is 730 * $1.629936 = $1,189.85.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_NCC40ads_H100_v5', os: 'windows', count: 1 }),
    },
    {
      name: 'win suffix product name stays windows', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_NCC40ads_H100_v5', os: 'windows', count: 1, hours: 100 },
      // Retail productName is "Virtual Machines NCCadsv5 Srs Win"; treat the " Win" suffix as Windows included-license compute.
      expected: async () => spotVm({ region: 'eastus2', currency: 'USD', sku: 'Standard_NCC40ads_H100_v5', os: 'windows', count: 1, hours: 100 }),
    },
    {
      name: 'promo sizes refused', region: 'eastus2', currency: 'USD',
      component: { type: 'spot-vm', sku: 'Standard_D2s_v5_Promo', os: 'linux', count: 1 },
      expectEngineError: /Promo sizes/i,
    },
    {
      name: 'linux D2s v5 EUR', region: 'eastus2', currency: 'EUR',
      component: { type: 'spot-vm', sku: 'Standard_D2s_v5', os: 'linux', count: 1, hours: 25 },
      // EUR comes from Retail API currencyCode because calculator data is USD-only.
      expected: async () => spotVm({ region: 'eastus2', currency: 'EUR', sku: 'Standard_D2s_v5', os: 'linux', count: 1, hours: 25 }),
    },
  ],
};
