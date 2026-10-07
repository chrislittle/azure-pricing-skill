'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS_PER_MONTH = 730;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function horizonDb({ region, currency = 'USD', vcores, replicas = 1, storageGb, backupGb = 0, hours = HOURS_PER_MONTH }) {
  const rows = dedupe(await query(`contains(productName, 'HorizonDB') and armRegionName eq '${region}'`, currency));
  const compute = pickOne(rows, r => r.productName === 'Azure HorizonDB Compute' && r.skuName === '1 vCore' && r.meterName === '1 vCore' && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption', 'HorizonDB 1 vCore compute');
  const storage = pickOne(rows, r => r.productName === 'Azure HorizonDB Storage' && r.skuName === 'HorizonDB storage' && r.meterName === 'HorizonDB Storage Data Stored' && r.unitOfMeasure === '1 GB/Month' && r.type === 'Consumption', 'HorizonDB storage');
  const backup = pickOne(rows, r => r.productName === 'Azure HorizonDB Backup Storage' && r.skuName === 'HorizonDB Backup Storage' && r.meterName === 'HorizonDB Backup Storage Data Stored' && r.unitOfMeasure === '1 GB/Month' && r.type === 'Consumption', 'HorizonDB backup storage');
  const billableBackupGb = Math.max(0, backupGb - storageGb);
  const lines = [
    line(`Compute: ${vcores} vCore(s) * ${replicas} replica(s) * ${hours} hours * ${compute.retailPrice}`, (vcores * replicas * hours / unitSize(compute.unitOfMeasure)) * compute.retailPrice, { meterId: compute.meterId }),
    line(`Storage: ${storageGb} GB * ${storage.retailPrice}`, (storageGb / unitSize(storage.unitOfMeasure)) * storage.retailPrice, { meterId: storage.meterId }),
  ];
  if (backupGb) {
    lines.push(line(`Backup over included database size: max(0, ${backupGb} - ${storageGb}) GB * ${backup.retailPrice}`, (billableBackupGb / unitSize(backup.unitOfMeasure)) * backup.retailPrice, { meterId: backup.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'horizondb',
  source: 'retail-api',
  cases: [
    {
      name: 'single 2-vcore replica with storage and included backup',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'horizondb', vcores: 2, replicas: 1, storageGb: 100, backupGb: 99 },
      // Retail API meters: 1 vCore hourly compute, HorizonDB Storage per GB-month, and backup is free up to database size so 99 <= 100 bills 0 backup GB.
      expected: async () => horizonDb({ region: 'eastus2', vcores: 2, replicas: 1, storageGb: 100, backupGb: 99 }),
    },
    {
      name: 'backup just above included database size',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'horizondb', vcores: 4, replicas: 2, storageGb: 100, backupGb: 101 },
      // Retail API backup meter is per GB-month; only backup above storage is billed, so 101 - 100 = 1 GB.
      expected: async () => horizonDb({ region: 'eastus2', vcores: 4, replicas: 2, storageGb: 100, backupGb: 101 }),
    },
    {
      name: 'large vcore shape and three replicas',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'horizondb', vcores: 32, replicas: 3, storageGb: 1024, backupGb: 2048 },
      // Compute is published as a 1-vCore hourly meter and scales by vcores * replicas; storage is counted once and backup bills the 1,024 GB excess.
      expected: async () => horizonDb({ region: 'eastus2', vcores: 32, replicas: 3, storageGb: 1024, backupGb: 2048 }),
    },
    {
      name: 'replicas 16 boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'horizondb', vcores: 2, replicas: 16, storageGb: 100, backupGb: 100 },
      // Retail API compute is a per-vCore hourly meter and each of 16 replicas is billed at the full vCore price; storage is still counted once and backup equal to storage is free.
      expected: async () => horizonDb({ region: 'eastus2', vcores: 2, replicas: 16, storageGb: 100, backupGb: 100 }),
    },
    {
      name: 'part-time compute with full-month storage',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'horizondb', vcores: 8, replicas: 2, storageGb: 250, backupGb: 0, hours: 100 },
      // Retail API compute is hourly and uses the component hours; storage remains a monthly GB charge.
      expected: async () => horizonDb({ region: 'eastus2', vcores: 8, replicas: 2, storageGb: 250, backupGb: 0, hours: 100 }),
    },
    {
      name: 'west europe regional prices',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'horizondb', vcores: 4, replicas: 2, storageGb: 100, backupGb: 150 },
      // Retail API West Europe HorizonDB compute/storage/backup rows have distinct regional prices from East US 2.
      expected: async () => horizonDb({ region: 'westeurope', vcores: 4, replicas: 2, storageGb: 100, backupGb: 150 }),
    },
    {
      name: 'eur two replicas with backup excess',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'horizondb', vcores: 4, replicas: 2, storageGb: 100, backupGb: 125 },
      // EUR Retail API rows are queried natively; compute is hourly and backup bills 25 GB above the included database size.
      expected: async () => horizonDb({ region: 'westeurope', currency: 'EUR', vcores: 4, replicas: 2, storageGb: 100, backupGb: 125 }),
    },
  ],
};
