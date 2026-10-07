'use strict';
// Azure Backup: protected-instance fees for every workload the calculator offers, vault storage
// (Standard and Archive tier) by redundancy, Blob/Data Lake write operations, and
// backup storage reserved capacity (100 TB / 1 PB blocks, 1 or 3 years).
// Meters: serviceName 'Backup', regional. Instance fees are per instance per month, and the number of
// billable instances depends on the size of each protected item (rules below, from the Azure Backup
// pricing page). Vault storage is per GB per month, separate from instance fees.
const { rows, single, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);
const GB_PER_TB = 1024;

// How many billable instances one protected item of `size` GB counts as.
const WORKLOADS = {
  vm: { label: 'Azure virtual machines', meter: 'Azure VM Protected Instance', tier: 'standard', archive: true,
    units: s => (s <= 50 ? 0.5 : Math.ceil(s / 500)), rule: 'up to 50 GB counts as half an instance; each further 500 GB (or part of 500 GB) counts as one' },
  'on-prem': { label: 'on-premises servers (MARS agent, DPM or MABS)', meter: 'On Premises Server Protected Instance', tier: 'standard', archive: false,
    units: s => (s <= 50 ? 0.5 : Math.ceil(s / 500)), rule: 'up to 50 GB counts as half an instance; each further 500 GB (or part of 500 GB) counts as one' },
  'sql-vm': { label: 'SQL Server in Azure VMs', meter: 'SQL Server in Azure VM Protected Instance', tier: 'standard', archive: true,
    units: s => Math.max(1, Math.ceil(s / 500)), rule: 'one instance per 500 GB (or part of 500 GB) of databases' },
  'sql-vm-snapshot': { label: 'SQL Server in Azure VMs (instance snapshot backup)', meter: 'SQL Server in Azure VM Snapshot Instance', tier: 'standard', archive: false,
    units: s => Math.min(40, Math.max(1, Math.ceil(s / 500))), rule: 'one instance per 500 GB (or part) of disks, capped at 40 instances (20 TB flat)' },
  'sap-hana': { label: 'SAP HANA in Azure VMs (Backint)', meter: 'SAP HANA on Azure VM Protected Instance', tier: 'standard', archive: true,
    units: () => 1, rule: 'flat fee per HANA instance, whatever its size' },
  'sap-hana-snapshot': { label: 'SAP HANA in Azure VMs (snapshot backup)', meter: 'SAP HANA on Azure VM Snapshot Instance', tier: 'standard', archive: false,
    units: s => Math.max(1, Math.ceil(s / (5 * GB_PER_TB))), rule: 'one instance per 5 TB (or part of 5 TB)' },
  'sap-ase': { label: 'SAP ASE (Sybase) in Azure VMs', meter: 'SAP ASE on Azure VM Protected Instance', tier: 'standard', archive: true,
    units: () => 1, rule: 'flat fee per ASE instance, whatever its size' },
  files: { label: 'Azure Files (snapshot backup)', meter: 'Azure Files Protected Instance', tier: null, archive: false,
    units: s => (s <= 250 ? 0.6 : 1), rule: 'a storage account with up to 250 GB of protected shares counts as 60% of an instance; larger counts as one. Snapshot storage is billed under Azure Files, not Backup' },
  'files-vaulted': { label: 'Azure Files (vaulted backup)', meter: 'Azure Files Vaulted Protected Instance', tier: 'filesVaulted', archive: false,
    units: s => vaultedBand(s), rule: 'by storage-account size: under 10 GB 10%, 10-100 GB 30%, 100 GB-1 TB 60%, 1 TB or more 100% of an instance' },
  blob: { label: 'Azure Blob storage (vaulted backup)', meter: 'Azure Blob Protected Instance', tier: 'vaulted', archive: false, writes: 'Azure Blob',
    units: s => vaultedBand(s), rule: 'by storage-account size: under 10 GB 10%, 10-100 GB 30%, 100 GB-1 TB 60%, 1 TB or more 100% of an instance' },
  adls: { label: 'Azure Data Lake Storage (vaulted backup)', meter: 'ADLS Gen2 Vaulted Protected Instance', tier: 'vaulted', archive: false, writes: 'ADLS Gen2 Vaulted',
    units: s => vaultedBand(s), rule: 'by storage-account size: under 10 GB 10%, 10-100 GB 30%, 100 GB-1 TB 60%, 1 TB or more 100% of an instance' },
  postgresql: { label: 'Azure Database for PostgreSQL', meter: 'PostgreSQL Protected Instance', tier: 'standard', archive: true,
    units: s => Math.max(1, Math.ceil(s / 250)), rule: 'one instance per 250 GB (or part of 250 GB)' },
  aks: { label: 'Azure Kubernetes Service', meter: 'AKS Namespace', tier: 'standard', archive: false,
    units: () => 1, rule: 'billed per namespace backed up, not by size' },
  cosmos: { label: 'Azure Cosmos DB (vaulted backup)', meter: 'Cosmos DB Protected Instance', tier: 'standard', archive: false,
    units: s => Math.max(1, Math.ceil(s / 500)), rule: 'one instance per 500 GB (or part of 500 GB) of source data' }
};

