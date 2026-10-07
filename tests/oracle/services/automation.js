'use strict';

const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'automation';
const HOURS_PER_MONTH = 730;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

async function graduated(offer, region, qty) {
  const data = await calc.product(SLUG);
  const calcRegion = offer === 'watcher' ? 'global' : calc.calcRegion(data, region);
  const table = data.graduatedOffers[offer][calcRegion];
  if (!table) throw new Error(`calculator has no ${offer} graduated prices for ${calcRegion}`);
  let previous = 0;
  let cost = 0;
  const bands = [];
  for (const band of table.prices) {
    const limit = band.limit;
    const units = Math.max(0, Math.min(qty, limit) - previous);
    if (units) {
      cost += units * band.price.value;
      bands.push({ from: previous, to: limit === Number.MAX_VALUE ? null : limit, units, unitPrice: band.price.value });
    }
    previous = limit;
    if (qty <= limit) break;
  }
  return { cost, bands };
}

async function automationCalc({ region, jobMinutes = 0, watchers = 0, hours = HOURS_PER_MONTH, nonAzureNodes = 0, azureNodes = 0, updateManagementNodes = 0 }) {
  const lines = [];
  if (jobMinutes) {
    const g = await graduated('process-automation', region, jobMinutes);
    lines.push(line(`Process automation: graduated ${jobMinutes} job minutes (first 500 free)`, g.cost, { sourceOffer: 'process-automation', bands: g.bands }));
  }
  if (watchers) {
    const watcherHours = watchers * hours;
    const g = await graduated('watcher', region, watcherHours);
    lines.push(line(`Watcher tasks: graduated ${watchers} * ${hours} = ${watcherHours} watcher-hours (first 744 free)`, g.cost, { sourceOffer: 'watcher', bands: g.bands }));
  }
  if (nonAzureNodes) {
    const g = await graduated('configuration-management', region, nonAzureNodes);
    lines.push(line(`Configuration management non-Azure nodes: graduated ${nonAzureNodes} nodes (first 5 free)`, g.cost, { sourceOffer: 'configuration-management', bands: g.bands }));
  }
  if (azureNodes) {
    const price = (await calc.offerPrice(SLUG, 'azure-configuration-management', region)).value;
    lines.push(line(`Configuration management Azure nodes: ${azureNodes} * ${price}`, azureNodes * price, { sourceOffer: 'azure-configuration-management' }));
  }
  if (updateManagementNodes) {
    const price = (await calc.offerPrice(SLUG, 'update-management', region)).value;
    lines.push(line(`Retired Automation Update Management nodes: ${updateManagementNodes} * ${price}`, updateManagementNodes * price, { sourceOffer: 'update-management' }));
  }
  return { monthlyList: totalOf(lines), lines };
}

