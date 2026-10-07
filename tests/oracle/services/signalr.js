'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'signalr-service';
const INCLUDED_MESSAGES_PER_UNIT_DAY = 1000000;
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calcOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }
async function calculatorSignalR({ region, tier, units = 1, messagesPerDay = 0, replicas = 0, hours = 730 }) {
  const days = hours / 24; const lines = [];
  if (tier === 'free') return { monthlyList: 0, lines: [line('Free tier unit is $0; no paid message overage meter', 0, { sourceOffer: 'free' })] };
  const unitOffer = tier === 'premium' ? 'premium' : 'standard';
  const messageOffer = tier === 'premium' ? 'premium-additional-messages' : 'additional-messages';
  const instances = tier === 'premium' ? 1 + replicas : 1;
  const unitPrice = await calcOffer(unitOffer, region);
  lines.push(line(`${tier} units: ${instances} instance(s) * ${units} * ${days} days * ${unitPrice}`, instances * units * days * unitPrice, { sourceOffer: unitOffer }));
  const messagesPerInstanceDay = messagesPerDay / instances;
  const billablePerDay = Math.max(0, messagesPerInstanceDay - units * INCLUDED_MESSAGES_PER_UNIT_DAY) * instances;
  if (billablePerDay) { const msgPrice = await calcOffer(messageOffer, region); lines.push(line(`${tier} messages: max(0, ${messagesPerDay} - ${units}M/day included) / 1M * ${days} days * ${msgPrice}`, (billablePerDay / 1000000) * days * msgPrice, { sourceOffer: messageOffer })); }
  return { monthlyList: totalOf(lines), lines };
}
async function retailSignalR({ region, currency, tier, units = 1, messagesPerDay = 0, hours = 730 }) {
  const rows = dedupe(await query(`serviceName eq 'SignalR' and armRegionName eq '${region}'`, currency));
  const days = hours / 24; const lines = [];
  if (tier === 'free') return { monthlyList: 0, lines: [line('Retail API Standard Unit - Free is $0/day', 0)] };
  const sku = tier === 'premium' ? 'Premium' : 'Standard';
  const unit = rows.find(r => r.type === 'Consumption' && r.skuName === sku && r.meterName === `${sku} Unit` && r.unitOfMeasure === '1/Day');
  const msg = rows.find(r => r.type === 'Consumption' && r.skuName === sku && r.meterName === `${sku} Message`);
  if (!unit || !msg) throw new Error(`missing SignalR ${sku} retail meters`);
  lines.push(line(`Retail ${sku} Unit: ${units} * ${days} days * ${unit.retailPrice}`, units * days * unit.retailPrice, { meterId: unit.meterId }));
  const billablePerDay = Math.max(0, messagesPerDay - units * INCLUDED_MESSAGES_PER_UNIT_DAY);
  if (billablePerDay) lines.push(line(`Retail ${sku} Message: ${billablePerDay}/day / ${msg.unitOfMeasure} * ${days} days * ${msg.retailPrice}`, (billablePerDay / unitSize(msg.unitOfMeasure)) * days * msg.retailPrice, { meterId: msg.meterId }));
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'signalr', source: 'both', cases: [
  { name: 'free tier remains zero', region: 'eastus2', currency: 'USD', component: { type: 'signalr', tier: 'free', units: 1, messagesPerDay: 20000 },
    // Calculator free offer is zero; the free service has trial boundaries and no paid overage line.
    expected: async () => calculatorSignalR({ region: 'eastus2', tier: 'free', units: 1, messagesPerDay: 20000 }) },
  { name: 'standard at included messages boundary', region: 'eastus2', currency: 'USD', component: { type: 'signalr', tier: 'standard', units: 1, messagesPerDay: 1000000 },
    // Calculator Standard Unit is per day; each unit includes 1M outbound messages per day.
    expected: async () => calculatorSignalR({ region: 'eastus2', tier: 'standard', units: 1, messagesPerDay: 1000000 }) },
  { name: 'standard just above included messages', region: 'eastus2', currency: 'USD', component: { type: 'signalr', tier: 'standard', units: 1, messagesPerDay: 1000001 },
    // Calculator additional-messages offer is per 1M messages; only the one message/day above the 1M unit grant is billable.
    expected: async () => calculatorSignalR({ region: 'eastus2', tier: 'standard', units: 1, messagesPerDay: 1000001 }) },
  { name: 'premium two units with overage', region: 'eastus2', currency: 'USD', component: { type: 'signalr', tier: 'premium', units: 2, messagesPerDay: 2500000 },
    // Calculator Premium Unit is per day and Premium Message bills only messages above 1M per unit per day.
    expected: async () => calculatorSignalR({ region: 'eastus2', tier: 'premium', units: 2, messagesPerDay: 2500000 }) },
  { name: 'premium replica has own units and message allowance', region: 'eastus2', currency: 'USD', component: { type: 'signalr', tier: 'premium', units: 2, replicas: 1, messagesPerDay: 5000000 },
    // Premium geo-replicas are separate instances: each bills its own units and gets its own 1M messages/unit/day allowance.
    expected: async () => calculatorSignalR({ region: 'eastus2', tier: 'premium', units: 2, replicas: 1, messagesPerDay: 5000000 }) },
  { name: 'invalid signalr unit step errors', region: 'eastus2', currency: 'USD', component: { type: 'signalr', tier: 'standard', units: 15, messagesPerDay: 0 },
    // SignalR deployable unit counts are 1-10, then 20, 30, ... 100.
    expectEngineError: /units.*1.*10.*20/i },
  { name: 'part-time standard unit', region: 'eastus2', currency: 'USD', component: { type: 'signalr', tier: 'standard', units: 1, messagesPerDay: 0, hours: 240 },
    // Calculator unit price is daily, so part-time hours are converted to days at hours/24.
    expected: async () => calculatorSignalR({ region: 'eastus2', tier: 'standard', units: 1, messagesPerDay: 0, hours: 240 }) },
  { name: 'west europe premium regional price', region: 'westeurope', currency: 'USD', component: { type: 'signalr', tier: 'premium', units: 1, messagesPerDay: 2000000 },
    // Calculator West Europe prices are selected independently from East US 2 by region slug.
    expected: async () => calculatorSignalR({ region: 'westeurope', tier: 'premium', units: 1, messagesPerDay: 2000000 }) },
  { name: 'israel central uplift regional price', region: 'israelcentral', currency: 'USD', component: { type: 'signalr', tier: 'standard', units: 1, messagesPerDay: 1500000 },
    // Calculator Israel Central has uplifted SignalR unit and message rates versus East US 2.
    expected: async () => calculatorSignalR({ region: 'israelcentral', tier: 'standard', units: 1, messagesPerDay: 1500000 }) },
  { name: 'us gov retail daily unit meter', region: 'usgovvirginia', currency: 'USD', component: { type: 'signalr', tier: 'standard', units: 1, messagesPerDay: 0 },
    // Retail API US Gov exposes Standard Unit as a daily meter; an extra 1 Hour zero/free row must not be selected.
    expected: async () => retailSignalR({ region: 'usgovvirginia', currency: 'USD', tier: 'standard', units: 1, messagesPerDay: 0 }) },
  { name: 'EUR retail standard overage', region: 'westeurope', currency: 'EUR', component: { type: 'signalr', tier: 'standard', units: 1, messagesPerDay: 1500000 },
    // Retail API EUR SignalR rows expose Standard Unit per day and Standard Message per 1M messages.
    expected: async () => retailSignalR({ region: 'westeurope', currency: 'EUR', tier: 'standard', units: 1, messagesPerDay: 1500000 }) },
] };
