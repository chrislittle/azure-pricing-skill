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

async function isoc({ region = 'eastus2', currency = 'USD', gbAnalyzed = 0, gbPerDay = 0, days = 30 }) {
  const rows = dedupe(await query(`serviceName eq 'Microsoft Defender' and productName eq 'Microsoft Defender ISOC'`, currency));
  const meter = pickOne(rows, r => r.armRegionName === region && r.skuName === 'Pay As You Go' && r.meterName === 'Pay As You Go Analysis' && r.unitOfMeasure === '1 GB' && r.type === 'Consumption', `Microsoft Defender ISOC Pay As You Go Analysis in ${region}`);
  const totalGb = gbAnalyzed + (gbPerDay * days);
  const lines = [
    line(`Defender ISOC ingestion: (${gbAnalyzed} monthly GB + ${gbPerDay} GB/day * ${days} days) * ${meter.retailPrice}`, (totalGb / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'defender-isoc',
  source: 'retail-api',
  cases: [
    {
      name: 'single GB analyzed', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-isoc', gbAnalyzed: 1 },
      // Learn says additional Microsoft and non-Microsoft security data can incur ingestion charges; Retail API Pay As You Go Analysis is per GB.
      expected: async () => isoc({ gbAnalyzed: 1 }),
    },
    {
      name: 'default-size estimate', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-isoc', gbAnalyzed: 100 },
      // Retail API Microsoft Defender ISOC Pay As You Go Analysis meter bills each GB analyzed.
      expected: async () => isoc({ gbAnalyzed: 100 }),
    },
    {
      name: 'large ingestion volume', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-isoc', gbAnalyzed: 1000 },
      // Linear per-GB Retail API meter: 1,000 GB times the regional Pay As You Go Analysis price.
      expected: async () => isoc({ gbAnalyzed: 1000 }),
    },
    {
      name: 'fractional GB rounds by line', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-isoc', gbAnalyzed: 12.345 },
      // Per-GB billing supports fractional GB in the oracle; each line is rounded to 2 decimals.
      expected: async () => isoc({ gbAnalyzed: 12.345 }),
    },
    {
      name: 'gb per day for thirty one days', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-isoc', gbAnalyzed: 0, gbPerDay: 10, days: 31 },
      // ISOC docs bill additional data ingested through connectors; public spec daily input converts to 10 GB/day * 31 days at the per-GB Analysis meter.
      expected: async () => isoc({ gbAnalyzed: 0, gbPerDay: 10, days: 31 }),
    },
    {
      name: 'monthly plus daily ingested data', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-isoc', gbAnalyzed: 20, gbPerDay: 5, days: 31 },
      // Monthly GB and daily GB are additive for the same per-GB ingestion meter: 20 + (5 * 31) GB.
      expected: async () => isoc({ gbAnalyzed: 20, gbPerDay: 5, days: 31 }),
    },
    {
      name: 'west europe regional price', region: 'westeurope', currency: 'USD',
      component: { type: 'defender-isoc', gbAnalyzed: 100 },
      // Retail API has regional Pay As You Go Analysis prices; West Europe differs from East US 2.
      expected: async () => isoc({ region: 'westeurope', gbAnalyzed: 100 }),
    },
    {
      name: 'eur west europe', region: 'westeurope', currency: 'EUR',
      component: { type: 'defender-isoc', gbAnalyzed: 100 },
      // EUR Retail API Pay As You Go Analysis meter multiplied by GB analyzed.
      expected: async () => isoc({ region: 'westeurope', currency: 'EUR', gbAnalyzed: 100 }),
    },
  ],
};
