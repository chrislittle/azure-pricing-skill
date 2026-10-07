'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'virtual-wan';
const HOURS = 730;
const FIREWALL_DEPLOY = { basic: 'secured-virtual-hubs-deployment-basic', standard: 'secured-virtual-hubs-deployment', premium: 'secured-virtual-hubs-deployment-premium' };
const FIREWALL_DATA = { basic: 'secured-virtual-hubs-process-basic', standard: 'secured-virtual-hubs-data-processed', premium: 'secured-virtual-hubs-data-processed-premium' };
const FIREWALL_CAPACITY_METER = { standard: 'Standard Secure Virtual Hub Capacity Unit', premium: 'Premium Secured Virtual Hub Capacity Unit' };
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, amount, extra = {}) { return { desc, monthlyList: round2(amount), ...extra }; }
async function rate(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }
async function firewallCapacityRate(region, tier, currency = 'USD') {
  const rows = dedupe(await query(`serviceName eq 'Azure Firewall' and armRegionName eq '${region}'`, currency));
  const meterName = FIREWALL_CAPACITY_METER[tier];
  const hit = rows.find(r => r.meterName === meterName);
  if (!hit) throw new Error(`Azure Firewall capacity Retail API row not found: ${tier} ${region} ${currency}`);
  return hit;
}
async function calculatorVirtualWan(opts) {
  const { region, currency = 'USD', wanType = 'standard', hubs = 1, thirdPartyIntegrations = false, dataProcessedGB = 0, extraRoutingUnits = 0, s2sScaleUnits = 0, s2sConnectionUnits = 0, p2sScaleUnits = 0, p2sConnectionUnits = 0, erScaleUnits = 0, erConnectionUnits = 0, nvaInfraUnits = 0, nvaDataGB = 0, firewallTier = 'none', firewallDataGB = 0, firewallCapacityUnits = 0, s2sHours, p2sHours, erHours, hours = HOURS } = opts;
  const lines = [];
  const sh = s2sHours ?? hours, ph = p2sHours ?? hours, eh = erHours ?? hours;
  if (wanType !== 'basic') {
    const hubOffer = thirdPartyIntegrations ? 'standard-hub-third-party-integrations' : 'standard-hub-deployment';
    const hubRate = await rate(hubOffer, region);
    lines.push(line(`${hubs} hubs * ${hours} hours * ${hubRate}`, hubs * hours * hubRate, { sourceOffer: hubOffer }));
    if (dataProcessedGB) { const offer = thirdPartyIntegrations ? 'standard-hub-data-processing' : 'standard-hub-data-processed'; const r = await rate(offer, region); lines.push(line(`${thirdPartyIntegrations ? 'Third-party' : 'Standard'} hub data processed: ${dataProcessedGB} GB * ${r}`, dataProcessedGB * r, { sourceOffer: offer })); }
    if (extraRoutingUnits) { const r = await rate('routing-infra-unit', region); lines.push(line(`Extra routing units: ${hubs} hubs * ${extraRoutingUnits} units * ${hours} hours * ${r}`, hubs * extraRoutingUnits * hours * r, { sourceOffer: 'routing-infra-unit' })); }
  }
  async function hourly(field, qty, offer, h) { if (qty) { const r = await rate(offer, region); lines.push(line(`${field}: ${hubs} hubs * ${qty} units * ${h} hours * ${r}`, hubs * qty * h * r, { sourceOffer: offer })); } }
  await hourly('S2S scale units', s2sScaleUnits, 's2s-scale-unit', sh);
  await hourly('S2S connection units', s2sConnectionUnits, 's2s-connection-unit', sh);
  if (wanType !== 'basic') {
    await hourly('P2S scale units', p2sScaleUnits, 'p2s-scale-unit', ph);
    await hourly('P2S connection units', p2sConnectionUnits, 'p2s-connection-unit', ph);
    if (erScaleUnits) { const firstFive = Math.min(erScaleUnits, 5); const additional = Math.max(0, erScaleUnits - 5); const firstRate = await rate('expressroute-scale-unit', region); lines.push(line(`ExpressRoute first-five scale units: ${hubs} hubs * ${firstFive} units * ${eh} hours * ${firstRate}`, hubs * firstFive * eh * firstRate, { sourceOffer: 'expressroute-scale-unit' })); if (additional) { const addRate = await rate('expressroute-additional-scale-unit', region); lines.push(line(`ExpressRoute additional scale units: ${hubs} hubs * ${additional} units * ${eh} hours * ${addRate}`, hubs * additional * eh * addRate, { sourceOffer: 'expressroute-additional-scale-unit' })); } }
    await hourly('ExpressRoute connection units', erConnectionUnits, 'expressroute-connection-unit', eh);
    await hourly('NVA infrastructure units', nvaInfraUnits, 'nva-infra-unit', hours);
    if (nvaDataGB) { const r = await rate('firewall-nva-data-processing', region); lines.push(line(`NVA data processing: ${nvaDataGB} GB * ${r}`, nvaDataGB * r, { sourceOffer: 'firewall-nva-data-processing' })); }
    if (firewallTier !== 'none') { const dr = await rate(FIREWALL_DEPLOY[firewallTier], region); const pr = await rate(FIREWALL_DATA[firewallTier], region); lines.push(line(`Secured hub ${firewallTier}: ${hubs} hubs * ${hours} hours * ${dr}`, hubs * hours * dr, { sourceOffer: FIREWALL_DEPLOY[firewallTier] })); lines.push(line(`Secured hub ${firewallTier} data: ${firewallDataGB} GB * ${pr}`, firewallDataGB * pr, { sourceOffer: FIREWALL_DATA[firewallTier] })); if (firewallCapacityUnits && FIREWALL_CAPACITY_METER[firewallTier]) { const cap = await firewallCapacityRate(region, firewallTier, currency); lines.push(line(`Secured hub ${firewallTier} capacity: ${hubs} hubs * ${firewallCapacityUnits} units * ${hours} hours * ${cap.retailPrice}`, hubs * firewallCapacityUnits * hours * cap.retailPrice, { meterId: cap.meterId })); } }
  }
  return { monthlyList: totalOf(lines), lines };
}
async function retailVirtualWanEur() {
  const rows = dedupe(await query(`serviceName eq 'Virtual WAN' and armRegionName eq 'eastus2'`, 'EUR'));
  const pick = (m) => { const hit = rows.find(r => r.meterName === m); if (!hit) throw new Error(`Virtual WAN EUR row not found: ${m}`); return hit; };
  const hub = pick('Standard Hub with Firewall policies for Third party security provider(s) Unit'), data = pick('Standard Hub with Firewall policies for Third party security provider(s) Data Processed'), s2s = pick('VPN S2S Scale Unit'), p2s = pick('VPN P2S Connection Unit'), er = pick('ExpressRoute Scale Unit'), erAdd = pick('ExpressRoute Additional Scale Unit');
  const fwRows = dedupe(await query(`serviceName eq 'Azure Firewall' and armRegionName eq 'eastus2'`, 'EUR'));
  const fwDeploy = fwRows.find(r => r.meterName === 'Standard Secure Virtual Hub Deployment');
  const fw = fwRows.find(r => r.meterName === 'Standard Secure Virtual Hub Capacity Unit');
  if (!fwDeploy) throw new Error('Azure Firewall EUR deployment row not found: Standard Secure Virtual Hub Deployment');
  if (!fw) throw new Error('Azure Firewall EUR capacity row not found: Standard Secure Virtual Hub Capacity Unit');
  const lines = [
    line(`Retail API third-party Standard Hub: 1 hub * 100 hours * ${hub.retailPrice}`, 100 * hub.retailPrice, { meterId: hub.meterId }),
    line(`Retail API third-party hub data: 1000 GB * ${data.retailPrice}`, 1000 * data.retailPrice, { meterId: data.meterId }),
    line(`Retail API S2S scale: 2 units * 80 hours * ${s2s.retailPrice}`, 2 * 80 * s2s.retailPrice, { meterId: s2s.meterId }),
    line(`Retail API P2S connections: 50 units * 60 hours * ${p2s.retailPrice}`, 50 * 60 * p2s.retailPrice, { meterId: p2s.meterId }),
    line(`Retail API ER first-five scale units: 5 units * 40 hours * ${er.retailPrice}`, 5 * 40 * er.retailPrice, { meterId: er.meterId }),
    line(`Retail API ER additional scale units: 1 unit * 40 hours * ${erAdd.retailPrice}`, 1 * 40 * erAdd.retailPrice, { meterId: erAdd.meterId }),
    line(`Retail API Standard Secure Virtual Hub deployment: 1 hub * 100 hours * ${fwDeploy.retailPrice}`, 100 * fwDeploy.retailPrice, { meterId: fwDeploy.meterId }),
    line(`Retail API Firewall capacity: 2 units * 100 hours * ${fw.retailPrice}`, 2 * 100 * fw.retailPrice, { meterId: fw.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'virtual-wan', source: 'both', cases: [
  { name: 'basic virtual wan s2s only no hub fee', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', wanType: 'basic', hubs: 2, s2sScaleUnits: 2, s2sConnectionUnits: 3, hours: 100 },
    // Basic Virtual WAN has no standard hub deployment or data processing fee; only S2S scale and connection unit-hours are billed.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', wanType: 'basic', hubs: 2, s2sScaleUnits: 2, s2sConnectionUnits: 3, hours: 100 }) },
  { name: 'standard hub data and routing units', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 2, dataProcessedGB: 1000, extraRoutingUnits: 1 },
    // Calculator standard-hub-deployment is hourly per hub; data is per GB; routing-infra-unit is hourly beyond included capacity.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', hubs: 2, dataProcessedGB: 1000, extraRoutingUnits: 1 }) },
  { name: 'third party integration hub', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 1, thirdPartyIntegrations: true, dataProcessedGB: 500 },
    // Calculator standard-hub-third-party-integrations replaces the standard hub hourly rate; data uses the third-party hub data-processing offer.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', hubs: 1, thirdPartyIntegrations: true, dataProcessedGB: 500 }) },
  { name: 's2s and p2s scale and connection units', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 1, s2sScaleUnits: 2, s2sConnectionUnits: 3, p2sScaleUnits: 2, p2sConnectionUnits: 50 },
    // Calculator VPN scale-unit and connection-unit offers are hourly, multiplied by hubs and requested units.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', hubs: 1, s2sScaleUnits: 2, s2sConnectionUnits: 3, p2sScaleUnits: 2, p2sConnectionUnits: 50 }) },
  { name: 'separate s2s p2s er gateway hours', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 1, s2sScaleUnits: 2, s2sConnectionUnits: 3, p2sScaleUnits: 2, p2sConnectionUnits: 50, erScaleUnits: 2, erConnectionUnits: 1, hours: 100, s2sHours: 80, p2sHours: 60, erHours: 40 },
    // S2S, P2S, and ExpressRoute unit meters use their own override hours when s2sHours, p2sHours, and erHours are provided.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', hubs: 1, s2sScaleUnits: 2, s2sConnectionUnits: 3, p2sScaleUnits: 2, p2sConnectionUnits: 50, erScaleUnits: 2, erConnectionUnits: 1, hours: 100, s2sHours: 80, p2sHours: 60, erHours: 40 }) },
  { name: 'expressroute scale unit boundary', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 1, erScaleUnits: 6, erConnectionUnits: 2, hours: 100 },
    // Calculator prices first 5 ER scale units with expressroute-scale-unit and further units with expressroute-additional-scale-unit.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', hubs: 1, erScaleUnits: 6, erConnectionUnits: 2, hours: 100 }) },
  { name: 'nva infrastructure and data processing', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 2, nvaInfraUnits: 2, nvaDataGB: 1234 },
    // Calculator nva-infra-unit is hourly per hub and firewall-nva-data-processing is per GB.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', hubs: 2, nvaInfraUnits: 2, nvaDataGB: 1234 }) },
  ...['basic', 'standard', 'premium'].map(firewallTier => ({ name: `secured hub ${firewallTier}${firewallTier === 'standard' ? ' non-us' : ''}`, region: firewallTier === 'standard' ? 'westeurope' : 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 1, firewallTier, firewallDataGB: 100 },
    // Calculator secured hub deployment is hourly and the matching secured data-processing offer is per GB.
    expected: async () => calculatorVirtualWan({ region: firewallTier === 'standard' ? 'westeurope' : 'eastus2', hubs: 1, firewallTier, firewallDataGB: 100 }) })),
  { name: 'secured hub standard firewall capacity units', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 1, firewallTier: 'standard', firewallDataGB: 100, firewallCapacityUnits: 2, hours: 100 },
    // Calculator secured hub standard deployment/data come from calculator offers; Standard Secure Virtual Hub Capacity Unit comes from Azure Firewall Retail API.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', hubs: 1, firewallTier: 'standard', firewallDataGB: 100, firewallCapacityUnits: 2, hours: 100 }) },
  { name: 'secured hub premium firewall capacity units', region: 'eastus2', currency: 'USD', component: { type: 'virtual-wan', hubs: 1, firewallTier: 'premium', firewallDataGB: 100, firewallCapacityUnits: 2, hours: 100 },
    // Premium secured virtual hub capacity units use the Azure Firewall Premium Secured Virtual Hub Capacity Unit Retail API meter.
    expected: async () => calculatorVirtualWan({ region: 'eastus2', hubs: 1, firewallTier: 'premium', firewallDataGB: 100, firewallCapacityUnits: 2, hours: 100 }) },
  { name: 'eur retail broad third-party hours capacity', region: 'eastus2', currency: 'EUR', component: { type: 'virtual-wan', hubs: 1, thirdPartyIntegrations: true, dataProcessedGB: 1000, s2sScaleUnits: 2, p2sConnectionUnits: 50, erScaleUnits: 6, firewallTier: 'standard', firewallCapacityUnits: 2, hours: 100, s2sHours: 80, p2sHours: 60, erHours: 40 },
    // Retail API EUR rows: third-party hub unit/data, separate VPN/ER hours, ER first-five/additional boundary, and Standard firewall capacity.
    expected: async () => retailVirtualWanEur() },
] };
