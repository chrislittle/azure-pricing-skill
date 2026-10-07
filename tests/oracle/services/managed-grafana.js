'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS = 730;
function line(desc, monthlyList, extra={}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines){ return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
function pick(rows,pred,what){ const hits=rows.filter(pred); if(!hits.length) throw new Error(`no Grafana meter for ${what}`); return hits.sort((a,b)=>a.retailPrice-b.retailPrice)[0]; }
async function grafana(opts){
  const rows=dedupe(await query(`serviceName eq 'Azure Grafana Service' and productName eq 'Azure Managed Grafana' and armRegionName eq '${opts.region}'`, opts.currency||'USD'));
  const hours=opts.hours??HOURS; const lines=[]; const tier=opts.tier||'standard';
  if(tier==='standard'){
    const nodeCount=(opts.size||'x1')==='x2'?4:2; // X1 = 2 Standard Units; X2 = 4.
    const node=pick(rows,r=>r.skuName==='Standard'&&r.meterName==='Standard Node','Standard Node');
    const nodeUnits=(opts.instances||1)*nodeCount;
    lines.push(line(`Standard compute units: ${opts.instances||1} workspace(s) * ${nodeCount} units * ${hours} h * ${node.retailPrice}`, (nodeUnits*hours/unitSize(node.unitOfMeasure))*node.retailPrice,{meterId:node.meterId}));
    if(opts.zoneRedundancy){
      const zr=pick(rows,r=>r.skuName==='Standard'&&/Zone Redundancy/.test(r.meterName),'Zone Redundancy');
      const zrUnits=(opts.instances||1)*(nodeCount/2); // Calculator adds +1 ZR unit for X1, +2 for X2.
      lines.push(line(`Standard zone-redundancy units: ${opts.instances||1} workspace(s) * ${nodeCount/2} ZR units * ${hours} h * ${zr.retailPrice}`, (zrUnits*hours/unitSize(zr.unitOfMeasure))*zr.retailPrice,{meterId:zr.meterId}));
    }
  }
  const user=pick(rows,r=>r.skuName===(tier==='essential'?'Essential':'Standard')&&/User$/.test(r.meterName),`${tier} users`);
  lines.push(line(`${tier} active users: ${opts.users} * ${user.retailPrice} per month`, opts.users*user.retailPrice,{meterId:user.meterId}));
  return {monthlyList:totalOf(lines),lines};
}
module.exports={ type:'managed-grafana', source:'retail-api', cases:[
 {name:'standard x1 one user full month',region:'eastus2',currency:'USD',component:{type:'managed-grafana',tier:'standard',users:1,instances:1,hours:730,zoneRedundancy:false}, // Pricing page/calculator: Standard X1 is 2 Standard Units, plus monthly active users.
  expected:()=>grafana({region:'eastus2',tier:'standard',users:1,instances:1,hours:730,size:'x1'})},
 {name:'standard x1 zone redundancy one-hour boundary',region:'eastus2',currency:'USD',component:{type:'managed-grafana',tier:'standard',users:0,instances:1,hours:1,zoneRedundancy:true}, // Boundary case: one X1 workspace-hour = 2 compute unit-hours + 1 zone-redundancy unit-hour.
  expected:()=>grafana({region:'eastus2',tier:'standard',users:0,instances:1,hours:1,zoneRedundancy:true,size:'x1'})},
 {name:'standard x2 zone redundant part-time',region:'eastus2',currency:'USD',component:{type:'managed-grafana',tier:'standard',users:5,instances:1,size:'x2',hours:100,zoneRedundancy:true}, // Calculator X2 = 4 Standard Units and adds +2 zone-redundancy units.
  expected:()=>grafana({region:'eastus2',tier:'standard',users:5,instances:1,size:'x2',hours:100,zoneRedundancy:true})},
 {name:'essential existing workspace users only',region:'eastus2',currency:'USD',component:{type:'managed-grafana',tier:'essential',users:3,instances:1,hours:730}, // Essential is legacy; Retail API exposes only the monthly active-user meter.
  expected:()=>grafana({region:'eastus2',tier:'essential',users:3,instances:1,hours:730})},
 {name:'west europe x1 regional node',region:'westeurope',currency:'USD',component:{type:'managed-grafana',tier:'standard',users:2,instances:1,hours:730,zoneRedundancy:true}, // West Europe has different hourly Standard node/zone redundancy rates; X1 still has 2 compute units.
  expected:()=>grafana({region:'westeurope',tier:'standard',users:2,instances:1,hours:730,zoneRedundancy:true,size:'x1'})},
 {name:'eur standard x1 users and node',region:'westeurope',currency:'EUR',component:{type:'managed-grafana',tier:'standard',users:4,instances:1,hours:24}, // EUR case queries Retail API; X1 node compute is 2 Standard Units.
  expected:()=>grafana({region:'westeurope',currency:'EUR',tier:'standard',users:4,instances:1,hours:24,size:'x1'})},
]};
