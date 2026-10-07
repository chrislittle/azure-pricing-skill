'use strict';
// Azure Firewall Manager: firewall policies (billed per policy per region, parent and child), Policy Analytics, secured virtual hubs
// with a third-party security provider, and Azure Firewall inside secured virtual hubs.
// Meters: serviceName 'Azure Firewall Manager' (policies, analytics, third-party hubs) and 'Azure Firewall' (secured hub firewalls).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const TIERS = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };
const HUB = {
  basic: { deploy: 'Basic Secured Virtual Hub Deployment', data: 'Basic Secured Virtual Hub Data Processed' },
  standard: { deploy: 'Standard Secure Virtual Hub Deployment', data: 'Standard Secure Virtual Hub Data Processed', capacity: 'Standard Secure Virtual Hub Capacity Unit' },
  premium: { deploy: 'Premium Secured Virtual Hub Deployment', data: 'Premium Secured Virtual Hub Data Processed', capacity: 'Premium Secured Virtual Hub Capacity Unit' }
};
const pl = k => (n(k) === 1 ? 'y' : 'ies');

module.exports = {
  type: 'firewall-manager',
  label: 'Azure Firewall Manager',
  family: 'network-security',
  calculator: ['firewall-manager'],
  keywords: ['firewall manager', 'firewall policy', 'central policy', 'secured virtual hub', 'policy analytics', 'virtual wan security', 'third party security provider'],
  fields: {
    policies: { int: true, min: 0, req: true, ask: 'How many Azure Firewall policies (central rule sets) are used by two or more firewalls? A policy used by only one firewall is free. A parent (base) policy that child policies inherit from counts every firewall that uses it directly or through a child, and is billed even if each child has one firewall. Use 0 if they only need the other items below.' },
    regions: { int: true, min: 1, max: 50, def: 1, ask: 'For those policies: in how many different Azure regions are the firewalls that use each policy? (A policy used by firewalls in 3 regions is billed 3 times; it cannot be more than the number of firewalls.) If the policies differ, add a separate component per group.' },
    firewallsPerPolicy: { int: true, min: 1, max: 10000, def: 2, ask: 'How many firewalls, in total, use each of those policies? A policy with 0 or 1 firewall is free; 2 or more is billed.' },
    childPolicies: { int: true, min: 0, def: 0, ask: 'Do they use child policies that inherit rules from a parent policy (for example one per region or team)? How many child policies? Most people say 0. A billed child policy is charged for itself and again for its parent in the same regions.' },
    childRegions: { int: true, min: 1, max: 50, def: 1, ask: 'Only for child policies: in how many regions does each child policy have firewalls (at most the number of firewalls)?' },
    childFirewalls: { int: true, min: 1, max: 10000, def: 1, ask: 'Only for child policies: how many firewalls use each child policy? A child policy with a single firewall is free (its parent is still billed, so count that firewall in the parent policy above).' },
    policyAnalytics: { int: true, min: 0, def: 0, ask: 'How many policies will have Policy Analytics turned on (a feature that analyses firewall logs to tune rules)? Most people say 0 unless they want rule optimisation.' },
    analyticsHours: { def: 730, ask: 'Only for Policy Analytics: hours a month it is switched on (730 = all month; it bills hourly while enabled).' },
    thirdPartyHubs: { int: true, min: 0, def: 0, ask: 'How many Virtual WAN hubs will be secured with a third-party security provider (instead of Azure Firewall)? Most people say 0.' },
    thirdPartyHours: { def: 730, ask: 'Only for third-party hubs: hours a month each hub exists (730 = all month).' },
    securedHubFirewallTier: { def: 'none', enum: ['none', 'basic', 'standard', 'premium'], ask: 'Only if this firewall is NOT already priced as part of a Virtual WAN or Azure Firewall component in the same estimate: will Azure Firewall run inside a Virtual WAN secured hub that Firewall Manager deploys? No -> none. Yes: small business -> basic; typical -> standard; TLS inspection or intrusion prevention -> premium.' },
    securedHubs: { int: true, min: 0, def: 1, ask: 'Only if there are secured hubs with Azure Firewall: how many hubs?' },
    securedHubDataGB: { def: 0, ask: 'Only if there are secured hubs with Azure Firewall: roughly how many GB a month go through the hub firewalls in total?' },
    securedHubCapacityUnits: { int: true, min: 0, def: 0, ask: 'Only for standard or premium secured hubs and only if they pre-scale firewall capacity: how many capacity units in total? Most people say 0.' },
    securedHubHours: { def: 730, ask: 'Only for secured hubs with Azure Firewall: hours a month each hub (and its capacity units) exists (730 = all month).' }
  },
  context: ['production'],
  examples: [
    { type: 'firewall-manager', policies: 2, regions: 2, firewallsPerPolicy: 4 },
    { type: 'firewall-manager', policies: 1, regions: 3, firewallsPerPolicy: 6, childPolicies: 2, childRegions: 2, childFirewalls: 3, policyAnalytics: 1, analyticsHours: 400, thirdPartyHubs: 1, thirdPartyHours: 730, securedHubFirewallTier: 'premium', securedHubs: 2, securedHubDataGB: 3000, securedHubCapacityUnits: 2, securedHubHours: 730 },
    { type: 'firewall-manager', policies: 0, securedHubFirewallTier: 'standard', securedHubs: 1, securedHubDataGB: 500 }
  ],
  readback: c => {
    const parts = [];
    const hrsTxt = h => ((h ?? HOURS) === HOURS ? 'running all month' : `${fmtN(h)} hours a month`);
    if (n(c.policies)) parts.push(`${fmtN(c.policies)} firewall polic${pl(c.policies)}, each in ${fmtN(c.regions ?? 1)} region(s) and used by ${fmtN(c.firewallsPerPolicy ?? 2)} firewall(s) (policies with fewer than 2 firewalls are free)`);
    if (n(c.childPolicies)) parts.push(`${fmtN(c.childPolicies)} child polic${pl(c.childPolicies)}, each in ${fmtN(c.childRegions ?? 1)} region(s) and used by ${fmtN(c.childFirewalls ?? 1)} firewall(s) (a billed child is charged for itself and its parent)`);
    if (n(c.policyAnalytics)) parts.push(`Policy Analytics on ${fmtN(c.policyAnalytics)} polic${pl(c.policyAnalytics)}, ${hrsTxt(c.analyticsHours)}`);
    if (n(c.thirdPartyHubs)) parts.push(`${fmtN(c.thirdPartyHubs)} secured hub(s) with a third-party provider, ${hrsTxt(c.thirdPartyHours)}`);
    if (c.securedHubFirewallTier && c.securedHubFirewallTier !== 'none') {
      parts.push(`Azure Firewall ${c.securedHubFirewallTier} in ${fmtN(c.securedHubs ?? 1)} secured hub(s), ${hrsTxt(c.securedHubHours)}, ${fmtN(n(c.securedHubDataGB))} GB processed a month`);
      if (n(c.securedHubCapacityUnits)) parts.push(`${fmtN(c.securedHubCapacityUnits)} pre-scaled capacity unit(s)`);
    }
    return `Azure Firewall Manager: ${parts.length ? parts.join('; ') : `${fmtN(n(c.policies))} policies`}`;
  },
  notIncluded: (types, spec) => {
    if (spec && spec.excluded) return [];
    const out = ['The firewalls themselves in your own virtual networks, the Virtual WAN hubs, DDoS Protection plans and WAF policies that Firewall Manager deploys are priced under their own services.'];
    const comps = ((spec && spec.options) || []).flatMap(o => o.components || []);
    const hubFw = comps.some(c => c.type === 'firewall-manager' && c.securedHubFirewallTier && c.securedHubFirewallTier !== 'none');
    if (hubFw && (types.has('virtual-wan') || types.has('azure-firewall'))) out.push('WARNING, possible double count: Azure Firewall in a secured hub is priced here and the estimate also has a virtual-wan or azure-firewall component; keep the hub firewall in only one of them.');
    return out;
  },
  price: async (c, ctx) => {
    const hrs = (v, name) => { const h = v ?? HOURS; if (h < 0 || h > 744) throw new PricingError(`${name} must be between 0 and 744 (the longest month).`); return h; };
    const analyticsHours = hrs(c.analyticsHours, 'analyticsHours'), thirdPartyHours = hrs(c.thirdPartyHours, 'thirdPartyHours'), hubHours = hrs(c.securedHubHours, 'securedHubHours');
    const tier = (c.securedHubFirewallTier || 'none').toLowerCase();
    if (tier !== 'none' && !TIERS[tier]) throw new PricingError('securedHubFirewallTier must be none, basic, standard or premium.');
    if (n(c.securedHubCapacityUnits) > 0 && (tier === 'none' || tier === 'basic')) throw new PricingError('Capacity units need a standard or premium secured hub firewall.');
    const policies = n(c.policies), regions = c.regions ?? 1, fws = c.firewallsPerPolicy ?? 2;
    const kids = n(c.childPolicies), kidRegions = c.childRegions ?? 1, kidFws = c.childFirewalls ?? 1;
    if (policies && regions > fws) throw new PricingError(`regions (${regions}) cannot be more than firewallsPerPolicy (${fws}): each region needs at least one firewall.`);
    if (kids && kidRegions > kidFws) throw new PricingError(`childRegions (${kidRegions}) cannot be more than childFirewalls (${kidFws}): each region needs at least one firewall.`);
    const G = 'Networking', S = 'Azure Firewall Manager', lines = [], notes = [];
    let billedPolicyRegions = 0;
    const needsFm = (policies && fws >= 2) || (kids && kidFws >= 2) || n(c.policyAnalytics) || n(c.thirdPartyHubs);
    let fmRows = [];
    if (needsFm) fmRows = await rows(`serviceName eq 'Azure Firewall Manager' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const fm = (name, what) => {
      const hit = fmRows.filter(r => r.meterName === name);
      if (!hit.length) throw new PricingError(`Firewall Manager ${what} is not priced in ${ctx.region}.`);
      return single(hit, `Firewall Manager ${what}`);
    };
    if (policies) {
      if (fws >= 2) {
        billedPolicyRegions += policies * regions;
        lines.push(meterLine(G, S, `Firewall policies: ${fmtN(policies)} polic${pl(policies)} x ${fmtN(regions)} region(s)`, fm('Standard Policy per Region', 'policy per region'), policies * regions, ctx, { unit: 'policy-regions / month' }));
        notes.push('A policy is billed per region it is used in once it has two or more firewalls attached; a policy with zero or one firewall association is free.');
      } else notes.push('Policies attached to a single firewall (or none) are free, so no policy charge applies.');
    }
    if (kids) {
      if (kidFws >= 2) {
        billedPolicyRegions += kids * kidRegions * 2;
        lines.push(meterLine(G, S, `Child policies: ${fmtN(kids)} child polic${pl(kids)} x ${fmtN(kidRegions)} region(s), each charged for itself and its parent in those regions (x2)`, fm('Standard Policy per Region', 'child policy per region'), kids * kidRegions * 2, ctx, { unit: 'policy-regions / month' }));
        notes.push('As in the Azure Pricing Calculator, a billed child policy costs twice the per-region policy price: it includes its parent in the same region. A child with a single firewall is free, but its parent is still billed.');
      } else notes.push('Child policies with a single firewall are free; their parent policy is still billed, so count those firewalls in the parent policy.');
    }
    if (n(c.policyAnalytics)) {
      lines.push(meterLine(G, S, `Policy Analytics: ${fmtN(c.policyAnalytics)} polic${pl(c.policyAnalytics)} x ${fmtN(analyticsHours)} hours`, fm('Policy analytics Deployment', 'Policy Analytics'), n(c.policyAnalytics) * analyticsHours, ctx, { unit: 'hours' }));
      notes.push('Policy Analytics is billed hourly while enabled; the number of firewalls attached to the policy does not change the charge.');
    }
    if (n(c.thirdPartyHubs)) lines.push(meterLine(G, S, `Secured hubs with third-party provider: ${fmtN(c.thirdPartyHubs)} hub(s) x ${fmtN(thirdPartyHours)} hours`, fm('Secured Virtual Hub with 3rd Party Integration Deployment', 'third-party secured hub'), n(c.thirdPartyHubs) * thirdPartyHours, ctx, { unit: 'hours' }));
    if (tier !== 'none') {
      const afw = await rows(`serviceName eq 'Azure Firewall' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
      const af = (name, what) => {
        const hit = afw.filter(r => r.meterName === name);
        if (!hit.length) throw new PricingError(`Azure Firewall ${TIERS[tier]} in a secured virtual hub (${what}) is not priced in ${ctx.region}.`);
        return single(hit, `Azure Firewall ${TIERS[tier]} secured hub ${what}`);
      };
      const hubs = n(c.securedHubs ?? 1), gb = n(c.securedHubDataGB), cap = n(c.securedHubCapacityUnits);
      lines.push(meterLine(G, 'Azure Firewall', `Azure Firewall ${TIERS[tier]} in secured hub: deployment, ${fmtN(hubs)} hub(s) x ${fmtN(hubHours)} hours`, af(HUB[tier].deploy, 'deployment'), hubs * hubHours, ctx, { unit: 'hours' }));
      lines.push(meterLine(G, 'Azure Firewall', `Azure Firewall ${TIERS[tier]} in secured hub: data processed, ${fmtN(gb)} GB/month`, af(HUB[tier].data, 'data processed'), gb, ctx, { unit: 'GB' }));
      if (cap) lines.push(meterLine(G, 'Azure Firewall', `Azure Firewall ${TIERS[tier]} in secured hub: pre-scaled capacity, ${fmtN(cap)} unit(s) x ${fmtN(hubHours)} hours`, af(HUB[tier].capacity, 'capacity unit'), cap * hubHours, ctx, { unit: 'hours' }));
      notes.push('Azure Firewall in a secured hub is billed at the Azure Firewall deployment and data-processing rates; the Virtual WAN hub itself is priced under Virtual WAN. Do not also add this hub firewall under a virtual-wan or azure-firewall component.');
    }
    if (!lines.length) notes.push('Nothing in this component is billable: Firewall Manager itself is free, and policies with fewer than 2 firewalls cost nothing.');
    return { lines, notes, facts: { policies, regions, firewallsPerPolicy: fws, childPolicies: kids, billedPolicyRegions, policyAnalytics: n(c.policyAnalytics), thirdPartyHubs: n(c.thirdPartyHubs), securedHubFirewallTier: tier } };
  }
};
