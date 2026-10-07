'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'route-server';
const HOURS = 730;
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, amount, extra = {}) { return { desc, monthlyList: round2(amount), ...extra }; }
async function productV3() { const res = await fetch(`https://azure.microsoft.com/api/v3/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!res.ok) throw new Error(`calculator v3 ${SLUG} HTTP ${res.status}`); return res.json(); }
async function priceV3(offer, armRegion) { const d = await productV3(); const slug = calc.calcRegion(d, armRegion); const p = d.offers[offer]?.prices?.perhour?.[slug]; if (!p) throw new Error(`route-server calculator v3 missing ${offer}/${slug}`); return p.value; }
async function calculatorRouteServer(opts) {
  const { region, servers = 1, routeMaps = false, connectedVms = 0, expressRouteConnections = 0, vpnConnections = 0, nvaConnections = 0, hours = HOURS } = opts;
  const lines = [];
  const baseOffer = routeMaps ? 'route-server-route-maps' : 'gateway';
  const baseRate = await priceV3(baseOffer, region);
  lines.push(line(`${servers} Route Servers${routeMaps ? ' with Route Maps' : ''} * ${hours} hours * ${baseRate}`, servers * hours * baseRate, { sourceOffer: baseOffer }));
  const extraUnits = Math.max(0, Math.ceil((connectedVms - 4000) / 1000));
  if (extraUnits) { const r = await priceV3('routing-infrastructure', region); lines.push(line(`Routing Infrastructure beyond 4,000 VMs: ${servers} servers * ${extraUnits} units * ${hours} hours * ${r}`, servers * extraUnits * hours * r, { sourceOffer: 'routing-infrastructure' })); }
  if (expressRouteConnections) { const r = await priceV3('express-route-connection-unit', region); lines.push(line(`ExpressRoute connection units: ${servers} servers * ${expressRouteConnections} connections * ${hours} hours * ${r}`, servers * expressRouteConnections * hours * r, { sourceOffer: 'express-route-connection-unit' })); }
  if (vpnConnections) { const r = await priceV3('azure-route-server', region); lines.push(line(`VPN S2S connection units: ${servers} servers * ${vpnConnections} connections * ${hours} hours * ${r}`, servers * vpnConnections * hours * r, { sourceOffer: 'azure-route-server' })); }
  if (routeMaps && nvaConnections) { const r = await priceV3('basic-gateway-with-route-maps', region); lines.push(line(`NVA connections with Route Maps: ${servers} servers * ${nvaConnections} connections * ${hours} hours * ${r}`, servers * nvaConnections * hours * r, { sourceOffer: 'basic-gateway-with-route-maps' })); }
  return { monthlyList: totalOf(lines), lines };
}
async function retailRouteServerEur() {
  const rows = dedupe(await query(`serviceName eq 'Azure Route Server' and armRegionName eq 'Global'`, 'EUR'));
  const pick = (meterName) => { const hit = rows.find(r => r.meterName === meterName); if (!hit) throw new Error(`Route Server EUR row not found: ${meterName}`); return hit; };
  const routeMaps = pick('Basic Gateway with Route Maps Unit'), routing = pick('Routing Infrastructure Unit'), nva = pick('NVA Connection with Route Maps Unit'), er = pick('ExpressRoute Connection Unit'), vpn = pick('VPN S2S Connection Unit');
  const lines = [
    line(`Retail API Basic Gateway with Route Maps: 1 server * 100 hours * ${routeMaps.retailPrice}`, 100 * routeMaps.retailPrice, { meterId: routeMaps.meterId }),
    line(`Retail API Routing Infrastructure: 2 units * 100 hours * ${routing.retailPrice}`, 200 * routing.retailPrice, { meterId: routing.meterId }),
    line(`Retail API NVA Connection with Route Maps: 4 connections * 100 hours * ${nva.retailPrice}`, 400 * nva.retailPrice, { meterId: nva.meterId }),
    line(`Retail API ExpressRoute Connection Unit: 2 connections * 100 hours * ${er.retailPrice}`, 200 * er.retailPrice, { meterId: er.meterId }),
    line(`Retail API VPN S2S Connection Unit: 3 connections * 100 hours * ${vpn.retailPrice}`, 300 * vpn.retailPrice, { meterId: vpn.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'route-server', source: 'both', cases: [
  { name: 'basic route server at included vm boundary', region: 'eastus2', currency: 'USD', component: { type: 'route-server', servers: 1, connectedVms: 4000 },
    // Calculator v3 gateway offer is the Route Server hourly base; 4,000 connected VMs are included so no routing-infrastructure units.
    expected: async () => calculatorRouteServer({ region: 'eastus2', servers: 1, connectedVms: 4000 }) },
  { name: 'one vm above routing unit boundary', region: 'eastus2', currency: 'USD', component: { type: 'route-server', servers: 1, connectedVms: 4001 },
    // Calculator v3 routing-infrastructure offer adds one hourly unit for each started 1,000 VMs above 4,000.
    expected: async () => calculatorRouteServer({ region: 'eastus2', servers: 1, connectedVms: 4001 }) },
  { name: 'expressroute and vpn connection units', region: 'eastus2', currency: 'USD', component: { type: 'route-server', servers: 1, expressRouteConnections: 2, vpnConnections: 3 },
    // Calculator v3 ExpressRoute Connection Unit and VPN S2S Connection Unit offers are hourly per connection.
    expected: async () => calculatorRouteServer({ region: 'eastus2', servers: 1, expressRouteConnections: 2, vpnConnections: 3 }) },
  { name: 'route maps with nva connections part-time', region: 'eastus2', currency: 'USD', component: { type: 'route-server', servers: 1, routeMaps: true, nvaConnections: 4, hours: 100 },
    // Calculator v3 route-server-route-maps is the hourly route-maps deployment; basic-gateway-with-route-maps is per NVA connection-hour.
    expected: async () => calculatorRouteServer({ region: 'eastus2', servers: 1, routeMaps: true, nvaConnections: 4, hours: 100 }) },
  { name: 'west europe route server non-us', region: 'westeurope', currency: 'USD', component: { type: 'route-server', servers: 2, connectedVms: 5000 },
    // Calculator v3 West Europe prices two base Route Servers plus one routing-infrastructure unit each, covering a non-US region.
    expected: async () => calculatorRouteServer({ region: 'westeurope', servers: 2, connectedVms: 5000 }) },
  { name: 'us gov virginia higher prices', region: 'usgovvirginia', currency: 'USD', component: { type: 'route-server', servers: 1, routeMaps: true, connectedVms: 5001, nvaConnections: 2, expressRouteConnections: 1, vpnConnections: 1, hours: 100 },
    // Calculator v3 US Gov Virginia is the only Route Server region family with different prices; include route maps, routing, ER, VPN, and NVA units.
    expected: async () => calculatorRouteServer({ region: 'usgovvirginia', servers: 1, routeMaps: true, connectedVms: 5001, nvaConnections: 2, expressRouteConnections: 1, vpnConnections: 1, hours: 100 }) },
  { name: 'eur retail route maps routing and connection units', region: 'eastus2', currency: 'EUR', component: { type: 'route-server', servers: 1, routeMaps: true, connectedVms: 5001, nvaConnections: 4, expressRouteConnections: 2, vpnConnections: 3, hours: 100 },
    // Retail API EUR global Route Server rows: route-maps gateway, routing infrastructure, NVA route-map, ExpressRoute, and VPN S2S unit-hours.
    expected: async () => retailRouteServerEur() },
] };
