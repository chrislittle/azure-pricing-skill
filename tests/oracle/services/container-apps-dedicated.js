'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS_PER_MONTH = 730;
const SECONDS_PER_HOUR = 3600;
const GPU_CONSUMPTION = { t4: { vcpu: 8, mem: 56 }, a100: { vcpu: 24, mem: 220 } };
const PROFILES = {
  d4: { vcpu: 4, mem: 16 }, d8: { vcpu: 8, mem: 32 }, d16: { vcpu: 16, mem: 64 }, d32: { vcpu: 32, mem: 128 },
  e4: { vcpu: 4, mem: 32 }, e8: { vcpu: 8, mem: 64 }, e16: { vcpu: 16, mem: 128 }, e32: { vcpu: 32, mem: 256 },
  'nc24-a100': { vcpu: 24, mem: 220, gpu: 1 }, 'nc48-a100': { vcpu: 48, mem: 440, gpu: 2 }, 'nc96-a100': { vcpu: 96, mem: 880, gpu: 4 },
};

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function savingsPrice(row, commitment) {
  if (commitment === 'payg') return row.retailPrice;
  const term = commitment === 'sp1y' ? '1 Year' : '3 Years';
  const hit = (row.savingsPlan || []).find(s => s.term === term);
  if (!hit) throw new Error(`missing ${term} savings price for ${row.meterName}`);
  return hit.retailPrice;
}
function pick(rows, meterName) {
  const hits = rows.filter(r => r.productName === 'Azure Container Apps' && r.meterName === meterName && r.type === 'Consumption');
  if (hits.length !== 1) throw new Error(`expected one Container Apps row for ${meterName}, found ${hits.length}`);
  return hits[0];
}
async function aca({ region, currency, instances = 1, profile = 'd4', hours = HOURS_PER_MONTH, environments = 1, planManagement = true, privateEndpoint = false, plannedMaintenance = false, commitment = 'payg', consumptionGpu = 'none', gpuReplicas = 1, gpuHours = 100, sessionHours = 0 }) {
  const rows = dedupe(await query(`serviceName eq 'Azure Container Apps' and armRegionName eq '${region}'`, currency));
  const lines = [];
  const instanceHours = commitment === 'payg' ? hours : HOURS_PER_MONTH;
  if (instances > 0) {
    const p = PROFILES[profile];
    if (p.gpu) {
      const gpu = pick(rows, 'Dedicated GPU Usage');
      const gpuPrice = savingsPrice(gpu, commitment);
      lines.push(line(`${profile} GPU: ${instances} instances * ${p.gpu} GPU * ${instanceHours} hours / ${unitSize(gpu.unitOfMeasure)} * ${gpuPrice}`, instances * p.gpu * instanceHours / unitSize(gpu.unitOfMeasure) * gpuPrice, { meterId: gpu.meterId }));
    } else {
      const cpu = pick(rows, 'Dedicated vCPU Usage');
      const mem = pick(rows, 'Dedicated Memory Usage');
      const cpuPrice = savingsPrice(cpu, commitment);
      const memPrice = savingsPrice(mem, commitment);
      lines.push(line(`${profile} vCPU: ${instances} instances * ${p.vcpu} vCPU * ${instanceHours} hours / ${unitSize(cpu.unitOfMeasure)} * ${cpuPrice}`, instances * p.vcpu * instanceHours / unitSize(cpu.unitOfMeasure) * cpuPrice, { meterId: cpu.meterId }));
      lines.push(line(`${profile} memory: ${instances} instances * ${p.mem} GiB * ${instanceHours} hours / ${unitSize(mem.unitOfMeasure)} * ${memPrice}`, instances * p.mem * instanceHours / unitSize(mem.unitOfMeasure) * memPrice, { meterId: mem.meterId }));
    }
  }
  for (const [enabled, meterName] of [[planManagement && instances > 0, 'Dedicated Plan Management'], [privateEndpoint, 'Environment Private Endpoint'], [plannedMaintenance, 'Environment Planned Maintenance Hour']]) {
    if (!enabled) continue;
    const r = pick(rows, meterName);
    const price = savingsPrice(r, commitment);
    lines.push(line(`${meterName}: ${environments} environments * ${HOURS_PER_MONTH} hours / ${unitSize(r.unitOfMeasure)} * ${price}`, environments * HOURS_PER_MONTH / unitSize(r.unitOfMeasure) * price, { meterId: r.meterId }));
  }
  if (consumptionGpu !== 'none') {
    const meterName = consumptionGpu === 't4' ? 'Standard NC T4 v3 GPU Usage' : 'Standard NC A100 v4 GPU Usage';
    const r = pick(rows, meterName);
    const price = savingsPrice(r, commitment);
    const seconds = gpuHours * SECONDS_PER_HOUR;
    lines.push(line(`${consumptionGpu} serverless GPU: ${gpuReplicas} replicas * ${seconds} seconds / ${unitSize(r.unitOfMeasure)} * ${price}`, gpuReplicas * seconds / unitSize(r.unitOfMeasure) * price, { meterId: r.meterId }));
    const shape = GPU_CONSUMPTION[consumptionGpu];
    const cpu = pick(rows, 'Standard vCPU Active Usage');
    const mem = pick(rows, 'Standard Memory Active Usage');
    const cpuPrice = savingsPrice(cpu, commitment);
    const memPrice = savingsPrice(mem, commitment);
    lines.push(line(`${consumptionGpu} serverless vCPU: ${gpuReplicas} replicas * ${shape.vcpu} vCPU * ${seconds} seconds / ${unitSize(cpu.unitOfMeasure)} * ${cpuPrice}`, gpuReplicas * shape.vcpu * seconds / unitSize(cpu.unitOfMeasure) * cpuPrice, { meterId: cpu.meterId }));
    lines.push(line(`${consumptionGpu} serverless memory: ${gpuReplicas} replicas * ${shape.mem} GiB * ${seconds} seconds / ${unitSize(mem.unitOfMeasure)} * ${memPrice}`, gpuReplicas * shape.mem * seconds / unitSize(mem.unitOfMeasure) * memPrice, { meterId: mem.meterId }));
  }
  if (sessionHours > 0) {
    const r = pick(rows, 'Dynamic Sessions');
    const price = savingsPrice(r, commitment);
    lines.push(line(`Dynamic Sessions: ${sessionHours} session-hours / ${unitSize(r.unitOfMeasure)} * ${price}`, sessionHours / unitSize(r.unitOfMeasure) * price, { meterId: r.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

const profileCases = Object.keys(PROFILES).map(profile => ({
  name: `profile ${profile} smoke`, region: 'eastus2', currency: 'USD',
  component: { type: 'container-apps-dedicated', profile, instances: 1, hours: 1, environments: 0, planManagement: false },
  // Dedicated CPU/memory profiles use vCPU and memory hours; dedicated NC A100 profiles use only the Dedicated GPU Usage meter.
  expected: async () => aca({ region: 'eastus2', currency: 'USD', profile, instances: 1, hours: 1, environments: 0, planManagement: false }),
}));

module.exports = {
  type: 'container-apps-dedicated',
  source: 'retail-api',
  cases: [
    {
      name: 'd4 with management extras', region: 'eastus2', currency: 'USD',
      component: { type: 'container-apps-dedicated', instances: 2, profile: 'd4', environments: 1, planManagement: true, privateEndpoint: true, plannedMaintenance: true },
      // Dedicated D4 uses vCPU+memory hourly meters, and plan management is charged because Dedicated instances are present.
      expected: async () => aca({ region: 'eastus2', currency: 'USD', instances: 2, profile: 'd4', environments: 1, privateEndpoint: true, plannedMaintenance: true }),
    },
    {
      name: 'private endpoint only no dedicated management', region: 'eastus2', currency: 'USD',
      component: { type: 'container-apps-dedicated', instances: 0, environments: 1, planManagement: true, privateEndpoint: true },
      // With zero Dedicated instances, plan management is not charged; private endpoint remains 730 hours * $0.10 = $73.
      expected: async () => aca({ region: 'eastus2', currency: 'USD', instances: 0, environments: 1, planManagement: true, privateEndpoint: true, consumptionGpu: 'none', sessionHours: 0 }),
    },
    {
      name: 'e8 one year savings plan part-time', region: 'eastus2', currency: 'USD',
      component: { type: 'container-apps-dedicated', instances: 1, profile: 'e8', hours: 100, commitment: 'sp1y', planManagement: false },
      // Savings-plan commitments cover the full monthly allocation, so instance compute uses 730 hours even when hours is 100.
      expected: async () => aca({ region: 'eastus2', currency: 'USD', instances: 1, profile: 'e8', hours: 100, commitment: 'sp1y', planManagement: false }),
    },
    {
      name: 'nc24 a100 three year savings', region: 'eastus2', currency: 'USD',
      component: { type: 'container-apps-dedicated', instances: 1, profile: 'nc24-a100', commitment: 'sp3y', planManagement: false },
      // Dedicated NC A100 profiles are priced by Dedicated GPU Usage; the 3-year savings-plan price applies to that GPU meter.
      expected: async () => aca({ region: 'eastus2', currency: 'USD', instances: 1, profile: 'nc24-a100', commitment: 'sp3y', planManagement: false }),
    },
    {
      name: 'serverless t4 gpu per-second', region: 'eastus2', currency: 'USD',
      component: { type: 'container-apps-dedicated', instances: 0, consumptionGpu: 't4', gpuReplicas: 2, gpuHours: 0.5, planManagement: false, sessionHours: 1.2 },
      // Serverless GPU adds per-second GPU, vCPU, and memory active-usage meters; Dynamic Sessions use the provided session-hours.
      expected: async () => aca({ region: 'eastus2', currency: 'USD', instances: 0, consumptionGpu: 't4', gpuReplicas: 2, gpuHours: 0.5, planManagement: false, sessionHours: 1.2 }),
    },
    {
      name: 'serverless a100 west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'container-apps-dedicated', instances: 0, consumptionGpu: 'a100', gpuReplicas: 1, gpuHours: 10, planManagement: false },
      // Non-US region per-second A100 Consumption GPU plus active vCPU and memory meters.
      expected: async () => aca({ region: 'westeurope', currency: 'USD', instances: 0, consumptionGpu: 'a100', gpuReplicas: 1, gpuHours: 10, planManagement: false }),
    },
    {
      name: 'd4 EUR retail', region: 'eastus2', currency: 'EUR',
      component: { type: 'container-apps-dedicated', instances: 1, profile: 'd4', hours: 10, planManagement: true },
      // EUR comes from Retail API; Dedicated compute uses 10 hours while mandatory plan management uses the monthly environment fee.
      expected: async () => aca({ region: 'eastus2', currency: 'EUR', instances: 1, profile: 'd4', hours: 10, planManagement: true }),
    },
    ...profileCases,
  ],
};
