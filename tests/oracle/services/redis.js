'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730;
const SLUG = 'redis-cache';
const cache = new Map();
async function product() { if (cache.has(SLUG)) return cache.get(SLUG); for (const v of ['v2','v3']) { const res = await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`, { headers:{accept:'application/json'} }); if (res.ok) { const j = await res.json(); cache.set(SLUG, j); return j; } } throw new Error(`calculator has no price data for ${SLUG}`); }
function total(lines){ return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
function line(desc, monthlyList, extra={}){ return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calcRate(offer, region, key){ const data=await product(); const o=data.offers[offer]; if(!o) throw new Error(`calculator ${SLUG}: no offer ${offer}`); const r=calc.calcRegion(data,region); const p=o.prices?.[key]?.[r] || o.prices?.[key]?.global; if(!p) throw new Error(`calculator ${SLUG}/${offer}: no ${key} price for ${r}`); return p.value; }
function offerFor(tier,size){ return `${tier}-${size}`; }
function rateKey(commitment){ return commitment==='ri1y'?'perhouroneyearreserved':commitment==='ri3y'?'perhourthreeyearreserved':'perhour'; }
async function redis({ region, tier, size, shards=1, replicasPerShard=1, caches=1, scaleFactor=1, commitment='payg', hours=HOURS }){
  const lines=[];
  if (tier === 'enterprise' || tier === 'enterprise-flash') {
    const infra = await calcRate(offerFor(tier,size), region, rateKey(commitment));
    const nodeText = tier === 'enterprise' ? '2-node minimum' : '3-node minimum';
    lines.push(line(`${tier} ${size} infrastructure (${nodeText}, scale x${scaleFactor}): ${caches} cache(s) * ${scaleFactor} * ${hours} h * ${infra}`, caches * scaleFactor * hours * infra));
    if (tier === 'enterprise' && size === 'e1') {
      const software = await calcRate(`${offerFor(tier,size)}-software`, region, 'perhour');
      lines.push(line(`enterprise e1 E1 Internal software: ${caches} cache(s) * ${hours} h * ${software}`, caches * hours * software));
    }
  } else {
    const hourly = await calcRate(offerFor(tier,size), region, rateKey(commitment));
    const replicaFactor = tier === 'premium' ? Math.max(1, (1 + replicasPerShard) / 2) : 1;
    const qty = caches * (tier === 'premium' ? shards : 1) * replicaFactor;
    lines.push(line(`${tier} ${size}: ${qty} billable cache unit(s) * ${hours} h * ${hourly}`, qty * hours * hourly));
  }
  return { monthlyList: total(lines), lines };
}
async function redisRetail({ region, currency='EUR', tier, size, caches=1, hours=HOURS }){ const proper=tier[0].toUpperCase()+tier.slice(1); const rows=dedupe(await query(`serviceName eq 'Redis Cache' and armRegionName eq '${region}' and skuName eq '${size.toUpperCase()}'`, currency)); const meterName=tier==='standard'?`${size.toUpperCase()} Cache Instance`:`${size.toUpperCase()} Cache`; const r=rows.find(x=>x.type==='Consumption' && x.productName===`Azure Redis Cache ${proper}` && x.meterName===meterName && x.unitOfMeasure==='1 Hour'); if(!r) throw new Error(`missing Retail API ${tier} ${size} ${currency}`); const serverFactor=tier==='standard'?2:1; const lines=[line(`Retail ${r.productName} ${r.meterName}: ${caches} cache(s) * ${serverFactor} server(s) * ${hours} h * ${r.retailPrice}`, caches*serverFactor*hours/unitSize(r.unitOfMeasure)*r.retailPrice,{meterId:r.meterId})]; return { monthlyList: total(lines), lines }; }
module.exports = { type:'redis', source:'both', cases:[
  { name:'basic c0 single-node cache', region:'eastus2', currency:'USD', component:{type:'redis', tier:'basic', size:'c0'}, expected: async()=>redis({region:'eastus2', tier:'basic', size:'c0'}) },
  { name:'standard c1 production cache', region:'eastus2', currency:'USD', component:{type:'redis', tier:'standard', size:'c1'}, expected: async()=>redis({region:'eastus2', tier:'standard', size:'c1'}) },
  { name:'premium p1 three shards default replica', region:'eastus2', currency:'USD', component:{type:'redis', tier:'premium', size:'p1', shards:3}, expected: async()=>redis({region:'eastus2', tier:'premium', size:'p1', shards:3}) },
  { name:'premium p2 extra replica', region:'eastus2', currency:'USD', component:{type:'redis', tier:'premium', size:'p2', shards:2, replicasPerShard:2}, expected: async()=>redis({region:'eastus2', tier:'premium', size:'p2', shards:2, replicasPerShard:2}) },
  { name:'premium p5 largest size', region:'eastus2', currency:'USD', component:{type:'redis', tier:'premium', size:'p5'}, expected: async()=>redis({region:'eastus2', tier:'premium', size:'p5'}) },
  { name:'premium p5 ten-shard limit', region:'eastus2', currency:'USD', component:{type:'redis', tier:'premium', size:'p5', shards:10}, expected: async()=>redis({region:'eastus2', tier:'premium', size:'p5', shards:10}) },
  { name:'premium p5 thirty-shard preview limit', region:'eastus2', currency:'USD', component:{type:'redis', tier:'premium', size:'p5', shards:30}, expected: async()=>redis({region:'eastus2', tier:'premium', size:'p5', shards:30}) },
  { name:'premium p1 one-year reservation', region:'eastus2', currency:'USD', component:{type:'redis', tier:'premium', size:'p1', commitment:'ri1y'}, expected: async()=>redis({region:'eastus2', tier:'premium', size:'p1', commitment:'ri1y'}) },
  { name:'enterprise e1 infrastructure plus E1 Internal software', region:'eastus2', currency:'USD', component:{type:'redis', tier:'enterprise', size:'e1'}, expected: async()=>redis({region:'eastus2', tier:'enterprise', size:'e1'}) },
  { name:'enterprise e10 infrastructure two data nodes', region:'eastus2', currency:'USD', component:{type:'redis', tier:'enterprise', size:'e10'}, expected: async()=>redis({region:'eastus2', tier:'enterprise', size:'e10'}) },
  { name:'enterprise e10 scale factor three', region:'eastus2', currency:'USD', component:{type:'redis', tier:'enterprise', size:'e10', scaleFactor:3}, expected: async()=>redis({region:'eastus2', tier:'enterprise', size:'e10', scaleFactor:3}) },
  { name:'enterprise e10 three-year reserved infrastructure', region:'eastus2', currency:'USD', component:{type:'redis', tier:'enterprise', size:'e10', commitment:'ri3y'}, expected: async()=>redis({region:'eastus2', tier:'enterprise', size:'e10', commitment:'ri3y'}) },
  { name:'enterprise flash f300 infrastructure three data nodes in west europe', region:'westeurope', currency:'USD', component:{type:'redis', tier:'enterprise-flash', size:'f300'}, expected: async()=>redis({region:'westeurope', tier:'enterprise-flash', size:'f300'}) },
  { name:'enterprise flash f300 scale factor three', region:'westeurope', currency:'USD', component:{type:'redis', tier:'enterprise-flash', size:'f300', scaleFactor:3}, expected: async()=>redis({region:'westeurope', tier:'enterprise-flash', size:'f300', scaleFactor:3}) },
  { name:'standard c1 part-time', region:'eastus2', currency:'USD', component:{type:'redis', tier:'standard', size:'c1', hours:100}, expected: async()=>redis({region:'eastus2', tier:'standard', size:'c1', hours:100}) },
  { name:'eur retail standard c1', region:'westeurope', currency:'EUR', component:{type:'redis', tier:'standard', size:'c1'}, expected: async()=>redisRetail({region:'westeurope', currency:'EUR', tier:'standard', size:'c1'}) },
]};
