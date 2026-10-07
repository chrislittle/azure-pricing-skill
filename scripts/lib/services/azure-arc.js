'use strict';
// Azure Arc: the charged capabilities that have Retail Prices API meters, other than Extended Security Updates
// (type esu-arc), Update Manager (update-manager) and Azure Policy machine configuration / Kubernetes policy
// (azure-policy). One component = one kind of Arc workload:
//   sql-server           SQL Server enabled by Azure Arc, pay-as-you-go licensing, per core per hour
//   sql-managed-instance SQL Managed Instance enabled by Azure Arc, per vCore per hour (+ reservations)
//   windows-server-payg  Windows Server pay-as-you-go enabled by Azure Arc, per core per hour
//   kubernetes-gitops    Arc-enabled Kubernetes configuration management (GitOps), per vCPU per month
//   essential-machine-management  Essential Machine Management for Arc-enabled servers, per server per hour (free with some entitlements)
// The Arc control plane (connecting and inventorying servers and clusters) has no charge, so it has no meter.
const { rows, single, line, meterLine, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);
const WORKLOADS = ['sql-server', 'sql-managed-instance', 'windows-server-payg', 'kubernetes-gitops', 'essential-machine-management'];
const NAMES = { 'sql-server': 'SQL Server', 'sql-managed-instance': 'SQL Managed Instance', 'windows-server-payg': 'Windows Server pay-as-you-go', 'kubernetes-gitops': 'Kubernetes GitOps', 'essential-machine-management': 'Essential Machine Management' };
const SQL_MIN_CORES = 4;
const DB = 'Azure Arc Enabled Databases';

