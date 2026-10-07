'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'expressroute';
const HOURS = 730;
const GATEWAY_OFFER = { standard: 'virtual-network-standard-gateway', 'high-performance': 'virtual-network-high-performance-gateway', 'ultra-performance': 'virtual-network-ultra-performance-gateway', ergw1az: 'gateway-ergw1az', ergw2az: 'gateway-ergw2az', ergw3az: 'gateway-ergw3az', scalable: 'gateway-ergwscale' };
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, amount, extra = {}) { return { desc, monthlyList: round2(amount), ...extra }; }
async function price(offer, regionOrZone) {
  if (/^(zone\d|usgov-zone1)$/.test(regionOrZone)) {
    const d = await calc.product(SLUG);
    const p = d.offers[offer] && d.offers[offer].prices && d.offers[offer].prices[regionOrZone];
    if (!p) throw new Error(`calculator ${SLUG}/${offer}: no price for ${regionOrZone}`);
    return p.value;
  }
  return (await calc.offerPrice(SLUG, offer, regionOrZone)).value;
}
function circuitOffer(tier, dataPlan, speed) { if (tier === 'local') return `unlimited-local-${speed}`; return `${tier === 'premium' ? 'premium-' : ''}${dataPlan}-${speed}`; }
async function calculatorExpressRoute(opts) {
  const { kind, zone = 'zone1', region = 'eastus2', speed = '1gbps', tier = 'standard', dataPlan = 'metered', circuits = 1, outboundGB = 0, globalReachSpeed = 'none', globalReachCircuits = 0, globalReachOutboundGB = 0, globalReachInboundGB = 0, portSpeed = '10gbps', ports = 1, directPremiumCircuits = 0, directCircuitSpeed = '10gbps', directGlobalReachSpeed, gatewaySku = 'ergw1az', gateways = 1, scaleUnits = 2, collectorGB = 0, hours = HOURS } = opts;
  const lines = [];
  if (kind === 'circuit') {
    const offer = circuitOffer(tier, dataPlan, speed);
    const circuitPrice = await price(offer, zone);
    lines.push(line(`${circuits} ${tier} ${dataPlan} ${speed} circuits in ${zone} * ${circuitPrice}/month`, circuits * circuitPrice, { sourceOffer: offer }));
    if (tier !== 'local' && dataPlan === 'metered' && outboundGB) { const egress = await price('metered-overage', zone); lines.push(line(`Metered outbound egress: ${outboundGB} GB * ${egress}`, outboundGB * egress, { sourceOffer: 'metered-overage' })); }
    if (globalReachSpeed !== 'none') { const globalOffer = `global-${globalReachSpeed}`; const globalCircuit = await price(globalOffer, zone); lines.push(line(`Global Reach ${globalReachSpeed}: ${circuits} circuits * ${globalCircuit}/month`, circuits * globalCircuit, { sourceOffer: globalOffer })); const inRate = await price('global-overage-in', zone); const outRate = await price('global-overage-out', zone); lines.push(line(`Global Reach inbound: ${globalReachInboundGB} GB * ${inRate}`, globalReachInboundGB * inRate, { sourceOffer: 'global-overage-in' })); lines.push(line(`Global Reach outbound: ${globalReachOutboundGB} GB * ${outRate}`, globalReachOutboundGB * outRate, { sourceOffer: 'global-overage-out' })); }
  } else if (kind === 'direct-port') {
    const metro = portSpeed.startsWith('metro-'); const speedSlug = portSpeed.replace(/^metro-/, ''); const offer = metro ? `hybrid-${speedSlug}` : `${dataPlan === 'unlimited' ? 'direct-unlimited' : 'direct'}-${speedSlug}`;
    const portPrice = await price(offer, zone); lines.push(line(`${ports} ExpressRoute Direct ${portSpeed} port pairs in ${zone} * ${portPrice}/month`, ports * portPrice, { sourceOffer: offer }));
    if (dataPlan === 'metered' && outboundGB) { const egress = await price('metered-overage', zone); lines.push(line(`Direct metered outbound egress: ${outboundGB} GB * ${egress}`, outboundGB * egress, { sourceOffer: 'metered-overage' })); }
    if (directPremiumCircuits) { const premiumOffer = `${dataPlan === 'unlimited' ? 'unlimited-direct' : 'direct-premiumAddon'}-${directCircuitSpeed}`; const premium = await price(premiumOffer, zone); lines.push(line(`Direct Premium add-on: ${directPremiumCircuits} circuits * ${premium}/month`, directPremiumCircuits * premium, { sourceOffer: premiumOffer })); }
    if (globalReachCircuits) { const grSpeed = directGlobalReachSpeed || directCircuitSpeed; const globalOffer = `global-${grSpeed}`; const globalCircuit = await price(globalOffer, zone); lines.push(line(`Global Reach ${grSpeed} on Direct circuits: ${globalReachCircuits} circuits * ${globalCircuit}/month`, globalReachCircuits * globalCircuit, { sourceOffer: globalOffer })); const inRate = await price('global-overage-in', zone); const outRate = await price('global-overage-out', zone); lines.push(line(`Global Reach inbound: ${globalReachInboundGB} GB * ${inRate}`, globalReachInboundGB * inRate, { sourceOffer: 'global-overage-in' })); lines.push(line(`Global Reach outbound: ${globalReachOutboundGB} GB * ${outRate}`, globalReachOutboundGB * outRate, { sourceOffer: 'global-overage-out' })); }
  } else if (kind === 'gateway') {
    const offer = GATEWAY_OFFER[gatewaySku]; const rate = await price(offer, region); const units = gatewaySku === 'scalable' ? scaleUnits : 1; lines.push(line(`${gateways} ${gatewaySku} gateways * ${units} units * ${hours} hours * ${rate}`, gateways * units * hours * rate, { sourceOffer: offer }));
  } else if (kind === 'traffic-collector') {
    const gwRate = await price('traffic-collector-standard-gateway', zone); const dataRate = await price('traffic-collector-standard-data-transfer', zone); lines.push(line(`Traffic Collector gateway: ${hours} hours * ${gwRate}`, hours * gwRate, { sourceOffer: 'traffic-collector-standard-gateway' })); lines.push(line(`Traffic Collector data: ${collectorGB} GB * ${dataRate}`, collectorGB * dataRate, { sourceOffer: 'traffic-collector-standard-data-transfer' }));
  }
  return { monthlyList: totalOf(lines), lines };
}
async function retailCircuitEur() {
  const rows = dedupe(await query(`serviceName eq 'ExpressRoute' and armRegionName eq 'Zone 1'`, 'EUR'));
  const pick = (pred, what) => { const hit = rows.find(pred); if (!hit) throw new Error(`ExpressRoute EUR row not found: ${what}`); return hit; };
  const circuit = pick(r => r.productName === 'ExpressRoute' && r.skuName === '1 Gbps Metered Data' && r.meterName === 'Standard Metered Data 1 Gbps Circuit', '1 Gbps metered circuit');
  const egress = pick(r => r.productName === 'ExpressRoute' && r.skuName === '1 Gbps Metered Data' && r.meterName === 'Metered Data - Data Transfer Out', 'metered data out');
  const lines = [line(`Retail API Zone 1 standard metered 1 Gbps circuit: 1 * ${circuit.retailPrice}/month`, circuit.retailPrice, { meterId: circuit.meterId }), line(`Retail API Zone 1 metered egress: 1000 GB * ${egress.retailPrice}`, 1000 * egress.retailPrice, { meterId: egress.meterId })];
  return { monthlyList: totalOf(lines), lines };
}
function c(name, component, note, opts = component) { return { name, region: component.region || 'eastus2', currency: 'USD', component: { type: 'expressroute', ...component }, /* Calculator offer arithmetic: see note below. */ expected: async () => calculatorExpressRoute(opts), _note: note }; }
const cases = [
  c('zone1 standard metered circuit with egress', { kind: 'circuit', zone: 'zone1', speed: '1gbps', tier: 'standard', dataPlan: 'metered', outboundGB: 1000 }, 'metered-1gbps monthly circuit plus metered-overage per outbound GB'),
  c('zone2 premium unlimited circuit plus global reach', { kind: 'circuit', zone: 'zone2', speed: '10gbps', tier: 'premium', dataPlan: 'unlimited', globalReachSpeed: '10gbps', globalReachInboundGB: 200, globalReachOutboundGB: 300 }, 'premium-unlimited-10gbps plus Global Reach add-on and in/out overage'),
  c('zone3 local circuit is unlimited', { kind: 'circuit', zone: 'zone3', speed: '5gbps', tier: 'local', dataPlan: 'unlimited' }, 'unlimited-local-5gbps; Local includes outbound data'),
  c('us gov zone1 standard metered circuit with egress', { kind: 'circuit', zone: 'usgov-zone1', speed: '1gbps', tier: 'standard', dataPlan: 'metered', outboundGB: 1000 }, 'US Gov Zone 1 metered-1gbps plus metered-overage at gov rates'),
  ...['50mbps', '100mbps', '200mbps', '500mbps', '2gbps'].map(speed => c(`standard metered ${speed}`, { kind: 'circuit', zone: 'zone4', speed, tier: 'standard', dataPlan: 'metered' }, `metered-${speed} monthly circuit in zone4`)),
  c('direct 10gbps with egress and premium add-on', { kind: 'direct-port', zone: 'zone1', portSpeed: '10gbps', dataPlan: 'metered', outboundGB: 500, directPremiumCircuits: 2, directCircuitSpeed: '10gbps' }, 'direct-10gbps, metered-overage, direct-premiumAddon-10gbps'),
  c('direct 100gbps zone2 with global reach hand check', { kind: 'direct-port', zone: 'zone2', portSpeed: '100gbps', dataPlan: 'metered', directCircuitSpeed: '100gbps', directGlobalReachSpeed: '100gbps', globalReachCircuits: 2, globalReachInboundGB: 750, globalReachOutboundGB: 750 }, 'direct-100gbps zone2 plus 2 global-100gbps add-ons and 1,500 GB bidirectional Global Reach data'),
  { name: 'global reach data without circuits boundary error', region: 'eastus2', currency: 'USD', component: { type: 'expressroute', kind: 'direct-port', zone: 'zone2', portSpeed: '100gbps', dataPlan: 'metered', directCircuitSpeed: '100gbps', globalReachInboundGB: 1 }, expectEngineError: /globalReachCircuits is 0/i },
  c('direct 100gbps unlimited with premium add-on zone1', { kind: 'direct-port', zone: 'zone1', portSpeed: '100gbps', dataPlan: 'unlimited', directPremiumCircuits: 1, directCircuitSpeed: '100gbps' }, 'direct-unlimited-100gbps monthly port pair plus unlimited-direct-100gbps Premium add-on'),
  { name: 'direct 100gbps unlimited not sold in zone2', region: 'eastus2', currency: 'USD', component: { type: 'expressroute', kind: 'direct-port', zone: 'zone2', portSpeed: '100gbps', dataPlan: 'unlimited' }, expectEngineError: /No ExpressRoute price found|no price/i },
  c('direct 400gbps metered', { kind: 'direct-port', zone: 'zone1', portSpeed: '400gbps', dataPlan: 'metered' }, 'direct-400gbps monthly port pair'),
  c('metro direct 10gbps with metered egress', { kind: 'direct-port', zone: 'zone1', portSpeed: 'metro-10gbps', outboundGB: 1000 }, 'hybrid-10gbps Metro port pair plus metered-overage outbound data'),
  ...['metro-10gbps', 'metro-100gbps', 'metro-400gbps'].map(portSpeed => c(`${portSpeed} direct metro`, { kind: 'direct-port', zone: 'zone1', portSpeed }, `hybrid-${portSpeed.replace('metro-', '')} monthly Metro port pair`)),
  ...['standard', 'high-performance', 'ultra-performance', 'ergw1az', 'ergw2az'].map(gatewaySku => c(`${gatewaySku} gateway`, { kind: 'gateway', gatewaySku }, `${GATEWAY_OFFER[gatewaySku]} hourly gateway`)),
  c('ergw3az gateway west europe non-us', { kind: 'gateway', region: 'westeurope', gatewaySku: 'ergw3az' }, 'gateway-ergw3az hourly gateway in West Europe', { kind: 'gateway', region: 'westeurope', gatewaySku: 'ergw3az' }),
  c('scalable gateway scale units part-time', { kind: 'gateway', gatewaySku: 'scalable', scaleUnits: 6, hours: 100 }, 'gateway-ergwscale per scale unit-hour'),
  c('traffic collector zone2', { kind: 'traffic-collector', zone: 'zone2', collectorGB: 1234, hours: 100 }, 'traffic collector gateway hourly plus per-GB data transfer'),
  { name: 'eur retail zone1 metered circuit egress', region: 'eastus2', currency: 'EUR', component: { type: 'expressroute', kind: 'circuit', zone: 'zone1', speed: '1gbps', tier: 'standard', dataPlan: 'metered', outboundGB: 1000 },
    // Retail API EUR rows for Zone 1: Standard Metered Data 1 Gbps Circuit plus Metered Data - Data Transfer Out per GB.
    expected: async () => retailCircuitEur() },
];
for (const k of cases) delete k._note;
module.exports = { type: 'expressroute', source: 'both', cases };
