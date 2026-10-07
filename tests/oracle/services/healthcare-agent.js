'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS=730;
function line(desc, monthlyList, extra={}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
function exact(rows,pred,what){const hits=rows.filter(pred); if(hits.length!==1) throw new Error(`expected one Healthcare Agent meter for ${what}, found ${hits.length}`); return hits[0];}
async function health(opts){
  const rows=dedupe(await query(`(productName eq 'Healthcare Agent Service' or productName eq 'Microsoft Azure Health Bot') and armRegionName eq '${opts.region}'`, opts.currency||'USD'));
  const plan=opts.plan||'agent'; const lines=[];
  if(plan==='legacy-standard'){
    const days=(opts.hours??HOURS)/24; const units=opts.legacyUnits??1;
    const unit=exact(rows,r=>r.productName==='Microsoft Azure Health Bot'&&r.skuName==='Standard'&&r.meterName==='Standard Unit','legacy Standard Unit');
    lines.push(line(`Legacy Standard units: ${units} unit(s) * ${days} days * ${unit.retailPrice}`, (units*days/unitSize(unit.unitOfMeasure))*unit.retailPrice,{meterId:unit.meterId}));
    const msgOver=Math.max(0,(opts.legacyMessages||0)-units*10000);
    if(msgOver){const m=exact(rows,r=>r.productName==='Microsoft Azure Health Bot'&&r.skuName==='Standard'&&r.meterName==='Standard Overage Messages','legacy overage messages'); lines.push(line(`Legacy message overage: (${opts.legacyMessages}-${units*10000}) / ${m.unitOfMeasure} * ${m.retailPrice}`, (msgOver/unitSize(m.unitOfMeasure))*m.retailPrice,{meterId:m.meterId}));}
    const mcuOver=Math.max(0,(opts.legacyMedicalContentUnits||0)-units*1000);
    if(mcuOver){const m=exact(rows,r=>r.productName==='Microsoft Azure Health Bot'&&r.skuName==='Standard'&&r.meterName==='Standard Overage MCU','legacy overage MCU'); lines.push(line(`Legacy medical content unit overage: (${opts.legacyMedicalContentUnits}-${units*1000}) * ${m.retailPrice}`, (mcuOver/unitSize(m.unitOfMeasure))*m.retailPrice,{meterId:m.meterId}));}
    return {monthlyList:totalOf(lines),lines};
  }
  const actions=(opts.actions||0)+(opts.classicMessages||0)+2*(opts.customerSourceResponses||0)+2*(opts.customerExtensionResponses||0)+5*(opts.credibleSourceResponses||0)+18*(opts.triageSessions||0);
  const free=plan==='free'; const r=exact(rows,x=>x.productName==='Healthcare Agent Service'&&x.skuName===(free?'Free Action':'Action')&&x.meterName===(free?'Free Action':'Action'), `${plan} action`);
  lines.push(line(`${free?'Free':'Agent'} plan billable actions: ${actions}`, (actions/unitSize(r.unitOfMeasure))*r.retailPrice,{meterId:r.meterId}));
  return {monthlyList:totalOf(lines),lines};
}
module.exports={ type:'healthcare-agent', source:'retail-api', cases:[
 {name:'zero quantities agent plan errors',region:'eastus2',currency:'USD',component:{type:'healthcare-agent',plan:'agent'}, expectEngineError:/billable actions|quantity|zero|at least/i},
 {name:'free development plan',region:'eastus2',currency:'USD',component:{type:'healthcare-agent',plan:'free',classicMessages:1000}, // Free plan uses the zero-price Free Action meter.
  expected:()=>health({region:'eastus2',plan:'free',classicMessages:1000})},
 {name:'agent classic one action each',region:'eastus2',currency:'USD',component:{type:'healthcare-agent',plan:'agent',classicMessages:1000}, // Healthcare Agent classic responses count as 1 billable action each.
  expected:()=>health({region:'eastus2',plan:'agent',classicMessages:1000})},
 {name:'agent sources extensions and credible sources',region:'eastus2',currency:'USD',component:{type:'healthcare-agent',plan:'agent',customerSourceResponses:100,customerExtensionResponses:50,credibleSourceResponses:10}, // Customer sources/extensions are 2 actions; built-in credible sources are 5 actions.
  expected:()=>health({region:'eastus2',plan:'agent',customerSourceResponses:100,customerExtensionResponses:50,credibleSourceResponses:10})},
 {name:'triage sessions and explicit actions west europe',region:'westeurope',currency:'USD',component:{type:'healthcare-agent',plan:'agent',triageSessions:10,actions:25}, // Triage sessions count as 18 actions and explicit actions are additive.
  expected:()=>health({region:'westeurope',plan:'agent',triageSessions:10,actions:25})},
 {name:'legacy standard included monthly grants',region:'eastus2',currency:'USD',component:{type:'healthcare-agent',plan:'legacy-standard',legacyUnits:1,legacyMessages:10000,legacyMedicalContentUnits:1000,hours:730}, // Legacy S1 bills unit-days; each unit includes 10K messages and 1K MCUs/month.
  expected:()=>health({region:'eastus2',plan:'legacy-standard',legacyUnits:1,legacyMessages:10000,legacyMedicalContentUnits:1000,hours:730})},
 {name:'legacy standard overage messages and mcu',region:'eastus2',currency:'USD',component:{type:'healthcare-agent',plan:'legacy-standard',legacyUnits:2,legacyMessages:25000,legacyMedicalContentUnits:2500,hours:240}, // Legacy S1 overages are extra messages per 1K and extra medical content units after per-unit grants.
  expected:()=>health({region:'eastus2',plan:'legacy-standard',legacyUnits:2,legacyMessages:25000,legacyMedicalContentUnits:2500,hours:240})},
 {name:'eur mixed action weights',region:'westeurope',currency:'EUR',component:{type:'healthcare-agent',plan:'agent',classicMessages:10,customerSourceResponses:10,credibleSourceResponses:10,triageSessions:1}, // EUR case queries the Retail API action meter and applies documented action weights.
  expected:()=>health({region:'westeurope',currency:'EUR',plan:'agent',classicMessages:10,customerSourceResponses:10,credibleSourceResponses:10,triageSessions:1})},
]};
