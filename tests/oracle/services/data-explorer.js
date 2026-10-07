'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'data-explorer';
const HOURS = 730;
const ENGINE = {
  'e2ads-v5': { offer: 'linux-e2adsv5-standard', cores: 2, hotCacheGB: 55 },
  'e4ads-v5': { offer: 'linux-e4adsv5-standard', cores: 4, hotCacheGB: 116 },
  'e8ads-v5': { offer: 'linux-e8adsv5-standard', cores: 8, hotCacheGB: 240 },
  'l8as-v3': { offer: 'linux-l8asv3-standard', cores: 8, hotCacheGB: 1750 },
  'l16as-v3': { offer: 'linux-l16asv3-standard', cores: 16, hotCacheGB: 3500 },
  'l32as-v3': { offer: 'linux-l32asv3-standard', cores: 32, hotCacheGB: 7000 },
};
const DM = { 'd2a-v4': { sku: 'D2a v4' }, 'd4a-v4': { sku: 'D4a v4' }, 'd8a-v4': { sku: 'D8a v4' } };
const COMMIT = { payg: { vm: 'perhour', markup: 'percoreperhour' }, ri1y: { vm: 'perhouroneyearreserved', markup: 'perhouroneyearreserved' }, ri3y: { vm: 'perhourthreeyearreserved', markup: 'perhourthreeyearreserved' } };

