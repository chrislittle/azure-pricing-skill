'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const HOURS=730, SLUG='openai-service';
function line(desc,monthlyList,extra={}){return{desc,monthlyList:round2(monthlyList),...extra};} function total(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
async function product(){for(const v of ['v2','v3']){const res=await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`,{headers:{accept:'application/json'}}); if(res.ok)return res.json(); if(res.status!==404)throw new Error(`calculator ${SLUG} HTTP ${res.status}`);} throw new Error('calculator not found');}
const OFFER={global:'language-models-gpt-4o-global-ptu','data-zone':'language-models-gpt-4o-area-ptu',regional:'language-models-ptu'};
function cprice(data,offer,region,unit){const o=data.offers[offer]; if(!o)throw new Error('missing '+offer); const cr=calc.calcRegion(data,region); const p=(o.prices[unit]||{})[cr]||(o.prices[unit]||{}).global; if(!p)throw new Error(`missing ${offer}/${unit} in ${cr}`); return p.value;}
const MODEL_RULES={
 'gpt-6.1-sol':{gd:[15,5],regional:[50,50]}, 'gpt-6-sol':{gd:[15,5],regional:[50,50]}, 'gpt-6-astra':{gd:[15,5],regional:[50,50]},
 'gpt-5.6-luna':{gd:[15,5],regional:[50,50]}, 'gpt-5.6-terra':{gd:[15,5],regional:[50,50]}, 'gpt-5.6-sol':{gd:[15,5],regional:[50,50]},
 'gpt-5.5':{gd:[15,5],regional:[50,50]}, 'gpt-image-2':{gd:[100,100],regional:[100,100]}, 'gpt-5.4':{gd:[15,5],regional:[50,50]},
 'gpt-5.4-mini':{gd:[15,5],regional:[25,25]}, 'gpt-5.3-codex':{gd:[15,5],regional:[50,50]}, 'gpt-5.2':{gd:[15,5],regional:[50,50]},
 'gpt-5.2-codex':{gd:[15,5],regional:[50,50]}, 'gpt-5.1':{gd:[15,5],regional:[50,50]}, 'gpt-5.1-codex':{gd:[15,5],regional:[50,50]},
 'gpt-5':{gd:[15,5],regional:[50,50]}, 'gpt-5-mini':{gd:[15,5],regional:[25,25]}, 'gpt-4.1':{gd:[15,5],regional:[50,50]},
 'gpt-4.1-mini':{gd:[15,5],regional:[25,25]}, 'gpt-4.1-nano':{gd:[15,5],regional:[25,25]}, 'o3':{gd:[15,5],regional:[50,50]},
 'o4-mini':{gd:[15,5],regional:[25,25]}, 'gpt-4o':{gd:[15,5],regional:[50,50]}, 'gpt-4o-mini':{gd:[15,5],regional:[25,25]},
 'o3-mini':{gd:[15,5],regional:[25,25]}, 'o1':{gd:[15,5],regional:[25,50]},
};
function normalizeModel(model){ return String(model||'').toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/,''); }
function rule(model,deployment){
 const m=normalizeModel(model); const spec=MODEL_RULES[m]; if(!spec) throw new Error(`unknown provisioned model ${model}`);
 const pair=deployment==='regional'?spec.regional:spec.gd; return {min:pair[0],step:pair[1]};
}
function validate(model,deployment,ptus){ const r=rule(model,deployment); if(r.available===false) throw new Error(`${model} is not available for ${deployment} provisioned deployments`); if(ptus<r.min) throw new Error(`${model} ${deployment} requires at least ${r.min} PTUs`); if((ptus-r.min)%r.step!==0) throw new Error(`${model} ${deployment} PTUs must increase in steps of ${r.step}`); }
async function ptu({region,currency='USD',model,deployment,ptus,commitment='hourly',hours=HOURS}){
 validate(model,deployment,ptus); const lines=[];
 if(currency==='USD'){
  const data=await product(); const offer=OFFER[deployment]; const unit=commitment==='reserved-1-month'?'p1m':commitment==='reserved-1-year'?'p1y':'payg'; const p=cprice(data,offer,region,unit); const cost=commitment==='reserved-1-year'?ptus*p/12:commitment==='reserved-1-month'?ptus*p:ptus*hours*p; lines.push(line(`${model} ${deployment} PTU ${ptus} ${commitment} @ ${p}`,cost,{sourceOffer:offer,unit}));
 } else {
  const rows=dedupe(await query(`serviceName eq 'Foundry Models' and armRegionName eq '${region}'`,currency)); const sku=deployment==='global'?'Provisioned Managed Global':deployment==='data-zone'?'Provisioned Managed Data Zone':'Provisioned Managed Regional';
  if(commitment==='hourly'){ const r=rows.find(x=>x.productName==='Azure OpenAI'&&x.skuName===sku&&x.type==='Consumption'); if(!r)throw new Error('missing '+sku); lines.push(line(`${currency} ${model} ${deployment} PTU hourly`,ptus*hours*r.retailPrice,{meterId:r.meterId})); }
  else { const term=commitment==='reserved-1-month'?'1 Month':'1 Year'; const r=rows.find(x=>x.productName==='Azure AI Foundry Provisioned Throughput Reservation'&&x.skuName===sku&&x.type==='Reservation'&&x.reservationTerm===term); if(!r)throw new Error('missing '+sku+' '+term); lines.push(line(`${currency} ${model} ${deployment} PTU ${term} reservation`,ptus*(term==='1 Year'?r.retailPrice/12:r.retailPrice),{meterId:r.meterId})); }
 }
 return {monthlyList:total(lines),lines};
}
function c(name,cfg){return{name,region:cfg.region||'eastus2',currency:cfg.currency||'USD',component:{type:'openai-provisioned',...cfg},
 // Microsoft Learn deployment-parameter tables set model-specific PTU minimums/steps; calculator/Retail offers bill hourly, monthly reservation, or annual reservation / 12.
 expected:()=>ptu({region:cfg.region||'eastus2',currency:cfg.currency||'USD',...cfg})};}
module.exports={type:'openai-provisioned',source:'both',cases:[
 c('global gpt-5.2 minimum 15 hourly',{model:'gpt-5.2',deployment:'global',ptus:15,hours:100}),
 c('dated gpt-5.2 accepted',{model:'gpt-5.2-2025-12-11',deployment:'global',ptus:15,hours:50}),
 c('global gpt-5.2 step 20 one month reserved',{model:'gpt-5.2',deployment:'global',ptus:20,commitment:'reserved-1-month'}),
 c('data-zone gpt-image-2 minimum 100',{model:'gpt-image-2',deployment:'data-zone',ptus:100,hours:100}),
 c('regional gpt-image-2 minimum 100',{model:'gpt-image-2',deployment:'regional',ptus:100,hours:100}),
 c('regional gpt-4o minimum 50',{model:'gpt-4o',deployment:'regional',ptus:50,hours:200}),
 c('regional gpt-4.1-mini minimum 25',{model:'gpt-4.1-mini',deployment:'regional',ptus:25,hours:100}),
 c('regional o1 minimum 25',{model:'o1',deployment:'regional',ptus:25,hours:100}),
 c('regional o1 next valid step 75',{model:'o1',deployment:'regional',ptus:75,commitment:'reserved-1-month'}),
 c('regional gpt-6 50 step',{model:'gpt-6-sol',deployment:'regional',ptus:100,commitment:'reserved-1-month'}),
 c('EUR data-zone gpt-5.2 one year reservation',{model:'gpt-5.2',deployment:'data-zone',ptus:20,commitment:'reserved-1-year',region:'westeurope',currency:'EUR'}),
 c('EUR west europe global hourly',{model:'gpt-5.2',deployment:'global',ptus:15,region:'westeurope',currency:'EUR',hours:100}),
 {name:'global below minimum rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'gpt-5.2',deployment:'global',ptus:14},expectEngineError:/PTU|minimum|least|step|invalid/i},
 {name:'global invalid 5-PTU step rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'gpt-5.2',deployment:'global',ptus:16},expectEngineError:/PTU|minimum|least|step|invalid/i},
 {name:'gpt-image-2 global 15 rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'gpt-image-2',deployment:'global',ptus:15},expectEngineError:/PTU|minimum|least|step|invalid/i},
 {name:'regional gpt-4o 25 rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'gpt-4o',deployment:'regional',ptus:25},expectEngineError:/PTU|minimum|least|step|invalid/i},
 {name:'regional o1 invalid 50 step rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'o1',deployment:'regional',ptus:50},expectEngineError:/PTU|minimum|least|step|invalid/i},
 {name:'unknown model rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'foo-model',deployment:'global',ptus:15},expectEngineError:/unknown|model|unsupported|invalid/i},
 {name:'gpt-5.2-chat rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'gpt-5.2-chat',deployment:'global',ptus:15},expectEngineError:/unknown|model|unsupported|invalid/i},
 {name:'gpt-6-foo rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'gpt-6-foo',deployment:'global',ptus:15},expectEngineError:/unknown|model|unsupported|invalid/i},
 {name:'o1-mini rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'o1-mini',deployment:'global',ptus:15},expectEngineError:/unknown|model|unsupported|invalid/i},
 {name:'gpt-5-nano rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'gpt-5-nano',deployment:'global',ptus:15},expectEngineError:/unknown|model|unsupported|invalid/i},
 {name:'gpt-oss rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'gpt-oss-20b',deployment:'global',ptus:50},expectEngineError:/unknown|model|unsupported|invalid/i},
 {name:'deepseek rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'DeepSeek v3.2',deployment:'global',ptus:1080},expectEngineError:/unknown|model|unsupported|invalid/i},
 {name:'llama rejected',region:'eastus2',currency:'USD',component:{type:'openai-provisioned',model:'Llama-3.3-70B-Instruct',deployment:'global',ptus:100},expectEngineError:/unknown|model|unsupported|invalid/i}
]};
