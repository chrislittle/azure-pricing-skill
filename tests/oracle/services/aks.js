'use strict';
const H = require('./_helpers');

async function price(c, region, currency='USD') {
  const tier=c.tier||'free', count=c.count||1, hours=c.hours==null?H.HOURS:c.hours;
  if (tier === 'free') return H.result([H.line(`AKS free tier x${count}`,0,{source:'Azure Kubernetes Service free tier control plane',quantity:count})]);
  const filter=`serviceName eq 'Azure Kubernetes Service' and armRegionName eq '${H.armRegion(region)}'`;
  const meter=tier==='premium'?'Standard Long Term Support':'Standard Uptime SLA';
  return H.result([await H.retailLine(filter,currency,r=>r.type==='Consumption'&&r.productName==='Azure Kubernetes Service'&&r.skuName==='Standard'&&r.meterName===meter,hours*count,`AKS ${tier} x${count} @ ${hours}h`)]);
}

module.exports={type:'aks',source:'retail-api',cases:[
  {name:'free cluster',region:'eastus2',currency:'USD',component:{type:'aks',tier:'free'},expected:()=>price({tier:'free'},'eastus2','USD')},
  {name:'standard cluster',region:'eastus2',currency:'USD',component:{type:'aks',tier:'standard'},expected:()=>price({tier:'standard'},'eastus2','USD')},
  {name:'premium cluster',region:'eastus2',currency:'USD',component:{type:'aks',tier:'premium'},expected:()=>price({tier:'premium'},'eastus2','USD')},
  {name:'standard two clusters',region:'eastus2',currency:'USD',component:{type:'aks',tier:'standard',count:2},expected:()=>price({tier:'standard',count:2},'eastus2','USD')},
  {name:'standard part month',region:'eastus2',currency:'USD',component:{type:'aks',tier:'standard',hours:100},expected:()=>price({tier:'standard',hours:100},'eastus2','USD')},
  {name:'us gov standard',region:'usgovvirginia',currency:'USD',component:{type:'aks',tier:'standard'},expected:()=>price({tier:'standard'},'usgovvirginia','USD')},
  {name:'westeurope EUR standard',region:'westeurope',currency:'EUR',component:{type:'aks',tier:'standard'},expected:()=>price({tier:'standard'},'westeurope','EUR')},
]};
