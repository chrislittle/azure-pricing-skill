'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');
const HOURS = 730;
const REGION_TO_CALC = { eastus2: 'us-east-2', centralus: 'us-central', westeurope: 'europe-west', germanywestcentral: 'germany-west-central' };
function calcRegion(r) { return REGION_TO_CALC[String(r).toLowerCase().replace(/\s+/g, '')] || String(r).toLowerCase().replace(/([a-z])([0-9])/g, '$1-$2').replace(/\s+/g, '-'); }
function armRegion(r) { const s=String(r).toLowerCase(); return { 'east us 2':'eastus2','central us':'centralus','west europe':'westeurope','germany west central':'germanywestcentral' }[s] || s.replace(/\s+/g, ''); }
async function product(slug) { return calc.product(slug); }
async function calcOffer(slug, offer, region) {
  const p=await product(slug);
  const o=(p.offers||{})[offer];
  if(!o) throw new Error(`calculator offer missing ${slug}/${offer}`);
  const r = calc.calcRegion(p, armRegion(region));
  const pr=(o.prices||{})[r] || (o.prices||{}).global;
  if(!pr) throw new Error(`calculator price missing ${slug}/${offer}/${region}`);
  return { key: offer, rate: pr.value, raw: o };
}
async function calcGraduated(slug, offer, qty) {
  const p=await product(slug);
  const o=(p.graduatedOffers||{})[offer];
  if(!o) throw new Error(`calculator graduated offer missing ${slug}/${offer}`);
  const prices = ((o.global || o).prices) || (o[calc.calcRegion(p, armRegion('eastus2'))] || {}).prices;
  if (!prices) throw new Error(`calculator graduated offer ${slug}/${offer} has no prices`);
  let last=0, cost=0, out=[];
  for (const b of prices) { const lim=b.limit; const take=Math.max(0, Math.min(qty, lim) - last); if (take>0) { const c=take*b.price.value; cost += c; out.push({ from:last, to:lim===Number.MAX_VALUE?null:lim, units:take, unitPrice:b.price.value, cost:round2(c) }); } last=lim; if(qty<=lim) break; }
  return { cost, bands: out };
}
function line(desc, monthlyList, evidence) { return Object.assign({ desc, monthlyList: round2(monthlyList) }, evidence || {}); }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
async function calcHourlyLine(slug, offer, region, qtyHours, desc) { const o=await calcOffer(slug, offer, region); return line(desc || `${offer} @ ${qtyHours}h`, o.rate * qtyHours, { source: `calculator:${slug}:${offer}`, rate: o.rate, quantity: qtyHours, unit: 'hour' }); }
async function calcMonthlyLine(slug, offer, region, count, desc) { const o=await calcOffer(slug, offer, region); return line(desc || `${offer} x${count}`, o.rate * count, { source: `calculator:${slug}:${offer}`, rate: o.rate, quantity: count, unit: 'month' }); }
function result(lines, notes=[]) { return { monthlyList: total(lines), lines, notes }; }
function q(s){ return String(s).replace(/'/g,"''"); }
function pick(rows, pred, what) { const hits=rows.filter(pred); if(!hits.length) throw new Error(`oracle no row for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice || String(a.meterId).localeCompare(String(b.meterId))); return hits[0]; }
async function retailRows(filter, currency='USD') { return dedupe(await query(filter, currency)); }
async function retailLine(filter, currency, pred, qty, desc) { const row=pick(await retailRows(filter, currency), pred, desc); const cost = qty / unitSize(row.unitOfMeasure) * row.retailPrice; return line(desc, cost, { source: `retail:${row.productName}/${row.skuName}/${row.meterName}`, unitPrice: row.retailPrice, unitOfMeasure: row.unitOfMeasure, quantity: qty, meterId: row.meterId }); }
async function retailFlatReservation(filter, currency, pred, months, desc, count=1) { const row=pick(await retailRows(filter, currency), pred, desc); return line(desc, row.retailPrice / months * count, { source: `retail:${row.productName}/${row.skuName}/${row.meterName}/${row.reservationTerm}`, termPrice: row.retailPrice, months, quantity: count }); }
function tiered(rows, qty) { const tiers=rows.slice().sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits); let cost=0, bands=[]; for(let i=0;i<tiers.length;i++){ const start=tiers[i].tierMinimumUnits||0, end=i+1<tiers.length?tiers[i+1].tierMinimumUnits:Infinity; if(qty<=start) break; const units=Math.min(qty,end)-start; const c=units*tiers[i].retailPrice; cost+=c; bands.push({from:start,to:end===Infinity?null:end,units,unitPrice:tiers[i].retailPrice,cost:round2(c)});} return { cost, bands }; }
async function retailTieredLine(filter, currency, pred, qty, desc) { const rows=(await retailRows(filter,currency)).filter(pred); if(!rows.length) throw new Error(`oracle no tier rows for ${desc}`); const t=tiered(rows, qty); const r=rows[0]; return line(desc, t.cost, { source: `retail:${r.productName}/${r.skuName}/${r.meterName}`, quantity: qty, unitOfMeasure: r.unitOfMeasure, bands:t.bands }); }
module.exports = { HOURS, round2, unitSize, armRegion, calcRegion, calcOffer, calcGraduated, calcHourlyLine, calcMonthlyLine, product, line, total, result, q, pick, retailRows, retailLine, retailFlatReservation, retailTieredLine };
