'use strict';
// App Service Environment v3 (Isolated v2 and Isolated v4 plans, including memory-optimized sizes) and the
// dedicated-host deployment. Meters: serviceName 'Azure App Service'; products
// 'Azure App Service Isolated v2 Plan' / 'Isolated v4 Plan' (Windows) and the same with ' - Linux'.
// Legacy ASE v1/v2 meters ('Isolated Plan' I1-I3, I12-I14, Stamp Fee, Front End) are retired (August 2024) and deliberately not priced.
// Instance meters are per instance-hour. The ASIP meter is the per-vCPU rate used on dedicated hosts; IDH v2 is the host.
const { rows, single, regionFilter, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

// vCPU / GiB memory per instance (Microsoft Learn and the pricing page agree).
const SIZES = {
  i1v2: [2, 8], i1mv2: [2, 16], i2v2: [4, 16], i2mv2: [4, 32], i3v2: [8, 32], i3mv2: [8, 64],
  i4v2: [16, 64], i4mv2: [16, 128], i5v2: [32, 128], i5mv2: [32, 256], i6v2: [64, 256],
  i1v4: [2, 8], i1mv4: [2, 16], i2v4: [4, 16], i2mv4: [4, 32], i3v4: [8, 32], i3mv4: [8, 64],
  i4v4: [16, 64], i4mv4: [16, 128], i5v4: [32, 128], i5mv4: [32, 256], i6v4: [64, 256]
};
const HOST_SIZES = ['i1v2', 'i2v2', 'i3v2'];
const HOST_VCPUS = 128;
const NO_HOST_REGIONS = ['australiacentral2', 'westindia'];
const COMMIT = { ri1y: ['1 Year', 'reservation'], ri3y: ['3 Years', 'reservation'], sp1y: ['1 Year', 'savings plan'], sp3y: ['3 Years', 'savings plan'] };

const plan = size => size.replace(/^i(\d)(m?)v(\d)$/, (_, n, m, v) => `I${n}${m}v${v}`);
const planFilter = (size, os) => {
  const gen = size.endsWith('v4') ? 'v4' : 'v2';
  const sku = gen === 'v4' ? plan(size) : size.replace(/^i(\d)(m?)v2$/, (_, n, m) => (m ? `I${n}mv2` : `I${n} v2`));
  return `productName eq 'Azure App Service Isolated ${gen} Plan${os === 'linux' ? ' - Linux' : ''}' and skuName eq '${sku}'`;
};

module.exports = {
  type: 'app-service-environment',
  label: 'App Service Environment (isolated App Service plans)',
  family: 'web-other',
  calculator: ['app-service'],
  keywords: ['app service environment', 'ase', 'ase v3', 'isolated', 'isolated v2', 'isolated web apps', 'dedicated app service', 'network isolation'],
  fields: {
    size: { def: 'i1v2', enum: Object.keys(SIZES), ask: 'How big is each instance (server) that runs your apps? Map vCPU and memory to a size: 2 vCPU 8 GB -> i1v2; 2 vCPU 16 GB -> i1mv2; 4 vCPU 16 GB -> i2v2; 4 vCPU 32 GB -> i2mv2; 8 vCPU 32 GB -> i3v2; 8 vCPU 64 GB -> i3mv2; 16 vCPU 64 GB -> i4v2; 16 vCPU 128 GB -> i4mv2; 32 vCPU 128 GB -> i5v2; 32 vCPU 256 GB -> i5mv2; 64 vCPU 256 GB -> i6v2. Same names ending in v4 are the newer Isolated v4 generation (i6v4 and no i6mv4 exist). If unknown, suggest i1v2 and record it as an assumption.' },
    instances: { req: true, ask: 'How many instances (servers) will the environment run in total for this size? One App Service plan holds up to 100 instances and one environment up to 200. Use 0 if the environment will be empty (it is still charged).' },
    os: { def: 'windows', enum: ['windows', 'linux'], ask: 'Do the apps run on Windows or on Linux (including Linux containers)? Default windows.' },
    deployment: { def: 'standard', enum: ['standard', 'dedicated-host'], ask: 'Is it a normal environment (standard), or must it run on dedicated physical hardware used by nobody else, for strict compliance (dedicated-host)? Dedicated hosts exist only in a few regions and only sizes i1v2, i2v2, i3v2. If unknown, suggest standard.' },
    dedicatedHosts: { def: 2, int: true, min: 0, max: 2, ask: 'Dedicated host only: every environment has two hosts (use 2). With several plan components in one environment, use 2 on one and 0 on the others so the hosts are billed once.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Pay-as-you-go, or compare a 1- or 3-year commitment (ri1y/ri3y = reservation, sp1y/sp3y = savings plan)? Only worth it if the instances run all month for a year or more.' },
    hours: { def: 730, ask: 'Hours a month the instances run (730 = all month). Pay-as-you-go only; reservations and savings plans bill every hour. On dedicated hosts the hosts use the same hours.' }
  },
  context: ['production', 'steadyUsage', 'zoneResilience'],
  examples: [
    { type: 'app-service-environment', size: 'i1v2', instances: 2 },
    { type: 'app-service-environment', size: 'i3mv2', instances: 4, os: 'linux', commitment: 'ri1y' },
    { type: 'app-service-environment', size: 'i2v2', instances: 6, os: 'windows', deployment: 'dedicated-host', dedicatedHosts: 2, hours: 730 },
    { type: 'app-service-environment', size: 'i1v4', instances: 0 }
  ],
  readback: c => {
    const size = c.size || 'i1v2';
    const spec = SIZES[size];
    const n = c.instances ?? 0;
    const hours = c.hours ?? HOURS;
    const commit = n > 0 && c.commitment && c.commitment !== 'payg' ? `, ${({ ri1y: '1-year reservation', ri3y: '3-year reservation', sp1y: '1-year savings plan', sp3y: '3-year savings plan' })[c.commitment]}` : `, ${hours === HOURS ? 'running all month' : `${fmtN(hours)} hours a month`}`;
    const host = c.deployment === 'dedicated-host' ? `, on ${fmtN(c.dedicatedHosts ?? 2)} dedicated host(s)` : '';
    return `App Service Environment: ${n === 0 ? 'empty environment, charged as one Windows I1v2 instance' : `${fmtN(n)} instance(s) of size ${size}`}${spec && n > 0 ? ` (${fmtN(spec[0])} vCPU, ${fmtN(spec[1])} GB memory each)` : ''}, ${c.os === 'linux' ? 'Linux' : 'Windows'}${host}${commit}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).some(x => /network|gateway|firewall/i.test(x)) ? [] : ['Virtual network, private DNS, and an Application Gateway or Front Door in front of the environment', 'Outbound internet data transfer', 'App Service certificates and custom domains','Dependencies such as databases, storage, Key Vault and monitoring'],
  price: async (c, ctx) => {
    const size = c.size || 'i1v2';
    const dims = SIZES[size];
    if (!dims) throw new PricingError(`Unknown size "${size}". Use one of ${Object.keys(SIZES).join(', ')}.`);
    const os = c.os || 'windows';
    if (!['windows', 'linux'].includes(os)) throw new PricingError('os must be windows or linux.');
    const deployment = c.deployment || 'standard';
    const commit = c.commitment || 'payg';
    if (commit !== 'payg' && !COMMIT[commit]) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y, ri3y, sp1y or sp3y.`);
    const n = c.instances ?? 0, hours = c.hours ?? HOURS;
    if (n < 0) throw new PricingError('instances cannot be negative.');
    if (n > 100) throw new PricingError('One App Service plan in an App Service Environment supports up to 100 instances; split the instances into several plan components (the environment total is 200).');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const vcpus = n * dims[0];
    const G = 'Web', S = 'Azure App Service';
    const get = async (productSku, what) => {
      const rs = await rows(`serviceName eq '${S}' and ${regionFilter(ctx)} and ${productSku}`, ctx);
      if (!rs.length) throw new PricingError(`${what} is not priced in ${ctx.region}. App Service Environment (and its ${size.endsWith('v4') ? 'Isolated v4 plans' : 'plans'}) is not offered in every region.`);
      return rs;
    };
    // Price `qty` units of one meter under the chosen commitment; whole-term reservation price / term months.
    const priced = (rs, what, qtyUnits, desc, unit, notes, facts) => {
      const cons = single(rs.filter(r => r.type === 'Consumption'), what);
      if (commit === 'payg') return line(G, S, desc, qtyUnits * hours, 'hours', cons[0].retailPrice, cons[0].retailPrice * qtyUnits * hours, meterInfo(cons[0]), { per: `${fmtN(qtyUnits)} x ${fmtN(hours)} hours` });
      const [term, kind] = COMMIT[commit];
      if (hours < HOURS) facts.commitmentUnderused = true;
      if (kind === 'reservation') {
        const rr = rs.find(r => r.type === 'Reservation' && r.reservationTerm === term);
        if (!rr) throw new PricingError(`No ${term} reservation price for ${what} in ${ctx.region}.`);
        const months = termMonths(term);
        notes.add(`${term} reservation: the listed reservation price is for the whole term per ${unit}; it is divided by ${months} months here and billed whether or not the instance runs.`);
        return line(G, S, `${desc}, ${term} reservation`, qtyUnits, `${unit} / month`, rr.retailPrice / months, rr.retailPrice / months * qtyUnits, meterInfo(rr), { termTotal: rr.retailPrice });
      }
      const sp = (cons[0].savingsPlan || []).find(x => x.term === term);
      if (!sp) throw new PricingError(`No ${term} savings plan rate for ${what} in ${ctx.region}.`);
      notes.add(`${term} savings plan: the committed hourly rate is billed for every hour of the month, whether or not the instances run.`);
      return line(G, S, `${desc}, ${term} savings plan rate`, qtyUnits * HOURS, 'hours', sp.unitPrice, sp.unitPrice * qtyUnits * HOURS, meterInfo(cons[0]));
    };
    const noteSet = new Set();
    const notes = { add: t => noteSet.add(t) };
    const facts = { size, instances: n, vcpus, os, deployment, commitment: commit, hours, empty: false, dedicatedHosts: 0, generation: size.endsWith('v4') ? 'v4' : 'v2' };
    const lines = [];
    const osLabel = os === 'linux' ? 'Linux' : 'Windows';
    if (deployment === 'dedicated-host') {
      if (!HOST_SIZES.includes(size)) throw new PricingError('Only sizes i1v2, i2v2 and i3v2 are available in an App Service Environment on dedicated hosts.');
      if (vcpus > HOST_VCPUS) throw new PricingError(`A dedicated host environment has ${HOST_VCPUS} vCPUs in total; ${fmtN(n)} x ${size} needs ${fmtN(vcpus)}.`);
      const hosts = c.dedicatedHosts ?? 2;
      if (hosts < 0) throw new PricingError('dedicatedHosts cannot be negative.');
      facts.dedicatedHosts = hosts;
      if (hosts) {
        const idh = await get(`productName eq 'Azure App Service Isolated v2 Plan' and skuName eq 'IDH v2'`, 'Isolated dedicated host (IDH v2)');
        lines.push(priced(idh, 'Isolated dedicated host', hosts, `Dedicated hosts (IDH v2), ${fmtN(hosts)} host(s)`, 'host', notes, facts));
      }
      if (vcpus) {
        const asip = await get(`productName eq 'Azure App Service Isolated v2 Plan${os === 'linux' ? ' - Linux' : ''}' and skuName eq 'ASIP'`, `Isolated v2 per-vCPU rate (${osLabel})`);
        lines.push(priced(asip, `Isolated v2 per-vCPU rate (${osLabel})`, vcpus, `${osLabel} Isolated v2 plan rate on dedicated hosts, ${fmtN(n)} x ${size} = ${fmtN(vcpus)} vCPU`, 'vCPU', notes, facts));
      }
      if (NO_HOST_REGIONS.includes(ctx.region)) notes.add('Microsoft lists no support for dedicated host deployments in this region, so check availability before relying on this price.');
      notes.add(`On dedicated hosts you pay for the hosts (two are created with the environment) plus a per-vCPU rate for each instance; the environment has ${HOST_VCPUS} vCPUs in total. Dedicated host deployments are not zone redundant and exist in only a few regions.`);
    } else if (n === 0) {
      facts.empty = true;
      const i1 = await get(`productName eq 'Azure App Service Isolated v2 Plan' and skuName eq 'I1 v2'`, 'Isolated v2 I1v2 (Windows)');
      const cons = single(i1.filter(r => r.type === 'Consumption'), 'Windows I1v2');
      lines.push(line(G, S, `Empty environment: charged as one Windows I1v2 instance, ${fmtN(hours)} hours`, hours, 'hours', cons[0].retailPrice, cons[0].retailPrice * hours, meterInfo(cons[0])));
      notes.add('An App Service Environment with no instances is charged as one Windows I1v2 instance. The charge stops once you deploy instances.');
      if (commit !== 'payg') notes.add('A reservation or savings plan does not apply to an empty environment, so it is priced pay-as-you-go.');
    } else {
      const rs = await get(planFilter(size, os), `${osLabel} ${size}`);
      lines.push(priced(rs, `${osLabel} ${size}`, n, `${osLabel} ${plan(size)} instances, ${fmtN(n)} x ${fmtN(dims[0])} vCPU / ${fmtN(dims[1])} GB`, 'instance', notes, facts));
    }
    if (deployment !== 'dedicated-host') notes.add('Zone redundancy on App Service Environment v3 has no added charge; you pay per instance.');
    notes.add('Apps inside the environment add no per-app charge: you pay for the instances of the plans, and an environment holds up to 200 instances in total (100 per plan).');
    if (facts.generation === 'v4') notes.add('Isolated v4 is the newer generation; check that it is offered in your region before choosing it.');
    return { lines, notes: [...noteSet], facts };
  }
};