function vaultedBand(s) {
  if (s < 10) return 0.1;
  if (s < 100) return 0.3;
  if (s < GB_PER_TB) return 0.6;
  return 1;
}

const RED = { lrs: 'LRS', zrs: 'ZRS', grs: 'GRS', 'ra-grs': 'RA-GRS' };
const RED_WORDS = { lrs: 'locally redundant (LRS)', zrs: 'zone redundant (ZRS)', grs: 'geo-redundant (GRS)', 'ra-grs': 'geo-redundant with read access (RA-GRS)' };

module.exports = {
  type: 'backup',
  label: 'Azure Backup',
  family: 'management',
  calculator: ['backup'],
  keywords: ['backup', 'back up', 'protect vms', 'restore', 'recovery vault', 'disaster recovery', 'retention', 'sql backup', 'sap hana backup'],
  fields: {
    workload: { req: true, enum: Object.keys(WORKLOADS), ask: 'What do you want to back up? vm = Azure virtual machines, on-prem = on-premises servers, sql-vm = SQL Server inside an Azure VM, sql-vm-snapshot = the same with instance snapshots, sap-hana / sap-hana-snapshot = SAP HANA in an Azure VM, sap-ase = SAP ASE, files = Azure Files shares (snapshot backup), files-vaulted = Azure Files shares in a vault, blob = Azure Blob storage (vaulted), adls = Data Lake Storage (vaulted), postgresql = PostgreSQL servers, aks = Kubernetes clusters, cosmos = Cosmos DB accounts. One component covers one kind of workload; add a component for each other kind.' },
    instances: { req: true, ask: 'How many of them (servers, VMs, storage accounts, databases servers, clusters or Cosmos DB accounts)?' },
    sizeGB: { def: 100, min: 1, ask: 'What is the average amount of data on each one, in GB (the used data, not the disk size)? It sets how many billable instances each counts as. If unknown, suggest 100 GB and record it as an assumption. Not needed for SAP HANA/ASE (backint) or Kubernetes.' },
    namespaces: { def: 1, int: true, min: 1, ask: 'Kubernetes only: how many namespaces per cluster do you want protected?' },
    storageGB: { req: true, min: 0, ask: 'How much backup data will sit in the vault in total, in GB (all restore points together)? Vault storage is often the biggest part of the bill, so please give a number (use 0 only for Azure Files snapshot backup, which has no vault). If unknown, suggest about twice the source data for 30 days of daily backups and record it as an assumption.' },
    archiveGB: { def: 0, ask: 'Only for long-term retention (monthly or yearly backups kept more than 6 months): how many GB of that vault data do you move to the cheaper Archive tier?' },
    redundancy: { def: 'grs', enum: ['lrs', 'zrs', 'grs', 'ra-grs'], ask: 'How safe must the backup copies be? Within one datacenter only (cheapest) -> lrs; across zones in the region -> zrs; copy in a second region -> grs (the usual choice); second region you can also read from, for cross-region restore -> ra-grs.' },
    writeOperations: { def: 0, ask: 'Blob and Data Lake backups only: how many write operations a month happen on the protected storage account (uploads and changes)? If unknown, suggest 1,000,000 and record it as an assumption.' },
    commitment: { def: 'payg', enum: ['payg', '1y', '3y'], ask: 'Will you commit to a lot of backup storage for 1 or 3 years to save money (only worthwhile from 100 TB)? No -> payg; 1 year -> 1y; 3 years -> 3y.' },
    reserved100TB: { def: 0, int: true, min: 0, ask: 'With a commitment: how many 100 TB blocks of backup storage do you reserve?' },
    reserved1PB: { def: 0, int: true, min: 0, ask: 'With a commitment: how many 1 PB blocks of backup storage do you reserve?' }
  },
  context: ['production', 'zoneResilience'],
  readback: c => {
    const w = WORKLOADS[c.workload] || { label: c.workload };
    const parts = [`${fmtN(n(c.instances))} ${w.label}`];
    if (!['sap-hana', 'sap-ase', 'aks'].includes(c.workload)) parts.push(`about ${fmtN(n(c.sizeGB ?? 100))} GB each`);
    if (c.workload === 'aks') parts.push(`${fmtN(n(c.namespaces ?? 1))} namespace(s) per cluster`);
    parts.push(`${fmtN(n(c.storageGB))} GB of vault backup data${n(c.archiveGB) ? ` plus ${fmtN(c.archiveGB)} GB in the Archive tier` : ''}`);
    parts.push(`${RED_WORDS[c.redundancy || 'grs']} storage`);
    if (n(c.writeOperations)) parts.push(`${fmtN(c.writeOperations)} write operations a month`);
    if (c.commitment && c.commitment !== 'payg') {
      const r = [n(c.reserved100TB) ? `${fmtN(c.reserved100TB)} x 100 TB` : '', n(c.reserved1PB) ? `${fmtN(c.reserved1PB)} x 1 PB` : ''].filter(Boolean).join(' and ');
      parts.push(`${c.commitment === '1y' ? '1-year' : '3-year'} storage commitment of ${r || 'no capacity'}`);
    }
    return `Backup of ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('backup-snapshots') ? [] : [
    'Instant-restore snapshots of VMs and Azure Disk Backup snapshots (billed under Managed Disks)',
    'Azure Files snapshot storage (billed under Azure Files)',
    'Restore charges: Archive-tier retrieval, Cosmos DB restore per GB, and blob point-in-time restore'
  ],
  examples: [
    { type: 'backup', workload: 'vm', instances: 10, sizeGB: 200, storageGB: 4000, redundancy: 'grs' },
    { type: 'backup', workload: 'blob', instances: 2, sizeGB: 2000, storageGB: 3000, archiveGB: 0, redundancy: 'zrs', writeOperations: 5000000, commitment: 'payg' },
    { type: 'backup', workload: 'sql-vm', instances: 3, sizeGB: 1200, storageGB: 6000, archiveGB: 2000, redundancy: 'lrs' },
    { type: 'backup', workload: 'postgresql', instances: 2, sizeGB: 300, storageGB: 800, archiveGB: 400, redundancy: 'grs' },
    { type: 'backup', workload: 'aks', instances: 2, namespaces: 5, storageGB: 200, redundancy: 'grs' },
    { type: 'backup', workload: 'vm', instances: 500, sizeGB: 300, storageGB: 120000, redundancy: 'lrs', commitment: '1y', reserved100TB: 1 }
  ],
  price: async (c, ctx) => {
    const wk = WORKLOADS[c.workload];
    if (!wk) throw new PricingError(`Unknown backup workload "${c.workload}". Use one of: ${Object.keys(WORKLOADS).join(', ')}.`);
    const red = (c.redundancy || 'grs').toLowerCase();
    if (!RED[red]) throw new PricingError(`Unknown redundancy "${c.redundancy}". Use lrs, zrs, grs or ra-grs.`);
    const commitment = (c.commitment || 'payg').toLowerCase();
    const inst = n(c.instances), size = n(c.sizeGB ?? 100), storage = n(c.storageGB), archive = n(c.archiveGB);
    if (n(c.reserved100TB) + n(c.reserved1PB) > 0 && commitment === 'payg') throw new PricingError('Reserved capacity needs commitment "1y" or "3y".');
    if (commitment !== 'payg' && !(n(c.reserved100TB) + n(c.reserved1PB) > 0)) throw new PricingError('A commitment needs reserved100TB or reserved1PB of at least 1.');
    if (archive && !wk.archive) throw new PricingError(`Archive tier is not available for ${wk.label}.`);
    if (n(c.writeOperations) && !wk.writes) throw new PricingError('Write operations are charged only for Blob and Data Lake backups.');

    if (wk.writes && red === 'ra-grs') throw new PricingError('Blob and Data Lake vaulted backup is not offered with RA-GRS. Use lrs, zrs or grs.');
    const rs = await rows(`serviceName eq 'Backup' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Backup is not priced in ${ctx.region}.`);
    const byName = name => rs.filter(r => r.meterName === name);
    const G = 'Management', S = 'Backup', lines = [], notes = [];

    // Protected instances
    const unitsEach = wk.units(size);
    const billable = c.workload === 'aks' ? inst * n(c.namespaces ?? 1) : inst * unitsEach;
    const pi = single(byName(wk.meter), `${wk.label} protected instance`);
    if (c.workload === 'aks') {
      lines.push(meterLine(G, S, `Backup for Kubernetes: ${fmtN(inst)} cluster(s) x ${fmtN(n(c.namespaces ?? 1))} namespace(s) = ${fmtN(billable)} protected namespaces`, pi, billable, ctx, { unit: 'namespaces / month' }));
    } else if (c.workload === 'sap-hana' || c.workload === 'sap-ase') {
      lines.push(meterLine(G, S, `${wk.label}: ${fmtN(inst)} protected instance(s), flat fee`, pi, inst, ctx, { unit: 'instances / month' }));
    } else {
      lines.push(meterLine(G, S, `${wk.label}: ${fmtN(inst)} protected instance(s) of about ${fmtN(size)} GB = ${fmtN(billable)} billable instance(s)`, pi, billable, ctx, { unit: 'instances / month' }));
    }
    notes.push(`Protected instances (${wk.label}): ${wk.rule}. This is separate from vault storage.`);

    // Vault storage
    const redLabel = RED[red];
    const stdName = { standard: `Standard ${redLabel} Data Stored`, vaulted: `Standard ${redLabel} Data Stored`, filesVaulted: `Azure Files Vaulted ${redLabel} Data Stored` }[wk.tier];
    let payg = storage, reservedGB = 0;
    if (storage && !wk.tier) throw new PricingError('Azure Files snapshot backup keeps snapshots in your storage account (billed under Azure Files), so there is no vault storage. Use storageGB 0 or choose files-vaulted.');
    if (commitment !== 'payg') {
      if (!wk.tier) throw new PricingError('Backup storage reserved capacity covers vault storage, and Azure Files snapshot backup has none. Use files-vaulted, or choose payg.');
      const term = commitment === '1y' ? '1 Year' : '3 Years';
      const months = termMonths(term);
      const res = (await rows(`serviceName eq 'Backup' and ${regionFilter(ctx)} and priceType eq 'Reservation'`, ctx));
      for (const [qty, tb, label] of [[n(c.reserved100TB), '100 TB', '100 TB'], [n(c.reserved1PB), '1 PB', '1 PB']]) {
        if (!qty) continue;
        const rr = res.find(r => r.skuName === `Standard - ${tb} ${redLabel}` && r.reservationTerm === term);
        if (!rr) throw new PricingError(`No ${term} ${label} ${redLabel} backup storage reservation in ${ctx.region}.`);
        const monthly = rr.retailPrice / months;
        lines.push(line(G, S, `Backup storage reservation: ${fmtN(qty)} x ${label} ${redLabel}, ${term.toLowerCase()}`, qty, `${label} blocks / month`, monthly, monthly * qty, meterInfo(rr), { termTotal: rr.retailPrice }));
        reservedGB += qty * (tb === '100 TB' ? 100 : 1024) * GB_PER_TB;
      }
      notes.push(`Storage reservation: the listed price is the whole-term price for one block, divided by ${months} months. It is billed whether or not the capacity is used, and covers vault-standard-tier ${redLabel} data (VMs, databases, Azure Files vaulted, Blob and Data Lake backups), not Archive-tier data; storage inside the reservation is not also billed pay-as-you-go (100 TB = ${fmtN(100 * GB_PER_TB)} GB, 1 PB = ${fmtN(1024 * GB_PER_TB)} GB).`);
      if (wk.tier !== 'standard') notes.push('Microsoft documents backup storage reservations for the vault-standard tier, which includes this workload; the public price list does not show which usage meter a reservation applies to, so confirm with Microsoft before quoting.');
      payg = Math.max(0, storage - reservedGB);
    }
    if (payg > 0) {
      const m = single(byName(stdName), `${wk.label} vault storage (${redLabel})`);
      lines.push(meterLine(G, S, `Backup vault storage, ${redLabel}: ${fmtN(payg)} GB${reservedGB ? ' beyond the reservation' : ''}`, m, payg, ctx, { unit: 'GB / month' }));
    }
    if (archive) {
      if (red === 'zrs') throw new PricingError('The Archive tier is offered for LRS and GRS only (not ZRS).');
      const archRed = red === 'ra-grs' ? 'GRS' : redLabel;
      const m = single(byName(`Archive ${archRed} Data Stored`), `Archive tier storage (${archRed})`);
      lines.push(meterLine(G, S, `Backup Archive tier storage, ${archRed}: ${fmtN(archive)} GB`, m, archive, ctx, { unit: 'GB / month' }));
      notes.push('Archive-tier data has a 180-day minimum: deleting it earlier still bills the remaining days (prorated). Restoring from Archive adds a one-time retrieval fee.');
    }
    if (wk.writes) {
      const ops = n(c.writeOperations);
      const m = single(byName(`${wk.writes} ${redLabel} Write Operations`), `${wk.label} write operations (${redLabel})`);
      if (ops) lines.push(meterLine(G, S, `Backup write operations on the protected account, ${redLabel}: ${fmtN(ops)}/month`, m, ops, ctx, { unit: 'operations' }));
      else notes.push('Blob and Data Lake backups also charge for write operations (per 10,000) on the protected account; none are included in this estimate.');
    }
    notes.push('Restoring from the Standard tier is free of charge (no transaction or egress fee).');
    return { lines, notes, facts: { workload: c.workload, instances: inst, billableInstances: billable, sizeGB: size, storageGB: storage, archiveGB: archive, redundancy: red, commitment, reservedGB } };
  }
};