function tiered(rows, qty) {
  const bands = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  let cost = 0;
  for (let i = 0; i < bands.length; i++) {
    const start = bands[i].tierMinimumUnits;
    const end = i + 1 < bands.length ? bands[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    cost += (Math.min(qty, end) - start) * bands[i].retailPrice;
  }
  return cost;
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function automationRetail({ region, jobMinutes = 0, watchers = 0, hours = HOURS_PER_MONTH, nonAzureNodes = 0, azureNodes = 0, updateManagementNodes = 0, currency = 'EUR' }) {
  const rows = dedupe(await query(`serviceName eq 'Automation' and armRegionName eq '${region}'`, currency));
  const lines = [];
  if (jobMinutes) {
    const runtime = rows.filter(r => r.productName === 'Process Automation' && r.meterName === 'Basic Runtime');
    lines.push(line(`EUR process automation: graduated ${jobMinutes} job minutes`, tiered(runtime, jobMinutes), { meterId: runtime[0] && runtime[0].meterId }));
  }
  if (watchers) {
    const watcherHours = watchers * hours;
    const watcher = rows.filter(r => r.productName === 'Process Automation' && r.meterName === 'Watcher');
    lines.push(line(`EUR watcher tasks: graduated ${watcherHours} watcher-hours`, tiered(watcher, watcherHours), { meterId: watcher[0] && watcher[0].meterId }));
  }
  if (nonAzureNodes) {
    const nodes = rows.filter(r => r.productName === 'Configuration Management' && r.meterName === 'Non-Azure Node');
    lines.push(line(`EUR configuration management non-Azure nodes: graduated ${nonAzureNodes}`, tiered(nodes, nonAzureNodes), { meterId: nodes[0] && nodes[0].meterId }));
  }
  if (azureNodes) {
    const row = pickOne(rows, r => r.productName === 'Configuration Management' && r.meterName === 'Azure Node', 'Azure configuration node');
    lines.push(line(`EUR Azure configuration nodes: ${azureNodes} * ${row.retailPrice}`, azureNodes * row.retailPrice, { meterId: row.meterId }));
  }
  if (updateManagementNodes) {
    const row = pickOne(rows, r => r.productName === 'Update Management' && r.meterName === 'Basic Node', 'Update Management basic node');
    lines.push(line(`EUR retired Update Management nodes: ${updateManagementNodes} * ${row.retailPrice}`, updateManagementNodes * row.retailPrice, { meterId: row.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'automation',
  source: 'both',
  cases: [
    {
      name: 'process automation at free boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'automation', jobMinutes: 500 },
      // Calculator graduated offer process-automation has 500 free job minutes, then per-minute overage.
      expected: async () => automationCalc({ region: 'eastus2', jobMinutes: 500 }),
    },
    {
      name: 'process automation above free boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'automation', jobMinutes: 506 },
      // Calculator process-automation: 500 free minutes plus 6 paid minutes at the second band.
      expected: async () => automationCalc({ region: 'eastus2', jobMinutes: 506 }),
    },
    {
      name: 'watchers just above global free hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'automation', jobMinutes: 0, watchers: 2, hours: 375 },
      // Calculator watcher graduated offer is global: 2 * 375 = 750 watcher-hours, first 744 free.
      expected: async () => automationCalc({ region: 'eastus2', watchers: 2, hours: 375 }),
    },
    {
      name: 'configuration management non-Azure nodes just above free grant',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'automation', jobMinutes: 0, nonAzureNodes: 6, azureNodes: 3 },
      // Calculator configuration-management: first 5 non-Azure nodes free; Azure nodes use the zero-price Azure node offer.
      expected: async () => automationCalc({ region: 'eastus2', nonAzureNodes: 6, azureNodes: 3 }),
    },
    {
      name: 'retired update management is free',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'automation', jobMinutes: 0, updateManagementNodes: 25 },
      // Calculator update-management offer is zero; old Automation Update Management is retired but not priced.
      expected: async () => automationCalc({ region: 'eastus2', updateManagementNodes: 25 }),
    },
    {
      name: 'non-US region all active dimensions',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'automation', jobMinutes: 2000, watchers: 2, hours: 730, nonAzureNodes: 8 },
      // Calculator West Europe graduated tables for process automation and configuration management plus global watcher bands.
      expected: async () => automationCalc({ region: 'westeurope', jobMinutes: 2000, watchers: 2, hours: 730, nonAzureNodes: 8 }),
    },
    {
      name: 'EUR retail API all active dimensions',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'automation', jobMinutes: 2000, watchers: 2, hours: 730, nonAzureNodes: 8, azureNodes: 1, updateManagementNodes: 1 },
      // EUR Retail API Automation rows expose the same graduated tiers: runtime minutes, watcher-hours, and non-Azure node-months.
      expected: async () => automationRetail({ region: 'westeurope', jobMinutes: 2000, watchers: 2, hours: 730, nonAzureNodes: 8, azureNodes: 1, updateManagementNodes: 1 }),
    },
  ],
};
