'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function line(desc,monthlyList,extra={}){return{desc,monthlyList:round2(monthlyList),...extra};} function total(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
const C={ 'united-states':'1', germany:'49', france:'33', 'united-kingdom':'44', australia:'61' };
function charge(qty, rows, pred, what, freeOverride){ const paid=rows.filter(pred).sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits).pop(); if(!paid) throw new Error('missing '+what); const free=freeOverride == null ? Math.max(0, paid.tierMinimumUnits||0) : freeOverride; return { row: paid, cost: Math.max(0, qty-free)/unitSize(paid.unitOfMeasure)*paid.retailPrice }; }
async function alerts({region,currency='USD',metricTimeSeries=0,dynamicThresholdTimeSeries=0,logAlertRules=0,logAlertResources=0,logFrequencyMinutes=5,emails=0,pushNotifications=0,webhooks=0,secureWebhooks=0,itsmEvents=0,smsCountry='united-states',smsMessages=0,voiceCountry='united-states',voiceCalls=0}){
 const rows=dedupe(await query(`serviceName eq 'Azure Monitor' and armRegionName eq '${region}'`,currency)); const lines=[];
 if(metricTimeSeries){ const r=charge(metricTimeSeries,rows,x=>x.meterName==='Alerts Metric Monitored','metric alerts'); lines.push(line(`metric alert time series after first 10 free`,r.cost,{meterId:r.row.meterId})); }
 if(dynamicThresholdTimeSeries){ const r=rows.find(x=>x.meterName==='Alerts Dynamic Threshold'&&x.retailPrice>0); lines.push(line(`dynamic threshold time series`,dynamicThresholdTimeSeries*r.retailPrice,{meterId:r.meterId})); }
 if(logAlertRules){ const r=rows.find(x=>x.meterName===`Alerts System Log Monitored at ${logFrequencyMinutes} Minute Frequency`); lines.push(line(`log alert rules ${logFrequencyMinutes} min; first time series included`,logAlertRules*r.retailPrice,{meterId:r.meterId})); }
 if(logAlertResources){ const r=rows.find(x=>x.meterName===`Alerts Resource Monitored at ${logFrequencyMinutes} Minute Frequency`); const billable=Math.max(0,logAlertResources-logAlertRules); lines.push(line(`resource-centric log alert billable resources ${logFrequencyMinutes} min after one free per rule`,billable*r.retailPrice,{meterId:r.meterId})); }
 for(const [qty,meter,desc,free] of [[emails,'Emails','emails after first 1000',1000],[pushNotifications,'Notifications Push Notification','push after first 1000',1000],[webhooks,'Notifications Web hook','webhooks after first 100000',100000],[secureWebhooks,'Notifications Secure web hook','secure webhooks after first 1000',1000],[itsmEvents,'Notifications ITSM Connector Create/Update Event','ITSM after first 1000',1000]]) if(qty){ const r=charge(qty,rows,x=>x.meterName===meter,desc,free); lines.push(line(desc,r.cost,{meterId:r.row.meterId})); }
 if(smsMessages){ const code=C[smsCountry]||smsCountry; const r=charge(smsMessages,rows,x=>x.meterName===`SMS Country Code ${code} Notification`,`SMS ${smsCountry}`); lines.push(line(`SMS ${smsCountry}`,r.cost,{meterId:r.row.meterId})); }
 if(voiceCalls){ const code=C[voiceCountry]||voiceCountry; const meter=voiceCountry==='united-states'?'Voice Calls':`Voice Calls Voice Call Country Code ${code}`; const r=charge(voiceCalls,rows,x=>x.meterName===meter,`voice ${voiceCountry}`); lines.push(line(`voice ${voiceCountry}`,r.cost,{meterId:r.row.meterId})); }
 return {monthlyList:total(lines),lines};
}
function c(name,cfg){return{name,region:cfg.region||'eastus2',currency:cfg.currency||'USD',component:{type:'monitor-alerts',...cfg},
 // Retail API alert meters: metric alerts have first 10 time series free; each log alert rule includes one free time series; notifications use free grants; SMS/voice rates are country-specific.
 expected:()=>alerts({region:cfg.region||'eastus2',currency:cfg.currency||'USD',...cfg})};}
module.exports={type:'monitor-alerts',source:'retail-api',cases:[
 c('metric alerts below free',{metricTimeSeries:9}), c('metric and dynamic thresholds',{metricTimeSeries:25,dynamicThresholdTimeSeries:5}),
 c('log alerts boundary first series free',{logAlertRules:3,logAlertResources:3,logFrequencyMinutes:5}),
 c('log alerts 1 minute with billable resources',{logAlertRules:3,logAlertResources:20,logFrequencyMinutes:1}),
 c('log alerts 5 minute one extra resource',{logAlertRules:2,logAlertResources:3,logFrequencyMinutes:5}),
 c('log alerts 10 minute resources',{logAlertRules:2,logAlertResources:7,logFrequencyMinutes:10}),
 c('notification free grants crossed',{emails:1500,pushNotifications:1200,webhooks:120000,secureWebhooks:1500,itsmEvents:1200}),
 c('US SMS and US voice',{smsCountry:'united-states',smsMessages:150,voiceCountry:'united-states',voiceCalls:15}),
 c('west europe Germany SMS voice EUR',{region:'westeurope',currency:'EUR',smsCountry:'germany',smsMessages:10,voiceCountry:'germany',voiceCalls:15})
]};
