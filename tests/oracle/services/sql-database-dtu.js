'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730;
const SLUG = 'azure-sql-database';
const OFFER = { basic:'single-dtu-basic-b', s0:'single-dtu-standard-s0', s1:'single-dtu-standard-s1', s2:'single-dtu-standard-s2', s3:'single-dtu-standard-s3', s4:'single-dtu-standard-s4', s6:'single-dtu-standard-s6', s7:'single-dtu-standard-s7', s9:'single-dtu-standard-s9', s12:'single-dtu-standard-s12', p1:'single-dtu-premium-tier-p1', p2:'single-dtu-premium-tier-p2', p4:'single-dtu-premium-tier-p4', p6:'single-dtu-premium-tier-p6', p11:'single-dtu-premium-tier-p11', p15:'single-dtu-premium-tier-p15' };
function line(desc, monthlyList, extra={}){ return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines){ return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
async function product(slug=SLUG){ for(const v of ['v2','v3']){ const res = await fetch(`https://azure.microsoft.com/api/${v}/pricing/${slug}/calculator/?culture=en-us`, { headers:{accept:'application/json'} }); if(res.ok) return res.json(); if(res.status !== 404) throw new Error(`calculator ${slug} HTTP ${res.status}`); } throw new Error(`calculator ${slug} not found`); }
function cprice(data, offer, region, unit='perhour'){ const o=data.offers[offer]; if(!o) throw new Error(`missing calculator offer ${offer}`); const cr=calc.calcRegion(data, region); const p=(o.prices[unit]||{})[cr] || (o.prices[unit]||{}).global; if(!p) throw new Error(`missing ${offer}/${unit} in ${cr}`); return p.value; }
function pick(rows,pred,what){ const r=rows.find(pred); if(!r) throw new Error('missing '+what); return r; }
async function dtu({region,currency='USD',level,databases=1,extraStorageGb=0,hours=HOURS}){
 const lines=[];
 if(currency==='USD'){
  const data=await product(); const p=cprice(data,OFFER[level],region); lines.push(line(`${level} DTU database: ${databases} * ${hours} h * ${p}`, databases*hours*p, {sourceOffer:OFFER[level]}));
  if(extraStorageGb){ const so=level[0]==='p'?'premium-tier-storage':'standard-storage'; const sp=cprice(data,so,region,'pergb'); lines.push(line(`${level} extra storage: ${databases} * ${extraStorageGb} GB * ${sp}`, databases*extraStorageGb*sp, {sourceOffer:so})); }
 } else {
  const rows=dedupe(await query(`serviceName eq 'SQL Database' and armRegionName eq '${region}'`,currency));
  const sku = level==='basic'?'Basic':level.toUpperCase();
  const r=pick(rows,x=>/^SQL Database Single/.test(x.productName) && x.skuName===sku && /DTU/i.test(x.meterName) && x.retailPrice>0 && /Day/.test(x.unitOfMeasure), `${currency} ${level} DTU`);
  lines.push(line(`${currency} ${level} DTU database: ${databases} * ${hours}/24 days * ${r.retailPrice}`, databases*(hours/24)*r.retailPrice, {meterId:r.meterId}));
  if(extraStorageGb){ const rr=pick(rows,x=>/Data Stored|Data Storage|Standard Data Stored|Premium Data Stored/i.test(x.meterName) && x.retailPrice>0 && (level[0]==='p'?/Premium/i.test(x.productName+x.skuName):/Standard/i.test(x.productName+x.skuName)), `${currency} extra storage`); lines.push(line(`${currency} ${level} extra storage: ${databases} * ${extraStorageGb} GB * ${rr.retailPrice}`, databases*extraStorageGb*rr.retailPrice, {meterId:rr.meterId})); }
 }
 return { monthlyList: total(lines), lines };
}
function c(level, extra={}){ return { name: extra.name || `${level} DTU`, region: extra.region||'eastus2', currency: extra.currency||'USD', component:{ type:'sql-database-dtu', level, databases:extra.databases||1, extraStorageGb:extra.extraStorageGb||0, hours:extra.hours||HOURS },
 // Calculator single DTU per-hour offer times database count and hours; optional extra GB uses Standard or Premium storage offer.
 expected:()=>dtu({region:extra.region||'eastus2',currency:extra.currency||'USD',level,databases:extra.databases||1,extraStorageGb:extra.extraStorageGb||0,hours:extra.hours||HOURS}) }; }
module.exports={ type:'sql-database-dtu', source:'both', cases:[
 c('basic',{hours:24,name:'basic one day'}), c('s0'), c('s1'), c('s2'), c('s3',{extraStorageGb:25}), c('s4'), c('s6'), c('s7'), c('s9'), c('s12'), c('p1',{extraStorageGb:50}), c('p2'), c('p4'), c('p6'), c('p11'), c('p15'),
 c('s3',{region:'westeurope',databases:2,hours:365,extraStorageGb:10,name:'west europe standard extra storage'}),
 c('s0',{region:'westeurope',currency:'EUR',hours:100,name:'EUR west europe retail'})
]};
