'use strict';
// Azure Firewall (Basic, Standard, Premium), standalone in a virtual network or inside a Virtual WAN secured hub.
// Meters: serviceName 'Azure Firewall', regional. Deployment is billed per firewall per hour, data processed per GB,
// capacity units (optional pre-scaling, Standard and Premium only) per unit-hour.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const TIERS = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };

// Meter names per tier and placement. Microsoft names the Standard hub meters "Secure" (not "Secured").
const METERS = {
  vnet: {
    basic: { deploy: 'Basic Deployment', data: 'Basic Data Processed' },
    standard: { deploy: 'Standard Deployment', data: 'Standard Data Processed', capacity: 'Standard Capacity Unit' },
    premium: { deploy: 'Premium Deployment', data: 'Premium Data Processed', capacity: 'Premium Capacity Unit' }
  },
  hub: {
    basic: { deploy: 'Basic Secured Virtual Hub Deployment', data: 'Basic Secured Virtual Hub Data Processed' },
    standard: { deploy: 'Standard Secure Virtual Hub Deployment', data: 'Standard Secure Virtual Hub Data Processed', capacity: 'Standard Secure Virtual Hub Capacity Unit' },
    premium: { deploy: 'Premium Secured Virtual Hub Deployment', data: 'Premium Secured Virtual Hub Data Processed', capacity: 'Premium Secured Virtual Hub Capacity Unit' }
  }
};

const fwNotes = (types, spec) => {
  const comps = ((spec && spec.options) || []).flatMap(o => o.components || []).filter(c => c.type === 'azure-firewall');
  const out = [];
  if (comps.some(c => (c.tier || 'standard') === 'basic')) out.push('A Basic firewall also needs its own management public IP address (priced separately).');
  if (comps.some(c => c.securedVirtualHub || n(c.firewalls) >= 2)) out.push('Firewall Manager policy fees (per policy and region) are priced separately under Firewall Manager.');
  return out;
};

