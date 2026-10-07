'use strict';
// Azure Virtual WAN: Standard hubs (deployment and data processed), hubs with Firewall Manager policies for
// third-party security providers, extra routing infrastructure units, site-to-site / point-to-site / ExpressRoute
// scale units and connection units, NVA infrastructure units and Azure Firewall in the hub (secured virtual hub).
// Meters: serviceName 'Virtual WAN' (regional, hourly or per GB) and, for secured hubs, serviceName 'Azure Firewall'
// (productName "<Tier> Secured Virtual Hub"). A hub includes 2 routing infrastructure units in its deployment fee.
// A Basic Virtual WAN has no hub fee and no data processing fee; only site-to-site VPN units bill. The legacy meters
// 'App Gateway Unit', 'Hub to Hub Transfer Unit' and 'VPN Policy Unit' (effective 2018, not on the pricing page or
// calculator) are intentionally not priced.
const NVA_UNITS = [2, 4, 10, 20, 30, 40, 60, 80];
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS, q } = require('../kit');

const n = v => Number(v || 0);
const FW = {
  basic: { name: 'Basic Secured Virtual Hub', label: 'Basic' },
  standard: { name: 'Standard Secure Virtual Hub', label: 'Standard' },
  premium: { name: 'Premium Secured Virtual Hub', label: 'Premium' }
};

