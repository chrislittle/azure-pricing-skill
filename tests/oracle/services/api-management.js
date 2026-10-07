'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'api-management';
const HOURS_PER_MONTH = 730;
const API_CENTER_INCLUDED_TIERS = new Set(['standard', 'premium', 'standard-v2', 'premium-v2']);

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calcOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }

async function graduatedCalc(offer, region, qty) {
  const data = await calc.product(SLUG);
  const calcRegion = calc.calcRegion(data, region);
  const table = data.graduatedOffers[offer][calcRegion];
  if (!table) throw new Error(`calculator has no ${offer} graduated prices for ${calcRegion}`);
  let previous = 0;
  let cost = 0;
  const bands = [];
  for (const band of table.prices) {
    const units = Math.max(0, Math.min(qty, band.limit) - previous);
    if (units) {
      cost += units * band.price.value;
      bands.push({ from: previous, to: band.limit === Number.MAX_VALUE ? null : band.limit, units, unitPrice: band.price.value });
    }
    previous = band.limit;
    if (qty <= band.limit) break;
  }
  return { cost, bands };
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

async function retailRows(region, currency) {
  return dedupe(await query(`serviceName eq 'API Management' and armRegionName eq '${region}'`, currency));
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

function apimInstanceCount(tier, units, additionalUnits) {
  return API_CENTER_INCLUDED_TIERS.has(tier) && units > 0 ? 1 : 0;
}

async function addApiCenterLines(lines, { region, tier, units, additionalUnits, apiCenters, apiCenterLinked = true, hours }) {
  if (!apiCenters) return;
  const included = apiCenterLinked ? Math.min(apiCenters, apimInstanceCount(tier, units, additionalUnits)) : 0;
  if (included) lines.push(line(`API Centers included with ${tier}: ${included} linked center(s)`, 0, { sourceOffer: 'api-center-free' }));
  const billable = apiCenters - included;
  if (billable > 0) {
    const p = await calcOffer('api-center-standard', region);
    lines.push(line(`API Center Standard billable: ${billable} * ${hours} hours * ${p}`, billable * hours * p, { sourceOffer: 'api-center-standard' }));
  }
}

async function calculatorApim({ region, tier, units = 1, additionalUnits = 0, callsPerMonth = 0, selfHostedGateways = 0, additionalWorkspaces = 0, workspaceGateways = 0, apiCenters = 0, apiCenterLinked = true, hours = HOURS_PER_MONTH }) {
  const lines = [];
  if (tier === 'consumption') {
    const p = await calcOffer('consumption', region);
    const billable10k = Math.max(0, callsPerMonth / 10000 - 100);
    lines.push(line(`Consumption calls: max(0, ${callsPerMonth}/10K - 100 free units) * ${p}`, billable10k * p, { sourceOffer: 'consumption' }));
  } else if (tier === 'basic' || tier === 'standard' || tier === 'developer') {
    const p = await calcOffer(tier, region);
    lines.push(line(`${tier} units: ${units} * ${hours} hours * ${p}`, units * hours * p, { sourceOffer: tier }));
  } else if (tier === 'premium') {
    const p = await calcOffer('premium', region);
    const secondary = await calcOffer('secondary', region);
    lines.push(line(`Premium primary units: ${units} * ${hours} hours * ${p}`, units * hours * p, { sourceOffer: 'premium' }));
    if (additionalUnits) lines.push(line(`Premium additional/secondary units: ${additionalUnits} * ${hours} hours * ${secondary}`, additionalUnits * hours * secondary, { sourceOffer: 'secondary' }));
    if (selfHostedGateways) {
      const gateway = await calcOffer('gateway', region);
      lines.push(line(`Premium self-hosted gateways: ${selfHostedGateways} * ${hours} hours * ${gateway}`, selfHostedGateways * hours * gateway, { sourceOffer: 'gateway' }));
    }
  } else if (tier === 'basic-v2' || tier === 'standard-v2' || tier === 'premium-v2') {
    const primaryOffer = `${tier}-unit`;
    const primary = await calcOffer(primaryOffer, region);
    lines.push(line(`${tier} primary units: ${units} * ${hours} hours * ${primary}`, units * hours * primary, { sourceOffer: primaryOffer }));
    if (additionalUnits) {
      const secondaryOffer = `${tier}-secondary-unit`;
      const secondary = await calcOffer(secondaryOffer, region);
      lines.push(line(`${tier} secondary units: ${additionalUnits} * ${hours} hours * ${secondary}`, additionalUnits * hours * secondary, { sourceOffer: secondaryOffer }));
    }
    if (tier === 'basic-v2' || tier === 'standard-v2') {
      const g = await graduatedCalc(`${tier}-calls`, region, callsPerMonth / 10000);
      const free = tier === 'basic-v2' ? '10M' : '50M';
      lines.push(line(`${tier} calls: graduated ${callsPerMonth / 10000} * 10K calls (first ${free} included)`, g.cost, { sourceOffer: `${tier}-calls`, bands: g.bands }));
    }
    if ((tier === 'standard-v2' || tier === 'premium-v2') && selfHostedGateways) {
      const offer = 'standard-v2-self-hosting';
      const p = await calcOffer(offer, region);
      lines.push(line(`${tier} self-hosted gateways: ${selfHostedGateways} * ${hours} hours * ${p}`, selfHostedGateways * hours * p, { sourceOffer: offer }));
    }
  }
  if (workspaceGateways) {
    const p = await calcOffer('workspace-gateway-premium', region);
    lines.push(line(`Dedicated workspace gateways: ${workspaceGateways} * ${hours} hours * ${p}`, workspaceGateways * hours * p, { sourceOffer: 'workspace-gateway-premium' }));
  }
  if (additionalWorkspaces) {
    const p = await calcOffer('workspace-gateway-premium-pack', region);
    lines.push(line(`Additional workspace packs: ${additionalWorkspaces} * ${hours} hours * ${p}`, additionalWorkspaces * hours * p, { sourceOffer: 'workspace-gateway-premium-pack' }));
  }
  await addApiCenterLines(lines, { region, tier, units, additionalUnits, apiCenters, apiCenterLinked, hours });
  return { monthlyList: totalOf(lines), lines };
}

async function retailApim({ region, currency = 'EUR', tier, units = 1, additionalUnits = 0, callsPerMonth = 0, selfHostedGateways = 0, workspaceGateways = 0, hours = HOURS_PER_MONTH }) {
  const rows = await retailRows(region, currency);
  const lines = [];
  if (tier === 'consumption') {
    const calls = rows.filter(r => r.skuName === 'Consumption' && r.meterName === 'Consumption Calls');
    const qty = callsPerMonth / unitSize(calls[0].unitOfMeasure);
    lines.push(line(`EUR Consumption calls: graduated ${qty} * 10K calls (first 1M free)`, tiered(calls, qty), { meterId: calls[0].meterId }));
  } else if (tier === 'developer' || tier === 'basic' || tier === 'standard') {
    const sku = tier[0].toUpperCase() + tier.slice(1);
    const m = pickOne(rows, r => r.skuName === sku && r.meterName === `${sku} Unit`, `${sku} Unit`);
    lines.push(line(`EUR ${sku} units: ${units} * ${hours} hours * ${m.retailPrice}`, units * hours * m.retailPrice, { meterId: m.meterId }));
  } else if (tier === 'premium') {
    const primary = pickOne(rows, r => r.skuName === 'Premium' && r.meterName === 'Premium Unit', 'Premium Unit');
    lines.push(line(`EUR Premium units: ${units} * ${hours} hours * ${primary.retailPrice}`, units * hours * primary.retailPrice, { meterId: primary.meterId }));
    if (additionalUnits) {
      const sec = pickOne(rows, r => r.skuName === 'Secondary' && r.meterName === 'Secondary Unit', 'Secondary Unit');
      lines.push(line(`EUR Premium secondary units: ${additionalUnits} * ${hours} hours * ${sec.retailPrice}`, additionalUnits * hours * sec.retailPrice, { meterId: sec.meterId }));
    }
    if (selfHostedGateways) {
      const gw = pickOne(rows, r => r.skuName === 'Gateway' && r.meterName === 'Gateway Unit', 'Gateway Unit');
      lines.push(line(`EUR Premium self-hosted gateways: ${selfHostedGateways} * ${hours} hours * ${gw.retailPrice}`, selfHostedGateways * hours * gw.retailPrice, { meterId: gw.meterId }));
    }
  } else if (tier === 'basic-v2' || tier === 'standard-v2' || tier === 'premium-v2') {
    const sku = tier === 'basic-v2' ? 'Basic v2' : tier === 'standard-v2' ? 'Standard v2' : 'Premium v2';
    const primary = pickOne(rows, r => r.skuName === sku && r.meterName === `${sku} Unit`, `${sku} Unit`);
    lines.push(line(`EUR ${sku} primary units: ${units} * ${hours} hours * ${primary.retailPrice}`, units * hours * primary.retailPrice, { meterId: primary.meterId }));
    if (additionalUnits) {
      const sec = pickOne(rows, r => r.skuName === sku && r.meterName === `${sku} Secondary Unit`, `${sku} Secondary Unit`);
      lines.push(line(`EUR ${sku} secondary units: ${additionalUnits} * ${hours} hours * ${sec.retailPrice}`, additionalUnits * hours * sec.retailPrice, { meterId: sec.meterId }));
    }
    if (tier === 'basic-v2' || tier === 'standard-v2') {
      const calls = rows.filter(r => r.skuName === sku && r.meterName === `${sku} Calls`);
      const qty = callsPerMonth / unitSize(calls[0].unitOfMeasure);
      lines.push(line(`EUR ${sku} calls: graduated ${qty} * 10K calls`, tiered(calls, qty), { meterId: calls[0].meterId }));
    }
    if ((tier === 'standard-v2' || tier === 'premium-v2') && selfHostedGateways) {
      const gw = pickOne(rows, r => r.skuName === sku && r.meterName === `${sku} Self-hosted Gateway`, `${sku} Self-hosted Gateway`);
      lines.push(line(`EUR ${sku} self-hosted gateways: ${selfHostedGateways} * ${hours} hours * ${gw.retailPrice}`, selfHostedGateways * hours * gw.retailPrice, { meterId: gw.meterId }));
    }
  }
  if (workspaceGateways) {
    const gw = pickOne(rows, r => r.skuName === 'Workspace Gateway Premium' && r.meterName === 'Workspace Gateway Premium Unit', 'workspace gateway premium');
    lines.push(line(`EUR workspace gateways: ${workspaceGateways} * ${hours} hours * ${gw.retailPrice}`, workspaceGateways * hours * gw.retailPrice, { meterId: gw.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'api-management',
  source: 'both',
  cases: [
    {
      name: 'consumption at 1M free calls boundary',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'consumption', units: 0, callsPerMonth: 1000000 },
      // Calculator consumption offer is per 10K calls; APIM Consumption includes the first 100 * 10K = 1M calls free.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'consumption', units: 0, callsPerMonth: 1000000 }),
    },
    {
      name: 'consumption just above 1M free calls',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'consumption', units: 0, callsPerMonth: 1010000 },
      // Calculator consumption offer charges only the one 10K-call unit above the 1M free grant.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'consumption', units: 0, callsPerMonth: 1010000 }),
    },
    {
      name: 'unlinked api center standard is billed',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'consumption', units: 0, callsPerMonth: 0, apiCenters: 1 },
      // Calculator api-center-standard is $0.9575/hour in East US 2, so an unlinked API Center costs 730 * 0.9575 = $698.98.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'consumption', units: 0, callsPerMonth: 0, apiCenters: 1 }),
    },
    {
      name: 'developer hourly unit',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'developer', units: 1, hours: 365 },
      // Calculator developer offer bills each Developer unit per hour; Developer is for non-production and has no call overage meter.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'developer', units: 1, hours: 365 }),
    },
    {
      name: 'classic basic hourly units',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'basic', units: 2, hours: 730 },
      // Calculator basic offer bills classic Basic gateway units per hour.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'basic', units: 2, hours: 730 }),
    },
    {
      name: 'classic standard with included api center',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'standard', units: 1, apiCenters: 1, hours: 730 },
      // API Center Standard is free when linked to APIM Standard, one API Center per APIM instance.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'standard', units: 1, apiCenters: 1, hours: 730 }),
    },
    {
      name: 'classic standard unlinked api center is billed',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'standard', units: 1, apiCenters: 1, apiCenterLinked: false, hours: 730 },
      // Public questions expose apiCenterLinked; Learn/API Center integration docs make linking the condition for the included Standard API Center. Unlinked Standard API Center uses api-center-standard: 730 * $0.9575 = $698.98.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'standard', units: 1, apiCenters: 1, apiCenterLinked: false, hours: 730 }),
    },
    {
      name: 'classic standard second api center is billed',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'standard', units: 1, apiCenters: 2, hours: 730 },
      // One API Center is included with the Standard APIM instance; the second is billed at 730 * $0.9575 = $698.98.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'standard', units: 1, apiCenters: 2, hours: 730 }),
    },
    {
      name: 'classic premium primary secondary self-hosted and workspaces',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'premium', units: 1, additionalUnits: 1, selfHostedGateways: 1, workspaceGateways: 1, additionalWorkspaces: 1, apiCenters: 2, hours: 730 },
      // Calculator Premium bills primary, secondary, classic self-hosted Gateway, workspace gateways/packs; one API Center is included with the Premium APIM instance and the second API Center is billed.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'premium', units: 1, additionalUnits: 1, selfHostedGateways: 1, workspaceGateways: 1, additionalWorkspaces: 1, apiCenters: 2, hours: 730 }),
    },
    {
      name: 'basic v2 at 10M included calls',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'basic-v2', units: 1, additionalUnits: 1, callsPerMonth: 10000000, hours: 730 },
      // Calculator Basic v2 bills primary/secondary units and graduated calls with first 1,000 * 10K = 10M included.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'basic-v2', units: 1, additionalUnits: 1, callsPerMonth: 10000000, hours: 730 }),
    },
    {
      name: 'standard v2 included api centers and self-hosted gateway',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'standard-v2', units: 1, additionalUnits: 1, callsPerMonth: 50010000, selfHostedGateways: 1, apiCenters: 2, hours: 730 },
      // Standard v2 includes one API Center per APIM instance; the second API Center is billed and overage calls start after 50M and self-hosted gateways bill hourly.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'standard-v2', units: 1, additionalUnits: 1, callsPerMonth: 50010000, selfHostedGateways: 1, apiCenters: 2, hours: 730 }),
    },
    {
      name: 'premium v2 primary secondary self-hosted workspace and api center',
      region: 'eastus2', currency: 'USD',
      component: { type: 'api-management', tier: 'premium-v2', units: 1, additionalUnits: 1, selfHostedGateways: 1, workspaceGateways: 1, apiCenters: 2, hours: 730 },
      // Premium v2 includes one API Center per APIM instance, bills the second API Center, and bills primary/secondary unit-hours, self-hosted gateway hours, and dedicated workspace gateway hours.
      expected: async () => calculatorApim({ region: 'eastus2', tier: 'premium-v2', units: 1, additionalUnits: 1, selfHostedGateways: 1, workspaceGateways: 1, apiCenters: 2, hours: 730 }),
    },
    {
      name: 'non-US brazil south standard v2 regional prices',
      region: 'brazilsouth', currency: 'USD',
      component: { type: 'api-management', tier: 'standard-v2', units: 1, additionalUnits: 1, callsPerMonth: 60000000, selfHostedGateways: 1, hours: 730 },
      // Calculator Brazil South Standard v2 unit, secondary unit, self-hosting, and overage-call offers differ from East US 2.
      expected: async () => calculatorApim({ region: 'brazilsouth', tier: 'standard-v2', units: 1, additionalUnits: 1, callsPerMonth: 60000000, selfHostedGateways: 1, hours: 730 }),
    },
    {
      name: 'EUR retail API consumption above free calls',
      region: 'westeurope', currency: 'EUR',
      component: { type: 'api-management', tier: 'consumption', units: 0, callsPerMonth: 1010000 },
      // Retail API EUR Consumption Calls rows have tierMinimumUnits=100 in 10K-call units, which is the 1M free grant.
      expected: async () => retailApim({ region: 'westeurope', currency: 'EUR', tier: 'consumption', units: 0, callsPerMonth: 1010000 }),
    },
    {
      name: 'EUR retail API classic premium with gateway',
      region: 'westeurope', currency: 'EUR',
      component: { type: 'api-management', tier: 'premium', units: 1, additionalUnits: 1, selfHostedGateways: 1, hours: 730 },
      // Retail API EUR non-Consumption rows expose Premium Unit, Secondary Unit, and classic Gateway Unit hourly meters.
      expected: async () => retailApim({ region: 'westeurope', currency: 'EUR', tier: 'premium', units: 1, additionalUnits: 1, selfHostedGateways: 1, hours: 730 }),
    },
    {
      name: 'EUR retail API standard v2 non-consumption',
      region: 'westeurope', currency: 'EUR',
      component: { type: 'api-management', tier: 'standard-v2', units: 1, additionalUnits: 1, callsPerMonth: 60000000, selfHostedGateways: 1, hours: 730 },
      // Retail API EUR Standard v2 rows expose primary/secondary unit-hours, graduated calls, and Self-hosted Gateway hourly meters.
      expected: async () => retailApim({ region: 'westeurope', currency: 'EUR', tier: 'standard-v2', units: 1, additionalUnits: 1, callsPerMonth: 60000000, selfHostedGateways: 1, hours: 730 }),
    },
  ],
};