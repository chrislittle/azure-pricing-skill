'use strict';
// Azure VPN Gateway: gateway SKUs (Basic, VpnGw1-5 and zone-redundant AZ variants), site-to-site tunnels and
// point-to-site connections above the amounts each SKU includes, and the Advanced Connectivity add-on.
// Meters: serviceName 'VPN Gateway', regional, hourly. S2S/P2S connection meters are shared by all SKUs
// (rows() keeps one copy of the shared meterId), so they are matched on meterName.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS, q } = require('../kit');

const n = v => Number(v || 0);

// Included and maximum counts per SKU, from the Azure Pricing Calculator data (the same limits as the VPN Gateway SKU table).
const SKUS = {
  basic:    { meter: 'Basic Gateway', label: 'Basic', inclS2S: 10, maxS2S: 10, inclP2S: 128, maxP2S: 128, az: false },
  vpngw1:   { meter: 'VpnGw1', label: 'VpnGw1', inclS2S: 10, maxS2S: 30, inclP2S: 128, maxP2S: 250, az: false },
  vpngw2:   { meter: 'VpnGw2', label: 'VpnGw2', inclS2S: 10, maxS2S: 30, inclP2S: 128, maxP2S: 500, az: false },
  vpngw3:   { meter: 'VpnGw3', label: 'VpnGw3', inclS2S: 10, maxS2S: 30, inclP2S: 128, maxP2S: 1000, az: false },
  vpngw4:   { meter: 'VpnGw4', label: 'VpnGw4', inclS2S: 10, maxS2S: 100, inclP2S: 128, maxP2S: 5000, az: false },
  vpngw5:   { meter: 'VpnGw5', label: 'VpnGw5', inclS2S: 10, maxS2S: 100, inclP2S: 128, maxP2S: 10000, az: false },
  vpngw1az: { meter: 'VpnGw1AZ', label: 'VpnGw1AZ', inclS2S: 10, maxS2S: 30, inclP2S: 128, maxP2S: 250, az: true },
  vpngw2az: { meter: 'VpnGw2AZ', label: 'VpnGw2AZ', inclS2S: 10, maxS2S: 30, inclP2S: 128, maxP2S: 500, az: true },
  vpngw3az: { meter: 'VpnGw3AZ', label: 'VpnGw3AZ', inclS2S: 10, maxS2S: 30, inclP2S: 128, maxP2S: 1000, az: true },
  vpngw4az: { meter: 'VpnGw4AZ', label: 'VpnGw4AZ', inclS2S: 10, maxS2S: 100, inclP2S: 128, maxP2S: 5000, az: true },
  vpngw5az: { meter: 'VpnGw5AZ', label: 'VpnGw5AZ', inclS2S: 10, maxS2S: 100, inclP2S: 128, maxP2S: 10000, az: true }
};

// Inter-VNet data transfer is billed on the source region's zone (productName 'VPN Gateway Bandwidth'), not on the region.
const ZONE1 = ['eastus', 'eastus2', 'centralus', 'northcentralus', 'southcentralus', 'westcentralus', 'westus', 'westus2', 'westus3', 'canadacentral', 'canadaeast', 'northeurope', 'westeurope', 'uksouth', 'ukwest', 'francecentral', 'francesouth', 'germanywestcentral', 'germanynorth', 'norwayeast', 'norwaywest', 'switzerlandnorth', 'switzerlandwest', 'australiacentral', 'australiacentral2'];
const ZONE2 = ['australiaeast', 'australiasoutheast', 'centralindia', 'southindia', 'westindia', 'japaneast', 'japanwest', 'koreacentral', 'koreasouth', 'eastasia', 'southeastasia'];
const ZONE3 = ['brazilsouth', 'brazilsoutheast', 'southafricanorth', 'southafricawest', 'uaenorth', 'uaecentral'];
const ZONE_NAMES = { zone1: 'Zone 1', zone2: 'Zone 2', zone3: 'Zone 3', 'usgov-zone1': 'US Gov Zone 1' };
const bandwidthZone = region => {
  const r = String(region || '').toLowerCase();
  if (/^usgov/.test(r)) return 'US Gov Zone 1';
  if (ZONE1.includes(r)) return 'Zone 1';
  if (ZONE2.includes(r)) return 'Zone 2';
  if (ZONE3.includes(r)) return 'Zone 3';
  throw new PricingError(`VPN Gateway inter-virtual-network data transfer: no billing zone is known for ${region}. Check the zone on the Azure VPN Gateway pricing page, or price this region without interVnetGB.`);
};

