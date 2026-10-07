'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS_PER_MONTH = 730;
const METER = {
  'general-purpose': 'Automatic General Purpose',
  'compute-optimized': 'Automatic Compute Optimized',
  'memory-optimized': 'Automatic Memory Optimized',
  'storage-optimized': 'Automatic Storage Optimized',
  'gpu-accelerated': 'Automatic GPU Accelerated',
  'high-performance': 'Automatic High Performance Compute',
  confidential: 'Automatic Confidential Compute',
};

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function pick(rows, meterName) {
  const hits = rows.filter(r => r.productName === 'Azure Kubernetes Service - Automatic' && r.meterName === meterName && r.type === 'Consumption');
  if (hits.length !== 1) throw new Error(`expected one AKS Automatic row for ${meterName}, found ${hits.length}`);
  return hits[0];
}
async function aksAuto({ region, currency, vcpus, computeType = 'general-purpose', otherPools = [], clusters = 1, hours = HOURS_PER_MONTH, clusterHours = HOURS_PER_MONTH }) {
  const rows = dedupe(await query(`serviceName eq 'Azure Kubernetes Service' and armRegionName eq '${region}'`, currency));
  const lines = [];
  const control = pick(rows, 'Automatic Hosted Control Plane');
  lines.push(line(`hosted control plane: ${clusters} clusters * ${clusterHours} hours / ${unitSize(control.unitOfMeasure)} * ${control.retailPrice}`, clusters * clusterHours / unitSize(control.unitOfMeasure) * control.retailPrice, { meterId: control.meterId }));
  const totals = new Map();
  for (const pool of [{ computeType, vcpus }, ...otherPools]) totals.set(pool.computeType, (totals.get(pool.computeType) || 0) + pool.vcpus);
  for (const [type, totalVcpus] of totals) {
    if (totalVcpus <= 0) continue;
    const r = pick(rows, METER[type]);
    lines.push(line(`${type}: ${totalVcpus} vCPU * ${hours} hours / ${unitSize(r.unitOfMeasure)} * ${r.retailPrice}`, totalVcpus * hours / unitSize(r.unitOfMeasure) * r.retailPrice, { meterId: r.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'aks-automatic',
  source: 'retail-api',
  cases: [
    {
      name: 'zero vcpu cluster only', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-automatic', vcpus: 0, computeType: 'general-purpose', clusters: 1 },
      // Zero worker vCPUs still pays the AKS Automatic hosted control-plane fee.
      expected: async () => aksAuto({ region: 'eastus2', currency: 'USD', vcpus: 0, computeType: 'general-purpose' }),
    },
    {
      name: 'general purpose all month', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-automatic', vcpus: 16, computeType: 'general-purpose', clusters: 1 },
      // Retail API has a hosted-control-plane hourly meter plus per-vCPU-hour Automatic General Purpose meter.
      expected: async () => aksAuto({ region: 'eastus2', currency: 'USD', vcpus: 16, computeType: 'general-purpose' }),
    },
    {
      name: 'two general purpose pools aggregate', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-automatic', vcpus: 3, computeType: 'general-purpose', otherPools: [{ computeType: 'general-purpose', vcpus: 5 }], clusters: 1 },
      // Two pools of the same compute type are additive: 3 + 5 = 8 general-purpose vCPUs.
      expected: async () => aksAuto({ region: 'eastus2', currency: 'USD', vcpus: 3, computeType: 'general-purpose', otherPools: [{ computeType: 'general-purpose', vcpus: 5 }], clusters: 1 }),
    },
    {
      name: 'compute and memory pools part-time', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-automatic', vcpus: 8, computeType: 'compute-optimized', otherPools: [{ computeType: 'memory-optimized', vcpus: 4 }], hours: 400, clusterHours: 730 },
      // Each pool's vCPU-hours are priced by its own Automatic compute-type meter; cluster fee remains 730 hours.
      expected: async () => aksAuto({ region: 'eastus2', currency: 'USD', vcpus: 8, computeType: 'compute-optimized', otherPools: [{ computeType: 'memory-optimized', vcpus: 4 }], hours: 400, clusterHours: 730 }),
    },
    {
      name: 'storage gpu and hpc pools', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-automatic', vcpus: 6, computeType: 'storage-optimized', otherPools: [{ computeType: 'gpu-accelerated', vcpus: 2 }, { computeType: 'high-performance', vcpus: 10 }] },
      // Covers Storage Optimized, GPU Accelerated, and High Performance Compute vCPU-hour meters.
      expected: async () => aksAuto({ region: 'eastus2', currency: 'USD', vcpus: 6, computeType: 'storage-optimized', otherPools: [{ computeType: 'gpu-accelerated', vcpus: 2 }, { computeType: 'high-performance', vcpus: 10 }] }),
    },
    {
      name: 'confidential two clusters west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'aks-automatic', vcpus: 5, computeType: 'confidential', clusters: 2, clusterHours: 500, hours: 500 },
      // Non-US region: two hosted control planes plus confidential vCPU-hours in West Europe.
      expected: async () => aksAuto({ region: 'westeurope', currency: 'USD', vcpus: 5, computeType: 'confidential', clusters: 2, clusterHours: 500, hours: 500 }),
    },
    {
      name: 'general purpose EUR', region: 'eastus2', currency: 'EUR',
      component: { type: 'aks-automatic', vcpus: 3, computeType: 'general-purpose', clusters: 1, hours: 100, clusterHours: 100 },
      // EUR is sourced from Retail API currencyCode; calculator data is USD-only.
      expected: async () => aksAuto({ region: 'eastus2', currency: 'EUR', vcpus: 3, computeType: 'general-purpose', clusters: 1, hours: 100, clusterHours: 100 }),
    },
  ],
};
