'use strict';
// AKS Automatic. Meters: 'Azure Kubernetes Service - Automatic' product (serviceName 'Azure Kubernetes Service').
// - 'Automatic Hosted Control Plane': per cluster-hour.
// - 'Automatic <category>': per vCPU-hour, charged on top of the price of the virtual machines AKS launches.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');
const vmSizes = require('../../../catalog/vm-sizes.json');

// Regions where AKS Automatic is generally available (Learn, managed system node pools limitations).
const GA_REGIONS = new Set('australiacentral,australiaeast,australiasoutheast,austriaeast,belgiumcentral,brazilsouth,canadacentral,canadaeast,centralindia,centralus,chilecentral,denmarkeast,eastasia,eastus,eastus2,francecentral,germanywestcentral,indonesiacentral,israelcentral,italynorth,japaneast,japanwest,koreacentral,koreasouth,malaysiawest,mexicocentral,newzealandnorth,northcentralus,northeurope,norwayeast,polandcentral,southafricanorth,southcentralus,southeastasia,southindia,spaincentral,swedencentral,switzerlandnorth,uaenorth,uksouth,ukwest,westcentralus,westeurope,westus,westus2,westus3'.split(','));

const n = v => Number(v || 0);
const TYPES = {
  'general-purpose': ['Automatic General Purpose', 'general purpose'],
  'compute-optimized': ['Automatic Compute Optimized', 'compute optimized'],
  'memory-optimized': ['Automatic Memory Optimized', 'memory optimized'],
  'storage-optimized': ['Automatic Storage Optimized', 'storage optimized'],
  'gpu-accelerated': ['Automatic GPU Accelerated', 'GPU accelerated'],
  'high-performance': ['Automatic High Performance Compute', 'high performance compute'],
  confidential: ['Automatic Confidential Compute', 'confidential compute']
};

// All node pools of one component: the main one plus optional extra ones.
function pools(c) {
  const out = [{ computeType: c.computeType || 'general-purpose', vcpus: n(c.vcpus) }];
  for (const p of c.otherPools || []) out.push({ computeType: p.computeType || 'general-purpose', vcpus: p.vcpus == null ? 0 : Number(p.vcpus) });
  return out;
}

