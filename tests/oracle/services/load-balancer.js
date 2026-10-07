'use strict';
const H = require('./_helpers');

async function price(c, region, currency='USD') {
  const tier=c.tier||'regional', rules=c.rules==null?5:c.rules, processedGB=c.processedGB||0, hours=c.hours==null?H.HOURS:c.hours;
  const meterRegion=H.armRegion(region).startsWith('usgov')?'US Gov':'Global';
  const sku=tier==='global'?'Global':'Standard';
  const filter=`serviceName eq 'Load Balancer' and armRegionName eq '${meterRegion}'`;
  const lines=[];
  if (rules > 0) {
    lines.push(await H.retailLine(filter,currency,r=>r.type==='Consumption'&&r.skuName===sku&&r.meterName===`${sku} Included LB Rules and Outbound Rules`,hours,`${sku} included rules @ ${hours}h`));
    const extra=Math.max(0,rules-5);
    if (extra) lines.push(await H.retailLine(filter,currency,r=>r.type==='Consumption'&&r.skuName===sku&&r.meterName===`${sku} Overage LB Rules and Outbound Rules`,extra*hours,`${sku} overage rules ${extra} @ ${hours}h`));
  }
  if (processedGB) lines.push(await H.retailLine(filter,currency,r=>r.type==='Consumption'&&r.skuName===sku&&r.meterName===`${sku} Data Processed`,processedGB,`${sku} data processed ${processedGB} GB`));
  return H.result(lines);
}

module.exports={type:'load-balancer',source:'retail-api',cases:[
  {name:'eastus2 5 rules plus data',region:'eastus2',currency:'USD',component:{type:'load-balancer',rules:5,processedGB:1000},expected:()=>price({rules:5,processedGB:1000},'eastus2','USD')},
  {name:'eastus2 8 rules bills overage',region:'eastus2',currency:'USD',component:{type:'load-balancer',rules:8,processedGB:0},expected:()=>price({rules:8},'eastus2','USD')},
  {name:'eastus2 zero rules data only',region:'eastus2',currency:'USD',component:{type:'load-balancer',rules:0,processedGB:1000},expected:()=>price({rules:0,processedGB:1000},'eastus2','USD')},
  {name:'us gov 8 rules plus data',region:'usgovvirginia',currency:'USD',component:{type:'load-balancer',rules:8,processedGB:1000},expected:()=>price({rules:8,processedGB:1000},'usgovvirginia','USD')},
  {name:'global tier 6 rules data free',region:'eastus2',currency:'USD',component:{type:'load-balancer',tier:'global',rules:6,processedGB:1000},expected:()=>price({tier:'global',rules:6,processedGB:1000},'eastus2','USD')},
  {name:'westeurope EUR standard',region:'westeurope',currency:'EUR',component:{type:'load-balancer',rules:5,processedGB:1000},expected:()=>price({rules:5,processedGB:1000},'westeurope','EUR')},
  {name:'eastus2 part month',region:'eastus2',currency:'USD',component:{type:'load-balancer',rules:8,processedGB:100,hours:100},expected:()=>price({rules:8,processedGB:100,hours:100},'eastus2','USD')},
]};
