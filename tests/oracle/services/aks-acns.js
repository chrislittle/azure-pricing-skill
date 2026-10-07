'use strict';
const { query, dedupe, round2 } = require('../api');
const HOURS = 730;
const SLUG = 'advanced-container-networking-services';
const cache = new Map();
async function product(slug) { if (cache.has(slug)) return cache.get(slug); for (const v of ['v2','v3']) { const res = await fetch('https://azure.microsoft.com/api/' + v + '/pricing/' + slug + '/calculator/?culture=en-us'); if (res.ok) { const j = await res.json(); cache.set(slug, j); return j; } } throw new Error('calculator has no price data for ' + slug); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length < 1) throw new Error('no Retail API row for ' + what); return hits[0]; }
async function acns(o) { const currency = o.currency || 'USD', hours = o.hours ?? HOURS; let price, source = {}; if (currency === 'USD') { const d = await product(SLUG); const region = (o.region || 'eastus2') === 'westeurope' ? 'europe-west' : 'us-east-2'; price = d.offers['advanced-container-networking-services-standard'].prices.perhour[region].value; source = { sourceOffer: 'advanced-container-networking-services-standard' }; } else { const rows = dedupe(await query("serviceName eq 'Advanced Container Networking Services'", currency)); const r = pick(rows, x => x.skuName === 'Standard' && x.meterName === 'Standard Node' && x.armRegionName === 'Global', 'Standard Node'); price = r.retailPrice; source = { meterId: r.meterId }; } const l = line('ACNS Standard nodes: ' + o.nodes + ' * ' + hours + ' h * ' + price, o.nodes * hours * price, source); return { monthlyList: l.monthlyList, lines: [l] }; }
module.exports = { type: 'aks-acns', source: 'both', cases: [
  { name: 'one node full month', region: 'eastus2', currency: 'USD', component: { type: 'aks-acns', nodes: 1 },
    // Calculator v3 Advanced Container Networking Services Standard node is billed per node-hour.
    expected: () => acns({ region: 'eastus2', nodes: 1 }) },
  { name: 'ten nodes full month', region: 'eastus2', currency: 'USD', component: { type: 'aks-acns', nodes: 10 },
    // Standard node-hour price scales linearly with the AKS node count.
    expected: () => acns({ region: 'eastus2', nodes: 10 }) },
  { name: 'autoscaled nodes part month', region: 'eastus2', currency: 'USD', component: { type: 'aks-acns', nodes: 8, hours: 365 },
    // Autoscaled average node count is multiplied by the part-month hours.
    expected: () => acns({ region: 'eastus2', nodes: 8, hours: 365 }) },
  { name: 'non-US nodes', region: 'westeurope', currency: 'USD', component: { type: 'aks-acns', nodes: 3 },
    // West Europe calculator v3 Standard node-hour is read from the non-US region price table.
    expected: () => acns({ region: 'westeurope', nodes: 3 }) },
  { name: 'EUR nodes', region: 'westeurope', currency: 'EUR', component: { type: 'aks-acns', nodes: 4, hours: 100 },
    // Retail API EUR Global ACNS Standard Node row is per node-hour.
    expected: () => acns({ currency: 'EUR', region: 'westeurope', nodes: 4, hours: 100 }) },
] };
