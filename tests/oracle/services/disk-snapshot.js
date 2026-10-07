'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS = 730;
const INSTANT_ACCESS_PROMO_FREE = true; // Microsoft pricing page: no instant-access storage charge through January 2027.
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice||String(a.meterName).localeCompare(String(b.meterName))); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
const PRODUCT = { 'standard-hdd':'Standard HDD Managed Disks', 'standard-ssd':'Standard SSD Managed Disks', 'premium-ssd':'Premium SSD Managed Disks', 'premium-ssd-v2':'Azure Premium SSD v2', ultra:'Ultra Disks' };
function snapshotProduct(c) {
  if (c.snapshotType === 'incremental' || (c.snapshotStorage ?? 'standard-hdd') === 'standard-hdd') return PRODUCT['standard-hdd'];
  return PRODUCT[c.sourceDiskType];
}
async function snapshotLine(region, c, currency) {
  if ((c.snapshotGB ?? 0) <= 0) return [];
  const product = snapshotProduct(c);
  const rows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq '${product}' and skuName eq 'Snapshots ${c.redundancy}'`, currency)).filter(x => x.type === 'Consumption');
  const snap = pick(rows, x => /Snapshots$/.test(x.meterName), `${product} Snapshots ${c.redundancy}`);
  const storage = c.snapshotType === 'incremental' ? 'Standard HDD (incremental snapshot rule)' : ((c.snapshotStorage ?? 'standard-hdd') === 'standard-hdd' ? 'Standard HDD' : 'same-as-disk');
  return [line(`${c.sourceDiskType} ${c.snapshotType} snapshot ${c.snapshotGB} GB on ${storage} ${c.redundancy}`, snap, c.snapshotGB, c.snapshotGB * snap.retailPrice / unitSize(snap.unitOfMeasure))];
}
async function instantLines(region, c, currency) {
  if ((c.instantAccessGB ?? 0) <= 0 && (c.restoreTB ?? 0) <= 0) return [];
  const product = PRODUCT[c.sourceDiskType];
  const rows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq '${product}' and skuName eq 'Instant Access Snapshots LRS'`, currency)).filter(x => x.type === 'Consumption');
  const lines = [];
  if ((c.instantAccessGB ?? 0) > 0) {
    const snap = pick(rows, x => x.meterName === 'Instant Access Snapshots LRS', `${product} instant access snapshot`);
    const hours = c.instantAccessHours ?? HOURS;
    const listCost = c.instantAccessGB * hours * snap.retailPrice / unitSize(snap.unitOfMeasure);
    lines.push(line(`${product} instant access snapshot ${c.instantAccessGB} GiB @ ${hours} h (promo free through Jan 2027)`, snap, c.instantAccessGB * hours, INSTANT_ACCESS_PROMO_FREE ? 0 : listCost));
  }
  if ((c.restoreTB ?? 0) > 0) {
    const rst = pick(rows, x => /Disk Capacity Restored/.test(x.meterName), `${product} restore`);
    lines.push(line(`${product} instant access restore ${c.restoreTB} ${c.sourceDiskType === 'premium-ssd-v2' ? 'TiB' : 'TB'}`, rst, c.restoreTB, c.restoreTB * rst.retailPrice / unitSize(rst.unitOfMeasure)));
  }
  return lines;
}
async function expected(region, c, currency = 'USD') {
  const lines = [];
  lines.push(...await snapshotLine(region, c, currency));
  lines.push(...await instantLines(region, c, currency));
  return { monthlyList: total(lines), lines };
}
module.exports = { type:'disk-snapshot', source:'both', cases:[
  { name:'premium incremental LRS uses Standard HDD', region:'eastus2', currency:'USD', component:{type:'disk-snapshot',snapshotGB:100,snapshotType:'incremental',sourceDiskType:'premium-ssd',redundancy:'LRS'},
    // Incremental snapshots use Standard HDD snapshot storage regardless of source disk type: 100 GB × Standard HDD LRS Snapshots.
    expected:()=>expected('eastus2',{snapshotGB:100,snapshotType:'incremental',sourceDiskType:'premium-ssd',redundancy:'LRS'}) },
  { name:'premium full ZRS default Standard HDD', region:'eastus2', currency:'USD', component:{type:'disk-snapshot',snapshotGB:100,snapshotType:'full',sourceDiskType:'premium-ssd',redundancy:'ZRS'},
    // Current module default is snapshotStorage: standard-hdd, so full snapshots also use Standard HDD Snapshots unless same-as-disk is requested.
    expected:()=>expected('eastus2',{snapshotGB:100,snapshotType:'full',sourceDiskType:'premium-ssd',redundancy:'ZRS'}) },
  { name:'premium full ZRS same-as-disk', region:'eastus2', currency:'USD', component:{type:'disk-snapshot',snapshotGB:100,snapshotType:'full',sourceDiskType:'premium-ssd',snapshotStorage:'same-as-disk',redundancy:'ZRS'},
    // same-as-disk full Premium SSD snapshots use the Premium SSD Managed Disks ZRS Snapshots meter.
    expected:()=>expected('eastus2',{snapshotGB:100,snapshotType:'full',sourceDiskType:'premium-ssd',snapshotStorage:'same-as-disk',redundancy:'ZRS'}) },
  { name:'standard SSD full same-as-disk non-US', region:'westeurope', currency:'USD', component:{type:'disk-snapshot',snapshotGB:100,snapshotType:'full',sourceDiskType:'standard-ssd',snapshotStorage:'same-as-disk',redundancy:'ZRS'},
    // Non-US same-as-disk full Standard SSD snapshots use the westeurope Standard SSD ZRS Snapshots meter.
    expected:()=>expected('westeurope',{snapshotGB:100,snapshotType:'full',sourceDiskType:'standard-ssd',snapshotStorage:'same-as-disk',redundancy:'ZRS'}) },
  { name:'premium SSD v2 incremental instant restore promo', region:'eastus2', currency:'USD', component:{type:'disk-snapshot',snapshotGB:100,snapshotType:'incremental',sourceDiskType:'premium-ssd-v2',redundancy:'LRS',instantAccessGB:100,instantAccessHours:100,restoreTB:2},
    // PSSD v2 incremental base uses Standard HDD LRS; instant-access storage is promotional $0 through Jan 2027; restore is per provisioned TiB.
    expected:()=>expected('eastus2',{snapshotGB:100,snapshotType:'incremental',sourceDiskType:'premium-ssd-v2',redundancy:'LRS',instantAccessGB:100,instantAccessHours:100,restoreTB:2}) },
  { name:'ultra incremental instant EUR promo', region:'westeurope', currency:'EUR', component:{type:'disk-snapshot',snapshotGB:100,snapshotType:'incremental',sourceDiskType:'ultra',redundancy:'LRS',instantAccessGB:100,instantAccessHours:100},
    // EUR case: base incremental snapshot uses Standard HDD LRS EUR meter; Ultra instant-access storage is $0 during the promotion.
    expected:()=>expected('westeurope',{snapshotGB:100,snapshotType:'incremental',sourceDiskType:'ultra',redundancy:'LRS',instantAccessGB:100,instantAccessHours:100},'EUR') },
]};
