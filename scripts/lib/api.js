'use strict';
// Azure Retail Prices API client: paging, on-disk cache, de-duplication.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE = 'https://prices.azure.com/api/retail/prices';
const API_VERSION = '2023-01-01-preview'; // required for savingsPlan data
const CACHE_DIR = process.env.AZP_CACHE_DIR || path.join(os.tmpdir(), 'azure-pricing-cache');
const CACHE_TTL_MS = 12 * 3600 * 1000;

function cacheFile(key) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}

async function fetchJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'accept': 'application/json' } });
    if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
    return await res.json();
  } catch (e) {
    if (attempt < 4) {
      await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
      return fetchJson(url, attempt + 1);
    }
    throw new Error('Retail Prices API request failed: ' + e.message + ' (' + url + ')');
  }
}

// query(filter, currency) -> array of raw items (all pages)
async function query(filter, currency = 'USD') {
  const key = currency + '|' + filter;
  const cf = cacheFile(key);
  try {
    const st = fs.statSync(cf);
    if (Date.now() - st.mtimeMs < CACHE_TTL_MS) return JSON.parse(fs.readFileSync(cf, 'utf8'));
  } catch (_) { /* no cache */ }
  let url = `${BASE}?api-version=${API_VERSION}&currencyCode='${currency}'&$filter=${encodeURIComponent(filter)}`;
  const all = [];
  let pages = 0;
  while (url) {
    const j = await fetchJson(url);
    all.push(...(j.Items || []));
    url = j.NextPageLink || null;
    if (++pages > 60) throw new Error('Too many pages for filter: ' + filter + ' — narrow the filter.');
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cf, JSON.stringify(all));
  return all;
}

// Same meter is often returned several times under different skuIds/product aliases.
function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const k = [it.meterId, it.tierMinimumUnits, it.retailPrice, it.type, it.reservationTerm || ''].join('|');
    if (!seen.has(k)) seen.set(k, it);
  }
  return [...seen.values()];
}

function q(s) { return String(s).replace(/'/g, "''"); }

module.exports = { query, dedupe, q, CACHE_DIR };
