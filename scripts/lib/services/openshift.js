'use strict';
// Azure Red Hat OpenShift: only the OpenShift licence is priced here. It is billed per worker vCPU-hour
// (serviceName 'Virtual Machines Licenses', regionless) at one flat rate for any VM series or size; the
// control plane carries no licence fee. The VMs and disks are priced with the 'vm' and 'disk' types.
const vmSizes = require('../../../catalog/vm-sizes.json');
const { rows, single, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);
const PRODUCT = 'Azure Red Hat OpenShift General Purpose';
const COMMIT = { payg: null, ri1y: '1 Year', ri3y: '3 Years' };

module.exports = {
  type: 'openshift',
  label: 'Azure Red Hat OpenShift',
  family: 'containers',
  calculator: ['openshift'],
  keywords: ['openshift', 'aro', 'red hat', 'kubernetes platform', 'managed openshift', 'containers', 'worker nodes'],
  fields: {
    workerNodes: { req: true, int: true, min: 1, max: 250, ask: 'How many worker nodes (the machines that run your applications) will the cluster have? OpenShift needs at least 3. If unknown, suggest 3 and record it as an assumption.' },
    vcpusPerNode: { req: true, int: true, min: 4, ask: 'How many vCPUs (cores) does each worker node have? This is the vCPU count of the virtual machine size they pick (for example a D4s v5 has 4, a D8s v5 has 8). If unknown, suggest 4 and record it as an assumption.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Will the cluster run steadily for a year or more, so they could commit to a reservation on the OpenShift licence for a discount? No or unsure -> payg; 1-year commitment -> ri1y; 3-year commitment -> ri3y.' },
    architecture: { def: 'standard', enum: ['standard', 'hosted'], ask: 'Does the cluster run its own control plane (three master VMs in their subscription), or does Microsoft host the control plane for them? Own control plane (the usual choice) -> standard; Microsoft-hosted control plane -> hosted.' },
    hours: { def: HOURS, min: 0, max: 744, ask: 'Hours a month the worker nodes run (730 = all month). Microsoft does not support scaling the cluster workers to zero or shutting the cluster down, so use less than a full month only for extra autoscaled nodes; the minimum 3 workers run all month. Ignored for reservations, which bill every hour.' }
  },
  context: ['production', 'steadyUsage', 'zoneResilience'],
  notIncluded: (types, spec) => {
    if (spec && spec.excluded) return [];
    const out = [];
    const opts = ((spec && spec.options) || []).filter(o => (o.components || []).some(c => c.type === 'openshift'));
    let anyVm = false, anyDisk = false, standard = false;
    for (const o of opts) {
      const comps = o.components || [];
      const vms = comps.filter(c => c.type === 'vm');
      if (vms.length) anyVm = true;
      if (comps.some(c => c.type === 'disk')) anyDisk = true;
      const osc = comps.filter(c => c.type === 'openshift');
      if (osc.some(c => (c.architecture || 'standard') === 'standard')) standard = true;
      const want = osc.reduce((a, c) => a + n(c.workerNodes) * n(c.vcpusPerNode), 0);
      if (vms.some(v => String(v.os || 'linux').toLowerCase() !== 'linux')) out.push('The vm components use an operating system other than plain Linux (Windows, RHEL or similar), which adds licence charges OpenShift nodes do not pay: use os linux');
      const have = vms.reduce((a, v) => a + ((vmSizes[v.sku] || {}).v || 0) * (v.count || 1), 0);
      if (vms.length && want && have && have < want) out.push(`The vm components total ${fmtN(have)} vCPUs but the OpenShift licence covers ${fmtN(want)} worker vCPUs: add the worker virtual machines`);
    }
    if (!anyVm) out.push('The virtual machines for worker nodes and infrastructure nodes: add them as vm components, billed at normal Linux VM rates (the OpenShift licence here is only the software fee for the workers)');
    if (standard) out.push('The three control plane (master) nodes of a standard cluster: at least 3 virtual machines of 8 vCPUs or more (for example D8s v5), plus three 1,024 GiB Premium SSD LRS disks. In the calculator these are often the largest lines, bigger than the licence');
    if (!anyDisk) out.push('Managed OS disks for every node: add them as disk components');
    out.push('Load balancers, public IP addresses, outbound data transfer, container registry and storage for applications');
    out.push('The Cluster Management fee that applies to clusters with a Microsoft-hosted control plane has no meter in the Azure Retail Prices API and is not included');
    return out;
  },
  examples: [
    { type: 'openshift', workerNodes: 3, vcpusPerNode: 4 },
    { type: 'openshift', workerNodes: 6, vcpusPerNode: 8, commitment: 'ri3y' },
    { type: 'openshift', workerNodes: 4, vcpusPerNode: 16, commitment: 'payg', architecture: 'hosted', hours: 400 }
  ],
  readback: c => {
    const w = n(c.workerNodes), v = n(c.vcpusPerNode), commit = c.commitment || 'payg';
    const when = commit === 'payg' ? ((c.hours ?? HOURS) === HOURS ? 'running all month' : `running ${fmtN(c.hours)} hours a month`) : `with a ${COMMIT[commit]} reservation`;
    return `OpenShift licence for ${fmtN(w)} worker node(s) x ${fmtN(v)} vCPUs = ${fmtN(w * v)} worker vCPUs, ${c.architecture === 'hosted' ? 'Microsoft-hosted control plane' : 'cluster-run control plane'}, ${when}`;
  },
  price: async (c, ctx) => {
    const w = n(c.workerNodes), v = n(c.vcpusPerNode), commit = c.commitment || 'payg', arch = c.architecture || 'standard';
    if (!(commit in COMMIT)) throw new PricingError(`commitment must be one of ${Object.keys(COMMIT).join(', ')}.`);
    if (!['standard', 'hosted'].includes(arch)) throw new PricingError('architecture must be "standard" or "hosted".');
    if (w < 1 || v < 1) throw new PricingError('workerNodes and vcpusPerNode must be at least 1.');
    if (arch === 'standard' && w < 3) throw new PricingError('A standard OpenShift cluster needs at least 3 worker nodes.');
    if (arch === 'hosted' && commit !== 'payg') throw new PricingError('Licence reservations apply only to clusters with their own control plane (architecture "standard").');
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    // The licence rate is the same for every family and size, so one 4 vCPU meter scaled by vCPUs/4 prices all of them.
    const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq '${PRODUCT}' and skuName eq '4 vCPU' and (armRegionName eq '' or armRegionName eq 'Global')`, ctx);
    const vcpus = w * v, units = vcpus / 4;
    const lines = [], notes = [];
    if (commit === 'payg') {
      const m = single(rs.filter(r => r.type === 'Consumption'), 'OpenShift licence (pay-as-you-go)');
      lines.push(meterLine('Containers', 'Virtual Machines Licenses', `OpenShift licence, ${fmtN(vcpus)} worker vCPUs (${fmtN(units)} x 4-vCPU blocks) x ${fmtN(hours)} hours`, m, units * hours, ctx, { unit: 'block-hours' }));
    } else {
      const rr = rs.find(r => r.type === 'Reservation' && r.reservationTerm === COMMIT[commit]);
      if (!rr) throw new PricingError(`No ${COMMIT[commit]} OpenShift licence reservation price found.`);
      const months = termMonths(COMMIT[commit]), monthly = rr.retailPrice / months;
      lines.push(line('Containers', 'Virtual Machines Licenses', `OpenShift licence, ${fmtN(vcpus)} worker vCPUs (${fmtN(units)} x 4-vCPU blocks), ${COMMIT[commit]} reservation`, units, '4-vCPU blocks / month', monthly, monthly * units, meterInfo(rr), { termTotal: rr.retailPrice }));
      notes.push(`${COMMIT[commit]} reservation: ${rr.retailPrice} is the whole-term price per 4 worker vCPUs, divided by ${months} months. Billed every hour whether or not the nodes run.`);
    }
    notes.push('The OpenShift licence is a flat per-vCPU rate on worker nodes only, the same for every VM series and size; control plane nodes carry no licence fee. VMs and disks are billed separately.');
    notes.push('Infrastructure nodes (monitoring, registry, routing) carry no OpenShift licence, only normal VM cost: leave them out of workerNodes.');
    if (arch === 'hosted') notes.push('Clusters with a Microsoft-hosted control plane also pay a Cluster Management fee, which is not published in the Retail Prices API and is not included.');
    return { lines, notes, facts: { architecture: arch, commitment: commit, workerNodes: w, workerVcpus: vcpus, hours } };
  }
};
