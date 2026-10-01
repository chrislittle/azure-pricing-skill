'use strict';
// Billing-unit math: unitOfMeasure parsing, graduated tiers, rounding.

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Returns { size, kind } where kind is 'hour' | 'month' | 'quantity' | 'day' | 'year' | 'second'.
// retailPrice is the price for ONE whole unitOfMeasure.
function parseUnit(uom) {
  const u = String(uom || '').trim();
  const m = u.match(/^([\d.,]+)\s*([KMB])?\b\s*(.*)$/i);
  let size = 1, rest = u;
  if (m) {
    size = parseFloat(m[1].replace(/,/g, ''));
    const mult = (m[2] || '').toUpperCase();
    if (mult === 'K') size *= 1e3; else if (mult === 'M') size *= 1e6; else if (mult === 'B') size *= 1e9;
    rest = m[3] || '';
  }
  const r = rest.toLowerCase();
  let kind = 'quantity';
  if (/\/\s*month|^month/.test(r)) kind = 'month';
  else if (/^hours?$|\/\s*hour$/.test(r)) kind = 'hour';
  else if (/\/\s*day|^days?$/.test(r)) kind = 'day';
  else if (/\/\s*year|^years?$/.test(r)) kind = 'year';
  else if (/^seconds?$/.test(r)) kind = 'second';
  return { size, kind, label: u, rest };
}

// Graduated pricing. rows: all bands of ONE meter (same meterId). qtyUnits: quantity already
// normalized into billing units (raw quantity / unitSize). Returns { cost, bands:[...] }.
function tieredCost(rows, qtyUnits) {
  const bands = [...rows].sort((a, b) => (a.tierMinimumUnits || 0) - (b.tierMinimumUnits || 0));
  let cost = 0; const used = [];
  for (let i = 0; i < bands.length; i++) {
    const lo = bands[i].tierMinimumUnits || 0;
    const hi = i + 1 < bands.length ? bands[i + 1].tierMinimumUnits : Infinity;
    if (qtyUnits <= lo) break;
    const slice = Math.min(qtyUnits, hi) - lo;
    const c = slice * bands[i].retailPrice;
    cost += c;
    used.push({ from: lo, to: Math.min(qtyUnits, hi), units: slice, price: bands[i].retailPrice, cost: c });
  }
  return { cost, bands: used };
}

// Cost for a raw quantity on a (possibly tiered) meter.
// If `ledger` is given (one per option = one subscription), tiers and free bands are shared across
// components: the charge is cost(previous + qty) - cost(previous), like a real monthly bill.
function meterCost(rows, rawQty, ledger) {
  const unit = parseUnit(rows[0].unitOfMeasure);
  const qtyUnits = rawQty / unit.size;
  const calc = q => rows.length > 1 ? tieredCost(rows, q) : { cost: q * rows[0].retailPrice, bands: [] };
  if (!ledger || rows.length < 2) return { ...calc(qtyUnits), unit, qtyUnits };
  const key = rows[0].meterId;
  const prev = ledger[key] || 0;
  ledger[key] = prev + qtyUnits;
  const a = calc(prev + qtyUnits), b = calc(prev);
  return { cost: a.cost - b.cost, bands: a.bands, unit, qtyUnits, sharedFrom: prev };
}

function termMonths(term) {
  const t = String(term || '').toLowerCase();
  const n = parseFloat(t) || 1;
  if (t.includes('year')) return n * 12;
  if (t.includes('month')) return n;
  throw new Error('Unknown reservation term: ' + term);
}

module.exports = { round2, parseUnit, tieredCost, meterCost, termMonths };
