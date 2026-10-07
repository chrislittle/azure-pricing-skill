'use strict';
const H = require('./_helpers');
function vcpu(sku){ const m=String(sku).match(/Standard_[A-Z]+(\d+)(?:-(\d+))?/i); return m?parseInt(m[2] || m[1],10):null; }
async function vmLine(sku, os, count, hours, region, currency){ const windows=os==='windows'; return H.retailLine(`serviceName eq 'Virtual Machines' and armRegionName eq '${H.armRegion(region)}' and armSkuName eq '${H.q(sku)}'`, currency, r=>r.type==='Consumption' && /^Virtual Machines |^[A-Z].*Series Linux|^[A-Z].*series Linux/i.test(r.productName) && !/Spot|Low Priority/i.test(r.skuName+' '+r.meterName) && (windows?/Windows/i.test(r.productName):!/Windows/i.test(r.productName)), hours*count, `${sku} ${os||'linux'} compute x${count}`); }
function sqlProduct(edition, os){ const base={web:'SQL Server Web',standard:'SQL Server Standard',enterprise:'SQL Server Enterprise'}[edition]; return os==='sles' ? `${base} SLES` : base; }
async function sqlLine(edition, v, os, count, hours, currency){
 const name=sqlProduct(edition, os);
 return H.retailLine(`serviceName eq 'Virtual Machines Licenses'`, currency, r=>r.type==='Consumption'&&r.productName===name&&(r.meterName===`${v} vCPU VM License` || (v<=4 && r.meterName==='1-4 vCPU VM License') || (v<=4 && r.meterName==='3-4 vCPU VM License')), hours*count, `${name} ${v} active vCPU license x${count}`);
}
async function price(c, region, currency){ const sku=c.sku, os=c.os||'linux', count=c.count||1, hours=c.hours||H.HOURS, lines=[]; lines.push(await vmLine(sku,os,count,hours,region,currency)); if(c.sqlLicense){ lines.push(await sqlLine(c.sqlLicense, vcpu(sku), os, count, hours, currency)); } return H.result(lines); }
module.exports = { type:'vm', source:'retail-api', cases:[
 {name:'L-series L8s_v3 prices',region:'eastus2',currency:'USD',component:{type:'vm',sku:'Standard_L8s_v3'},expected:()=>price({sku:'Standard_L8s_v3'},'eastus2','USD')},
 {name:'DC confidential compute DC2as_v5',region:'eastus2',currency:'USD',component:{type:'vm',sku:'Standard_DC2as_v5'},expected:()=>price({sku:'Standard_DC2as_v5'},'eastus2','USD')},
 {name:'EC confidential memory EC2as_v5',region:'eastus2',currency:'USD',component:{type:'vm',sku:'Standard_EC2as_v5'},expected:()=>price({sku:'Standard_EC2as_v5'},'eastus2','USD')},
 {name:'NC A100 GPU in Central US',region:'centralus',currency:'USD',component:{type:'vm',sku:'Standard_NC24ads_A100_v4'},expected:()=>price({sku:'Standard_NC24ads_A100_v4'},'centralus','USD')},
 {name:'SQL Server Web license on 8 vCPU VM',region:'eastus2',currency:'USD',component:{type:'vm',sku:'Standard_D8as_v5',sqlLicense:'web'},expected:()=>price({sku:'Standard_D8as_v5',sqlLicense:'web'},'eastus2','USD')},
 {name:'SQL Server Standard license on 8 vCPU VM',region:'eastus2',currency:'USD',component:{type:'vm',sku:'Standard_D8as_v5',sqlLicense:'standard'},expected:()=>price({sku:'Standard_D8as_v5',sqlLicense:'standard'},'eastus2','USD')},
 {name:'SQL Server Enterprise license on 8 vCPU VM non-US EUR',region:'germanywestcentral',currency:'EUR',component:{type:'vm',sku:'Standard_D8as_v5',sqlLicense:'enterprise'},expected:()=>price({sku:'Standard_D8as_v5',sqlLicense:'enterprise'},'germanywestcentral','EUR')}
 ,{name:'SQL Server Standard constrained-core active 4 vCPU',region:'eastus2',currency:'USD',component:{type:'vm',sku:'Standard_E8-4ds_v5',sqlLicense:'standard'},expected:()=>price({sku:'Standard_E8-4ds_v5',sqlLicense:'standard'},'eastus2','USD')}
 ,{name:'SLES SQL Server Standard uses SLES SQL meter',region:'eastus2',currency:'USD',component:{type:'vm',sku:'Standard_D8as_v5',os:'sles',sqlLicense:'standard'},expected:()=>price({sku:'Standard_D8as_v5',os:'sles',sqlLicense:'standard'},'eastus2','USD')}
]};
