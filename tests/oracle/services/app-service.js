'use strict';
const H = require('./_helpers');
function tier(plan){ const p=String(plan).toLowerCase(); if(p==='f1') return 'free'; if(p==='d1') return 'shared'; if(p.startsWith('b')) return 'basic'; if(p.startsWith('s')) return 'standard'; if(p.includes('v2')) return 'premiumv2'; if(p.includes('v4')) return 'premiumv4'; return 'premiumv3'; }
async function price(c, region, currency){
  const plan=String(c.plan), os=c.os||'linux', count=c.count||1, hours=c.hours||H.HOURS, commitment=c.commitment||'payg';
  const lines=[];
  if(currency==='USD'){
    const suffix = commitment==='ri1y'?'one-year':commitment==='ri3y'?'three-year':commitment==='sp1y'?'sv-one-year':commitment==='sp3y'?'sv-three-year':'payg';
    const key=`${os}-${tier(plan)}-${plan.toLowerCase()}-${suffix}`;
    lines.push(await H.calcHourlyLine('app-service', key, region, hours*count, `${plan} ${os} ${commitment} x${count} @ ${hours}h/mo`));
  } else {
    const map={free:'Free',shared:'Shared',basic:'Basic',standard:'Standard',premiumv2:'Premium v2',premiumv3:'Premium v3',premiumv4:'Premium v4'};
    const row=await H.retailLine(`serviceName eq 'Azure App Service' and armRegionName eq '${H.armRegion(region)}'`, currency,
      r=>r.type==='Consumption' && new RegExp(plan.replace('v',' v'),'i').test(r.skuName+' '+r.meterName) && new RegExp(os,'i').test(r.productName+' '+r.skuName+' '+r.meterName),
      hours*count, `${plan} ${os} PAYG x${count} @ ${hours}h/mo`);
    lines.push(row);
  }
  if(c.ipSslConnections){ const g=await H.calcGraduated('app-service', tier(plan)==='basic'?'ip-standard':'ip-premium', c.ipSslConnections); lines.push(H.line(`IP SSL connections ${c.ipSslConnections} (first included)`, g.cost, { source:'calculator:app-service:ip-standard/ip-premium', bands:g.bands })); }
  return H.result(lines);
}
module.exports = { type:'app-service', source:'both', cases:[
  { name:'F1 Windows free plan', region:'eastus2', currency:'USD', component:{type:'app-service', plan:'F1', os:'windows'}, expected:()=>price({plan:'F1',os:'windows'},'eastus2','USD') },
  { name:'D1 Windows shared plan', region:'eastus2', currency:'USD', component:{type:'app-service', plan:'D1', os:'windows'}, expected:()=>price({plan:'D1',os:'windows'},'eastus2','USD') },
  { name:'Premium v2 Linux P1v2', region:'eastus2', currency:'USD', component:{type:'app-service', plan:'P1v2', os:'linux'}, expected:()=>price({plan:'P1v2',os:'linux'},'eastus2','USD') },
  { name:'Premium v4 Windows P1v4', region:'westeurope', currency:'USD', component:{type:'app-service', plan:'P1v4', os:'windows'}, expected:()=>price({plan:'P1v4',os:'windows'},'westeurope','USD') },
  { name:'Premium mv3 Linux reservation 1y', region:'eastus2', currency:'USD', component:{type:'app-service', plan:'P1mv3', os:'linux', commitment:'ri1y'}, expected:()=>price({plan:'P1mv3',os:'linux',commitment:'ri1y'},'eastus2','USD') },
  { name:'Premium v3 Linux savings plan 3y', region:'eastus2', currency:'USD', component:{type:'app-service', plan:'P1v3', os:'linux', commitment:'sp3y'}, expected:()=>price({plan:'P1v3',os:'linux',commitment:'sp3y'},'eastus2','USD') },
  { name:'IP SSL above included connection', region:'eastus2', currency:'USD', component:{type:'app-service', plan:'S1', os:'windows', ipSslConnections:3}, expected:()=>price({plan:'S1',os:'windows',ipSslConnections:3},'eastus2','USD') },
  { name:'EUR Standard Linux non-US', region:'germanywestcentral', currency:'EUR', component:{type:'app-service', plan:'S1', os:'linux'}, expected:()=>price({plan:'S1',os:'linux'},'germanywestcentral','EUR') }
]};
