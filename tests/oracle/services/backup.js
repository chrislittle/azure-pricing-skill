'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'backup';

const WORKLOADS = {
  vm: { label: 'Azure virtual machines', offer: 'backup-azure-vm', storage: 'standard', units: sizeUnits500WithSmall },
  'on-prem': { label: 'on-premises servers', offer: 'backup-on-prem', storage: 'standard', units: sizeUnits500WithSmall },
  'sql-vm': { label: 'SQL Server in Azure VMs', offer: 'backup-sql-server', storage: 'standard', archive: true, units: sizeUnits500 },
  'sql-vm-snapshot': { label: 'SQL Server in Azure VMs snapshot', offer: 'backup-sql-server-snapshot', storage: 'standard', units: sqlSnapshotUnits },
  'sap-hana': { label: 'SAP HANA Backint', offer: 'backup-sap-server', storage: 'standard', archive: true, units: flatUnits },
  'sap-hana-snapshot': { label: 'SAP HANA snapshot', offer: 'backup-sap-server-snapshot', storage: 'standard', units: sapHanaSnapshotUnits },
  'sap-ase': { label: 'SAP ASE', offer: 'backup-sap-ase-azure-vm', storage: 'standard', archive: true, units: flatUnits },
  files: { label: 'Azure Files snapshot', offer: 'backup-file-server', storage: null, units: azureFilesSnapshotUnits },
  'files-vaulted': { label: 'Azure Files vaulted', offer: 'backup-file-vaulted', storage: 'vaulted', units: azureFilesVaultedUnits },
  blob: { label: 'Azure Blob vaulted', offer: 'backup-blobs', storage: 'standard', writes: 'backup-storage-redundancy', units: vaultedStorageAccountUnits },
  adls: { label: 'Azure Data Lake Storage vaulted', offer: 'backup-azure-data-lake-storage', storage: 'standard', writes: 'backup-azure-data-lake-storage-redundancy', units: vaultedStorageAccountUnits },
  postgresql: { label: 'Azure Database for PostgreSQL', offer: 'backup-postgresql-flexible-server', storage: 'standard', units: sizeUnits250 },
  aks: { label: 'Azure Kubernetes Service', offer: 'backup-kubernetes-service', storage: 'standard', units: aksNamespaceUnits },
  cosmos: { label: 'Azure Cosmos DB', offer: 'azure-cosmos-db', storage: 'standard', units: sizeUnits500 },
};

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function sizeUnits500WithSmall(sizeGB) {
  return sizeGB <= 50 ? 0.5 : Math.ceil(sizeGB / 500);
}

function sizeUnits500(sizeGB) {
  return Math.ceil(sizeGB / 500);
}

function sizeUnits250(sizeGB) {
  return Math.ceil(sizeGB / 250);
}

function sqlSnapshotUnits(sizeGB) {
  if (sizeGB > 20 * 1024) throw new Error('SQL Server snapshot backup supports up to 20 TB per protected instance');
  return Math.ceil(sizeGB / 512);
}

function sapHanaSnapshotUnits(sizeGB) {
  return Math.ceil(sizeGB / (5 * 1024));
}

function flatUnits() {
  return 1;
}

function azureFilesSnapshotUnits(sizeGB) {
  return sizeGB <= 250 ? 0.6 : 1;
}

function azureFilesVaultedUnits(sizeGB) {
  return vaultedStorageAccountUnits(sizeGB);
}

function vaultedStorageAccountUnits(sizeGB) {
  if (sizeGB < 10) return 0.1;
  if (sizeGB < 100) return 0.3;
  if (sizeGB < 1024) return 0.6;
  return 1;
}

function aksNamespaceUnits(_sizeGB, namespaces) {
  return namespaces;
}

function redKey(redundancy) {
  return String(redundancy).replace('-', '_');
}

async function offerValue(offer, region) {
  return (await calc.offerPrice(SLUG, offer, region)).value;
}

