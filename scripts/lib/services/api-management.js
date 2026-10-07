'use strict';
// Azure API Management: Consumption, Developer, Basic, Standard, Premium (classic) and Basic v2, Standard v2, Premium v2.
// Also covers additional (secondary / scale-out) units, self-hosted gateways, workspaces and workspace gateways, and API Center.
// Meters: serviceName 'API Management' (and 'Azure API Center'), regional.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const hrs = c => c.hours ?? HOURS;

// Retail meter names per tier. calls: per-call billing (10K calls); free: billed per call allowance is a free first band.
const API_CENTER_FREE_TIERS = ['standard', 'standard-v2', 'premium', 'premium-v2']; // Learn: Tutorial - Create or link an API Center to API Management
const T = {
  consumption: { name: 'Consumption', calls: 'Consumption Calls' },
  developer: { name: 'Developer', unit: 'Developer Unit', pack: 'Developer Workspace Pack', gatewayFree: true },
  basic: { name: 'Basic', unit: 'Basic Unit' },
  standard: { name: 'Standard', unit: 'Standard Unit', pack: 'Standard Workspace Pack' },
  premium: { name: 'Premium', unit: 'Premium Unit', secondary: 'Secondary Unit', gateway: 'Gateway Unit', pack: 'Premium Workspace Pack', wsGateway: 'Workspace Gateway Premium Unit' },
  'basic-v2': { name: 'Basic v2', unit: 'Basic v2 Unit', secondary: 'Basic v2 Secondary Unit', calls: 'Basic v2 Calls' },
  'standard-v2': { name: 'Standard v2', unit: 'Standard v2 Unit', secondary: 'Standard v2 Secondary Unit', calls: 'Standard v2 Calls', gateway: 'Standard v2 Self-hosted Gateway', pack: 'Standard v2 Workspace Pack' },
  'premium-v2': { name: 'Premium v2', unit: 'Premium v2 Unit', secondary: 'Premium v2 Secondary Unit', gateway: 'Premium v2 Self-hosted Gateway', pack: 'Premium v2 Workspace Pack', wsGateway: 'Workspace Gateway Premium Unit' }
};

