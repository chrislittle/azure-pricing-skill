'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS = 730;
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function arm(region) { return String(region).replace(/-/g, '').toLowerCase(); }
async function rows(region, currency) { return dedupe(await query(`serviceName eq 'Azure confidential ledger' and armRegionName eq '${arm(region)}'`, currency)); }
function pick(rs, pred, what) { const r = rs.find(pred); if (!r) throw new Error(`missing ${what}`); return r; }
function billableStorageGB(totalStorageGB, ledgers) { return Math.max(0, (totalStorageGB || 0) - 100 * ledgers); }
async function ledger(cfg) { const rs = await rows(cfg.region, cfg.currency || 'USD'); const lines = []; const n = cfg.instances || 1; const hours = cfg.hours == null ? HOURS : cfg.hours;
  if (cfg.service === 'standard') { const inst = pick(rs, r => r.productName === 'Azure confidential ledger' && r.skuName === 'Standard' && r.meterName === 'Standard Instance', 'standard ledger instance'); lines.push(line(`Standard ledger: ${n} * ${hours} h * ${inst.retailPrice}`, n * hours / unitSize(inst.unitOfMeasure) * inst.retailPrice, { meterId: inst.meterId })); const billable = billableStorageGB(cfg.additionalStorageGB, n); if (cfg.additionalStorageGB) { const st = pick(rs, r => r.productName === 'Azure confidential ledger' && r.skuName === 'Additional Storage', 'standard additional storage'); lines.push(line(`Standard storage beyond 100 GB/ledger: max(0, ${cfg.additionalStorageGB} - ${100 * n}) = ${billable} GB * ${st.retailPrice}`, billable * st.retailPrice, { meterId: st.meterId })); } }
  else { const nodes = cfg.nodes || 3; const inst = pick(rs, r => r.productName === 'Managed CCF' && r.skuName === `MCCF - ${nodes} nodes`, `MCCF ${nodes} nodes`); lines.push(line(`Managed CCF ${nodes} nodes: ${n} * ${hours} h * ${inst.retailPrice}`, n * hours / unitSize(inst.unitOfMeasure) * inst.retailPrice, { meterId: inst.meterId })); const billable = billableStorageGB(cfg.additionalStorageGB, n); if (cfg.additionalStorageGB) { const st = pick(rs, r => r.productName === 'Managed CCF' && r.skuName === 'MCCF - Additional Storage', 'MCCF storage'); lines.push(line(`MCCF storage beyond 100 GB/network: max(0, ${cfg.additionalStorageGB} - ${100 * n}) = ${billable} GB * ${st.retailPrice}`, billable * st.retailPrice, { meterId: st.meterId })); } }
  return { monthlyList: total(lines), lines };
}
function c(name, cfg) { const { region, currency, ...component } = cfg; return { name, region: region || 'eastus', currency: currency || 'USD', component: { type: 'confidential-ledger', ...component }, expected: () => ledger(cfg) }; }
module.exports = { type: 'confidential-ledger', source: 'retail-api', cases: [
  // Retail API standard ledger instance is hourly; first 100 GB per ledger is included.
  c('standard ledger under 100 GB included', { region: 'eastus', service: 'standard', instances: 1, additionalStorageGB: 99, hours: 730 }),
  // Storage at the 100 GB included boundary has no additional storage charge.
  c('standard ledger exactly 100 GB included', { region: 'eastus', service: 'standard', instances: 1, additionalStorageGB: 100, hours: 730 }),
  // Only storage above the 100 GB per-ledger grant is charged.
  c('standard ledger just over included storage', { region: 'eastus', service: 'standard', instances: 1, additionalStorageGB: 101, hours: 730 }),
  // Part-time standard ledger multiplies only instance hours; storage remains monthly.
  c('standard ledger partial month', { region: 'eastus', service: 'standard', instances: 2, additionalStorageGB: 0, hours: 100 }),
  // Managed CCF 3-node network hourly meter.
  c('managed CCF 3 nodes', { region: 'westeurope', service: 'managed-ccf', instances: 1, nodes: 3, additionalStorageGB: 105, hours: 730 }),
  // Managed CCF 5-node network hourly meter.
  c('managed CCF 5 nodes', { region: 'westeurope', service: 'managed-ccf', instances: 1, nodes: 5, hours: 100 }),
  // Managed CCF 7-node network hourly meter.
  c('managed CCF 7 nodes', { region: 'westeurope', service: 'managed-ccf', instances: 1, nodes: 7, hours: 100 }),
  // Managed CCF 9-node network hourly meter.
  c('managed CCF 9 nodes', { region: 'westeurope', service: 'managed-ccf', instances: 1, nodes: 9, hours: 100 }),
  // Non-US region standard ledger uses West Europe retail rows.
  c('West Europe standard ledger', { region: 'westeurope', service: 'standard', instances: 1, additionalStorageGB: 1, hours: 730 }),
  // Retail API EUR is queried natively, no FX conversion.
  c('EUR West Europe standard ledger', { region: 'westeurope', currency: 'EUR', service: 'standard', instances: 1, additionalStorageGB: 1, hours: 730 })
] };