async function backupCalc({ region, workload, instances = 1, sizeGB = 100, namespaces = 1, storageGB = 0, archiveGB = 0, redundancy = 'grs', writeOperations = 0, commitment = 'payg', reserved100TB = 0, reserved1PB = 0 }) {
  const cfg = WORKLOADS[workload];
  if (!cfg) throw new Error(`unknown backup workload ${workload}`);
  const lines = [];

  const unitCount = cfg.units(sizeGB, namespaces);
  const protectedUnits = instances * unitCount;
  const protectedPrice = await offerValue(cfg.offer, region);
  lines.push(line(`${cfg.label}: ${instances} instance(s) * ${unitCount} protected unit(s) * ${protectedPrice}`, protectedUnits * protectedPrice, { sourceOffer: cfg.offer }));

  const reservedGB = commitment === 'payg' ? 0 : (reserved100TB * 100 * 1024) + (reserved1PB * 1024 * 1024);
  const paygStorageGB = commitment === 'payg' ? storageGB : Math.max(0, storageGB - reservedGB);

  if (paygStorageGB && cfg.storage) {
    const storageOffer = cfg.storage === 'vaulted' ? `backup-storage-vaulted-${redundancy}` : `backup-storage-standard-${redundancy}`;
    const price = await offerValue(storageOffer, region);
    lines.push(line(`Backup vault storage ${redundancy}: ${paygStorageGB} GB * ${price}`, paygStorageGB * price, { sourceOffer: storageOffer }));
  }

  if (archiveGB && cfg.archive) {
    const archiveOffer = `backup-storage-archive-${redundancy === 'lrs' ? 'lrs' : 'grs'}`;
    const price = await offerValue(archiveOffer, region);
    lines.push(line(`Backup archive storage ${redundancy}: ${archiveGB} GB * ${price}`, archiveGB * price, { sourceOffer: archiveOffer }));
  }

  if (writeOperations && cfg.writes) {
    const writesOffer = `${cfg.writes}-${redundancy}`;
    const price = await offerValue(writesOffer, region);
    lines.push(line(`Backup write operations ${redundancy}: ${writeOperations} / 10K * ${price}`, (writeOperations / 10000) * price, { sourceOffer: writesOffer }));
  }

  if (commitment !== 'payg') {
    const suffix = commitment === '1y' ? 'oneyear' : 'threeyear';
    const months = commitment === '1y' ? 12 : 36;
    const rk = redKey(redundancy);
    if (reserved100TB) {
      const offer = `reserved-capacity-hundred-tbpermonth-${rk}-${suffix}`;
      const price = await offerValue(offer, region);
      lines.push(line(`Reserved backup storage 100 TB ${redundancy} ${commitment}: ${reserved100TB} * ${price}/${months}`, reserved100TB * price / months, { sourceOffer: offer }));
    }
    if (reserved1PB) {
      const offer = `reserved-capacity-one-pbpermonth-${rk}-${suffix}`;
      const price = await offerValue(offer, region);
      lines.push(line(`Reserved backup storage 1 PB ${redundancy} ${commitment}: ${reserved1PB} * ${price}/${months}`, reserved1PB * price / months, { sourceOffer: offer }));
    }
  }

  return { monthlyList: totalOf(lines), lines };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function backupRetailVmEur({ region, instances = 1, sizeGB = 100, storageGB = 0, redundancy = 'GRS', currency = 'EUR' }) {
  const rows = dedupe(await query(`serviceName eq 'Backup' and armRegionName eq '${region}'`, currency));
  const pi = pickOne(rows, r => r.productName === 'Backup' && r.skuName === 'Azure VM' && r.meterName === 'Azure VM Protected Instance', 'Azure VM protected instance');
  const storage = pickOne(rows, r => r.productName === 'Backup' && r.skuName === 'Standard' && r.meterName === `Standard ${redundancy} Data Stored`, `${redundancy} data stored`);
  const units = instances * sizeUnits500WithSmall(sizeGB);
  const lines = [
    line(`EUR Azure VM protected units: ${units} * ${pi.retailPrice}`, units * pi.retailPrice, { meterId: pi.meterId }),
    line(`EUR Backup Standard ${redundancy} storage: ${storageGB} / ${unitSize(storage.unitOfMeasure)} * ${storage.retailPrice}`, (storageGB / unitSize(storage.unitOfMeasure)) * storage.retailPrice, { meterId: storage.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'backup',
  source: 'both',
  cases: [
    {
      name: 'Azure VM at 50 GB half-instance boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'vm', instances: 2, sizeGB: 50, storageGB: 100, redundancy: 'grs' },
      // Calculator backup-azure-vm is the >50-500 GB unit; Microsoft pricing page says <=50 GB is half that protected-instance charge, plus Standard GRS storage.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'vm', instances: 2, sizeGB: 50, storageGB: 100, redundancy: 'grs' }),
    },
    {
      name: 'Azure VM just above 500 GB boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'vm', instances: 1, sizeGB: 501, storageGB: 0 },
      // Microsoft pricing page: >500 GB is charged for each 500 GB increment; 501 GB is two backup-azure-vm units.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'vm', instances: 1, sizeGB: 501 }),
    },
    {
      name: 'on-premises servers use VM size bands',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'on-prem', instances: 2, sizeGB: 1200, storageGB: 100, redundancy: 'lrs' },
      // Calculator backup-on-prem shares the 50 GB / 500 GB protected-instance sizing rule; Standard LRS vault storage is separate.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'on-prem', instances: 2, sizeGB: 1200, storageGB: 100, redundancy: 'lrs' }),
    },
    {
      name: 'SQL in Azure VM with archive',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'sql-vm', instances: 2, sizeGB: 1200, storageGB: 100, archiveGB: 10, redundancy: 'grs' },
      // Calculator backup-sql-server is per 500 GB protected unit; add Standard GRS vault storage and Archive GRS for long-term retention.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'sql-vm', instances: 2, sizeGB: 1200, storageGB: 100, archiveGB: 10, redundancy: 'grs' }),
    },
    {
      name: 'SQL snapshot protected instances',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'sql-vm-snapshot', instances: 1, sizeGB: 500, storageGB: 100, redundancy: 'zrs' },
      // Calculator backup-sql-server-snapshot uses the same per-500 GB protected-unit sizing; Standard ZRS vault storage is charged per GB.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'sql-vm-snapshot', instances: 1, sizeGB: 500, storageGB: 100, redundancy: 'zrs' }),
    },
    {
      name: 'SQL snapshot at 20 TB cap',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'sql-vm-snapshot', instances: 1, sizeGB: 20480, storageGB: 0 },
      // SQL Server instance snapshot backup is capped at 20 TB; at the cap, bill 20,480 GB / 512 GB = 40 protected units.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'sql-vm-snapshot', instances: 1, sizeGB: 20480 }),
    },
    {
      name: 'SAP HANA Backint flat fee',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'sap-hana', instances: 2, storageGB: 100, archiveGB: 10, redundancy: 'grs' },
      // Calculator backup-sap-server is a flat Backint protected-instance fee; component size is not needed, with separate Standard and Archive storage.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'sap-hana', instances: 2, storageGB: 100, archiveGB: 10, redundancy: 'grs' }),
    },
    {
      name: 'SAP HANA snapshot flat fee',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'sap-hana-snapshot', instances: 1, storageGB: 100, redundancy: 'grs' },
      // Calculator backup-sap-server-snapshot publishes the SAP HANA snapshot protected-instance fee; no archive tier for snapshot backup.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'sap-hana-snapshot', instances: 1, storageGB: 100, redundancy: 'grs' }),
    },
    {
      name: 'SAP HANA snapshot just above 5 TB boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'sap-hana-snapshot', instances: 1, sizeGB: 5121, storageGB: 0 },
      // SAP HANA snapshot protected instances are billed per 5 TB block; 5,121 GB is two backup-sap-server-snapshot units.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'sap-hana-snapshot', instances: 1, sizeGB: 5121 }),
    },
    {
      name: 'SAP ASE flat fee with archive',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'sap-ase', instances: 1, storageGB: 100, archiveGB: 10, redundancy: 'grs' },
      // Calculator backup-sap-ase-azure-vm is a flat protected-instance fee; add Standard and Archive storage.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'sap-ase', instances: 1, storageGB: 100, archiveGB: 10, redundancy: 'grs' }),
    },
    {
      name: 'Azure Files snapshot backup has no vault storage',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'files', instances: 3, sizeGB: 1200, storageGB: 0 },
      // Microsoft Azure Files snapshot pricing: a protected storage account over 250 GB is one flat backup-file-server instance; snapshots stay in the storage account, so no vault storage line.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'files', instances: 3, sizeGB: 1200 }),
    },
    {
      name: 'Azure Files vaulted fractional protected instance',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'files-vaulted', instances: 1, sizeGB: 50, storageGB: 0 },
      // Microsoft Azure Files vaulted table: 10-100 GB is 30% of one backup-file-vaulted protected instance.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'files-vaulted', instances: 1, sizeGB: 50 }),
    },
    {
      name: 'Azure Files vaulted backup',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'files-vaulted', instances: 2, sizeGB: 1200, storageGB: 100, redundancy: 'ra-grs' },
      // Calculator backup-file-vaulted is flat per protected storage account; vaulted RA-GRS storage uses backup-storage-vaulted-ra-grs.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'files-vaulted', instances: 2, sizeGB: 1200, storageGB: 100, redundancy: 'ra-grs' }),
    },
    {
      name: 'Blob vaulted backup with write operations',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'blob', instances: 2, sizeGB: 1200, storageGB: 100, redundancy: 'grs', writeOperations: 10000 },
      // Calculator backup-blobs is flat per protected account; Blob vaulted backup data uses Standard GRS vault storage, and writes use the GRS 10K operation offer.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'blob', instances: 2, sizeGB: 1200, storageGB: 100, redundancy: 'grs', writeOperations: 10000 }),
    },
    {
      name: 'Blob vaulted 10 percent instance band',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'blob', instances: 1, sizeGB: 5, storageGB: 0 },
      // Blob vaulted protected-account sizing uses 10% of one backup-blobs instance below 10 GB.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'blob', instances: 1, sizeGB: 5 }),
    },
    {
      name: 'Blob vaulted 30 percent instance band',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'blob', instances: 1, sizeGB: 50, storageGB: 0 },
      // Blob vaulted protected-account sizing uses 30% from 10 GB up to 100 GB.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'blob', instances: 1, sizeGB: 50 }),
    },
    {
      name: 'Blob vaulted 60 percent instance band',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'blob', instances: 1, sizeGB: 500, storageGB: 0 },
      // Blob vaulted protected-account sizing uses 60% from 100 GB up to the calculator's 1,024 GB edge.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'blob', instances: 1, sizeGB: 500 }),
    },
    {
      name: 'Blob reserved capacity charges storage above reservation',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'blob', instances: 1, sizeGB: 1200, storageGB: 200000, redundancy: 'lrs', commitment: '3y', reserved100TB: 1 },
      // A 100 TB reservation covers 102,400 GB of Standard LRS vault storage; bill the remaining 97,600 GB PAYG plus the amortized 3-year reservation and Blob protected instance.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'blob', instances: 1, sizeGB: 1200, storageGB: 200000, redundancy: 'lrs', commitment: '3y', reserved100TB: 1 }),
    },
    {
      name: 'ADLS vaulted backup with write operations',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'adls', instances: 1, sizeGB: 1200, storageGB: 100, redundancy: 'zrs', writeOperations: 20000 },
      // Calculator backup-azure-data-lake-storage is flat per protected account; ADLS vaulted backup data uses Standard ZRS vault storage, and writes use the ZRS 10K operation offer.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'adls', instances: 1, sizeGB: 1200, storageGB: 100, redundancy: 'zrs', writeOperations: 20000 }),
    },
    {
      name: 'ADLS vaulted full instance at 1024 GB edge',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'adls', instances: 1, sizeGB: 1024, storageGB: 0 },
      // ADLS vaulted protected-account sizing reaches 100% at the calculator's 1,024 GB edge.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'adls', instances: 1, sizeGB: 1024 }),
    },
    {
      name: 'PostgreSQL just above 250 GB boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'postgresql', instances: 1, sizeGB: 251, storageGB: 100, redundancy: 'grs' },
      // Calculator backup-postgresql-flexible-server increments at 250 GB protected units; 251 GB is two units plus Standard GRS storage.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'postgresql', instances: 1, sizeGB: 251, storageGB: 100, redundancy: 'grs' }),
    },
    {
      name: 'AKS namespaces',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'aks', instances: 2, namespaces: 3, storageGB: 100, redundancy: 'grs' },
      // Calculator backup-kubernetes-service is per protected namespace; 2 clusters * 3 namespaces, plus Standard GRS vault storage.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'aks', instances: 2, namespaces: 3, storageGB: 100, redundancy: 'grs' }),
    },
    {
      name: 'Cosmos DB vaulted backup',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'cosmos', instances: 2, sizeGB: 1200, storageGB: 100, redundancy: 'grs' },
      // Calculator azure-cosmos-db uses 500 GB protected units; 1,200 GB is three units per account, plus Standard GRS storage.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'cosmos', instances: 2, sizeGB: 1200, storageGB: 100, redundancy: 'grs' }),
    },
    {
      name: 'reserved capacity one-year and three-year blocks',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'backup', workload: 'vm', instances: 1, sizeGB: 100, storageGB: 0, redundancy: 'lrs', commitment: '1y', reserved100TB: 1, reserved1PB: 1 },
      // Calculator reserved-capacity offers are whole-term prices; amortize one-year LRS 100 TB and 1 PB blocks over 12 months.
      expected: async () => backupCalc({ region: 'eastus2', workload: 'vm', instances: 1, sizeGB: 100, redundancy: 'lrs', commitment: '1y', reserved100TB: 1, reserved1PB: 1 }),
    },
    {
      name: 'non-US region with three-year reserved capacity',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'backup', workload: 'files-vaulted', instances: 1, sizeGB: 100, storageGB: 100, redundancy: 'grs', commitment: '3y', reserved100TB: 1 },
      // Calculator West Europe Files vaulted protected-instance fee plus GRS three-year reserved-capacity offer; reservation covers vault-standard storage, so do not add PAYG storage.
      expected: async () => backupCalc({ region: 'westeurope', workload: 'files-vaulted', instances: 1, sizeGB: 100, storageGB: 100, redundancy: 'grs', commitment: '3y', reserved100TB: 1 }),
    },
    {
      name: 'EUR Retail API Azure VM and storage',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'backup', workload: 'vm', instances: 1, sizeGB: 100, storageGB: 100, redundancy: 'grs' },
      // EUR Retail API Backup rows: Azure VM Protected Instance meter times one protected unit, plus Standard GRS Data Stored per GB-month.
      expected: async () => backupRetailVmEur({ region: 'westeurope', instances: 1, sizeGB: 100, storageGB: 100, redundancy: 'GRS', currency: 'EUR' }),
    },
  ],
};
