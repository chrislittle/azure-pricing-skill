'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730, SLUG='azure-sql-database';
function line(desc, monthlyList, extra={}){ return { desc, monthlyList: round2(monthlyList), ...extra }; } function total(lines){ return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
async function product(){ for(const v of ['v2','v3']){ const res=await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`,{headers:{accept:'application/json'}}); if(res.ok) return res.json(); if(res.status!==404) throw new Error(`calculator ${SLUG} HTTP ${res.status}`);} throw new Error('calculator not found'); }
function cprice(data, offer, region, unit='perhour'){ const o=data.offers[offer]; if(!o) throw new Error(`missing offer ${offer}`); const cr=calc.calcRegion(data,region); const p=(o.prices[unit]||{})[cr] || (o.prices[unit]||{}).global; if(!p) throw new Error(`missing ${offer}/${unit} in ${cr}`); return p.value; }
function unit(commitment){ return commitment==='ri1y'?'perhouroneyearreserved':commitment==='ri3y'?'perhourthreeyearreserved':'perhour'; }
function hw(h){ return h==='premium-series'?'premium':h==='premium-series-memory-optimized'?'memoryoptimized':h==='dc-series'?'dc':h==='fsv2'?'fsv2':'gen5'; }
function pick(rows,pred,what){ const r=rows.find(pred); if(!r) throw new Error('missing '+what); return r; }
function spTerm(commitment){ return commitment==='sp1y'?'1 Year':commitment==='sp3y'?'3 Years':null; }
function spRate(row, commitment){ const term=spTerm(commitment); const sp=(row.savingsPlan||[]).find(x=>x.term===term); if(!sp) throw new Error(`missing ${term} savingsPlan for ${row.productName} ${row.skuName}`); return sp.unitPrice; }
async function pool({region,currency='USD',tier,poolSize,pools=1,hardware='standard-series',storageGb=32,extraStorageGb=0,zoneRedundant=false,haReplicas=0,ahb=false,commitment='payg',backupStorageGb=0,backupRedundancy='GRS',ltrStorageGb=0,hours=HOURS}){
 const lines=[];
 if(currency==='USD'){
  const data=await product();
  if(['basic','standard','premium'].includes(tier)){
   const offer=`elastic-dtu-${tier==='premium'?'premium-tier':tier}-${poolSize}`; const p=cprice(data,offer,region); lines.push(line(`${tier} eDTU pool ${poolSize}: ${pools} * ${hours} h * ${p}`,pools*hours*p,{sourceOffer:offer}));
   if(extraStorageGb){ const sp=cprice(data,tier==='premium'?'premium-tier-storage':'standard-storage',region,'pergb'); lines.push(line(`${tier} eDTU extra storage ${extraStorageGb} GB`,pools*extraStorageGb*sp)); }
  } else {
   const h=hw(hardware); const base=tier==='business-critical'?'business-critical':tier; const local=tier==='general-purpose'?(zoneRedundant?'zone':'local'):'';
   const compute=tier==='hyperscale'?`elastic-vcore-hyperscale-${h}-${poolSize}`:`elastic-vcore-${base}-${h}${local?'-'+local:''}-${poolSize}`;
   const replicas=tier==='hyperscale'?1+haReplicas:1;
   const useSp=!!spTerm(commitment); const sr=useSp||tier==='hyperscale'?dedupe(await query(`serviceName eq 'SQL Database' and armRegionName eq '${region}'`,currency)):[];
   let cp, cextra={sourceOffer:compute};
   if(useSp){
     const comp=tier==='hyperscale'
       ? pick(sr,r=>r.productName==='SQL Database SingleDB/Elastic Pool Hyperscale - Compute Gen5'&&r.skuName==='vCore'&&r.type==='Consumption','hyperscale compute savings plan')
       : pick(sr,r=>r.productName==='SQL Database Single/Elastic Pool General Purpose - Compute Gen5'&&r.skuName===`${poolSize} vCore${zoneRedundant?' Zone Redundancy':''}`&&r.type==='Consumption','general purpose compute savings plan');
     cp=poolSize*spRate(comp,commitment);
     if(tier==='general-purpose'&&zoneRedundant){ const baseComp=pick(sr,r=>r.productName==='SQL Database Single/Elastic Pool General Purpose - Compute Gen5'&&r.skuName===`${poolSize} vCore`&&r.type==='Consumption','general purpose base compute savings plan'); cp+=poolSize*spRate(baseComp,commitment); }
     cextra={meterId:comp.meterId};
   } else cp=cprice(data,compute,region,unit(commitment));
   lines.push(line(`${tier} compute ${poolSize} vCores x ${replicas} replica(s)${useSp?' savings plan':''}`,pools*replicas*hours*cp,cextra));
   if(tier==='hyperscale'){ const m=pick(sr,r=>r.productName==='SQL Database - shared resource management'&&r.skuName==='1 vCore'&&r.meterName==='1 vCore'&&r.unitOfMeasure==='1 Hour'&&r.type==='Consumption','regional shared resource management'); const mp=useSp?spRate(m,commitment):m.retailPrice; lines.push(line(`${tier} shared resource management ${poolSize} vCores x ${replicas} copies${useSp?' savings plan':''}`,pools*replicas*poolSize*hours*mp,{meterId:m.meterId})); }
   else if(!ahb){ if(useSp){ const lic=pick(dedupe(await query(`serviceName eq 'SQL Database' and armRegionName eq 'Global'`,currency)),r=>r.productName==='SQL Database Single/Elastic Pool General Purpose - SQL License'&&r.meterName==='vCore'&&r.type==='Consumption'&&r.retailPrice>0,'general purpose SQL license savings plan'); lines.push(line(`${tier} SQL license ${poolSize} vCores x ${replicas} savings plan`,pools*replicas*poolSize*hours*spRate(lic,commitment),{meterId:lic.meterId})); } else { const sw=`elastic-vcore-${base}-software-${poolSize}`; const lp=cprice(data,sw,region,'perhour'); lines.push(line(`${tier} SQL license ${poolSize} vCores x ${replicas}`,pools*replicas*hours*lp,{sourceOffer:sw})); } }
   const so=tier==='general-purpose'?`elastic-vcore-general-purpose-${zoneRedundant?'zone':'local'}-storage`:tier==='business-critical'?'elastic-vcore-business-critical-storage':'elastic-vcore-hyperscale-storage'; const sp=cprice(data,so,region,'pergb'); lines.push(line(`${tier} storage ${storageGb} GB`,pools*storageGb*sp,{sourceOffer:so}));
   if(backupStorageGb){ const bo=tier==='hyperscale'?`elastic-backup-pitr-storage-hyperscale-${backupRedundancy==='GRS'?'ra-grs':backupRedundancy.toLowerCase()}`:`single-elastic-pool-pitr-backup-storage-${backupRedundancy==='GRS'?'ra-grs':backupRedundancy.toLowerCase()}`; const bp=cprice(data,bo,region,'pergb'); lines.push(line(`${tier} backup ${backupStorageGb} GB ${backupRedundancy}`,pools*backupStorageGb*bp,{sourceOffer:bo})); }
  }
 } else {
  const rs=dedupe(await query(`serviceName eq 'SQL Database' and armRegionName eq '${region}'`,currency));
  const comp=pick(rs,r=>r.productName.includes('Elastic Pool')&&r.productName.includes('General Purpose')&&r.productName.includes('Compute')&&r.skuName===`${poolSize} vCore`&&r.type==='Consumption',`${currency} elastic pool compute`); lines.push(line(`${currency} general purpose elastic pool compute`,pools*hours*comp.retailPrice,{meterId:comp.meterId}));
  const lic=pick(dedupe(await query(`serviceName eq 'SQL Database' and armRegionName eq 'Global'`,currency)),r=>r.productName.includes('General Purpose')&&r.productName.includes('SQL License')&&r.meterName==='vCore'&&r.retailPrice>0,'SQL license'); lines.push(line(`${currency} SQL license`,pools*poolSize*hours*lic.retailPrice,{meterId:lic.meterId}));
 }
 return { monthlyList: total(lines), lines };
}
function c(name, cfg){ return { name, region:cfg.region||'eastus2', currency:cfg.currency||'USD', component:{ type:'sql-elastic-pool', ...cfg },
 // Calculator/Retail bill pool compute hourly; savings-plan cases use Retail savingsPlan arrays for compute, SQL license, and Hyperscale shared resource management.
 expected:()=>pool({region:cfg.region||'eastus2',currency:cfg.currency||'USD',...cfg}) }; }
module.exports={type:'sql-elastic-pool',source:'both',cases:[
 c('basic eDTU pool per-day',{tier:'basic',poolSize:50,hours:24}), c('standard eDTU pool extra storage',{tier:'standard',poolSize:100,extraStorageGb:20}), c('premium eDTU pool',{tier:'premium',poolSize:125}),
 c('general purpose reserved with storage',{tier:'general-purpose',poolSize:4,storageGb:100,commitment:'ri1y'}), c('business critical zone redundant AHB',{tier:'business-critical',poolSize:4,storageGb:128,zoneRedundant:true,ahb:true}),
 c('general purpose savings plan 1y includes license',{tier:'general-purpose',poolSize:4,storageGb:100,commitment:'sp1y'}),
 c('general purpose savings plan 3y includes license',{tier:'general-purpose',poolSize:4,storageGb:100,commitment:'sp3y'}),
 c('general purpose zone redundant savings plan',{tier:'general-purpose',poolSize:4,storageGb:100,zoneRedundant:true,commitment:'sp1y'}),
 c('hyperscale HA replicas west europe',{tier:'hyperscale',poolSize:4,storageGb:512,haReplicas:2,backupStorageGb:100,backupRedundancy:'ZRS',region:'westeurope'}),
 c('hyperscale savings plan shared resource',{tier:'hyperscale',poolSize:4,storageGb:256,haReplicas:1,commitment:'sp1y'}), c('EUR general purpose retail',{tier:'general-purpose',poolSize:4,region:'westeurope',currency:'EUR',hours:100})
]};