module.exports = {
  type: 'azure-firewall',
  label: 'Azure Firewall',
  family: 'network-security',
  calculator: ['azure-firewall'],
  keywords: ['firewall', 'network security', 'traffic inspection', 'egress filtering', 'tls inspection', 'intrusion detection', 'secured hub', 'virtual wan'],
  fields: {
    tier: { def: 'standard', enum: ['basic', 'standard', 'premium'], ask: 'How big and how demanding is the traffic? Small or medium business, up to about 250 Mbps -> basic. Typical production network filtering -> standard. Needs inspection of encrypted (TLS) traffic or intrusion detection and prevention (IDPS), for example for regulated data -> premium. If unknown, suggest standard and record it as an assumption.' },
    firewalls: { req: true, int: true, min: 1, max: 500, ask: 'How many firewalls will they deploy? Count one per hub network or per region; two firewalls for high availability across regions count as 2. If unknown, suggest 1 and record it as an assumption.' },
    dataGB: { def: 0, ask: 'Roughly how many GB a month of network traffic will go through the firewall (all firewalls together)? If unknown, suggest 1,000 GB and record it as an assumption.' },
    securedVirtualHub: { def: false, type: 'boolean', ask: 'Is the firewall inside an Azure Virtual WAN hub (a "secured virtual hub") managed with Firewall Manager? Yes -> true; a firewall in your own virtual network -> false.' },
    minCapacity: { int: true, min: 0, max: 50, def: 0, ask: 'Only for standard or premium, and only if they pre-scale firewall capacity ahead of expected spikes: what minimum capacity (number of instances, 2 to 50) will each firewall be set to? Azure always runs 2 instances at no extra charge, so 2 costs nothing extra. Use 0 if they do not pre-scale (most people).' },
    capacityHours: { int: true, min: 0, max: 744, def: 730, ask: 'Only if minimum capacity is above 2: how many hours a month is it set that high (730 = all month; cannot be more than the hours the firewall runs)?' },
    hours: { def: 730, ask: 'How many hours a month does each firewall exist? 730 = all month; a firewall is billed from deployment until it is deleted, even when no traffic flows.' }
  },
  context: ['production'],
  examples: [
    { type: 'azure-firewall', tier: 'standard', firewalls: 1, dataGB: 1000 },
    { type: 'azure-firewall', tier: 'premium', firewalls: 2, hours: 730, dataGB: 5000, securedVirtualHub: false, minCapacity: 5, capacityHours: 200 },
    { type: 'azure-firewall', tier: 'standard', firewalls: 1, dataGB: 2000, securedVirtualHub: true, minCapacity: 4, capacityHours: 730 },
    { type: 'azure-firewall', tier: 'basic', firewalls: 1, dataGB: 100 }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    const where = c.securedVirtualHub ? 'in a Virtual WAN secured hub' : 'in a virtual network';
    const parts = [`${fmtN(n(c.firewalls))} firewall(s) ${where}, ${hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month each`}`, `${fmtN(n(c.dataGB))} GB of traffic processed a month`];
    if (n(c.minCapacity) > 2) parts.push(`minimum capacity ${fmtN(c.minCapacity)} per firewall for ${fmtN(c.capacityHours ?? HOURS)} hours a month (${fmtN(c.minCapacity - 2)} billable units above the 2 included instances)`);
    else if (n(c.minCapacity)) parts.push(`minimum capacity ${fmtN(c.minCapacity)} per firewall (the 2 default instances are included, no extra charge)`);
    return `Azure Firewall ${c.tier || 'standard'}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    ...(types.has('public-ip') ? [] : ['The public IP address(es) the firewall uses are priced separately.']),
    ...fwNotes(types, spec),
    'Log storage and analysis (Log Analytics or storage) for firewall logs, and traffic between virtual networks or out to the internet, are priced separately.'
  ],
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!TIERS[tier]) throw new PricingError('tier must be basic, standard or premium.');
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const capHours = c.capacityHours ?? HOURS;
    if (capHours < 0 || capHours > 744) throw new PricingError('capacityHours must be between 0 and 744 (the longest month).');
    const minCap = n(c.minCapacity);
    if (c.securedVirtualHub != null && typeof c.securedVirtualHub !== 'boolean') throw new PricingError('securedVirtualHub must be true or false.');
    if (minCap > 0 && tier === 'basic') throw new PricingError('Pre-scaled capacity is not available on the Basic tier; use standard or premium.');
    if (minCap === 1 || minCap > 50) throw new PricingError('minCapacity must be 0 (no pre-scaling) or between 2 and 50.');
    if (minCap > 2 && capHours > hours) throw new PricingError('capacityHours cannot be more than hours: capacity cannot be set longer than the firewall runs.');
    const place = c.securedVirtualHub ? 'hub' : 'vnet';
    const names = METERS[place][tier];
    const rs = await rows(`serviceName eq 'Azure Firewall' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const m = (name, what) => {
      const hit = rs.filter(r => r.meterName === name);
      if (!hit.length) throw new PricingError(`Azure Firewall ${TIERS[tier]}${c.securedVirtualHub ? ' in a secured virtual hub' : ''} (${what}) is not priced in ${ctx.region}.`);
      return single(hit, `Azure Firewall ${TIERS[tier]} ${what}`);
    };
    const G = 'Networking', S = 'Azure Firewall', fw = n(c.firewalls), lines = [];
    const label = `Azure Firewall ${TIERS[tier]}${c.securedVirtualHub ? ' (secured virtual hub)' : ''}`;
    lines.push(meterLine(G, S, `${label}: deployment, ${fmtN(fw)} firewall(s) x ${fmtN(hours)} hours`, m(names.deploy, 'deployment'), fw * hours, ctx, { unit: 'hours' }));
    lines.push(meterLine(G, S, `${label}: data processed, ${fmtN(n(c.dataGB))} GB/month`, m(names.data, 'data processed'), n(c.dataGB), ctx, { unit: 'GB' }));
    const billable = Math.max(0, minCap - 2) * fw;
    if (billable > 0) lines.push(meterLine(G, S, `${label}: pre-scaled capacity, minimum ${fmtN(minCap)} instances = ${fmtN(minCap - 2)} billable unit(s) x ${fmtN(fw)} firewall(s) x ${fmtN(capHours)} hours`, m(names.capacity, 'capacity unit'), billable * capHours, ctx, { unit: 'hours' }));
    const notes = ['Azure Firewall bills a fixed hourly deployment charge for each firewall from the moment it is deployed, even when no traffic flows, plus a charge per GB of traffic it processes.'];
    if (tier === 'basic') notes.push('The Basic tier is intended for small and medium businesses with throughput up to 250 Mbps.');
    if (minCap > 0) notes.push(`The capacity-unit charge excludes the two default running instances (Learn, prescaling: "The instance count used for this calculation excludes the two default running instances."): a minimum of ${fmtN(minCap)} bills ${fmtN(Math.max(0, minCap - 2))} unit(s) per firewall.`);
    if (c.securedVirtualHub) notes.push('The Virtual WAN hub itself (hub hours, connections, data) is priced under Virtual WAN, not here.');
    return { lines, notes, facts: { tier, firewalls: fw, hours, dataGB: n(c.dataGB), securedVirtualHub: !!c.securedVirtualHub, minCapacity: minCap, billableCapacityUnits: billable } };
  }
};
