'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730;
const SLUG = 'documentdb';
const cache = new Map();
const NODE = { free:null, m10:'documentdb-vcore-node-10', m20:'documentdb-vcore-node-20', m25:'documentdb-vcore-node-1', m30:'documentdb-vcore-node-2', m40:'documentdb-vcore-node-4', m50:'documentdb-vcore-node-8', m60:'documentdb-vcore-node-16', m80:'documentdb-vcore-node-32', m200:'documentdb-vcore-node-64', m300:'documentdb-vcore-node-96' };
const VCORES = { m10:1, m20:2, m25:1, m30:2, m40:4, m50:8, m60:16, m80:32, m200:64, m300:96, 'm200-autoscale':64 };
const STORAGE = [32,64,128,256,512,1024,2048,4095,8192,16384,32767];
async function product(){ if(cache.has(SLUG)) return cache.get(SLUG); for(const v of ['v2','v3']){ const res=await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`,{headers:{accept:'application/json'}}); if(res.ok){const j=await res.json(); cache.set(SLUG,j); return j;} } throw new Error(`calculator has no price data for ${SLUG}`); }
function total(lines){ return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
function line(desc, monthlyList, extra={}){ return { desc, monthlyList: round2(monthlyList), ...extra }; }
function roundStorage(gb){ return STORAGE.find(x=>gb<=x) || STORAGE[STORAGE.length-1]; }
function rateKey(commitment){ return commitment==='ri1y'?'perhouroneyearreserved':commitment==='ri3y'?'perhourthreeyearreserved':'perhour'; }
async function calcRate(offer, region, key){ const data=await product(); const o=data.offers[offer]; if(!o) throw new Error(`calculator ${SLUG}: no offer ${offer}`); const r=calc.calcRegion(data,region); const p=o.prices?.[key]?.[r] || o.prices?.[key]?.global; if(!p) throw new Error(`calculator ${SLUG}/${offer}: no ${key} price for ${r}`); return p.value; }
function pickOne(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one ${what}, found ${hits.length}`); return hits[0]; }
async function docRows(region, currency) { return dedupe(await query(`armRegionName eq '${region}' and contains(productName, 'DocumentDB')`, currency)); }
async function coord1(rows) { return pickOne(rows, x=>x.type==='Consumption' && x.productName==='Azure DocumentDB' && x.skuName==='Coordinator Node 1 vCore' && x.meterName==='vCore' && x.unitOfMeasure==='1 Hour', 'DocumentDB Coordinator Node 1 vCore consumption meter'); }
async function autoscale1(rows) { return pickOne(rows, x=>x.type==='Consumption' && x.productName==='Azure DocumentDB' && x.skuName==='1 vCore - autoscale' && x.meterName==='vCore' && x.unitOfMeasure==='1 Hour', 'DocumentDB 1 vCore autoscale consumption meter'); }
async function storageMeter(rows) { return pickOne(rows, x=>x.type==='Consumption' && x.productName==='Azure DocumentDB' && x.skuName==='General Purpose Storage' && x.meterName==='General Purpose Storage Data Stored' && x.unitOfMeasure==='1 GB/Month', 'DocumentDB General Purpose Storage meter'); }
async function reservation1(rows, term) { return pickOne(rows, x=>x.type==='Reservation' && x.productName==='Azure DocumentDB Reservations' && x.skuName==='Coordinator Node 1 vCore' && x.meterName==='vCore' && x.reservationTerm===term, `DocumentDB Coordinator Node 1 vCore ${term} reservation meter`); }
async function docdb({ region, currency='USD', tier, storageGb, shards=1, highAvailability=true, extraBackupGb=0, backupRedundancy='lrs', commitment='payg', hours=HOURS }){
  if(tier==='free') return { monthlyList:0, lines:[line('Free tier: one 32 GB non-HA cluster',0)] };
  const factor=shards*(highAvailability?2:1);
  const rows = await docRows(region, currency);
  const storageSize=roundStorage(storageGb);
  const lines=[];
  if (['m30','m40','m50','m60','m80','m200','m300','m200-autoscale'].includes(tier)) {
    const vc = VCORES[tier];
    if (commitment === 'ri1y' || commitment === 'ri3y') {
      const term = commitment === 'ri1y' ? '1 Year' : '3 Years';
      const months = commitment === 'ri1y' ? 12 : 36;
      const r = await reservation1(rows, term);
      lines.push(line(`${tier} reserved compute: ${factor} node(s) * ${vc} vCore(s) * ${r.retailPrice}/${months} months`, factor * vc * r.retailPrice / months, { meterId:r.meterId }));
    } else {
      const r = tier === 'm200-autoscale' ? await autoscale1(rows) : await coord1(rows);
      const savings = commitment === 'savings-plan' || commitment === 'sp1y' || commitment === 'sp3y';
      const rate = r.retailPrice * (savings ? 0.8 : 1);
      lines.push(line(`${tier} compute: ${factor} node(s) * ${vc} vCore(s) * ${hours} h * ${r.retailPrice}${savings ? ' * 80% savings plan' : ''}`, factor * vc * hours * rate, { meterId:r.meterId }));
    }
  } else {
    const nodeRate=await calcRate(NODE[tier],region,rateKey(commitment));
    lines.push(line(`${tier} compute: ${factor} node(s) * ${hours} h * ${nodeRate}`, factor*hours*nodeRate));
  }
  const storage = await storageMeter(rows);
  lines.push(line(`General purpose storage: ${factor} node(s) * rounded ${storageSize} GB * ${storage.retailPrice}`, factor*storageSize/unitSize(storage.unitOfMeasure)*storage.retailPrice, { meterId: storage.meterId }));
  return { monthlyList: total(lines), lines };
}

