'use strict';
// Azure Managed Instance for Apache Cassandra: virtual-machine nodes, P30 data disks and extra backup copies.
// Meters: serviceName 'Azure Managed Instance for Apache Cassandra', one productName (... - Compute), regional.
// The "vCore" node meters are the price of ONE NODE (virtual machine) per hour, whatever the vCore count of the
// size: e.g. Standard_D8s_v4 = 0.48/hour is the 8-vCPU VM price plus 25%, not 0.48 per vCore.
// Each VM size is listed under several skuName spellings and generations ("D8s_v4" 2021, "Standard_D8s_v4" 2025); the
// deterministic policy below picks the price.
const { rows, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const SVC = 'Azure Managed Instance for Apache Cassandra';

// "Apache_Cassandra_Standard_E8s_v5", "Standard E8s V5" and "e8s_v5" are the same size.
// Sizes the Azure pricing calculator and pricing page offer; older Retail meters (NP, L v2, a/ds v4, DS4/DS5/D15) are legacy.
const CURRENT = /^([de]\d+(a|ad)?sv5|l\d+a?sv3|[de]\d+sv4|e\d+v4|ds1[34]v2)$/;
const norm = s => String(s || '').toLowerCase().replace(/apache_cassandra_/g, '').replace(/standard/g, '').replace(/[^a-z0-9]/g, '');

const vcpus = k => { const m = k.match(/^[a-z]+(\d+)/); const v = m ? Number(m[1]) : 0; return k.startsWith('ds13') ? 8 : k.startsWith('ds14') ? 16 : v; };

module.exports = {
  type: 'cassandra-mi',
  label: 'Azure Managed Instance for Apache Cassandra',
  family: 'data-platform',
  calculator: ['managed-instance-apache-cassandra'],
  keywords: ['cassandra', 'apache cassandra', 'nosql', 'wide column', 'managed cassandra', 'cql', 'managed instance for apache cassandra'],
  fields: {
    nodeSize: { req: true, ask: 'How powerful should each Cassandra server (node) be? Ask for CPU cores and memory per node (Microsoft says most workloads need at least 16 cores) and whether the workload is memory-heavy (most databases), general-purpose, or needs very fast local storage. Map to a size: 16 cores and 128 GB memory-heavy = Standard_E16s_v5; 8 cores and 64 GB = Standard_E8s_v5; 16 cores and 64 GB general-purpose = Standard_D16s_v5; 8 cores and 32 GB = Standard_D8s_v5; 32 cores and 256 GB = Standard_E32s_v5; storage-heavy 16 cores = Standard_L16s_v3. If unknown, suggest Standard_E16s_v5 and record it as an assumption. If the person names a size, use it.' },
    nodesPerDatacenter: { req: true, int: true, min: 3, ask: 'How many Cassandra nodes (servers) in each datacenter? The service needs at least 3, and 3, 6, 9... is best so data is copied to three nodes. If unknown, suggest 3 and record it as an assumption.' },
    datacenters: { def: 1, int: true, min: 1, ask: 'How many datacenters (regions or zones) does the Cassandra cluster span? Each datacenter has its own full set of nodes. If one region, 1.' },
    disksPerNode: { def: 4, int: true, min: 1, ask: 'How many 1 TB data disks (P30) on each node? Total space per node is this number in TB; plan to use at most half of it because Cassandra needs headroom, and Microsoft strongly recommends at least four disks per node. If unknown, use 4 and record it as an assumption.' },
    backupCopies: { def: 2, int: true, min: 0, ask: 'How many backup copies of the data are kept? Two are included free; only ask if they want more than two.' },
    backupGbPerCopy: { def: 0, min: 0, ask: 'Only if keeping more than two backup copies: how many GB is one backup copy of the data (roughly the size of the data stored in the cluster)? Extra copies beyond two are charged per GB.' },
    hours: { def: 730, ask: 'Only if the cluster runs part-time: how many hours a month are the nodes running? Leave at 730 for always on. Disks are billed all month either way.' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'cassandra-mi', nodeSize: 'Standard_E16s_v5', nodesPerDatacenter: 3 },
    { type: 'cassandra-mi', nodeSize: 'Standard_D16s_v5', nodesPerDatacenter: 6, datacenters: 2, disksPerNode: 8, backupCopies: 4, backupGbPerCopy: 500, hours: 730 }
  ],
  readback: c => {
    const dcs = n(c.datacenters) || 1, nodes = n(c.nodesPerDatacenter);
    const parts = [`${fmtN(nodes)} node${nodes === 1 ? '' : 's'} per datacenter in ${fmtN(dcs)} datacenter${dcs === 1 ? '' : 's'} (${fmtN(nodes * dcs)} nodes in total), each node on virtual machine size ${c.nodeSize}`,
      `${fmtN(c.disksPerNode ?? 4)} 1 TB data disk(s) per node`];
    if (n(c.backupCopies ?? 2) > 2 && n(c.backupGbPerCopy)) parts.push(`${fmtN(c.backupCopies)} backup copies of ${fmtN(c.backupGbPerCopy)} GB each (the first two copies are free)`);
    parts.push(`${fmtN(c.hours ?? HOURS)} hours a month`);
    return `Managed Cassandra: ${parts.join(', ')}`;
  },
  notIncluded: () => ['Data transfer out of the region and between datacenters (billed separately under bandwidth)', 'The virtual network the cluster is deployed into'],
  price: async (c, ctx) => {
    const dcs = n(c.datacenters) || 1, nodesPer = n(c.nodesPerDatacenter), disks = c.disksPerNode == null ? 4 : n(c.disksPerNode);
    const hours = c.hours ?? HOURS, copies = c.backupCopies == null ? 2 : n(c.backupCopies), backupGb = n(c.backupGbPerCopy);
    if (nodesPer < 3) throw new PricingError('Each Cassandra datacenter needs at least 3 nodes (nodesPerDatacenter).');
    const want = norm(c.nodeSize);
    if (!want) throw new PricingError('nodeSize is required, for example Standard_E8s_v5.');
    const all = await rows(`serviceName eq '${SVC}' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!all.length) throw new PricingError(`${SVC} is not priced in ${ctx.region}.`);
    const isVm = r => / vCore$/.test(r.meterName) && r.skuName !== 'VM Instance';
    const display = r => r.skuName.replace(/^Apache_Cassandra_/, '').replace(/^Standard[ _]/, 'Standard_').replace(/ /g, '_').replace(/_V5$/, '_v5');
    const vm = all.filter(r => isVm(r) && norm(r.skuName) === want);
    if (!vm.length || !CURRENT.test(want)) {
      const sizes = [...new Set(all.filter(r => isVm(r) && CURRENT.test(norm(r.skuName))).map(r => display(r).replace(/^(?!Standard_)/, 'Standard_')))].sort();
      throw new PricingError(`Node size "${c.nodeSize}" is not offered${vm.length ? ' (legacy size)' : ''} in ${ctx.region}. Current sizes: ${sizes.join(', ')}.`);
    }
    // Several meters can exist for one size and region. Deterministic policy:
    // 1) drop placeholder prices (below half the plain Linux pay-as-you-go VM price, or below 0.05 per hour);
    // 2) prefer meters on the current "Standard_<size>" naming; 3) otherwise take the highest price.
    const armNames = [...new Set(vm.map(r => 'Standard_' + r.skuName.replace(/^Apache_Cassandra_/, '').replace(/^Standard[ _]/, '').replace(/ /g, '_').replace(/_V(\d)/, '_v$1')))];
    const vmRows = (await rows(`serviceName eq 'Virtual Machines' and ${regionFilter(ctx)} and priceType eq 'Consumption' and (${armNames.map(a => `armSkuName eq '${a}'`).join(' or ')})`, ctx))
      .filter(r => !/windows|spot|low priority/i.test(`${r.productName} ${r.skuName} ${r.meterName}`) && n(r.retailPrice) > 0);
    const vmPrice = vmRows.length ? Math.min(...vmRows.map(r => n(r.retailPrice))) : 0;
    const floor = Math.max(0.05, vmPrice * 0.5);
    const plausible = vm.filter(r => n(r.retailPrice) >= floor);
    if (!plausible.length) throw new PricingError(`No usable price for ${c.nodeSize} in ${ctx.region}: the only meters found are placeholder prices (${[...new Set(vm.map(r => r.retailPrice))].join(', ')} per node-hour). Try another size or region.`);
    const std = plausible.filter(r => /^(Apache_Cassandra_)?Standard_/.test(r.skuName));
    const pool = std.length ? std : plausible;
    const best = pool.reduce((a, b) => n(b.retailPrice) > n(a.retailPrice) ? b : a);
    const node = vm.filter(r => r.meterId === best.meterId);
    const multi = new Set(vm.map(r => r.retailPrice)).size > 1;
    const G = 'Databases', lines = [], notes = [];
    const nodes = nodesPer * dcs;
    lines.push(meterLine(G, SVC, `Cassandra nodes, size ${c.nodeSize}: ${fmtN(nodesPer)} node(s) x ${fmtN(dcs)} datacenter(s) = ${fmtN(nodes)} nodes, ${fmtN(hours)} hours`, node, nodes * hours, ctx, { unit: 'hours' }));
    if (disks > 0) {
      const disk = all.filter(r => r.meterName === 'P30 Disk');
      if (!disk.length) throw new PricingError(`No P30 disk price found in ${ctx.region}.`);
      const total = nodes * disks;
      lines.push(meterLine(G, SVC, `P30 (1 TB) data disks: ${fmtN(disks)} per node x ${fmtN(nodes)} nodes = ${fmtN(total)} disks`, disk, total, ctx, { unit: 'disks / month' }));
    }
    const extra = Math.max(0, copies - 2) * backupGb;
    if (extra > 0) {
      const bk = all.filter(r => r.meterName === 'Backup Data Stored');
      if (!bk.length) throw new PricingError(`No backup storage price found in ${ctx.region}.`);
      lines.push(meterLine(G, SVC, `Backup copies beyond the 2 free: ${fmtN(copies - 2)} extra x ${fmtN(backupGb)} GB`, bk, extra, ctx, { unit: 'GB / month' }));
    }
    notes.push(`Each node is billed as one virtual machine per hour (${c.nodeSize}); the node price covers the VM plus the management of Cassandra, and the price is per node, not per vCPU.`);
    if (multi) notes.push(`Several meters exist for this size in ${ctx.region}; this estimate uses ${best.retailPrice} per node-hour (placeholder prices are ignored, then the current Standard_ naming is preferred, then the highest price). The Azure pricing calculator may show a different rate for this size.`);
    notes.push('Data disks are billed per disk per month and are not reduced by the hours setting.');
    notes.push('Two backup copies are free; only copies beyond two are charged per GB per month.');
    return { lines, notes, facts: { nodeSize: c.nodeSize, vcpus: vcpus(want), nodesMultipleOf3: nodesPer % 3 === 0, nodesPerDatacenter: nodesPer, datacenters: dcs, nodes, disksPerNode: disks, hours, backupCopies: copies } };
  }
};
