'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice||String(a.meterName).localeCompare(String(b.meterName))); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
async function expected(region, c, currency = 'USD') {
  const lines = [];
  if (c.tier === 'premium') {
    const sku = `${c.diskSize} ${c.redundancy}`;
    const rows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Premium Page Blob' and skuName eq '${sku}'`, currency)).filter(x => x.type === 'Consumption');
    const d = pick(rows, x => / Disk$/.test(x.meterName), `${sku} disk`);
    lines.push(line(`Premium Page Blob ${sku} x${c.diskCount ?? 1}`, d, c.diskCount ?? 1, (c.diskCount ?? 1) * d.retailPrice));
    if ((c.snapshotGB ?? 0) > 0) {
      const sr = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Premium Page Blob' and skuName eq 'Snapshots ${c.redundancy === 'ZRS' ? 'ZRS' : 'LRS'}'`, currency)).filter(x => x.type === 'Consumption');
      const s = pick(sr, x => /Snapshots$/.test(x.meterName), `page blob snapshot ${c.redundancy}`);
      lines.push(line(`Page blob snapshot ${c.snapshotGB} GB`, s, c.snapshotGB, c.snapshotGB * s.retailPrice / unitSize(s.unitOfMeasure)));
    }
  } else {
    const sku = `Standard ${c.redundancy}`;
    const rows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Standard Page Blob v2' and skuName eq '${sku}'`, currency)).filter(x => x.type === 'Consumption');
    const disk = c.purpose === 'unmanaged-disk';
    const data = pick(rows, x => x.meterName === `${c.redundancy} Data Stored` || (!/^Disk /.test(x.meterName) && /Data Stored$/.test(x.meterName)), `${sku} data stored`);
    lines.push(line(`${sku} ${c.purpose} data ${c.dataGB} GB`, data, c.dataGB, c.dataGB * data.retailPrice / unitSize(data.unitOfMeasure)));
    const op = (field, normalRe, diskRe, desc) => {
      if ((c[field] ?? 0) <= 0) return;
      const row = disk ? pick(rows, x => diskRe.test(x.meterName), `${sku} unmanaged ${desc}`) : pick(rows, x => normalRe.test(x.meterName), `${sku} ${desc}`);
      lines.push(line(`${sku} ${desc} ${c[field]}`, row, c[field], c[field] * row.retailPrice / unitSize(row.unitOfMeasure)));
    };
    op('writeOps', /^(?!Disk |.* Disk ).*Write Operations$/, /Disk Write Operations$|Disk Read Operations$|Disk Delete Operations$/, 'write ops');
    op('additionalWriteIO', /Write Additional IO$/, /Disk Write Additional IO$/, 'additional write IO');
    op('readOps', /^(?!Disk |.* Disk ).*Read Operations$/, /Disk Read Operations$/, 'read ops');
    op('additionalReadIO', /Read Additional IO$/, /Disk Read Additional IO$/, 'additional read IO');
    if ((c.geoReplicationGB ?? 0) > 0) {
      const bwRows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Storage - Bandwidth' and skuName eq 'Geo-Replication v2'`, currency)).filter(x => x.type === 'Consumption');
      const bw = pick(bwRows, x => x.meterName === 'Geo-Replication v2 Data Transfer', 'geo-replication transfer');
      lines.push(line(`Geo-replication ${c.geoReplicationGB} GB`, bw, c.geoReplicationGB, c.geoReplicationGB * bw.retailPrice / unitSize(bw.unitOfMeasure)));
    }
  }
  return { monthlyList: total(lines), lines };
}
module.exports = { type:'page-blob', source:'retail-api', cases:[
  { name:'standard page blob LRS ops', region:'eastus2', currency:'USD', component:{type:'page-blob',tier:'standard',purpose:'page-blob',redundancy:'LRS',dataGB:100,writeOps:10000,readOps:10000},
    // Standard Page Blob v2 LRS bills Data Stored plus Write/Read Operations per 10K.
    expected:()=>expected('eastus2',{tier:'standard',purpose:'page-blob',redundancy:'LRS',dataGB:100,writeOps:10000,readOps:10000}) },
  { name:'standard unmanaged disk GRS', region:'eastus2', currency:'USD', component:{type:'page-blob',tier:'standard',purpose:'unmanaged-disk',redundancy:'GRS',dataGB:100,writeOps:10000,readOps:10000},
    // Unmanaged disk capacity uses the page-blob GRS Data Stored row ($0.06/GB), while transactions use Disk * Operations.
    expected:()=>expected('eastus2',{tier:'standard',purpose:'unmanaged-disk',redundancy:'GRS',dataGB:100,writeOps:10000,readOps:10000}) },
  { name:'standard GRS additional IO and geo', region:'eastus2', currency:'USD', component:{type:'page-blob',tier:'standard',purpose:'page-blob',redundancy:'GRS',dataGB:100,writeOps:10000000,additionalWriteIO:10000000,readOps:10000000,additionalReadIO:10000000,geoReplicationGB:100},
    // Covers calculator page-blob additional IO meters and Geo-Replication v2 Data Transfer.
    expected:()=>expected('eastus2',{tier:'standard',purpose:'page-blob',redundancy:'GRS',dataGB:100,writeOps:10000000,additionalWriteIO:10000000,readOps:10000000,additionalReadIO:10000000,geoReplicationGB:100}) },
  { name:'premium P30 LRS', region:'eastus2', currency:'USD', component:{type:'page-blob',tier:'premium',redundancy:'LRS',diskSize:'P30',diskCount:1},
    // Premium Page Blob is a flat monthly disk tier meter, here P30 LRS Disk.
    expected:()=>expected('eastus2',{tier:'premium',redundancy:'LRS',diskSize:'P30',diskCount:1}) },
  { name:'premium P4 ZRS snapshot', region:'eastus2', currency:'USD', component:{type:'page-blob',tier:'premium',redundancy:'ZRS',diskSize:'P4',diskCount:2,snapshotGB:50},
    // Premium ZRS uses the P4 ZRS Disk monthly meter plus ZRS Snapshots per GB-month.
    expected:()=>expected('eastus2',{tier:'premium',redundancy:'ZRS',diskSize:'P4',diskCount:2,snapshotGB:50}) },
  { name:'standard RA-GZRS non-US', region:'westeurope', currency:'USD', component:{type:'page-blob',tier:'standard',purpose:'page-blob',redundancy:'RA-GZRS',dataGB:100},
    // Non-US case pins Standard Page Blob v2 RA-GZRS storage to westeurope.
    expected:()=>expected('westeurope',{tier:'standard',purpose:'page-blob',redundancy:'RA-GZRS',dataGB:100}) },
  { name:'standard GZRS EUR', region:'westeurope', currency:'EUR', component:{type:'page-blob',tier:'standard',purpose:'page-blob',redundancy:'GZRS',dataGB:100},
    // EUR case queries Standard Page Blob v2 GZRS data stored with currencyCode EUR.
    expected:()=>expected('westeurope',{tier:'standard',purpose:'page-blob',redundancy:'GZRS',dataGB:100},'EUR') },
]};
