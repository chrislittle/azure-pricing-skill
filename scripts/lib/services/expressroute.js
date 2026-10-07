'use strict';
// Azure ExpressRoute: circuits (Local / Standard / Premium, metered or unlimited data), ExpressRoute Direct
// ports (including Metro and the Premium add-on), Global Reach, ExpressRoute gateways (virtual network gateways
// by size, zone-redundant ErGw1-3AZ and scalable ErGwScale) and Traffic Collector.
// Meters: serviceName 'ExpressRoute'. Circuits, ports, Global Reach and Traffic Collector are priced per
// peering-location zone (armRegionName 'Zone 1'..'Zone 4', 'US Gov Zone 1'); gateways are priced per Azure region.
// Several meters share one meterId across zones and products, so every query names the zone, product and meter.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS, q } = require('../kit');

const n = v => Number(v || 0);

const ZONES = { zone1: 'Zone 1', zone2: 'Zone 2', zone3: 'Zone 3', zone4: 'Zone 4', 'usgov-zone1': 'US Gov Zone 1' };
const SPEEDS = { '50mbps': '50 Mbps', '100mbps': '100 Mbps', '200mbps': '200 Mbps', '500mbps': '500 Mbps', '1gbps': '1 Gbps', '2gbps': '2 Gbps', '5gbps': '5 Gbps', '10gbps': '10 Gbps' };
const LOCAL_SPEEDS = ['1gbps', '2gbps', '5gbps', '10gbps'];
const GR_SPEEDS = { ...SPEEDS, '40gbps': '40 Gbps', '100gbps': '100 Gbps' };
const PORTS = { '10gbps': '10 Gbps', '100gbps': '100 Gbps', '400gbps': '400 Gbps', 'metro-10gbps': 'Metro 10 Gbps', 'metro-100gbps': 'Metro 100 Gbps', 'metro-400gbps': 'Metro 400 Gbps' };
const DIRECT_CIRCUIT_SPEEDS = { '1gbps': '1 Gbps', '2gbps': '2 Gbps', '5gbps': '5 Gbps', '10gbps': '10 Gbps', '40gbps': '40 Gbps', '100gbps': '100 Gbps', '200gbps': '200 Gbps', '400gbps': '400 Gbps' };
const GATEWAYS = {
  standard: { meter: 'Standard Gateway', label: 'Standard (about 1 Gbps)' },
  'high-performance': { meter: 'High Performance Gateway', label: 'High Performance (about 2 Gbps)' },
  'ultra-performance': { meter: 'Ultra High Performance Gateway', label: 'Ultra Performance (about 10 Gbps)' },
  ergw1az: { meter: 'ErGw1AZ Gateway', label: 'ErGw1AZ zone-redundant (about 1 Gbps)' },
  ergw2az: { meter: 'ErGw2AZ Gateway', label: 'ErGw2AZ zone-redundant (about 2 Gbps)' },
  ergw3az: { meter: 'ErGw3AZ Gateway', label: 'ErGw3AZ zone-redundant (about 10 Gbps)' },
  scalable: { meter: 'ErGwScale Unit', label: 'ErGwScale scalable gateway' }
};
const KINDS = ['circuit', 'direct-port', 'gateway', 'traffic-collector'];

