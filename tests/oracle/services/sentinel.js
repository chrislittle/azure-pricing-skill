'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'azure-sentinel', DAYS = 730 / 24, TIERS = [50,100,200,300,400,500,1000,2000,5000,10000,25000,50000];
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function data() { const r = await fetch(`https://azure.microsoft.com/api/v2/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`calculator ${SLUG} HTTP ${r.status}`); return r.json(); }
function price(d, offer, region) { const p = d.offers[offer].prices[calc.calcRegion(d, region)] || d.offers[offer].prices.global; if (!p) throw new Error(`missing ${offer}`); return p.value; }
async function retailRows(region, currency) { return dedupe(await query(`contains(serviceName,'Sentinel') and armRegionName eq '${region}'`, currency)); }
async function monitorRows(region, currency) { return dedupe(await query(`serviceName eq 'Azure Monitor' and armRegionName eq '${region}'`, currency)); }
async function logAnalyticsRows(region, currency) { return dedupe(await query(`serviceName eq 'Log Analytics' and armRegionName eq '${region}'`, currency)); }
function pick(rows, sku, meter) { const r = rows.find(x => x.skuName === sku && x.meterName === meter && x.type === 'Consumption'); if (!r) throw new Error(`missing ${sku}/${meter}`); return r; }
async function sentinel(cfg) {
  const d = await data(); const lines = []; const region = cfg.region; const gb = cfg.analyticsGBPerDay || 0; const commitment = String(cfg.commitment || 'payg');
  const retail = cfg.currency && cfg.currency !== 'USD' ? await retailRows(region, cfg.currency) : null;
  function retailPayg() { const r = retail && pick(retail, 'Pay-as-you-go', 'Pay-as-you-go Analysis'); return r ? r.retailPrice : price(d, 'pay-as-you-go', region); }
  function analyticsFor(comm) { if (comm === 'payg') return { name: 'pay-as-you-go', cost: gb * DAYS * retailPayg(), unit: retailPayg() }; const tier = Number(comm); const daily = price(d, `capacity-${tier}`, region); const over = Math.max(0, gb - tier); return { name: `capacity-${tier}`, cost: DAYS * (daily + over * (daily / tier)), unit: daily / tier, daily }; }
  if (gb) { const a = commitment === 'cheapest' ? ['payg', ...TIERS.map(String)].map(analyticsFor).sort((x, y) => x.cost - y.cost)[0] : analyticsFor(commitment); lines.push(line(`Analytics ${gb} GB/day via ${a.name}${a.daily ? ` plus overage at ${a.unit}/GB-day` : ''}`, a.cost, { sourceOffer: a.name })); }
  const analyticsRetention = cfg.analyticsRetentionMonths || 3;
  if (analyticsRetention > 3) { const r = pick(await logAnalyticsRows(region, cfg.currency || 'USD'), 'Analytics Logs', 'Analytics Logs Data Retention'); lines.push(line(`Analytics retention beyond 3 months: ${gb * DAYS} GB * ${analyticsRetention - 3} extra month(s) * ${r.retailPrice}`, gb * DAYS * (analyticsRetention - 3) * r.retailPrice, { meterId: r.meterId })); }
  if ((cfg.totalRetentionMonths || 0) > analyticsRetention) { const p = price(d, 'data-lake-storage-data', region); const months = cfg.totalRetentionMonths - analyticsRetention; lines.push(line(`Analytics total retention in lake: ${gb * DAYS / 6} compressed GB * ${months} month(s) * ${p}`, (gb * DAYS / 6) * months * p, { sourceOffer: 'data-lake-storage-data' })); }
  if (cfg.dataLakeGBPerDay) { const p = price(d, 'data-lake-ingestion-data', region); lines.push(line(`Data lake ingestion: ${cfg.dataLakeGBPerDay} GB/day * ${DAYS} * ${p}`, cfg.dataLakeGBPerDay * DAYS * p, { sourceOffer: 'data-lake-ingestion-data' })); const sp = price(d, 'data-lake-storage-data', region); const chargedMonths = cfg.dataLakeRetentionMonths || 12; lines.push(line(`Data lake storage with 6:1 compression: ${cfg.dataLakeGBPerDay * DAYS / 6} GB * ${chargedMonths} month(s) * ${sp}`, (cfg.dataLakeGBPerDay * DAYS / 6) * chargedMonths * sp, { sourceOffer: 'data-lake-storage-data' })); }
  if (cfg.dataProcessingGBPerDay) { const p = price(d, 'data-processing', region); lines.push(line(`Data processing: ${cfg.dataProcessingGBPerDay} GB/day * ${DAYS} * ${p}`, cfg.dataProcessingGBPerDay * DAYS * p, { sourceOffer: 'data-processing' })); }
  if (cfg.dataLakeQueryGBScanned) { const p = price(d, 'data-lake-query', region); lines.push(line(`Data lake query: ${cfg.dataLakeQueryGBScanned} GB * ${p}`, cfg.dataLakeQueryGBScanned * p, { sourceOffer: 'data-lake-query' })); }
  if (cfg.basicLogsSearchGBScanned) { const r = pick(await monitorRows(region, cfg.currency || 'USD'), 'Search Queries', 'Search Queries Scanned'); lines.push(line(`Basic logs search queries: ${cfg.basicLogsSearchGBScanned} GB * ${r.retailPrice}`, cfg.basicLogsSearchGBScanned * r.retailPrice, { meterId: r.meterId })); }
  if (cfg.searchGBScanned) { const p = price(d, 'search-jobs', region); lines.push(line(`Search jobs: ${cfg.searchGBScanned} GB * ${p}`, cfg.searchGBScanned * p, { sourceOffer: 'search-jobs' })); }
  if (cfg.restoreGBDays) { const p = price(d, 'data-restore', region); lines.push(line(`Restore: ${cfg.restoreGBDays} GB-days * ${p}`, cfg.restoreGBDays * p, { sourceOffer: 'data-restore' })); }
  if (cfg.advancedInsightsHours) { const p = price(d, 'advanced-data-insights', region); lines.push(line(`Advanced insights: ${cfg.advancedInsightsHours} h * ${p}`, cfg.advancedInsightsHours * p, { sourceOffer: 'advanced-data-insights' })); }
  if (cfg.graphHours) { const p = price(d, 'graph-size', region); lines.push(line(`Graph: ${cfg.graphHours} h * ${p}`, cfg.graphHours * p, { sourceOffer: 'graph-size' })); }
  if (cfg.sapSystems) { const p = price(d, 'protection-for-sap', region); lines.push(line(`SAP protection: ${cfg.sapSystems} systems * ${cfg.sapHours || 730} h * ${p}`, cfg.sapSystems * (cfg.sapHours || 730) * p, { sourceOffer: 'protection-for-sap' })); }
  if (cfg.basicLogsGBPerDay || cfg.auxiliaryLogsGBPerDay) { const rows = retail || await retailRows(region, cfg.currency || 'USD'); if (cfg.basicLogsGBPerDay) { const r = pick(rows, 'Basic Logs', 'Basic Logs Analysis'); lines.push(line(`Basic logs: ${cfg.basicLogsGBPerDay} GB/day * ${DAYS} * ${r.retailPrice}`, cfg.basicLogsGBPerDay * DAYS * r.retailPrice, { meterId: r.meterId })); } if (cfg.auxiliaryLogsGBPerDay) { const r = pick(rows, 'Classic Auxiliary Logs Analysis', 'Classic Auxiliary Logs Analysis'); lines.push(line(`Auxiliary logs analysis: ${cfg.auxiliaryLogsGBPerDay} GB/day * ${DAYS} * ${r.retailPrice}`, cfg.auxiliaryLogsGBPerDay * DAYS * r.retailPrice, { meterId: r.meterId })); const mon = pick(await monitorRows(region, cfg.currency || 'USD'), 'Auxiliary Logs', 'Auxiliary Logs Data Ingestion'); lines.push(line(`Azure Monitor auxiliary ingestion: ${cfg.auxiliaryLogsGBPerDay} GB/day * ${DAYS} * ${mon.retailPrice}`, cfg.auxiliaryLogsGBPerDay * DAYS * mon.retailPrice, { meterId: mon.meterId })); } }
  return { monthlyList: total(lines), lines };
}
async function eur(cfg) { cfg.currency = 'EUR'; return sentinel(cfg); }
function c(name, cfg) { const { region, currency, ...component } = cfg; return { name, region: region || 'eastus2', currency: currency || 'USD', component: { type: 'sentinel', ...component }, expected: () => currency === 'EUR' ? eur(cfg) : sentinel(cfg) }; }
const tierCases = TIERS.map(t => c(`commitment tier ${t}`, { region: 'eastus2', analyticsGBPerDay: t, commitment: String(t) }));
module.exports = { type: 'sentinel', source: 'both', cases: [
  // Calculator pay-as-you-go analytics is GB/day * 730/24 days * pay-as-you-go offer.
  c('payg analytics', { region: 'eastus2', analyticsGBPerDay: 10, commitment: 'payg' }),
  // Commitment overage bills extra GB/day at the tier effective per-GB-day rate.
  c('100 GB commitment with overage', { region: 'eastus2', analyticsGBPerDay: 125, commitment: '100' }),
  // Cheapest compares PAYG and all commitment tiers for the analytics volume.
  c('cheapest selects a tier', { region: 'eastus2', analyticsGBPerDay: 220, commitment: 'cheapest' }),
  ...tierCases,
  // West Europe exercises non-US prices; data lake storage charges all retained lake months, compressed 6:1.
  c('West Europe lake and advanced dimensions', { region: 'westeurope', analyticsGBPerDay: 0, dataLakeGBPerDay: 20, dataProcessingGBPerDay: 5, dataLakeRetentionMonths: 12, dataLakeQueryGBScanned: 1000, searchGBScanned: 500, restoreGBDays: 100, advancedInsightsHours: 10, graphHours: 5, sapSystems: 1, sapHours: 100 }),
  // US Gov Sentinel has higher PAYG and SAP hourly prices than commercial East US 2.
  c('US Gov payg and SAP', { region: 'usgovarizona', analyticsGBPerDay: 20, commitment: 'payg', sapSystems: 1, sapHours: 10 }),
  // Analytics retention after the first 3 months uses the Log Analytics Analytics Logs Data Retention meter, not data lake storage.
  c('analytics retention 6 months', { region: 'eastus2', analyticsGBPerDay: 10, commitment: 'payg', analyticsRetentionMonths: 6 }),
  // Total retention keeps analytics data in the Sentinel data lake after analytics retention, compressed 6:1.
  c('analytics total retention in lake', { region: 'eastus2', analyticsGBPerDay: 10, commitment: 'payg', analyticsRetentionMonths: 6, totalRetentionMonths: 12 }),
  // Basic logs search is billed on Azure Monitor Search Queries Scanned.
  c('basic logs search scanned', { region: 'westeurope', analyticsGBPerDay: 0, basicLogsSearchGBScanned: 1000 }),
  // Retail API EUR covers native EUR PAYG, Basic analysis, Sentinel auxiliary analysis, and the Azure Monitor auxiliary ingestion meter.
  c('EUR West Europe PAYG basic auxiliary', { region: 'westeurope', currency: 'EUR', analyticsGBPerDay: 5, commitment: 'payg', basicLogsGBPerDay: 2, auxiliaryLogsGBPerDay: 3 })
] };