module.exports = {
  type: 'virtual-wan',
  label: 'Azure Virtual WAN',
  family: 'networking-gateways',
  calculator: ['virtual-wan'],
  keywords: ['virtual wan', 'vwan', 'hub and spoke', 'sd-wan', 'branch connectivity', 'secured hub', 'wan', 'global transit'],
  fields: {
    wanType: { def: 'standard', enum: ['standard', 'basic'], ask: 'Is this a Standard Virtual WAN (needed for point-to-site VPN, ExpressRoute, firewalls, NVAs and hub-to-hub transit) or a Basic one (site-to-site VPN only, no hub fee)? Standard unless they only need site-to-site VPN and want the cheapest option. If unknown, suggest standard.' },
    hubs: { req: true, def: 1, int: true, min: 1, ask: 'How many virtual hubs? You need one per Azure region that connects branches, users or virtual networks through Virtual WAN.' },
    thirdPartyIntegrations: { def: false, ask: 'Will the hubs use route maps or Firewall Manager policies for a third-party security provider? Yes -> true (the hub costs more per hour); otherwise false.' },
    dataProcessedGB: { def: 0, min: 0, ask: 'Standard only: how many GB a month go from one virtual network to another through the hub (including to virtual networks behind another hub)? Traffic between branches, users or ExpressRoute and Azure is NOT counted. If unknown, suggest 500 and record it as an assumption; use 0 only if they have no VNet-to-VNet traffic.' },
    extraRoutingUnits: { def: 0, int: true, min: 0, ask: 'Per hub: extra routing capacity beyond the 2 units included. Each hub handles about 2,000 VMs across all its connected virtual networks; add 1 unit for every further 1,000 VMs. Use 0 if they have fewer than 2,000 VMs per hub.' },
    s2sScaleUnits: { def: 0, int: true, min: 0, ask: 'Site-to-site VPN, per hub: how many scale units? Each unit gives 500 Mbps of VPN throughput (2 units = 1 Gbps). Use 0 if they do not use site-to-site VPN.' },
    s2sConnectionUnits: { def: 0, int: true, min: 0, ask: 'Site-to-site VPN, per hub: how many branch connections (tunnel sets to branch offices or other sites)?' },
    p2sScaleUnits: { def: 0, int: true, min: 0, ask: 'User VPN (point-to-site), per hub: how many scale units? Each unit gives 500 Mbps. Use 0 if remote users do not connect through Virtual WAN.' },
    p2sConnectionUnits: { def: 0, int: true, min: 0, max: 100000, ask: 'User VPN, per hub: how many remote users connect at the same time?' },
    erScaleUnits: { def: 0, int: true, min: 0, max: 10, ask: 'ExpressRoute into the hub, per hub: how many scale units? Each unit gives 2 Gbps. Use 0 if they do not connect ExpressRoute circuits to Virtual WAN. The first 5 scale units are billed at the full rate, further units at a lower rate.' },
    erConnectionUnits: { def: 0, int: true, min: 0, ask: 'ExpressRoute into the hub, per hub: how many ExpressRoute circuit connections?' },
    nvaInfraUnits: { def: 0, int: true, min: 0, ask: 'Only if they put a partner network virtual appliance (NVA, such as an SD-WAN device) inside the hub: how many infrastructure units per hub (2, 4, 10, 20, 30, 40, 60 or 80)? Each unit gives 500 Mbps of throughput through the appliance. The appliance vendor bills its licence separately.' },
    nvaDataGB: { def: 0, min: 0, ask: 'Only with an NVA in the hub: GB a month of firewall traffic the NVA processes in total.' },
    firewallTier: { def: 'none', enum: ['none', 'basic', 'standard', 'premium'], ask: 'Should the hubs also run Azure Firewall to inspect traffic (a secured hub)? No -> none; small business with modest throughput -> basic; normal -> standard; needs TLS inspection or intrusion detection -> premium.' },
    firewallDataGB: { def: 0, min: 0, ask: 'Secured hub only: GB a month the Azure Firewall in the hubs inspects in total.' },
    firewallCapacityUnits: { def: 0, int: true, min: 0, ask: 'Secured hub with Standard or Premium firewall only, per hub: how many pre-scaled firewall capacity units (optional)? Use 0 unless they asked to pre-scale.' },
    s2sHours: { min: 0, max: 744, ask: 'Only if the site-to-site VPN units run for fewer hours than the hub: hours a month. Leave empty to use the hub hours.' },
    p2sHours: { min: 0, max: 744, ask: 'Only if the user VPN units run for fewer hours than the hub: hours a month. Leave empty to use the hub hours.' },
    erHours: { min: 0, max: 744, ask: 'Only if the ExpressRoute units run for fewer hours than the hub: hours a month. Leave empty to use the hub hours.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Hours a month each hub and its units exist (730 = all month).' }
  },
  context: ['production', 'multiRegionUsers', 'privateOnly'],
  examples: [
    { type: 'virtual-wan', hubs: 1, dataProcessedGB: 1000 },
    { type: 'virtual-wan', wanType: 'basic', hubs: 1, s2sScaleUnits: 2, s2sConnectionUnits: 10 },
    { type: 'virtual-wan', hubs: 2, thirdPartyIntegrations: true, dataProcessedGB: 5000, extraRoutingUnits: 2, s2sScaleUnits: 2, s2sConnectionUnits: 20, p2sScaleUnits: 2, p2sConnectionUnits: 200, erScaleUnits: 7, erConnectionUnits: 2, nvaInfraUnits: 2, nvaDataGB: 1000, firewallTier: 'standard', firewallDataGB: 2000, firewallCapacityUnits: 2, p2sHours: 400, hours: 730 }
  ],
  readback: c => {
    const hubs = n(c.hubs) || 1;
    const hours = c.hours ?? HOURS;
    const parts = [`${c.wanType === 'basic' ? 'Basic' : 'Standard'} WAN, ${fmtN(hubs)} hub(s), ${hours === HOURS ? 'running all month' : `${fmtN(hours)} hours a month`}`, `${fmtN(n(c.dataProcessedGB))} GB a month of VNet-to-VNet traffic through the hubs`];
    if (c.thirdPartyIntegrations) parts.push('with route maps / third-party security provider policies');
    if (n(c.extraRoutingUnits)) parts.push(`${fmtN(c.extraRoutingUnits)} extra routing infrastructure unit(s) per hub`);
    if (n(c.s2sScaleUnits) || n(c.s2sConnectionUnits)) parts.push(`site-to-site VPN per hub: ${fmtN(n(c.s2sScaleUnits))} scale units, ${fmtN(n(c.s2sConnectionUnits))} connections`);
    if (n(c.p2sScaleUnits) || n(c.p2sConnectionUnits)) parts.push(`user VPN per hub: ${fmtN(n(c.p2sScaleUnits))} scale units, ${fmtN(n(c.p2sConnectionUnits))} connections`);
    if (n(c.erScaleUnits) || n(c.erConnectionUnits)) parts.push(`ExpressRoute per hub: ${fmtN(n(c.erScaleUnits))} scale units, ${fmtN(n(c.erConnectionUnits))} connections`);
    if (n(c.nvaInfraUnits) || n(c.nvaDataGB)) parts.push(`NVA in hub: ${fmtN(n(c.nvaInfraUnits))} infrastructure units per hub, ${fmtN(n(c.nvaDataGB))} GB processed a month`);
    if (c.firewallTier && c.firewallTier !== 'none') parts.push(`Azure Firewall ${c.firewallTier} in each hub${n(c.firewallCapacityUnits) ? ` with ${fmtN(c.firewallCapacityUnits)} capacity unit(s)` : ''}, ${fmtN(n(c.firewallDataGB))} GB inspected a month`);
    return `Virtual WAN: ${parts.join('; ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Data transfer charges for traffic leaving Azure or crossing regions between hubs (standard bandwidth rates)',
    'Virtual network peering charges when a virtual network connected to a hub sends or receives data',
    'The branch devices, SD-WAN partner licences and the circuits that connect to the hubs'
  ],
  price: async (c, ctx) => {
    const hubs = c.hubs == null ? 1 : n(c.hubs);
    if (hubs < 1) throw new PricingError('hubs must be at least 1.');
    const hours = c.hours ?? HOURS;
    const wan = (c.wanType || 'standard').toLowerCase();
    if (!['standard', 'basic'].includes(wan)) throw new PricingError('wanType must be standard or basic.');
    const basic = wan === 'basic';
    const hrs = v => v ?? hours;
    for (const [k, v] of [['s2sHours', c.s2sHours], ['p2sHours', c.p2sHours], ['erHours', c.erHours]]) if (v != null && !basic && v > hours) throw new PricingError(`${k} cannot exceed the hub hours (${hours}): a gateway only exists while its hub does.`);
    const s2sH = hrs(c.s2sHours), p2sH = hrs(c.p2sHours), erH = hrs(c.erHours);
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const fwTier = (c.firewallTier || 'none').toLowerCase();
    if (fwTier !== 'none' && !FW[fwTier]) throw new PricingError('firewallTier must be none, basic, standard or premium.');
    const g = n(c.dataProcessedGB);
    if (basic) {
      const bad = [['thirdPartyIntegrations', c.thirdPartyIntegrations], ['dataProcessedGB', g], ['extraRoutingUnits', n(c.extraRoutingUnits)], ['p2sScaleUnits', n(c.p2sScaleUnits)], ['p2sConnectionUnits', n(c.p2sConnectionUnits)], ['erScaleUnits', n(c.erScaleUnits)], ['erConnectionUnits', n(c.erConnectionUnits)], ['nvaInfraUnits', n(c.nvaInfraUnits)], ['nvaDataGB', n(c.nvaDataGB)], ['firewallCapacityUnits', n(c.firewallCapacityUnits)]].filter(([, v]) => v).map(([k]) => k);
      if (bad.length || fwTier !== 'none') throw new PricingError(`A Basic Virtual WAN supports site-to-site VPN only (no hub fee, no data processing fee). ${[...bad, ...(fwTier !== 'none' ? ['firewallTier'] : [])].join(', ')} need a Standard Virtual WAN; set wanType to standard.`);
      if (!n(c.s2sScaleUnits) && !n(c.s2sConnectionUnits)) throw new PricingError('A Basic Virtual WAN has no hub fee, so it needs site-to-site scale or connection units to price anything.');
    }
    const nva = n(c.nvaInfraUnits);
    if (nva && !NVA_UNITS.includes(nva)) throw new PricingError(`NVA infrastructure units per hub must be one of ${NVA_UNITS.join(', ')}.`);
    if (n(c.firewallCapacityUnits) && !['standard', 'premium'].includes(fwTier)) throw new PricingError('firewallCapacityUnits needs firewallTier standard or premium.');
    const rs = await rows(`serviceName eq 'Virtual WAN' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Virtual WAN is not priced in ${ctx.region}; pick a nearby region that offers it.`);
    const mt = (name, what) => {
      const m = rs.filter(r => r.meterName === name);
      if (!m.length) throw new PricingError(`Virtual WAN ${what} has no published price in ${ctx.region} (some regions such as swedencentral, germanynorth, norwaywest and uaecentral lack hub prices); pick a nearby region such as westeurope or northeurope.`);
      return single(m, `Virtual WAN ${what} in ${ctx.region}`);
    };
    const G = 'Networking', S = 'Virtual WAN', lines = [], notes = [];
    const third = !!c.thirdPartyIntegrations;
    const hubName = third ? 'Standard Hub with Firewall policies for Third party security provider(s)' : 'Standard Hub';
    if (!basic) lines.push(meterLine(G, S, `Virtual WAN Standard hub${third ? ' with third-party security provider policies' : ''}: ${fmtN(hubs)} hub(s) x ${fmtN(hours)} hours`, mt(`${hubName} Unit`, 'hub deployment'), hubs * hours, ctx, { unit: 'hub-hours' }));
    if (g && !basic) lines.push(meterLine(G, S, `Data processed through the hubs, ${fmtN(g)} GB/month`, mt(`${hubName} Data Processed`, 'hub data processed'), g, ctx, { unit: 'GB' }));
    const perHub = (qty, name, what, label, unit, h = hours) => {
      if (!n(qty)) return;
      lines.push(meterLine(G, S, `${label}: ${fmtN(n(qty))} per hub x ${fmtN(hubs)} hub(s) x ${fmtN(h)} hours`, mt(name, what), n(qty) * hubs * h, ctx, { unit: unit || 'unit-hours' }));
    };
    perHub(c.extraRoutingUnits, 'Routing Infrastructure Unit', 'routing infrastructure units', 'Extra routing infrastructure units (2 per hub are included)');
    perHub(c.s2sScaleUnits, 'VPN S2S Scale Unit', 'site-to-site scale units', 'Site-to-site VPN scale units', null, s2sH);
    perHub(c.s2sConnectionUnits, 'VPN S2S Connection Unit', 'site-to-site connection units', 'Site-to-site VPN connection units', null, s2sH);
    perHub(c.p2sScaleUnits, 'VPN P2S Scale Unit', 'user VPN scale units', 'User VPN (point-to-site) scale units', null, p2sH);
    perHub(c.p2sConnectionUnits, 'VPN P2S Connection Unit', 'user VPN connection units', 'User VPN connection units', null, p2sH);
    const er = n(c.erScaleUnits);
    if (er) {
      const full = Math.min(er, 5), extra = Math.max(0, er - 5);
      perHub(full, 'ExpressRoute Scale Unit', 'ExpressRoute scale units', 'ExpressRoute scale units (first 5 per hub)', null, erH);
      perHub(extra, 'ExpressRoute Additional Scale Unit', 'ExpressRoute additional scale units', 'ExpressRoute additional scale units (above 5 per hub)', null, erH);
    }
    perHub(c.erConnectionUnits, 'ExpressRoute Connection Unit', 'ExpressRoute connection units', 'ExpressRoute connection units', null, erH);
    perHub(c.nvaInfraUnits, 'NVA Infrastructure Unit', 'NVA infrastructure units', 'NVA infrastructure units');
    if (n(c.nvaDataGB)) lines.push(meterLine(G, S, `Firewall NVA data processing, ${fmtN(n(c.nvaDataGB))} GB/month`, mt('Firewall NVA Data Processing Data Processed', 'NVA data processing'), n(c.nvaDataGB), ctx, { unit: 'GB' }));
    if (fwTier !== 'none') {
      const fw = FW[fwTier];
      const fr = await rows(`serviceName eq 'Azure Firewall' and ${regionFilter(ctx)} and priceType eq 'Consumption' and skuName eq '${q(fw.name)}'`, ctx);
      if (!fr.length) throw new PricingError(`Azure Firewall ${fw.label} in a secured hub is not priced in ${ctx.region}.`);
      lines.push(meterLine(G, 'Azure Firewall', `Azure Firewall ${fw.label} in the hub (secured virtual hub): ${fmtN(hubs)} hub(s) x ${fmtN(hours)} hours`, single(fr.filter(r => r.meterName === `${fw.name} Deployment`), `Azure Firewall ${fw.label} secured hub deployment`), hubs * hours, ctx, { unit: 'hours' }));
      if (n(c.firewallDataGB)) lines.push(meterLine(G, 'Azure Firewall', `Data inspected by Azure Firewall ${fw.label}, ${fmtN(n(c.firewallDataGB))} GB/month`, single(fr.filter(r => r.meterName === `${fw.name} Data Processed`), `Azure Firewall ${fw.label} secured hub data processed`), n(c.firewallDataGB), ctx, { unit: 'GB' }));
      const cu = n(c.firewallCapacityUnits);
      if (cu) lines.push(meterLine(G, 'Azure Firewall', `Azure Firewall ${fw.label} capacity units: ${fmtN(cu)} per hub x ${fmtN(hubs)} hub(s) x ${fmtN(hours)} hours`, single(fr.filter(r => r.meterName === `${fw.name} Capacity Unit`), `Azure Firewall ${fw.label} secured hub capacity unit`), cu * hubs * hours, ctx, { unit: 'unit-hours' }));
      notes.push('Azure Firewall in a hub is billed separately from the hub itself: per hour while deployed plus per GB processed.');
    } else if (n(c.firewallDataGB)) throw new PricingError('firewallDataGB was given but firewallTier is none; choose a firewallTier.');
    if (basic) notes.push('A Basic Virtual WAN has no hub fee and no data processing fee; only site-to-site VPN scale and connection units bill. Point-to-site, ExpressRoute, firewalls and NVAs need a Standard Virtual WAN.');
    else notes.push('A Standard hub bills per hour and per GB processed. Each hub includes 2 routing infrastructure units; only extra units are billed. Scale units and connection units bill per hour per hub.');
    if (!basic) notes.push('Hub data processing is charged for virtual-network-to-virtual-network transit (including via a remote hub). Branch-to-branch and branch-to-virtual-network traffic through the same hub is not charged for data processing. Standard data transfer charges for leaving Azure or crossing regions are separate.');
    return { lines, notes, facts: { wanType: wan, hubs, hours, thirdPartyIntegrations: third, dataProcessedGB: g, extraRoutingUnits: n(c.extraRoutingUnits), s2sScaleUnits: n(c.s2sScaleUnits), p2sScaleUnits: n(c.p2sScaleUnits), erScaleUnits: er, scaleUnits: n(c.s2sScaleUnits) + n(c.p2sScaleUnits) + er, nvaInfraUnits: n(c.nvaInfraUnits), firewallTier: fwTier } };
  }
};
