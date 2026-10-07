'use strict';
// Azure Site Recovery (calculator slug site-recovery): per protected instance per month, either replicated to
// Azure or replicated to a customer-owned site. Replica storage, network egress and failover VMs are billed
// by their own services.
const { rows, single, meterLine, regionFilter, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'site-recovery',
  label: 'Azure Site Recovery',
  family: 'management',
  calculator: ['site-recovery'],
  keywords: ['disaster recovery', 'site recovery', 'replication', 'failover', 'dr', 'replicate vms', 'business continuity'],
  fields: {
    destination: { def: 'azure', enum: ['azure', 'customer-site'], ask: 'Where will the servers or virtual machines be replicated to? To Azure (a disaster-recovery copy in Azure, including Azure VMs replicated to another Azure region) -> azure; to another site you own (for example a second datacenter) -> customer-site. If unknown, suggest azure and record it as an assumption.' },
    instances: { req: true, int: false, min: 1, ask: 'How many virtual machines or physical servers do you want to protect (replicate) with Site Recovery? Each one is a protected instance; billing uses the average number of protected instances over the month, so a fraction is allowed. If unknown, ask for a count of the machines that must come back after a disaster.' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'site-recovery', instances: 10 },
    { type: 'site-recovery', destination: 'customer-site', instances: 25 }
  ],
  readback: c => `Site Recovery: ${fmtN(n(c.instances))} protected instance(s) replicated ${c.destination === 'customer-site' ? 'to a site you own' : 'to Azure'}, billed per instance per month`,
  notIncluded: () => [
    'Storage for the replicated disks, the cache storage account and storage transactions, network data transfer (egress), and the virtual machines that run after a failover or test failover (all billed by their own services)'
  ],
  price: async (c, ctx) => {
    const dest = c.destination || 'azure';
    if (!['azure', 'customer-site'].includes(dest)) throw new PricingError('destination must be "azure" or "customer-site".');
    const inst = n(c.instances);
    if (!(inst >= 1)) throw new PricingError('instances must be at least 1.');
    const rs = await rows(`serviceName eq 'Azure Site Recovery' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Site Recovery is not priced in ${ctx.region}.`);
    let m, what;
    if (dest === 'azure') {
      m = single(rs.filter(r => r.meterName === 'VM Replicated to Azure'), 'Site Recovery protected instance replicated to Azure');
      what = 'replicated to Azure';
    } else {
      // Regions carry either the System Center meter or the on-premises-sites meter, at the same list rate.
      let own = rs.filter(r => r.meterName === 'VM Replicated to System Center');
      if (!own.length) own = rs.filter(r => r.meterName === 'VM Replicated between On-premise sites');
      if (!own.length) throw new PricingError(`Replication to a customer-owned site is not offered in ${ctx.region}; use destination "azure" or pick another region.`);
      m = single(own, 'Site Recovery protected instance replicated to a customer-owned site');
      what = 'replicated to a customer-owned site';
    }
    const lines = [meterLine('Management', 'Azure Site Recovery', `Site Recovery: ${fmtN(inst)} protected instance(s) ${what}`, m, inst, ctx, { unit: 'instances / month' })];
    const notes = [
      'Site Recovery charges per protected instance per month. Every protected instance is free for its first 31 days, so this estimate is the steady-state charge after that; an instance protected for less than 31 days has no Site Recovery charge.',
      'Replica disks, storage transactions, network egress and the VMs started at failover are billed separately.'
    ];
    return { lines, notes, facts: { destination: dest, instances: inst } };
  }
};
