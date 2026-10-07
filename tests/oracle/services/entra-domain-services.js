'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS_PER_MONTH = 730;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function skuName(sku) {
  return { standard: 'Standard', enterprise: 'Enterprise', premium: 'Premium' }[sku] || sku;
}

function forestMeter(sku, forestType) {
  const s = skuName(sku);
  const f = forestType === 'resource' ? 'Resource' : 'User';
  return `${s} ${f} Forest`;
}

async function rows(region, currency) {
  return dedupe(await query(`serviceName eq 'Microsoft Entra Domain Services' and armRegionName eq '${region}'`, currency));
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function retailDomainServices({ region, currency = 'USD', sku = 'enterprise', forestType = 'user', replicaSets = 1, hours = HOURS_PER_MONTH }) {
  const meterName = forestMeter(sku, forestType);
  const r = pickOne(await rows(region, currency), x => x.type === 'Consumption' && x.skuName === skuName(sku) && x.meterName === meterName && x.unitOfMeasure === '1/Hour', meterName);
  const monthlyList = (hours / unitSize(r.unitOfMeasure)) * r.retailPrice * replicaSets;
  return {
    monthlyList: round2(monthlyList),
    lines: [line(`${meterName}: ${replicaSets} replica set(s) * ${hours} hours * ${r.retailPrice}`, monthlyList, { meterId: r.meterId })],
  };
}

module.exports = {
  type: 'entra-domain-services',
  source: 'retail-api',
  cases: [
    {
      name: 'standard user forest all month',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'standard', forestType: 'user', replicaSets: 1 },
      // Retail API meter Standard User Forest is hourly; one all-month replica set is 730 hours.
      expected: async () => retailDomainServices({ region: 'eastus2', sku: 'standard', forestType: 'user', replicaSets: 1 }),
    },
    {
      name: 'enterprise user forest with extra replica set',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'enterprise', forestType: 'user', replicaSets: 2 },
      // Retail API meter Enterprise User Forest is hourly; charge each replica set for the same hours.
      expected: async () => retailDomainServices({ region: 'eastus2', sku: 'enterprise', forestType: 'user', replicaSets: 2 }),
    },
    {
      name: 'enterprise resource forest',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'enterprise', forestType: 'resource', replicaSets: 1 },
      // Retail API meter Enterprise Resource Forest is hourly and separately named from User Forest.
      expected: async () => retailDomainServices({ region: 'eastus2', sku: 'enterprise', forestType: 'resource', replicaSets: 1 }),
    },
    {
      name: 'premium resource forest',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'premium', forestType: 'resource', replicaSets: 1 },
      // Retail API meter Premium Resource Forest is hourly; Premium user and resource forest rates match.
      expected: async () => retailDomainServices({ region: 'eastus2', sku: 'premium', forestType: 'resource', replicaSets: 1 }),
    },
    {
      name: 'premium user forest part-time hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'premium', forestType: 'user', replicaSets: 1, hours: 100 },
      // Retail API meter Premium User Forest is hourly; use the component's 100-hour lifetime.
      expected: async () => retailDomainServices({ region: 'eastus2', sku: 'premium', forestType: 'user', replicaSets: 1, hours: 100 }),
    },
    {
      name: 'west europe enterprise user forest',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'enterprise', forestType: 'user', replicaSets: 1 },
      // Retail API West Europe exposes the same hourly meter names; this verifies non-US region lookup.
      expected: async () => retailDomainServices({ region: 'westeurope', sku: 'enterprise', forestType: 'user', replicaSets: 1 }),
    },
    {
      name: 'enterprise maximum five replica sets',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'enterprise', forestType: 'user', replicaSets: 5 },
      // Retail API Enterprise User Forest is hourly per replica set; this covers the public 5-replica-set maximum.
      expected: async () => retailDomainServices({ region: 'eastus2', sku: 'enterprise', forestType: 'user', replicaSets: 5 }),
    },
    {
      name: 'standard user forest 744-hour month boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'standard', forestType: 'user', replicaSets: 1, hours: 744 },
      // Retail API Standard User Forest is hourly; 744 hours checks a 31-day full-month boundary instead of the 730-hour convention.
      expected: async () => retailDomainServices({ region: 'eastus2', sku: 'standard', forestType: 'user', replicaSets: 1, hours: 744 }),
    },
    {
      name: 'us gov virginia enterprise user forest',
      region: 'usgovvirginia',
      currency: 'USD',
      component: { type: 'entra-domain-services', sku: 'enterprise', forestType: 'user', replicaSets: 1 },
      // Retail API US Gov Virginia has separate government-region hourly rates for Enterprise User Forest.
      expected: async () => retailDomainServices({ region: 'usgovvirginia', sku: 'enterprise', forestType: 'user', replicaSets: 1 }),
    },
    {
      name: 'west europe enterprise user forest in eur',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'entra-domain-services', sku: 'enterprise', forestType: 'user', replicaSets: 1 },
      // Retail API EUR in West Europe returns native EUR hourly price for Enterprise User Forest; no FX conversion.
      expected: async () => retailDomainServices({ region: 'westeurope', currency: 'EUR', sku: 'enterprise', forestType: 'user', replicaSets: 1 }),
    },
    {
      name: 'eur enterprise user forest',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'entra-domain-services', sku: 'enterprise', forestType: 'user', replicaSets: 1 },
      // Retail API EUR returns native EUR hourly price for Enterprise User Forest; no FX conversion.
      expected: async () => retailDomainServices({ region: 'eastus2', currency: 'EUR', sku: 'enterprise', forestType: 'user', replicaSets: 1 }),
    },
  ],
};
