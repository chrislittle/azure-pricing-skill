'use strict';
// Azure Container Instances: per-second vCPU and memory for Linux/Windows containers, Spot and confidential
// containers. GPU containers are not offered: Microsoft retired that product on 2025-07-14.
// Meters: serviceName 'Container Instances', regional. vCPU in hours, memory in GB-hours, Windows licence per second.
// The pricing page bills vCPU rounded up to a whole number and memory rounded up to the nearest 0.1 GB.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const VARIANTS = {
  standard: { sku: 'Standard', cpu: 'Standard vCPU Duration', mem: 'Standard Memory Duration', label: 'standard' },
  spot: { sku: 'Standard Spot', cpu: 'Standard Spot vCPU Duration', mem: 'Standard Spot Memory Duration', label: 'Spot (can be evicted)' },
  confidential: { sku: 'Confidential containers ACI', cpu: 'Confidential containers ACI vCPU Duration', mem: 'Confidential containers ACI Memory Duration', label: 'confidential' }
};
const COMMIT = { payg: null, 'savings-1y': '1 Year', 'savings-3y': '3 Years' };
const billedVcpu = v => Math.ceil(n(v) - 1e-9);
const billedMem = m => Math.ceil(n(m) * 10 - 1e-9) / 10;

// Same meter rows with the Savings Plan rate swapped in as the price.
function withPlan(rs, term, what) {
  return rs.map(r => {
    const sp = (r.savingsPlan || []).find(s => s.term === term);
    if (!sp) throw new PricingError(`No ${term} savings plan price for ${what}.`);
    return Object.assign({}, r, { retailPrice: sp.retailPrice });
  });
}

