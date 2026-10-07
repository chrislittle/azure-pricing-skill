'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS=730;
const REGION={eastus2:'us-east-2',westeurope:'europe-west',eastus:'us-east'};
const TOKEN_RATES={
  opus:{input:100,output:500,cacheRead:10,cacheWrite:125},
  gpt:{input:35,output:280,cacheRead:3.5,cacheWrite:0},
};
const TASK_TOKENS={
  quickQuestions:{input:20000,output:2000,cacheRead:15000,cacheWrite:5000},
  incidentInvestigations:{input:200000,output:15000,cacheRead:150000,cacheWrite:50000},
  fullRemediations:{input:500000,output:40000,cacheRead:400000,cacheWrite:100000},
};
async function product(){ const res=await fetch('https://azure.microsoft.com/api/v3/pricing/sre-agent/calculator/?culture=en-us',{headers:{accept:'application/json'}}); if(!res.ok) throw new Error(`SRE calculator HTTP ${res.status}`); return res.json(); }
async function aauPrice(region,currency='USD'){
  if(currency==='USD') { const j=await product(); return {price:j.offers['sre-agent-active-and-always-on-flow'].prices.peragentunit[REGION[region]||region].value, source:'calculator'}; }
  const rows=dedupe(await query(`serviceName eq 'Foundry Tools' and productName eq 'Azure Agent Unit' and armRegionName eq '${region}'`, currency));
  const hits=rows.filter(r=>r.skuName==='SRE'&&r.meterName==='SRE Agent Unit');
  if(hits.length!==1) throw new Error(`expected one SRE Agent Unit Retail API meter, found ${hits.length}`);
  return {price:hits[0].retailPrice/unitSize(hits[0].unitOfMeasure), meterId:hits[0].meterId, source:'retail-api'};
}
function taskAaus(model, task){ const r=TOKEN_RATES[model], t=TASK_TOKENS[task]; return (t.input*r.input + t.output*r.output + t.cacheRead*r.cacheRead + t.cacheWrite*r.cacheWrite)/1000000; }
function activeAaus(o){ const model=o.model||'opus'; return (o.activeAaus||0)+(o.quickQuestions||0)*taskAaus(model,'quickQuestions')+(o.incidentInvestigations||0)*taskAaus(model,'incidentInvestigations')+(o.fullRemediations||0)*taskAaus(model,'fullRemediations'); }
async function sre(o){ const unit=await aauPrice(o.region,o.currency||'USD'); const price=unit.price; const always=(o.agents||0)*(o.hours??HOURS)*4; const active=activeAaus(o); const lines=[{desc:`Always-on flow: ${o.agents||0} agents * ${o.hours??HOURS} h * 4 AAU/h * ${price}`,monthlyList:round2(always*price),unitPrice:price,source:unit.source}]; if(active) lines.push({desc:`Active flow: ${round2(active)} AAUs from ${o.model||'opus'} token-derived task estimates * ${price}`,monthlyList:round2(active*price),unitPrice:price,source:unit.source}); return {monthlyList:round2(lines.reduce((s,l)=>s+l.monthlyList,0)),lines}; }
module.exports={ type:'sre-agent', source:'both', cases:[
 {name:'always-on one agent full month',region:'eastus2',currency:'USD',component:{type:'sre-agent',agents:1,hours:730,model:'opus'}, // Learn: always-on flow is 4 AAUs per agent-hour; calculator price is per AAU.
  expected:()=>sre({region:'eastus2',agents:1,hours:730,model:'opus'})},
 {name:'one-hour always-on boundary',region:'eastus2',currency:'USD',component:{type:'sre-agent',agents:1,hours:1,model:'opus'}, // Boundary: one provisioned agent-hour consumes exactly 4 AAUs.
  expected:()=>sre({region:'eastus2',agents:1,hours:1,model:'opus'})},
 {name:'gpt quick question token arithmetic',region:'eastus2',currency:'USD',component:{type:'sre-agent',agents:0,hours:0,quickQuestions:1,model:'gpt'}, // GPT quick = 20K*35/1M + 2K*280/1M + 15K*3.5/1M + 5K*0/1M = 1.3125 AAUs.
  expected:()=>sre({region:'eastus2',agents:0,hours:0,quickQuestions:1,model:'gpt'})},
 {name:'opus active flow task mix',region:'eastus2',currency:'USD',component:{type:'sre-agent',agents:1,hours:730,quickQuestions:2,incidentInvestigations:1,fullRemediations:1,model:'opus'}, // Opus AAUs are derived from Learn per-1M-token rates for input/output/cache read/cache write.
  expected:()=>sre({region:'eastus2',agents:1,hours:730,quickQuestions:2,incidentInvestigations:1,fullRemediations:1,model:'opus'})},
 {name:'gpt active flow task mix',region:'eastus2',currency:'USD',component:{type:'sre-agent',agents:1,hours:100,quickQuestions:10,incidentInvestigations:2,fullRemediations:1,model:'gpt'}, // GPT task estimates: quick 1.3125, incident 11.725, full remediation 30.1 AAUs.
  expected:()=>sre({region:'eastus2',agents:1,hours:100,quickQuestions:10,incidentInvestigations:2,fullRemediations:1,model:'gpt'})},
 {name:'explicit active AAUs only',region:'eastus2',currency:'USD',component:{type:'sre-agent',agents:2,hours:24,activeAaus:500,model:'opus'}, // User-supplied active AAUs are added directly to always-on AAUs.
  expected:()=>sre({region:'eastus2',agents:2,hours:24,activeAaus:500,model:'opus'})},
 {name:'west europe regional AAU price',region:'westeurope',currency:'USD',component:{type:'sre-agent',agents:1,hours:730,quickQuestions:1,model:'opus'}, // Calculator v3 exposes region-specific per-AAU prices; West Europe differs from East US 2.
  expected:()=>sre({region:'westeurope',agents:1,hours:730,quickQuestions:1,model:'opus'})},
 {name:'eur west europe retail aau meter',region:'westeurope',currency:'EUR',component:{type:'sre-agent',agents:1,hours:24,quickQuestions:1,model:'gpt'}, // EUR uses Retail API SRE Agent Unit meter; GPT quick question is 1.3125 active AAUs.
  expected:()=>sre({region:'westeurope',currency:'EUR',agents:1,hours:24,quickQuestions:1,model:'gpt'})},
]};
