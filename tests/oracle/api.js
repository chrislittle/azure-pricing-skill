'use strict';

const BASE = 'https://prices.azure.com/api/retail/prices';
const API_VERSION = '2023-01-01-preview';

const _cache = new Map();

async function query(filter, currency = 'USD', opts = {}) {
  const key = currency + '||' + filter;
  if (_cache.has(key)) return _cache.get(key);

  const rows = [];
  let url = `${BASE}?api-version=${API_VERSION}&currencyCode=${encodeURIComponent(`'${currency}'`)}&$filter=${encodeURIComponent(filter)}`;
  let pages = 0;
  while (url) {
    let res, lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (res.ok) break;
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        res = null;
      } catch (e) {
        lastErr = e;
        res = null;
      }
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
    if (!res) throw lastErr;
    const body = await res.json();
    for (const it of body.Items || []) rows.push(it);
    url = body.NextPageLink || null;
    pages++;
    if (pages > (opts.maxPages || 60)) break;
  }
  _cache.set(key, rows);
  return rows;
}

// De-duplicate identical rows: same meterId, tierMinimumUnits, retailPrice, type
function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = [r.meterId, r.tierMinimumUnits, r.retailPrice, r.type, r.skuId || '', r.unitOfMeasure || ''].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// unitOfMeasure -> numeric unit size, e.g. '1 Hour'->1, '10K'->10000, '1M'->1000000,
// '100'->100, '1/Month'->1, '1 GB/Month'->1, '10K Requests'->10000
function unitSize(unitOfMeasure) {
  if (!unitOfMeasure) return 1;
  const u = String(unitOfMeasure).trim();
  const m = u.match(/^([\d.,]+)\s*([KMB]?)/i);
  if (!m) return 1;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(n) || n === 0) return 1;
  const mult = (m[2] || '').toUpperCase();
  if (mult === 'K') n *= 1e3;
  else if (mult === 'M') n *= 1e6;
  else if (mult === 'B') n *= 1e9;
  return n;
}

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

module.exports = { query, dedupe, unitSize, round2, BASE, API_VERSION };
