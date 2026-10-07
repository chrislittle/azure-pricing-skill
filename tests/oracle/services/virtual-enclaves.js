'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'azure-virtual-enclaves';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function data() { const r = await fetch(`https://azure.microsoft.com/api/v3/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`calculator ${SLUG} HTTP ${r.status}`); return r.json(); }
function price(d, region) { const p = d.offers['virtual-enclaves-offer'].prices.perhour; return (p[calc.calcRegion(d, region)] || p.global).value; }
async function enclaves(cfg) { const d = await data(); const p = price(d, cfg.region); const hours = Math.ceil(cfg.hours == null ? 730 : cfg.hours); const lines = [line(`${cfg.enclaves} enclave(s) * ${hours} rounded-up hour(s) * ${p}`, cfg.enclaves * hours * p, { sourceOffer: 'virtual-enclaves-offer' })]; return { monthlyList: total(lines), lines }; }
async function eur(cfg) { const rows = dedupe(await query(`serviceName eq 'Azure Virtual Enclaves'`, 'EUR')); const gov = /^usgov/i.test(cfg.region); const row = rows.find(r => r.skuName === 'Standard' && r.meterName === 'Standard Service' && r.armRegionName === (gov ? 'US Gov' : 'Global')); if (!row) throw new Error('missing virtual enclaves EUR row'); const hours = Math.ceil(cfg.hours == null ? 730 : cfg.hours); const lines = [line(`EUR ${cfg.enclaves} enclave(s) * ${hours} rounded-up h * ${row.retailPrice}`, cfg.enclaves * hours * row.retailPrice, { meterId: row.meterId })]; return { monthlyList: total(lines), lines }; }
function c(name, cfg) { const { region, currency, ...component } = cfg; return { name, region: region || 'eastus2', currency: currency || 'USD', component: { type: 'virtual-enclaves', ...component }, expected: () => currency === 'EUR' ? eur(cfg) : enclaves(cfg) }; }
module.exports = { type: 'virtual-enclaves', source: 'both', cases: [
  // v3 calculator Standard Service is per enclave-hour.
  c('one enclave full month', { region: 'eastus2', enclaves: 1, hours: 730 }),
  // Partial hours round up to the next whole billable hour.
  c('fractional hours round up', { region: 'eastus2', enclaves: 2, hours: 10.2 }),
  // Multiple enclaves multiply the same hourly meter.
  c('three enclaves partial month', { region: 'eastus2', enclaves: 3, hours: 100 }),
  // West Europe is a non-US calculator region with the commercial hourly price.
  c('West Europe enclave', { region: 'westeurope', enclaves: 1, hours: 730 }),
  // US Gov has a higher v3 calculator price than commercial regions.
  c('US Gov enclave', { region: 'usgovarizona', enclaves: 1, hours: 730 }),
  // Retail API EUR row is global for commercial regions.
  c('EUR global commercial enclave', { region: 'westeurope', currency: 'EUR', enclaves: 1, hours: 100 })
] };
