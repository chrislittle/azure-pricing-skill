'use strict';
// Azure HDInsight (classic clusters on Linux): per-node-hour meters that already include the VM, plus
// the Enterprise Security Package surcharge, the ID Broker nodes and managed disks.
// Meters: serviceName 'HDInsight', productName 'HDInsight <series>' (node-hours), 'HDInsight ID Broker',
// 'HDInsight Storage' (managed disks) and the regionless 'HDInsight Add-on Software'.
// Customer-chosen nodes (head, worker, edge) are sized from vCPU and memory and only Current/Extended VM series
// are used. ZooKeeper nodes (for HBase, Interactive Query, Kafka) and ID Broker nodes are sized by HDInsight
// itself, so they are priced at the size Microsoft documents even though that VM series is End of Life.
const { query, meterLine, PricingError, fmtN, HOURS, q } = require('../kit');
const { lifecycle } = require('../lifecycle');

const n = v => Number(v || 0);
const SVC = 'HDInsight';
const CLUSTERS = { hadoop: 'Hadoop', spark: 'Spark', 'interactive-query': 'Interactive Query', hbase: 'HBase', kafka: 'Kafka' };
// Learn "Default and minimum recommended node configuration": head/worker minimum vCPU and GiB; ZooKeeper A4 v2 (4 cores)
// where the cluster has billed ZooKeeper nodes. Spark uses the calculator default (4 vCPU / 16 GiB), a lower memory than the D12_v2 Learn minimum.
const MIN = { hadoop: [16, 56], spark: [4, 16], 'interactive-query': [8, 56], hbase: [4, 14], kafka: [4, 14] };
const ZK_SIZE = 'A4 v2', ZK_CORES = 4, ZK_FREE_CORES = 2;
const BILLED_ZK = new Set(['hbase', 'interactive-query', 'kafka']);
const DISKS = {
  standard: { sku: 'S30', label: 'Standard S30 (1 TiB)' },
  premium: { sku: 'P30', label: 'Premium P30 (1 TiB)' },
  'premium-zrs': { sku: 'P30 - ZRS', label: 'Premium P30 ZRS (1 TiB)' }
};
const GP = /^(D\d+a(s)? v4|D\d+ads v5|E\d+a(s)? v4|E\d+ads v5|E\d+i?d(s)? v5)$/;
const armOf = name => `Standard_${String(name).replace(/ /g, '_')}`;
const gibPerCore = s => (/^D/.test(s) ? 4 : 8);
// Memory per Learn size tables: the largest E sizes are below 8 GiB per vCPU.
const memOf = (nm, cores) => (/^E/.test(nm) && cores === 96 ? 672 : /^E/.test(nm) && cores === 64 && /v4/.test(nm) ? 432 : cores * gibPerCore(nm));