module.exports = { type:'documentdb', source:'both', cases:[
  { name:'free 32gb non-ha cluster', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'free', storageGb:32, highAvailability:false},
    // Microsoft pricing describes the free tier as one 32-GB non-HA cluster; oracle bills zero.
    expected: async()=>docdb({region:'eastus2', tier:'free', storageGb:32, highAvailability:false}) },
  { name:'m10 dev 32gb no ha', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m10', storageGb:32, highAvailability:false},
    // Calculator v3 node-10 hourly offer plus the rounded 32-GB storage tier for one non-HA node.
    expected: async()=>docdb({region:'eastus2', tier:'m10', storageGb:32, highAvailability:false}) },
  { name:'m20 dev 64gb no ha', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m20', storageGb:64, highAvailability:false},
    // Calculator v3 node-20 hourly offer plus 64-GB storage tier for one non-HA node.
    expected: async()=>docdb({region:'eastus2', tier:'m20', storageGb:64, highAvailability:false}) },
  { name:'m25 128gb no ha', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m25', storageGb:128, highAvailability:false},
    // Calculator v3 node-1 offer represents the remaining small tier, with fixed 128-GB storage tier.
    expected: async()=>docdb({region:'eastus2', tier:'m25', storageGb:128, highAvailability:false}) },
  { name:'m30 storage rounds 33gb to 64gb ha', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m30', storageGb:33, highAvailability:true},
    // M30+ compute is vCores times the Coordinator Node 1 vCore hourly meter; 33 GB rounds up to 64 GB and HA doubles compute and storage.
    expected: async()=>docdb({region:'eastus2', tier:'m30', storageGb:33, highAvailability:true}) },
  { name:'m40 two shards storage rounds 65gb to 128gb', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m40', storageGb:65, shards:2, highAvailability:true},
    // Two shards each have HA primary/standby nodes; 65 GB rounds to the 128-GB storage offer per node.
    expected: async()=>docdb({region:'eastus2', tier:'m40', storageGb:65, shards:2, highAvailability:true}) },
  { name:'m50 one-year reservation', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m50', storageGb:128, commitment:'ri1y'},
    // Reservations are published as Coordinator Node 1 vCore reservation totals: $360/vCore-year amortized monthly; storage remains consumption charged.
    expected: async()=>docdb({region:'eastus2', tier:'m50', storageGb:128, commitment:'ri1y'}) },
  { name:'m60 three-year reservation', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m60', storageGb:256, commitment:'ri3y'},
    // Three-year reservation is $720 per vCore for the full term, amortized over 36 months; storage is not reserved.
    expected: async()=>docdb({region:'eastus2', tier:'m60', storageGb:256, commitment:'ri3y'}) },
  { name:'m80 part-time compute full storage', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m80', storageGb:512, hours:100},
    // Compute honors 100 running hours while provisioned storage remains a full-month fixed tier.
    expected: async()=>docdb({region:'eastus2', tier:'m80', storageGb:512, hours:100}) },
  { name:'m200 large tier', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m200', storageGb:1024},
    // M200 is 64 vCores per node times the Coordinator Node 1 vCore hourly meter, doubled for HA.
    expected: async()=>docdb({region:'eastus2', tier:'m200', storageGb:1024}) },
  { name:'m300 west europe', region:'westeurope', currency:'USD', component:{type:'documentdb', tier:'m300', storageGb:2048},
    // West Europe calculator compute/storage rates.
    expected: async()=>docdb({region:'westeurope', tier:'m300', storageGb:2048}) },
  { name:'m50 payg vcore math blocker case', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m50', storageGb:128, highAvailability:false},
    // M50 is 8 vCores: 8 * 730 * $0.068961 plus 128 GB * $0.138 = about $420.39, not the higher Coordinator Node 8 vCore aggregate meter.
    expected: async()=>docdb({region:'eastus2', tier:'m50', storageGb:128, highAvailability:false}) },
  { name:'eur m30 two shards vcore math', region:'westeurope', currency:'EUR', component:{type:'documentdb', tier:'m30', storageGb:128, shards:2, highAvailability:true},
    // West Europe EUR M30 with two shards and HA is 4 nodes * 2 vCores * 730 * Coordinator Node 1 vCore plus 4 * 128 GB storage (about EUR 520.52).
    expected: async()=>docdb({region:'westeurope', currency:'EUR', tier:'m30', storageGb:128, shards:2, highAvailability:true}) },
  { name:'m50 one-year reservation per-vcore total', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m50', storageGb:128, highAvailability:false, commitment:'ri1y'},
    // One-year reservation is $360 per vCore for the year: 8 * 360 / 12 plus storage.
    expected: async()=>docdb({region:'eastus2', tier:'m50', storageGb:128, highAvailability:false, commitment:'ri1y'}) },
  { name:'m50 three-year reservation per-vcore total', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m50', storageGb:128, highAvailability:false, commitment:'ri3y'},
    // Three-year reservation is $720 per vCore for the full term: 8 * 720 / 36 plus storage.
    expected: async()=>docdb({region:'eastus2', tier:'m50', storageGb:128, highAvailability:false, commitment:'ri3y'}) },
  { name:'m200 autoscale one-vcore meter', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m200-autoscale', storageGb:1024, highAvailability:false},
    // M200-Autoscale uses the 1 vCore - autoscale hourly meter times 64 vCores, plus storage.
    expected: async()=>docdb({region:'eastus2', tier:'m200-autoscale', storageGb:1024, highAvailability:false}) },
  { name:'m50 savings plan 20 percent compute discount', region:'eastus2', currency:'USD', component:{type:'documentdb', tier:'m50', storageGb:128, highAvailability:false, commitment:'sp1y'},
    // Savings plan applies a 20% discount to compute only: 8 * 730 * Coordinator Node 1 vCore * 80%, plus full storage.
    expected: async()=>docdb({region:'eastus2', tier:'m50', storageGb:128, highAvailability:false, commitment:'sp1y'}) },
]};

