'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'functions';
const HOURS_PER_MONTH = 730;
const SIZE = { ep1: { vcpu: 1, mem: 3.5 }, ep2: { vcpu: 2, mem: 7 }, ep3: { vcpu: 4, mem: 14 } };
const COMMIT = { payg: 'payg', sp1y: 'sv-one-year', sp3y: 'sv-three-year' };

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function offer(name, region) { return (await calc.offerPrice(SLUG, name, region)).value; }
async function premiumCalc({ region, size = 'ep1', alwaysReadyInstances = 1, prewarmedInstances = 0, prewarmedHours = HOURS_PER_MONTH, scaleOutInstances = 0, scaleOutHours = 0, hours = HOURS_PER_MONTH, commitment = 'payg' }) {
  const s = SIZE[size];
  const suffix = COMMIT[commitment];
  const alwaysCpuRate = await offer(`premium-vcpu-duration-${suffix}`, region);
  const alwaysMemRate = await offer(`premium-memory-duration-${suffix}`, region);
  const paygCpuRate = await offer('premium-vcpu-duration-payg', region);
  const paygMemRate = await offer('premium-memory-duration-payg', region);
  const lines = [];
  const always = Math.max(alwaysReadyInstances, 1);
  lines.push(line(`always-ready vCPU: ${always} ${size} * ${s.vcpu} vCPU * ${hours} hours * ${alwaysCpuRate}`, always * s.vcpu * hours * alwaysCpuRate, { sourceOffer: `premium-vcpu-duration-${suffix}` }));
  lines.push(line(`always-ready memory: ${always} ${size} * ${s.mem} GiB * ${hours} hours * ${alwaysMemRate}`, always * s.mem * hours * alwaysMemRate, { sourceOffer: `premium-memory-duration-${suffix}` }));
  const extraHours = prewarmedInstances * prewarmedHours + scaleOutInstances * scaleOutHours;
  if (extraHours > 0) {
    lines.push(line(`pre-warmed/scale-out vCPU: ${s.vcpu} vCPU * ${extraHours} instance-hours * ${paygCpuRate}`, s.vcpu * extraHours * paygCpuRate, { sourceOffer: 'premium-vcpu-duration-payg' }));
    lines.push(line(`pre-warmed/scale-out memory: ${s.mem} GiB * ${extraHours} instance-hours * ${paygMemRate}`, s.mem * extraHours * paygMemRate, { sourceOffer: 'premium-memory-duration-payg' }));
  }
  return { monthlyList: totalOf(lines), lines };
}
async function premiumRetail({ region, currency, size = 'ep1', alwaysReadyInstances = 1, hours = HOURS_PER_MONTH }) {
  const rows = dedupe(await query(`serviceName eq 'Functions' and armRegionName eq '${region}'`, currency));
  const cpu = rows.find(r => r.productName === 'Premium Functions' && r.meterName === 'Premium vCPU Duration');
  const mem = rows.find(r => r.productName === 'Premium Functions' && r.meterName === 'Premium Memory Duration');
  if (!cpu || !mem) throw new Error('missing Premium Functions retail meters');
  const s = SIZE[size];
  const always = Math.max(alwaysReadyInstances, 1);
  const lines = [
    line(`always-ready vCPU: ${always} ${size} * ${s.vcpu} vCPU * ${hours} hours / ${unitSize(cpu.unitOfMeasure)} * ${cpu.retailPrice}`, always * s.vcpu * hours / unitSize(cpu.unitOfMeasure) * cpu.retailPrice, { meterId: cpu.meterId }),
    line(`always-ready memory: ${always} ${size} * ${s.mem} GiB * ${hours} hours / ${unitSize(mem.unitOfMeasure)} * ${mem.retailPrice}`, always * s.mem * hours / unitSize(mem.unitOfMeasure) * mem.retailPrice, { meterId: mem.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'functions-premium',
  source: 'both',
  cases: [
    {
      name: 'default ep1 one always ready no prewarmed', region: 'eastus2', currency: 'USD',
      component: { type: 'functions-premium', size: 'ep1', alwaysReadyInstances: 1 },
      // Size and always-ready are required; EP1 with one always-ready and prewarmed default 0 is 730 hours of 1 vCPU and 3.5 GiB.
      expected: async () => premiumCalc({ region: 'eastus2', size: 'ep1', alwaysReadyInstances: 1, prewarmedInstances: 0 }),
    },
    {
      name: 'ep2 with prewarmed and scale out', region: 'eastus2', currency: 'USD',
      component: { type: 'functions-premium', size: 'ep2', alwaysReadyInstances: 2, prewarmedInstances: 1, prewarmedHours: 100, scaleOutInstances: 3, scaleOutHours: 10 },
      // Always-ready, pre-warmed, and scale-out EP2 allocations are charged PAYG vCPU-hours and GiB-hours for their allocation time.
      expected: async () => premiumCalc({ region: 'eastus2', size: 'ep2', alwaysReadyInstances: 2, prewarmedInstances: 1, prewarmedHours: 100, scaleOutInstances: 3, scaleOutHours: 10 }),
    },
    {
      name: 'ep3 savings plan only always ready', region: 'eastus2', currency: 'USD',
      component: { type: 'functions-premium', size: 'ep3', alwaysReadyInstances: 1, prewarmedInstances: 1, prewarmedHours: 100, commitment: 'sp1y' },
      // Savings-plan offers apply only to always-ready EP3; pre-warmed capacity remains PAYG for its allocated hours.
      expected: async () => premiumCalc({ region: 'eastus2', size: 'ep3', alwaysReadyInstances: 1, prewarmedInstances: 1, prewarmedHours: 100, commitment: 'sp1y' }),
    },
    {
      name: 'ep1 three year savings west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'functions-premium', size: 'ep1', alwaysReadyInstances: 2, prewarmedInstances: 0, commitment: 'sp3y' },
      // Non-US region uses West Europe calculator rates with the three-year savings-plan offer on always-ready instances.
      expected: async () => premiumCalc({ region: 'westeurope', size: 'ep1', alwaysReadyInstances: 2, prewarmedInstances: 0, commitment: 'sp3y' }),
    },
    {
      name: 'ep2 part-time payg', region: 'eastus2', currency: 'USD',
      component: { type: 'functions-premium', size: 'ep2', alwaysReadyInstances: 1, prewarmedInstances: 0, hours: 100 },
      // PAYG always-ready allocation can be priced for an explicit 100-hour interval.
      expected: async () => premiumCalc({ region: 'eastus2', size: 'ep2', alwaysReadyInstances: 1, prewarmedInstances: 0, hours: 100 }),
    },
    {
      name: 'ep1 EUR retail', region: 'eastus2', currency: 'EUR',
      component: { type: 'functions-premium', size: 'ep1', alwaysReadyInstances: 1, prewarmedInstances: 0, hours: 25 },
      // EUR comes from Retail API Functions Premium vCPU and memory meters; calculator data is USD-only.
      expected: async () => premiumRetail({ region: 'eastus2', currency: 'EUR', size: 'ep1', alwaysReadyInstances: 1, hours: 25 }),
    },
  ],
};