module.exports = {
  type: 'hdinsight',
  label: 'Azure HDInsight',
  family: 'analytics',
  calculator: ['hdinsight'],
  keywords: ['hdinsight', 'hadoop', 'hive cluster', 'hbase', 'kafka cluster', 'spark cluster', 'interactive query', 'llap', 'big data cluster'],
  fields: {
    clusterType: { def: 'spark', ask: 'Which cluster type: spark, hadoop, interactive-query (Hive LLAP), hbase or kafka? Storm and ML Services clusters can no longer be created. If unknown, suggest spark and record it as an assumption.' },
    workerNodes: { req: true, int: true, min: 1, ask: 'How many worker nodes (region servers for HBase, brokers for Kafka)? If unknown, suggest 4 and record it as an assumption.' },
    workerVcpu: { int: true, min: 1, ask: 'Do not ask for a VM size. How many vCPUs and how much memory per worker node? Leave empty for the Microsoft minimum for the cluster type (Spark 4 vCPU / 16 GiB, Hadoop 16 / 56, Interactive Query 8 / 56, HBase and Kafka 4 / 14); a node is picked from Current VM series that meets it.' },
    workerMemoryGiB: { min: 1, ask: 'Memory in GiB per worker node (see workerVcpu); leave empty for the minimum.' },
    headVcpu: { int: true, min: 1, ask: 'vCPUs per head node; leave empty for the Microsoft minimum for the cluster type. Every cluster has exactly 2 head nodes.' },
    headMemoryGiB: { min: 1, ask: 'Memory in GiB per head node; leave empty for the minimum.' },
    edgeNodes: { def: 0, int: true, min: 0, ask: 'Edge nodes (client or application nodes)? 0 if none.' },
    edgeVcpu: { def: 4, int: true, min: 1, ask: 'Only with edge nodes: vCPUs per edge node (default 4).' },
    edgeMemoryGiB: { def: 16, min: 1, ask: 'Only with edge nodes: memory in GiB per edge node (default 16).' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours a month does the cluster exist? Billing is by the minute from creation until the cluster is deleted, and a cluster cannot be paused, so a cluster deleted after each job bills only its run time. 730 = always on.' },
    managedDisks: { def: 0, int: true, min: 0, ask: 'How many managed data disks are attached to the cluster in total? Only Kafka (required) and HBase with Accelerated Writes use them; for example Kafka with 2 disks per broker. 0 if none.' },
    diskTier: { def: 'standard', enum: Object.keys(DISKS), ask: 'Managed disk tier: standard (S30), premium (P30) or premium-zrs?' },
    diskOperations: { def: 0, min: 0, ask: 'Only for standard managed disks: how many disk operations a month, in thousands? 0 if unknown.' },
    enterpriseSecurity: { def: false, ask: 'Do they need the Enterprise Security Package (domain-joined cluster, Microsoft Entra Domain Services, Ranger)? It adds a per-core-hour charge.' },
    idBroker: { def: false, ask: 'Do they need HDInsight ID Broker (modern authentication for ESP clusters)? It adds two broker nodes sized by HDInsight.' }
  },
  context: ['production', 'steadyUsage', 'idlePeriods'],
  examples: [
    { type: 'hdinsight', clusterType: 'spark', workerNodes: 4, hours: 730 },
    {
      type: 'hdinsight', clusterType: 'kafka', workerNodes: 3, workerVcpu: 8, workerMemoryGiB: 32, hours: 730, managedDisks: 6, diskTier: 'premium',
      enterpriseSecurity: true, idBroker: true, edgeNodes: 1
    },
    { type: 'hdinsight', clusterType: 'hadoop', workerNodes: 8, hours: 100, managedDisks: 4, diskOperations: 50000 }
  ],
  readback: c => {
    const ct = c.clusterType || 'spark';
    const [mc, mm] = MIN[ct] || [0, 0];
    const node = (cnt, v, m) => `${fmtN(cnt)} x ${fmtN(v)} vCPU / ${fmtN(m)} GiB`;
    const parts = [`${CLUSTERS[ct] || ct} cluster: ${node(n(c.workerNodes), c.workerVcpu ?? mc, c.workerMemoryGiB ?? mm)} worker nodes, ${node(2, c.headVcpu ?? mc, c.headMemoryGiB ?? mm)} head nodes`];
    parts.push(BILLED_ZK.has(ct) ? '3 ZooKeeper nodes (A4 v2, sized by HDInsight)' : 'ZooKeeper nodes at no charge (A2 v2, sized by HDInsight)');
    if (n(c.edgeNodes)) parts.push(`${node(n(c.edgeNodes), c.edgeVcpu ?? 4, c.edgeMemoryGiB ?? 16)} edge nodes`);
    parts.push(`${fmtN(c.hours ?? HOURS)} hours a month`);
    if (n(c.managedDisks)) parts.push(`${fmtN(c.managedDisks)} ${DISKS[c.diskTier || 'standard'] ? DISKS[c.diskTier || 'standard'].label : c.diskTier} managed disks`);
    if (c.enterpriseSecurity) parts.push('Enterprise Security Package');
    if (c.idBroker) parts.push('ID Broker (2 nodes)');
    return `Azure HDInsight: ${parts.join('; ')}`;
  },
  notIncluded: (types, spec) => {
    const ex = (spec && spec.excluded) || [];
    if (ex.some(e => /storage|data lake|blob/i.test(String(e)))) return [];
    return types.has('blob') ? [] : ['The storage account or Data Lake Storage that holds the cluster data (and the metastore database, if external) is billed separately.'];
  },
  price: async (c, ctx) => {
    const ct = c.clusterType || 'spark';
    if (/^(storm|ml-?services?|r-?server)$/i.test(String(ct))) throw new PricingError(`${ct} clusters can no longer be created: Apache Storm and ML Services are not available in HDInsight 4.0 or later, and HDInsight 3.6 was retired on 1 October 2022. Use spark (Structured Streaming) or kafka instead.`);
    if (!CLUSTERS[ct]) throw new PricingError(`Unknown clusterType "${ct}". Use ${Object.keys(CLUSTERS).join(', ')}.`);
    const hours = n(c.hours ?? HOURS);
    if (!(hours > 0)) throw new PricingError('hours must be greater than 0.');
    const disks = n(c.managedDisks), tier = c.diskTier || 'standard';
    if (!DISKS[tier]) throw new PricingError(`diskTier must be ${Object.keys(DISKS).join(', ')}.`);
    if (ct === 'kafka' && !(disks > 0)) throw new PricingError('A Kafka cluster needs managed disks on its worker nodes. Set managedDisks (for example 2 per broker).');
    if (n(c.diskOperations) && !(disks > 0 && tier === 'standard')) throw new PricingError('Disk operations are only billed on standard managed disks; set managedDisks and diskTier standard, or leave diskOperations at 0.');
    const worker = n(c.workerNodes);
    if (!(worker >= 1)) throw new PricingError('workerNodes must be at least 1.');

    const all = await query(`serviceName eq '${SVC}' and priceType eq 'Consumption' and armRegionName eq '${q(ctx.region)}'`, ctx.currency);
    if (!all.length) throw new PricingError(`HDInsight is not offered in ${ctx.region}.`);

    // Current/Extended general-purpose sizes: name -> { row, cores, mem }
    const modern = new Map();
    for (const r of all) {
      if (!/^HDInsight .* Series$/.test(r.productName)) continue;
      for (const nm of String(r.skuName).split('/')) {
        if (!GP.test(nm) || !lifecycle(armOf(nm)).modern) continue;
        const cores = parseInt(/\d+/.exec(nm)[0], 10);
        if (!modern.has(nm) || r.retailPrice < modern.get(nm).row.retailPrice) modern.set(nm, { name: nm, row: r, cores, mem: memOf(nm, cores) });
      }
    }
    const pickSize = (vcpu, mem, role) => {
      const [mc, mm] = MIN[ct];
      if (role !== 'edge' && (vcpu < mc || mem < mm)) throw new PricingError(`HDInsight ${CLUSTERS[ct]} ${role} nodes need at least ${mc} vCPUs and ${mm} GiB of memory (Learn minimum recommended size); ${vcpu} vCPUs / ${mem} GiB is too small.`);
      const fit = [...modern.values()].filter(s => s.cores >= vcpu && s.mem >= mem).sort((a, b) => a.row.retailPrice - b.row.retailPrice || a.mem - b.mem);
      if (!fit.length) throw new PricingError(`No Current HDInsight node size in ${ctx.region} has ${vcpu} vCPUs and ${mem} GiB of memory. Ask for fewer vCPUs or less memory.`);
      return fit[0];
    };

    const G = 'Analytics', lines = [], notes = [];
    let cores = 0;
    const add = (role, count, vcpu, mem) => {
      const s = pickSize(vcpu, mem, role);
      cores += s.cores * count;
      lines.push(meterLine(G, SVC, `${count} ${role} node(s), ${s.name} (${s.cores} vCPU / ${s.mem} GiB) x ${fmtN(hours)} hours`, [s.row], count * hours, ctx, { unit: 'node-hours' }));
    };
    const [mc, mm] = MIN[ct];
    add('worker', worker, n(c.workerVcpu ?? mc), n(c.workerMemoryGiB ?? mm));
    add('head', 2, n(c.headVcpu ?? mc), n(c.headMemoryGiB ?? mm));
    if (n(c.edgeNodes)) add('edge', n(c.edgeNodes), n(c.edgeVcpu ?? 4), n(c.edgeMemoryGiB ?? 16));

    // ZooKeeper and ID Broker nodes are sized by HDInsight, not chosen by the customer.
    if (BILLED_ZK.has(ct)) {
      const zk = all.filter(r => r.productName === 'HDInsight Av2 Series' && r.skuName === ZK_SIZE);
      if (!zk.length) throw new PricingError(`No HDInsight ZooKeeper node price (${ZK_SIZE}) in ${ctx.region}.`);
      cores += ZK_CORES * 3;
      lines.push(meterLine(G, SVC, `3 ZooKeeper node(s), ${ZK_SIZE} (sized by HDInsight) x ${fmtN(hours)} hours`, zk, 3 * hours, ctx, { unit: 'node-hours' }));
      notes.push('HDInsight sizes the ZooKeeper nodes of HBase, Interactive Query and Kafka clusters itself (Learn lists A4_v2 as the default and minimum), so they are priced at that size even though the Av2 series is on the VM End of Life list; they are not a customer choice.');
    } else {
      cores += ZK_FREE_CORES * 3;
      notes.push('Hadoop and Spark clusters get three ZooKeeper nodes at no charge: HDInsight provides A2_v2 ZooKeeper nodes free of charge. They are not on the bill, but their cores count for the Enterprise Security Package.');
    }

    if (c.enterpriseSecurity) {
      const esp = await query(`serviceName eq '${SVC}' and priceType eq 'Consumption' and productName eq 'HDInsight Add-on Software' and skuName eq 'Enterprise Security Package'`, ctx.currency);
      if (!esp.length) throw new PricingError('No Enterprise Security Package surcharge found.');
      lines.push(meterLine(G, SVC, `Enterprise Security Package: ${fmtN(cores)} cores x ${fmtN(hours)} hours`, esp, cores * hours, ctx, { unit: 'core-hours' }));
      notes.push('The Enterprise Security Package surcharge is applied to the total cores of all nodes in the cluster, including the ZooKeeper nodes.');
    }
    if (c.idBroker) {
      const ib = all.filter(r => r.productName === 'HDInsight ID Broker');
      if (!ib.length) throw new PricingError(`HDInsight ID Broker is not priced in ${ctx.region}.`);
      lines.push(meterLine(G, SVC, `ID Broker: 2 nodes (A2 v2, sized by HDInsight) x ${fmtN(hours)} hours`, ib, 2 * hours, ctx, { unit: 'node-hours' }));
      notes.push('Enabling ID Broker adds two broker nodes; HDInsight sets their size (Learn template: Standard_A2_V2, an Av2 size on the VM End of Life list), so they are priced as documented and are not a customer choice.');
    }
    if (disks > 0) {
      const d = DISKS[tier];
      const dm = all.filter(r => r.productName === 'HDInsight Storage' && r.skuName === d.sku && r.meterName === `${d.sku} Disk`);
      if (!dm.length) throw new PricingError(`No ${d.label} managed disk price in ${ctx.region}.`);
      lines.push(meterLine(G, SVC, `${fmtN(disks)} x ${d.label} managed disk(s), per month`, dm, disks, ctx, { unit: 'disk-months' }));
      if (n(c.diskOperations)) {
        const op = all.filter(r => r.productName === 'HDInsight Storage' && r.meterName === 'Operations');
        if (!op.length) throw new PricingError(`No managed disk operations price in ${ctx.region}.`);
        lines.push(meterLine(G, SVC, `Managed disk operations, ${fmtN(n(c.diskOperations) * 1000)} per month`, op.slice(0, 1), n(c.diskOperations) * 1000, ctx, { unit: '10K operations' }));
      }
    }

    notes.push('HDInsight node prices are all-in per node-hour: the virtual machine and the HDInsight service fee are one meter, so do not add vm components for the cluster nodes. Billing is pro-rated per minute from creation until the cluster is deleted; a cluster cannot be paused. Node sizes are picked from Current VM series that meet the vCPU and memory asked for.');
    if (ct === 'kafka') notes.push('The Kafka surcharge meter is $0, so Kafka costs the same per node as other cluster types.');
    return { lines, notes, facts: { clusterType: ct, hours, workerNodes: worker, cores, enterpriseSecurity: !!c.enterpriseSecurity } };
  }
};
