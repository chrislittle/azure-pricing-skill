'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

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

async function easm({ region = 'eastus2', currency = 'USD', assets = 0, days = 30, hosts = 0, domains = 0, ipAddresses = 0, hostDays, domainDays, ipDays }) {
  const rows = dedupe(await query(`serviceName eq 'Microsoft Defender for Cloud' and productName eq 'Defender External Attack Surface Management'`, currency));
  const regional = rows.filter(r => (r.armRegionName === region || r.armRegionName === 'Global') && r.type === 'Consumption');
  const exact = regional.filter(r => r.armRegionName === region);
  const meter = pickOne(exact.length ? exact : regional, r => r.skuName === 'Defender EASM Standard' && r.meterName === 'Defender EASM Standard Asset', `Defender EASM Standard Asset in ${region}`);
  const hDays = hostDays || days;
  const dDays = domainDays || days;
  const iDays = ipDays || days;
  const lines = [];
  if (assets) lines.push(line(`Defender EASM assets: ${assets} assets * ${days} days * ${meter.retailPrice}`, (assets * days / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId }));
  if (hosts) lines.push(line(`Defender EASM approved host:IP combinations: ${hosts} hosts * ${hDays} days * ${meter.retailPrice}`, (hosts * hDays / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId }));
  if (domains) lines.push(line(`Defender EASM approved domains: ${domains} domains * ${dDays} days * ${meter.retailPrice}`, (domains * dDays / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId }));
  if (ipAddresses) lines.push(line(`Defender EASM approved IP addresses: ${ipAddresses} IPs * ${iDays} days * ${meter.retailPrice}`, (ipAddresses * iDays / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId }));
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'defender-easm',
  source: 'retail-api',
  cases: [
    {
      name: 'one asset one day', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-easm', assets: 1, days: 1 },
      // Learn says billing is based on billable assets after the 30-day trial; Retail API Standard Asset meter is per asset-day.
      expected: async () => easm({ assets: 1, days: 1 }),
    },
    {
      name: 'default full oracle month', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-easm', assets: 500 },
      // Component default is 30.4167 days; monthly cost is billable assets times days times the Standard Asset meter.
      expected: async () => easm({ assets: 500 }),
    },
    {
      name: 'thirty-day billing period', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-easm', assets: 1000, days: 30 },
      // Defender EASM billable-assets docs describe daily billable asset counts; use exactly 30 days here.
      expected: async () => easm({ assets: 1000, days: 30 }),
    },
    {
      name: 'thirty one day billing period', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-easm', assets: 1000, days: 31 },
      // Public spec supports 31 days; billable assets docs describe daily counts, so 1,000 assets are charged for 31 asset-days each.
      expected: async () => easm({ assets: 1000, days: 31 }),
    },
    {
      name: 'split billable assets with per-type days', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-easm', assets: 0, hosts: 100, domains: 50, ipAddresses: 25, hostDays: 31, domainDays: 30, ipDays: 7 },
      // Learn defines billable assets as approved host:IP combinations, domains, and IP addresses; each split count uses its own monitored days.
      expected: async () => easm({ hosts: 100, domains: 50, ipAddresses: 25, hostDays: 31, domainDays: 30, ipDays: 7 }),
    },
    {
      name: 'partial month', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-easm', assets: 250, days: 7 },
      // Per-asset-day semantics: 250 approved billable assets monitored for 7 days.
      expected: async () => easm({ assets: 250, days: 7 }),
    },
    {
      name: 'west europe uses regional asset meter', region: 'westeurope', currency: 'USD',
      component: { type: 'defender-easm', assets: 500, days: 30 },
      // Retail API exposes a West Europe Defender EASM Standard Asset row; multiply by billable assets and days.
      expected: async () => easm({ region: 'westeurope', assets: 500, days: 30 }),
    },
    {
      name: 'eur west europe', region: 'westeurope', currency: 'EUR',
      component: { type: 'defender-easm', assets: 500, days: 30 },
      // EUR Retail API Standard Asset meter is the source; calculator data is not available for this slug.
      expected: async () => easm({ region: 'westeurope', currency: 'EUR', assets: 500, days: 30 }),
    },
  ],
};