module.exports = {
  type: 'vpn-gateway',
  label: 'Azure VPN Gateway',
  family: 'networking-gateways',
  calculator: ['vpn-gateway'],
  keywords: ['vpn', 'vpn gateway', 'site to site', 'point to site', 'remote access', 'tunnel', 'hybrid connectivity', 'branch office'],
  fields: {
    sku: { req: true, def: 'vpngw1az', enum: Object.keys(SKUS), ask: 'How much VPN throughput do they need? Up to ~100 Mbps for dev/test only -> basic; ~650 Mbps -> vpngw1az; ~1 Gbps -> vpngw2az; ~1.25 Gbps -> vpngw3az; ~5 Gbps -> vpngw4az; ~10 Gbps -> vpngw5az. Always use the zone-redundant AZ SKUs: new non-AZ VpnGw1-5 gateways cannot be created and are refused. If unknown, suggest vpngw1az and record it as an assumption.' },
    gateways: { def: 1, int: true, min: 1, ask: 'How many VPN gateways (for example one per virtual network or region)?' },
    s2sTunnels: { def: 0, int: true, min: 0, ask: 'Site-to-site VPN: how many tunnels to on-premises sites or other networks does each gateway need? Each SKU includes 10 for free; only tunnels above that are billed.' },
    p2sConnections: { def: 0, int: true, min: 0, ask: 'Point-to-site VPN: how many remote users or laptops connect to each gateway at the same time? Each SKU includes 128 for free; only connections above that are billed.' },
    advancedConnectivity: { def: false, ask: 'Only if they were told to enable the VPN Gateway "Advanced Connectivity" add-on (high-bandwidth tunnels; it exists only for the new VpnGw5AZ gateway): true or false?' },
    interVnetGB: { def: 0, min: 0, ask: 'How many GB a month does each gateway send to virtual networks in OTHER Azure regions over VNet-to-VNet connections? Same-region traffic and inbound traffic are free. Use 0 if none.' },
    interVnetZone: { enum: Object.keys(ZONE_NAMES), ask: 'Only when interVnetGB is used: the billing zone of the sending region, if it is not obvious. Most of North America and Europe is zone1; much of Asia-Pacific is zone2; Brazil, South Africa and the UAE are zone3; US Government regions are usgov-zone1. Leave empty to derive it from the region.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Hours a month each gateway exists (730 = all month; a gateway bills while it exists even when idle).' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'vpn-gateway', sku: 'vpngw1az' },
    { type: 'vpn-gateway', sku: 'vpngw5az', gateways: 2, s2sTunnels: 20, p2sConnections: 300, advancedConnectivity: true, interVnetGB: 1000, hours: 730 },
    { type: 'vpn-gateway', sku: 'basic', hours: 200 }
  ],
  readback: c => {
    const sku = SKUS[(c.sku || 'vpngw1az').toLowerCase()];
    const hours = c.hours ?? HOURS;
    const parts = [`${fmtN(n(c.gateways) || 1)} gateway(s), ${hours === HOURS ? 'running all month' : `${fmtN(hours)} hours a month`}`];
    parts.push(`${fmtN(n(c.s2sTunnels))} site-to-site tunnels per gateway`);
    parts.push(`${fmtN(n(c.p2sConnections))} point-to-site connections per gateway`);
    if (c.advancedConnectivity) parts.push('with the Advanced Connectivity add-on');
    if (n(c.interVnetGB)) parts.push(`${fmtN(c.interVnetGB)} GB a month to other regions over VNet-to-VNet per gateway`);
    return `VPN Gateway ${sku ? sku.label : c.sku}${sku && sku.az ? ' (zone-redundant)' : ''}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The public IP address(es) each VPN gateway needs (a Standard public IP is billed separately; active-active gateways need two)',
    'Outbound internet and point-to-site data transfer (billed as standard bandwidth); VNet-to-VNet transfer between regions is priced here when interVnetGB is given',
    'ExpressRoute gateways (virtual network gateway of type ExpressRoute): price them with the expressroute type, kind gateway'
  ],
  price: async (c, ctx) => {
    const key = (c.sku || 'vpngw1az').toLowerCase();
    const sku = SKUS[key];
    if (!sku) throw new PricingError(`Unknown VPN gateway sku "${c.sku}". Use one of: ${Object.keys(SKUS).join(', ')}.`);
    if (/^vpngw[1-5]$/.test(key)) throw new PricingError(`${sku.label} (not zone-redundant) cannot be created: since 1 November 2025 new VPN gateways must use an availability-zone SKU, and VpnGw1-5 non-AZ SKUs retire on 30 September 2026 (Microsoft Learn, VPN Gateway SKU consolidation). Use ${key}az instead.`);
    const gateways = c.gateways == null ? 1 : n(c.gateways);
    const hours = c.hours ?? HOURS;
    if (gateways < 1) throw new PricingError('gateways must be at least 1.');
    const vnetGb = n(c.interVnetGB);
    if (vnetGb < 0) throw new PricingError('interVnetGB cannot be negative.');
    if (c.advancedConnectivity && key !== 'vpngw5az') throw new PricingError('The Advanced Connectivity add-on (high-bandwidth tunnels) is available only on VpnGw5AZ gateways; use sku vpngw5az or drop the add-on.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const s2s = n(c.s2sTunnels), p2s = n(c.p2sConnections);
    if (s2s > sku.maxS2S) throw new PricingError(`${sku.label} supports at most ${sku.maxS2S} site-to-site tunnels; pick a larger sku.`);
    if (p2s > sku.maxP2S) throw new PricingError(`${sku.label} supports at most ${sku.maxP2S} point-to-site connections; pick a larger sku.`);
    const rs = await rows(`serviceName eq 'VPN Gateway' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`VPN Gateway is not priced in ${ctx.region}.`);
    const byMeter = (name, what) => {
      const m = rs.filter(r => r.meterName === name);
      if (!m.length && name === sku.meter) throw new PricingError(`${sku.label} gateway has no price in ${ctx.region}; use a nearby region that offers it.`);
      return single(m, `VPN Gateway ${what} in ${ctx.region}`);
    };
    const G = 'Networking', S = 'VPN Gateway', lines = [];
    lines.push(meterLine(G, S, `VPN gateway ${sku.label}${sku.az ? ' (zone-redundant)' : ''}, ${fmtN(gateways)} gateway(s) x ${fmtN(hours)} hours`, byMeter(sku.meter, `${sku.label} gateway`), gateways * hours, ctx, { unit: 'hours' }));
    const extraS2S = Math.max(0, s2s - sku.inclS2S), extraP2S = Math.max(0, p2s - sku.inclP2S);
    if (extraS2S) lines.push(meterLine(G, S, `Site-to-site tunnels above the ${sku.inclS2S} included: ${fmtN(extraS2S)} per gateway x ${fmtN(gateways)} gateway(s) x ${fmtN(hours)} hours`, byMeter('S2S Connection', 'site-to-site tunnels'), extraS2S * gateways * hours, ctx, { unit: 'tunnel-hours' }));
    if (extraP2S) lines.push(meterLine(G, S, `Point-to-site connections above the ${sku.inclP2S} included: ${fmtN(extraP2S)} per gateway x ${fmtN(gateways)} gateway(s) x ${fmtN(hours)} hours`, byMeter('P2S Connection', 'point-to-site connections'), extraP2S * gateways * hours, ctx, { unit: 'connection-hours' }));
    if (c.advancedConnectivity) lines.push(meterLine(G, S, `Advanced Connectivity add-on, ${fmtN(gateways)} gateway(s) x ${fmtN(hours)} hours`, byMeter('Advanced Connectivity Add-On', 'Advanced Connectivity add-on'), gateways * hours, ctx, { unit: 'hours' }));
    if (vnetGb) {
      const zone = c.interVnetZone ? ZONE_NAMES[String(c.interVnetZone).toLowerCase()] : bandwidthZone(ctx.region);
      if (!zone) throw new PricingError(`Unknown interVnetZone "${c.interVnetZone}". Use one of: ${Object.keys(ZONE_NAMES).join(', ')}.`);
      const br = await rows(`serviceName eq 'VPN Gateway' and productName eq 'VPN Gateway Bandwidth' and armRegionName eq '${q(zone)}' and meterName eq 'Standard Inter-Virtual Network Data Transfer Out' and priceType eq 'Consumption'`, ctx);
      lines.push(meterLine(G, S, `VNet-to-VNet data sent to other regions (${zone}): ${fmtN(vnetGb)} GB per gateway x ${fmtN(gateways)} gateway(s)`, single(br, `VPN Gateway inter-VNet data transfer out in ${zone}`), vnetGb * gateways, ctx, { unit: 'GB' }));
    }
    const notes = [
      `A ${sku.label} gateway includes ${sku.inclS2S} site-to-site tunnels and ${sku.inclP2S} point-to-site connections; only tunnels or connections above that are billed per hour (up to ${sku.maxS2S} tunnels and ${fmtN(sku.maxP2S)} connections).`,
      'A VPN gateway bills for every hour it exists, even when no traffic flows. A partial hour is billed as a full hour.',
      'VNet-to-VNet transfer is billed on the sending gateway\'s zone; inbound transfer and transfer between virtual networks in the same region are free.'
    ];
    return { lines, notes, facts: { sku: key, zoneRedundant: sku.az, gateways, s2sTunnels: s2s, p2sConnections: p2s, hours, advancedConnectivity: !!c.advancedConnectivity, interVnetGB: vnetGb } };
  }
};
