'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'azure-stack-edge';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function data() { const r = await fetch(`https://azure.microsoft.com/api/v2/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`calculator ${SLUG} HTTP ${r.status}`); return r.json(); }
function price(d, offer, region) { const p = d.offers[offer].prices[calc.calcRegion(d, region)] || d.offers[offer].prices.global; if (!p) throw new Error(`missing ${offer}`); return p.value; }
const DEV = {
  'pro-fpga': { svc: 'edge-subscription-fee', ship: 'pro-standard', ret: 'pro-standard', dest: 'pro-standard', secure: 'pro-standard', loss: 'pro-standard', unit: 'day' },
  'pro-1gpu': { svc: 'service-fee-one-gpu-pro-standard', ship: 'pro-standard', ret: 'pro-standard', dest: 'pro-standard', secure: 'pro-standard', loss: 'pro-standard', unit: 'day' },
  'pro-2gpu': { svc: 'service-fee-two-gpu-pro-standard', ship: 'pro-standard', ret: 'pro-standard', dest: 'pro-standard', secure: 'pro-standard', loss: 'pro-standard', unit: 'day' },
  'pro-r': { svc: 'service-fee-pro-standard-r', ship: 'pro-standard-r', ret: 'pro-standard-r', dest: 'pro-standard-r', secure: 'pro-standard-r', loss: 'pro-standard-r', unit: 'day' },
  'pro-r-ups': { svc: 'service-fee-ups-pro-standard-r', ship: 'pro-standard-r', ret: 'pro-standard-r', dest: 'ups-pro-standard-r', secure: 'ups-pro-standard-r', loss: 'ups-pro-standard-r', unit: 'day' },
  'pro2-64g': { svc: 'service-fee-64G2T-pro-2-standard', ship: 'pro-2-standard', loss: '64G2T-pro-2-standard', unit: 'hour' },
  'pro2-128g': { svc: 'service-fee-128G4T1GPU-pro-2-standard', ship: 'pro-2-standard', loss: '128G4T1GPU-pro-2-standard', unit: 'hour' },
  'pro2-256g': { svc: 'service-fee-256G6T2GPU-pro-2-standard', ship: 'pro-2-standard', loss: '256G6T2GPU-pro-2-standard', unit: 'hour' },
  'mini-r': { svc: 'service-fee-mini-r', ship: 'mini-r', ret: 'mini-r', dest: 'mini-r', secure: 'mini-r', loss: 'mini-r', unit: 'day' },
};
function monthlyDays(hours) { return (hours / 730) * 30; }
async function se(cfg) { const d = await data(); const dev = DEV[cfg.device]; const n = cfg.devices || 1, hours = cfg.hours == null ? 730 : cfg.hours; const lines = []; const p = price(d, dev.svc, cfg.region); const qty = dev.unit === 'day' ? monthlyDays(hours) : hours; lines.push(line(`${cfg.device} service: ${n} * ${dev.unit === 'day' ? `${qty} 30-day-month day(s)` : `${hours} h`} * ${p}`, n * qty * p, { sourceOffer: dev.svc })); if (cfg.shipments) { const ship = price(d, `shipping-${cfg.shipArea || 'us'}-${dev.ship}`, cfg.region); lines.push(line(`${cfg.shipArea || 'us'} shipping: ${n} * ${cfg.shipments} * ${ship}`, n * cfg.shipments * ship, { sourceOffer: `shipping-${cfg.shipArea || 'us'}-${dev.ship}` })); } const aux = [['returnWithoutDrives','return-', 'ret'],['dataDestruction','destruction-fee-', 'dest'],['secureDestruction','secure-destruction-fee-', 'secure'],['lostDevices', dev.loss === 'mini-r' ? 'lost-fee-' : 'loss-fee-', 'loss']]; for (const [field, prefix, key] of aux) if (cfg[field]) { const suffix = dev[key]; if (!suffix) throw new Error(`${field} not offered for ${cfg.device}`); const offer = `${prefix}${suffix}`; const ap = price(d, offer, cfg.region); lines.push(line(`${field}: ${cfg[field]} * ${ap}`, cfg[field] * ap, { sourceOffer: offer })); } return { monthlyList: total(lines), lines }; }
async function retailEur(cfg) { const rows = dedupe(await query(`serviceName eq 'Azure Stack Edge' and armRegionName eq '${cfg.region}'`, 'EUR')); const svc = rows.find(r => r.meterName === 'Standard Monthly Service Fee'); const ship = rows.find(r => r.meterName === 'Device Standard Shipping'); if (!svc) return se(cfg); const days = monthlyDays(cfg.hours || 730); const lines = [line(`EUR Standard service ${days} 30-day-month day(s)`, (cfg.devices || 1) * days * svc.retailPrice, { meterId: svc.meterId })]; if ((cfg.shipments || 0) && ship) lines.push(line('EUR shipping', (cfg.devices || 1) * cfg.shipments * ship.retailPrice, { meterId: ship.meterId })); return { monthlyList: total(lines), lines }; }
function c(name, cfg) { const { region, currency, ...component } = cfg; return { name, region: region || 'eastus2', currency: currency || 'USD', component: { type: 'stack-edge', ...component }, expected: () => currency === 'EUR' ? retailEur(cfg) : se(cfg) }; }
module.exports = { type: 'stack-edge', source: 'both', cases: [
  // Pro FPGA uses the daily edge subscription fee on a 30-day billing month plus US shipping.
  c('Pro FPGA with shipping', { region: 'eastus2', device: 'pro-fpga', devices: 1, hours: 730, shipArea: 'us', shipments: 1 }),
  // Pro 1 GPU daily service fee uses 30 days for a full month.
  c('Pro 1 GPU service', { region: 'eastus2', device: 'pro-1gpu', devices: 1, hours: 730, shipments: 0 }),
  // Pro 2 GPU daily service fee prorates against a 30-day month, not hours/24.
  c('Pro 2 GPU service', { region: 'eastus2', device: 'pro-2gpu', devices: 1, hours: 365, shipments: 0 }),
  // Rugged Pro R service plus APAC shipping.
  c('Pro R APAC shipping', { region: 'westeurope', device: 'pro-r', devices: 1, hours: 730, shipArea: 'apac', shipments: 1 }),
  // Rugged Pro R UPS service plus return-without-drives fee.
  c('Pro R UPS return without drives', { region: 'eastus2', device: 'pro-r-ups', devices: 1, hours: 730, shipments: 0, returnWithoutDrives: 1 }),
  // Pro 2 64GB bills with hourly Pro 2 service fee; US Gov has higher service pricing.
  c('Pro2 64GB US Gov', { region: 'usgovarizona', device: 'pro2-64g', devices: 1, hours: 730, shipments: 0 }),
  // Pro 2 128GB hourly service fee.
  c('Pro2 128GB', { region: 'eastus2', device: 'pro2-128g', devices: 2, hours: 100, shipments: 0 }),
  // Pro 2 256GB hourly service plus lost-device fee.
  c('Pro2 256GB lost device', { region: 'eastus2', device: 'pro2-256g', devices: 1, hours: 730, shipments: 0, lostDevices: 1 }),
  // Mini R daily service plus secure destruction.
  c('Mini R secure destruction', { region: 'eastus2', device: 'mini-r', devices: 1, hours: 730, shipments: 0, secureDestruction: 1 }),
  // Retail API EUR standard service/shipping rows for West Europe.
  c('EUR West Europe standard', { region: 'westeurope', currency: 'EUR', device: 'pro-fpga', devices: 1, hours: 730, shipArea: 'emea', shipments: 1 })
] };
