'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
async function expected(region,c,currency='USD') { const sku=`Standard ${c.redundancy}`; const rows=dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Queues v2' and skuName eq '${sku}'`,currency)).filter(x=>x.type==='Consumption'); const lines=[]; const data=pick(rows,x=>/Data Stored$/.test(x.meterName),`${sku} data`); lines.push(line(`${sku} queue data ${c.dataGB} GB`,data,c.dataGB,c.dataGB*data.retailPrice/unitSize(data.unitOfMeasure))); if((c.writeOps??0)>0){const w=pick(rows,x=>/Class 1 Operations$/.test(x.meterName),`${sku} class 1`); lines.push(line(`${sku} queue write/class1 ops ${c.writeOps}`,w,c.writeOps,c.writeOps*w.retailPrice/unitSize(w.unitOfMeasure)));} if((c.readOps??0)>0){const r=pick(rows,x=>/Class 2 Operations$/.test(x.meterName),`${sku} class 2`); lines.push(line(`${sku} queue read/class2 ops ${c.readOps}`,r,c.readOps,c.readOps*r.retailPrice/unitSize(r.unitOfMeasure)));} return { monthlyList: total(lines), lines }; }
module.exports = { type:'queue-storage', source:'retail-api', cases:[
  { name:'LRS storage and ops', region:'eastus2', currency:'USD', component:{ type:'queue-storage', dataGB:100, redundancy:'LRS', writeOps:20000, readOps:50000 },
    // Queues v2 Standard LRS: Data Stored plus Class 1 and Class 2 operation meters per 10K operations.
    expected:()=>expected('eastus2',{dataGB:100,redundancy:'LRS',writeOps:20000,readOps:50000}) },
  { name:'ZRS redundancy', region:'eastus2', currency:'USD', component:{ type:'queue-storage', dataGB:100, redundancy:'ZRS', writeOps:10000, readOps:10000 },
    // Standard ZRS uses ZRS Data Stored and ZRS Class 1/Class 2 operation meters.
    expected:()=>expected('eastus2',{dataGB:100,redundancy:'ZRS',writeOps:10000,readOps:10000}) },
  { name:'GRS redundancy', region:'eastus2', currency:'USD', component:{ type:'queue-storage', dataGB:100, redundancy:'GRS', writeOps:10000, readOps:10000 },
    // Standard GRS uses GRS Data Stored and GRS-prefixed operation meters.
    expected:()=>expected('eastus2',{dataGB:100,redundancy:'GRS',writeOps:10000,readOps:10000}) },
  { name:'RA-GRS redundancy', region:'eastus2', currency:'USD', component:{ type:'queue-storage', dataGB:100, redundancy:'RA-GRS', writeOps:10000, readOps:10000 },
    // RA-GRS storage has its own Data Stored meter; operations use the GRS class meters.
    expected:()=>expected('eastus2',{dataGB:100,redundancy:'RA-GRS',writeOps:10000,readOps:10000}) },
  { name:'GZRS data only non-US', region:'westeurope', currency:'USD', component:{ type:'queue-storage', dataGB:100, redundancy:'GZRS' },
    // GZRS currently exposes storage and read/class2 meters; this case audits the storage meter in westeurope.
    expected:()=>expected('westeurope',{dataGB:100,redundancy:'GZRS'}) },
  { name:'RA-GZRS data EUR', region:'westeurope', currency:'EUR', component:{ type:'queue-storage', dataGB:100, redundancy:'RA-GZRS' },
    // EUR case queries the RA-GZRS Data Stored meter with currencyCode EUR.
    expected:()=>expected('westeurope',{dataGB:100,redundancy:'RA-GZRS'},'EUR') },
] };
