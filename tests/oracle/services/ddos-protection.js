'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730, SLUG = 'ddos-protection';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function offer(name, region) { return (await calc.offerPrice(SLUG, name, region)).value; }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`); return hits[0]; }
async function retailRows(region, currency) { return dedupe(await query(`serviceName eq 'Azure DDOS Protection' and armRegionName eq '${region}'`, currency)); }
async function ddos(o) {
  const tier = o.tier || 'network', hours = o.hours ?? HOURS, publicIps = o.publicIps || 0, lines = [];
  if ((o.currency || 'USD') === 'USD') {
    if (tier === 'ip') { const p = await offer('ddos-ip-protection', o.region); lines.push(line(`IP Protection: ${publicIps} IP resources * ${hours} h * ${p}`, publicIps * hours * p, { sourceOffer: 'ddos-ip-protection' })); }
    else { const plan = await offer('ddos-plan', o.region); lines.push(line(`Network Protection plan: ${hours} h * ${plan}`, hours * plan, { sourceOffer: 'ddos-plan' })); const over = Math.max(0, publicIps - 100); if (over) { const r = await offer('ddos-resource', o.region); lines.push(line(`Network Protection resource overage: (${publicIps}-100 included) * ${hours} h * ${r}`, over * hours * r, { sourceOffer: 'ddos-resource' })); } }
  } else {
    const rows = await retailRows(o.region, o.currency);
    if (tier === 'ip') { const p = pick(rows, r => r.meterName === 'IP Protection Resource', 'IP Protection Resource'); lines.push(line(`IP Protection: ${publicIps} IP resources * ${hours} h * ${p.retailPrice}`, publicIps * hours * p.retailPrice, { meterId: p.meterId })); }
    else { const plan = pick(rows, r => r.meterName === 'Network Protection Plan', 'Network Protection Plan'); lines.push(line(`Network Protection plan: ${hours} h * ${plan.retailPrice}`, hours * plan.retailPrice, { meterId: plan.meterId })); const over = Math.max(0, publicIps - 100); if (over) { const r = pick(rows, x => x.meterName === 'Network Protection Resource', 'Network Protection Resource'); lines.push(line(`Network Protection resource overage: (${publicIps}-100 included) * ${hours} h * ${r.retailPrice}`, over * hours * r.retailPrice, { meterId: r.meterId })); } }
  }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'ddos-protection', source: 'both', cases: [
  { name: 'ip protection single resource', region: 'eastus2', currency: 'USD', component: { type: 'ddos-protection', tier: 'ip', publicIps: 1 },
    // Calculator ddos-ip-protection is an hourly per-public-IP resource meter.
    expected: () => ddos({ region: 'eastus2', tier: 'ip', publicIps: 1 }) },
  { name: 'ip protection part time', region: 'eastus2', currency: 'USD', component: { type: 'ddos-protection', tier: 'ip', publicIps: 10, hours: 100 },
    // IP Protection prorates by enabled hours: public IP resources * hours * hourly offer.
    expected: () => ddos({ region: 'eastus2', tier: 'ip', publicIps: 10, hours: 100 }) },
  { name: 'EUR ip protection', region: 'westeurope', currency: 'EUR', component: { type: 'ddos-protection', tier: 'ip', publicIps: 3, hours: 24 },
    // Retail API EUR row IP Protection Resource bills per protected public IP-hour.
    expected: () => ddos({ region: 'westeurope', currency: 'EUR', tier: 'ip', publicIps: 3, hours: 24 }) },
  { name: 'network protection at 100-resource boundary', region: 'eastus2', currency: 'USD', component: { type: 'ddos-protection', tier: 'network', publicIps: 100 },
    // Calculator Network Protection plan includes the first 100 protected resources; no ddos-resource overage at 100.
    expected: () => ddos({ region: 'eastus2', tier: 'network', publicIps: 100 }) },
  { name: 'network protection just above 100-resource boundary', region: 'eastus2', currency: 'USD', component: { type: 'ddos-protection', tier: 'network', publicIps: 101 },
    // At 101 public IPs, charge one Network Protection Resource overage in addition to the hourly plan.
    expected: () => ddos({ region: 'eastus2', tier: 'network', publicIps: 101 }) },
  { name: 'network protection non-US overage', region: 'westeurope', currency: 'USD', component: { type: 'ddos-protection', tier: 'network', publicIps: 125, hours: 365 },
    // West Europe calculator rows use the same plan/resource formula, prorated for 365 hours.
    expected: () => ddos({ region: 'westeurope', tier: 'network', publicIps: 125, hours: 365 }) },
  { name: 'US Gov network protection overage', region: 'usgovvirginia', currency: 'USD', component: { type: 'ddos-protection', tier: 'network', publicIps: 101, hours: 24 },
    // US Gov Virginia calculator rows use region-specific Network Protection Plan and Resource hourly prices.
    expected: () => ddos({ region: 'usgovvirginia', tier: 'network', publicIps: 101, hours: 24 }) },
  { name: 'EUR network protection overage', region: 'westeurope', currency: 'EUR', component: { type: 'ddos-protection', tier: 'network', publicIps: 101, hours: 24 },
    // Retail API EUR rows: Azure DDOS Protection Network Protection Plan plus one Network Protection Resource overage above 100.
    expected: () => ddos({ region: 'westeurope', currency: 'EUR', tier: 'network', publicIps: 101, hours: 24 }) },
] };
