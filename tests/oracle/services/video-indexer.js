'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function line(desc,monthlyList,extra={}){return{desc,monthlyList:round2(monthlyList),...extra};} function totalOf(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
const AUDIO={basic:'Basic Audio Indexing Analysis',standard:'Standard Audio Indexing Analysis',advanced:'Advanced Audio Indexing Analysis'};
const VIDEO={basic:'Basic Video Indexing Analysis',standard:'Standard Video Indexing Analysis',advanced:'Advanced Video Indexing Analysis'};
function pick(rows,sku){const r=rows.find(x=>x.skuName===sku); if(!r) throw new Error(`no Video Indexer meter ${sku}`); return r;}
async function vi(o){ const rows=dedupe(await query(`serviceName eq 'Foundry Tools' and productName eq 'Azure Video Indexer' and armRegionName eq '${o.region}'`, o.currency||'USD')); const lines=[]; function add(sku,mins,desc){ if(!mins) return; const r=pick(rows,sku); lines.push(line(`${desc}: ${mins} minutes * ${r.retailPrice}`, (mins/unitSize(r.unitOfMeasure))*r.retailPrice,{meterId:r.meterId})); } if((o.audioPreset||'standard')!=='none') add(AUDIO[o.audioPreset||'standard'],o.minutes,'Audio indexing'); if((o.videoPreset||'standard')!=='none') add(VIDEO[o.videoPreset||'standard'],o.minutes,'Video indexing'); add('Video Modification',o.modificationMinutes||0,'Video modification/redaction'); return {monthlyList:totalOf(lines),lines}; }
module.exports={type:'video-indexer',source:'retail-api',cases:[
 {name:'basic audio only',region:'eastus2',currency:'USD',component:{type:'video-indexer',minutes:60,audioPreset:'basic',videoPreset:'none'}, // Video Indexer audio-only bills input content minutes on the selected audio indexing meter.
  expected:()=>vi({region:'eastus2',minutes:60,audioPreset:'basic',videoPreset:'none'})},
 {name:'standard audio and video',region:'eastus2',currency:'USD',component:{type:'video-indexer',minutes:120,audioPreset:'standard',videoPreset:'standard'}, // Audio and video presets are separate per-minute meters, both applied when both modalities are indexed.
  expected:()=>vi({region:'eastus2',minutes:120,audioPreset:'standard',videoPreset:'standard'})},
 {name:'advanced video only with modification',region:'eastus2',currency:'USD',component:{type:'video-indexer',minutes:30,audioPreset:'none',videoPreset:'advanced',modificationMinutes:10}, // Advanced video indexing and video modification/redaction use distinct per-minute meters.
  expected:()=>vi({region:'eastus2',minutes:30,audioPreset:'none',videoPreset:'advanced',modificationMinutes:10})},
 {name:'west europe advanced audio basic video',region:'westeurope',currency:'USD',component:{type:'video-indexer',minutes:45,audioPreset:'advanced',videoPreset:'basic'}, // Non-US case validates regional Retail API Video Indexer meters.
  expected:()=>vi({region:'westeurope',minutes:45,audioPreset:'advanced',videoPreset:'basic'})},
 {name:'modification only without indexing',region:'eastus2',currency:'USD',component:{type:'video-indexer',minutes:0,audioPreset:'none',videoPreset:'none',modificationMinutes:1}, // Modification/redaction can be estimated without indexing minutes and bills per input content minute.
  expected:()=>vi({region:'eastus2',minutes:0,audioPreset:'none',videoPreset:'none',modificationMinutes:1})},
 {name:'germany north higher regional prices',region:'germanynorth',currency:'USD',component:{type:'video-indexer',minutes:60,audioPreset:'advanced',videoPreset:'advanced',modificationMinutes:10}, // Germany North has higher Retail API per-minute rates than East US 2 for advanced audio/video and modification.
  expected:()=>vi({region:'germanynorth',minutes:60,audioPreset:'advanced',videoPreset:'advanced',modificationMinutes:10})},
 {name:'eur standard audio with modification',region:'westeurope',currency:'EUR',component:{type:'video-indexer',minutes:10,audioPreset:'standard',videoPreset:'none',modificationMinutes:5}, // EUR case queries Retail API per-minute meters directly.
  expected:()=>vi({region:'westeurope',currency:'EUR',minutes:10,audioPreset:'standard',videoPreset:'none',modificationMinutes:5})},
]};

