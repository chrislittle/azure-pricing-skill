'use strict';
const H = require('./_helpers');
function prod(c){
 if((c.tier||'Hot')==='Premium') return c.namespace==='hierarchical' ? 'Premium Block Blob v2 Hierarchical Namespace' : 'Premium Block Blob';
 return c.namespace==='hierarchical' ? 'General Block Blob v2 Hierarchical Namespace' : 'General Block Blob v2';
}
function sku(c){ return `${c.tier||'Hot'} ${c.redundancy||'LRS'}`; }
async function op(filter,currency,c,pred,qty,desc){ if(qty) return H.retailLine(filter,currency,r=>r.type==='Consumption'&&(r.productName===prod(c)||(c.namespace!=='hierarchical'&&(r.productName==='Blob Storage'||(c.redundancy==='RA-GZRS'&&r.productName==='Azure Data Lake Storage Gen2 Flat Namespace'))))&&r.skuName===sku(c)&&pred(r),qty,desc); }
async function storageCalcV3(){
 const res = await fetch('https://azure.microsoft.com/api/v3/pricing/storage/calculator/?culture=en-us', {headers:{accept:'application/json'}});
 if(!res.ok) throw new Error(`storage calculator v3 HTTP ${res.status}`);
 return res.json();
}
async function hnsIterative(c, region, kind){
 const d=await storageCalcV3();
 const red=String(c.redundancy||'LRS').toLowerCase();
 const tier=String(c.tier||'Hot').toLowerCase();
 const key=`general-purpose-v2-block-blob-structured-${tier}-${red}-iterative-${kind}-operations`;
 const offer=(d.offers||{})[key];
 if(!offer) throw new Error(`calculator storage missing ${key}`);
 const prices=offer.prices||{};
 const regionPrices=prices.per10k || prices.per100 || prices;
 const arm=H.armRegion(region);
 const cr=({australiaeast:'australia-east',switzerlandnorth:'switzerland-north'})[arm] || H.calcRegion(region);
 const pr=regionPrices[cr] || regionPrices.global;
 if(!pr) throw new Error(`calculator storage missing ${key}/${cr}`);
 return { key, rate: pr.value };
}
async function price(c, region, currency){ const lines=[], filter=`serviceName eq 'Storage' and armRegionName eq '${H.armRegion(region)}'`; const tier=c.tier||'Hot', red=c.redundancy||'LRS', gb=c.capacityGB||0;
 if(c.commitment){ const size=gb>=1024*1024?'1 PB':'100 TB'; const term=c.commitment==='ri3y'?'3 Years':'1 Year'; lines.push(await H.retailFlatReservation(filter,currency,r=>r.type==='Reservation'&&r.productName==='Storage Reserved Capacity'&&r.skuName===`${tier} - ${size} ${red}`&&r.reservationTerm===term,c.commitment==='ri3y'?36:12,`${tier} ${red} ${size} reserved ${term}`)); }
 else if(gb){ lines.push(await H.retailTieredLine(filter,currency,r=>r.type==='Consumption'&&r.productName===prod(c)&&r.skuName===sku(c)&&/Data Stored$/.test(r.meterName),gb,`${prod(c)} ${sku(c)} capacity ${gb} GB`)); }
 for (const l of [
  await op(filter,currency,c,r=>/Write Operations/.test(r.meterName),c.writeOps,`${sku(c)} writes ${c.writeOps}`),
  await op(filter,currency,c,r=>/Read Operations/.test(r.meterName)&&!/Priority/.test(r.meterName),c.readOps,`${sku(c)} reads ${c.readOps}`),
  await op(filter,currency,c,r=>/(^|\s)Other Operations$|All Other Operations$/.test(r.meterName),c.otherOps,`${sku(c)} other ${c.otherOps}`),
  await op(filter,currency,c,r=>/List and Create Container Operations/.test(r.meterName),c.listOps,`${sku(c)} list ${c.listOps}`),
  await op(filter,currency,c,r=>/Data Retrieval$/.test(r.meterName)&&!/Priority/.test(r.meterName),c.retrievalGB,`${sku(c)} retrieval ${c.retrievalGB} GB`),
  await op(filter,currency,c,r=>/Priority Read Operations/.test(r.meterName),c.priorityReadOps,`${sku(c)} priority reads ${c.priorityReadOps}`),
  await op(filter,currency,c,r=>/Priority Data Retrieval/.test(r.meterName),c.priorityRetrievalGB,`${sku(c)} priority retrieval ${c.priorityRetrievalGB} GB`),
 ]) if(l) lines.push(l);
 if(c.iterativeWriteOps){ const p=await hnsIterative(c, region, 'write'); lines.push(H.line(`${sku(c)} iterative writes ${c.iterativeWriteOps}`, c.iterativeWriteOps/10000*p.rate, {source:`calculator:storage:${p.key}`, unitPrice:p.rate, unitOfMeasure:'10K'})); }
 if(c.iterativeReadOps){ const p=await hnsIterative(c, region, 'read'); lines.push(H.line(`${sku(c)} iterative reads ${c.iterativeReadOps}`, c.iterativeReadOps/10000*p.rate, {source:`calculator:storage:${p.key}`, unitPrice:p.rate, unitOfMeasure:'10K'})); }
 if(c.sftpHours){ lines.push(H.line(`SFTP enabled ${c.sftpHours} h`, c.sftpHours*0.30, {source:'Azure Blob Storage pricing page SFTP hourly add-on', unitPrice:0.30, unitOfMeasure:'1 Hour'})); }
 return H.result(lines); }