function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function product(currency = 'USD') {
  const qs = currency === 'USD' ? 'culture=en-us' : `culture=en-us&currency=${encodeURIComponent(currency.toLowerCase())}`;
  const res = await fetch(`https://azure.microsoft.com/api/v3/pricing/${SLUG}/calculator/?${qs}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`calculator v3 ${SLUG} HTTP ${res.status}`);
  return res.json();
}
async function v3Price(data, offer, priceKey, region) {
  const r = calc.calcRegion(data, region);
  const p = data.offers[offer] && data.offers[offer].prices[priceKey] && data.offers[offer].prices[priceKey][r];
  if (!p) throw new Error(`no ${offer}/${priceKey} price for ${r}`);
  return p.value;
}
async function vmRows(region, currency) { return dedupe(await query(`serviceName eq 'Virtual Machines' and armRegionName eq '${region}'`, currency, { maxPages: 60 })); }
async function adxRows(region, currency) { return dedupe(await query(`serviceName eq 'Azure Data Explorer' and armRegionName eq '${region}'`, currency, { maxPages: 10 })); }
async function storageRows(region, currency) { return dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}'`, currency, { maxPages: 60 })); }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one row for ${what}, found ${hits.length}`); return hits[0]; }
function tiered(rows, qty) {
  const bands = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  let cost = 0;
  for (let i = 0; i < bands.length; i++) {
    const start = bands[i].tierMinimumUnits;
    const end = i + 1 < bands.length ? bands[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    cost += (Math.min(qty, end) - start) / unitSize(bands[i].unitOfMeasure) * bands[i].retailPrice;
  }
  return cost;
}
function autoEngine({ environment, workload, dailyIngestionGB, hotCacheDays, compressionRatio }) {
  if (environment === 'dev') return 'e2ads-v5';
  const hotGB = dailyIngestionGB * hotCacheDays / compressionRatio;
  if (workload === 'storage' || (workload === 'auto' && hotGB >= 480)) {
    for (const sku of ['l8as-v3', 'l16as-v3', 'l32as-v3']) {
      if (Math.ceil(hotGB / ENGINE[sku].hotCacheGB) <= 4) return sku;
    }
    return 'l32as-v3';
  }
  if (hotGB <= ENGINE['e2ads-v5'].hotCacheGB * 2) return 'e2ads-v5';
  if (hotGB <= ENGINE['e4ads-v5'].hotCacheGB * 2) return 'e4ads-v5';
  return 'e8ads-v5';
}
function autoEngineInstances({ environment, dailyIngestionGB, hotCacheDays, compressionRatio, engineSku }) {
  const minNodes = environment === 'dev' ? 1 : 2;
  const hotGB = dailyIngestionGB * hotCacheDays / compressionRatio;
  return Math.max(minNodes, Math.ceil(hotGB / ENGINE[engineSku].hotCacheGB));
}
function autoDataManagementSku(engineSku) {
  const cores = ENGINE[engineSku].cores;
  if (cores <= 4) return 'd2a-v4';
  return 'd4a-v4';
}
function retailVmSku(engineSku) { return engineSku.toUpperCase().replace(/-/g, ' ').replace('ADS', 'ads').replace('AS', 'as'); }

async function adx({ region, currency = 'USD', environment = 'production', dailyIngestionGB, retentionDays = 365, hotCacheDays = 30, compressionRatio = 7, workload = 'auto', engineSku = null, engineInstances = null, dataManagementSku = null, dataManagementInstances = null, hours = HOURS, zoneRedundantStorage = false, storageWriteOperations = null, storageReadOperations = null, commitment = 'payg' }) {
  const lines = [];
  const data = await product(currency);
  engineSku = engineSku || autoEngine({ environment, workload, dailyIngestionGB, hotCacheDays, compressionRatio });
  engineInstances = engineInstances || autoEngineInstances({ environment, dailyIngestionGB, hotCacheDays, compressionRatio, engineSku });
  dataManagementSku = dataManagementSku || autoDataManagementSku(engineSku);
  dataManagementInstances = dataManagementInstances || (environment === 'dev' ? 1 : 2);
  const e = ENGINE[engineSku];
  const keys = COMMIT[commitment];

  let engineVm; let engineExtra = { sourceOffer: `${e.offer}--${keys.vm}` };
  if (currency !== 'USD' && commitment === 'payg') {
    const rs = await vmRows(region, currency);
    const sku = retailVmSku(engineSku);
    const m = pick(rs, r => r.type === 'Consumption' && r.productName.startsWith('Virtual Machines') && !/Windows|Spot|Low Priority/i.test(r.productName + ' ' + r.skuName + ' ' + r.meterName) && r.skuName.toLowerCase() === sku.toLowerCase(), `engine ${sku}`);
    engineVm = m.retailPrice; engineExtra = { meterId: m.meterId };
  } else {
    engineVm = await v3Price(data, e.offer, keys.vm, region);
  }
  lines.push(line(`${currency} engine ${engineSku}: ${engineInstances} nodes * ${hours} hours * ${engineVm}`, engineInstances * hours * engineVm, engineExtra));

  if (environment !== 'dev') {
    let markup; let markupExtra = { sourceOffer: `markup--${keys.markup}` };
    if (currency !== 'USD' && commitment === 'payg') {
      const ar = await adxRows(region, currency);
      const m = pick(ar, r => r.type === 'Consumption' && r.meterName === 'Standard Engine Cluster Markup', 'ADX markup');
      markup = m.retailPrice; markupExtra = { meterId: m.meterId };
    } else {
      markup = await v3Price(data, 'markup', keys.markup, region);
    }
    lines.push(line(`${currency} ADX markup: ${engineInstances} nodes * ${e.cores} cores * ${hours} hours * ${markup}`, engineInstances * e.cores * hours * markup, markupExtra));
  }

  if (dataManagementInstances) {
    const rs = await vmRows(region, currency);
    const sku = DM[dataManagementSku].sku;
    const m = pick(rs, r => r.type === 'Consumption' && r.productName.startsWith('Virtual Machines') && !/Windows|Spot|Low Priority/i.test(r.productName + ' ' + r.skuName + ' ' + r.meterName) && r.skuName === sku, `data management ${sku}`);
    lines.push(line(`${currency} data management ${dataManagementSku}: ${dataManagementInstances} nodes * ${hours} hours * ${m.retailPrice}`, dataManagementInstances * hours * m.retailPrice, { meterId: m.meterId }));
  }

  if (dailyIngestionGB && retentionDays) {
    const storedGB = dailyIngestionGB * (retentionDays + 14) * 1.3 / compressionRatio;
    const defaultOps = Math.round((dailyIngestionGB / 1000) * 750000 * 30);
    if (storageWriteOperations == null) storageWriteOperations = defaultOps;
    if (storageReadOperations == null) storageReadOperations = defaultOps;
    const sr = await storageRows(region, currency);
    const sku = zoneRedundantStorage ? 'Hot ZRS' : 'Hot LRS';
    const meter = zoneRedundantStorage ? 'Hot ZRS Data Stored' : 'Hot LRS Data Stored';
    const rows = sr.filter(r => r.productName === 'General Block Blob v2' && r.skuName === sku && r.meterName === meter && r.type === 'Consumption');
    lines.push(line(`${currency} retained compressed data: ${dailyIngestionGB} GB/day * (${retentionDays} + 14) days * 1.3 / ${compressionRatio} * ${sku}`, tiered(rows, storedGB), { meterId: rows[0].meterId, storedGB: round2(storedGB) }));
    if (storageWriteOperations) {
      const wr = pick(sr, r => r.productName === 'Blob Storage' && r.skuName === sku && /Write Operations/.test(r.meterName), `${sku} write operations`);
      lines.push(line(`${currency} storage writes: ${storageWriteOperations} / ${unitSize(wr.unitOfMeasure)} * ${wr.retailPrice}`, storageWriteOperations / unitSize(wr.unitOfMeasure) * wr.retailPrice, { meterId: wr.meterId }));
    }
    if (storageReadOperations) {
      const rr = pick(sr, r => r.productName === 'Blob Storage' && r.skuName === sku && /Read Operations/.test(r.meterName), `${sku} read operations`);
      lines.push(line(`${currency} storage reads: ${storageReadOperations} / ${unitSize(rr.unitOfMeasure)} * ${rr.retailPrice}`, storageReadOperations / unitSize(rr.unitOfMeasure) * rr.retailPrice, { meterId: rr.meterId }));
    }
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = { type: 'data-explorer', source: 'both', cases: [
  { name: 'pricing page FAQ example 100GB per day production', region: 'eastus2', currency: 'USD', component: { type: 'data-explorer', dailyIngestionGB: 100, environment: 'production', retentionDays: 30, hotCacheDays: 7, compressionRatio: 7 },
    // Calculator v3 defaults: auto-select E2ads v5 with two nodes; storage is ingestion * (retention + 14 days) * 1.3 / compression and default operations are 750K/TB/day * 30.
    expected: async () => adx({ region: 'eastus2', dailyIngestionGB: 100, environment: 'production', retentionDays: 30, hotCacheDays: 7, compressionRatio: 7 }) },
  { name: 'dev cluster no data explorer markup', region: 'eastus2', currency: 'USD', component: { type: 'data-explorer', dailyIngestionGB: 10, environment: 'dev', retentionDays: 7, hotCacheDays: 1, compressionRatio: 5, hours: 100 },
    // Dev/Test auto-selects one E2ads v5 engine node, one D2a v4 data-management node, and no ADX markup.
    expected: async () => adx({ region: 'eastus2', dailyIngestionGB: 10, environment: 'dev', retentionDays: 7, hotCacheDays: 1, compressionRatio: 5, hours: 100 }) },
  { name: 'auto storage optimized for large hot cache', region: 'eastus2', currency: 'USD', component: { type: 'data-explorer', dailyIngestionGB: 5000, environment: 'production', retentionDays: 365, hotCacheDays: 365, compressionRatio: 7 },
    // A large hot-cache footprint is independently sized to storage-optimized L-series nodes, choosing L32as v3 when smaller L sizes would exceed four nodes.
    expected: async () => adx({ region: 'eastus2', dailyIngestionGB: 5000, environment: 'production', retentionDays: 365, hotCacheDays: 365, compressionRatio: 7 }) },
  { name: 'auto threshold at 480 GB hot cache', region: 'eastus2', currency: 'USD', component: { type: 'data-explorer', dailyIngestionGB: 112, environment: 'production', retentionDays: 30, hotCacheDays: 30, compressionRatio: 7 },
    // At about 480 GB of hot cache (112*30/7), the calculator-style independent rule switches to L8as v3 storage-optimized nodes.
    expected: async () => adx({ region: 'eastus2', dailyIngestionGB: 112, environment: 'production', retentionDays: 30, hotCacheDays: 30, compressionRatio: 7 }) },
  { name: 'storage workload with storage operations', region: 'eastus2', currency: 'USD', component: { type: 'data-explorer', dailyIngestionGB: 200, environment: 'production', retentionDays: 60, hotCacheDays: 14, compressionRatio: 6, workload: 'storage', storageWriteOperations: 20000, storageReadOperations: 50000 },
    // Storage workload auto-selects L8as v3; retained data uses Hot LRS and operations use Blob Storage Hot LRS meters.
    expected: async () => adx({ region: 'eastus2', dailyIngestionGB: 200, retentionDays: 60, hotCacheDays: 14, compressionRatio: 6, workload: 'storage', storageWriteOperations: 20000, storageReadOperations: 50000 }) },
  { name: 'one year reserved engine and markup east us 2', region: 'eastus2', currency: 'USD', component: { type: 'data-explorer', dailyIngestionGB: 50, environment: 'production', retentionDays: 30, hotCacheDays: 7, compressionRatio: 5, commitment: 'ri1y' },
    // Calculator v3 one-year reserved hourly prices apply to engine VMs and ADX markup in East US 2; data management remains pay-as-you-go.
    expected: async () => adx({ region: 'eastus2', dailyIngestionGB: 50, retentionDays: 30, hotCacheDays: 7, compressionRatio: 5, commitment: 'ri1y' }) },
  { name: 'three year reserved engine and markup west europe', region: 'westeurope', currency: 'USD', component: { type: 'data-explorer', dailyIngestionGB: 50, environment: 'production', retentionDays: 30, hotCacheDays: 7, compressionRatio: 5, commitment: 'ri3y' },
    // Calculator v3 three-year reserved hourly prices apply to engine VMs and ADX markup outside West US 2 as well.
    expected: async () => adx({ region: 'westeurope', dailyIngestionGB: 50, retentionDays: 30, hotCacheDays: 7, compressionRatio: 5, commitment: 'ri3y' }) },
  { name: 'non-US west europe production', region: 'westeurope', currency: 'USD', component: { type: 'data-explorer', dailyIngestionGB: 75, environment: 'production', retentionDays: 30, hotCacheDays: 7, compressionRatio: 5 },
    // West Europe uses region-specific VM and storage prices with auto-selected E2ads v5 and D2a v4 data-management servers.
    expected: async () => adx({ region: 'westeurope', dailyIngestionGB: 75, retentionDays: 30, hotCacheDays: 7, compressionRatio: 5 }) },
  { name: 'EUR west europe production', region: 'westeurope', currency: 'EUR', component: { type: 'data-explorer', dailyIngestionGB: 75, environment: 'production', retentionDays: 30, hotCacheDays: 7, compressionRatio: 5 },
    // EUR case uses Retail API EUR rows for VM, markup, data-management, and storage pay-as-you-go meters.
    expected: async () => adx({ region: 'westeurope', currency: 'EUR', dailyIngestionGB: 75, retentionDays: 30, hotCacheDays: 7, compressionRatio: 5 }) },
] };
