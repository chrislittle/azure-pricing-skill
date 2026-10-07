const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'vpn-gateway';
const HOURS = 730;
const S2S_INCLUDED = 10;
const P2S_INCLUDED = 128;
const SKU_OFFER = {
  basic: 'vpngateways-basic',
  vpngw1az: 'vpngateways-vpngw1az',
  vpngw2az: 'vpngateways-vpngw2az',
  vpngw3az: 'vpngateways-vpngw3az',
  vpngw4az: 'vpngateways-vpngw4az',
  vpngw5az: 'vpngateways-vpngw5az',
};
const RETAIL_ZONE = { zone1: 'Zone 1', zone2: 'Zone 2', zone3: 'Zone 3', usgovzone1: 'US Gov Zone 1' };
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, amount, extra = {}) { return { desc, monthlyList: round2(amount), ...extra }; }
async function calculatorRate(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }
async function interVnetMeter(currency, zone) {
  const armRegionName = RETAIL_ZONE[zone] || zone;
  const rows = dedupe(await query(`serviceName eq 'VPN Gateway' and productName eq 'VPN Gateway Bandwidth' and armRegionName eq '${armRegionName}'`, currency));
  const hit = rows.find(r => r.meterName === 'Standard Inter-Virtual Network Data Transfer Out');
  if (!hit) throw new Error(`VPN Gateway inter-VNet Retail API row not found: ${currency} ${armRegionName}`);
  return hit;
}
async function interVnetLine(currency, zone, gb) {
  const m = await interVnetMeter(currency, zone);
  return line(`Retail API inter-VNet data transfer out ${zone}: ${gb} GB * ${m.retailPrice}`, gb * m.retailPrice, { meterId: m.meterId });
}
async function calculatorVpn(opts) {
  const { region, sku, gateways = 1, s2sTunnels = 0, p2sConnections = 0, advancedConnectivity = false, interVnetGB = 0, interVnetZone = 'zone1', hours = HOURS, currency = 'USD' } = opts;
  const lines = [];
  const gatewayRate = await calculatorRate(SKU_OFFER[sku], region);
  lines.push(line(`${gateways} ${sku} gateways * ${hours} hours * ${gatewayRate}`, gateways * hours * gatewayRate, { sourceOffer: SKU_OFFER[sku] }));
  const billableS2s = Math.max(0, s2sTunnels - S2S_INCLUDED) * gateways;
  if (billableS2s) { const s2sRate = await calculatorRate('s2s', region); lines.push(line(`${billableS2s} billable S2S tunnels beyond ${S2S_INCLUDED}/gateway * ${hours} hours * ${s2sRate}`, billableS2s * hours * s2sRate, { sourceOffer: 's2s' })); }
  const billableP2s = Math.max(0, p2sConnections - P2S_INCLUDED) * gateways;
  if (billableP2s) { const p2sRate = await calculatorRate('p2s', region); lines.push(line(`${billableP2s} billable P2S connections beyond ${P2S_INCLUDED}/gateway * ${hours} hours * ${p2sRate}`, billableP2s * hours * p2sRate, { sourceOffer: 'p2s' })); }
  if (advancedConnectivity) { const acRate = await calculatorRate('vpngateways-vpngw1ac', region); lines.push(line(`Advanced Connectivity add-on: ${gateways} gateways * ${hours} hours * ${acRate}`, gateways * hours * acRate, { sourceOffer: 'vpngateways-vpngw1ac' })); }
  if (interVnetGB) lines.push(await interVnetLine(currency, interVnetZone, interVnetGB));
  return { monthlyList: totalOf(lines), lines };
}
async function retailVpn(opts) {
  const { region, currency, sku, gateways = 1, s2sTunnels = 0, p2sConnections = 0, advancedConnectivity = false, interVnetGB = 0, interVnetZone = 'zone1', hours = HOURS } = opts;
  const rows = dedupe(await query(`serviceName eq 'VPN Gateway' and armRegionName eq '${region}'`, currency));
  const skuName = sku === 'basic' ? 'Basic' : sku.replace(/^vpngw/i, 'VpnGw').replace(/az$/i, 'AZ');
  const pick = (pred, what) => { const hit = rows.find(pred); if (!hit) throw new Error(`VPN Gateway Retail API row not found: ${what}`); return hit; };
  const lines = [];
  const gw = pick(r => r.skuName === skuName && (r.meterName === skuName || r.meterName === `${skuName} Gateway` || r.meterName === 'Basic Gateway'), skuName);
  lines.push(line(`Retail API ${skuName}: ${gateways} gateways * ${hours} hours * ${gw.retailPrice}`, gateways * hours * gw.retailPrice, { meterId: gw.meterId }));
  const billableS2s = Math.max(0, s2sTunnels - S2S_INCLUDED) * gateways;
  if (billableS2s) { const s2s = pick(r => r.skuName === skuName && r.meterName === 'S2S Connection', `${skuName} S2S Connection`); lines.push(line(`Retail API S2S overage: ${billableS2s} tunnels * ${hours} hours * ${s2s.retailPrice}`, billableS2s * hours * s2s.retailPrice, { meterId: s2s.meterId })); }
  const billableP2s = Math.max(0, p2sConnections - P2S_INCLUDED) * gateways;
  if (billableP2s) { const p2s = pick(r => r.skuName === skuName && r.meterName === 'P2S Connection', `${skuName} P2S Connection`); lines.push(line(`Retail API P2S overage: ${billableP2s} connections * ${hours} hours * ${p2s.retailPrice}`, billableP2s * hours * p2s.retailPrice, { meterId: p2s.meterId })); }
  if (advancedConnectivity) { const ac = pick(r => r.meterName === 'Advanced Connectivity Add-On', 'Advanced Connectivity Add-On'); lines.push(line(`Retail API Advanced Connectivity: ${gateways} gateways * ${hours} hours * ${ac.retailPrice}`, gateways * hours * ac.retailPrice, { meterId: ac.meterId })); }
  if (interVnetGB) lines.push(await interVnetLine(currency, interVnetZone, interVnetGB));
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'vpn-gateway', source: 'both', cases: [
  { name: 'basic included tunnel boundaries', region: 'eastus2', currency: 'USD', component: { type: 'vpn-gateway', sku: 'basic', s2sTunnels: 10, p2sConnections: 128 },
    // Calculator vpngateways-basic is hourly; 10 S2S tunnels and 128 P2S connections are included, so no overage lines.
    expected: async () => calculatorVpn({ region: 'eastus2', sku: 'basic', s2sTunnels: 10, p2sConnections: 128 }) },
  { name: 'vpngw1az above included tunnel and user boundary', region: 'eastus2', currency: 'USD', component: { type: 'vpn-gateway', sku: 'vpngw1az', s2sTunnels: 11, p2sConnections: 129 },
    // Calculator vpngateways-vpngw1az plus one S2S tunnel over 10 and one P2S connection over 128, each billed hourly.
    expected: async () => calculatorVpn({ region: 'eastus2', sku: 'vpngw1az', s2sTunnels: 11, p2sConnections: 129 }) },
  ...['vpngw2az', 'vpngw3az', 'vpngw4az'].map(sku => ({ name: `${sku} sku`, region: 'eastus2', currency: 'USD', component: { type: 'vpn-gateway', sku },
    // Calculator zone-redundant gateway SKU offer is billed per gateway-hour for a 730-hour month.
    expected: async () => calculatorVpn({ region: 'eastus2', sku }) })),
  { name: 'vpngw5az advanced connectivity part-time', region: 'eastus2', currency: 'USD', component: { type: 'vpn-gateway', sku: 'vpngw5az', advancedConnectivity: true, hours: 100 },
    // Advanced Connectivity is valid only on VpnGw5AZ; calculator add-on offer vpngateways-vpngw1ac is hourly.
    expected: async () => calculatorVpn({ region: 'eastus2', sku: 'vpngw5az', advancedConnectivity: true, hours: 100 }) },
  { name: 'zone1 inter-vnet data transfer', region: 'eastus2', currency: 'USD', component: { type: 'vpn-gateway', sku: 'vpngw1az', interVnetGB: 1000, interVnetZone: 'zone1' },
    // Retail API VPN Gateway Bandwidth Zone 1 meter bills Standard Inter-Virtual Network Data Transfer Out per GB.
    expected: async () => calculatorVpn({ region: 'eastus2', sku: 'vpngw1az', interVnetGB: 1000, interVnetZone: 'zone1' }) },
  { name: 'zone2 inter-vnet data transfer', region: 'eastasia', currency: 'USD', component: { type: 'vpn-gateway', sku: 'vpngw2az', interVnetGB: 1000, interVnetZone: 'zone2' },
    // Retail API VPN Gateway Bandwidth Zone 2 meter bills Standard Inter-Virtual Network Data Transfer Out per GB.
    expected: async () => calculatorVpn({ region: 'eastasia', sku: 'vpngw2az', interVnetGB: 1000, interVnetZone: 'zone2' }) },
  { name: 'zone3 inter-vnet data transfer', region: 'brazilsouth', currency: 'USD', component: { type: 'vpn-gateway', sku: 'vpngw3az', interVnetGB: 1000, interVnetZone: 'zone3' },
    // Retail API VPN Gateway Bandwidth Zone 3 meter bills Standard Inter-Virtual Network Data Transfer Out per GB.
    expected: async () => calculatorVpn({ region: 'brazilsouth', sku: 'vpngw3az', interVnetGB: 1000, interVnetZone: 'zone3' }) },
  { name: 'west europe vpngw5az non-us', region: 'westeurope', currency: 'USD', component: { type: 'vpn-gateway', sku: 'vpngw5az', advancedConnectivity: true },
    // Calculator West Europe region uses vpngateways-vpngw5az plus Advanced Connectivity add-on; this verifies non-US region lookup.
    expected: async () => calculatorVpn({ region: 'westeurope', sku: 'vpngw5az', advancedConnectivity: true }) },
  { name: 'eur retail vpngw1az over boundaries plus inter-vnet', region: 'eastus2', currency: 'EUR', component: { type: 'vpn-gateway', sku: 'vpngw1az', s2sTunnels: 11, p2sConnections: 129, interVnetGB: 1000, interVnetZone: 'zone1', hours: 100 },
    // Retail API EUR rows: VpnGw1AZ hourly gateway, one S2S and one P2S over included limits, plus Zone 1 inter-VNet transfer.
    expected: async () => retailVpn({ region: 'eastus2', currency: 'EUR', sku: 'vpngw1az', s2sTunnels: 11, p2sConnections: 129, interVnetGB: 1000, interVnetZone: 'zone1', hours: 100 }) },
] };
