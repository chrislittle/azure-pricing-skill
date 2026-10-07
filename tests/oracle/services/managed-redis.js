'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730;
const SLUG = 'managed-redis';
const cache = new Map();
async function product(){ if(cache.has(SLUG)) return cache.get(SLUG); for(const v of ['v2','v3']){ const res=await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`,{headers:{accept:'application/json'}}); if(res.ok){const j=await res.json(); cache.set(SLUG,j); return j;} } throw new Error(`calculator has no price data for ${SLUG}`); }
function total(lines){ return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
function line(desc, monthlyList, extra={}){ return { desc, monthlyList: round2(monthlyList), ...extra }; }
function rateKey(commitment){ return commitment === 'ri1y' ? 'perhouroneyearreserved' : commitment === 'ri3y' ? 'perhourthreeyearreserved' : 'perhour'; }
async function calcRate(size, region, key){ const data=await product(); const o=data.offers[size]; if(!o) throw new Error(`calculator ${SLUG}: no offer ${size}`); const r=calc.calcRegion(data,region); const p=o.prices?.[key]?.[r] || o.prices?.[key]?.global; if(!p) throw new Error(`calculator ${SLUG}/${size}: no ${key} price for ${r}`); return p.value; }
function productName(tier){ return { 'memory-optimized':'Azure Managed Redis - Memory Optimized', balanced:'Azure Managed Redis - Balanced', 'compute-optimized':'Azure Managed Redis - Compute Optimized', 'flash-optimized':'Azure Managed Redis - Flash Optimized' }[tier]; }
async function managed({ region, tier, size, highAvailability=true, caches=1, commitment='payg', hours=HOURS }){ const key=rateKey(commitment); const hourly=await calcRate(size,region,key); const nodes=highAvailability?2:1; const lines=[line(`${tier} ${size}: ${caches} cache(s) * ${nodes} node(s) * ${hours} h * ${hourly}`, caches*nodes*hours*hourly)]; return { monthlyList: total(lines), lines }; }
async function managedRetail({ region, currency='EUR', tier, size, highAvailability=true, caches=1, hours=HOURS }){ const rows=dedupe(await query(`serviceName eq 'Redis Cache' and armRegionName eq '${region}' and skuName eq '${size.toUpperCase()}'`, currency)); const r=rows.find(x=>x.type==='Consumption' && x.productName===productName(tier) && x.meterName===`${size.toUpperCase()} Cache Instance` && x.unitOfMeasure==='1 Hour'); if(!r) throw new Error(`missing Retail API ${tier} ${size} ${currency}`); const nodes=highAvailability?2:1; const lines=[line(`Retail ${r.productName} ${r.meterName}: ${caches} * ${nodes} node(s) * ${hours} h * ${r.retailPrice}`, caches*nodes*hours/unitSize(r.unitOfMeasure)*r.retailPrice,{meterId:r.meterId})]; return { monthlyList: total(lines), lines }; }

module.exports = { type: 'managed-redis', source: 'both', cases: [
  { name:'balanced b5 high availability', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'balanced', size:'b5', highAvailability:true},
    // Calculator v3 B5 hourly cache-instance rate; Microsoft docs state HA deploys primary and replica shards across at least two nodes, so HA doubles node cost.
    expected: async()=>managed({region:'eastus2', tier:'balanced', size:'b5', highAvailability:true}) },
  { name:'balanced b5 no ha dev cache', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'balanced', size:'b5', highAvailability:false},
    // Non-HA is documented only for dev/test and uses fewer VMs, so bill one node rather than two.
    expected: async()=>managed({region:'eastus2', tier:'balanced', size:'b5', highAvailability:false}) },
  { name:'memory optimized m10', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'memory-optimized', size:'m10'},
    // Calculator v3 M10 hourly rate times two HA nodes for production default.
    expected: async()=>managed({region:'eastus2', tier:'memory-optimized', size:'m10'}) },
  { name:'compute optimized x3', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'compute-optimized', size:'x3'},
    // Calculator v3 X3 hourly rate times two HA nodes.
    expected: async()=>managed({region:'eastus2', tier:'compute-optimized', size:'x3'}) },
  { name:'flash optimized a250 payg', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'flash-optimized', size:'a250'},
    // Calculator v3 A250 hourly rate times two HA nodes; public component guidance says flash reservations are not used.
    expected: async()=>managed({region:'eastus2', tier:'flash-optimized', size:'a250'}) },
  { name:'balanced b5 one-year reservation', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'balanced', size:'b5', commitment:'ri1y'},
    // Calculator v3 B5 perhouroneyearreserved is the amortized one-year reserved hourly rate, still multiplied by HA node count.
    expected: async()=>managed({region:'eastus2', tier:'balanced', size:'b5', commitment:'ri1y'}) },
  { name:'compute optimized x3 three-year reservation', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'compute-optimized', size:'x3', commitment:'ri3y'},
    // Calculator v3 X3 perhourthreeyearreserved is the amortized three-year reserved hourly rate.
    expected: async()=>managed({region:'eastus2', tier:'compute-optimized', size:'x3', commitment:'ri3y'}) },
  { name:'flash optimized a250 one-year reservation', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'flash-optimized', size:'a250', commitment:'ri1y'},
    // Calculator v3 A250 perhouroneyearreserved is the amortized one-year reserved hourly rate, multiplied by the two HA nodes.
    expected: async()=>managed({region:'eastus2', tier:'flash-optimized', size:'a250', commitment:'ri1y'}) },
  { name:'balanced b5 three caches', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'balanced', size:'b5', caches:3},
    // Each cache is independently billed; three HA B5 caches multiply the per-node hourly price by 3 caches * 2 nodes.
    expected: async()=>managed({region:'eastus2', tier:'balanced', size:'b5', caches:3}) },  { name:'balanced b5 part-time compute', region:'eastus2', currency:'USD', component:{type:'managed-redis', tier:'balanced', size:'b5', hours:100},
    // Managed Redis is hourly; the selected 100 hours only affect compute/node runtime.
    expected: async()=>managed({region:'eastus2', tier:'balanced', size:'b5', hours:100}) },
  { name:'west europe regional balanced b5', region:'westeurope', currency:'USD', component:{type:'managed-redis', tier:'balanced', size:'b5'},
    // Calculator v3 uses a distinct West Europe B5 hourly rate.
    expected: async()=>managed({region:'westeurope', tier:'balanced', size:'b5'}) },
  { name:'eur retail balanced b5', region:'westeurope', currency:'EUR', component:{type:'managed-redis', tier:'balanced', size:'b5'},
    // EUR case uses Retail API directly: B5 Cache Instance hourly meter * two HA nodes * 730 h.
    expected: async()=>managedRetail({region:'westeurope', currency:'EUR', tier:'balanced', size:'b5'}) },
]};

