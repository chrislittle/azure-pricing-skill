'use strict';
// Contract checks for the built-in types (scripts/lib/recipes.js + schema.js), which
// services-contract.js does not cover: a baseline component prices cleanly in two regions with
// finite lines that add up, the readback is clean, and bad quantities are refused, not priced.
// usage: node tests/unit/builtin-contract.js [type,type,...]
const { priceSpec } = require('../../scripts/lib/estimate');
const { readback } = require('../../scripts/lib/readback');
const { SCHEMA } = require('../../scripts/lib/schema');
const SERVICES = require('../../scripts/lib/services');

// Baselines use the same shapes as the canonical scenarios in engine-vs-oracle.js.
const BASE = {
  vm: { type: 'vm', sku: 'Standard_D4as_v5' },
  disk: { type: 'disk', diskType: 'premium-ssd', sizeGiB: 128 },
  'public-ip': { type: 'public-ip' },
  bandwidth: { type: 'bandwidth', egressGB: 200 },
  'load-balancer': { type: 'load-balancer', rules: 5, processedGB: 1024 },
  'app-gateway': { type: 'app-gateway' },
  aks: { type: 'aks', tier: 'standard' },
  'app-service': { type: 'app-service', plan: 'P1v3', os: 'windows', count: 2 },
  functions: { type: 'functions', executions: 5000000, gbSeconds: 500000 },
  'container-apps': { type: 'container-apps', apps: 2, vcpu: 0.5, memGiB: 1, replicas: 1, requests: 3000000 },
  'sql-database': { type: 'sql-database', vcores: 4, storageGB: 250 },
  'sql-mi': { type: 'sql-mi', vcores: 8, storageGB: 512 },
  postgres: { type: 'postgres', vcores: 4, storageGB: 512 },
  mysql: { type: 'mysql', vcores: 4, storageGB: 512 },
  cosmos: { type: 'cosmos', mode: 'autoscale', maxRU: 4000, storageGB: 100 },
  blob: { type: 'blob', tier: 'Hot', capacityGB: 2048, readOps: 4000000 },
  files: { type: 'files', capacityGB: 1024 },
  'log-analytics': { type: 'log-analytics', ingestGBPerDay: 10 },
  meter: { type: 'meter', filter: { serviceName: 'Virtual Network', productName: 'Public IP Prefix', meterName: 'Standard Static IP Addresses' }, quantity: 2, hours: 730 },
  openai: { type: 'openai', model: 'gpt-5-nano', inputTokens: 200000000, outputTokens: 40000000 }
};
const REGIONS = ['eastus2', 'westeurope'];
const only = (process.argv[2] || '').split(',').filter(Boolean);
const spec = (c, region = REGIONS[0]) => ({ region, discountPct: 0, options: [{ name: 'x', components: [c] }] });

(async () => {
  let pass = 0; const fails = []; const skipped = [];
  for (const t of Object.keys(SCHEMA).filter(x => !SERVICES[x])) {
    if (only.length && !only.includes(t)) continue;
    const base = BASE[t];
    if (!base) { skipped.push(t); continue; }
    const bad = m => fails.push(`${t}: ${m}`);
    // 1. Baseline prices cleanly and the lines add up.
    for (const region of REGIONS) {
      const o = (await priceSpec(spec(base, region))).options[0];
      if (o.errors.length) { bad(`baseline does not price in ${region}: ${o.errors.join('; ')}`); continue; }
      if (!o.lines.length || !(o.totalList > 0)) { bad(`baseline has no cost in ${region}`); continue; }
      if (o.lines.some(l => !Number.isFinite(l.list))) { bad(`non-finite line in ${region}`); continue; }
      const sum = Math.round(o.lines.reduce((s, l) => s + l.list, 0) * 100) / 100;
      if (Math.abs(sum - o.totalList) > 0.011) bad(`lines (${sum}) do not add up to total (${o.totalList}) in ${region}`); else pass++;
    }
    // 2. Readback is clean.
    try { const rb = readback(spec(base)); if (/undefined|NaN|\[object/.test(rb.text)) bad('readback contains undefined/NaN/[object]'); else pass++; }
    catch (e) { bad(`readback throws: ${e.message}`); }
    // 3. Every quantity field refuses text and negative numbers instead of pricing them.
    for (const [k, f] of Object.entries(SCHEMA[t].fields || {})) {
      if (f.enum || typeof f.def === 'boolean' || typeof f.def === 'string') continue;
      const isQty = typeof f.def === 'number' || f.int || f.min != null || f.max != null || typeof base[k] === 'number';
      if (!isQty) continue;
      for (const v of ['abc', -5]) {
        const o = (await priceSpec(spec(Object.assign({}, base, { [k]: v })))).options[0];
        if (o.errors.length) pass++;
        else bad(`field ${k}=${JSON.stringify(v)} priced (${o.totalList}) instead of an error`);
      }
    }
  }
  if (!only.length || only.includes('meter')) {
    const GB = { serviceName: 'Load Balancer', armRegionName: 'Global', skuName: 'Standard', meterName: 'Standard Data Processed' };
    const chk = async (name, c, wantErr) => { const o = (await priceSpec(spec(c))).options[0]; if (!!o.errors.length === wantErr && (wantErr || o.totalList > 0)) pass++; else bad('meter ' + name + ': ' + (o.errors.join('; ') || 'priced ' + o.totalList)); };
    await chk('per-GB prices', { type: 'meter', filter: GB, quantity: 100 }, false);
    await chk('hours refused on per-GB', { type: 'meter', filter: GB, quantity: 100, hours: 5 }, true);
    await chk('hourly without hours refused', { type: 'meter', filter: BASE.meter.filter, quantity: 2 }, true);
    await chk('missing quantity refused', { type: 'meter', filter: GB }, true);
    await chk('typo key refused', Object.assign({}, BASE.meter, { hour: 5 }), true);
  }
  console.log(`builtin contract: ${pass} pass, ${fails.length} fail${skipped.length ? ` (no baseline: ${skipped.join(', ')})` : ''}`);
  for (const f of fails) console.log('FAIL ' + f);
  process.exitCode = fails.length ? 1 : 0;
})();
