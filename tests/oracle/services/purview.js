'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS=730;
const DAYS=HOURS/24;
function line(desc, monthlyList, extra={}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines){return round2(lines.reduce((s,l)=>s+l.monthlyList,0));}
function pick(rows,pred,what){const hits=rows.filter(pred); if(!hits.length) throw new Error(`no Purview meter for ${what}`); if(hits.length>1) hits.sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits || String(a.meterId).localeCompare(String(b.meterId))); return hits[0];}
function tiered(rows, rawQty){const rs=rows.slice().sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits); const qty=rawQty/unitSize(rs[0].unitOfMeasure); let cost=0,bands=[]; for(let i=0;i<rs.length;i++){const st=rs[i].tierMinimumUnits,en=i+1<rs.length?rs[i+1].tierMinimumUnits:Infinity; if(qty<=st)break; const units=Math.min(qty,en)-st,c=units*rs[i].retailPrice; cost+=c; bands.push({fromUnits:st,toUnits:en===Infinity?null:en,units,unitPrice:rs[i].retailPrice,cost:round2(c)});} return {cost,bands,unitOfMeasure:rs[0].unitOfMeasure,meterId:rs[0].meterId};}
async function purviewRows(region,currency){
  const regional=await query(`contains(productName,'Purview') and armRegionName eq '${region}'`,currency||'USD');
  const policyRegion=String(region).startsWith('usgov')?'US Gov':'Global';
  const policy=await query(`productName eq 'Azure Purview Data Policy' and armRegionName eq '${policyRegion}'`,currency||'USD');
  return dedupe([...regional,...policy]);
}
function add(lines, rows, desc, pred, qty, note){ if(!qty)return; const r=pick(rows,pred,desc); lines.push(line(`${desc}: ${qty} ${note||r.unitOfMeasure} * ${r.retailPrice}`, (qty/unitSize(r.unitOfMeasure))*r.retailPrice,{meterId:r.meterId,unitOfMeasure:r.unitOfMeasure})); }
function addTier(lines, rows, desc, pred, qty){ if(!qty)return; const rs=rows.filter(pred); if(!rs.length) throw new Error(`no Purview tier for ${desc}`); const t=tiered(rs,qty); lines.push(line(`${desc}: ${qty} / ${t.unitOfMeasure} through graduated bands`,t.cost,{meterId:t.meterId,bands:t.bands})); }
async function purview(o){const rows=await purviewRows(o.region,o.currency); const hours=o.hours??HOURS, days=o.days??DAYS; const lines=[]; const model=o.model||'unified';
 if(model==='classic'){
  add(lines,rows,'Classic Data Map capacity units',x=>x.productName==='Azure Purview Data Map'&&x.skuName==='Standard'&&x.meterName==='Standard Capacity Unit',(o.dataMapCapacityUnits||0)*hours,'capacity-unit hours');
  add(lines,rows,'Classic DevOps policies',x=>x.productName==='Azure Purview Data Policy'&&x.skuName==='DevOps'&&x.meterName==='Policy',(o.devopsPolicies||0)*hours,'policy-hours');
  add(lines,rows,'Classic scanning ingestion classification vCore',x=>x.productName==='Azure Purview Scanning Ingestion and Classification'&&x.skuName==='Standard'&&x.meterName==='Standard vCore',o.scanVcoreHours||0,'vCore hours');
  add(lines,rows,'Classic resource set vCore',x=>x.productName==='Azure Purview Data Map'&&x.skuName==='Resource Set'&&x.meterName==='Resource Set vCore',o.resourceSetVcoreHours||0,'vCore hours');
  add(lines,rows,'Classic insights generation vCore',x=>x.productName==='Azure Purview Data Map'&&x.skuName==='Data Map Enrichment - Insight Generation',o.insightsGenerationVcoreHours||0,'vCore hours');
  add(lines,rows,'Classic insights report API calls',x=>x.productName==='Azure Purview Data Map'&&x.skuName==='Catalog Insights',o.insightsReportCalls||0,'API calls');
  return {monthlyList:totalOf(lines),lines};
 }
 add(lines,rows,'Advanced resource set vCore',x=>x.productName==='Microsoft Purview Data Map'&&x.skuName==='Advanced Resource Set',o.advancedResourceSetVcoreHours||0,'vCore hours');
 add(lines,rows,'Unified Catalog governed assets per day',x=>x.productName==='Microsoft Purview Data Governance'&&x.skuName==='Data Catalog Standard',(o.catalogAssets||0)*days,'asset-days');
 add(lines,rows,'DGPU Basic',x=>x.skuName==='Data Management Basic',o.dgpuBasic||0,'DGPUs');
 add(lines,rows,'DGPU Standard',x=>x.skuName==='Data Management Standard',o.dgpuStandard||0,'DGPUs');
 add(lines,rows,'DGPU Advanced',x=>x.skuName==='Data Management Advanced',o.dgpuAdvanced||0,'DGPUs');
 add(lines,rows,'On-demand classification assets',x=>x.productName==='Microsoft Purview On-Demand Classification',o.classificationAssets||0,'assets');
 add(lines,rows,'Data security assets per day',x=>x.productName==='Microsoft Purview Data Security'&&x.meterName==='Standard Asset',(o.securityAssets||0)*days,'asset-days');
 add(lines,rows,'Data security processing units',x=>x.meterName==='Standard Data Security Processing Unit',o.dataSecurityProcessingUnits||0,'processing units');
 add(lines,rows,'In-transit protection requests',x=>x.skuName==='In Transit Protection',o.inTransitProtectionRequests||0,'requests');
 addTier(lines,rows,'OCR transactions',x=>x.skuName==='Optical Character Recognition',o.ocrTransactions||0);
 add(lines,rows,'Investigations compute unit hours',x=>x.skuName==='Investigations'&&x.meterName==='Investigations Compute Unit',o.investigationComputeHours||0,'compute-unit hours');
 add(lines,rows,'Investigations GB per day',x=>x.skuName==='Investigations'&&x.meterName==='Investigations GB',(o.investigationGb||0)*days,'GB-days');
 add(lines,rows,'Audit records',x=>x.skuName==='Audit Standard',(o.auditRecords||0),'records');
 add(lines,rows,'Communication Compliance Standard records',x=>x.skuName==='Communication Compliance Standard',o.communicationComplianceStandardRecords||0,'records');
 add(lines,rows,'Communication Compliance Premium records',x=>x.skuName==='Communication Compliance Premium',o.communicationCompliancePremiumRecords||0,'records');
 add(lines,rows,'eDiscovery Premium GB per day',x=>x.skuName==='eDiscovery Premium',(o.ediscoveryPremiumGb||0)*days,'GB-days');
 addTier(lines,rows,'eDiscovery Graph export GB',x=>x.skuName==='eDiscovery Graph API Standard',o.ediscoveryGraphExportGb||0);
 add(lines,rows,'Retention GB per day',x=>x.skuName==='Retention',(o.retentionGb||0)*days,'GB-days');
 add(lines,rows,'Data Lifecycle Premium messages per day',x=>x.skuName==='Data Lifecycle Management Premium',(o.lifecycleManagementPremiumMessages||0)*days,'message-days');
 return {monthlyList:totalOf(lines),lines};}
