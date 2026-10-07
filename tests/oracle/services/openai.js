'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function line(desc, monthlyList, extra={}){return{desc,monthlyList:round2(monthlyList),...extra};}
function total(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
function norm(s){return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'');}
const MODEL={
 'gpt-5-nano':{product:'Azure OpenAI GPT5',base:'GPT 5 Nano'},
 'gpt-5.6-sol':{product:'Azure OpenAI GPT5',base:'5.6 sol'},
 'gpt-4.1-mini':{product:'Azure OpenAI',base:'gpt 4.1 mini'},
 'text-embedding-3-small':{product:'Azure OpenAI',base:'text-embedding-3-small'},
 'gpt-realtime-2.1-mini':{product:'Azure OpenAI Media',base:'gpt-realtime-2.1-mini'}
};
function wantedSuffix(deployment,processing){ const dep=deployment==='datazone'?'dzone':deployment==='regional'?'reg':'gl'; return {dep,batch:processing==='batch'}; }
function pick(rows, pred, what){ const hits=rows.filter(pred).sort((a,b)=>a.retailPrice-b.retailPrice); if(!hits.length) throw new Error('missing '+what); return hits[0]; }
function cost(row,tokens){ return tokens/unitSize(row.unitOfMeasure)*row.retailPrice; }
async function openai({region,currency='USD',model,inputTokens=0,cachedInputTokens=0,outputTokens=0,deployment='global',processing='standard',fineTuned=false,trainingTokens=0,hostingHours=0,audioInputTokens=0,audioOutputTokens=0,cachedAudioInputTokens=0,cachedImageInputTokens=0,imageInputTokens=0,imageOutputTokens=0}){
 const m=MODEL[model]; if(!m) throw new Error('oracle model not mapped '+model); const rows=dedupe(await query(`serviceName eq 'Foundry Models' and armRegionName eq '${region}' and productName eq '${m.product}'`, currency));
 const lines=[], ns=norm(m.base), sx=wantedSuffix(deployment,processing);
 const isCached=n=>/cchd|cached|cd/.test(n);
 const meter=(kind)=>pick(rows,r=>{ const n=norm(r.meterName); if(!n.includes(ns)) return false; if(sx.dep==='dzone'&&!/dzone|datazone|dz/.test(n)) return false; if(sx.dep==='reg'&&!/regnl|regional/.test(n)) return false; if(sx.dep==='gl'&&!/glbl|global|gl1m|gltokens/.test(n)) return false; if(sx.batch!==/batch/.test(n)) return false; if(kind==='cached') return isCached(n)&&/(inp|inpt|input)/.test(n)&&!/img|image|audio/.test(n); if(kind==='input') return (model.startsWith('text-embedding') ? n.includes(ns) : /(inp|inpt|input)/.test(n)&&!isCached(n)&&!/img|audio|image/.test(n)); if(kind==='output') return /(outp|outpt|output|opt)/.test(n)&&!/img|image|audio/.test(n); if(kind==='audioInput') return /audio/.test(n)&&/(inp|input)/.test(n)&&!isCached(n); if(kind==='audioOutput') return /audio/.test(n)&&/(outp|output|opt)/.test(n); if(kind==='cachedAudioInput') return /audio/.test(n)&&isCached(n)&&/(inp|input)/.test(n); if(kind==='cachedImageInput') return /img|image/.test(n)&&isCached(n)&&/(inp|input)/.test(n); if(kind==='imageInput') return /img|image/.test(n)&&/(inp|input)/.test(n)&&!isCached(n); if(kind==='imageOutput') return /outputimg|outimg|imgopt|imageoutput/.test(n); return false; }, `${model} ${kind}`);
 if(fineTuned){ const f=(kind)=>pick(rows,r=>{const n=norm(r.meterName); return n.includes(norm(model+'-ft')) && ((kind==='input'&&/input|inpt/.test(n)&&!/cached|cchd/.test(n))||(kind==='cached'&&/cached|cchd/.test(n))||(kind==='output'&&/output|opt/.test(n))||(kind==='hosting'&&/hosting/.test(n))||(kind==='training'&&/training/.test(n)));},`${model} fine-tune ${kind}`);
   if(inputTokens) {const r=f('input'); lines.push(line(`${model} fine-tuned input ${inputTokens}`,cost(r,inputTokens),{meterId:r.meterId}));}
   if(cachedInputTokens){const r=f('cached'); lines.push(line(`${model} fine-tuned cached input ${cachedInputTokens}`,cost(r,cachedInputTokens),{meterId:r.meterId}));}
   if(outputTokens){const r=f('output'); lines.push(line(`${model} fine-tuned output ${outputTokens}`,cost(r,outputTokens),{meterId:r.meterId}));}
   if(trainingTokens){const r=f('training'); lines.push(line(`${model} fine-tuning training ${trainingTokens}`,cost(r,trainingTokens),{meterId:r.meterId}));}
   if(hostingHours){const r=f('hosting'); lines.push(line(`${model} fine-tuned hosting ${hostingHours} h`,hostingHours/unitSize(r.unitOfMeasure)*r.retailPrice,{meterId:r.meterId}));}
 } else if(model==='gpt-realtime-2.1-mini'){
   if(inputTokens){const r=meter('input'); lines.push(line(`${model} text input ${inputTokens}`,cost(r,inputTokens),{meterId:r.meterId}));}
   if(cachedInputTokens){const r=meter('cached'); lines.push(line(`${model} cached input ${cachedInputTokens}`,cost(r,cachedInputTokens),{meterId:r.meterId}));}
   if(outputTokens){const r=meter('output'); lines.push(line(`${model} text output ${outputTokens}`,cost(r,outputTokens),{meterId:r.meterId}));}
   if(audioInputTokens){const r=meter('audioInput'); lines.push(line(`${model} audio input ${audioInputTokens}`,cost(r,audioInputTokens),{meterId:r.meterId}));}
   if(audioOutputTokens){const r=meter('audioOutput'); lines.push(line(`${model} audio output ${audioOutputTokens}`,cost(r,audioOutputTokens),{meterId:r.meterId}));}
   if(cachedAudioInputTokens){const r=meter('cachedAudioInput'); lines.push(line(`${model} cached audio input ${cachedAudioInputTokens}`,cost(r,cachedAudioInputTokens),{meterId:r.meterId}));}
   if(cachedImageInputTokens){const r=meter('cachedImageInput'); lines.push(line(`${model} cached image input ${cachedImageInputTokens}`,cost(r,cachedImageInputTokens),{meterId:r.meterId}));}
   if(imageInputTokens){const r=meter('imageInput'); lines.push(line(`${model} image input ${imageInputTokens}`,cost(r,imageInputTokens),{meterId:r.meterId}));}
   if(imageOutputTokens){const r=meter('imageOutput'); lines.push(line(`${model} image output ${imageOutputTokens}`,cost(r,imageOutputTokens),{meterId:r.meterId}));}
 } else {
   if(inputTokens){const r=meter('input'); lines.push(line(`${model} ${deployment} ${processing} input ${inputTokens}`,cost(r,inputTokens),{meterId:r.meterId}));}
   if(cachedInputTokens){const r=meter('cached'); lines.push(line(`${model} ${deployment} ${processing} cached ${cachedInputTokens}`,cost(r,cachedInputTokens),{meterId:r.meterId}));}
   if(outputTokens){const r=meter('output'); lines.push(line(`${model} ${deployment} ${processing} output ${outputTokens}`,cost(r,outputTokens),{meterId:r.meterId}));}
 }
 return {monthlyList:total(lines),lines};
}
module.exports={type:'openai',source:'retail-api',cases:[
 {name:'gpt-5-nano global standard cached',region:'eastus2',currency:'USD',component:{type:'openai',model:'gpt-5-nano',inputTokens:1000000,cachedInputTokens:500000,outputTokens:200000}, // GPT-5 Nano global standard uses 1M-token input/cached/output meters.
  expected:()=>openai({region:'eastus2',model:'gpt-5-nano',inputTokens:1000000,cachedInputTokens:500000,outputTokens:200000})},
 {name:'gpt-5-nano datazone batch',region:'eastus2',currency:'USD',component:{type:'openai',model:'gpt-5-nano',inputTokens:1000000,cachedInputTokens:500000,outputTokens:200000,deployment:'datazone',processing:'batch'}, // Batch Data Zone uses separate discounted batch meters, including batch cached input.
  expected:()=>openai({region:'eastus2',model:'gpt-5-nano',inputTokens:1000000,cachedInputTokens:500000,outputTokens:200000,deployment:'datazone',processing:'batch'})},
 {name:'gpt-4.1-mini regional standard',region:'eastus2',currency:'USD',component:{type:'openai',model:'gpt-4.1-mini',inputTokens:2000000,cachedInputTokens:1000000,outputTokens:500000,deployment:'regional'}, // Regional GPT-4.1 mini uses 1K-token regnl input/cached/output meters.
  expected:()=>openai({region:'eastus2',model:'gpt-4.1-mini',inputTokens:2000000,cachedInputTokens:1000000,outputTokens:500000,deployment:'regional'})},
 {name:'embedding global no output',region:'eastus2',currency:'USD',component:{type:'openai',model:'text-embedding-3-small',inputTokens:10000000,outputTokens:0}, // Embeddings bill only input tokens on the embedding meter.
  expected:()=>openai({region:'eastus2',model:'text-embedding-3-small',inputTokens:10000000,outputTokens:0})},
 {name:'realtime mini text cached audio and image',region:'eastus2',currency:'USD',component:{type:'openai',model:'gpt-realtime-2.1-mini',inputTokens:1000000,cachedInputTokens:500000,outputTokens:200000,audioInputTokens:100000,audioOutputTokens:50000,cachedAudioInputTokens:100000,cachedImageInputTokens:100000,imageInputTokens:100000}, // Realtime multimodal meters price text, cached, image/audio inputs and audio/text outputs separately.
  expected:()=>openai({region:'eastus2',model:'gpt-realtime-2.1-mini',inputTokens:1000000,cachedInputTokens:500000,outputTokens:200000,audioInputTokens:100000,audioOutputTokens:50000,cachedAudioInputTokens:100000,cachedImageInputTokens:100000,imageInputTokens:100000})},
 {name:'eur gpt-4.1-mini regional',region:'westeurope',currency:'EUR',component:{type:'openai',model:'gpt-4.1-mini',inputTokens:1000000,cachedInputTokens:500000,outputTokens:100000,deployment:'regional'}, // EUR case prices native Retail API currency in a non-US region.
  expected:()=>openai({region:'westeurope',currency:'EUR',model:'gpt-4.1-mini',inputTokens:1000000,cachedInputTokens:500000,outputTokens:100000,deployment:'regional'})},
 {name:'us gov gpt-5.6-sol data zone',region:'usgovvirginia',currency:'USD',component:{type:'openai',model:'gpt-5.6-sol',inputTokens:1000000,cachedInputTokens:500000,outputTokens:1000000,deployment:'datazone'}, // Azure Government offers GPT-5.6 Data Zone meters in gov regions, not commercial Global Standard fallback.
  expected:()=>openai({region:'usgovvirginia',model:'gpt-5.6-sol',inputTokens:1000000,cachedInputTokens:500000,outputTokens:1000000,deployment:'datazone'})},
]};
