'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'web-pubsub';
const INCLUDED_MESSAGES_PER_UNIT_DAY = 1000000;
const v3Cache = new Map();
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function productV3(slug) { if (v3Cache.has(slug)) return v3Cache.get(slug); const res = await fetch(`https://azure.microsoft.com/api/v3/pricing/${slug}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!res.ok) throw new Error(`calculator v3 ${slug}: HTTP ${res.status}`); const d = await res.json(); v3Cache.set(slug, d); return d; }
function v3Price(data, offer, armRegion) { const region = calc.calcRegion(data, armRegion); const prices = data.offers[offer].prices; for (const bucket of Object.keys(prices)) if (prices[bucket][region]) return prices[bucket][region].value; throw new Error(`calculator v3 ${offer}: no price for ${region}`); }
async function calculatorWebPubSub({ region, tier, units = 1, messagesPerDay = 0, replicas = 0, hours = 730 }) {
  const data = await productV3(SLUG); const days = hours / 24; const lines = [];
  if (tier === 'free') return { monthlyList: 0, lines: [line('Free tier unit is $0 and has no paid overage line', 0, { sourceOffer: 'free' })] };
  const unitOffer = `${tier}-units`; const msgOffer = `${tier}-messages`; const unitPrice = v3Price(data, unitOffer, region);
  const instances = tier === 'premium' ? 1 + replicas : 1;
  lines.push(line(`${tier} units: ${instances} instance(s) * ${units} * ${days} days * ${unitPrice}`, instances * units * days * unitPrice, { sourceOffer: unitOffer }));
  const messagesPerInstanceDay = messagesPerDay / instances;
  const billablePerDay = Math.max(0, messagesPerInstanceDay - units * INCLUDED_MESSAGES_PER_UNIT_DAY) * instances;
  if (billablePerDay) { const msgPrice = v3Price(data, msgOffer, region); lines.push(line(`${tier} outbound messages: ${billablePerDay}/day / 1M * ${days} days * ${msgPrice}`, (billablePerDay / 1000000) * days * msgPrice, { sourceOffer: msgOffer })); }
  return { monthlyList: totalOf(lines), lines };
}
async function retailWebPubSub({ region, currency, tier, units = 1, messagesPerDay = 0, hours = 730 }) {
  const rows = dedupe(await query(`serviceName eq 'Web PubSub' and armRegionName eq '${region}'`, currency)); const days = hours / 24;
  if (tier === 'free') return { monthlyList: 0, lines: [line('Retail API Standard Unit - Free is zero', 0)] };
  const sku = tier === 'premium' ? 'Premium' : 'Standard';
  const unit = rows.find(r => r.type === 'Consumption' && r.skuName === sku && r.meterName === `${sku} Unit`);
  const msg = rows.find(r => r.type === 'Consumption' && r.skuName === sku && r.meterName === `${sku} Message`);
  if (!unit || !msg) throw new Error(`missing Web PubSub ${sku} retail meters`);
  const lines = [line(`Retail ${sku} Unit: ${units} * ${days} days * ${unit.retailPrice}`, units * days * unit.retailPrice, { meterId: unit.meterId })];
  const billablePerDay = Math.max(0, messagesPerDay - units * INCLUDED_MESSAGES_PER_UNIT_DAY);
  if (billablePerDay) lines.push(line(`Retail ${sku} Message: ${billablePerDay}/day / ${msg.unitOfMeasure} * ${days} days * ${msg.retailPrice}`, (billablePerDay / unitSize(msg.unitOfMeasure)) * days * msg.retailPrice, { meterId: msg.meterId }));
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'web-pubsub', source: 'both', cases: [
  { name: 'free tier zero', region: 'eastus2', currency: 'USD', component: { type: 'web-pubsub', tier: 'free', units: 1, messagesPerDay: 20000 },
    // Calculator v3 has no paid Free offer; Web PubSub Free is a trial tier with included connection/message limits only.
    expected: async () => calculatorWebPubSub({ region: 'eastus2', tier: 'free', units: 1, messagesPerDay: 20000 }) },
  { name: 'standard at 1M per unit per day', region: 'eastus2', currency: 'USD', component: { type: 'web-pubsub', tier: 'standard', units: 1, messagesPerDay: 1000000 },
    // Calculator v3 Standard Unit is per day; the first 1M outbound messages per unit per day are included.
    expected: async () => calculatorWebPubSub({ region: 'eastus2', tier: 'standard', units: 1, messagesPerDay: 1000000 }) },
  { name: 'standard just above message grant', region: 'eastus2', currency: 'USD', component: { type: 'web-pubsub', tier: 'standard', units: 1, messagesPerDay: 1000001 },
    // Calculator v3 Standard Message is per 1M outbound messages; inbound and pings are not billed.
    expected: async () => calculatorWebPubSub({ region: 'eastus2', tier: 'standard', units: 1, messagesPerDay: 1000001 }) },
  { name: 'premium two units with overage', region: 'eastus2', currency: 'USD', component: { type: 'web-pubsub', tier: 'premium', units: 2, messagesPerDay: 2500000 },
    // Premium includes the same 1M outbound messages per unit per day, then Premium Message overage applies.
    expected: async () => calculatorWebPubSub({ region: 'eastus2', tier: 'premium', units: 2, messagesPerDay: 2500000 }) },
  { name: 'premium replica has own units and message allowance', region: 'eastus2', currency: 'USD', component: { type: 'web-pubsub', tier: 'premium', units: 2, replicas: 1, messagesPerDay: 5000000 },
    // Premium geo-replicas are separate instances: each bills its own units and gets its own 1M messages/unit/day allowance.
    expected: async () => calculatorWebPubSub({ region: 'eastus2', tier: 'premium', units: 2, replicas: 1, messagesPerDay: 5000000 }) },
  { name: 'standard three units valid', region: 'eastus2', currency: 'USD', component: { type: 'web-pubsub', tier: 'standard', units: 3, messagesPerDay: 0 },
    // Microsoft Learn manual scale lists Standard/Premium_P1 units 1 through 10, then 20, 30, ... 100; 3 units is valid.
    expected: async () => calculatorWebPubSub({ region: 'eastus2', tier: 'standard', units: 3, messagesPerDay: 0 }) },
  { name: 'invalid web pubsub unit step errors', region: 'eastus2', currency: 'USD', component: { type: 'web-pubsub', tier: 'standard', units: 15, messagesPerDay: 0 },
    // Learn manual scale lists Standard/Premium_P1 units 1-10, then 20, 30, ... 100; 15 is invalid.
    expectEngineError: /units.*1.*10.*20.*100/i },
  { name: 'part-time standard unit', region: 'eastus2', currency: 'USD', component: { type: 'web-pubsub', tier: 'standard', units: 1, messagesPerDay: 0, hours: 240 },
    // Calculator daily unit price is prorated by hours/24 for a part-month service lifetime.
    expected: async () => calculatorWebPubSub({ region: 'eastus2', tier: 'standard', units: 1, messagesPerDay: 0, hours: 240 }) },
  { name: 'west europe premium regional price', region: 'westeurope', currency: 'USD', component: { type: 'web-pubsub', tier: 'premium', units: 1, messagesPerDay: 2000000 },
    // Calculator v3 selects the West Europe region independently from East US 2.
    expected: async () => calculatorWebPubSub({ region: 'westeurope', tier: 'premium', units: 1, messagesPerDay: 2000000 }) },
  { name: 'belgium central uplift regional price', region: 'belgiumcentral', currency: 'USD', component: { type: 'web-pubsub', tier: 'standard', units: 1, messagesPerDay: 1500000 },
    // Calculator v3 Belgium Central has uplifted Web PubSub unit and message rates versus East US 2.
    expected: async () => calculatorWebPubSub({ region: 'belgiumcentral', tier: 'standard', units: 1, messagesPerDay: 1500000 }) },
  { name: 'us gov retail daily unit meter', region: 'usgovvirginia', currency: 'USD', component: { type: 'web-pubsub', tier: 'standard', units: 1, messagesPerDay: 0 },
    // Retail API US Gov exposes the Standard Unit daily meter for Web PubSub.
    expected: async () => retailWebPubSub({ region: 'usgovvirginia', currency: 'USD', tier: 'standard', units: 1, messagesPerDay: 0 }) },
  { name: 'EUR retail standard overage', region: 'westeurope', currency: 'EUR', component: { type: 'web-pubsub', tier: 'standard', units: 1, messagesPerDay: 1500000 },
    // Retail API EUR Web PubSub rows expose Standard Unit per day and Standard Message per 1M outbound messages.
    expected: async () => retailWebPubSub({ region: 'westeurope', currency: 'EUR', tier: 'standard', units: 1, messagesPerDay: 1500000 }) },
] };
