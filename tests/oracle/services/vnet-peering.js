'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'virtual-network';
const HOURS = 730;
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length < 1) throw new Error('no Retail API row for ' + what); return hits[0]; }
async function offer(name, region) { return (await calc.offerPrice(SLUG, name, region)).value; }
function billingZone(region) {
  if (region === 'usgovvirginia' || region === 'usgovtexas' || region === 'usgovarizona') return 'usgovzone1';
  if (region === 'japaneast' || region === 'japanwest' || region === 'eastasia' || region === 'southeastasia') return 'zone2';
  if (region === 'brazilsouth' || region === 'southafricanorth') return 'zone3';
  return 'zone1';
}
function peeringOffer(direction, region) { return `across-${direction}-${billingZone(region)}`; }
async function routingApplianceHourly(region, gbps) {
  if (gbps === 10) return { price: await offer('routing-appliance-basic', region), sourceOffer: 'routing-appliance-basic' };
  const standard = await offer('routing-appliance-standard', region);
  return { price: standard * (gbps / 50), sourceOffer: 'routing-appliance-standard x ' + (gbps / 50) };
}
async function vnet(o) { const currency = o.currency || 'USD', region = o.region || 'eastus2', peerRegion = o.peerRegion || region, hours = o.hours ?? HOURS, lines = []; if (currency === 'USD') { if (o.sameRegionGB) { const out = await offer('same-outbound', region), inn = await offer('same-inbound', region); lines.push(line('Same-region peering: ' + o.sameRegionGB + ' GB * outbound ' + out + ' + inbound ' + inn, o.sameRegionGB * (out + inn), { sourceOffer: 'same-outbound/same-inbound' })); } if (o.globalOutGB) { const outOffer = peeringOffer('outbound', region), inOffer = peeringOffer('inbound', peerRegion); const out = await offer(outOffer, region), inn = await offer(inOffer, peerRegion); lines.push(line('Global peering ' + region + ' -> ' + peerRegion + ': ' + o.globalOutGB + ' GB * outbound ' + out + ' + peer inbound ' + inn, o.globalOutGB * (out + inn), { sourceOffer: outOffer + '/' + inOffer })); } if (o.globalInGB) { const outOffer = peeringOffer('outbound', peerRegion), inOffer = peeringOffer('inbound', region); const out = await offer(outOffer, peerRegion), inn = await offer(inOffer, region); lines.push(line('Global peering ' + peerRegion + ' -> ' + region + ': ' + o.globalInGB + ' GB * peer outbound ' + out + ' + inbound ' + inn, o.globalInGB * (out + inn), { sourceOffer: outOffer + '/' + inOffer })); } if (o.acceleratedConnectionsNics) { const offerName = 'accelerated-connections-' + (o.acceleratedConnectionsSku || 'a1'); const p = await offer(offerName, region); lines.push(line('Accelerated Connections ' + (o.acceleratedConnectionsSku || 'a1') + ': ' + o.acceleratedConnectionsNics + ' NICs * ' + hours + ' h * ' + p, o.acceleratedConnectionsNics * hours * p, { sourceOffer: offerName })); } if (o.routingAppliances) { const gbps = o.routingApplianceGbps || 10; const rp = await routingApplianceHourly(region, gbps); lines.push(line('Routing appliance ' + gbps + ' Gbps: ' + o.routingAppliances + ' * ' + hours + ' h * ' + rp.price, o.routingAppliances * hours * rp.price, { sourceOffer: rp.sourceOffer })); } if (o.tapNics) { const p = await offer('virtual-network-tap', region); lines.push(line('Virtual Network TAP: ' + o.tapNics + ' NICs * ' + hours + ' h * ' + p, o.tapNics * hours * p, { sourceOffer: 'virtual-network-tap' })); } } else { const rows = dedupe(await query("serviceName eq 'Virtual Network'", currency)); if (o.globalOutGB) lines.push(line('Global peering outbound: ' + o.globalOutGB + ' GB', o.globalOutGB * 2 * pick(rows, r => r.productName === 'Global Virtual Network Peering' && r.meterName === 'Inter-Region Egress' && r.armRegionName === 'westeurope', 'Inter-Region Egress').retailPrice)); if (o.globalInGB) lines.push(line('Global peering inbound: ' + o.globalInGB + ' GB', o.globalInGB * 2 * pick(rows, r => r.productName === 'Global Virtual Network Peering' && r.meterName === 'Inter-Region Ingress' && r.armRegionName === 'westeurope', 'Inter-Region Ingress').retailPrice)); if (o.tapNics) lines.push(line('Virtual Network TAP: ' + o.tapNics + ' NICs * ' + hours + ' h', o.tapNics * hours * pick(rows, r => r.productName === 'Virtual Network' && r.skuName === 'TAP' && r.armRegionName === 'Zone 1', 'TAP').retailPrice)); } return { monthlyList: totalOf(lines), lines }; }
module.exports = { type: 'vnet-peering', source: 'both', cases: [
  { name: 'same-region peering double charged', region: 'eastus2', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 100 },
    // Calculator same-outbound and same-inbound offers both apply to each same-region peering GB.
    expected: () => vnet({ region: 'eastus2', sameRegionGB: 100 }) },
  { name: 'global peering to Europe zone1', region: 'eastus2', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 0, peerRegion: 'westeurope', globalOutGB: 100, globalInGB: 50 },
    // East US 2 and West Europe are both Zone 1; each direction is charged once for source outbound and once for peer inbound.
    expected: () => vnet({ region: 'eastus2', peerRegion: 'westeurope', globalOutGB: 100, globalInGB: 50 }) },
  { name: 'global peering cross-zone eastus2 to Japan', region: 'eastus2', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 0, peerRegion: 'japaneast', globalOutGB: 100, globalInGB: 50 },
    // Live calculator rates: Zone 1 outbound/inbound $0.035 and Zone 2 outbound/inbound $0.09; 100*(0.035+0.09)+50*(0.09+0.035) = $18.75.
    expected: () => vnet({ region: 'eastus2', peerRegion: 'japaneast', globalOutGB: 100, globalInGB: 50 }) },
  { name: 'US Gov global peering one way', region: 'usgovvirginia', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 0, peerRegion: 'usgovtexas', globalOutGB: 100, globalInGB: 0 },
    // Live calculator US Gov Zone 1 outbound and inbound are $0.044; 100*(0.044+0.044) = $8.80.
    expected: () => vnet({ region: 'usgovvirginia', peerRegion: 'usgovtexas', globalOutGB: 100, globalInGB: 0 }) },
  { name: 'accelerated connections all sizes', region: 'eastus2', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 0, acceleratedConnectionsNics: 1, acceleratedConnectionsSku: 'a8', hours: 100 },
    // Accelerated Connections A8 is an hourly NIC add-on from the calculator virtual-network offer set.
    expected: () => vnet({ region: 'eastus2', acceleratedConnectionsNics: 1, acceleratedConnectionsSku: 'a8', hours: 100 }) },
  { name: 'routing appliance and TAP non-US', region: 'westeurope', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 0, routingAppliances: 2, routingApplianceGbps: 10, tapNics: 3, hours: 365 },
    // West Europe calculator prices cover 10 Gbps routing appliance hours (basic offer) and Virtual Network TAP NIC-hours.
    expected: () => vnet({ region: 'westeurope', routingAppliances: 2, routingApplianceGbps: 10, tapNics: 3, hours: 365 }) },

  { name: 'routing appliance 50 Gbps', region: 'eastus2', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 0, routingAppliances: 1, routingApplianceGbps: 50, hours: 100 },
    // Calculator standard routing-appliance offer is the 50 Gbps hourly price.
    expected: () => vnet({ region: 'eastus2', routingAppliances: 1, routingApplianceGbps: 50, hours: 100 }) },
  { name: 'routing appliance 100 Gbps', region: 'eastus2', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 0, routingAppliances: 1, routingApplianceGbps: 100, hours: 100 },
    // 100 Gbps is two 50 Gbps standard routing-appliance units; calculator standard price scales linearly from the documented bandwidth unit.
    expected: () => vnet({ region: 'eastus2', routingAppliances: 1, routingApplianceGbps: 100, hours: 100 }) },
  { name: 'routing appliance 200 Gbps', region: 'eastus2', currency: 'USD', component: { type: 'vnet-peering', sameRegionGB: 0, routingAppliances: 1, routingApplianceGbps: 200, hours: 100 },
    // 200 Gbps is four 50 Gbps standard routing-appliance units; calculator standard price scales linearly from the documented bandwidth unit.
    expected: () => vnet({ region: 'eastus2', routingAppliances: 1, routingApplianceGbps: 200, hours: 100 }) },
  { name: 'EUR global peering and TAP', region: 'westeurope', currency: 'EUR', component: { type: 'vnet-peering', sameRegionGB: 0, peerRegion: 'eastus2', globalOutGB: 10, globalInGB: 10, tapNics: 1, hours: 100 },
    // Retail API EUR westeurope rows cover inter-region ingress/egress plus Zone 1 TAP NIC-hour.
    expected: () => vnet({ currency: 'EUR', region: 'westeurope', peerRegion: 'eastus2', globalOutGB: 10, globalInGB: 10, tapNics: 1, hours: 100 }) },
] };
