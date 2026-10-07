'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS=730;
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
async function expected(region,c,currency='USD'){const rows=dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Ultra Disks' and skuName eq 'Ultra LRS'`,currency)).filter(x=>x.type==='Consumption'); const h=c.hours??HOURS, count=c.count??1, lines=[]; for(const [field,re,label] of [['sizeGB',/Provisioned Capacity/,'capacity GiB'],['iops',/Provisioned IOPS/,'IOPS'],['throughputMBps',/Provisioned Throughput/,'throughput MBps']]){const r=pick(rows,x=>re.test(x.meterName),`Ultra ${label}`); const qty=c[field]*h*count; lines.push(line(`Ultra Disk ${label} ${c[field]} x${count} @ ${h} h`,r,qty,qty*r.retailPrice/unitSize(r.unitOfMeasure)));} if((c.vcpuReservation??0)>0){const r=pick(rows,x=>/Reservation per vCPU/.test(x.meterName),'Ultra vCPU reservation'); const qty=c.vcpuReservation*h; lines.push(line(`Ultra Disk vCPU reservation ${c.vcpuReservation} @ ${h} h`,r,qty,qty*r.retailPrice/unitSize(r.unitOfMeasure)));} return { monthlyList:total(lines), lines};}
module.exports={ type:'ultra-disk', source:'both', cases:[
  { name:'basic ultra disk', region:'eastus2', currency:'USD', component:{type:'ultra-disk',sizeGB:1024,iops:5000,throughputMBps:200,count:1},
    // Ultra LRS bills provisioned capacity GiB, IOPS, and throughput MBps as separate hourly meters.
    expected:()=>expected('eastus2',{sizeGB:1024,iops:5000,throughputMBps:200,count:1}) },
  { name:'multiple disks', region:'eastus2', currency:'USD', component:{type:'ultra-disk',sizeGB:2048,iops:10000,throughputMBps:400,count:2},
    // Each provisioned dimension is multiplied by disk count and 730 hours.
    expected:()=>expected('eastus2',{sizeGB:2048,iops:10000,throughputMBps:400,count:2}) },
  { name:'with vcpu reservation', region:'eastus2', currency:'USD', component:{type:'ultra-disk',sizeGB:1024,iops:5000,throughputMBps:200,count:1,vcpuReservation:4},
    // vCPU reservation is an additional hourly Ultra LRS Reservation per vCPU Provisioned meter.
    expected:()=>expected('eastus2',{sizeGB:1024,iops:5000,throughputMBps:200,count:1,vcpuReservation:4}) },
  { name:'part-time', region:'eastus2', currency:'USD', component:{type:'ultra-disk',sizeGB:512,iops:3000,throughputMBps:100,count:1,hours:100},
    // Part-time case multiplies all Ultra provisioned meters by 100 hours.
    expected:()=>expected('eastus2',{sizeGB:512,iops:3000,throughputMBps:100,count:1,hours:100}) },
  { name:'non-US region', region:'westeurope', currency:'USD', component:{type:'ultra-disk',sizeGB:1024,iops:5000,throughputMBps:200,count:1},
    // Non-US case pins Ultra Disks meters to westeurope.
    expected:()=>expected('westeurope',{sizeGB:1024,iops:5000,throughputMBps:200,count:1}) },
  { name:'EUR currency', region:'westeurope', currency:'EUR', component:{type:'ultra-disk',sizeGB:1024,iops:5000,throughputMBps:200,count:1},
    // EUR case uses Retail Prices API currencyCode EUR for the three Ultra LRS provisioned meters.
    expected:()=>expected('westeurope',{sizeGB:1024,iops:5000,throughputMBps:200,count:1},'EUR') },
]};
