'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function line(desc, monthlyList, extra={}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function chaos(opts){ const rows=dedupe(await query(`serviceName eq 'Azure Chaos Studio' and productName eq 'Azure Chaos Studio' and armRegionName eq '${opts.region}'`, opts.currency||'USD')); const r=rows.find(x=>x.skuName==='Essential'&&x.meterName==='Essential Action-Minute'); if(!r) throw new Error('no Chaos Studio action-minute meter'); const runs=opts.experimentRuns||0; const minutes=opts.minutesPerAction??10; const actions=opts.actionsPerRun??1; const actionMinutes=runs*minutes*actions; const lines=[line(`Action-minutes: ${runs} runs * ${actions} action(s) * ${minutes} minutes/action`, (actionMinutes/unitSize(r.unitOfMeasure))*r.retailPrice,{meterId:r.meterId})]; return {monthlyList:round2(lines[0].monthlyList),lines}; }
module.exports={ type:'chaos-studio', source:'retail-api', cases:[
 {name:'defaults ten runs ten minutes one action',region:'eastus2',currency:'USD',component:{type:'chaos-studio',experimentRuns:10}, // Public defaults are 10 minutes per run and 1 action per run; calculator bills per action-minute.
  expected:()=>chaos({region:'eastus2',experimentRuns:10})},
 {name:'single ten-minute action',region:'eastus2',currency:'USD',component:{type:'chaos-studio',experimentRuns:1,minutesPerAction:10,actionsPerRun:1}, // One action that lasts 10 minutes produces 10 action-minutes.
  expected:()=>chaos({region:'eastus2',experimentRuns:1,minutesPerAction:10,actionsPerRun:1})},
 {name:'parallel actions multiply their own minutes',region:'eastus2',currency:'USD',component:{type:'chaos-studio',experimentRuns:10,minutesPerAction:15,actionsPerRun:3}, // Calculator action-minutes are per action times that action's minutes; simultaneous actions still add.
  expected:()=>chaos({region:'eastus2',experimentRuns:10,minutesPerAction:15,actionsPerRun:3})},
 {name:'zero runs is free',region:'eastus2',currency:'USD',component:{type:'chaos-studio',experimentRuns:0,minutesPerAction:10,actionsPerRun:1}, // No experiment executions means zero action-minutes.
  expected:()=>chaos({region:'eastus2',experimentRuns:0,minutesPerAction:10,actionsPerRun:1})},
 {name:'very large action-minute volume',region:'eastus2',currency:'USD',component:{type:'chaos-studio',experimentRuns:1000000,minutesPerAction:60,actionsPerRun:25}, // Large-volume case exercises arithmetic without tiers: 1,000,000 * 25 * 60 action-minutes.
  expected:()=>chaos({region:'eastus2',experimentRuns:1000000,minutesPerAction:60,actionsPerRun:25})},
 {name:'west europe same action-minute meter',region:'westeurope',currency:'USD',component:{type:'chaos-studio',experimentRuns:5,minutesPerAction:60,actionsPerRun:2}, // Non-US region validates the Retail API action-minute row outside East US 2.
  expected:()=>chaos({region:'westeurope',experimentRuns:5,minutesPerAction:60,actionsPerRun:2})},
 {name:'eur short runs',region:'westeurope',currency:'EUR',component:{type:'chaos-studio',experimentRuns:2,minutesPerAction:7,actionsPerRun:4}, // EUR case queries the same Retail API meter in EUR.
  expected:()=>chaos({region:'westeurope',currency:'EUR',experimentRuns:2,minutesPerAction:7,actionsPerRun:4})},
]};
