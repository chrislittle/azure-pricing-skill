'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730;
const SLUG = 'firewall-manager';
const FIREWALL_SLUG = 'azure-firewall';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function offer(name, region) { return (await calc.offerPrice(SLUG, name, region)).value; }
async function firewallOffer(name, region) { return (await calc.offerPrice(FIREWALL_SLUG, name, region)).value; }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one row for ${what}, found ${hits.length}`); return hits[0]; }
async function rows(region, currency, serviceName) { return dedupe(await query(`serviceName eq '${serviceName}' and armRegionName eq '${region}'`, currency)); }
const HUB = {
  basic: { deploy: 'azure-firewall-secured-virtual-hub-deployment-basic', data: 'azure-firewall-secured-virtual-hub-data-processing-basic', sku: 'Basic Secured Virtual Hub' },
  standard: { deploy: 'secured-virtual-hub-deployment', data: 'secured-virtual-hub-data-processing', capacity: 'secured-virtual-hub-capacity-standard', sku: 'Standard Secure Virtual Hub' },
  premium: { deploy: 'azure-firewall-secured-virtual-hub-deployment', data: 'azure-firewall-secured-virtual-hub-data-processing', capacity: 'secured-virtual-hub-capacity-premium', sku: 'Premium Secured Virtual Hub' },
};
async function fwManager(o) {
  const region = o.region, currency = o.currency || 'USD', hours = o.hours ?? HOURS, lines = [];
  async function price(kind, tier) {
    if (currency === 'USD') {
      if (kind === 'policy') return { price: await offer('policies-per-region', region), sourceOffer: 'policies-per-region' };
      if (kind === 'analytics') return { price: await offer('azure-firewall-manager-policy-analytics', region), sourceOffer: 'azure-firewall-manager-policy-analytics' };
      if (kind === 'third') return { price: await offer('secure-virtual-hub-third-party-integration-deployment', region), sourceOffer: 'secure-virtual-hub-third-party-integration-deployment' };
      if (kind === 'capacity') return { price: await firewallOffer(HUB[tier].capacity, region), sourceOffer: `azure-firewall/${HUB[tier].capacity}` };
      return { price: await offer(HUB[tier][kind], region), sourceOffer: HUB[tier][kind] };
    }
    if (kind === 'policy' || kind === 'analytics' || kind === 'third') {
      const fm = await rows(region, currency, 'Azure Firewall Manager');
      const row = pick(fm, r => kind === 'policy' ? r.meterName.includes('Policy per Region') : kind === 'analytics' ? r.meterName.includes('Policy analytics') : r.meterName.includes('3rd Party'), kind);
      return { price: row.retailPrice, meterId: row.meterId };
    }
    const fw = await rows(region, currency, 'Azure Firewall');
    const row = pick(fw, r => r.skuName === HUB[tier].sku && r.meterName.includes(kind === 'deploy' ? 'Deployment' : kind === 'capacity' ? 'Capacity Unit' : 'Data Processed'), `${tier} secured hub ${kind}`);
    return { price: row.retailPrice, meterId: row.meterId };
  }
  if ((o.policies || 0) > 0 && (o.firewallsPerPolicy ?? 2) >= 2) { const p = await price('policy'); lines.push(line(`Policies shared by >=2 firewalls: ${o.policies} * ${o.regions ?? 1} * ${p.price}`, o.policies * (o.regions ?? 1) * p.price, p)); }
  if ((o.childPolicies || 0) > 0 && (o.childFirewalls ?? 1) >= 2) { const p = await price('policy'); lines.push(line(`Child policies billed with parent: ${o.childPolicies} * ${o.childRegions ?? 1} regions * 2 * ${p.price}`, o.childPolicies * (o.childRegions ?? 1) * 2 * p.price, p)); }
  if (o.policyAnalytics) { const p = await price('analytics'); const h = o.analyticsHours ?? hours; lines.push(line(`Policy Analytics: ${o.policyAnalytics} * ${h} h * ${p.price}`, o.policyAnalytics * h * p.price, p)); }
  if (o.thirdPartyHubs) { const p = await price('third'); const h = o.thirdPartyHours ?? hours; lines.push(line(`Third-party secured hubs: ${o.thirdPartyHubs} * ${h} h * ${p.price}`, o.thirdPartyHubs * h * p.price, p)); }
  const tier = o.securedHubFirewallTier;
  if (tier && tier !== 'none' && (o.securedHubs || 0) > 0) {
    const h = o.securedHubHours ?? hours;
    const d = await price('deploy', tier); lines.push(line(`${tier} secured hub deployment: ${o.securedHubs} * ${h} h * ${d.price}`, o.securedHubs * h * d.price, d));
    if (o.securedHubDataGB) { const gb = await price('data', tier); lines.push(line(`${tier} secured hub data: ${o.securedHubDataGB} GB * ${gb.price}`, o.securedHubDataGB * gb.price, gb)); }
    if (o.securedHubCapacityUnits && tier !== 'basic') { const cap = await price('capacity', tier); lines.push(line(`${tier} secured hub capacity: ${o.securedHubCapacityUnits} CU * ${h} h * ${cap.price}`, o.securedHubCapacityUnits * h * cap.price, cap)); }
  }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'firewall-manager', source: 'both', cases: [
  { name: 'all-free single-firewall policies', region: 'eastus2', currency: 'USD', component: { type: 'firewall-manager', policies: 3, firewallsPerPolicy: 1, regions: 1, childPolicies: 2, childFirewalls: 1, childRegions: 1 },
    // Policies and child policies used by only one firewall are free; with no add-ons this all-free case returns $0.
    expected: () => fwManager({ region: 'eastus2', policies: 3, firewallsPerPolicy: 1, regions: 1, childPolicies: 2, childFirewalls: 1, childRegions: 1 }) },
  { name: 'shared policies and billed child policies', region: 'eastus2', currency: 'USD', component: { type: 'firewall-manager', policies: 1, firewallsPerPolicy: 2, regions: 2, childPolicies: 3, childFirewalls: 2, childRegions: 2 },
    // Each billed child policy is charged twice per region: once for the child and once for its parent.
    expected: () => fwManager({ region: 'eastus2', policies: 1, firewallsPerPolicy: 2, regions: 2, childPolicies: 3, childFirewalls: 2, childRegions: 2 }) },
  { name: 'separate analytics and third-party hours', region: 'eastus2', currency: 'USD', component: { type: 'firewall-manager', policies: 0, policyAnalytics: 2, analyticsHours: 100, thirdPartyHubs: 1, thirdPartyHours: 50 },
    // Policy Analytics and third-party secured hub integration each use their own hourly quantity.
    expected: () => fwManager({ region: 'eastus2', policies: 0, policyAnalytics: 2, analyticsHours: 100, thirdPartyHubs: 1, thirdPartyHours: 50 }) },
  { name: 'basic secured hub firewall', region: 'eastus2', currency: 'USD', component: { type: 'firewall-manager', policies: 0, securedHubFirewallTier: 'basic', securedHubs: 1, securedHubDataGB: 500, securedHubHours: 100 },
    // Basic secured hub uses Firewall Manager basic secured hub deployment/hour and data/GB offers with securedHubHours.
    expected: () => fwManager({ region: 'eastus2', policies: 0, securedHubFirewallTier: 'basic', securedHubs: 1, securedHubDataGB: 500, securedHubHours: 100 }) },
  { name: 'standard secured hub capacity non-US', region: 'westeurope', currency: 'USD', component: { type: 'firewall-manager', policies: 0, securedHubFirewallTier: 'standard', securedHubs: 2, securedHubDataGB: 1000, securedHubCapacityUnits: 3, securedHubHours: 365 },
    // Standard secured hub deployment/data use Firewall Manager calculator offers; capacity uses Azure Firewall secured-hub capacity-unit offer.
    expected: () => fwManager({ region: 'westeurope', policies: 0, securedHubFirewallTier: 'standard', securedHubs: 2, securedHubDataGB: 1000, securedHubCapacityUnits: 3, securedHubHours: 365 }) },
  { name: 'EUR premium secured hub with capacity', region: 'westeurope', currency: 'EUR', component: { type: 'firewall-manager', policies: 1, firewallsPerPolicy: 2, regions: 1, childPolicies: 1, childFirewalls: 2, childRegions: 1, securedHubFirewallTier: 'premium', securedHubs: 1, securedHubDataGB: 100, securedHubCapacityUnits: 1, securedHubHours: 24, policyAnalytics: 1, analyticsHours: 24 },
    // Retail API EUR rows combine Firewall Manager policy/analytics with Azure Firewall Premium Secured Virtual Hub deployment, data, and capacity meters.
    expected: () => fwManager({ region: 'westeurope', currency: 'EUR', policies: 1, firewallsPerPolicy: 2, regions: 1, childPolicies: 1, childFirewalls: 2, childRegions: 1, securedHubFirewallTier: 'premium', securedHubs: 1, securedHubDataGB: 100, securedHubCapacityUnits: 1, securedHubHours: 24, policyAnalytics: 1, analyticsHours: 24 }) },
] };