module.exports={type:'purview',source:'retail-api',cases:[
 {name:'classic data map scan and global devops policies',region:'eastus2',currency:'USD',component:{type:'purview',model:'classic',dataMapCapacityUnits:1,devopsPolicies:5,hours:730,scanVcoreHours:10}, // Classic bills Data Map capacity and DevOps policies hourly; commercial DevOps policy meter is Global.
  expected:()=>purview({region:'eastus2',model:'classic',dataMapCapacityUnits:1,devopsPolicies:5,hours:730,scanVcoreHours:10})},
 {name:'classic gov devops and enrichment',region:'usgovvirginia',currency:'USD',component:{type:'purview',model:'classic',dataMapCapacityUnits:1,devopsPolicies:2,hours:100,resourceSetVcoreHours:3,insightsGenerationVcoreHours:4,insightsReportCalls:10}, // US Gov regions use the US Gov DevOps policy meter plus sovereign classic Data Map rates.
  expected:()=>purview({region:'usgovvirginia',model:'classic',dataMapCapacityUnits:1,devopsPolicies:2,hours:100,resourceSetVcoreHours:3,insightsGenerationVcoreHours:4,insightsReportCalls:10})},
 {name:'unified governance assets dgpus and advanced resource set',region:'eastus2',currency:'USD',component:{type:'purview',model:'unified',days:10,advancedResourceSetVcoreHours:3,catalogAssets:1000,dgpuBasic:2,dgpuStandard:1,dgpuAdvanced:0.5}, // Unified model bills governed assets per asset-day and DGPUs per processing unit; no classic Data Map charge.
  expected:()=>purview({region:'eastus2',model:'unified',days:10,advancedResourceSetVcoreHours:3,catalogAssets:1000,dgpuBasic:2,dgpuStandard:1,dgpuAdvanced:0.5})},
 {name:'unified security with ocr boundary and days',region:'eastus2',currency:'USD',component:{type:'purview',model:'unified',days:7,classificationAssets:10000,securityAssets:100,inTransitProtectionRequests:1000,ocrTransactions:2501,investigationComputeHours:2,investigationGb:5,dataSecurityProcessingUnits:1}, // OCR has 2,500 free transactions; security assets and investigation GB multiply by explicit days.
  expected:()=>purview({region:'eastus2',model:'unified',days:7,classificationAssets:10000,securityAssets:100,inTransitProtectionRequests:1000,ocrTransactions:2501,investigationComputeHours:2,investigationGb:5,dataSecurityProcessingUnits:1})},
 {name:'unified compliance records and per-day meters',region:'eastus2',currency:'USD',component:{type:'purview',model:'unified',days:5,auditRecords:1000000,communicationComplianceStandardRecords:1000,communicationCompliancePremiumRecords:500,ediscoveryPremiumGb:10,ediscoveryGraphExportGb:51,retentionGb:100,lifecycleManagementPremiumMessages:1000}, // Audit and communication compliance are record meters; eDiscovery/retention/lifecycle storage-style meters multiply by days.
  expected:()=>purview({region:'eastus2',model:'unified',days:5,auditRecords:1000000,communicationComplianceStandardRecords:1000,communicationCompliancePremiumRecords:500,ediscoveryPremiumGb:10,ediscoveryGraphExportGb:51,retentionGb:100,lifecycleManagementPremiumMessages:1000})},
 {name:'eur unified governance and security one day',region:'westeurope',currency:'EUR',component:{type:'purview',model:'unified',days:1,catalogAssets:100,securityAssets:100,ocrTransactions:3000}, // EUR case queries Retail API directly; per-day assets use explicit days and OCR walks the free tier.
  expected:()=>purview({region:'westeurope',currency:'EUR',model:'unified',days:1,catalogAssets:100,securityAssets:100,ocrTransactions:3000})},
]};