module.exports = {
  type: 'azure-arc',
  label: 'Azure Arc (charged capabilities)',
  family: 'hybrid-edge',
  calculator: ['azure-arc'],
  keywords: ['azure arc', 'arc-enabled', 'hybrid', 'on premises servers', 'sql server arc', 'gitops', 'pay-as-you-go licensing', 'arc kubernetes'],
  fields: {
    workload: { req: true, enum: WORKLOADS, ask: 'Which Azure Arc capability do you want priced? SQL Server running outside Azure with pay-as-you-go licensing -> sql-server; a SQL Managed Instance running on your own hardware -> sql-managed-instance; Windows Server 2025 billed pay-as-you-go through Arc -> windows-server-payg; GitOps configuration on Arc-connected Kubernetes clusters -> kubernetes-gitops; Essential Machine Management (update, change tracking, inventory and machine configuration tooling) on Arc-connected servers -> essential-machine-management. Price each capability as its own component. (Connecting servers and clusters to Arc, and its inventory, has no charge.)' },
    count: { def: 1, int: true, min: 1, ask: 'How many of them: servers or VMs running SQL Server or Windows Server, SQL Managed Instances, Kubernetes clusters, or Arc-connected servers for essential-machine-management? If unknown, suggest 1 and record it as an assumption.' },
    cores: { req: true, int: true, min: 1, ask: 'How many CPU cores does each one have (use 1 for essential-machine-management, which is per server; cores or vCores of each server or VM; vCores of each SQL Managed Instance; vCPUs of each Kubernetes cluster)? If unknown, suggest 8 and record it as an assumption.' },
    edition: { def: 'standard', enum: ['standard', 'enterprise', 'web'], ask: 'SQL Server only: which edition? Standard -> standard, Enterprise -> enterprise, Web -> web. Developer and Express editions have no charge. If unknown, suggest standard and record it as an assumption.' },
    licenseScope: { def: 'machine', enum: ['machine', 'physical-host'], ask: 'SQL Server only: do you pay for the cores of each machine (machine), or for all physical cores of the host with unlimited virtualization at the Enterprise rate (physical-host)? physical-host needs edition enterprise and "cores" is then the physical cores of each host. If unknown, suggest machine.' },
    tier: { def: 'general-purpose', enum: ['general-purpose', 'business-critical', 'developer'], ask: 'SQL Managed Instance only: which service tier? Standard workloads -> general-purpose; the highest availability and performance -> business-critical; a free instance for development and testing -> developer. If unknown, suggest general-purpose and record it as an assumption.' },
    licensing: { def: 'license-included', enum: ['license-included', 'hybrid-benefit'], ask: 'SQL Managed Instance only: do you pay for the SQL Server licence as part of the hourly price (license-included), or do you bring your own licences with Software Assurance (hybrid-benefit), which removes the licence part? If unknown, suggest license-included.' },
    drReplicaVcores: { def: 0, int: true, min: 0, ask: 'General-purpose SQL Managed Instance only: how many vCores of disaster-recovery replica (a secondary copy in another place) do you run? Use 0 if none.' },
    commitment: { def: 'payg', enum: ['payg', '1yr', '3yr'], ask: 'SQL Managed Instance only: will the Arc service part run steadily for a long time? Pay as you go -> payg; reserved for one year -> 1yr; reserved for three years -> 3yr. If unknown, suggest payg.' },
    freeEntitlement: { def: false, bool: true, ask: 'Essential Machine Management only: are the servers covered by Windows Server Software Assurance, Windows Server pay-as-you-go, Extended Security Updates or Defender for Servers Plan 2? If yes the feature is free; answer true. If unknown, suggest false and record it as an assumption.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Hours a month they run (730 = all month; a stopped SQL Server instance is not billed). Does not apply to Kubernetes GitOps, which is per vCPU per month, or to reservations, which bill the full month.' }
  },
  context: ['production'],
  examples: [
    { type: 'azure-arc', workload: 'sql-server', count: 2, cores: 8, edition: 'standard' },
    { type: 'azure-arc', workload: 'sql-server', count: 1, cores: 32, edition: 'enterprise', licenseScope: 'physical-host', hours: 500 },
    { type: 'azure-arc', workload: 'sql-managed-instance', count: 2, cores: 4, tier: 'business-critical', licensing: 'license-included', commitment: '1yr' },
    { type: 'azure-arc', workload: 'sql-managed-instance', count: 1, cores: 8, tier: 'general-purpose', licensing: 'license-included', drReplicaVcores: 8 },
    { type: 'azure-arc', workload: 'windows-server-payg', count: 3, cores: 16, hours: 600 },
    { type: 'azure-arc', workload: 'kubernetes-gitops', count: 3, cores: 8 },
    { type: 'azure-arc', workload: 'essential-machine-management', count: 20, cores: 1 }
  ],
  readback: c => {
    const w = c.workload;
    const cnt = n(c.count) || 1, cores = n(c.cores);
    const h = c.hours ?? HOURS;
    const hrs = h === HOURS ? 'running all month' : `${fmtN(h)} hours a month`;
    if (w === 'sql-server') {
      const ed = c.edition || 'standard';
      return c.licenseScope === 'physical-host'
        ? `Azure Arc SQL Server ${ed} pay-as-you-go, all physical cores of the host with unlimited virtualization: ${fmtN(cnt)} host(s) x ${fmtN(cores)} physical cores, ${hrs}`
        : `Azure Arc SQL Server ${ed} pay-as-you-go: ${fmtN(cnt)} machine(s) x ${fmtN(cores)} cores each, ${hrs}`;
    }
    if (w === 'sql-managed-instance') {
      const t = c.tier || 'general-purpose';
      const parts = [`Azure Arc SQL Managed Instance ${t}: ${fmtN(cnt)} instance(s) x ${fmtN(cores)} vCores each`];
      if (n(c.drReplicaVcores)) parts.push(`${fmtN(c.drReplicaVcores)} vCores of disaster-recovery replica`);
      parts.push(t === 'developer' ? 'free developer instance' : (c.licensing === 'hybrid-benefit' ? 'own licences (hybrid benefit)' : 'licence included'));
      parts.push(c.commitment && c.commitment !== 'payg' ? `${c.commitment === '1yr' ? '1-year' : '3-year'} reservation for the Arc service part` : hrs);
      return parts.join(', ');
    }
    if (w === 'windows-server-payg') return `Azure Arc Windows Server pay-as-you-go: ${fmtN(cnt)} server(s) x ${fmtN(cores)} cores each, ${hrs}`;
    if (w === 'essential-machine-management') return `Azure Arc Essential Machine Management: ${fmtN(cnt)} server(s), ${c.freeEntitlement === true ? 'free through an entitlement' : hrs}`;
    return `Azure Arc Kubernetes GitOps configuration: ${fmtN(cnt)} cluster(s) x ${fmtN(cores)} vCPUs each, billed per vCPU per month`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : ['The servers, clusters and storage that Arc connects (Arc only bills the capabilities listed), plus System Center Operations Manager Managed Instance ($6 per endpoint a month, an Azure Monitor meter), Azure Arc on System Center VMM ($2.50 per physical core a month), Extended Security Updates, Update Manager, Azure Policy, Defender and Monitor for Arc servers, which are priced as their own components']),
  price: async (c, ctx) => {
    const w = c.workload;
    if (!WORKLOADS.includes(w)) throw new PricingError(`workload must be one of ${WORKLOADS.join(', ')}.`);
    const count = c.count == null ? 1 : n(c.count), cores = n(c.cores);
    const hours = c.hours ?? HOURS;
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(cores) || cores < 1) throw new PricingError('count and cores must be whole numbers of at least 1.');
    if (!Number.isFinite(Number(hours)) || hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const gov = /^usgov|^usdod/.test(ctx.region);
    const REGIONLESS = `armRegionName eq '${gov ? 'US Gov' : 'Global'}'`;
    const G = 'Management';
    const notes = [];
    const lines = [];
    const facts = { workload: w, count, cores, totalCores: count * cores, hours };

    if (w === 'sql-server') {
      const ed = c.edition || 'standard';
      const scope = c.licenseScope || 'machine';
      if (!['standard', 'enterprise', 'web'].includes(ed)) throw new PricingError('edition must be standard, enterprise or web.');
      if (!['machine', 'physical-host'].includes(scope)) throw new PricingError('licenseScope must be "machine" or "physical-host".');
      if (scope === 'physical-host' && ed !== 'enterprise') throw new PricingError('Unlimited virtualization by physical cores is billed at the Enterprise rate; use edition "enterprise" with licenseScope "physical-host".');
      const rs = await rows(`serviceName eq '${DB}' and productName eq 'Azure Arc-enabled SQL Server - Arc-enabled servers' and priceType eq 'Consumption' and ${REGIONLESS}`, ctx);
      const name = scope === 'physical-host' ? 'Ent edition - Host - PAYG' : ed === 'standard' ? 'Std edition - PAYG' : ed === 'enterprise' ? 'Ent edition - PAYG' : 'Web Edition - PAYG';
      const m = single(rs.filter(r => r.meterName === name), `SQL Server ${ed} pay-as-you-go per core (${name})`);
      const billable = Math.max(cores, SQL_MIN_CORES);
      const total = count * billable;
      lines.push(meterLine(G, DB, `SQL Server ${ed} pay-as-you-go via Azure Arc${scope === 'physical-host' ? ' (physical cores, unlimited virtualization)' : ''}: ${fmtN(count)} x ${fmtN(billable)} billable cores x ${fmtN(hours)} hours`, m, total * hours, ctx, { unit: 'core-hours' }));
      notes.push(`SQL Server pay-as-you-go through Azure Arc is billed per core per hour, with a minimum of ${SQL_MIN_CORES} cores per machine${billable > cores ? `; ${fmtN(cores)} cores are rounded up to ${fmtN(billable)}` : ''}. A stopped SQL Server instance is not billed.`);
      notes.push('Machines that use their own SQL Server licences (Software Assurance or subscription) report $0 meters instead, and the Developer and Express editions are free, so this applies only to pay-as-you-go licensing.');
      Object.assign(facts, { edition: ed, licenseScope: scope, billableCores: total });
    } else if (w === 'essential-machine-management') {
      const rs = await rows(`serviceName eq 'Azure Arc' and priceType eq 'Consumption' and ${REGIONLESS} and meterName eq 'Essential Machine Management Server'`, ctx);
      const m = single(rs, 'Essential Machine Management per server');
      if (c.freeEntitlement === true) notes.push('Essential Machine Management is free for servers with Windows Server Software Assurance, Windows Server pay-as-you-go, Extended Security Updates or Defender for Servers Plan 2, so nothing is charged.');
      else lines.push(meterLine(G, 'Azure Arc', `Essential Machine Management: ${fmtN(count)} server(s) x ${fmtN(hours)} hours`, m, count * hours, ctx, { unit: 'server-hours' }));
      facts.freeEntitlement = c.freeEntitlement === true;
    } else if (w === 'windows-server-payg') {
      if (gov) throw new PricingError('Windows Server pay-as-you-go via Arc is not offered in Azure Government regions.');
      const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq 'Az Arc Pay As You Go Windows Server' and priceType eq 'Consumption' and ${REGIONLESS}`, ctx);
      const m = single(rs.filter(r => r.meterName === '1 Core License'), 'Windows Server pay-as-you-go per core');
      lines.push(meterLine('Compute', 'Virtual Machines Licenses', `Windows Server pay-as-you-go via Azure Arc: ${fmtN(count)} server(s) x ${fmtN(cores)} cores x ${fmtN(hours)} hours`, m, count * cores * hours, ctx, { unit: 'core-hours' }));
      notes.push('Windows Server pay-as-you-go enabled by Azure Arc bills Standard and Datacenter at the same per-core rate, with no minimum core count per machine and no difference between virtual and physical machines. It supports Windows Server 2025; a seven-day trial period is not billed.');
      facts.billableCores = count * cores;
    } else if (w === 'kubernetes-gitops') {
      const rs = await rows(`serviceName eq 'Azure Arc' and productName eq 'Azure Arc' and priceType eq 'Consumption' and ${REGIONLESS}`, ctx);
      const m = single(rs.filter(r => r.meterName === 'Kubernetes Configuration Management/vCPU'), 'Kubernetes configuration management per vCPU');
      const total = count * cores;
      lines.push(meterLine('Containers', 'Azure Arc', `Arc-enabled Kubernetes configuration (GitOps): ${fmtN(total)} vCPUs in total (${fmtN(count)} cluster(s) x ${fmtN(cores)}), first 6 free`, m, total, ctx, { unit: 'vCPUs / month' }));
      notes.push('GitOps (Flux) configuration on Arc-enabled Kubernetes is billed per vCPU per month after the first six vCPUs; a cluster pays one charge however many repositories are connected. Microsoft Learn words the free six vCPUs per cluster in one article and per subscription in another; this estimate applies them once to the total vCPUs entered.');
      notes.push('GitOps is included at no extra charge on AKS enabled by Azure Arc on Azure Local and on AKS Edge Essentials.');
      facts.totalVcpus = total;
    } else {
      const tier = c.tier || 'general-purpose';
      const lic = c.licensing || 'license-included';
      const commit = c.commitment || 'payg';
      const dr = n(c.drReplicaVcores);
      if (!['general-purpose', 'business-critical', 'developer'].includes(tier)) throw new PricingError('tier must be general-purpose, business-critical or developer.');
      if (!['license-included', 'hybrid-benefit'].includes(lic)) throw new PricingError('licensing must be "license-included" or "hybrid-benefit".');
      if (!['payg', '1yr', '3yr'].includes(commit)) throw new PricingError('commitment must be payg, 1yr or 3yr.');
      if (!Number.isInteger(dr) || dr < 0) throw new PricingError('drReplicaVcores must be a whole number, 0 or more.');
      if (dr && tier !== 'general-purpose') throw new PricingError('A priced disaster-recovery replica applies to the general-purpose tier only; a business-critical DR replica has no Arc service charge.');
      const vcores = count * cores;
      if (tier === 'developer') {
        const rs = await rows(`serviceName eq '${DB}' and productName eq 'Azure Arc enabled SQL Managed Instance Developer Instance' and priceType eq 'Consumption' and ${REGIONLESS}`, ctx);
        lines.push(meterLine(G, DB, `SQL Managed Instance developer instance via Azure Arc: ${fmtN(count)} x ${fmtN(cores)} vCores x ${fmtN(hours)} hours, no charge`, single(rs, 'SQL Managed Instance developer instance'), vcores * hours, ctx, { unit: 'vCore-hours' }));
        notes.push('The Developer tier of SQL Managed Instance enabled by Azure Arc has no charge.');
      } else {
        const T = tier === 'general-purpose' ? 'General Purpose' : 'Business Critical';
        const all = await rows(`serviceName eq '${DB}' and ${REGIONLESS} and (priceType eq 'Consumption' or priceType eq 'Reservation') and contains(productName, 'Azure Arc enabled SQL Managed Instance - ${T}')`, ctx);
        const arcProd = `Azure Arc enabled SQL Managed Instance - ${T} - Arc Service`;
        const arc = (sku, type, term) => all.filter(r => r.productName === arcProd && r.skuName === sku && r.type === type && (!term || r.reservationTerm === term));
        const term = commit === '1yr' ? '1 Year' : commit === '3yr' ? '3 Years' : null;
        const arcLine = (sku, q, what) => {
          if (!term) return meterLine(G, DB, `${what}: ${fmtN(q)} vCores x ${fmtN(hours)} hours`, single(arc(sku, 'Consumption'), `${what} (${T})`), q * hours, ctx, { unit: 'vCore-hours' });
          const rr = single(arc(sku, 'Reservation', term), `${what} ${term} reservation (${T})`)[0];
          const months = termMonths(term);
          return line(G, DB, `${what}, ${term} reservation: ${fmtN(q)} vCores`, q, 'vCores / month', rr.retailPrice / months, rr.retailPrice / months * q, meterInfo(rr), { termTotal: rr.retailPrice });
        };
        lines.push(arcLine('vCore', vcores, `SQL Managed Instance ${T.toLowerCase()} Arc service`));
        if (dr) lines.push(arcLine('DR Replica', dr, 'Disaster-recovery replica Arc service'));
        if (lic === 'license-included') {
          const lrs = single(all.filter(r => r.productName === `Azure Arc enabled SQL Managed Instance - ${T} - SQL License` && r.type === 'Consumption'), `SQL Managed Instance ${T} SQL licence`);
          lines.push(meterLine(G, DB, `SQL Server licence included in ${T.toLowerCase()} SQL Managed Instance: ${fmtN(vcores)} vCores x ${fmtN(hours)} hours`, lrs, vcores * hours, ctx, { unit: 'vCore-hours' }));
        } else notes.push('With your own SQL Server licences and Software Assurance (Azure Hybrid Benefit) the licence part of the price is not charged.');
        if (term) {
          notes.push(`${term} reservation: the listed reservation price is for the whole term per vCore; it is divided by ${termMonths(term)} months here and billed whether or not the instance runs. It covers the Arc service part only, not the SQL licence.`);
          if (hours < HOURS) facts.commitmentUnderused = true;
        }
      }
      if (tier === 'business-critical') notes.push('Business Critical is billed per vCore of the instance only: the Retail API lists the Business Critical disaster-recovery replica Arc service meter at $0, and this estimate assumes high-availability replicas are not billed separately.');
      Object.assign(facts, { tier, licensing: lic, commitment: commit, drReplicaVcores: dr, vcores });
    }
    notes.push(`Arc itself, the control plane that connects and inventories servers and clusters, has no charge; only the ${NAMES[w]} capability above is billed.`);
    return { lines, notes, facts };
  }
};
