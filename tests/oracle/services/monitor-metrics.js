'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS=730;
function line(desc,monthlyList,extra={}){return{desc,monthlyList:round2(monthlyList),...extra};} function total(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
function charge(qty,row){return qty/unitSize(row.unitOfMeasure)*row.retailPrice;}
function tiered(qty, rows, pred, what){ const paid=rows.filter(pred).sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits).pop(); if(!paid) throw new Error('missing '+what); const free=(paid.tierMinimumUnits||0)*unitSize(paid.unitOfMeasure); return {row:paid,cost:Math.max(0,qty-free)/unitSize(paid.unitOfMeasure)*paid.retailPrice}; }
async function metrics({region,currency='USD',aksNodes=0,metricsPerNode=10000,scrapeIntervalSeconds=30,ingestedSamplesMillions=0,querySamplesMillions=0,advancedPlatformSamplesMillions=0,platformMetricApiCalls=0,metricsExportSamplesMillions=0,platformLogsGb=0}){
 const rows=dedupe(await query(`serviceName eq 'Azure Monitor' and armRegionName eq '${region}'`,currency)); const lines=[];
 const samplesM=ingestedSamplesMillions || (aksNodes ? aksNodes*metricsPerNode*(HOURS*3600/scrapeIntervalSeconds)/1e6 : 0);
 const pick=(pred,what)=>{const r=rows.find(pred); if(!r)throw new Error('missing '+what); return r;};
 if(samplesM){const ing=rows.find(x=>x.meterName==='Metric Samples Ingested Metric samples'); const proc=rows.find(x=>x.meterName==='Metric Samples Processed Metric samples'); if(ing&&proc){ lines.push(line(`metric samples ingested ${samplesM}M`,charge(samplesM*1e6,ing),{meterId:ing.meterId})); lines.push(line(`metric samples processed ${samplesM}M`,charge(samplesM*1e6,proc),{meterId:proc.meterId})); } else { const r=pick(x=>x.meterName==='Metrics ingestion Metric samples','metrics ingestion'); lines.push(line(`metrics ingestion ${samplesM}M samples`,charge(samplesM*1e6,r),{meterId:r.meterId})); } }
 if(querySamplesMillions){const r=pick(x=>x.meterName==='Prometheus Metrics Queries Metric samples','query samples'); lines.push(line(`Prometheus query ${querySamplesMillions}M samples`,charge(querySamplesMillions*1e6,r),{meterId:r.meterId}));}
 if(advancedPlatformSamplesMillions){const r=pick(x=>x.meterName==='Advanced Platform Metric Samples Ingested Metric samples','advanced platform'); lines.push(line(`advanced platform ${advancedPlatformSamplesMillions}M samples`,charge(advancedPlatformSamplesMillions*1e6,r),{meterId:r.meterId}));}
 if(platformMetricApiCalls){const r=tiered(platformMetricApiCalls,rows,x=>x.meterName==='Native Metric Queries API Calls','platform metric API calls'); lines.push(line(`native metric query API calls after first 1M`,r.cost,{meterId:r.row.meterId}));}
 if(metricsExportSamplesMillions){const r=pick(x=>x.meterName==='Metrics Export Metric Samples Exported','metrics export'); lines.push(line(`metrics export ${metricsExportSamplesMillions}M samples`,charge(metricsExportSamplesMillions*1e6,r),{meterId:r.meterId}));}
 if(platformLogsGb){const r=pick(x=>x.meterName==='Platform Logs Data Processed','platform logs'); lines.push(line(`platform logs ${platformLogsGb} GB`,platformLogsGb*r.retailPrice,{meterId:r.meterId}));}
 return {monthlyList:total(lines),lines};
}
function c(name,cfg){return{name,region:cfg.region||'eastus2',currency:cfg.currency||'USD',component:{type:'monitor-metrics',...cfg},
 // Retail API metrics meters use 10M-sample units for ingestion/query/advanced samples, 1K for export samples, and Native Metric Queries API Calls have a 1M calls free grant.
 expected:()=>metrics({region:cfg.region||'eastus2',currency:cfg.currency||'USD',...cfg})};}
module.exports={type:'monitor-metrics',source:'retail-api',cases:[
 c('AKS scrape derived ingestion',{aksNodes:3,metricsPerNode:10000,scrapeIntervalSeconds:30}), c('explicit ingestion and query',{ingestedSamplesMillions:100,querySamplesMillions:50}), c('advanced and export',{advancedPlatformSamplesMillions:20,metricsExportSamplesMillions:2}), c('API calls below 1M free',{platformMetricApiCalls:900000}), c('API calls above free and platform logs',{platformMetricApiCalls:1500000,platformLogsGb:20}), c('west europe EUR metrics',{region:'westeurope',currency:'EUR',ingestedSamplesMillions:10,platformMetricApiCalls:1200000,metricsExportSamplesMillions:1})
]};