module.exports = {
  type: 'container-instances',
  label: 'Azure Container Instances',
  family: 'compute-other',
  calculator: ['container-instances'],
  keywords: ['containers', 'container instances', 'docker', 'serverless containers', 'aci', 'run a container', 'spot containers', 'batch containers'],
  fields: {
    vcpu: { req: true, min: 0, ask: 'How many vCPUs does ONE container group need in total (all its containers added together)? Azure bills whole vCPUs, so a fraction is rounded up (1.3 becomes 2). If unknown, suggest 1 and record it as an assumption.' },
    memoryGb: { req: true, min: 1, ask: 'How many GB of memory does ONE container group need in total? Minimum 1 GB and at most 7 GB per vCPU; memory is billed rounded up to the next 0.1 GB. If unknown, suggest 1.5 GB per vCPU and record it as an assumption.' },
    containerGroups: { def: 1, int: true, min: 1, ask: 'How many container groups (sets of containers that start and stop together, each with the size above) run at the same time, or are different workloads? Do NOT multiply by how often a job runs: put that in hours. If unknown, use 1.' },
    hours: { def: 730, ask: 'In total, how many hours a month does EACH container group run? Add up every run (730 = all month; a 20-minute job every night is about 10 hours). ACI bills per second only while a group runs, so this is not multiplied by anything else.' },
    os: { def: 'linux', enum: ['linux', 'windows'], ask: 'Do the containers run Linux or Windows? Windows adds a per-vCPU licence charge. Answer linux or windows; if unknown use linux.' },
    variant: { def: 'standard', enum: Object.keys(VARIANTS), ask: 'What kind of container? Ordinary -> standard. Cheaper but Azure can stop it at any time (batch or test work, not production) -> spot. Data must stay protected while in use by hardware (confidential computing) -> confidential. If unknown use standard.' },
    commitment: { def: 'payg', enum: Object.keys(COMMIT), ask: 'Will they commit to a steady hourly spend for a discount? No -> payg; 1 year -> savings-1y; 3 years -> savings-3y. Only for standard and confidential containers on a steady workload (not Spot). If unknown use payg.' }
  },
  context: ['production', 'interruptible', 'steadyUsage'],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Container registry to hold the images (Azure Container Registry).',
    'Outbound data transfer (bandwidth), public IP addresses and virtual network / NAT gateway costs.',
    'Storage the containers mount (Azure Files volumes, disks) and log/monitoring costs.',
    'GPU containers: Microsoft retired Azure Container Instances GPU resources on 14 July 2025, so they are not priced; use Azure Container Apps serverless GPU or AKS GPU node pools instead.'
  ]),
  examples: [
    { type: 'container-instances', vcpu: 1, memoryGb: 1.5 },
    { type: 'container-instances', containerGroups: 3, vcpu: 2, memoryGb: 4, hours: 200, os: 'windows', commitment: 'savings-1y' },
    { type: 'container-instances', variant: 'spot', containerGroups: 10, vcpu: 4, memoryGb: 8, hours: 100 },
    { type: 'container-instances', variant: 'spot', os: 'windows', containerGroups: 2, vcpu: 2, memoryGb: 4, hours: 50 },
    { type: 'container-instances', variant: 'confidential', containerGroups: 2, vcpu: 2, memoryGb: 4, hours: 300, commitment: 'savings-3y' }
  ],
  readback: c => {
    const v = VARIANTS[c.variant || 'standard'] || VARIANTS.standard;
    const hrs = c.hours ?? HOURS;
    const os = (c.os || 'linux') === 'windows' ? 'Windows' : 'Linux';
    const cm = COMMIT[c.commitment || 'payg'] ? `, ${COMMIT[c.commitment].toLowerCase().replace(/^(\d+) years?$/, '$1-year')} savings plan` : ', pay as you go';
    const rv = billedVcpu(c.vcpu), rm = billedMem(c.memoryGb);
    const rounded = rv !== n(c.vcpu) || rm !== n(c.memoryGb) ? ` (billed as ${fmtN(rv)} vCPU and ${fmtN(rm)} GB after rounding up)` : '';
    return `Container Instances (${v.label}, ${os}): ${fmtN(c.containerGroups ?? 1)} container group(s), each ${fmtN(n(c.vcpu))} vCPU and ${fmtN(n(c.memoryGb))} GB memory${rounded}, each running ${hrs === HOURS ? 'all month (730 hours in total)' : `${fmtN(hrs)} hours in total per month`}${cm}`;
  },
  price: async (c, ctx) => {
    const variant = c.variant || 'standard';
    const v = VARIANTS[variant];
    if (!v) throw new PricingError(`Unknown variant "${variant}". Use one of: ${Object.keys(VARIANTS).join(', ')}. GPU containers are retired and not priced.`);
    const os = (c.os || 'linux').toLowerCase();
    if (!['linux', 'windows'].includes(os)) throw new PricingError('os must be "linux" or "windows".');
    if (os === 'windows' && variant === 'confidential') throw new PricingError('Windows containers are not supported for confidential containers.');
    const commitment = c.commitment || 'payg';
    if (!(commitment in COMMIT)) throw new PricingError(`Unknown commitment "${commitment}". Use payg, savings-1y or savings-3y.`);
    if (commitment !== 'payg' && variant === 'spot') throw new PricingError('Savings plans do not apply to Spot containers.');
    const groups = c.containerGroups ?? 1, hours = c.hours ?? HOURS;
    if (!Number.isInteger(groups) || groups < 1) throw new PricingError('containerGroups must be a whole number of at least 1.');
    if (!(n(c.vcpu) > 0)) throw new PricingError('vcpu must be greater than 0.');
    if (!(n(c.memoryGb) >= 1)) throw new PricingError('memoryGb must be at least 1 GB per container group.');
    const vcpu = billedVcpu(c.vcpu), mem = billedMem(c.memoryGb);
    if (mem > vcpu * 7) throw new PricingError(`A container group can have at most 7 GB of memory per vCPU: ${fmtN(vcpu)} vCPU allows up to ${fmtN(vcpu * 7)} GB.`);
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    // Filter by SKU in the query so SKUs that share a meterId cannot collapse after de-duplication.
    const skus = [...new Set([v.sku, ...(os === 'windows' ? ['Standard'] : [])])];
    const rs = await rows(`serviceName eq 'Container Instances' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Container Instances' and (${skus.map(s => `skuName eq '${s}'`).join(' or ')})`, ctx);
    const pick = (sku, meter, what) => {
      const m = rs.filter(r => r.skuName === sku && r.meterName === meter);
      if (!m.length) throw new PricingError(`Container Instances ${what} is not priced in ${ctx.region}.`);
      return single(m, `Container Instances ${what}`);
    };
    const term = COMMIT[commitment];
    const plan = (m, what) => term ? withPlan(m, term, what) : m;
    const G = 'Compute', S = 'Container Instances', lines = [];
    const gh = groups * hours, secs = gh * 3600;
    const tag = term ? `, ${term.toLowerCase()} savings plan` : '';
    const span = `${fmtN(groups)} group(s) x ${fmtN(hours)} hours`;
    const cpuRows = plan(pick(v.sku, v.cpu, `${variant} vCPU`), `${variant} vCPU`);
    const memRows = plan(pick(v.sku, v.mem, `${variant} memory`), `${variant} memory`);
    lines.push(meterLine(G, S, `${v.label} container vCPU: ${fmtN(vcpu)} billed vCPU${vcpu !== n(c.vcpu) ? ` (${fmtN(n(c.vcpu))} rounded up)` : ''} x ${span}${tag}`, cpuRows, vcpu * gh, ctx, { unit: 'vCPU-hours' }));
    lines.push(meterLine(G, S, `${v.label} container memory: ${fmtN(mem)} billed GB${mem !== n(c.memoryGb) ? ` (${fmtN(n(c.memoryGb))} rounded up)` : ''} x ${span}${tag}`, memRows, mem * gh, ctx, { unit: 'GB-hours' }));
    if (os === 'windows') {
      const sw = plan(pick('Standard', 'Standard Windows Software Duration', 'Windows software'), 'Windows software');
      lines.push(meterLine(G, S, `Windows licence: ${fmtN(vcpu)} billed vCPU x ${span}${tag}`, sw, vcpu * secs, ctx, { unit: 'vCPU-seconds' }));
    }
    const notes = ['Container Instances bills per second while a container group runs, for the vCPU and memory it is allocated (not what it uses). vCPU is rounded up to a whole number and memory up to the nearest 0.1 GB per group. A stopped or deleted group costs nothing.'];
    if (os === 'windows') notes.push('Windows containers add a per-vCPU-second licence charge on top of vCPU and memory.');
    if (variant === 'spot') notes.push('Spot containers use spare capacity at a discount and Azure can evict them at any time; they support Linux and Windows. Microsoft describes Spot containers as a preview not recommended for production scenarios.');
    if (term) notes.push(`Savings plan: the ${term.toLowerCase()} savings plan hourly rate is applied to vCPU, memory${os === 'windows' ? ' and Windows licence' : ''}; it assumes steady spend that covers this usage.`);
    return { lines, notes, facts: { variant, os, commitment, containerGroups: groups, vcpu, memoryGb: mem, hours, spot: variant === 'spot' } };
  }
};
