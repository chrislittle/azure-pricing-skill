'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function line(desc,monthlyList,extra={}){return{desc,monthlyList:round2(monthlyList),...extra};}
async function s1Price(region,currency){
  const priceRegion=String(region).startsWith('usgov')?'US Gov':'Global';
  const rows=dedupe(await query(`serviceName eq 'Azure Bot Service' and productName eq 'Azure Bot Service' and armRegionName eq '${priceRegion}'`, currency||'USD'));
  const hits=rows.filter(x=>x.skuName==='S1'&&x.meterName==='S1 Premium Channel Messages'&&x.unitOfMeasure==='1K');
  if(hits.length!==1) throw new Error(`expected one Bot Service S1 premium-message meter for ${priceRegion}, found ${hits.length}`);
  return { price:hits[0].retailPrice, unit:unitSize(hits[0].unitOfMeasure), meterId:hits[0].meterId, priceRegion };
}
async function bot(o){
  const tier=o.tier||'s1';
  if(tier==='free') return {monthlyList:0,lines:[line(`Free tier premium messages: ${o.premiumMessages||0} within 10,000 included messages`,0)]};
  const p=await s1Price(o.region,o.currency||'USD');
  const messages=o.premiumMessages||0;
  const lines=[line(`S1 premium-channel messages: ${messages} / ${p.unit} * ${p.price}`, (messages/p.unit)*p.price, p)];
  return {monthlyList:round2(lines[0].monthlyList),lines};
}
module.exports={type:'bot-service',source:'both',cases:[
 {name:'free tier below included messages',region:'eastus2',currency:'USD',component:{type:'bot-service',tier:'free',premiumMessages:9999}, // Free includes up to 10,000 premium-channel messages and has no overage meter.
  expected:()=>bot({region:'eastus2',tier:'free',premiumMessages:9999})},
 {name:'free tier at included message limit',region:'eastus2',currency:'USD',component:{type:'bot-service',tier:'free',premiumMessages:10000}, // Boundary: exactly 10,000 premium messages remains free.
  expected:()=>bot({region:'eastus2',tier:'free',premiumMessages:10000})},
 {name:'free tier above cap errors',region:'eastus2',currency:'USD',component:{type:'bot-service',tier:'free',premiumMessages:10001}, // Free tier has no PAYG overage; use S1 above 10,000 premium messages.
  expectEngineError:/free.*10,000|use tier.*s1|no pay-as-you-go/i},
 {name:'s1 just above free cap',region:'eastus2',currency:'USD',component:{type:'bot-service',tier:'s1',premiumMessages:10001}, // S1 has no free grant; all premium-channel messages bill per 1K using the Retail API S1 meter.
  expected:()=>bot({region:'eastus2',tier:'s1',premiumMessages:10001})},
 {name:'s1 premium messages',region:'eastus2',currency:'USD',component:{type:'bot-service',tier:'s1',premiumMessages:100000}, // S1 bills premium channels in 1,000-message units; standard channels are free and omitted.
  expected:()=>bot({region:'eastus2',tier:'s1',premiumMessages:100000})},
 {name:'s1 large volume',region:'eastus2',currency:'USD',component:{type:'bot-service',tier:'s1',premiumMessages:25000000}, // Large-volume case exercises linear per-1K message arithmetic without tiers.
  expected:()=>bot({region:'eastus2',tier:'s1',premiumMessages:25000000})},
 {name:'s1 zero premium messages',region:'eastus2',currency:'USD',component:{type:'bot-service',tier:'s1',premiumMessages:0}, // No Direct Line/Web Chat premium messages means no Bot Service charge.
  expected:()=>bot({region:'eastus2',tier:'s1',premiumMessages:0})},
 {name:'west europe same s1 calculator offer',region:'westeurope',currency:'USD',component:{type:'bot-service',tier:'s1',premiumMessages:5000}, // Retail API Global S1 meter applies to commercial regions.
  expected:()=>bot({region:'westeurope',tier:'s1',premiumMessages:5000})},
 {name:'us gov virginia s1 premium messages',region:'usgovvirginia',currency:'USD',component:{type:'bot-service',tier:'s1',premiumMessages:2000}, // Retail API US Gov S1 price is $0.625 per 1K premium-channel messages.
  expected:()=>bot({region:'usgovvirginia',tier:'s1',premiumMessages:2000})},
 {name:'eur west europe premium messages',region:'westeurope',currency:'EUR',component:{type:'bot-service',tier:'s1',premiumMessages:2000}, // EUR case reads the Retail API Azure Bot Service Global S1 meter directly, not a Health Bot exchange-ratio proxy.
  expected:()=>bot({region:'westeurope',currency:'EUR',tier:'s1',premiumMessages:2000})},
]};
