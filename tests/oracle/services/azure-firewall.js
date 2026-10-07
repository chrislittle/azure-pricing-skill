'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730;
const SLUG = 'azure-firewall';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
const OFFERS = {
  basic: { vnetDeploy: 'firewall-deployment-basic', vnetData: 'data-transfer-basic', hubDeploy: 'basic-secured-virtual-hub-deploy', hubData: 'basic-secured-virtual-hub-process' },
  standard: { vnetDeploy: 'firewall-deployment-standard', vnetData: 'data-transfer-standard', vnetCapacity: 'capacity-unit-standard', hubDeploy: 'secured-virtual-hub-deploy-standard', hubData: 'secured-virtual-hub-process-standard', hubCapacity: 'secured-virtual-hub-capacity-standard' },
  premium: { vnetDeploy: 'firewall-deployment-premium', vnetData: 'data-transfer-premium', vnetCapacity: 'capacity-unit-premium', hubDeploy: 'secured-virtual-hub-deploy-premium', hubData: 'secured-virtual-hub-process-premium', hubCapacity: 'secured-virtual-hub-capacity-premium' },
};
async function offer(offerName, region) { return (await calc.offerPrice(SLUG, offerName, region)).value; }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`); return hits[0]; }
async function retailRows(region, currency) { return dedupe(await query(`serviceName eq 'Azure Firewall' and armRegionName eq '${region}'`, currency)); }
async function retailPrice(region, currency, tier, secured, kind) {
  const rows = await retailRows(region, currency);
  const sku = { basic: secured ? 'Basic Secured Virtual Hub' : 'Basic', standard: secured ? 'Standard Secure Virtual Hub' : 'Standard', premium: secured ? 'Premium Secured Virtual Hub' : 'Premium' }[tier];
  const phrase = kind === 'deploy' ? 'Deployment' : kind === 'data' ? 'Data Processed' : 'Capacity Unit';
  return pick(rows, r => r.skuName === sku && r.meterName.includes(phrase), `${sku} ${phrase}`);
}
async function azureFirewall(o) {
  const tier = o.tier || 'standard', map = OFFERS[tier], secured = !!o.securedVirtualHub, hours = o.hours ?? HOURS, lines = [];
  async function unit(kind) {
    if ((o.currency || 'USD') === 'USD') { const offerName = secured ? map[`hub${kind}`] : map[`vnet${kind}`]; return { price: await offer(offerName, o.region), sourceOffer: offerName }; }
    const row = await retailPrice(o.region, o.currency, tier, secured, kind.toLowerCase()); return { price: row.retailPrice, meterId: row.meterId };
  }
  const deploy = await unit('Deploy');
  lines.push(line(`${tier}${secured ? ' secured hub' : ' VNet'} deployment: ${o.firewalls} * ${hours} h * ${deploy.price}`, o.firewalls * hours * deploy.price, deploy));
  if (o.dataGB) { const data = await unit('Data'); lines.push(line(`${tier}${secured ? ' secured hub' : ' VNet'} data: ${o.dataGB} GB * ${data.price}`, o.dataGB * data.price, data)); }
  if (o.minCapacity && tier !== 'basic') {
    const billableCapacityUnits = Math.max(0, o.minCapacity - 2) * o.firewalls;
    if (billableCapacityUnits) {
      const cap = await unit('Capacity');
      lines.push(line(`${tier}${secured ? ' secured hub' : ' VNet'} capacity: (${o.minCapacity} min - 2 included) * ${o.firewalls} firewalls * ${o.capacityHours ?? HOURS} h * ${cap.price}`, billableCapacityUnits * (o.capacityHours ?? HOURS) * cap.price, cap));
    }
  }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'azure-firewall', source: 'both', cases: [
  { name: 'basic VNet deployment and data', region: 'eastus2', currency: 'USD', component: { type: 'azure-firewall', tier: 'basic', firewalls: 1, dataGB: 200 },
    // Calculator Basic VNet uses Basic Deployment per firewall-hour plus Basic Data Processed per GB.
    expected: () => azureFirewall({ region: 'eastus2', tier: 'basic', firewalls: 1, dataGB: 200 }) },
  { name: 'standard VNet full month with data', region: 'eastus2', currency: 'USD', component: { type: 'azure-firewall', tier: 'standard', firewalls: 1, dataGB: 1000 },
    // Calculator Standard VNet deployment is hourly; Standard Data Processed is per GB.
    expected: () => azureFirewall({ region: 'eastus2', tier: 'standard', firewalls: 1, dataGB: 1000 }) },
  { name: 'standard min capacity default boundary', region: 'eastus2', currency: 'USD', component: { type: 'azure-firewall', tier: 'standard', firewalls: 1, minCapacity: 2, capacityHours: 730 },
    // Two default instances per firewall are included; minCapacity 2 has no prescale capacity charge.
    expected: () => azureFirewall({ region: 'eastus2', tier: 'standard', firewalls: 1, minCapacity: 2, capacityHours: 730 }) },
  { name: 'standard min capacity four', region: 'eastus2', currency: 'USD', component: { type: 'azure-firewall', tier: 'standard', firewalls: 1, minCapacity: 4, capacityHours: 730 },
    // Billable prescale units are (minCapacity - 2) * firewalls, so min 4 bills 2 * 730 * Standard Capacity Unit.
    expected: () => azureFirewall({ region: 'eastus2', tier: 'standard', firewalls: 1, minCapacity: 4, capacityHours: 730 }) },
  { name: 'standard min capacity multiple firewalls part time', region: 'eastus2', currency: 'USD', component: { type: 'azure-firewall', tier: 'standard', firewalls: 2, minCapacity: 4, capacityHours: 365 },
    // Capacity is per firewall: (4 - 2) * 2 firewalls * 365 hours.
    expected: () => azureFirewall({ region: 'eastus2', tier: 'standard', firewalls: 2, minCapacity: 4, capacityHours: 365 }) },
  { name: 'basic secured virtual hub part time', region: 'eastus2', currency: 'USD', component: { type: 'azure-firewall', tier: 'basic', securedVirtualHub: true, firewalls: 2, dataGB: 200, hours: 100 },
    // Calculator Basic secured hub uses Basic Secured Virtual Hub deploy hours plus process GB; Basic has no prescaling.
    expected: () => azureFirewall({ region: 'eastus2', tier: 'basic', securedVirtualHub: true, firewalls: 2, dataGB: 200, hours: 100 }) },
  { name: 'premium VNet min capacity above included', region: 'eastus2', currency: 'USD', component: { type: 'azure-firewall', tier: 'premium', firewalls: 1, dataGB: 500, minCapacity: 4, capacityHours: 365 },
    // Premium VNet prescale bills only units above the two default instances, plus deployment and data.
    expected: () => azureFirewall({ region: 'eastus2', tier: 'premium', firewalls: 1, dataGB: 500, minCapacity: 4, capacityHours: 365 }) },
  { name: 'premium secured virtual hub capacity boundary', region: 'westeurope', currency: 'USD', component: { type: 'azure-firewall', tier: 'premium', securedVirtualHub: true, firewalls: 1, dataGB: 750, minCapacity: 2 },
    // Secured hub prescale also excludes the two included default instances, so minCapacity 2 has no capacity charge.
    expected: () => azureFirewall({ region: 'westeurope', tier: 'premium', securedVirtualHub: true, firewalls: 1, dataGB: 750, minCapacity: 2 }) },
  { name: 'US Gov basic VNet deployment and data', region: 'usgovvirginia', currency: 'USD', component: { type: 'azure-firewall', tier: 'basic', firewalls: 1, dataGB: 100 },
    // US Gov Virginia Basic VNet uses region-specific Basic Deployment and Basic Data Processed calculator offers.
    expected: () => azureFirewall({ region: 'usgovvirginia', tier: 'basic', firewalls: 1, dataGB: 100 }) },
  { name: 'EUR standard secured virtual hub above capacity boundary', region: 'westeurope', currency: 'EUR', component: { type: 'azure-firewall', tier: 'standard', securedVirtualHub: true, firewalls: 1, dataGB: 100, minCapacity: 4, capacityHours: 100 },
    // Retail API EUR rows: deployment/hour, data/GB, and two billable capacity units above the two included instances.
    expected: () => azureFirewall({ region: 'westeurope', currency: 'EUR', tier: 'standard', securedVirtualHub: true, firewalls: 1, dataGB: 100, minCapacity: 4, capacityHours: 100 }) },
] };

