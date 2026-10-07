'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'database-migration';
const HOURS_PER_MONTH = 730;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function commitmentOffer(commitment) {
  if (commitment === 'savings-1y') return 'premium-compute-4-vcore-sv-one-year';
  if (commitment === 'savings-3y') return 'premium-compute-4-vcore-sv-three-year';
  return 'premium-compute-4-vcore-payg';
}

async function calculatorDms({ region, tier = 'premium', vcores, instances = 1, hours = HOURS_PER_MONTH, commitment = 'payg', newService = false }) {
  if (tier === 'standard') {
    const lines = [line(`Standard offline migration tier is published as free: ${instances} instance(s) * ${hours} hours`, 0)];
    return { monthlyList: 0, lines };
  }
  if (newService && vcores === 4) {
    const freeHours = 183 * 24;
    const billableHours = Math.max(0, hours - freeHours);
    const p = await calc.offerPrice(SLUG, commitmentOffer(commitment), region);
    const lines = [
      line(`New Premium 4-vCore service: max(0, ${hours} - ${freeHours} first-183-day free hours) * ${instances} instance(s) * ${p.value}`, billableHours * instances * p.value, { sourceOffer: commitmentOffer(commitment), freeHours }),
    ];
    return { monthlyList: totalOf(lines), lines };
  }
  const offer = commitmentOffer(commitment);
  const p = await calc.offerPrice(SLUG, offer, region);
  const fourVcoreHourly = p.value;
  const monthly = (vcores / 4) * instances * hours * fourVcoreHourly;
  const lines = [
    line(`Premium ${vcores} vCore: (${vcores}/4) * ${instances} instance(s) * ${hours} hours * 4-vCore offer ${fourVcoreHourly}`, monthly, { sourceOffer: offer }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function retailDms({ region, currency = 'USD', tier = 'premium', vcores, instances = 1, hours = HOURS_PER_MONTH, newService = false }) {
  if (tier === 'standard') return { monthlyList: 0, lines: [line(`Standard offline migration tier is published as free: ${instances} instance(s) * ${hours} hours`, 0)] };
  const rows = dedupe(await query(`serviceName eq 'Azure Database Migration Service' and armRegionName eq '${region}'`, currency));
  const sku = `${vcores} vCore`;
  const m = pickOne(rows, r => r.productName === 'Azure Database Migration Service Premium Compute' && r.skuName === sku && r.meterName === sku && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption', `DMS Premium ${sku}`);
  if (newService && vcores === 4) {
    const freeHours = 183 * 24;
    const billableHours = Math.max(0, hours - freeHours);
    const lines = [line(`Retail API new Premium ${sku}: max(0, ${hours} - ${freeHours} free hours) * ${instances} * ${m.retailPrice}`, billableHours * instances * m.retailPrice, { meterId: m.meterId, freeHours })];
    return { monthlyList: totalOf(lines), lines };
  }
  const lines = [
    line(`Retail API Premium ${sku}: ${instances} instance(s) * ${hours} hours * ${m.retailPrice}`, (instances * hours / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'database-migration',
  source: 'both',
  cases: [
    {
      name: 'standard 1-vcore offline migration is free',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'standard', vcores: 1, instances: 1, hours: 730 },
      // Public calculator exposes paid Premium offers only; the public component spec describes Standard/offline migration as free, so list cost is $0.
      expected: async () => calculatorDms({ region: 'eastus2', tier: 'standard', vcores: 1, instances: 1, hours: 730 }),
    },
    {
      name: 'premium 4-vcore payg one month',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'premium', vcores: 4, instances: 1, hours: 730, commitment: 'payg', newService: false },
      // Calculator premium-compute-4-vcore-payg is an hourly 4-vCore offer; monthly = 730 * offer price.
      expected: async () => calculatorDms({ region: 'eastus2', tier: 'premium', vcores: 4, instances: 1, hours: 730, commitment: 'payg', newService: false }),
    },
    {
      name: 'premium 4-vcore payg 744-hour calendar month',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'premium', vcores: 4, instances: 1, hours: 744, commitment: 'payg', newService: false },
      // The current public question spec allows 744 hours; calculator premium-compute-4-vcore-payg is hourly, so use 744 * offer price.
      expected: async () => calculatorDms({ region: 'eastus2', tier: 'premium', vcores: 4, instances: 1, hours: 744, commitment: 'payg', newService: false }),
    },
    {
      name: 'new premium 4-vcore service within 183-day free period',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'premium', vcores: 4, instances: 1, hours: 744, commitment: 'payg', newService: true },
      // Public component spec says a brand-new 4-vCore Premium migration service is free for the first 183 days; 744 hours is inside 183*24 free hours.
      expected: async () => calculatorDms({ region: 'eastus2', tier: 'premium', vcores: 4, instances: 1, hours: 744, commitment: 'payg', newService: true }),
    },
    {
      name: 'standard germany west central free despite missing free meter',
      region: 'germanywestcentral',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'standard', vcores: 1, instances: 1, hours: 744 },
      // Retail API Germany West Central has only Premium Compute rows and no Basic free meter, but Standard/offline migration remains a free tier by service pricing semantics.
      expected: async () => retailDms({ region: 'germanywestcentral', tier: 'standard', vcores: 1, instances: 1, hours: 744 }),
    },
    {
      name: 'premium 8-vcore two instances part-time',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'premium', vcores: 8, instances: 2, hours: 100, commitment: 'payg', newService: true },
      // Calculator publishes the 4-vCore hourly offer; 8 vCores are two 4-vCore blocks, multiplied by two instances and 100 hours.
      expected: async () => calculatorDms({ region: 'eastus2', tier: 'premium', vcores: 8, instances: 2, hours: 100, commitment: 'payg', newService: true }),
    },
    {
      name: 'premium 16-vcore one-year savings',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'premium', vcores: 16, instances: 1, hours: 730, commitment: 'savings-1y', newService: true },
      // Calculator premium-compute-4-vcore-sv-one-year is an hourly 4-vCore savings-plan price; scale by 16/4.
      expected: async () => calculatorDms({ region: 'eastus2', tier: 'premium', vcores: 16, instances: 1, hours: 730, commitment: 'savings-1y' }),
    },
    {
      name: 'premium 4-vcore three-year savings',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'premium', vcores: 4, instances: 1, hours: 336, commitment: 'savings-3y', newService: false },
      // Calculator premium-compute-4-vcore-sv-three-year is hourly; a two-week migration uses 336 hours.
      expected: async () => calculatorDms({ region: 'eastus2', tier: 'premium', vcores: 4, instances: 1, hours: 336, commitment: 'savings-3y', newService: false }),
    },
    {
      name: 'west europe regional premium rate',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'database-migration', engine: 'other', tier: 'premium', vcores: 8, instances: 1, hours: 730, commitment: 'payg', newService: true },
      // Calculator West Europe premium 4-vCore PAYG offer is region-specific; 8 vCores scale as two 4-vCore blocks.
      expected: async () => calculatorDms({ region: 'westeurope', tier: 'premium', vcores: 8, instances: 1, hours: 730, commitment: 'payg' }),
    },
    {
      name: 'eur premium retail api',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'database-migration', engine: 'other', tier: 'premium', vcores: 4, instances: 2, hours: 100, commitment: 'payg', newService: false },
      // EUR Retail API Premium Compute 4 vCore hourly row is queried natively and multiplied by two instances and 100 hours.
      expected: async () => retailDms({ region: 'westeurope', currency: 'EUR', tier: 'premium', vcores: 4, instances: 2, hours: 100 }),
    },
  ],
};
