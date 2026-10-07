'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'fluid-relay'; const v3Cache = new Map();
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function productV3() { if (v3Cache.has(SLUG)) return v3Cache.get(SLUG); const res = await fetch(`https://azure.microsoft.com/api/v3/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!res.ok) throw new Error(`calculator v3 ${SLUG}: HTTP ${res.status}`); const d = await res.json(); v3Cache.set(SLUG, d); return d; }
function v3Price(data, offer, armRegion) { const region = calc.calcRegion(data, armRegion); const prices = data.offers[offer].prices; for (const bucket of Object.keys(prices)) if (prices[bucket][region]) return prices[bucket][region].value; throw new Error(`calculator v3 ${offer}: no price for ${region}`); }
async function calculatorFluid({ region, tier, operationsIn = 0, operationsOut = 0, clientMinutes = 0, storageGB = 0 }) { const data = await productV3(); const lines = []; const map = [['operationsIn', operationsIn, `${tier}-operations-in-1M`, 1000000], ['operationsOut', operationsOut, `${tier}-operations-out-1M`, 1000000], ['clientMinutes', clientMinutes, `${tier}-client-connectivity-1M-minutes`, 1000000], ['storageGB', storageGB, `${tier}-storage`, 1]]; for (const [field, qty, offer, div] of map) if (qty) { const p = v3Price(data, offer, region); lines.push(line(`${field}: ${qty} / ${div} * ${p}`, (qty / div) * p, { sourceOffer: offer })); } return { monthlyList: totalOf(lines), lines }; }
async function retailFluid({ region, currency, tier, operationsIn = 0, operationsOut = 0, clientMinutes = 0, storageGB = 0 }) { const rs = dedupe(await query(`serviceName eq 'Azure Fluid Relay' and armRegionName eq '${region}'`, currency)); const sku = tier === 'basic' ? 'Basic' : 'Standard'; const meters = [['operationsIn', operationsIn, `${sku} Operations In`], ['operationsOut', operationsOut, `${sku} Operations Out`], ['clientMinutes', clientMinutes, `${sku} Client Connectivity Minutes`], ['storageGB', storageGB, `${sku} Storage`]]; const lines = []; for (const [field, qty, meter] of meters) if (qty) { const r = rs.find(x => x.type === 'Consumption' && x.skuName === sku && x.meterName === meter); if (!r) throw new Error(`missing ${meter}`); lines.push(line(`Retail ${meter}: ${qty} / ${r.unitOfMeasure} * ${r.retailPrice}`, (qty / unitSize(r.unitOfMeasure)) * r.retailPrice, { meterId: r.meterId })); } return { monthlyList: totalOf(lines), lines }; }
module.exports = { type: 'fluid-relay', source: 'both', cases: [
  { name: 'standard operations in only', region: 'eastus2', currency: 'USD', component: { type: 'fluid-relay', tier: 'standard', operationsIn: 1000000, operationsOut: 0, clientMinutes: 0 },
    // Calculator v3 Standard Operations In is billed per 1M operations; current component schema requires operationsOut and clientMinutes fields too.
    expected: async () => calculatorFluid({ region: 'eastus2', tier: 'standard', operationsIn: 1000000, operationsOut: 0, clientMinutes: 0 }) },
  { name: 'standard all dimensions', region: 'eastus2', currency: 'USD', component: { type: 'fluid-relay', tier: 'standard', operationsIn: 2000000, operationsOut: 3000000, clientMinutes: 4000000, storageGB: 50 },
    // Calculator v3 bills operations in, operations out, client connectivity minutes, and storage as separate meters.
    expected: async () => calculatorFluid({ region: 'eastus2', tier: 'standard', operationsIn: 2000000, operationsOut: 3000000, clientMinutes: 4000000, storageGB: 50 }) },
  { name: 'standard fractional million boundary', region: 'eastus2', currency: 'USD', component: { type: 'fluid-relay', tier: 'standard', operationsIn: 1000001, operationsOut: 999999, clientMinutes: 1 },
    // Calculator v3 prices are linear per 1M units; there is no free boundary, so fractional million quantities are billable.
    expected: async () => calculatorFluid({ region: 'eastus2', tier: 'standard', operationsIn: 1000001, operationsOut: 999999, clientMinutes: 1 }) },
  { name: 'basic limited-region all dimensions', region: 'italynorth', currency: 'USD', component: { type: 'fluid-relay', tier: 'basic', operationsIn: 2000000, operationsOut: 3000000, clientMinutes: 4000000, storageGB: 50 },
    // Calculator v3 Basic prices exist only in selected regions; Italy North is one of the Basic price regions.
    expected: async () => calculatorFluid({ region: 'italynorth', tier: 'basic', operationsIn: 2000000, operationsOut: 3000000, clientMinutes: 4000000, storageGB: 50 }) },
  { name: 'west europe standard regional uplift', region: 'westeurope', currency: 'USD', component: { type: 'fluid-relay', tier: 'standard', operationsIn: 2000000, operationsOut: 3000000, clientMinutes: 4000000, storageGB: 50 },
    // Calculator v3 West Europe Standard rates are higher than East US 2 for all four dimensions.
    expected: async () => calculatorFluid({ region: 'westeurope', tier: 'standard', operationsIn: 2000000, operationsOut: 3000000, clientMinutes: 4000000, storageGB: 50 }) },
  { name: 'EUR retail standard all dimensions', region: 'westeurope', currency: 'EUR', component: { type: 'fluid-relay', tier: 'standard', operationsIn: 2000000, operationsOut: 3000000, clientMinutes: 4000000, storageGB: 50 },
    // Retail API is queried natively in EUR for Standard Operations In/Out, Client Connectivity Minutes, and Storage.
    expected: async () => retailFluid({ region: 'westeurope', currency: 'EUR', tier: 'standard', operationsIn: 2000000, operationsOut: 3000000, clientMinutes: 4000000, storageGB: 50 }) },
] };
