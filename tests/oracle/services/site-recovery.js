'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'site-recovery';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function data() { const r = await fetch(`https://azure.microsoft.com/api/v2/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`calculator ${SLUG} HTTP ${r.status}`); return r.json(); }
function price(d, offer, region) { const p = d.offers[offer].prices[calc.calcRegion(d, region)] || d.offers[offer].prices.global; return p.value; }
async function calcPrice({ region, destination, instances }) {
  const d = await data(); const offer = destination === 'customer-site' ? 'recover-to-customer' : 'recover-to-azure'; const p = price(d, offer, region);
  const lines = [line(`${instances} protected instance(s) * ${offer} ${p}/month`, instances * p, { sourceOffer: offer })]; return { monthlyList: total(lines), lines };
}
async function retailEur({ region, destination, instances }) {
  const rows = dedupe(await query(`serviceName eq 'Azure Site Recovery' and armRegionName eq '${region}'`, 'EUR'));
  const meter = destination === 'customer-site' ? 'VM Replicated to System Center' : 'VM Replicated to Azure';
  const row = rows.find(r => r.meterName === meter && r.type === 'Consumption'); if (!row) throw new Error(`missing ${meter}`);
  const lines = [line(`EUR ${instances} * ${row.meterName} ${row.retailPrice}/month`, instances * row.retailPrice, { meterId: row.meterId })]; return { monthlyList: total(lines), lines };
}
function c(name, cfg) { return { name, region: cfg.region || 'eastus2', currency: cfg.currency || 'USD', component: { type: 'site-recovery', destination: cfg.destination, instances: cfg.instances }, expected: () => (cfg.currency === 'EUR' ? retailEur(cfg) : calcPrice(cfg)) }; }
module.exports = { type: 'site-recovery', source: 'both', cases: [
  // Calculator recover-to-azure is a flat monthly protected-instance charge.
  c('to Azure single protected instance', { region: 'eastus2', destination: 'azure', instances: 1 }),
  // Calculator recover-to-customer prices VM replication to a customer-owned site.
  c('to customer site protected instances', { region: 'eastus2', destination: 'customer-site', instances: 3 }),
  // US Gov differs for customer-site recovery (20 vs 16 USD) in the calculator data.
  c('US Gov customer-site premium', { region: 'usgovarizona', destination: 'customer-site', instances: 2 }),
  // Non-US region check; Site Recovery Azure target is currently same USD as East US 2.
  c('West Europe Azure target', { region: 'westeurope', destination: 'azure', instances: 4 }),
  // Retail API EUR row: serviceName Azure Site Recovery / VM Replicated to Azure.
  c('EUR West Europe Azure target', { region: 'westeurope', currency: 'EUR', destination: 'azure', instances: 2 })
] };