const zoneOf = c => {
  const z = (c.zone || 'zone1').toLowerCase();
  if (!ZONES[z]) throw new PricingError(`Unknown zone "${c.zone}". Use one of: ${Object.keys(ZONES).join(', ')}.`);
  return { key: z, name: ZONES[z] };
};
const zoneRows = (zone, extra, ctx) => rows(`serviceName eq 'ExpressRoute' and armRegionName eq '${q(zone.name)}' and priceType eq 'Consumption' and ${extra}`, ctx);
const pick = (rs, what) => { if (!rs.length) throw new PricingError(`No ExpressRoute price found for ${what}.`); return single(rs, what); };
const fail = m => { throw new PricingError(m); };
const hoursOf = c => { const h = c.hours ?? HOURS; if (h < 0 || h > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).'); return h; };

module.exports = {
  type: 'expressroute',
  label: 'Azure ExpressRoute',
  family: 'networking-gateways',
  calculator: ['expressroute'],
  keywords: ['expressroute', 'private connection', 'dedicated link', 'express route', 'circuit', 'hybrid network', 'direct connect', 'global reach', 'er gateway'],
  fields: {
    kind: { req: true, def: 'circuit', enum: KINDS, ask: 'What should this line price? A private connection from their network to Azure through a provider -> circuit. Their own dedicated 10/100/400 Gbps ports at a Microsoft location -> direct-port. The ExpressRoute gateway that sits in their virtual network and receives the circuit -> gateway. The optional flow-log collector -> traffic-collector. A typical design needs a circuit plus a gateway as two components. ExpressRoute Metro provider circuits are priced as ordinary circuits (the same circuit price); only a Metro Direct port pair uses direct-port with a metro- port size.' },
    zone: { def: 'zone1', enum: Object.keys(ZONES), ask: 'Circuits, ports, Global Reach and Traffic Collector are priced by the zone of the ExpressRoute peering location (city) they connect at: the ExpressRoute locations page lists a Zone for every location. Most of North America and Europe is zone1; much of Asia-Pacific, Australia and Japan is zone2; other locations are zone3 or zone4; US Government locations are usgov-zone1. If unknown, suggest zone1 and record it as an assumption.' },
    speed: { def: '1gbps', enum: Object.keys(SPEEDS), ask: 'Circuits only: how much bandwidth should the circuit have? Choose 50mbps, 100mbps, 200mbps, 500mbps, 1gbps, 2gbps, 5gbps or 10gbps. If unknown, suggest 1gbps and record it as an assumption.' },
    tier: { def: 'standard', enum: ['local', 'standard', 'premium'], ask: 'Circuits and Direct Premium add-on: local -> only reaches Azure regions near the peering location (always unlimited data, 1-10 Gbps); standard -> all regions in the same geopolitical area; premium -> connects worldwide and to many more routes and virtual networks. If unknown, suggest standard.' },
    dataPlan: { def: 'metered', enum: ['metered', 'unlimited'], ask: 'Circuits and Direct ports: pay per GB sent out of Azure (metered), or a higher flat price with no per-GB charge (unlimited)? Which is cheaper depends on the zone and how much data leaves Azure; the estimate states the break-even GB per month for the chosen circuit, so price metered and say so. Local circuits are always unlimited. If unknown, suggest metered.' },
    circuits: { def: 1, int: true, min: 1, ask: 'Circuits only: how many circuits of this kind and speed?' },
    outboundGB: { def: 0, min: 0, ask: 'Metered data only: how many GB a month leave Azure toward on-premises across this circuit? Data coming into Azure is free. Use 0 for unlimited or local circuits.' },
    globalReachSpeed: { def: 'none', enum: ['none', ...Object.keys(GR_SPEEDS)], ask: 'Circuits only: should their on-premises sites in different places be linked to each other through Microsoft\'s network (Global Reach)? If no -> none. If yes, give the same value as speed: the add-on is sold per circuit at that circuit\'s bandwidth, and a different value is rejected. For Direct ports use globalReachCircuits instead.' },
    globalReachCircuits: { def: 0, int: true, min: 0, ask: 'ExpressRoute Direct only: how many circuits carved out of the ports need Global Reach (it works on Direct circuits too)? Use 0 if none.' },
    directGlobalReachSpeed: { enum: Object.keys(GR_SPEEDS), ask: 'ExpressRoute Direct Global Reach only: the bandwidth of the circuits that get Global Reach (the add-on is sold at the circuit\'s own bandwidth). Leave empty to use directCircuitSpeed.' },
    globalReachOutboundGB: { def: 0, min: 0, ask: 'Global Reach only: GB a month sent from this circuit to the other site (Global Reach is billed per GB in both directions).' },
    globalReachInboundGB: { def: 0, min: 0, ask: 'Global Reach only: GB a month received from the other site.' },
    portSpeed: { def: '10gbps', enum: Object.keys(PORTS), ask: 'ExpressRoute Direct only: port size. 10gbps, 100gbps or 400gbps; the metro-... values are for Metro, where the two ports sit in a metro pair of locations. If unknown, suggest 10gbps.' },
    ports: { def: 1, int: true, min: 1, ask: 'ExpressRoute Direct only: how many port pairs?' },
    directPremiumCircuits: { def: 0, int: true, min: 0, ask: 'ExpressRoute Direct only: how many circuits carved out of the ports need the Premium add-on? (Local and Standard circuits on Direct are free.)' },
    directCircuitSpeed: { def: '10gbps', enum: Object.keys(DIRECT_CIRCUIT_SPEEDS), ask: 'ExpressRoute Direct Premium add-on only: the bandwidth of each Premium circuit (1gbps ... 400gbps).' },
    gatewaySku: { def: 'ergw1az', enum: Object.keys(GATEWAYS), ask: 'Gateway only: how fast must traffic from on-premises reach the virtual network, and does it need to survive a zone outage? About 1 Gbps -> ergw1az (or standard for the older non-zone-redundant gateway); about 2 Gbps -> ergw2az (high-performance); about 10 Gbps -> ergw3az (ultra-performance); bandwidth that grows and shrinks automatically -> scalable. If unknown, suggest ergw1az.' },
    gateways: { def: 1, int: true, min: 1, ask: 'Gateway only: how many ExpressRoute gateways (one per virtual network that receives a circuit)?' },
    scaleUnits: { def: 2, min: 1, max: 40, ask: 'Scalable gateway only: how many scale units to run (each is about 1 Gbps; 1 to 40). A gateway that scales automatically bills for the units in use each hour, so give the average number of units.' },
    collectorGB: { def: 0, min: 0, ask: 'Traffic Collector only: GB of circuit traffic a month it should log.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Gateways and Traffic Collector: hours a month each one exists (730 = all month).' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'expressroute', kind: 'circuit', zone: 'zone1', speed: '1gbps', tier: 'standard', dataPlan: 'metered', outboundGB: 2000 },
    { type: 'expressroute', kind: 'circuit', zone: 'zone2', speed: '2gbps', tier: 'premium', dataPlan: 'unlimited', circuits: 2, globalReachSpeed: '2gbps', globalReachOutboundGB: 500, globalReachInboundGB: 300 },
    { type: 'expressroute', kind: 'direct-port', zone: 'zone1', portSpeed: '10gbps', dataPlan: 'metered', ports: 1, directPremiumCircuits: 1, directCircuitSpeed: '1gbps', globalReachCircuits: 1, directGlobalReachSpeed: '1gbps', globalReachOutboundGB: 200, outboundGB: 1000 },
    { type: 'expressroute', kind: 'gateway', gatewaySku: 'ergw2az', gateways: 2, hours: 730 },
    { type: 'expressroute', kind: 'gateway', gatewaySku: 'scalable', scaleUnits: 4 },
    { type: 'expressroute', kind: 'traffic-collector', zone: 'zone1', collectorGB: 500 }
  ],
  readback: c => {
    const kind = (c.kind || 'circuit').toLowerCase();
    const zone = (c.zone || 'zone1').toLowerCase();
    const where = `peering-location ${zone}`;
    const hours = c.hours ?? HOURS;
    const hrs = hours === HOURS ? 'running all month' : `${fmtN(hours)} hours a month`;
    if (kind === 'gateway') {
      const g = GATEWAYS[(c.gatewaySku || 'ergw1az').toLowerCase()];
      const sku = (c.gatewaySku || 'ergw1az').toLowerCase();
      return `ExpressRoute gateway ${g ? g.label : c.gatewaySku}: ${fmtN(n(c.gateways) || 1)} gateway(s)${sku === 'scalable' ? `, ${fmtN(n(c.scaleUnits) || 2)} scale units each` : ''}, ${hrs}`;
    }
    if (kind === 'traffic-collector') return `ExpressRoute Traffic Collector in ${where}: ${hrs}, ${fmtN(n(c.collectorGB))} GB of traffic logged a month`;
    if (kind === 'direct-port') {
      const parts = [`${fmtN(n(c.ports) || 1)} port pair(s) of ${(PORTS[(c.portSpeed || '10gbps').toLowerCase()] || c.portSpeed)}`, `${c.dataPlan || 'metered'} data`];
      if (n(c.directPremiumCircuits)) parts.push(`${fmtN(c.directPremiumCircuits)} Premium add-on circuit(s) of ${DIRECT_CIRCUIT_SPEEDS[(c.directCircuitSpeed || '10gbps').toLowerCase()] || c.directCircuitSpeed}`);
      if (n(c.globalReachCircuits)) parts.push(`Global Reach on ${fmtN(c.globalReachCircuits)} circuit(s) of ${GR_SPEEDS[(c.directGlobalReachSpeed || c.directCircuitSpeed || '10gbps').toLowerCase()] || c.directGlobalReachSpeed || c.directCircuitSpeed}, ${fmtN(n(c.globalReachOutboundGB))} GB out and ${fmtN(n(c.globalReachInboundGB))} GB in a month`);
      if (n(c.outboundGB)) parts.push(`${fmtN(c.outboundGB)} GB a month sent out of Azure`);
      return `ExpressRoute Direct in ${where}: ${parts.join(', ')}`;
    }
    const tier = (c.tier || 'standard').toLowerCase();
    const parts = [`${fmtN(n(c.circuits) || 1)} circuit(s) of ${SPEEDS[(c.speed || '1gbps').toLowerCase()] || c.speed}`, `${tier} tier`, `${tier === 'local' ? 'unlimited' : (c.dataPlan || 'metered')} data`];
    if (n(c.outboundGB)) parts.push(`${fmtN(c.outboundGB)} GB a month sent out of Azure`);
    if (c.globalReachSpeed && c.globalReachSpeed !== 'none') parts.push(`Global Reach ${GR_SPEEDS[c.globalReachSpeed] || c.globalReachSpeed} with ${fmtN(n(c.globalReachOutboundGB))} GB out and ${fmtN(n(c.globalReachInboundGB))} GB in a month`);
    return `ExpressRoute circuit in ${where}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The connectivity provider\'s own charges for the circuit (the telecom or exchange provider bills separately)'
  ],
  price: async (c, ctx) => {
    const kind = (c.kind || 'circuit').toLowerCase();
    if (!KINDS.includes(kind)) throw new PricingError(`Unknown kind "${c.kind}". Use one of: ${KINDS.join(', ')}.`);
    const G = 'Networking', S = 'ExpressRoute', lines = [], notes = [];
    const facts = { kind };

    if (kind === 'gateway') {
      const key = (c.gatewaySku || 'ergw1az').toLowerCase();
      const g = GATEWAYS[key];
      if (!g) throw new PricingError(`Unknown gatewaySku "${c.gatewaySku}". Use one of: ${Object.keys(GATEWAYS).join(', ')}.`);
      const gateways = c.gateways == null ? 1 : n(c.gateways);
      if (gateways < 1) throw new PricingError('gateways must be at least 1.');
      const hours = hoursOf(c);
      const rs = await rows(`serviceName eq 'ExpressRoute' and ${regionFilter(ctx)} and priceType eq 'Consumption' and meterName eq '${q(g.meter)}'`, ctx);
      if (!rs.length) throw new PricingError(`The ExpressRoute ${key} gateway is not priced in ${ctx.region}.`);
      const m = single(rs, `ExpressRoute ${key} gateway in ${ctx.region}`);
      if (key === 'scalable') {
        const units = c.scaleUnits == null ? 2 : n(c.scaleUnits);
        if (units < 1 || units > 40) throw new PricingError('A scalable ExpressRoute gateway runs between 1 and 40 scale units.');
        lines.push(meterLine(G, S, `ExpressRoute scalable gateway: ${fmtN(gateways)} gateway(s) x ${fmtN(units)} scale units x ${fmtN(hours)} hours`, m, gateways * units * hours, ctx, { unit: 'scale-unit hours' }));
        notes.push('A scalable ExpressRoute gateway bills per scale unit per hour (each unit is about 1 Gbps, 1 to 40 units). The estimate assumes the scale units shown run for the whole time; an autoscaling gateway bills for the units actually in use each hour.');
        facts.scaleUnits = units;
      } else {
        lines.push(meterLine(G, S, `ExpressRoute gateway ${g.label}: ${fmtN(gateways)} gateway(s) x ${fmtN(hours)} hours`, m, gateways * hours, ctx, { unit: 'hours' }));
      }
      notes.push('An ExpressRoute gateway bills for every hour it exists, even when no traffic flows. It is separate from the circuit charge.');
      Object.assign(facts, { gatewaySku: key, gateways, hours, zoneRedundant: /az$/.test(key) || key === 'scalable' });
      return { lines, notes, facts };
    }

    const zone = zoneOf(c);
    facts.zone = zone.key;
    const grData = async () => {
      for (const [dir, qty] of [['Out', n(c.globalReachOutboundGB)], ['In', n(c.globalReachInboundGB)]]) {
        if (!qty) continue;
        const dm = pick(await zoneRows(zone, `productName eq 'ExpressRoute Global Reach' and meterName eq 'Data Transfer ${dir}'`, ctx), `Global Reach data ${dir.toLowerCase()} in ${zone.name}`);
        lines.push(meterLine(G, S, `Global Reach data ${dir === 'Out' ? 'sent' : 'received'}, ${fmtN(qty)} GB/month`, dm, qty, ctx, { unit: 'GB' }));
      }
    };

    if (kind === 'traffic-collector') {
      if (!['zone1', 'zone2', 'zone3'].includes(zone.key)) fail('Traffic Collector is sold in zone1, zone2 and zone3 only; use one of those zones.');
      const hours = hoursOf(c), gb = n(c.collectorGB);
      const hr = pick((await zoneRows(zone, `contains(skuName,'ERTC') and unitOfMeasure eq '1 Hour'`, ctx)), `Traffic Collector hours in ${zone.name}`);
      lines.push(meterLine(G, S, `ExpressRoute Traffic Collector instance, ${fmtN(hours)} hours in ${zone.name}`, hr, hours, ctx, { unit: 'hours' }));
      if (gb) {
        const dt = pick((await zoneRows(zone, `contains(skuName,'Data_ERTC')`, ctx)), `Traffic Collector data in ${zone.name}`);
        lines.push(meterLine(G, S, `Traffic Collector data processed, ${fmtN(gb)} GB/month`, dt, gb, ctx, { unit: 'GB' }));
      }
      notes.push('Traffic Collector bills per hour for the instance plus per GB of circuit traffic it logs.');
      Object.assign(facts, { hours, collectorGB: gb });
      return { lines, notes, facts };
    }

    if (kind === 'direct-port') {
      const pk = (c.portSpeed || '10gbps').toLowerCase();
      if (!PORTS[pk]) throw new PricingError(`Unknown portSpeed "${c.portSpeed}". Use one of: ${Object.keys(PORTS).join(', ')}.`);
      const plan = (c.dataPlan || 'metered').toLowerCase();
      if (!['metered', 'unlimited'].includes(plan)) throw new PricingError('dataPlan must be metered or unlimited.');
      const ports = c.ports == null ? 1 : n(c.ports);
      if (ports < 1) throw new PricingError('ports must be at least 1.');
      const metro = pk.startsWith('metro-');
      if (plan === 'unlimited' && (metro || pk === '400gbps')) throw new PricingError(`Unlimited data is not priced for ${PORTS[pk]} ports; use metered.`);
      if (metro && zone.key === 'usgov-zone1') fail('Metro Direct ports are not sold in US Government locations; use a regular port size or a commercial zone.');
      if (pk.endsWith('400gbps') && !['zone1', 'zone2'].includes(zone.key) && !metro) fail('400 Gbps Direct ports are sold in zone1 and zone2 only; use 100gbps or one of those zones.');
      if (plan === 'unlimited' && pk === '100gbps' && !['zone1', 'usgov-zone1'].includes(zone.key)) fail('No ExpressRoute price found: unlimited-data 100 Gbps Direct ports are sold only in zone1 and usgov-zone1; use metered data or one of those zones.');
      const portMeter = metro ? `Port ${PORTS[pk]} Port` : plan === 'unlimited' ? `Port Unlimited ${PORTS[pk]} Port` : `Port ${PORTS[pk]} Port`;
      const pr = pick(await zoneRows(zone, `productName eq 'ExpressRoute Direct' and meterName eq '${q(portMeter)}'`, ctx), `ExpressRoute Direct ${PORTS[pk]} ${plan} port in ${zone.name}`);
      lines.push(meterLine(G, S, `ExpressRoute Direct ${PORTS[pk]} ports, ${plan} data: ${fmtN(ports)} port pair(s) in ${zone.name}`, pr, ports, ctx, { unit: 'port pairs / month' }));
      const pc = n(c.directPremiumCircuits);
      if (pc) {
        const ck = (c.directCircuitSpeed || '10gbps').toLowerCase();
        if (!DIRECT_CIRCUIT_SPEEDS[ck]) throw new PricingError(`Unknown directCircuitSpeed "${c.directCircuitSpeed}".`);
        if (plan === 'unlimited' && ['200gbps', '400gbps'].includes(ck)) fail('Premium add-on circuits with unlimited data are sold up to 100 Gbps; use metered data or a circuit of 100 Gbps or less.');
        if (['200gbps', '400gbps'].includes(ck) && !['zone1', 'zone2'].includes(zone.key)) fail('Premium add-on circuits of 200 and 400 Gbps are sold in zone1 and zone2 only.');
        const nm = `Premium ${plan === 'unlimited' ? 'Unlimited' : 'Metered'} Data ${DIRECT_CIRCUIT_SPEEDS[ck]} Circuit`;
        const pm = pick(await zoneRows(zone, `productName eq 'ExpressRoute Direct' and meterName eq '${q(nm)}'`, ctx), `ExpressRoute Direct Premium add-on ${DIRECT_CIRCUIT_SPEEDS[ck]} (${plan}) in ${zone.name}`);
        lines.push(meterLine(G, S, `ExpressRoute Direct Premium add-on: ${fmtN(pc)} circuit(s) of ${DIRECT_CIRCUIT_SPEEDS[ck]}, ${plan} data`, pm, pc, ctx, { unit: 'circuits / month' }));
      }
      const gb = n(c.outboundGB);
      if (gb && plan === 'unlimited') throw new PricingError('outboundGB applies to metered data only; unlimited data has no per-GB charge.');
      if (gb) {
        const eg = pick(await zoneRows(zone, `meterName eq 'Metered Data - Data Transfer Out'`, ctx), `ExpressRoute metered outbound data in ${zone.name}`);
        lines.push(meterLine(G, S, `Outbound data from metered Direct circuits, ${fmtN(gb)} GB/month`, eg, gb, ctx, { unit: 'GB' }));
      }
      const grc = n(c.globalReachCircuits);
      if (grc) {
        const gk = (c.directGlobalReachSpeed || c.directCircuitSpeed || '10gbps').toLowerCase();
        if (!GR_SPEEDS[gk]) fail('Global Reach add-ons are sold for circuits of 100 Gbps or less; set directGlobalReachSpeed to 100gbps or lower.');
        const gm = pick(await zoneRows(zone, `productName eq 'ExpressRoute Global Reach' and meterName eq '${q(GR_SPEEDS[gk])} Circuit'`, ctx), `Global Reach ${GR_SPEEDS[gk]} add-on in ${zone.name}`);
        lines.push(meterLine(G, S, `Global Reach add-on ${GR_SPEEDS[gk]} on Direct circuits: ${fmtN(grc)} circuit(s)`, gm, grc, ctx, { unit: 'circuits / month' }));
        await grData();
      } else if (n(c.globalReachOutboundGB) || n(c.globalReachInboundGB)) fail('Global Reach data was given but globalReachCircuits is 0.');
      notes.push('Local and Standard circuits on ExpressRoute Direct have no circuit fee; the port charge covers them. Only the Premium add-on is billed per circuit.');
      notes.push('Data coming into Azure over ExpressRoute is free.');
      Object.assign(facts, { portSpeed: pk, metro, dataPlan: plan, ports, directPremiumCircuits: pc, outboundGB: gb, circuitCount: ports, globalReachCircuits: grc });
      return { lines, notes, facts };
    }

    // circuit
    const sk = (c.speed || '1gbps').toLowerCase();
    if (!SPEEDS[sk]) throw new PricingError(`Unknown speed "${c.speed}". Use one of: ${Object.keys(SPEEDS).join(', ')}.`);
    const tier = (c.tier || 'standard').toLowerCase();
    if (!['local', 'standard', 'premium'].includes(tier)) throw new PricingError('tier must be local, standard or premium.');
    let plan = (c.dataPlan || 'metered').toLowerCase();
    if (!['metered', 'unlimited'].includes(plan)) throw new PricingError('dataPlan must be metered or unlimited.');
    if (tier === 'local') {
      if (c.dataPlan && plan === 'metered') throw new PricingError('Local circuits only come with unlimited data; set dataPlan to unlimited.');
      if (zone.key === 'zone4') fail('Local circuits are sold in zone1, zone2, zone3 and usgov-zone1 only; use a standard circuit or one of those zones.');
      if (!LOCAL_SPEEDS.includes(sk)) throw new PricingError('Local circuits start at 1 Gbps (1gbps, 2gbps, 5gbps, 10gbps).');
      plan = 'unlimited';
    }
    const circuits = c.circuits == null ? 1 : n(c.circuits);
    if (circuits < 1) throw new PricingError('circuits must be at least 1.');
    const cap = s => s[0].toUpperCase() + s.slice(1);
    const meterName = `${cap(tier)} ${cap(plan)} Data ${SPEEDS[sk]} Circuit`;
    const cm = pick(await zoneRows(zone, `productName eq 'ExpressRoute' and meterName eq '${q(meterName)}'`, ctx), `ExpressRoute ${tier} ${plan} ${SPEEDS[sk]} circuit in ${zone.name} (check the speed and tier are sold in that zone)`);
    lines.push(meterLine(G, S, `ExpressRoute ${tier} circuit, ${SPEEDS[sk]}, ${plan} data: ${fmtN(circuits)} circuit(s) in ${zone.name}`, cm, circuits, ctx, { unit: 'circuits / month' }));
    const gb = n(c.outboundGB);
    if (gb && plan === 'unlimited') throw new PricingError('outboundGB applies to metered data only; unlimited and local circuits have no per-GB charge.');
    if (gb) {
      const eg = pick(await zoneRows(zone, `meterName eq 'Metered Data - Data Transfer Out'`, ctx), `ExpressRoute metered outbound data in ${zone.name}`);
      lines.push(meterLine(G, S, `Outbound data over metered circuits, ${fmtN(gb)} GB/month`, eg, gb, ctx, { unit: 'GB' }));
    }
    let gr = null;
    if (c.globalReachSpeed && c.globalReachSpeed !== 'none') {
      const gk = c.globalReachSpeed.toLowerCase();
      if (!GR_SPEEDS[gk]) throw new PricingError(`Unknown globalReachSpeed "${c.globalReachSpeed}".`);
      if (gk !== sk) throw new PricingError(`The Global Reach add-on is sold per circuit at the circuit's own bandwidth: set globalReachSpeed to ${sk} (the circuit speed) or none.`);
      gr = gk;
      const gm = pick(await zoneRows(zone, `productName eq 'ExpressRoute Global Reach' and meterName eq '${q(GR_SPEEDS[gk])} Circuit'`, ctx), `Global Reach ${GR_SPEEDS[gk]} add-on in ${zone.name}`);
      lines.push(meterLine(G, S, `Global Reach add-on ${GR_SPEEDS[gk]}: ${fmtN(circuits)} circuit(s)`, gm, circuits, ctx, { unit: 'circuits / month' }));
      await grData();
    } else if (n(c.globalReachOutboundGB) || n(c.globalReachInboundGB)) {
      throw new PricingError('Global Reach data was given but globalReachSpeed is none; set globalReachSpeed to the circuit speed.');
    }
    if (tier !== 'local') {
      const other = plan === 'metered' ? 'Unlimited' : 'Metered';
      const om = (await zoneRows(zone, `productName eq 'ExpressRoute' and meterName eq '${q(`${cap(tier)} ${other} Data ${SPEEDS[sk]} Circuit`)}'`, ctx));
      const em = await zoneRows(zone, `meterName eq 'Metered Data - Data Transfer Out'`, ctx);
      if (om.length && em.length) {
        const price = rs => (rs.find(r => r.retailPrice > 0) || rs[0]).retailPrice;
        const met = plan === 'metered' ? price(cm) : price(om), unl = plan === 'metered' ? price(om) : price(cm), rate = price(em);
        if (rate > 0 && unl > met) notes.push(`In ${zone.name}, a ${tier} ${SPEEDS[sk]} circuit costs less with metered data below about ${fmtN(Math.round((unl - met) / rate))} GB a month sent out of Azure per circuit, and less with unlimited data above that (${ctx.currency} ${fmtN(Math.round(met * 100) / 100)} metered or ${fmtN(Math.round(unl * 100) / 100)} unlimited a month, plus ${Math.round(rate * 10000) / 10000} per GB metered).`);
        else if (unl <= met) notes.push(`In ${zone.name}, unlimited data costs no more than metered for a ${tier} ${SPEEDS[sk]} circuit.`);
      }
    }
    notes.push('Data coming into Azure over ExpressRoute is free for every circuit.');
    if (plan === 'metered') notes.push('Metered circuits charge per GB sent out of Azure; the circuit fee is lower than an unlimited circuit.');
    if (tier === 'local') notes.push('Local circuits include unlimited data and reach only the Azure regions near the peering location.');
    if (tier === 'premium') notes.push('The Premium price already includes the Premium add-on.');
    Object.assign(facts, { speed: sk, tier, dataPlan: plan, circuits, outboundGB: gb, globalReach: gr, circuitCount: circuits });
    return { lines, notes, facts };
  }
};