module.exports = {
  type: 'aks-automatic',
  label: 'Azure Kubernetes Service (AKS) Automatic',
  family: 'containers',
  calculator: ['kubernetes-service'],
  keywords: ['aks automatic', 'kubernetes', 'managed kubernetes', 'automatic cluster', 'node auto provisioning', 'containers', 'cluster'],
  fields: {
    vcpus: { req: true, ask: 'AKS Automatic starts and scales the worker servers (nodes) for you and charges per vCPU of those servers, on top of the normal VM price. How many vCPUs do the worker nodes have in total on average (workload needs plus some headroom)? Count the vCPUs of the node VMs, not pods and not GPUs: for GPU nodes give the vCPUs of the GPU VM. The system nodes AKS manages are not charged. Then ask which VM size and how many nodes, and price those as Linux vm components too (Windows nodes are not supported). If unknown, suggest 16 vCPUs (for example 4 x D4s_v5) and record it as an assumption.' },
    computeType: { def: 'general-purpose', enum: Object.keys(TYPES), ask: 'What kind of servers do the workloads need? Everyday web apps and APIs -> general-purpose; CPU-heavy -> compute-optimized; in-memory data or caches -> memory-optimized; fast local disks / databases -> storage-optimized; AI or graphics with GPUs -> gpu-accelerated; scientific or HPC -> high-performance; confidential computing -> confidential. Default general-purpose.' },
    otherPools: { def: [], ask: 'Only if they need a second kind of server as well: a list of { "computeType": "...", "vcpus": N } for each extra kind.' },
    clusters: { def: 1, ask: 'How many AKS Automatic clusters? Each cluster has its own hourly management fee. Default 1.' },
    hours: { def: 730, ask: 'Hours a month the vCPUs run on average (730 = all month). A cluster that scales to nothing at night might be about 400.' },
    clusterHours: { def: 730, ask: 'Hours a month each cluster exists (730 = all month).' }
  },
  context: ['production'],
  examples: [
    { type: 'aks-automatic', vcpus: 16 },
    { type: 'aks-automatic', vcpus: 32, computeType: 'memory-optimized', otherPools: [{ computeType: 'gpu-accelerated', vcpus: 24 }, { computeType: 'compute-optimized', vcpus: 8 }], clusters: 2, hours: 500, clusterHours: 730 }
  ],
  readback: c => {
    const ps = pools(c).filter(p => p.vcpus);
    const hours = c.hours ?? HOURS, ch = c.clusterHours ?? HOURS;
    const cl = c.clusters ?? 1;
    const parts = ps.map(p => `${fmtN(p.vcpus)} vCPUs of ${(TYPES[p.computeType] || [, p.computeType])[1]} nodes`);
    return `AKS Automatic: ${fmtN(cl)} cluster(s) managed ${ch === HOURS ? 'all month' : `${fmtN(ch)} hours a month`}${parts.length ? `; ${parts.join(' and ')} running ${hours === HOURS ? 'all month' : `${fmtN(hours)} hours a month`}` : ''}`;
  },
  notIncluded: (types, spec) => {
    const out = [];
    const opts = (spec.options || []).filter(o => (o.components || []).some(c => c.type === 'aks-automatic'));
    let anyVm = false;
    for (const o of opts) {
      const comps = o.components || [];
      const vms = comps.filter(c => c.type === 'vm');
      const want = comps.filter(c => c.type === 'aks-automatic').reduce((a, c) => a + pools(c).reduce((x, p) => x + (Number.isFinite(p.vcpus) ? p.vcpus : 0), 0), 0);
      if (vms.length) anyVm = true;
      if (vms.some(v => String(v.os || 'linux').toLowerCase().startsWith('windows'))) out.push('AKS Automatic does not support Windows nodes: use Linux vm components for the nodes');
      if (vms.some(v => { const os = String(v.os || 'linux').toLowerCase(); return os !== 'linux' && !os.startsWith('windows'); })) out.push('The vm components use an operating system other than plain Linux (RHEL, SLES or similar), which adds license charges AKS Automatic nodes do not use; use os linux for the nodes');
      const have = vms.reduce((a, v) => a + ((vmSizes[v.sku] || {}).v || 0) * (v.count || 1), 0);
      if (vms.length && want && have && Math.abs(have - want) > want * 0.1) out.push(`The vm components total ${fmtN(have)} vCPUs but aks-automatic charges for ${fmtN(want)} vCPUs; make them match`);
    }
    if (!anyVm) out.push('The worker node virtual machines: AKS Automatic charges per vCPU on top of normal VM prices, so add Linux vm components for the node sizes (system node pool VMs are free)');
    out.push('Managed NAT gateway for outbound traffic, load balancers, public IPs and data sent out to the internet', 'Managed disks and monitoring such as Container insights and managed Prometheus');
    return out;
  },
  price: async (c, ctx) => {
    if (c.vcpus == null || !Number.isFinite(Number(c.vcpus))) throw new PricingError('aks-automatic needs "vcpus": the total vCPUs of the worker nodes.');
    const clusters = c.clusters ?? 1, hours = c.hours ?? HOURS, ch = c.clusterHours ?? HOURS;
    if (!(clusters >= 1)) throw new PricingError('clusters must be at least 1.');
    for (const [k, v] of [['hours', hours], ['clusterHours', ch]]) if (v < 0 || v > 744) throw new PricingError(`${k} must be between 0 and 744 (the longest month).`);
    if (c.otherPools != null && !Array.isArray(c.otherPools)) throw new PricingError('otherPools must be a list of { "computeType": "...", "vcpus": N }.');
    (c.otherPools || []).forEach((p, i) => {
      const at = `otherPools[${i}]`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new PricingError(`${at} must be an object like { "computeType": "...", "vcpus": N }.`);
      const bad = Object.keys(p).filter(k => k !== 'computeType' && k !== 'vcpus');
      if (bad.length) throw new PricingError(`${at} has unknown field(s) ${bad.map(k => '"' + k + '"').join(', ')}. Allowed keys: computeType, vcpus.`);
      if (p.vcpus == null) throw new PricingError(`${at} needs "vcpus": the vCPUs of that kind of node.`);
      if (typeof p.vcpus !== 'number') throw new PricingError(`${at}.vcpus must be a number, not text (got ${JSON.stringify(p.vcpus)}).`);
      if (p.computeType != null && typeof p.computeType !== 'string') throw new PricingError(`${at}.computeType must be text: ${Object.keys(TYPES).join(', ')}.`);
    });
    const ps = pools(c);
    for (const p of ps) {
      if (!TYPES[p.computeType]) throw new PricingError(`Unknown computeType "${p.computeType}". Use ${Object.keys(TYPES).join(', ')}.`);
      if (!Number.isFinite(p.vcpus) || p.vcpus < 0) throw new PricingError('vcpus must be a number of 0 or more (for every pool in otherPools too).');
    }
    const rs = await rows(`serviceName eq 'Azure Kubernetes Service' and ${regionFilter(ctx)} and productName eq 'Azure Kubernetes Service - Automatic' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`AKS Automatic is not priced in ${ctx.region}. It is not offered in every region.`);
    const G = 'Containers', S = 'Azure Kubernetes Service';
    const lines = [];
    const cp = single(rs.filter(r => r.meterName === 'Automatic Hosted Control Plane'), 'AKS Automatic hosted control plane');
    lines.push(meterLine(G, S, `AKS Automatic hosted control plane, ${fmtN(clusters)} cluster(s) x ${fmtN(ch)} hours`, cp, clusters * ch, ctx, { unit: 'hours' }));
    // Merge pools of the same category so each meter appears once.
    const byType = {};
    for (const p of ps) if (p.vcpus) byType[p.computeType] = (byType[p.computeType] || 0) + p.vcpus;
    for (const [t, v] of Object.entries(byType)) {
      const m = single(rs.filter(r => r.meterName === TYPES[t][0]), `AKS Automatic ${TYPES[t][1]} vCPUs`);
      lines.push(meterLine(G, S, `AKS Automatic ${TYPES[t][1]} nodes, ${fmtN(v)} vCPUs x ${fmtN(hours)} hours`, m, v * hours, ctx, { unit: 'vCPU-hours' }));
    }
    const notesGA = GA_REGIONS.has(ctx.region) ? [] : [`AKS Automatic is not on Microsoft's list of generally available regions for ${ctx.region}; it is priced here, but check availability before committing.`];
    const totalVcpus = Object.values(byType).reduce((a, b) => a + b, 0);
    const notes = [
      ...notesGA,
      'AKS Automatic charges a hosted control plane fee per cluster-hour and, on top of the virtual machine price, a per-vCPU-hour fee that depends on the kind of servers AKS launches.',
      'AKS Automatic manages the nodes for you (provisioning, scaling, upgrades); the number of vCPUs here is the average you expect it to run.'
    ];
    return { lines, notes, facts: { clusters, vcpus: totalVcpus, hours, clusterHours: ch, computeTypes: Object.keys(byType), gpu: !!byType['gpu-accelerated'] } };
  }
};
