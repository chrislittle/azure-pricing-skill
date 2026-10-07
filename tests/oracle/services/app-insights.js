'use strict';
const { query, dedupe, round2 } = require('../api');
const HOURS=730;
function line(desc,monthlyList,extra={}){return{desc,monthlyList:round2(monthlyList),...extra};} function total(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
function pick(rows,pred,what){const r=rows.find(pred); if(!r)throw new Error('missing '+what); return r;}
async function app({region,currency='USD',ingestGbPerMonth,retentionDays=90,standardTests=0,testLocations=5,testFrequencyMinutes=5,multiStepTests=0,hours=HOURS}){
 const lines=[];
 const la=dedupe(await query(`serviceName eq 'Log Analytics' and armRegionName eq '${region}'`,currency));
 const ai=dedupe(await query(`serviceName eq 'Application Insights' and armRegionName eq '${region}'`,currency));
 const mon=dedupe(await query(`serviceName eq 'Azure Monitor' and armRegionName eq '${region}'`,currency));
 const ing=pick(la,r=>r.skuName==='Analytics Logs'&&r.meterName==='Analytics Logs Data Ingestion'&&r.retailPrice>0,'workspace Analytics Logs ingestion');
 lines.push(line(`${currency} workspace ingestion after 5 GB grant`,Math.max(0,ingestGbPerMonth-(ing.tierMinimumUnits||5))*ing.retailPrice,{meterId:ing.meterId}));
 if(retentionDays>90){const rr=pick(la,r=>r.skuName==='Analytics Logs'&&r.meterName==='Analytics Logs Data Retention','workspace retention'); lines.push(line(`${currency} retention beyond 90 days`,ingestGbPerMonth*((retentionDays-90)/(HOURS/24))*rr.retailPrice,{meterId:rr.meterId}));}
 if(standardTests){const st=pick(mon,r=>r.skuName==='Standard Web Test','standard web test'); lines.push(line(`${currency} standard tests`,standardTests*testLocations*(hours*60/testFrequencyMinutes)*st.retailPrice,{meterId:st.meterId}));}
 if(multiStepTests){const mt=pick(ai,r=>r.skuName==='Basic'&&/Multi-step/.test(r.meterName),'multi-step'); lines.push(line(`${currency} multi-step prorated daily`,multiStepTests*(hours/HOURS)*mt.retailPrice,{meterId:mt.meterId}));}
 return {monthlyList:total(lines),lines};
}
function c(name,cfg){return{name,region:cfg.region||'eastus2',currency:cfg.currency||'USD',component:{type:'app-insights',...cfg},
 // Retail API workspace-based Log Analytics ingestion uses Analytics Logs with first 5 GB free; current Analytics Logs retention is GB-month; multi-step tests are prorated by hours/730.
 expected:()=>app({region:cfg.region||'eastus2',currency:cfg.currency||'USD',...cfg})};}
module.exports={type:'app-insights',source:'retail-api',cases:[
 c('below 5 GB free grant',{ingestGbPerMonth:4}), c('above 5 GB grant with retention',{ingestGbPerMonth:20,retentionDays:120}), c('standard tests',{ingestGbPerMonth:5,standardTests:2,testLocations:5,testFrequencyMinutes:5}), c('multi-step partial month',{ingestGbPerMonth:5,multiStepTests:3,hours:365}), c('west europe tests',{region:'westeurope',ingestGbPerMonth:50,standardTests:1,testLocations:3,testFrequencyMinutes:10}), c('EUR west europe',{region:'westeurope',currency:'EUR',ingestGbPerMonth:10,retentionDays:180,standardTests:1,multiStepTests:1})
]};
