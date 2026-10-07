'use strict';
const { query, dedupe, round2 } = require('../api');
const SLUG = 'azure-devops';
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function data() { const r = await fetch(`https://azure.microsoft.com/api/v2/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`calculator ${SLUG} HTTP ${r.status}`); return r.json(); }
function price(d, offer) { return d.offers[offer].prices.global.value; }
function graduated(d, offer, qty) { const bands = d.graduatedOffers[offer].global.prices; let prev = 0, cost = 0; for (const b of bands) { const units = Math.max(0, Math.min(qty, b.limit) - prev); cost += units * b.price.value; if (qty <= b.limit) break; prev = b.limit; } return cost; }
async function devopsRows(currency) { return dedupe(await query(`serviceName eq 'Azure DevOps'`, currency)); }
async function githubRows(currency) { return dedupe(await query(`serviceName eq 'GitHub'`, currency)); }
function pick(rows, pred, what) { const r = rows.find(pred); if (!r) throw new Error(`missing ${what}`); return r; }
async function devops(cfg) { const d = await data(); const lines = []; const rows = await devopsRows(cfg.currency || 'USD');
  const paidBasic = Math.max(0, (cfg.basicUsers || 0) - 5); if (paidBasic) { const r = pick(rows, x => x.productName === 'Azure Repos and Boards (Basic)' && x.skuName === 'Basic' && x.meterName === 'Basic User', 'Basic User'); lines.push(line(`Basic users beyond 5 free: ${paidBasic} * ${r.retailPrice}`, paidBasic * r.retailPrice, { meterId: r.meterId })); }
  if (cfg.testPlansUsers) { const r = pick(rows, x => x.productName === 'Azure Test Plans' && x.skuName === 'Standard' && x.meterName === 'Standard User', 'Test Plans Standard User'); lines.push(line(`Test Plans users: ${cfg.testPlansUsers} * ${r.retailPrice}`, cfg.testPlansUsers * r.retailPrice, { meterId: r.meterId })); }
  const hosted = cfg.hostedJobs || 0; if (hosted) { const r = pick(rows, x => x.productName === 'Azure Pipelines' && x.skuName === 'Microsoft-hosted CI/CD' && x.meterName === 'Microsoft-hosted CI/CD Concurrent Job', 'Microsoft-hosted CI/CD Concurrent Job'); lines.push(line(`Microsoft-hosted paid parallel jobs: ${hosted} * ${r.retailPrice}; purchased jobs replace the free-tier grant`, hosted * r.retailPrice, { meterId: r.meterId })); }
  const self = Math.max(0, (cfg.selfHostedJobs || 1) - 1); if (self) { const r = pick(rows, x => x.productName === 'Azure Pipelines' && x.skuName === 'Self-hosted CI/CD' && x.meterName === 'Self-hosted CI/CD Concurrent Job', 'Self-hosted CI/CD Concurrent Job'); lines.push(line(`Self-hosted parallel jobs beyond 1 free: ${self} * ${r.retailPrice}`, self * r.retailPrice, { meterId: r.meterId })); }
  if (cfg.artifactsGB) { const arts = rows.filter(r => r.productName === 'Azure Artifacts' && r.meterName === 'Standard Data Stored').sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits); const charge = Math.max(0, cfg.artifactsGB - 2); let cost = 0; for (let i=0;i<arts.length;i++){ const start=arts[i].tierMinimumUnits, end=i+1<arts.length?arts[i+1].tierMinimumUnits:Infinity; if(charge<=start) break; cost += (Math.min(charge,end)-start)*arts[i].retailPrice; } lines.push(line(`Artifacts graduated storage after 2 GB free: ${cfg.artifactsGB} GB`, cost, { meterId: arts[0] && arts[0].meterId })); }
  const minuteMeters = { macosMinutes: ['macOS Standard', 'macOS Standard Job'], macosXLMinutes: ['macOS XL', 'macOS XL Job'], linux8CoreMinutes: ['Linux 8-core', 'Linux 8-core Job'], linux16CoreMinutes: ['Linux 16-core', 'Linux 16-core Job'], windows8CoreMinutes: ['Windows 8-core', 'Windows 8-core Job'], windows16CoreMinutes: ['Windows 16-core', 'Windows 16-core Job'] };
  for (const [field, [sku, meter]] of Object.entries(minuteMeters)) if (cfg[field]) { const r = pick(rows, x => x.productName === 'Azure Pipelines' && x.skuName === sku && x.meterName === meter, `${sku} ${meter}`); lines.push(line(`${field}: ${cfg[field]} min * ${r.retailPrice}`, cfg[field] * r.retailPrice, { meterId: r.meterId })); }
  if (cfg.loadTestVirtualUserMinutes) lines.push(line(`Load testing graduated VU-min, first 20000 free: ${cfg.loadTestVirtualUserMinutes}`, graduated(d, 'shared-resources-load-testing', cfg.loadTestVirtualUserMinutes), { sourceOffer: 'shared-resources-load-testing' }));
  if (cfg.aiCredits) { const r = pick(await githubRows(cfg.currency || 'USD'), x => x.productName === 'GitHub Advanced Security' && x.skuName === 'AI Credit for AzDO' && x.meterName === 'AI Credit for AzDO GAC', 'AI Credit for AzDO GAC'); lines.push(line(`AI credits for AzDO: ${cfg.aiCredits} * ${r.retailPrice}`, cfg.aiCredits * r.retailPrice, { meterId: r.meterId })); }
  if (cfg.ghasCommitters) { const p = price(d, 'advanced-security'); lines.push(line(`Advanced Security committers: ${cfg.ghasCommitters} * ${p}`, cfg.ghasCommitters * p, { sourceOffer: 'advanced-security' })); }
  if (cfg.codeScanningCommitters) { const p = price(d, 'code-scanning'); lines.push(line(`Code scanning committers: ${cfg.codeScanningCommitters} * ${p}`, cfg.codeScanningCommitters * p, { sourceOffer: 'code-scanning' })); }
  if (cfg.secretScanningCommitters) { const p = price(d, 'secret-scanning'); lines.push(line(`Secret scanning committers: ${cfg.secretScanningCommitters} * ${p}`, cfg.secretScanningCommitters * p, { sourceOffer: 'secret-scanning' })); }
  return { monthlyList: total(lines), lines };
}
async function eur(cfg) { cfg.currency = 'EUR'; return devops(cfg); }
function c(name, cfg) { const { region, currency, ...component } = cfg; return { name, region: region || 'eastus2', currency: currency || 'USD', component: { type: 'azure-devops', ...component }, expected: () => currency === 'EUR' ? eur(cfg) : devops(cfg) }; }
module.exports = { type: 'azure-devops', source: 'both', cases: [
  // First 5 Basic users, first self-hosted job, and first 2 GB Artifacts are free; one purchased hosted job is billed because it replaces the free-tier grant.
  c('free grants plus one purchased hosted job', { basicUsers: 5, hostedJobs: 1, selfHostedJobs: 1, artifactsGB: 2 }),
  // One above grants: Basic and self-hosted subtract their free grants; Microsoft-hosted bills both jobs because Learn says the first purchase only removes free-tier time limits.
  c('just above free grants', { basicUsers: 6, hostedJobs: 2, selfHostedJobs: 2, artifactsGB: 3 }),
  // Test Plans users are charged separately and include Basic access.
  c('test plans users', { basicUsers: 0, testPlansUsers: 3, hostedJobs: 1, selfHostedJobs: 1 }),
  // Larger hosted agents and load testing use per-minute/graduated meters.
  c('larger agents and load testing', { basicUsers: 5, macosMinutes: 100, macosXLMinutes: 50, loadTestVirtualUserMinutes: 25000 }),
  // Linux and Windows larger-agent minutes use their own Retail per-minute meters, not macOS prices.
  c('Linux and Windows larger agents', { basicUsers: 5, linux8CoreMinutes: 1000, linux16CoreMinutes: 500, windows8CoreMinutes: 1000, windows16CoreMinutes: 500 }),
  // AI credits for Azure DevOps Advanced Security use the GitHub "AI Credit for AzDO GAC" Retail meter.
  c('AI credits', { basicUsers: 5, aiCredits: 1000 }),
  // Security products bill per committer/month.
  c('security committers', { basicUsers: 5, ghasCommitters: 2, codeScanningCommitters: 3, secretScanningCommitters: 4 }),
  // Azure DevOps calculator prices are global; three Microsoft-hosted concurrent jobs require three paid jobs.
  c('West Europe global prices', { region: 'westeurope', basicUsers: 10, hostedJobs: 3, artifactsGB: 20 }),
  // Retail API EUR: Basic users after 5 free and Artifacts after 2 GB free, no FX conversion.
  c('EUR Basic and Artifacts', { region: 'westeurope', currency: 'EUR', basicUsers: 7, artifactsGB: 12 }),
  // Retail API EUR: Test Plans has no 5-user free grant; query Standard User natively in EUR.
  c('EUR Test Plans', { region: 'westeurope', currency: 'EUR', basicUsers: 0, testPlansUsers: 2 })
] };