module.exports={type:'blob',source:'both',cases:[
 {name:'Hot LRS capacity with write read other list ops',region:'eastus2',currency:'USD',component:{type:'blob',tier:'Hot',redundancy:'LRS',capacityGB:1000,writeOps:10000,readOps:10000,otherOps:10000,listOps:10000},expected:()=>price({tier:'Hot',redundancy:'LRS',capacityGB:1000,writeOps:10000,readOps:10000,otherOps:10000,listOps:10000},'eastus2','USD')},
 {name:'Hot RA-GZRS operations',region:'eastus2',currency:'USD',component:{type:'blob',tier:'Hot',redundancy:'RA-GZRS',capacityGB:1000,writeOps:10000,readOps:10000,otherOps:10000,listOps:10000},expected:()=>price({tier:'Hot',redundancy:'RA-GZRS',capacityGB:1000,writeOps:10000,readOps:10000,otherOps:10000,listOps:10000},'eastus2','USD')},
 {name:'Archive priority and retrieval',region:'eastus2',currency:'USD',component:{type:'blob',tier:'Archive',redundancy:'LRS',capacityGB:1000,retrievalGB:100,priorityReadOps:10000,priorityRetrievalGB:100},expected:()=>price({tier:'Archive',redundancy:'LRS',capacityGB:1000,retrievalGB:100,priorityReadOps:10000,priorityRetrievalGB:100},'eastus2','USD')},
 {name:'Hierarchical namespace Hot LRS ops and iterative',region:'eastus2',currency:'USD',component:{type:'blob',tier:'Hot',redundancy:'LRS',namespace:'hierarchical',capacityGB:1000,writeOps:10000,readOps:10000,otherOps:10000,iterativeWriteOps:10000,iterativeReadOps:10000},expected:()=>price({tier:'Hot',redundancy:'LRS',namespace:'hierarchical',capacityGB:1000,writeOps:10000,readOps:10000,otherOps:10000,iterativeWriteOps:10000,iterativeReadOps:10000},'eastus2','USD')},
 {name:'Hierarchical namespace Cold GRS directory operations',region:'eastus2',currency:'USD',component:{type:'blob',tier:'Cold',redundancy:'GRS',namespace:'hierarchical',capacityGB:1000,iterativeWriteOps:10000,iterativeReadOps:10000},expected:()=>price({tier:'Cold',redundancy:'GRS',namespace:'hierarchical',capacityGB:1000,iterativeWriteOps:10000,iterativeReadOps:10000},'eastus2','USD')},
 {name:'Australia East HNS Hot GZRS directory writes',region:'australiaeast',currency:'USD',component:{type:'blob',tier:'Hot',redundancy:'GZRS',namespace:'hierarchical',capacityGB:1000,iterativeWriteOps:100000},expected:()=>price({tier:'Hot',redundancy:'GZRS',namespace:'hierarchical',capacityGB:1000,iterativeWriteOps:100000},'australiaeast','USD')},
 {name:'Switzerland North HNS Hot GZRS directory writes',region:'switzerlandnorth',currency:'USD',component:{type:'blob',tier:'Hot',redundancy:'GZRS',namespace:'hierarchical',capacityGB:1000,iterativeWriteOps:100000},expected:()=>price({tier:'Hot',redundancy:'GZRS',namespace:'hierarchical',capacityGB:1000,iterativeWriteOps:100000},'switzerlandnorth','USD')},
 {name:'SFTP hourly add-on on HNS account',region:'eastus2',currency:'USD',component:{type:'blob',tier:'Hot',redundancy:'LRS',namespace:'hierarchical',capacityGB:100,sftpHours:730},expected:()=>price({tier:'Hot',redundancy:'LRS',namespace:'hierarchical',capacityGB:100,sftpHours:730},'eastus2','USD')},
 {name:'Premium flat block blob operations',region:'eastus2',currency:'USD',component:{type:'blob',tier:'Premium',redundancy:'LRS',capacityGB:2048,writeOps:20000,readOps:30000,otherOps:10000},expected:()=>price({tier:'Premium',redundancy:'LRS',capacityGB:2048,writeOps:20000,readOps:30000,otherOps:10000},'eastus2','USD')},
 {name:'Hot GRS capacity band boundary in EUR',region:'westeurope',currency:'EUR',component:{type:'blob',tier:'Hot',redundancy:'GRS',capacityGB:51200,writeOps:10000,readOps:10000,otherOps:10000,listOps:10000},expected:()=>price({tier:'Hot',redundancy:'GRS',capacityGB:51200,writeOps:10000,readOps:10000,otherOps:10000,listOps:10000},'westeurope','EUR')},
 {name:'Hot GZRS 1 PB three-year reservation',region:'eastus2',currency:'USD',component:{type:'blob',tier:'Hot',redundancy:'GZRS',capacityGB:1048576,commitment:'ri3y'},expected:()=>price({tier:'Hot',redundancy:'GZRS',capacityGB:1048576,commitment:'ri3y'},'eastus2','USD')},
 {name:'US Gov Hot LRS capacity',region:'usgovvirginia',currency:'USD',component:{type:'blob',tier:'Hot',redundancy:'LRS',capacityGB:1000},expected:()=>price({tier:'Hot',redundancy:'LRS',capacityGB:1000},'usgovvirginia','USD')},
]};
