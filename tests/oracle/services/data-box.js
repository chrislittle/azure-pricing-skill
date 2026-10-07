'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'databox';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function data() { const r = await fetch(`https://azure.microsoft.com/api/v2/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`calculator ${SLUG} HTTP ${r.status}`); return r.json(); }
function price(d, offer, region) { const p = d.offers[offer].prices[calc.calcRegion(d, region)] || d.offers[offer].prices.global; if (!p) throw new Error(`missing ${offer}`); return p.value; }
function diskBillableDays(daysKept) { if (!daysKept) return 1; return daysKept <= 3 ? 1 : daysKept - 2; }
async function db(cfg) { const d = await data(); const lines = []; const n = cfg.devices || 1;
  if (cfg.device === 'data-box-disk') { const disks = cfg.disksPerOrder || 5; const proc = price(d, 'disk-processing-fee', cfg.region); lines.push(line(`Disk order processing: ${n} orders * ${proc}`, n * proc, { sourceOffer: 'disk-processing-fee' })); if ((cfg.shipping || 'microsoft-managed') === 'microsoft-managed') { const ship = price(d, 'disk-shipping-fee', cfg.region); lines.push(line(`Disk Microsoft-managed shipping: ${n} * ${ship}`, n * ship, { sourceOffer: 'disk-shipping-fee' })); } const days = diskBillableDays(cfg.daysKept || 0); if (days) { const p = price(d, 'disk-usage-fee', cfg.region); lines.push(line(`Disk daily usage: ${n} orders * ${disks} disks * ${days} billable day(s) * ${p}`, n * disks * days * p, { sourceOffer: 'disk-usage-fee' })); } if (cfg.lostOrDamaged) { const p = price(d, 'disk-lost-fee', cfg.region); lines.push(line(`Lost/damaged disks: ${cfg.lostOrDamaged} * ${p}`, cfg.lostOrDamaged * p, { sourceOffer: 'disk-lost-fee' })); } }
  else if (cfg.device === 'data-box-120' || cfg.device === 'data-box-525') { const cap = cfg.device === 'data-box-120' ? '120' : '525'; const included = cap === '120' ? 10 : 20; const extra = Math.max(0, (cfg.daysKept || 0) - included); if (extra) { const p = price(d, `data-box-${cap}-extra-day-fee`, cfg.region); lines.push(line(`${cap} TB extra days: ${n} * ${extra} day(s) beyond ${included} included * ${p}`, n * extra * p, { sourceOffer: `data-box-${cap}-extra-day-fee` })); } if (cfg.lostOrDamaged) { const p = price(d, `data-box-${cap}-damaged-device-fee`, cfg.region); lines.push(line(`${cap} TB lost/damaged devices: ${cfg.lostOrDamaged} * ${p}`, cfg.lostOrDamaged * p, { sourceOffer: `data-box-${cap}-damaged-device-fee` })); } }
  else if (cfg.device === 'data-box-gateway') { const p = price(d, 'gateway-subscription-fee', cfg.region); lines.push(line(`Gateway subscription: ${n} * ${cfg.days || 31} days * ${p}`, n * (cfg.days || 31) * p, { sourceOffer: 'gateway-subscription-fee' })); }
  return { monthlyList: total(lines), lines }; }
async function retailEur(cfg) { const rows = dedupe(await query(`serviceName eq 'Data Box' and armRegionName eq '${cfg.region}'`, 'EUR')); const row = rows.find(r => r.productName === 'Data Box Disk' && r.meterName === 'Standard Service Fee'); if (!row) return db(cfg); const ship = rows.find(r => r.productName === 'Data Box Disk' && r.meterName === 'Device Standard Shipping'); const use = rows.find(r => r.productName === 'Data Box Disk' && r.meterName === 'Standard Daily Use Fee'); const lines = [line(`EUR disk order processing`, (cfg.devices || 1) * row.retailPrice, { meterId: row.meterId })]; if (use) lines.push(line(`EUR disk daily usage minimum`, (cfg.devices || 1) * (cfg.disksPerOrder || 5) * diskBillableDays(cfg.daysKept || 0) * use.retailPrice, { meterId: use.meterId })); if (ship) lines.push(line(`EUR disk shipping`, (cfg.devices || 1) * ship.retailPrice, { meterId: ship.meterId })); return { monthlyList: total(lines), lines }; }
function c(name, cfg) { const { region, currency, ...component } = cfg; return { name, region: region || 'eastus2', currency: currency || 'USD', component: { type: 'data-box', ...component }, expected: () => currency === 'EUR' ? retailEur(cfg) : db(cfg) }; }
module.exports = { type: 'data-box', source: 'both', cases: [
  // Data Box Disk with daysKept=0 still includes one daily usage fee unit for the grace-period handling window, plus Microsoft-managed shipping.
  c('disk order zero days handling', { region: 'eastus2', device: 'data-box-disk', devices: 1, disksPerOrder: 5, daysKept: 0 }),
  // Self-managed shipping removes the disk shipping fee but keeps processing and grace-period handling.
  c('disk order self-managed shipping', { region: 'eastus2', device: 'data-box-disk', devices: 1, disksPerOrder: 5, daysKept: 0, shipping: 'self-managed' }),
  // First three disk days are charged as a single daily usage fee unit per disk.
  c('disk three-day grace boundary', { region: 'eastus2', device: 'data-box-disk', devices: 1, disksPerOrder: 2, daysKept: 3 }),
  // After three disk days, daily usage is daysKept-2 billable days per disk.
  c('disk just above grace boundary with lost disk', { region: 'usgovarizona', device: 'data-box-disk', devices: 1, disksPerOrder: 1, daysKept: 4, lostOrDamaged: 1 }),
  // Data Box 120 has 10 included days; day 11 starts extra-day fees.
  c('Data Box 120 one extra day', { region: 'eastus2', device: 'data-box-120', devices: 2, daysKept: 11 }),
  // Data Box 525 has 20 included days and a distinct extra-day/lost-device fee.
  c('Data Box 525 included days plus damage', { region: 'westeurope', device: 'data-box-525', devices: 1, daysKept: 20, lostOrDamaged: 1 }),
  // Gateway subscription bills by day of virtual appliance use.
  c('Gateway partial month', { region: 'eastus2', device: 'data-box-gateway', devices: 2, days: 15 }),
  // Gateway default is 31 days when the component omits days.
  c('Gateway default 31 days', { region: 'eastus2', device: 'data-box-gateway', devices: 1 }),
  // Retail API EUR Data Box Disk processing and shipping rows.
  c('EUR West Europe disk order', { region: 'westeurope', currency: 'EUR', device: 'data-box-disk', devices: 1, disksPerOrder: 5, daysKept: 0 })
] };