module.exports = {
  type: 'api-management',
  label: 'Azure API Management',
  family: 'integration',
  calculator: ['api-management'],
  keywords: ['api management', 'apim', 'api gateway', 'api', 'developer portal', 'gateway', 'rate limiting', 'publish apis'],
  fields: {
    tier: { def: 'standard-v2', enum: ['consumption', 'developer', 'basic', 'standard', 'premium', 'basic-v2', 'standard-v2', 'premium-v2'], ask: 'What is it for? Pay only per call, spiky or small -> consumption. Learning/testing (no SLA) -> developer. Production -> basic-v2 or standard-v2 (newer, faster to deploy; standard-v2 adds VNet integration), premium-v2 for private networking, zones and multi-region. The older basic, standard and premium tiers are still available. If unknown, suggest standard-v2 for production and record it as an assumption.' },
    units: { req: true, int: true, ask: 'How many gateway units (instances) do you need? 1 for small or test workloads, 2 or more for redundancy in production. Consumption does not use units; enter 0.' },
    additionalUnits: { def: 0, int: true, min: 0, ask: 'Premium, basic-v2, standard-v2 and premium-v2 only: how many extra units for a second region, extra availability zones or scale-out? Extra units are billed at a lower rate than the first unit.' },
    callsPerMonth: { def: 0, int: true, ask: 'Consumption, basic-v2 and standard-v2 only: how many API calls a month in total? Consumption includes the first 1 million, basic-v2 the first 10 million and standard-v2 the first 50 million.' },
    selfHostedGateways: { def: 0, int: true, min: 0, ask: 'Only if they run the gateway on their own servers or Kubernetes: how many self-hosted gateway deployments? Free on developer; billed on premium, standard-v2 and premium-v2.' },
    additionalWorkspaces: { def: 0, int: true, min: 0, ask: 'Only if separate API teams need their own workspaces: how many workspaces beyond the first five (the first five are included)?' },
    workspaceGateways: { def: 0, int: true, min: 0, ask: 'Premium and premium-v2 only: how many dedicated workspace gateways (isolated gateway for a workspace)? Most people need 0.' },
    apiCenters: { def: 0, int: true, min: 0, ask: 'Only if they want an API Center (API inventory and governance) on the Standard plan: how many?' },
    apiCenterLinked: { def: true, ask: 'Only with an API Center: will it be linked to this API Management service so its APIs sync automatically? A linked API Center Standard is free on the Standard, Standard v2, Premium and Premium v2 tiers (one per API Management instance); others are billed. If unknown, assume linked and record it as an assumption.' },
    hours: { def: 730 }
  },
  context: ['production', 'zoneResilience', 'privateOnly', 'multiRegionUsers'],
  examples: [
    { type: 'api-management', tier: 'consumption', units: 0, callsPerMonth: 20000000 },
    { type: 'api-management', tier: 'standard-v2', units: 2, additionalUnits: 1, callsPerMonth: 120000000, selfHostedGateways: 2, additionalWorkspaces: 3, apiCenters: 1 },
    { type: 'api-management', tier: 'basic', units: 1, apiCenters: 1 },
    { type: 'api-management', tier: 'standard', units: 1, apiCenters: 2, apiCenterLinked: true },
    { type: 'api-management', tier: 'premium', units: 1, additionalUnits: 2, selfHostedGateways: 1, additionalWorkspaces: 2, workspaceGateways: 1 },
    { type: 'api-management', tier: 'developer', units: 1 },
    { type: 'api-management', tier: 'basic-v2', units: 1, callsPerMonth: 40000000 },
    { type: 'api-management', tier: 'premium-v2', units: 2, additionalUnits: 2 }
  ],
  readback: c => {
    const tier = c.tier || 'standard-v2';
    const t = T[tier] || { name: tier };
    const hours = hrs(c) < HOURS ? `${fmtN(hrs(c))} hours a month` : 'running all month';
    const parts = [];
    if (tier !== 'consumption') parts.push(`${fmtN(n(c.units))} unit(s), ${hours}`);
    if (n(c.additionalUnits)) parts.push(`${fmtN(c.additionalUnits)} additional unit(s) (extra region, zone or scale-out)`);
    if (n(c.callsPerMonth)) parts.push(`${fmtN(c.callsPerMonth)} API calls a month`);
    if (n(c.selfHostedGateways)) parts.push(`${fmtN(c.selfHostedGateways)} self-hosted gateway(s)`);
    if (n(c.additionalWorkspaces)) parts.push(`${fmtN(c.additionalWorkspaces)} workspaces beyond the first five`);
    if (n(c.workspaceGateways)) parts.push(`${fmtN(c.workspaceGateways)} workspace gateway(s)`);
    if (n(c.apiCenters)) parts.push(`${fmtN(c.apiCenters)} API Center(s) (Standard, ${c.apiCenterLinked === false ? 'not linked, billed' : API_CENTER_FREE_TIERS.includes(tier) ? 'first one linked and included free' : 'billed'})`);
    return `API Management ${t.name}: ${parts.join(', ') || 'no usage entered'}`;
  },
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard-v2').toLowerCase();
    const t = T[tier];
    if (!t) throw new PricingError(`Unknown API Management tier "${tier}". Use ${Object.keys(T).join(', ')}.`);
    const hours = hrs(c);
    const units = n(c.units), extra = n(c.additionalUnits);
    if (tier === 'consumption' && (units || extra)) throw new PricingError('The consumption tier has no units; use callsPerMonth only.');
    if (tier !== 'consumption' && units < 1) throw new PricingError(`${t.name} needs at least 1 unit.`);
    if (extra && !t.secondary) throw new PricingError(`Additional units are not offered on ${t.name}; they exist on premium, basic-v2, standard-v2 and premium-v2.`);
    const gw = n(c.selfHostedGateways);
    if (gw && !t.gateway && !t.gatewayFree) throw new PricingError(`${t.name} has no self-hosted gateway; use developer (free), premium, standard-v2 or premium-v2.`);
    if (n(c.workspaceGateways) && !t.wsGateway) throw new PricingError('Workspace gateways exist on premium and premium-v2 only.');
    const rs = await rows(`serviceName eq 'API Management' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`API Management is not priced in ${ctx.region}.`);
    const pick = (meterName, what) => single(rs.filter(r => r.meterName === meterName), `API Management ${what}`);
    const G = 'Integration', S = 'API Management', lines = [], notes = [];
    if (t.unit) lines.push(meterLine(G, S, `API Management ${t.name}: ${fmtN(units)} unit(s) x ${fmtN(hours)} hours`, pick(t.unit, `${t.name} unit`), units * hours, ctx, { unit: 'hours' }));
    if (extra) {
      lines.push(meterLine(G, S, `${t.name} additional units: ${fmtN(extra)} x ${fmtN(hours)} hours`, pick(t.secondary, `${t.name} additional unit`), extra * hours, ctx, { unit: 'hours' }));
      notes.push('Additional units (secondary regions, extra zones or scale-out) are billed at their own hourly rate, lower than the first unit on most tiers.');
    }
    if (t.calls) {
      const rowsCalls = pick(t.calls, `${t.name} calls`);
      const z = rowsCalls.find(r => Number(r.retailPrice) === 0 && Number(r.tierMinimumUnits) === 0);
      const nextBand = z && rowsCalls.filter(r => Number(r.tierMinimumUnits) > 0).sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits)[0];
      lines.push(meterLine(G, S, `${t.name} API calls: ${fmtN(n(c.callsPerMonth))}/month${nextBand ? ` (first ${fmtN(nextBand.tierMinimumUnits * 10000)} free)` : ''}`, rowsCalls, n(c.callsPerMonth), ctx));
      notes.push(`${t.name} bills calls in blocks of 10,000 above the free allowance.`);
    } else if (n(c.callsPerMonth)) notes.push(`${t.name} includes API calls in the unit price; the call count is not billed.`);
    if (gw) {
      if (t.gatewayFree) notes.push('Self-hosted gateways are free on the Developer tier.');
      else lines.push(meterLine(G, S, `Self-hosted gateway: ${fmtN(gw)} deployment(s) x ${fmtN(hours)} hours`, pick(t.gateway, `${t.name} self-hosted gateway`), gw * hours, ctx, { unit: 'hours' }));
    }
    if (n(c.workspaceGateways)) lines.push(meterLine(G, S, `Workspace gateway: ${fmtN(c.workspaceGateways)} x ${fmtN(hours)} hours`, pick(t.wsGateway, 'workspace gateway'), n(c.workspaceGateways) * hours, ctx, { unit: 'hours' }));
    if (n(c.additionalWorkspaces)) {
      if (!t.pack) throw new PricingError(`${t.name} has no workspace pack price; workspaces are offered on premium, standard-v2, premium-v2 (and developer for free).`);
      lines.push(meterLine(G, S, `Workspaces beyond the first five: ${fmtN(c.additionalWorkspaces)} x ${fmtN(hours)} hours`, pick(t.pack, `${t.name} workspace pack`), n(c.additionalWorkspaces) * hours, ctx, { unit: 'hours' }));
      notes.push('The first five workspaces are included; each further workspace is billed hourly as a workspace pack.');
    }
    if (n(c.apiCenters)) {
      const ac = await rows(`serviceName eq 'Azure API Center' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
      const std = ac.filter(r => r.meterName === 'Standard Unit');
      if (!std.length) throw new PricingError(`API Center is not offered in ${ctx.region}; put the API Center in a region that offers it (it can still be linked to an API Management service elsewhere).`);
      const freeEligible = c.apiCenterLinked !== false && API_CENTER_FREE_TIERS.includes(tier);
      const billed = n(c.apiCenters) - (freeEligible ? 1 : 0);
      if (freeEligible) {
        const fr = ac.filter(r => r.meterName === 'apim apic free sku Unit');
        if (fr.length) lines.push(meterLine(G, 'Azure API Center', `API Center Standard linked to API Management ${t.name} (included at no extra cost): 1 x ${fmtN(hours)} hours`, [fr[0]], hours, ctx, { unit: 'hours' }));
        notes.push(`The first API Center linked to a ${t.name} instance is included at no extra cost (one API Center can be linked per API Management instance).`);
      } else notes.push('API Center Standard is free only when linked to an API Management Standard, Standard v2, Premium or Premium v2 instance; this one is billed.');
      if (billed > 0) lines.push(meterLine(G, 'Azure API Center', `API Center Standard: ${fmtN(billed)} x ${fmtN(hours)} hours`, single(std, 'API Center Standard'), billed * hours, ctx, { unit: 'hours' }));
      notes.push('API Center is offered in a limited set of regions (Learn lists fewer than the calculator and Retail prices, which include East US 2).');
    }
    notes.push('Not priced: the Workspace Gateway Standard unit (a Retail meter that is not on the calculator or pricing page) and the 0-priced AI Gateway Requests meter.');
    if (!lines.length) throw new PricingError('Nothing to price: add units or callsPerMonth.');
    return { lines, notes, facts: { tier, units, additionalUnits: extra, callsPerMonth: n(c.callsPerMonth), selfHostedGateways: gw, additionalWorkspaces: n(c.additionalWorkspaces), apiCenters: n(c.apiCenters), hours } };
  }
};
