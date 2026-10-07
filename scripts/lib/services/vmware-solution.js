'use strict';
// Azure VMware Solution (AVS): VMware private cloud on dedicated Azure bare-metal hosts, billed per host-hour.
// Meters: serviceName 'Specialized Compute', productName 'Specialized Compute Azure VMware Solution',
// skuName '<host> VCF BYOL' (the AVS service price excludes the VMware VCF subscription from Broadcom).
const { rows, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);
const HOSTS = {
  av36: { name: 'AV36', spec: '36 cores, 576 GB memory, 18.6 TB storage per host' },
  av36p: { name: 'AV36P', spec: '36 cores, 768 GB memory, 20.7 TB all-NVMe storage per host' },
  av48: { name: 'AV48', spec: '48 cores, 1,000 GB memory, 25.6 TB all-NVMe storage per host' },
  av52: { name: 'AV52', spec: '52 cores, 1,500 GB memory, 40 TB storage per host' },
  av64: { name: 'AV64', spec: '64 cores, 1,000 GB memory, 19.2 TB all-NVMe storage per host' }
};
const COMMIT = { payg: null, 'reservation-1y': '1 Year', 'reservation-3y': '3 Years' };
const termWord = t => t.toLowerCase().replace(/^(\d+) years?$/, '$1-year');

