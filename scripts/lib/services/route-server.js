'use strict';
// Azure Route Server: the server itself (hourly, with or without route maps), extra routing infrastructure units
// above the 2 included, and connection units for ExpressRoute, site-to-site VPN and NVA (route maps) connections.
// Meters: serviceName 'Azure Route Server'. Prices are regionless: armRegionName 'Global' (commercial) or 'US Gov'.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const DEFAULT_VMS = 4000;

module.exports = {
  type: 'route-server',
  label: 'Azure Route Server',
  family: 'networking-gateways',
  calculator: ['route-server'],
  keywords: ['route server', 'bgp', 'network virtual appliance', 'nva routing', 'dynamic routing', 'route maps', 'sd-wan routing'],
  fields: {
    servers: { req: true, def: 1, int: true, min: 1, ask: 'How many Route Servers do they need? You need one per virtual network where network appliances (NVAs) or gateways must exchange routes by BGP. If unknown, suggest 1.' },
    routeMaps: { def: false, ask: 'Do they need route maps (a preview feature, to filter routes or change BGP attributes such as AS-PATH and communities)? Yes -> true (billed at a higher hourly rate); otherwise false.' },
    connectedVms: { def: 0, int: true, min: 0, max: 50000, ask: 'Roughly how many VMs are in the Route Server\'s virtual network and all virtual networks peered with it? A Route Server covers 4,000 VMs; each further 1,000 VMs needs one more routing infrastructure unit. A Route Server supports at most 50,000 VMs. Use 0 if under 4,000.' },
    expressRouteConnections: { def: 0, int: true, min: 0, ask: 'For each Route Server, how many ExpressRoute gateway connections exchange routes through it? Do not enter an estate-wide total when there are several servers.' },
    vpnConnections: { def: 0, int: true, min: 0, ask: 'For each Route Server, how many branch sites connect over site-to-site VPN and exchange routes through it? Do not enter an estate-wide total when there are several servers.' },
    nvaPeers: { def: 0, int: true, min: 0, max: 16, ask: 'For each Route Server, how many NVA instances peer with it over BGP in total, with or without route maps? A Route Server has at most 16 BGP peers. Use 0 if no NVA is used.' },
    nvaConnections: { def: 0, int: true, min: 0, max: 16, ask: 'Only with route maps: for each Route Server, how many NVA BGP connections (peers) have a route map applied? A Route Server has at most 16 BGP peers.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Hours a month each Route Server exists (730 = all month; it bills while it exists, even when idle).' }
  },
  context: ['production', 'privateOnly'],
  examples: [
    { type: 'route-server', servers: 1 },
    { type: 'route-server', servers: 2, routeMaps: true, connectedVms: 7500, expressRouteConnections: 1, vpnConnections: 2, nvaConnections: 4, hours: 730 }
  ],
  readback: c => {
    const hours = c.hours ?? HOURS;
    const parts = [`${fmtN(c.servers == null ? 1 : n(c.servers))} server(s), ${hours === HOURS ? 'running all month' : `${fmtN(hours)} hours a month`}`];
    parts.push(c.routeMaps ? 'with route maps' : 'without route maps');
    parts.push(`${fmtN(n(c.connectedVms))} connected VMs`);
    if (n(c.expressRouteConnections)) parts.push(`${fmtN(c.expressRouteConnections)} ExpressRoute connection(s) per server`);
    if (n(c.vpnConnections)) parts.push(`${fmtN(c.vpnConnections)} site-to-site VPN connection(s) per server`);
    if (n(c.nvaConnections)) parts.push(`${fmtN(c.nvaConnections)} NVA route-map connection(s) per server`);
    return `Route Server: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The Standard public IP address the Route Server needs (billed separately)'
  ],
  price: async (c, ctx) => {
    const servers = c.servers == null ? 1 : n(c.servers);
    const hours = c.hours ?? HOURS;
    if (servers < 1) throw new PricingError('servers must be at least 1.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const peers = Math.max(n(c.nvaPeers), n(c.nvaConnections));
    if (n(c.nvaPeers) && n(c.nvaConnections) > n(c.nvaPeers)) throw new PricingError('nvaConnections (peers with a route map) cannot exceed nvaPeers (all NVA peers).');
    const vms = n(c.connectedVms), erC = n(c.expressRouteConnections), vpnC = n(c.vpnConnections), nvaC = n(c.nvaConnections);
    if (nvaC && !c.routeMaps) throw new PricingError('NVA route-map connections need routeMaps set to true.');
    const geo = /^usgov/i.test(ctx.region) ? 'US Gov' : 'Global';
    const rs = await rows(`serviceName eq 'Azure Route Server' and armRegionName eq '${geo}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Route Server is not priced for ${ctx.region}.`);
    const mt = (name, what) => single(rs.filter(r => r.meterName === name), `Route Server ${what}`);
    const G = 'Networking', S = 'Azure Route Server', lines = [];
    const extraUnits = Math.max(0, Math.ceil((vms - DEFAULT_VMS) / 1000));
    lines.push(meterLine(G, S, `Route Server${c.routeMaps ? ' with route maps' : ''}: ${fmtN(servers)} server(s) x ${fmtN(hours)} hours`, mt(c.routeMaps ? 'Basic Gateway with Route Maps Unit' : 'Basic Gateway', 'server hours'), servers * hours, ctx, { unit: 'hours' }));
    const perServer = (qty, name, what, label) => { if (qty) lines.push(meterLine(G, S, `${label}: ${fmtN(qty)} per server x ${fmtN(servers)} server(s) x ${fmtN(hours)} hours`, mt(name, what), qty * servers * hours, ctx, { unit: 'unit-hours' })); };
    perServer(extraUnits, 'Routing Infrastructure Unit', 'routing infrastructure units', `Extra routing infrastructure units for ${fmtN(vms)} VMs (4,000 are covered)`);
    perServer(erC, 'ExpressRoute Connection Unit', 'ExpressRoute connection units', 'ExpressRoute connection units');
    perServer(vpnC, 'VPN S2S Connection Unit', 'site-to-site connection units', 'Site-to-site VPN connection units');
    perServer(nvaC, 'NVA Connection with Route Maps Unit', 'NVA route-map connection units', 'NVA connections with route maps');
    const notes = [
      'A Route Server bills for every hour it exists, even when no routes change. It has no data transfer charge.',
      'ExpressRoute and site-to-site VPN connection units are charged only when the Route Server has been upgraded to the latest software version; an older deployment may not pay them.',
      'Route maps are a preview feature and carry extra charges.',
      'By default a Route Server has 2 routing infrastructure units, enough for 4,000 connected VMs; each extra unit adds 1,000 VMs.'
    ];
    return { lines, notes, facts: { servers, hours, routeMaps: !!c.routeMaps, connectedVms: vms, extraRoutingUnits: extraUnits, expressRouteConnections: erC, vpnConnections: vpnC, nvaConnections: nvaC, nvaPeers: peers } };
  }
};
