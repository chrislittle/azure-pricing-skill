'use strict';
// Azure Pricing Calculator price data, for oracles. Independent of the engine and of the Retail
// Prices API: this is the data the public calculator at azure.microsoft.com/pricing/calculator uses.
//   https://azure.microsoft.com/api/v2/pricing/<slug>/calculator/?culture=en-us
// Shape: { tiers, categories, offers: { "<offer>": { prices: { "<calc-region>": { value } } , ... } },
//          graduatedOffers, regions: [ { slug, displayName } ], schema, ... }
// Not every calculator product exposes this endpoint (some return 404).
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE = path.join(os.tmpdir(), 'azp-oracle-calculator');
const TTL = 12 * 3600 * 1000;
const REGIONS = require('../../catalog/regions.json'); // arm code -> display name

async function product(slug) {
  const f = path.join(CACHE, slug.replace(/[\\/]/g, '__') + '.json');
  try { if (Date.now() - fs.statSync(f).mtimeMs < TTL) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`https://azure.microsoft.com/api/v2/pricing/${slug}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
      if (res.status === 404) throw Object.assign(new Error(`calculator has no price data for "${slug}"`), { notFound: true });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(f, JSON.stringify(j));
      return j;
    } catch (e) { lastErr = e; if (e.notFound) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw lastErr;
}

// arm region code (eastus2) -> calculator region slug (us-east-2), via display names.
function calcRegion(data, arm) {
  const name = REGIONS[arm];
  if (!name) throw new Error(`unknown arm region ${arm}`);
  const hit = (data.regions || []).find(r => r.displayName === name);
  if (!hit) throw new Error(`calculator has no region named "${name}"`);
  return hit.slug;
}

// Price of one offer in one region. Returns the raw { value, ... } object, or throws.
async function offerPrice(slug, offer, arm) {
  const d = await product(slug);
  const o = d.offers && d.offers[offer];
  if (!o) throw new Error(`calculator ${slug}: no offer "${offer}"`);
  const r = calcRegion(d, arm);
  const p = (o.prices || {})[r] || (o.prices || {}).global;
  if (!p) throw new Error(`calculator ${slug}/${offer}: no price for ${r}`);
  return p;
}

module.exports = { product, calcRegion, offerPrice };
