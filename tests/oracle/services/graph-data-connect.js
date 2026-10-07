'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'graph-data-connect';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function product(currency = 'USD') {
  const qs = currency === 'USD' ? 'culture=en-us' : `culture=en-us&currency=${encodeURIComponent(currency.toLowerCase())}`;
  const res = await fetch(`https://azure.microsoft.com/api/v3/pricing/${SLUG}/calculator/?${qs}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`calculator v3 ${SLUG} HTTP ${res.status}`);
  return res.json();
}
async function price(region, currency) {
  if (currency !== 'USD') {
    const rows = dedupe(await query("meterName eq 'Standard 1K Objects Extracted'", currency));
    const hit = rows.find(r => r.armRegionName === 'Global' && r.serviceName === 'Microsoft Graph data connect' && r.skuName === 'Standard');
    if (!hit) throw new Error(`no ${currency} Retail API row for Standard 1K Objects Extracted`);
    return { value: hit.retailPrice, source: { meterId: hit.meterId, unitSize: unitSize(hit.unitOfMeasure) } };
  }
  const data = await product(currency);
  const r = calc.calcRegion(data, region);
  const p = data.offers['data-extractor'].prices.per1k[r];
  if (!p) throw new Error(`no graph-data-connect price for ${r}`);
  return { value: p.value, source: { sourceOffer: 'data-extractor--per1k', unitSize: 1000 } };
}
async function graph({ region, currency = 'USD', objects, runs = 1 }) {
  const p = await price(region, currency);
  const unitsPerRun = Math.ceil((objects / runs) / p.source.unitSize);
  const billableUnits = runs * unitsPerRun;
  const lines = [line(`${currency} data extractor: ${runs} runs * ceil(${objects}/${runs}/${p.source.unitSize}) units * ${p.value}`, billableUnits * p.value, { ...p.source, billableUnits, unitsPerRun })];
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'graph-data-connect', source: 'both', cases: [
  { name: 'one thousand objects', region: 'eastus2', currency: 'USD', component: { type: 'graph-data-connect', objects: 1000 },
    // Calculator v3 data-extractor offer is per 1,000 objects; Learn says each run rounds up fractions, so 1,000 objects in one run is one billable unit.
    expected: async () => graph({ region: 'eastus2', objects: 1000 }) },
  { name: 'one thousand and one objects boundary', region: 'eastus2', currency: 'USD', component: { type: 'graph-data-connect', objects: 1001 },
    // One run with 1,001 objects rounds up to two 1K units at $0.75, so the boundary cost is $1.50.
    expected: async () => graph({ region: 'eastus2', objects: 1001 }) },
  { name: 'single object rounds to one unit', region: 'eastus2', currency: 'USD', component: { type: 'graph-data-connect', objects: 1 },
    // Learn billing rounds each run up to the next 1,000 objects; one object in one run is one $0.75 unit.
    expected: async () => graph({ region: 'eastus2', objects: 1 }) },
  { name: 'learn example 20 runs of 500 objects', region: 'eastus2', currency: 'USD', component: { type: 'graph-data-connect', objects: 10000, runs: 20 },
    // Learn FAQ example: 20 pipeline runs with 500 rows each bill 20 rounded-up units; 20 * $0.75 = $15.00.
    expected: async () => graph({ region: 'eastus2', objects: 10000, runs: 20 }) },
  { name: 'large monthly extraction', region: 'eastus2', currency: 'USD', component: { type: 'graph-data-connect', objects: 5000000 },
    // One large run bills ceil(5,000,000 / 1,000) units at the calculator v3 per-1K price.
    expected: async () => graph({ region: 'eastus2', objects: 5000000 }) },
  { name: 'non-US west europe extraction', region: 'westeurope', currency: 'USD', component: { type: 'graph-data-connect', objects: 250000 },
    // Calculator v3 has a West Europe row; one run bills ceil(250,000 / 1,000) units.
    expected: async () => graph({ region: 'westeurope', objects: 250000 }) },
  { name: 'EUR retail global three runs', region: 'westeurope', currency: 'EUR', component: { type: 'graph-data-connect', objects: 250000, runs: 3 },
    // Retail API Global meter "Standard 1K Objects Extracted" is authoritative for EUR; 3 * ceil(250,000/3/1,000) = 252 units, €166.31.
    expected: async () => graph({ region: 'westeurope', currency: 'EUR', objects: 250000, runs: 3 }) },
] };
