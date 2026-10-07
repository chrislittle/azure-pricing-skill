'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730, SLUG = 'azure-bastion';
const BASE = { basic: 'basic', standard: 'standard', premium: 'premium' };
const OVER = { standard: 'standard-overage', premium: 'premium-overage' };
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function offer(name, region) { return (await calc.offerPrice(SLUG, name, region)).value; }
function graduated(bands, qty) { let prev = 0, cost = 0, out = []; for (const b of bands) { if (qty <= prev) break; const units = Math.min(qty, b.limit) - prev, c = units * b.price.value; cost += c; out.push({ fromUnits: prev, toUnits: b.limit > 1e100 ? null : b.limit, units, unitPrice: b.price.value, cost: round2(c) }); prev = b.limit; } return { cost, bands: out }; }
function graduatedRetail(rows, qty) { const sorted = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits); let cost = 0, out = []; for (let i = 0; i < sorted.length; i++) { const start = sorted[i].tierMinimumUnits, end = i + 1 < sorted.length ? sorted[i + 1].tierMinimumUnits : Infinity; if (qty <= start) break; const units = Math.min(qty, end) - start, c = units * sorted[i].retailPrice; cost += c; out.push({ fromUnits: start, toUnits: end === Infinity ? null : end, units, unitPrice: sorted[i].retailPrice, cost: round2(c) }); } return { cost, bands: out, meterId: sorted[0] && sorted[0].meterId }; }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`); return hits[0]; }
async function retailRows(region, currency) { return dedupe(await query(`serviceName eq 'Azure Bastion' and armRegionName eq '${region}'`, currency)); }
async function bastion(o) {
  const tier = o.tier || 'standard', hours = o.hours ?? HOURS, hosts = o.hosts ?? 1, lines = [];
  if ((o.currency || 'USD') === 'USD') {
    const p = await offer(BASE[tier], o.region); lines.push(line(`${tier} Bastion host: ${hosts} * ${hours} h * ${p}`, hosts * hours * p, { sourceOffer: BASE[tier] }));
    if (o.additionalInstances && OVER[tier]) { const op = await offer(OVER[tier], o.region); lines.push(line(`${tier} additional instances: ${hosts} * ${o.additionalInstances} * ${hours} h * ${op}`, hosts * o.additionalInstances * hours * op, { sourceOffer: OVER[tier] })); }
    if (o.outboundGB) { const data = await calc.product(SLUG), reg = calc.calcRegion(data, o.region); const t = graduated(data.graduatedOffers.zone1[reg].prices, o.outboundGB); lines.push(line(`Outbound data: ${o.outboundGB} GB through calculator bands (first 5 GB free)`, t.cost, { sourceOffer: 'zone1 outbound data', bands: t.bands })); }
  } else {
    const rows = await retailRows(o.region, o.currency), sku = tier[0].toUpperCase() + tier.slice(1);
    const base = pick(rows, r => r.skuName === sku && r.meterName === `${sku} Gateway`, `${sku} Gateway`); lines.push(line(`${tier} Bastion host: ${hosts} * ${hours} h * ${base.retailPrice}`, hosts * hours * base.retailPrice, { meterId: base.meterId }));
    if (o.additionalInstances && OVER[tier]) { const add = pick(rows, r => r.skuName === sku && r.meterName === `${sku} Additional Gateway`, `${sku} Additional Gateway`); lines.push(line(`${tier} additional instances: ${hosts} * ${o.additionalInstances} * ${hours} h * ${add.retailPrice}`, hosts * o.additionalInstances * hours * add.retailPrice, { meterId: add.meterId })); }
    if (o.outboundGB) { const dataRows = rows.filter(r => r.meterName === `${sku} Data Transfer Out`); const t = graduatedRetail(dataRows, o.outboundGB); lines.push(line(`${sku} outbound data: ${o.outboundGB} GB through Retail API bands (first 5 GB free)`, t.cost, { meterId: t.meterId, bands: t.bands })); }
  }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'bastion', source: 'both', cases: [
  { name: 'basic host no outbound', region: 'eastus2', currency: 'USD', component: { type: 'bastion', tier: 'basic', hosts: 1, hours: 730 },
    // Calculator Basic Gateway offer bills per host-hour; no outbound line when GB is zero.
    expected: () => bastion({ region: 'eastus2', tier: 'basic', hosts: 1, hours: 730 }) },
  { name: 'standard outbound at 5 GB free boundary', region: 'eastus2', currency: 'USD', component: { type: 'bastion', tier: 'standard', hosts: 1, outboundGB: 5 },
    // Calculator outbound graduated band has limit 5 at zero price, so exactly 5 GB is free.
    expected: () => bastion({ region: 'eastus2', tier: 'standard', hosts: 1, outboundGB: 5 }) },
  { name: 'standard outbound just above free boundary', region: 'eastus2', currency: 'USD', component: { type: 'bastion', tier: 'standard', hosts: 1, outboundGB: 6 },
    // Calculator outbound bands charge only the 1 GB above the 5 GB free grant at the first paid band.
    expected: () => bastion({ region: 'eastus2', tier: 'standard', hosts: 1, outboundGB: 6 }) },
  { name: 'standard additional instances part time', region: 'eastus2', currency: 'USD', component: { type: 'bastion', tier: 'standard', hosts: 2, additionalInstances: 3, hours: 100 },
    // Standard additional scale units use the standard-overage hourly offer: hosts * extra instances * hours.
    expected: () => bastion({ region: 'eastus2', tier: 'standard', hosts: 2, additionalInstances: 3, hours: 100 }) },
  { name: 'premium non-US with outbound band', region: 'westeurope', currency: 'USD', component: { type: 'bastion', tier: 'premium', hosts: 1, additionalInstances: 1, outboundGB: 12000 },
    // Premium uses Premium Gateway, premium-overage, and outbound graduated bands in West Europe.
    expected: () => bastion({ region: 'westeurope', tier: 'premium', hosts: 1, additionalInstances: 1, outboundGB: 12000 }) },
  { name: 'US Gov standard outbound band', region: 'usgovvirginia', currency: 'USD', component: { type: 'bastion', tier: 'standard', hosts: 1, outboundGB: 6 },
    // US Gov Virginia uses region-specific Standard Gateway and outbound bands; first 5 GB band is zero priced.
    expected: () => bastion({ region: 'usgovvirginia', tier: 'standard', hosts: 1, outboundGB: 6 }) },
  { name: 'EUR standard host outbound', region: 'westeurope', currency: 'EUR', component: { type: 'bastion', tier: 'standard', hosts: 1, additionalInstances: 1, outboundGB: 6, hours: 24 },
    // Retail API EUR rows: Standard Gateway/hour, Standard Additional Gateway/hour, Standard Data Transfer Out graduated first 5 GB free.
    expected: () => bastion({ region: 'westeurope', currency: 'EUR', tier: 'standard', hosts: 1, additionalInstances: 1, outboundGB: 6, hours: 24 }) },
] };
