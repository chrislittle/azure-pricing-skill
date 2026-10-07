'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS = 730, SECONDS = 3600;
function line(desc, monthlyList, extra={}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
function pick(rows, pred, what) { const hit = rows.filter(pred).sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits||b.retailPrice-a.retailPrice)[0]; if(!hit) throw new Error('missing '+what); return hit; }
function tier(rows, qty, rateOf) { const rs=rows.slice().sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits); let cost=0,bands=[]; for(let i=0;i<rs.length;i++){ const st=rs[i].tierMinimumUnits, en=i+1<rs.length?rs[i+1].tierMinimumUnits:Infinity; if(qty<=st) break; const u=Math.min(qty,en)-st, rate=rateOf?rateOf(rs[i]):rs[i].retailPrice, c=u*rate; cost+=c; bands.push({fromUnits:st,toUnits:en===Infinity?null:en,units:u,unitPrice:rate,cost:round2(c)});} return {cost,bands}; }
function spRate(row, commitment) { if(commitment==='sp1y'||commitment==='sp3y'){ const term=commitment==='sp1y'?'1 Year':'3 Years'; const sp=(row.savingsPlan||[]).find(x=>x.term===term); if(sp) return sp.unitPrice || sp.retailPrice; } return row.retailPrice; }
async function functionsPrice({ region, currency='USD', plan='consumption', executions, gbSeconds, durationMs, memoryMB, instanceMemoryMB=2048, alwaysReadyInstances=0, alwaysReadyExecutions=0, commitment='payg' }) {
  if (gbSeconds == null) gbSeconds = executions * (durationMs || 0) / 1000 * (((plan === 'flex' ? (memoryMB || instanceMemoryMB) : memoryMB) || 0) / 1024);
  const rows=dedupe(await query(`serviceName eq 'Functions' and armRegionName eq '${region}'`, currency));
  const lines=[];
  if(plan==='consumption'){
    const er=rows.filter(r=>r.productName==='Functions'&&r.skuName==='Standard'&&r.meterName==='Standard Total Executions');
    const gr=rows.filter(r=>r.productName==='Functions'&&r.skuName==='Standard'&&r.meterName==='Standard Execution Time');
    const eu=executions/unitSize(er[0].unitOfMeasure), gu=gbSeconds/unitSize(gr[0].unitOfMeasure);
    const ec=tier(er,eu), gc=tier(gr,gu);
    lines.push(line(`Standard executions: ${executions} / ${er[0].unitOfMeasure} through free tier`, ec.cost, {bands:ec.bands}));
    lines.push(line(`Standard execution time: ${gbSeconds} GB-s through free tier`, gc.cost, {bands:gc.bands}));
  } else {
    const odExec=rows.filter(r=>r.productName==='Flex Consumption'&&r.skuName==='On Demand'&&r.meterName==='On Demand Total Executions');
    const odTime=rows.filter(r=>r.productName==='Flex Consumption'&&r.skuName==='On Demand'&&r.meterName==='On Demand Execution Time');
    const arBase=pick(rows,r=>r.productName==='Flex Consumption'&&r.skuName==='Always Ready'&&r.meterName==='Always Ready Baseline','always ready baseline');
    const arExec=pick(rows,r=>r.productName==='Flex Consumption'&&r.skuName==='Always Ready'&&r.meterName==='Always Ready Total Executions','always ready executions');
    const eu=executions/unitSize(odExec[0].unitOfMeasure), gu=gbSeconds/unitSize(odTime[0].unitOfMeasure);
    const ec=tier(odExec, eu, r=>spRate(r,commitment)), gc=tier(odTime, gu, r=>spRate(r,commitment));
    lines.push(line(`Flex on-demand executions: ${executions} / ${odExec[0].unitOfMeasure} through free grant`, ec.cost, {bands:ec.bands}));
    lines.push(line(`Flex on-demand execution time: ${gbSeconds} GB-s through free grant`, gc.cost, {bands:gc.bands}));
    if(alwaysReadyInstances) lines.push(line(`Always-ready baseline: ${alwaysReadyInstances} * ${instanceMemoryMB/1024} GiB * ${HOURS} h * 3600 s`, alwaysReadyInstances*(instanceMemoryMB/1024)*HOURS*SECONDS*spRate(arBase,commitment), {meterId:arBase.meterId}));
    if(alwaysReadyExecutions) lines.push(line(`Always-ready executions: ${alwaysReadyExecutions} / ${arExec.unitOfMeasure}`, alwaysReadyExecutions/unitSize(arExec.unitOfMeasure)*spRate(arExec,commitment), {meterId:arExec.meterId}));
  }
  return { monthlyList: total(lines), lines };
}
module.exports={ type:'functions', source:'retail-api', cases:[
 {name:'consumption just at free grants',region:'eastus2',currency:'USD',component:{type:'functions',plan:'consumption',executions:1000000,gbSeconds:400000}, // Retail Standard meters expose 1M executions and 400k GB-s as zero-price bands.
  expected:()=>functionsPrice({region:'eastus2',plan:'consumption',executions:1000000,gbSeconds:400000})},
 {name:'consumption over free grants',region:'eastus2',currency:'USD',component:{type:'functions',plan:'consumption',executions:5000000,gbSeconds:500000}, // Paid bands charge only execution and GB-s usage above the free tier minimums.
  expected:()=>functionsPrice({region:'eastus2',plan:'consumption',executions:5000000,gbSeconds:500000})},
 {name:'flex 512mb always ready',region:'eastus2',currency:'USD',component:{type:'functions',plan:'flex',executions:2000000,gbSeconds:250000,instanceMemoryMB:512,alwaysReadyInstances:1,alwaysReadyExecutions:500000}, // Flex bills on-demand grants plus always-ready baseline GB-seconds and always-ready executions.
  expected:()=>functionsPrice({region:'eastus2',plan:'flex',executions:2000000,gbSeconds:250000,instanceMemoryMB:512,alwaysReadyInstances:1,alwaysReadyExecutions:500000})},
 {name:'flex 4096mb three year savings west europe',region:'westeurope',currency:'USD',component:{type:'functions',plan:'flex',executions:6000000,gbSeconds:800000,instanceMemoryMB:4096,alwaysReadyInstances:2,alwaysReadyExecutions:1000000,commitment:'sp3y'}, // Non-US region with Flex savings-plan rates from each meter savingsPlan array.
  expected:()=>functionsPrice({region:'westeurope',plan:'flex',executions:6000000,gbSeconds:800000,instanceMemoryMB:4096,alwaysReadyInstances:2,alwaysReadyExecutions:1000000,commitment:'sp3y'})},
 {name:'flex payg no always ready',region:'eastus2',currency:'USD',component:{type:'functions',plan:'flex',executions:300000,gbSeconds:120000,instanceMemoryMB:2048,alwaysReadyInstances:0}, // Flex without always-ready only charges on-demand paid usage above the grants.
  expected:()=>functionsPrice({region:'eastus2',plan:'flex',executions:300000,gbSeconds:120000,instanceMemoryMB:2048,alwaysReadyInstances:0})},
 {name:'eur flex 2048mb always ready',region:'westeurope',currency:'EUR',component:{type:'functions',plan:'flex',executions:1000000,gbSeconds:200000,instanceMemoryMB:2048,alwaysReadyInstances:1,alwaysReadyExecutions:250000}, // EUR uses Retail API currencyCode directly for Flex meters.
  expected:()=>functionsPrice({region:'westeurope',currency:'EUR',plan:'flex',executions:1000000,gbSeconds:200000,instanceMemoryMB:2048,alwaysReadyInstances:1,alwaysReadyExecutions:250000})},
 {name:'flex default 2048mb duration execution time',region:'eastus2',currency:'USD',component:{type:'functions',plan:'flex',executions:1000000,durationMs:1000}, // Flex defaults to a 2048 MB instance, so 1M one-second executions are 2,000,000 GB-s before the 100,000 GB-s grant.
  expected:()=>functionsPrice({region:'eastus2',plan:'flex',executions:1000000,durationMs:1000})},
]};
