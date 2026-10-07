'use strict';
// Azure Virtual Network features that carry a charge: virtual network peering (same-region and global), Accelerated
// Connections, the virtual network routing appliance and Virtual Network TAP. The virtual network itself is free.
// Meters: serviceName 'Virtual Network'. Same-region peering is regionless (Global); global peering is priced per
// region (egress where the data leaves, ingress where it arrives); the rest are hourly.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const applianceGbps = c => n(c.routingApplianceGbps) || LEGACY_SKU[String(c.routingApplianceSku || '').toLowerCase()] || 10;

const ACCEL = { a1: 'A1', a2: 'A2', a4: 'A4', a8: 'A8' };
// Bandwidth per appliance -> billed units: 10 Gbps is one Basic unit; 50, 100 and 200 Gbps are 1, 2 and 4 Standard units.
const APPLIANCE = { 10: { meter: 'Basic Appliance Unit', units: 1 }, 50: { meter: 'Standard Appliance Standard Unit', units: 1 }, 100: { meter: 'Standard Appliance Standard Unit', units: 2 }, 200: { meter: 'Standard Appliance Standard Unit', units: 4 } };
const LEGACY_SKU = { basic: 10, standard: 50 };

module.exports = {
  type: 'vnet-peering',
  label: 'Azure Virtual Network (peering and network add-ons)',
  family: 'networking-core',
  calculator: ['virtual-network'],
  keywords: ['vnet peering', 'virtual network peering', 'hub and spoke', 'peered networks', 'global peering', 'accelerated connections', 'network tap', 'routing appliance'],
  fields: {
    sameRegionGB: { req: true, min: 0, ask: 'If virtual networks in the SAME region are peered: roughly how many GB a month move between them in total (both directions added up)? Each GB is charged on the way out and again on the way in. Use 0 if there is no same-region peering.' },
    peerRegion: { def: '', ask: 'Only for peering ACROSS regions: which Azure region is the other virtual network in (for example westeurope or West Europe)? The region of the estimate is this side. Both sides must be in the same cloud (commercial or US Gov). Leave empty if there is no cross-region peering.' },
    globalOutGB: { def: 0, min: 0, ask: 'Cross-region peering: GB a month sent FROM the virtual network in the estimate\'s region TO the one in the other region.' },
    globalInGB: { def: 0, min: 0, ask: 'Cross-region peering: GB a month sent TO the virtual network in the estimate\'s region FROM the one in the other region.' },
    acceleratedConnectionsNics: { def: 0, int: true, min: 0, ask: 'Only if they use Accelerated Connections (higher connections per second for network-heavy VMs): how many network interfaces use it?' },
    acceleratedConnectionsSku: { def: 'a1', enum: Object.keys(ACCEL), ask: 'Accelerated Connections size per interface: up to 100K connections per second -> a1; up to 250K -> a2; up to 600K -> a4; up to 1.5M -> a8. If unknown, suggest a1 and record it as an assumption.' },
    routingAppliances: { def: 0, int: true, min: 0, ask: 'Only if they use the virtual network routing appliance: how many appliances? (A subscription can have up to two per region.)' },
    routingApplianceGbps: { def: 10, enum: [10, 50, 100, 200], ask: 'Bandwidth of each routing appliance, chosen when it is created: 10, 50, 100 or 200 Gbps. If unknown, suggest 10 and record it as an assumption.' },
    routingApplianceSku: { enum: Object.keys(LEGACY_SKU), ask: 'Do not ask this. Old name for the appliance size (basic = 10 Gbps, standard = 50 Gbps); use routingApplianceGbps instead.' },
    tapNics: { def: 0, int: true, min: 0, ask: 'Only if they copy network traffic to a monitoring appliance with Virtual Network TAP: how many network interfaces are mirrored?' },
    hours: { def: 730, ask: 'Hours a month the hourly items (Accelerated Connections, routing appliance, TAP) run; 730 = all month.' }
  },
  context: ['production', 'privateOnly'],
  examples: [
    { type: 'vnet-peering', sameRegionGB: 500 },
    { type: 'vnet-peering', sameRegionGB: 2000, peerRegion: 'westeurope', globalOutGB: 800, globalInGB: 300, acceleratedConnectionsNics: 4, acceleratedConnectionsSku: 'a2', routingAppliances: 1, routingApplianceGbps: 10, tapNics: 2, hours: 730 }
  ],
  testRegions: ['eastus2', 'northeurope'],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    const time = hrs === HOURS ? 'all month' : `${fmtN(hrs)} hours a month`;
    const parts = [`${fmtN(n(c.sameRegionGB))} GB a month between same-region peered networks`];
    if (n(c.globalOutGB) || n(c.globalInGB)) parts.push(`cross-region peering with ${c.peerRegion || 'another region'}: ${fmtN(n(c.globalOutGB))} GB a month out and ${fmtN(n(c.globalInGB))} GB a month in`);
    if (n(c.acceleratedConnectionsNics)) parts.push(`${fmtN(c.acceleratedConnectionsNics)} network interface(s) with Accelerated Connections ${(c.acceleratedConnectionsSku || 'a1').toUpperCase()}, ${time}`);
    if (n(c.routingAppliances)) parts.push(`${fmtN(c.routingAppliances)} routing appliance(s) of ${applianceGbps(c)} Gbps, ${time}`);
    if (n(c.tapNics)) parts.push(`${fmtN(c.tapNics)} network interface(s) mirrored with TAP, ${time}`);
    return `Virtual Network: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Public IP addresses (see the public-ip component) and any gateways or firewalls inside the virtual networks'
  ],
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    for (const k of ['sameRegionGB', 'globalOutGB', 'globalInGB', 'acceleratedConnectionsNics', 'routingAppliances', 'tapNics']) if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    const accel = ACCEL[(c.acceleratedConnectionsSku || 'a1').toLowerCase()];
    const gbps = applianceGbps(c);
    const app = APPLIANCE[gbps];
    if (!accel) throw new PricingError(`Unknown acceleratedConnectionsSku "${c.acceleratedConnectionsSku}". Use a1, a2, a4 or a8.`);
    if (!app) throw new PricingError(`routingApplianceGbps must be 10, 50, 100 or 200 (got ${gbps}).`);
    const G = 'Networking', S = 'Virtual Network', lines = [];
    const base = `serviceName eq 'Virtual Network' and priceType eq 'Consumption'`;
    const gov = /^usgov/i.test(ctx.region || '');
    if (gov && (n(c.acceleratedConnectionsNics) || n(c.routingAppliances))) throw new PricingError('Accelerated Connections and the routing appliance have no published US Gov price, so they cannot be priced here.');
    const same = n(c.sameRegionGB);
    if (same) {
      const rs = await rows(`${base} and productName eq 'Virtual Network Peering' and armRegionName eq '${gov ? 'US Gov' : 'Global'}'`, ctx);
      const eg = single(rs.filter(r => r.meterName === 'Intra-Region Egress'), 'same-region peering outbound data');
      const ing = single(rs.filter(r => r.meterName === 'Intra-Region Ingress'), 'same-region peering inbound data');
      lines.push(meterLine(G, S, `Same-region peering, data leaving the source network, ${fmtN(same)} GB`, eg, same, ctx, { unit: 'GB' }));
      lines.push(meterLine(G, S, `Same-region peering, data arriving at the destination network, ${fmtN(same)} GB`, ing, same, ctx, { unit: 'GB' }));
    }
    if (n(c.globalOutGB) || n(c.globalInGB)) {
      const peer = c.peerRegion ? require('../estimate').normalizeRegion(c.peerRegion).code : '';
      if (!peer) throw new PricingError('Cross-region peering needs peerRegion (the other virtual network\'s Azure region, for example westeurope).');
      if (/^usgov/.test(peer) !== gov) throw new PricingError('Azure Government and commercial Azure are separate clouds: virtual networks cannot be peered across them, so there is no price for this peering.');
      if (peer === ctx.region) throw new PricingError('peerRegion is the same as the estimate\'s region: use sameRegionGB for peering inside one region.');
      const side = async region => {
        const rs = await rows(`${base} and productName eq 'Global Virtual Network Peering' and armRegionName eq '${region.replace(/'/g, "''")}'`, ctx);
        if (!rs.length) throw new PricingError(`Global virtual network peering is not priced in ${region}.`);
        return { eg: single(rs.filter(r => r.meterName === 'Inter-Region Egress'), `global peering outbound data in ${region}`), ing: single(rs.filter(r => r.meterName === 'Inter-Region Ingress'), `global peering inbound data in ${region}`) };
      };
      const here = await side(ctx.region), there = await side(peer);
      if (n(c.globalOutGB)) {
        lines.push(meterLine(G, S, `Global peering, data leaving ${ctx.region}, ${fmtN(c.globalOutGB)} GB`, here.eg, n(c.globalOutGB), ctx, { unit: 'GB' }));
        lines.push(meterLine(G, S, `Global peering, data arriving in ${peer}, ${fmtN(c.globalOutGB)} GB`, there.ing, n(c.globalOutGB), ctx, { unit: 'GB' }));
      }
      if (n(c.globalInGB)) {
        lines.push(meterLine(G, S, `Global peering, data leaving ${peer}, ${fmtN(c.globalInGB)} GB`, there.eg, n(c.globalInGB), ctx, { unit: 'GB' }));
        lines.push(meterLine(G, S, `Global peering, data arriving in ${ctx.region}, ${fmtN(c.globalInGB)} GB`, here.ing, n(c.globalInGB), ctx, { unit: 'GB' }));
      }
    }
    if (n(c.acceleratedConnectionsNics)) {
      const rs = await rows(`${base} and productName eq 'Accelerated Connections' and armRegionName eq 'Global'`, ctx);
      lines.push(meterLine(G, S, `Accelerated Connections ${accel}, ${fmtN(c.acceleratedConnectionsNics)} interface(s) x ${fmtN(hours)} hours`, single(rs.filter(r => r.meterName === `${accel} Management NIC`), `Accelerated Connections ${accel}`), n(c.acceleratedConnectionsNics) * hours, ctx, { unit: 'NIC-hours' }));
    }
    if (n(c.routingAppliances)) {
      const rs = await rows(`${base} and productName eq 'Virtual Network Routing Appliance' and armRegionName eq 'Global'`, ctx);
      lines.push(meterLine(G, S, `Virtual network routing appliance (${gbps} Gbps${app.units > 1 ? `, billed as ${app.units} Standard units` : ''}), ${fmtN(c.routingAppliances)} x ${fmtN(hours)} hours`, single(rs.filter(r => r.meterName === app.meter), `${gbps} Gbps routing appliance`), n(c.routingAppliances) * hours * app.units, ctx, { unit: 'hours' }));
    }
    if (n(c.tapNics)) {
      const rs = await rows(`${base} and productName eq 'Virtual Network' and skuName eq 'TAP' and armRegionName eq '${gov ? 'US Gov Zone 1' : ''}'`, ctx);
      lines.push(meterLine(G, S, `Virtual Network TAP, ${fmtN(c.tapNics)} interface(s) x ${fmtN(hours)} hours`, single(rs, 'Virtual Network TAP'), n(c.tapNics) * hours, ctx, { unit: 'NIC-hours' }));
    }
    if (!lines.length) throw new PricingError('Nothing to price: virtual networks are free; set a peering volume, Accelerated Connections, a routing appliance or TAP.');
    const notes = [
      'The virtual network itself is free. Peering charges apply in both directions: a GB sent between peered networks is charged on the way out of the source and again on the way in at the destination.',
      'Cross-region (global) peering is priced by the region where the data leaves and the region where it arrives; the rate depends on each region\'s pricing zone.'
    ];
    if (gov) notes.push('US Gov regions have their own prices for same-region peering ($0.0125 a GB each way), global peering between Gov regions ($0.044 a GB each way) and TAP.');
    if (n(c.tapNics) || n(c.routingAppliances)) notes.push('Virtual Network TAP and the routing appliance are only offered in selected regions: confirm the region supports them before quoting.');
    if (n(c.acceleratedConnectionsNics)) notes.push('Accelerated Connections is billed per interface per hour once the interface is attached to a running VM; it is in limited availability.');
    return { lines, notes, facts: { sameRegionGB: same, globalGB: n(c.globalOutGB) + n(c.globalInGB), acceleratedConnectionsNics: n(c.acceleratedConnectionsNics), routingAppliances: n(c.routingAppliances), tapNics: n(c.tapNics), hours } };
  }
};
