'use strict';

const { query, dedupe, round2 } = require('../api');
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function tiered(rows, qty) { const tiers = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits); let cost = 0; const bands = []; for (let i = 0; i < tiers.length; i++) { const start = tiers[i].tierMinimumUnits; const end = i + 1 < tiers.length ? tiers[i + 1].tierMinimumUnits : Infinity; if (qty <= start) break; const units = Math.min(qty, end) - start; cost += units * tiers[i].retailPrice; bands.push({ fromUnits: start, toUnits: end === Infinity ? null : end, units, unitPrice: tiers[i].retailPrice }); } return { cost, bands }; }
async function rows(region, currency) { return dedupe(await query(`productName eq 'Static Web Apps' and armRegionName eq '${region}'`, currency)); }
async function retailStatic({ region, currency = 'USD', plan, apps = 1, bandwidthGB = 0, enterpriseEdgeApps = 0, hours = 730 }) {
  if (plan === 'free') return { monthlyList: 0, lines: [line(`Free apps: ${apps} app(s) at $0; bandwidth capped at 100 GB/month with no overage meter`, 0)] };
  const rs = await rows(region, currency);
  const app = rs.find(r => r.type === 'Consumption' && r.meterName === 'Standard App');
  const bw = rs.filter(r => r.type === 'Consumption' && r.meterName === 'Standard Bandwidth Usage');
  const edge = rs.find(r => r.type === 'Consumption' && r.meterName === 'Standard Azure Front Door Add-on');
  if (!app || !bw.length || !edge) throw new Error(`missing Static Web Apps retail meters for ${region}`);
  const lines = [line(`Standard apps: ${apps} * ${app.retailPrice}/month`, apps * app.retailPrice, { meterId: app.meterId })];
  if (bandwidthGB) { const g = tiered(bw, bandwidthGB); lines.push(line(`Bandwidth: ${bandwidthGB} GB through Retail API tiers (first 100 GB/month free)`, g.cost, { meterId: bw[0].meterId, bands: g.bands })); }
  if (enterpriseEdgeApps) lines.push(line(`Enterprise-grade edge: ${enterpriseEdgeApps} * ${hours} hours * ${edge.retailPrice}`, enterpriseEdgeApps * hours * edge.retailPrice, { meterId: edge.meterId }));
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'static-web-apps', source: 'retail-api', cases: [
  { name: 'free plan bandwidth over cap errors', region: 'eastus2', currency: 'USD', component: { type: 'static-web-apps', plan: 'free', apps: 1, bandwidthGB: 150 },
    // Free plan bandwidth is capped at 100 GB/month and has no overage meter.
    expectEngineError: /free plan.*100 GB.*cannot go over/i },
  { name: 'free plan max apps at cap', region: 'eastus2', currency: 'USD', component: { type: 'static-web-apps', plan: 'free', apps: 10, bandwidthGB: 100 },
    // Free plan can host up to 10 apps and shows an app-count line, but all Free app hosting remains $0.
    expected: async () => retailStatic({ region: 'eastus2', plan: 'free', apps: 10, bandwidthGB: 100 }) },
  { name: 'free plan above max apps errors', region: 'eastus2', currency: 'USD', component: { type: 'static-web-apps', plan: 'free', apps: 11, bandwidthGB: 100 },
    // Free plan maximum is 10 apps.
    expectEngineError: /free plan.*10 app/i },
  { name: 'standard app with bandwidth at free boundary', region: 'eastus2', currency: 'USD', component: { type: 'static-web-apps', plan: 'standard', apps: 1, bandwidthGB: 100 },
    // Retail API Standard Bandwidth Usage has a $0 band from 0 to 100 GB/month, then a paid band.
    expected: async () => retailStatic({ region: 'eastus2', plan: 'standard', apps: 1, bandwidthGB: 100 }) },
  { name: 'standard app just above bandwidth grant', region: 'eastus2', currency: 'USD', component: { type: 'static-web-apps', plan: 'standard', apps: 1, bandwidthGB: 101 },
    // The first 100 GB/month are free; only the 1 GB overage is charged at the paid tier.
    expected: async () => retailStatic({ region: 'eastus2', plan: 'standard', apps: 1, bandwidthGB: 101 }) },
  { name: 'two standard apps share subscription bandwidth grant', region: 'eastus2', currency: 'USD', component: { type: 'static-web-apps', plan: 'standard', apps: 2, bandwidthGB: 150 },
    // The 100 GB/month bandwidth grant is per subscription, not per app; two apps with 150 GB total bill 50 GB overage.
    expected: async () => retailStatic({ region: 'eastus2', plan: 'standard', apps: 2, bandwidthGB: 150 }) },
  { name: 'multiple standard apps with enterprise edge', region: 'eastus2', currency: 'USD', component: { type: 'static-web-apps', plan: 'standard', apps: 3, bandwidthGB: 250, enterpriseEdgeApps: 2, hours: 100 },
    // Retail API bills Standard App monthly, bandwidth by graduated GB/month, and Azure Front Door add-on per app-hour.
    expected: async () => retailStatic({ region: 'eastus2', plan: 'standard', apps: 3, bandwidthGB: 250, enterpriseEdgeApps: 2, hours: 100 }) },
  { name: 'chile central regional uplift', region: 'chilecentral', currency: 'USD', component: { type: 'static-web-apps', plan: 'standard', apps: 1, bandwidthGB: 150, enterpriseEdgeApps: 1, hours: 730 },
    // Retail API Chile Central rows have higher Standard App, bandwidth, and Front Door add-on rates than East US 2.
    expected: async () => retailStatic({ region: 'chilecentral', plan: 'standard', apps: 1, bandwidthGB: 150, enterpriseEdgeApps: 1, hours: 730 }) },
  { name: 'EUR retail standard app and edge', region: 'westeurope', currency: 'EUR', component: { type: 'static-web-apps', plan: 'standard', apps: 2, bandwidthGB: 101, enterpriseEdgeApps: 1, hours: 100 },
    // Retail API is queried natively in EUR; no FX conversion is performed.
    expected: async () => retailStatic({ region: 'westeurope', currency: 'EUR', plan: 'standard', apps: 2, bandwidthGB: 101, enterpriseEdgeApps: 1, hours: 100 }) },
] };
