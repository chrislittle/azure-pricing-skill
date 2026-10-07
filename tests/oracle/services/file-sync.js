'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
async function expected(region,c,currency='USD'){const rows=dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'File Sync' and skuName eq 'Standard'`,currency)).filter(x=>x.type==='Consumption'); const paid=pick(rows,x=>x.meterName==='Standard Server','File Sync paid server'); const free=pick(rows,x=>x.meterName==='Standard Server - Free','File Sync free server'); const freeServers=Math.min(c.servers,c.syncServices??1); const paidServers=Math.max(0,c.servers-freeServers); const lines=[line(`File Sync free registered server(s) ${freeServers}`,free,freeServers,0)]; if(paidServers>0) lines.push(line(`File Sync paid registered server(s) ${paidServers}`,paid,paidServers,paidServers*paid.retailPrice/unitSize(paid.unitOfMeasure))); return {monthlyList:round2(lines.reduce((s,l)=>s+l.monthlyList,0)),lines};}
module.exports={type:'file-sync',source:'retail-api',cases:[
  { name:'one server free grant', region:'eastus2', currency:'USD', component:{type:'file-sync',servers:1,syncServices:1},
    // File Sync exposes a Standard Server - Free meter; one registered server is free for one sync service.
    expected:()=>expected('eastus2',{servers:1,syncServices:1}) },
  { name:'two servers one paid', region:'eastus2', currency:'USD', component:{type:'file-sync',servers:2,syncServices:1},
    // One server is free and the second uses the Standard Server monthly meter.
    expected:()=>expected('eastus2',{servers:2,syncServices:1}) },
  { name:'five servers two sync services', region:'eastus2', currency:'USD', component:{type:'file-sync',servers:5,syncServices:2},
    // Free grant scales with syncServices; remaining registered servers use Standard Server per month.
    expected:()=>expected('eastus2',{servers:5,syncServices:2}) },
  { name:'non-US two servers', region:'westeurope', currency:'USD', component:{type:'file-sync',servers:2,syncServices:1},
    // Non-US case pins File Sync Standard Server meter to westeurope.
    expected:()=>expected('westeurope',{servers:2,syncServices:1}) },
  { name:'EUR paid servers', region:'westeurope', currency:'EUR', component:{type:'file-sync',servers:3,syncServices:1},
    // EUR case queries File Sync Standard Server with currencyCode EUR after applying the free server grant.
    expected:()=>expected('westeurope',{servers:3,syncServices:1},'EUR') },
]};
