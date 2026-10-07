'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const HOURS=730, SLUG='cosmos-db';
function line(desc,monthlyList,extra={}){return{desc,monthlyList:round2(monthlyList),...extra};} function total(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
async function product(){for(const v of ['v2','v3']){const res=await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`,{headers:{accept:'application/json'}}); if(res.ok)return res.json(); if(res.status!==404)throw new Error(`calculator ${SLUG} HTTP ${res.status}`);} throw new Error('calculator not found');}
function cprice(data,offer,region,unit='perhour'){const o=data.offers[offer]; if(!o)throw new Error(`missing offer ${offer}`); const cr=calc.calcRegion(data,region); const p=(o.prices[unit]||{})[cr]||(o.prices[unit]||{}).global; if(!p)throw new Error(`missing ${offer}/${unit} in ${cr}`); return p.value;}
function runit(c){return c==='ri1y'?'perhouroneyearreserved':c==='ri3y'?'perhourthreeyearreserved':'perhour';}
function spRate(row){ const sp=(row.savingsPlan||[]).find(x=>x.term==='1 Year'); if(!sp) throw new Error(`missing 1 Year savingsPlan for ${row.productName}`); return sp.unitPrice; }
async function pg({region,currency='USD',layout='multi-node',vcores,workers=2,workerVcores=0,storageGib=128,workerStorageGib=512,ha=false,commitment='payg',hours=HOURS}){
 const lines=[]; const nodes=ha?2:1;
 if(currency==='USD'){
  const data=await product();
  if(layout==='multi-node'){
   const wv=workerVcores||vcores;
   if(commitment==='ri1y'||commitment==='ri3y'){
    const term=commitment==='ri1y'?12:36; const rs=dedupe(await query(`serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${region}'`,currency));
    const coord=rs.find(r=>r.productName==='Azure Cosmos DB for PostgreSQL Compute- Coordinator Node'&&r.type==='Reservation'&&r.retailPrice===(commitment==='ri1y'?719:1395));
    const work=rs.find(r=>r.productName==='Azure Cosmos DB for PostgreSQL Compute- Worker Node'&&r.type==='Reservation'&&r.retailPrice===(commitment==='ri1y'?868:1698));
    lines.push(line(`coordinator ${vcores} vCore x ${nodes} ${commitment} amortized`,vcores*nodes*coord.retailPrice/term,{meterId:coord.meterId}));
    lines.push(line(`${workers} worker(s) ${wv} vCore x ${nodes} ${commitment} amortized`,workers*wv*nodes*work.retailPrice/term,{meterId:work.meterId}));
   } else if(commitment==='sp1y'){
    const rs=dedupe(await query(`serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${region}'`,currency));
    const coord=rs.find(r=>r.productName==='Azure Cosmos DB for PostgreSQL Compute- Coordinator Node'&&r.skuName==='vCore'&&r.type==='Consumption');
    const work=rs.find(r=>r.productName==='Azure Cosmos DB for PostgreSQL Compute- Worker Node'&&r.skuName==='vCore'&&r.type==='Consumption');
    lines.push(line(`coordinator ${vcores} vCore x ${nodes} sp1y`,vcores*nodes*hours*spRate(coord),{meterId:coord.meterId}));
    lines.push(line(`${workers} worker(s) ${wv} vCore x ${nodes} sp1y`,workers*wv*nodes*hours*spRate(work),{meterId:work.meterId}));
   } else {
    const cp=cprice(data,`hyperscalecitus-multi-node-compute-coordinator-${vcores}`,region,runit(commitment)); lines.push(line(`coordinator ${vcores} vCore x ${nodes}`,vcores*nodes*hours*cp,{sourceOffer:`hyperscalecitus-multi-node-compute-coordinator-${vcores}`}));
    const wp=cprice(data,`hyperscalecitus-multi-node-compute-worker-${wv}`,region,runit(commitment)); lines.push(line(`${workers} worker(s) ${wv} vCore x ${nodes}`,workers*wv*nodes*hours*wp,{sourceOffer:`hyperscalecitus-multi-node-compute-worker-${wv}`}));
   }
   const cs=cprice(data,`hyperscalecitus-multi-node-coordinator-generalpurpose-storage-${storageGib}`,region,'pergb'); lines.push(line(`coordinator storage ${storageGib} GiB x ${nodes}`,nodes*storageGib*cs));
   const ws=cprice(data,`hyperscalecitus-multi-node-worker-generalpurpose-storage-${workerStorageGib}`,region,'pergb'); lines.push(line(`worker storage ${workerStorageGib} GiB x ${workers} x ${nodes}`,workers*nodes*workerStorageGib*ws));
  } else if(layout==='single-node'){
   if(commitment==='sp1y'){ const rs=dedupe(await query(`serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${region}'`,currency)); const comp=rs.find(r=>r.productName==='Azure Cosmos DB for PostgreSQL Compute- Coordinator Node'&&r.skuName==='vCore'&&r.type==='Consumption'); lines.push(line(`single node ${vcores} vCore x ${nodes} sp1y`,vcores*nodes*hours*spRate(comp),{meterId:comp.meterId})); }
   else { const cp=cprice(data,`hyperscalecitus-single-node-compute-worker-${vcores}`,region,runit(commitment)); lines.push(line(`single node ${vcores} vCore x ${nodes}`,vcores*nodes*hours*cp)); }
   const sp=cprice(data,`hyperscalecitus-single-node-generalpurpose-storage-${storageGib}`,region,'pergb'); lines.push(line(`single node storage ${storageGib} GiB x ${nodes}`,nodes*storageGib*sp));
  } else { const cp=cprice(data,`single-node-compute-burstable-worker-${vcores}`,region,'perhour'); lines.push(line(`burstable ${vcores} vCore`,hours*cp)); const sp=cprice(data,'hyperscalecitus-single-node-generalpurpose-storage-128',region,'pergb'); lines.push(line(`burstable storage 128 GiB`,128*sp)); }
 } else {
  const rows=dedupe(await query(`serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${region}'`,currency)); const get=(pred,what)=>{const r=rows.find(pred); if(!r)throw new Error('missing '+what); return r;};
  const coord=get(r=>r.productName==='Azure Cosmos DB for PostgreSQL Compute- Coordinator Node'&&r.skuName==='vCore'&&r.type==='Consumption','coordinator'); const worker=get(r=>r.productName==='Azure Cosmos DB for PostgreSQL Compute- Worker Node'&&r.skuName==='vCore'&&r.type==='Consumption','worker'); const stor=get(r=>r.productName==='Azure Cosmos DB for PostgreSQL General Purpose Storage','storage');
  lines.push(line(`${currency} coordinator`,vcores*hours*coord.retailPrice,{meterId:coord.meterId})); lines.push(line(`${currency} workers`,workers*(workerVcores||vcores)*hours*worker.retailPrice,{meterId:worker.meterId})); lines.push(line(`${currency} storage`,(storageGib+workers*workerStorageGib)*stor.retailPrice,{meterId:stor.meterId}));
 }
 return {monthlyList:total(lines),lines};
}
function c(name,cfg){return{name,region:cfg.region||'eastus2',currency:cfg.currency||'USD',component:{type:'cosmos-postgresql',...cfg},
 // Calculator/Retail Cosmos DB for PostgreSQL bills compute per vCore-hour and storage per GiB; reservations use amortized reservation rows; sp1y uses Retail savingsPlan arrays.
 expected:()=>pg({region:cfg.region||'eastus2',currency:cfg.currency||'USD',...cfg})};}
module.exports={type:'cosmos-postgresql',source:'both',cases:[
 c('multi-node 4 vCore two workers',{layout:'multi-node',vcores:4,workers:2,storageGib:128,workerStorageGib:512}), c('multi-node reserved 3y HA',{layout:'multi-node',vcores:8,workers:3,workerVcores:4,storageGib:256,workerStorageGib:1024,ha:true,commitment:'ri3y'}),
 c('multi-node savings plan 1y',{layout:'multi-node',vcores:4,workers:2,storageGib:128,workerStorageGib:512,commitment:'sp1y'}),
 c('single-node',{layout:'single-node',vcores:2,storageGib:128}), c('single-node savings plan 1y',{layout:'single-node',vcores:2,storageGib:128,commitment:'sp1y'}), c('burstable one vCore',{layout:'burstable',vcores:1,hours:100}), c('west europe HA',{layout:'multi-node',vcores:4,workers:2,ha:true,region:'westeurope'}), c('EUR west europe retail',{layout:'multi-node',vcores:4,workers:2,region:'westeurope',currency:'EUR',hours:100})
]};
