'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const DAYS = 730/24;
function line(desc, monthlyList, extra={}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines){ return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
function pick(rows,pred,what){ const r=rows.find(pred); if(!r) throw new Error('missing '+what); return r; }
async function rows(region,currency){ return dedupe(await query(`armRegionName eq '${region}' and (serviceName eq 'Azure Monitor' or serviceName eq 'Log Analytics')`, currency)); }
async function logs({region,currency='USD',ingestGBPerDay,retentionDays=31,commitmentTier,basicLogsGBPerDay=0,auxiliaryLogsGBPerDay=0,searchQueryScannedGB=0,searchJobScannedGB=0,restoreGB=0,restoreDays=1,exportGBPerDay=0,archiveGB=0}){
 const rs=await rows(region,currency), lines=[]; const analyticsGB=ingestGBPerDay*DAYS;
 if(commitmentTier){ const cr=pick(rs,r=>r.serviceName==='Azure Monitor'&&r.skuName===`${commitmentTier} GB Commitment Tier`&&/Capacity Reservation/.test(r.meterName),'commitment tier'); lines.push(line(`Commitment tier ${commitmentTier} GB/day for ${DAYS} days`, DAYS*cr.retailPrice/unitSize(cr.unitOfMeasure),{meterId:cr.meterId})); const included=commitmentTier*DAYS; const over=Math.max(0,analyticsGB-included); if(over) lines.push(line(`Ingestion above commitment: ${over} GB at effective tier rate`, over*(cr.retailPrice/commitmentTier),{meterId:cr.meterId})); }
 else { const pr=pick(rs,r=>r.serviceName==='Log Analytics'&&r.skuName==='Analytics Logs'&&r.meterName==='Analytics Logs Data Ingestion'&&r.retailPrice>0,'analytics ingestion'); const bill=Math.max(0,analyticsGB-5); lines.push(line(`Analytics Logs ingestion above 5 GB/day free: ${bill} GB`, bill*pr.retailPrice/unitSize(pr.unitOfMeasure),{meterId:pr.meterId})); }
 const add=(qty,sku,meter,desc,mult=1)=>{ if(qty){ const r=pick(rs,x=>x.serviceName==='Azure Monitor'&&x.skuName===sku&&x.meterName===meter,desc); lines.push(line(`${desc}: ${qty}`, qty*mult*r.retailPrice/unitSize(r.unitOfMeasure),{meterId:r.meterId})); }};
 add(basicLogsGBPerDay*DAYS,'Basic Logs','Basic Logs Data Ingestion','Basic Logs ingestion');
 add(auxiliaryLogsGBPerDay*DAYS,'Auxiliary Logs','Auxiliary Logs Data Ingestion','Auxiliary Logs ingestion');
 add(auxiliaryLogsGBPerDay*DAYS,'Logs Processed','Logs Processed GB','Auxiliary Logs processing');
 add(searchQueryScannedGB,'Search Queries','Search Queries Scanned','Basic/Auxiliary query scans');
 add(searchJobScannedGB,'Search Jobs','Search Jobs Scanned','Search jobs');
 if(restoreGB){ const r=pick(rs,x=>x.serviceName==='Azure Monitor'&&x.skuName==='Data Restore'&&x.meterName==='Data Restore','Data restore'); const gbDays=Math.max(restoreGB,2048)*Math.max(restoreDays,0.5); lines.push(line(`Data restore with 2 TB / 12 hour minimum: ${gbDays} GB-days`,gbDays*r.retailPrice/unitSize(r.unitOfMeasure),{meterId:r.meterId})); }
 add(exportGBPerDay*DAYS,'Log Analytics data export','Log Analytics data export Data Exported','Data export');
 add(archiveGB,'Data Archive','Data Archive','Archive retention');
 if(retentionDays>31){ const rr=pick(rs,r=>r.serviceName==='Log Analytics'&&r.skuName==='Analytics Logs'&&r.meterName==='Analytics Logs Data Retention','analytics retention'); const ar=pick(rs,r=>r.serviceName==='Azure Monitor'&&r.skuName==='Data Archive'&&r.meterName==='Data Archive','archive retention'); const interactiveDays=Math.max(0,Math.min(retentionDays,730)-31); const archiveDays=Math.max(0,retentionDays-730); if(interactiveDays) lines.push(line(`Retention days 32-${Math.min(retentionDays,730)} at Analytics retention rate`, ingestGBPerDay*interactiveDays*rr.retailPrice,{meterId:rr.meterId})); if(archiveDays) lines.push(line(`Retention beyond 730 days at archive rate`, ingestGBPerDay*archiveDays*ar.retailPrice,{meterId:ar.meterId})); }
 return {monthlyList:total(lines),lines};
}
module.exports={type:'log-analytics',source:'retail-api',cases:[
 {name:'analytics payg retention included',region:'eastus2',currency:'USD',component:{type:'log-analytics',ingestGBPerDay:10,retentionDays:31}, // Pay-as-you-go analytics logs use Log Analytics Analytics Logs Data Analyzed GB meter.
  expected:()=>logs({region:'eastus2',ingestGBPerDay:10,retentionDays:31})},
 {name:'100gb commitment with overage',region:'eastus2',currency:'USD',component:{type:'log-analytics',ingestGBPerDay:150,commitmentTier:100}, // Commitment tier meter is daily; overage uses the tier daily price divided by committed GB/day.
  expected:()=>logs({region:'eastus2',ingestGBPerDay:150,commitmentTier:100})},
 {name:'basic auxiliary and searches',region:'eastus2',currency:'USD',component:{type:'log-analytics',ingestGBPerDay:20,basicLogsGBPerDay:5,auxiliaryLogsGBPerDay:3,searchQueryScannedGB:100,searchJobScannedGB:50}, // Basic/Auxiliary logs use their ingestion meters; query and search job meters bill scanned GB.
  expected:()=>logs({region:'eastus2',ingestGBPerDay:20,basicLogsGBPerDay:5,auxiliaryLogsGBPerDay:3,searchQueryScannedGB:100,searchJobScannedGB:50})},
 {name:'restore export archive',region:'eastus2',currency:'USD',component:{type:'log-analytics',ingestGBPerDay:5,restoreGB:20,restoreDays:3,exportGBPerDay:2,archiveGB:500}, // Restore is GB-day, export is daily GB, archive is GB-month.
  expected:()=>logs({region:'eastus2',ingestGBPerDay:5,restoreGB:20,restoreDays:3,exportGBPerDay:2,archiveGB:500})},
 {name:'west europe 200gb commitment',region:'westeurope',currency:'USD',component:{type:'log-analytics',ingestGBPerDay:220,commitmentTier:200,basicLogsGBPerDay:10}, // Non-US region uses the West Europe commitment tier and Basic Logs meters.
  expected:()=>logs({region:'westeurope',ingestGBPerDay:220,commitmentTier:200,basicLogsGBPerDay:10})},
 {name:'eur basic auxiliary archive',region:'westeurope',currency:'EUR',component:{type:'log-analytics',ingestGBPerDay:12,basicLogsGBPerDay:4,auxiliaryLogsGBPerDay:2,archiveGB:100}, // EUR uses native Retail API currency for Azure Monitor and Log Analytics meters.
  expected:()=>logs({region:'westeurope',currency:'EUR',ingestGBPerDay:12,basicLogsGBPerDay:4,auxiliaryLogsGBPerDay:2,archiveGB:100})},
 {name:'restore minimum 100gb 12h bills 1024gb-day',region:'eastus2',currency:'USD',component:{type:'log-analytics',ingestGBPerDay:0,restoreGB:100,restoreDays:0.5}, // Data Restore has a 2 TB minimum and bills at least 12 hours; 100 GB for 12h charges 2048 GB-days * $0.10 = $102.40.
  expected:()=>logs({region:'eastus2',ingestGBPerDay:0,restoreGB:100,restoreDays:0.5})},
 {name:'retention beyond 730 days uses archive rate',region:'eastus2',currency:'USD',component:{type:'log-analytics',ingestGBPerDay:10,retentionDays:800}, // Retention days 32-730 use Analytics retention; days over 730 use the cheaper Data Archive GB-month rate, not the Analytics rate.
  expected:()=>logs({region:'eastus2',ingestGBPerDay:10,retentionDays:800})},
 {name:'auxiliary logs include processing meter',region:'eastus2',currency:'USD',component:{type:'log-analytics',ingestGBPerDay:0,auxiliaryLogsGBPerDay:10}, // Auxiliary Logs bill both ingestion and Logs Processed GB for the monthly auxiliary volume.
  expected:()=>logs({region:'eastus2',ingestGBPerDay:0,auxiliaryLogsGBPerDay:10})},
]};
