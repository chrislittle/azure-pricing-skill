'use strict';
// Azure Container Apps: Dedicated plan workload profiles (incl. GPU), plan management fee, Consumption GPU and Dynamic Sessions.
// Meters (serviceName 'Azure Container Apps'): Dedicated vCPU/Memory/GPU Usage and Plan Management (per hour),
// Environment Private Endpoint / Planned Maintenance Hour (per hour), Dynamic Sessions (per session-hour),
// Standard NC T4 v3 / NC A100 v4 GPU Usage and Standard vCPU/Memory Active Usage (per second).
const { rows, single, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS } = require('../kit');

const PROFILES = {
  d4: { label: 'D4', vcpu: 4, mem: 16, gpu: 0 }, d8: { label: 'D8', vcpu: 8, mem: 32, gpu: 0 },
  d16: { label: 'D16', vcpu: 16, mem: 64, gpu: 0 }, d32: { label: 'D32', vcpu: 32, mem: 128, gpu: 0 },
  e4: { label: 'E4', vcpu: 4, mem: 32, gpu: 0 }, e8: { label: 'E8', vcpu: 8, mem: 64, gpu: 0 },
  e16: { label: 'E16', vcpu: 16, mem: 128, gpu: 0 }, e32: { label: 'E32', vcpu: 32, mem: 256, gpu: 0 },
  'nc24-a100': { label: 'NC24-A100', vcpu: 24, mem: 220, gpu: 1 },
  'nc48-a100': { label: 'NC48-A100', vcpu: 48, mem: 440, gpu: 2 },
  'nc96-a100': { label: 'NC96-A100', vcpu: 96, mem: 880, gpu: 4 }
};
const SERVERLESS_GPU = {
  t4: { label: 'NC8as-T4', meter: 'Standard NC T4 v3 GPU Usage', vcpu: 8, mem: 56 },
  a100: { label: 'NC24-A100', meter: 'Standard NC A100 v4 GPU Usage', vcpu: 24, mem: 220 }
};
const COMMIT = { sp1y: '1 Year', sp3y: '3 Years' };
const n = v => Number(v || 0);

