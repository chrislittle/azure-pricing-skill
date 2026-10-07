'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'cdn';
const ZONE = { 'north-america': 'zone1', europe: 'zone1', 'middle-east-africa': 'zone1', 'asia-pacific': 'zone2', 'south-america': 'zone3', australia: 'zone4', india: 'zone5' };
function retailZoneName(zone) { return zone === 'usgov-zone1' ? 'US Gov Zone 1' : 'Zone ' + zone.replace('zone',''); }
function isGov(region) { return region === 'usgovvirginia'; }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function graduated(bands, qty) { let prev = 0, cost = 0; for (const b of bands) { if (qty <= prev) break; const units = Math.min(qty, b.limit) - prev; cost += units * b.price.value; prev = b.limit; } return cost; }
function graduatedRetail(rows, qty) { const sorted = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits); let cost = 0; for (let i = 0; i < sorted.length; i++) { const start = sorted[i].tierMinimumUnits, end = i + 1 < sorted.length ? sorted[i + 1].tierMinimumUnits : Infinity; if (qty <= start) break; cost += (Math.min(qty, end) - start) * sorted[i].retailPrice; } return cost; }
function audienceParts(s) { if (!s || !s.includes(':')) return [['north-america', 1]]; return s.split(',').map(p => { const [k, v] = p.split(':'); return [k.trim(), Number(v) / 100]; }); }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length < 1) throw new Error('no Retail API row for ' + what); return hits[0]; }
async function cdn(o) { const currency = o.currency || 'USD', provider = o.provider || 'microsoft', region = o.region || 'eastus2', lines = []; if (currency === 'USD' && provider !== 'verizon' && !isGov(region)) { const d = await calc.product(SLUG); const offer = provider === 'akamai' ? 'akamai' : 'microsoft'; for (const [area, frac] of audienceParts(o.audience)) { const zone = ZONE[area] || 'zone1', gb = o.egressGB * frac; lines.push(line(provider + ' data ' + area + ': ' + gb + ' GB through ' + zone + ' bands', graduated(d.graduatedOffers[offer][zone].prices, gb), { sourceOffer: offer, zone })); } if (o.rules) lines.push(line('Rules engine rules: ' + o.rules + ' through first-5-free bands', graduated(d.graduatedOffers.rules.zone1.prices, o.rules), { sourceOffer: 'rules' })); if (o.rulesRequestsMillions) { const rows = await query("productName eq 'Azure CDN from Microsoft'", 'USD'); const r = pick(rows, x => x.skuName === 'Standard' && x.meterName === 'Standard Requests' && x.armRegionName === 'Zone 1', 'Standard Requests'); lines.push(line('Rules requests: ' + o.rulesRequestsMillions + 'M * ' + r.retailPrice, o.rulesRequestsMillions * r.retailPrice, { meterId: r.meterId })); } } else { const productName = provider === 'verizon' ? 'Azure CDN from Verizon' : (provider === 'akamai' ? 'Azure CDN from Akamai' : 'Azure CDN from Microsoft'); const rows = await query("productName eq '" + productName + "'", currency); for (const [area, frac] of audienceParts(o.audience)) { const z = isGov(region) ? 'usgov-zone1' : (ZONE[area] || 'zone1'); const zone = retailZoneName(z); const gb = o.egressGB * frac; const meter = provider === 'akamai' ? 'Standard Acceleration Data Transfer' : 'Standard Data Transfer'; lines.push(line(provider + ' data ' + area + ': ' + gb + ' GB through Retail API ' + zone + ' bands', graduatedRetail(rows.filter(r => r.meterName === meter && r.armRegionName === zone), gb))); } const rulesZone = isGov(region) ? 'US Gov Zone 1' : 'Zone 1'; if (o.rules) lines.push(line('Rules engine rules: ' + o.rules, graduatedRetail(rows.filter(r => r.meterName === 'Standard Rule' && r.armRegionName === rulesZone), o.rules))); if (o.rulesRequestsMillions) { const r = pick(rows, x => x.skuName === 'Standard' && x.meterName === 'Standard Requests' && x.armRegionName === rulesZone, 'Standard Requests'); lines.push(line('Rules requests: ' + o.rulesRequestsMillions + 'M * ' + r.retailPrice, o.rulesRequestsMillions * r.retailPrice)); } } return { monthlyList: totalOf(lines), lines }; }
module.exports = { type: 'cdn', source: 'both', cases: [
  { name: 'Microsoft 10TB data boundary', region: 'eastus2', currency: 'USD', component: { type: 'cdn', provider: 'microsoft', egressGB: 10000, audience: 'north-america:100' },
    // Calculator microsoft Zone 1 graduated offer charges the first 10,000 GB at the first data tier.
    expected: () => cdn({ provider: 'microsoft', egressGB: 10000, audience: 'north-america:100' }) },
  { name: 'Microsoft just above 10TB and free rules', region: 'eastus2', currency: 'USD', component: { type: 'cdn', provider: 'microsoft', egressGB: 10001, audience: 'north-america:100', rules: 5 },
    // The 10,001st GB enters the second calculator data tier; first five rules are zero-priced.
    expected: () => cdn({ provider: 'microsoft', egressGB: 10001, audience: 'north-america:100', rules: 5 }) },
  { name: 'multiple audience zones and paid rules', region: 'eastus2', currency: 'USD', component: { type: 'cdn', provider: 'microsoft', egressGB: 20000, audience: 'north-america:50,asia-pacific:25,australia:25', rules: 7, rulesRequestsMillions: 10 },
    // Calculator data is split across Zone 1/2/4; rules use first-5-free bands and requests use Retail API Standard Requests.
    expected: () => cdn({ provider: 'microsoft', egressGB: 20000, audience: 'north-america:50,asia-pacific:25,australia:25', rules: 7, rulesRequestsMillions: 10 }) },

  { name: 'rules requests Learn example 500M', region: 'eastus2', currency: 'USD', component: { type: 'cdn', provider: 'microsoft', egressGB: 50000, audience: 'north-america:100', rules: 10, rulesRequestsMillions: 500 },
    // Learn example: 50 TB Zone 1 data ($3,810) + five paid rules ($5) + 500M rule requests at $0.60/M ($300) = $4,115.
    expected: () => cdn({ region: 'eastus2', provider: 'microsoft', egressGB: 50000, audience: 'north-america:100', rules: 10, rulesRequestsMillions: 500 }) },
  { name: 'US Gov Microsoft CDN', region: 'usgovvirginia', currency: 'USD', component: { type: 'cdn', provider: 'microsoft', egressGB: 10001, audience: 'north-america:100', rules: 6, rulesRequestsMillions: 2 },
    // Retail API US Gov Zone 1 rows cover data bands, first-5-free rules, and Standard Requests at the government rate.
    expected: () => cdn({ region: 'usgovvirginia', provider: 'microsoft', egressGB: 10001, audience: 'north-america:100', rules: 6, rulesRequestsMillions: 2 }) },
  { name: 'Zone 3 and Zone 5 band crossing', region: 'eastus2', currency: 'USD', component: { type: 'cdn', provider: 'microsoft', egressGB: 20002, audience: 'south-america:50,india:50' },
    // Zone 3 and Zone 5 each receive 10,001 GB, crossing the 10 TB graduated data boundary independently.
    expected: () => cdn({ region: 'eastus2', provider: 'microsoft', egressGB: 20002, audience: 'south-america:50,india:50' }) },
  { name: 'Akamai non-US audience retired', region: 'westeurope', currency: 'USD', component: { type: 'cdn', provider: 'akamai', egressGB: 12000, audience: 'europe:50,india:50' },
    // Azure CDN from Akamai is retired; the engine should refuse to price it rather than use stale calculator data.
    expectEngineError: /retired/i },
  { name: 'Verizon retail data retired', region: 'eastus2', currency: 'USD', component: { type: 'cdn', provider: 'verizon', egressGB: 10001, audience: 'north-america:100' },
    // Azure CDN from Edgio/Verizon retired on 2025-01-15; the engine should refuse to price it.
    expectEngineError: /retired/i },
  { name: 'EUR Microsoft CDN', region: 'westeurope', currency: 'EUR', component: { type: 'cdn', provider: 'microsoft', egressGB: 10001, audience: 'europe:70,south-america:30', rules: 6, rulesRequestsMillions: 1 },
    // Retail API EUR rows cover Microsoft CDN data bands across Zone 1/3, Standard Rule first-5-free tiers, and Standard Requests.
    expected: () => cdn({ currency: 'EUR', provider: 'microsoft', egressGB: 10001, audience: 'europe:70,south-america:30', rules: 6, rulesRequestsMillions: 1 }) },
] };