module.exports = {
  type: 'vmware-solution',
  label: 'Azure VMware Solution',
  family: 'compute-other',
  calculator: ['azure-vmware'],
  keywords: ['vmware', 'avs', 'vsphere', 'vcenter', 'esxi', 'lift and shift vmware', 'private cloud', 'vsan'],
  fields: {
    nodes: { req: true, int: true, min: 3, ask: 'How many VMware hosts do they need in total? Azure VMware Solution needs at least 3 hosts per cluster. Size it from the cores, memory and storage of the VMs being moved, spread over the hosts. If they only know their VM count, suggest 3 and record it as an assumption.' },
    hostType: { def: 'av36p', enum: Object.keys(HOSTS), ask: 'Which size of host? Choose by cores and memory per host: av36 (36 cores, 576 GB), av36p (36 cores, 768 GB, the usual starting choice), av48 (48 cores, 1 TB), av52 (52 cores, 1.5 TB, most storage) or av64 (64 cores, 1 TB). Not every size is sold in every region. av64 normally can only be added to a private cloud that already has at least 3 hosts of av36p, av48 or av52, so do not suggest it as the only host size. If unknown, suggest av36p and record it as an assumption.' },
    hours: { def: 730, ask: 'How many hours a month do the hosts exist? Hosts bill every hour they are provisioned (730 = all month). Reservations ignore this.' },
    commitment: { def: 'payg', enum: Object.keys(COMMIT), ask: 'Will the hosts run for a year or more? No -> payg; 1 year -> reservation-1y; 3 years -> reservation-3y. Reservations are not sold for every host size (none for av36; av36p and av52 have no 3-year) and need an Enterprise Agreement or Microsoft Customer Agreement. If unknown use payg.' }
  },
  context: ['production', 'steadyUsage'],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The VMware Cloud Foundation (VCF) subscription: the host price does not include it; customers bring their own VCF licence bought from Broadcom (or use portable licences).',
    'Connectivity to the private cloud: ExpressRoute circuit/gateway, VPN, and outbound data transfer.',
    ...(types && types.has && types.has('public-ip') ? [] : ['Public IPv4 addresses used by the private cloud: they are charged by the size of the Public IPv4 prefix (add a public-ip component).']),
    'Windows Server and SQL Server licences for the VMs you run on the hosts (SQL Server Enterprise on Azure VMware Solution has its own licence charge unless Azure Hybrid Benefit applies).',
    'Extra storage beyond the hosts (Azure NetApp Files, Elastic SAN, Pure Cloud Block Store), backup, and disaster recovery tools. VMware HCX, VCF Automation and VCF Operations come with the VCF subscription you bring, not with the host price.'
  ]),
  examples: [
    { type: 'vmware-solution', nodes: 3 },
    { type: 'vmware-solution', nodes: 4, hostType: 'av36p', hours: 400 },
    { type: 'vmware-solution', nodes: 3, hostType: 'av36p', commitment: 'reservation-1y' },
    { type: 'vmware-solution', nodes: 3, hostType: 'av64', commitment: 'reservation-3y' }
  ],
  readback: c => {
    const h = HOSTS[c.hostType || 'av36p'] || { name: c.hostType, spec: '' };
    const ct = COMMIT[c.commitment || 'payg'];
    const hrs = c.hours ?? HOURS;
    const when = ct ? `${termWord(ct)} reservation` : `pay as you go, ${hrs === HOURS ? 'running all month (730 hours)' : `${fmtN(hrs)} hours a month`}`;
    return `Azure VMware Solution: ${fmtN(n(c.nodes))} ${h.name} host(s) (${h.spec}), ${when}`;
  },
  price: async (c, ctx) => {
    const key = c.hostType || 'av36p';
    const h = HOSTS[key];
    if (!h) throw new PricingError(`Unknown hostType "${key}". Use one of: ${Object.keys(HOSTS).join(', ')}.`);
    const nodes = n(c.nodes), hours = c.hours ?? HOURS;
    if (!Number.isInteger(nodes) || nodes < 3) throw new PricingError('Azure VMware Solution needs a whole number of at least 3 hosts per cluster.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const commitment = c.commitment || 'payg';
    if (!(commitment in COMMIT)) throw new PricingError(`Unknown commitment "${commitment}". Use payg, reservation-1y or reservation-3y.`);
    const term = COMMIT[commitment];
    const product = 'Specialized Compute Azure VMware Solution';
    const all = await rows(`serviceName eq 'Specialized Compute' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption' and endswith(skuName, 'VCF BYOL')`, ctx);
    const rs = all.filter(r => r.skuName === `${h.name} VCF BYOL`);
    if (!rs.length) {
      const here = Object.values(HOSTS).filter(x => all.some(r => r.skuName === `${x.name} VCF BYOL` && r.retailPrice > 0)).map(x => x.name);
      throw new PricingError(here.length
        ? `${h.name} hosts are not sold in ${ctx.region}. Host sizes sold there: ${here.join(', ')}.`
        : `Azure VMware Solution is not available in ${ctx.region}.`);
    }
    const payg = rs;
    const label = `Azure VMware Solution ${h.name} host`;
    const lines = [], notes = [];
    if (!term) lines.push(meterLine('Compute', 'Specialized Compute', `${label}: ${fmtN(nodes)} host(s) x ${fmtN(hours)} hours`, payg, nodes * hours, ctx, { unit: 'host-hours' }));
    else {
      const rr = (await rows(`serviceName eq 'Specialized Compute' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Reservation' and skuName eq '${h.name} VCF BYOL'`, ctx)).find(r => r.reservationTerm === term);
      if (!rr) throw new PricingError(`${h.name} hosts have no ${termWord(term)} reservation in ${ctx.region}. Reservations are sold only for some host sizes and regions; use payg or another term.`);
      const months = termMonths(term), monthly = rr.retailPrice / months;
      lines.push(line('Compute', 'Specialized Compute', `${label}: ${fmtN(nodes)} host(s), ${termWord(term)} reservation`, nodes, 'host / month', monthly, monthly * nodes, meterInfo(rr), { termTotal: rr.retailPrice }));
      notes.push(`${termWord(term)} reservation: ${fmtN(rr.retailPrice)} is the whole-term price per host, divided by ${months} months. It is billed whether or not the host is used; paying upfront or monthly costs the same.`);
    }
    notes.unshift('Each host bills every hour it is provisioned. A private cloud needs at least 3 hosts per cluster (up to 16). The price covers the Azure hardware and managed service but not the VMware VCF subscription.');
    if (h.name === 'AV64') notes.push('AV64 hosts normally can only be added to a private cloud that already has at least 3 hosts of AV36P, AV48 or AV52 (except where AV64 Gen 2 is offered). Price those base hosts as well; this estimate includes only the AV64 hosts.');
    return { lines, notes, facts: { hostType: h.name, nodes, hours, commitment, paygHourly: payg[0].retailPrice } };
  }
};