module.exports = {
  type: 'container-apps-dedicated',
  label: 'Azure Container Apps (Dedicated plan, GPU and Dynamic Sessions)',
  family: 'containers',
  calculator: ['container-apps'],
  keywords: ['container apps dedicated', 'workload profile', 'dedicated plan', 'container apps gpu', 'serverless gpu', 'dynamic sessions', 'code interpreter sessions', 'container apps environment', 'containers'],
  fields: {
    instances: { req: true, ask: 'Container Apps Dedicated plan reserves whole servers (workload profile instances). How many instances do you need running? Use 0 if you only need serverless GPU or Dynamic Sessions.' },
    profile: { def: 'd4', enum: Object.keys(PROFILES), ask: 'What does each instance need? Ask for vCPU, memory and GPU, not names. Balanced: 4 vCPU/16 GB d4, 8/32 d8, 16/64 d16, 32/128 d32. Memory-heavy: 4/32 e4, 8/64 e8, 16/128 e16, 32/256 e32. GPU (A100): 1 GPU nc24-a100, 2 GPUs nc48-a100, 4 GPUs nc96-a100 (needs a support request for capacity). Use the lowercase value. Default d4.' },
    hours: { def: HOURS, ask: 'Hours a month each instance runs (730 = all month).' },
    environments: { def: 1, int: true, min: 0, ask: 'How many Container Apps environments use the Dedicated plan? The plan management fee is charged per environment. Default 1.' },
    planManagement: { def: true, ask: 'Do not ask unless the customer says it is waived: the Dedicated plan management fee is mandatory whenever the environment has a Dedicated profile. Default true.' },
    privateEndpoint: { def: false, ask: 'Do the environments use a private endpoint? It adds an hourly fee per environment. Default no.' },
    plannedMaintenance: { def: false, ask: 'Do the environments use planned maintenance windows? It adds an hourly fee per environment. Default no.' },
    commitment: { def: 'payg', enum: ['payg', 'sp1y', 'sp3y'], ask: 'Pay-as-you-go, or compare a 1- or 3-year Azure savings plan for the instance compute? Only worth it if the instances run all month for a year or more.' },
    consumptionGpu: { def: 'none', enum: ['none', 't4', 'a100'], ask: 'Do you also need serverless (Consumption) GPU, paid by the second only while running? none, t4 (NC8as-T4) or a100 (NC24-A100). Default none.' },
    gpuReplicas: { def: 1, int: true, min: 0, ask: 'How many serverless GPU replicas run at the same time? Default 1.' },
    gpuHours: { def: 100, ask: 'Hours a month each serverless GPU replica is active (billed per second, no idle charge). Default 100.' },
    sessionHours: { def: 0, ask: 'Dynamic Sessions (sandboxes for AI code interpreters): total session-hours a month across all sessions. Billed per session-hour in 1-hour increments. Default 0.' }
  },
  context: ['production', 'steadyUsage', 'idlePeriods'],
  examples: [
    { type: 'container-apps-dedicated', instances: 2, profile: 'd8' },
    { type: 'container-apps-dedicated', instances: 1, profile: 'nc24-a100', hours: 300, privateEndpoint: true, plannedMaintenance: true, commitment: 'sp1y' },
    { type: 'container-apps-dedicated', instances: 0, consumptionGpu: 't4', gpuReplicas: 2, gpuHours: 120, sessionHours: 2000, planManagement: false }
  ],
  readback: c => {
    const p = PROFILES[c.profile || 'd4'];
    const parts = [];
    if (n(c.instances)) parts.push(`${fmtN(c.instances)} x ${p ? p.label : c.profile} Dedicated instance(s) running ${(c.hours ?? HOURS) === HOURS ? 'all month' : `${fmtN(c.hours)} hours a month`}`);
    if ((c.consumptionGpu || 'none') !== 'none') parts.push(`${fmtN(c.gpuReplicas ?? 1)} serverless ${(SERVERLESS_GPU[c.consumptionGpu] || {}).label || c.consumptionGpu} GPU replica(s) for ${fmtN(c.gpuHours ?? 100)} hours`);
    if (n(c.sessionHours)) parts.push(`${fmtN(c.sessionHours)} Dynamic Sessions hours`);
    const extra = [];
    if (n(c.instances) && c.planManagement !== false) extra.push('plan management fee');
    if (c.privateEndpoint) extra.push('private endpoint');
    if (c.plannedMaintenance) extra.push('planned maintenance');
    const cm = ({ sp1y: '1-year savings plan', sp3y: '3-year savings plan' })[c.commitment];
    return `Container Apps: ${parts.length ? parts.join('; ') : 'no dedicated, GPU or session usage yet'}${n(c.environments ?? 1) > 1 ? `, ${fmtN(c.environments)} environments` : ''}${extra.length ? `, with ${extra.join(', ')}` : ''}${cm ? `, ${cm} on instance compute (billed all month)` : ''}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Consumption-plan app usage (vCPU/memory seconds, requests) and its monthly free grants: add a container-apps component for those',
    'Container registry, Log Analytics, virtual network and egress data transfer',
    'Custom-container Dynamic Sessions run on dedicated E16 instances: price those with an e16 profile here',
    'Not priced: the Environment Management Hour meter (new in September 2026, purpose not documented), Hybrid (Arc-enabled) vCPU usage, the Flexible workload profile (preview) and confidential DC profiles (UAE North only)'
  ]),
  price: async (c, ctx) => {
    const instances = n(c.instances), hours = c.hours ?? HOURS, envs = c.environments ?? 1;
    const commit = c.commitment || 'payg', cg = c.consumptionGpu || 'none';
    const gpuReplicas = c.gpuReplicas ?? 1, gpuHours = c.gpuHours ?? 100, sessionHours = n(c.sessionHours);
    const prof = PROFILES[c.profile || 'd4'];
    if (!prof) throw new PricingError(`Unknown profile "${c.profile}". Use ${Object.keys(PROFILES).join(', ')}.`);
    if (instances < 0 || hours < 0 || hours > 744 || envs < 0 || gpuReplicas < 0 || gpuHours < 0 || gpuHours > 744 || sessionHours < 0) throw new PricingError('Quantities cannot be negative and hours cannot exceed 744 a month.');
    if (commit !== 'payg' && !COMMIT[commit]) throw new PricingError(`Unknown commitment "${commit}". Use payg, sp1y or sp3y.`);
    if (!SERVERLESS_GPU[cg] && cg !== 'none') throw new PricingError(`Unknown consumptionGpu "${cg}". Use none, t4 or a100.`);
    const rs = await rows(`serviceName eq 'Azure Container Apps' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Container Apps is not priced in ${ctx.region}.`);
    const G = 'Containers', S = 'Azure Container Apps';
    const by = (name, serverless) => {
      const m = rs.filter(r => r.meterName === name);
      if (!m.length) throw new PricingError(serverless ? `Serverless GPU (${name.replace(' GPU Usage', '').replace('Standard ', '')}) is not offered in ${ctx.region}; choose another region or another GPU type.` : /GPU/.test(name) ? `GPU workload profiles are not offered in ${ctx.region} (Dedicated GPU capacity also needs a support request); choose another region.` : `${name} is not priced in ${ctx.region}.`);
      return single(m, name);
    };
    const notes = new Set();
    const lines = [];
    const facts = { profile: c.profile || 'd4', instances, vcpus: instances * prof.vcpu, gpu: false, commitment: commit, hours, environments: envs, privateEndpoint: !!c.privateEndpoint, envFeature: !!(c.privateEndpoint || c.plannedMaintenance), dedicatedGpu: !!prof.gpu && instances > 0, consumptionGpu: cg, serverlessGpu: cg !== 'none', sessionHours };

    // Dedicated compute: GPU profiles bill the GPU meter instead of vCPU and memory.
    const compute = (meter, qty, desc, unit) => {
      const m = by(meter);
      if (commit === 'payg') return meterLine(G, S, desc, m, qty * hours, ctx, { unit: 'hours', per: `${fmtN(qty)} ${unit} x ${fmtN(hours)} hours` });
      const sp = (m[0].savingsPlan || []).find(x => x.term === COMMIT[commit]);
      if (!sp) throw new PricingError(`No ${COMMIT[commit]} savings plan rate for ${meter} in ${ctx.region}.`);
      notes.add(`${COMMIT[commit]} savings plan: the committed hourly rate is billed for every hour of the month, whether or not the instances run. It is applied here to the instance compute only.`);
      if (hours < HOURS) { const pg = qty * hours * m[0].retailPrice; notes.add(`A savings plan bills every hour of the month, so ${desc.split(',')[0]} is priced for 730 hours instead of your ${fmtN(hours)}; pay-as-you-go for ${fmtN(hours)} hours would cost about ${pg.toFixed(2)} for that line.`); }
      return line(G, S, `${desc}, ${COMMIT[commit]} savings plan rate`, qty * HOURS, 'hours', sp.unitPrice, sp.unitPrice * qty * HOURS, meterInfo(m[0]));
    };
    if (instances > 0) {
      if (prof.gpu) {
        facts.gpu = true;
        lines.push(compute('Dedicated GPU Usage', instances * prof.gpu, `Dedicated ${prof.label} GPU, ${fmtN(instances)} instance(s) x ${fmtN(prof.gpu)} GPU`, 'GPU'));
        notes.add('GPU workload profiles bill the GPU meter only; the Dedicated vCPU and memory prices do not apply to them.');
      } else {
        lines.push(compute('Dedicated vCPU Usage', instances * prof.vcpu, `Dedicated ${prof.label} vCPUs, ${fmtN(instances)} x ${fmtN(prof.vcpu)} vCPU`, 'vCPU'));
        lines.push(compute('Dedicated Memory Usage', instances * prof.mem, `Dedicated ${prof.label} memory, ${fmtN(instances)} x ${fmtN(prof.mem)} GiB`, 'GiB'));
      }
    }
    if (c.planManagement !== false && envs > 0 && instances > 0) {
      lines.push(meterLine(G, S, `Dedicated plan management, ${fmtN(envs)} environment(s)`, by('Dedicated Plan Management'), envs * HOURS, ctx, { unit: 'hours' }));
      notes.add('The Dedicated plan management fee is charged per environment for every hour the environment has a Dedicated workload profile, in addition to instance compute. Private endpoints and planned maintenance are separate hourly charges per environment.');
    }
    if (c.privateEndpoint && envs > 0) lines.push(meterLine(G, S, `Environment private endpoint, ${fmtN(envs)} environment(s)`, by('Environment Private Endpoint'), envs * HOURS, ctx, { unit: 'hours' }));
    if (c.plannedMaintenance && envs > 0) lines.push(meterLine(G, S, `Environment planned maintenance, ${fmtN(envs)} environment(s)`, by('Environment Planned Maintenance Hour'), envs * HOURS, ctx, { unit: 'hours' }));
    if (cg !== 'none') {
      const sg = SERVERLESS_GPU[cg];
      const secs = gpuReplicas * gpuHours * 3600;
      facts.gpu = true;
      lines.push(meterLine(G, S, `Serverless ${sg.label} GPU, ${fmtN(gpuReplicas)} replica(s) x ${fmtN(gpuHours)} hours`, by(sg.meter, true), secs, ctx, { unit: 'seconds' }));
      lines.push(meterLine(G, S, `Serverless GPU replicas vCPU, ${fmtN(gpuReplicas)} x ${fmtN(sg.vcpu)} vCPU x ${fmtN(gpuHours)} hours`, by('Standard vCPU Active Usage'), secs * sg.vcpu, ctx, { unit: 'vCPU-seconds' }));
      lines.push(meterLine(G, S, `Serverless GPU replicas memory, ${fmtN(gpuReplicas)} x ${fmtN(sg.mem)} GiB x ${fmtN(gpuHours)} hours`, by('Standard Memory Active Usage'), secs * sg.mem, ctx, { unit: 'GiB-seconds' }));
      notes.add(`Serverless GPU is billed per second while a replica is active, on top of the active vCPU and memory of the ${sg.label} profile (${fmtN(sg.vcpu)} vCPU / ${fmtN(sg.mem)} GiB, the whole profile is assumed). There is no idle charge. The monthly free grants (180,000 vCPU-seconds and 360,000 GiB-seconds per subscription) are not subtracted here.`);
    }
    if (sessionHours > 0) {
      lines.push(meterLine(G, S, `Dynamic Sessions, ${fmtN(sessionHours)} session-hours`, by('Dynamic Sessions'), sessionHours, ctx, { unit: 'session-hours' }));
      notes.add('Dynamic Sessions (code interpreter) are billed per session-hour in 1-hour increments.');
    }
    if (!lines.length) throw new PricingError('Nothing to price: set instances, consumptionGpu or sessionHours.');
    return { lines, notes: [...notes], facts };
  }
};
