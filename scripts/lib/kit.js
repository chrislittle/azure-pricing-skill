'use strict';
// Shared building blocks for service recipes (scripts/lib/services/*.js).
// A recipe returns { lines, notes, facts }.
// line: { group, service, desc, qty, unit, unitPrice, list, meter }
//   list = monthly list cost at full precision (rounded later, per line).
const { query, dedupe, q } = require('./api');
const { parseUnit, tieredCost, meterCost, termMonths, round2 } = require('./units');

const HOURS = 730;
const DAYS = HOURS / 24;

class PricingError extends Error {
  constructor(msg, candidates) { super(msg); this.candidates = candidates || []; }
}

function meterInfo(r) {
  return { meterId: r.meterId, serviceName: r.serviceName, productName: r.productName, skuName: r.skuName,
    meterName: r.meterName, unitOfMeasure: r.unitOfMeasure, armRegionName: r.armRegionName, retailPrice: r.retailPrice };
}

async function rows(filter, ctx) { return dedupe(await query(filter, ctx.currency)); }

// Rows for exactly one meter (all tier bands). Throws with candidates if 0 or >1 meters.
function single(rs, what) {
  const ids = [...new Set(rs.map(r => r.meterId))];
  if (ids.length === 0) throw new PricingError(`No price found for ${what}.`);
  if (ids.length > 1) {
    // Identical price under several meterIds (catalog aliases) is safe to collapse.
    const sig = new Set(rs.map(r => r.tierMinimumUnits + ':' + r.retailPrice));
    const perId = rs.filter(r => r.meterId === ids[0]).length;
    if (sig.size === perId) return rs.filter(r => r.meterId === ids[0]);
    throw new PricingError(`Ambiguous meters for ${what}: ${ids.length} candidates.`, rs.slice(0, 12).map(meterInfo));
  }
  return rs;
}

function line(group, service, desc, qty, unit, unitPrice, list, meter, extra) {
  return Object.assign({ group, service, desc, qty, unit, unitPrice, list, meter }, extra || {});
}

const regionFilter = ctx => `armRegionName eq '${q(ctx.region)}'`;
const fmtN = v => Number(v).toLocaleString('en-US');

// One priced line for a raw quantity on a (possibly tiered) meter. Honors free bands and shares
// tiers across components in the same option through ctx.ledger.
function meterLine(group, service, desc, meterRows, rawQty, ctx, extra) {
  const r0 = meterRows.find(r => r.retailPrice > 0) || meterRows[0];
  const mc = meterCost(meterRows, rawQty, ctx && ctx.ledger);
  const u = parseUnit(meterRows[0].unitOfMeasure);
  return line(group, service, desc, rawQty, extra && extra.unit || meterRows[0].unitOfMeasure, r0.retailPrice, mc.cost, meterInfo(meterRows[0]),
    Object.assign({ unitLabel: u.size !== 1 ? `per ${meterRows[0].unitOfMeasure}` : undefined }, extra || {}));
}

module.exports = { HOURS, DAYS, PricingError, meterInfo, rows, single, line, regionFilter, meterLine, fmtN,
  query, dedupe, q, parseUnit, tieredCost, meterCost, termMonths, round2 };
