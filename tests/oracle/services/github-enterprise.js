'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function rows(currency) { return dedupe(await query("serviceName eq 'GitHub'", currency, { maxPages: 30 })); }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one GitHub row for ${what}, found ${hits.length}`); return hits[0]; }
function addMonthly(lines, rs, qty, pred, what) { if (!qty) return; const r = pick(rs, pred, what); lines.push(line(`${what}: ${qty} * ${r.retailPrice}`, qty * r.retailPrice, { meterId: r.meterId })); }
const CODESPACES = { 2: 'Development Optimized D2', 4: 'Development Optimized D4', 8: 'Development Optimized D8', 16: 'Development Optimized D16', 32: 'Development Optimized D32' };
function includedMinutes(opts) { return opts.actionsIncludedMinutes != null ? opts.actionsIncludedMinutes : opts.enterpriseUsers ? 50000 : 0; }
async function github(opts) {
  const rs = await rows(opts.currency || 'USD'); const lines = [];
  addMonthly(lines, rs, opts.enterpriseUsers, r => r.productName === 'GitHub Enterprise (GHE)' && r.skuName === 'Enterprise' && r.meterName === 'Enterprise User', 'GitHub Enterprise user');
  addMonthly(lines, rs, opts.advancedSecurityCommitters, r => r.productName === 'GitHub Advanced Security GHE' && r.skuName === 'Advanced Security GHE', 'GitHub Advanced Security GHE committer');
  addMonthly(lines, rs, opts.codeSecurityCommitters, r => r.productName === 'GitHub Advanced Security GHE' && r.skuName === 'Code Scanning for GHE', 'GitHub Code Scanning for GHE committer');
  addMonthly(lines, rs, opts.secretProtectionCommitters, r => r.productName === 'GitHub Advanced Security GHE' && r.skuName === 'Secret Scanning for GHE', 'GitHub Secret Scanning for GHE committer');
  addMonthly(lines, rs, opts.codeQualityCommitters, r => r.productName === 'GitHub Code Quality' && r.skuName === 'Code Quality for GHE', 'GitHub Code Quality committer');
  addMonthly(lines, rs, opts.azdoAdvancedSecurityCommitters, r => r.productName === 'GitHub Advanced Security' && r.skuName === 'Advanced Security for AzDO', 'AzDO Advanced Security committer');
  addMonthly(lines, rs, opts.azdoCodeSecurityCommitters, r => r.productName === 'GitHub Advanced Security' && r.skuName === 'Code Scanning for AzDO', 'AzDO Code Scanning committer');
  addMonthly(lines, rs, opts.azdoSecretProtectionCommitters, r => r.productName === 'GitHub Advanced Security' && r.skuName === 'Secret Scanning for AzDO', 'AzDO Secret Scanning committer');
  addMonthly(lines, rs, opts.copilotBusinessUsers, r => r.productName === 'GitHub Copilot' && r.skuName === 'Business' && r.meterName === 'Business User', 'Copilot Business user');
  addMonthly(lines, rs, opts.copilotBusinessStandaloneUsers, r => r.productName === 'GitHub Copilot' && r.skuName === 'Business for non-GHE customers', 'Copilot Business standalone user');
  addMonthly(lines, rs, opts.copilotEnterpriseUsers, r => r.productName === 'GitHub Copilot' && r.skuName === 'Enterprise' && r.meterName === 'Enterprise User', 'Copilot Enterprise user');
  addMonthly(lines, rs, opts.premiumRequests, r => r.productName === 'GitHub Enterprise (GHE)' && r.skuName === 'Premium Request', 'GitHub premium request');
  addMonthly(lines, rs, opts.aiCredits, r => r.productName === 'GitHub Enterprise (GHE)' && r.skuName === 'AI Credit', 'GitHub AI credit');

  let included = includedMinutes(opts);
  for (const [key, sku, label, job] of [
    ['actionsLinuxSlimMinutes', 'Linux B1', 'Actions Linux 1-core overage', true],
    ['actionsLinuxArmMinutes', 'Linux ARM B2', 'Actions Linux ARM 2-core overage', true],
    ['actionsLinuxMinutes', 'Linux', 'Actions Linux overage', false],
    ['actionsWindowsArmMinutes', 'Windows ARM B2', 'Actions Windows ARM 2-core overage', true],
    ['actionsWindowsMinutes', 'Windows', 'Actions Windows overage', false],
    ['actionsMacosMinutes', 'macOS', 'Actions macOS overage', false],
  ]) {
    const used = opts[key] || 0; const covered = Math.min(used, included); const bill = used - covered; included -= covered;
    if (bill) addMonthly(lines, rs, bill, r => r.productName === 'GitHub Actions' && r.skuName === sku && (job ? / Job$/.test(r.meterName) : /Overage$/.test(r.meterName)), label);
  }
  for (const lr of opts.largerRunners || []) addMonthly(lines, rs, lr.minutes, r => r.productName === 'GitHub Actions' && r.skuName === lr.runner && / Job$/.test(r.meterName), `Actions larger runner ${lr.runner}`);
  addMonthly(lines, rs, opts.sharedStorageGb, r => r.productName === 'GitHub Storage' && r.skuName === 'Packages', 'Actions artifacts and Packages shared storage GB-month overage');
  addMonthly(lines, rs, opts.actionsCacheStorageGb, r => r.productName === 'GitHub Storage' && r.skuName === 'Actions', 'Actions cache/custom image storage GB-month');
  addMonthly(lines, rs, opts.actionsTransferGb, r => r.productName === 'GitHub Bandwidth' && r.skuName === 'Action', 'Actions data transfer GB');

  for (const cs of opts.codespaces || []) addMonthly(lines, rs, cs.hours * (cs.developers == null ? 1 : cs.developers), r => r.productName === 'GitHub Codespaces - Linux' && r.skuName === CODESPACES[cs.cores], `Codespaces ${cs.cores} core hours`);
  addMonthly(lines, rs, opts.codespacesStorageGb, r => r.productName === 'GitHub Storage' && r.skuName === 'Codespaces', 'Codespaces storage GB-month');
  addMonthly(lines, rs, opts.packagesTransferGb, r => r.productName === 'GitHub Packages' && r.meterName === 'Standard Data Transfer Out Overage', 'Packages transfer GB overage');
  const lfsFree = opts.enterpriseUsers ? 250 : 0;
  addMonthly(lines, rs, Math.max(0, (opts.lfsStorageGb || 0) - lfsFree), r => r.productName === 'GitHub Storage' && r.skuName === 'LFS', 'LFS storage GB-month above free quota');
  addMonthly(lines, rs, Math.max(0, (opts.lfsTransferGb || 0) - lfsFree), r => r.productName === 'GitHub Bandwidth' && r.skuName === 'LFS', 'LFS transfer GB above free quota');
  return { monthlyList: totalOf(lines), lines };
}

module.exports = { type: 'github-enterprise', source: 'retail-api', cases: [
  { name: 'enterprise seats and security add-ons', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', enterpriseUsers: 10, advancedSecurityCommitters: 3, codeSecurityCommitters: 2, secretProtectionCommitters: 2, codeQualityCommitters: 4, azdoAdvancedSecurityCommitters: 1, azdoCodeSecurityCommitters: 1, azdoSecretProtectionCommitters: 1 },
    // Retail API GitHub seat and security meters are Global monthly per user/committer rows under GitHub Enterprise/GHE, Advanced Security, and Code Quality products.
    expected: async () => github({ currency: 'USD', enterpriseUsers: 10, advancedSecurityCommitters: 3, codeSecurityCommitters: 2, secretProtectionCommitters: 2, codeQualityCommitters: 4, azdoAdvancedSecurityCommitters: 1, azdoCodeSecurityCommitters: 1, azdoSecretProtectionCommitters: 1 }) },
  { name: 'copilot seats premium requests and ai credits', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', copilotBusinessUsers: 5, copilotBusinessStandaloneUsers: 2, copilotEnterpriseUsers: 3, premiumRequests: 1000, aiCredits: 2500 },
    // Retail API GitHub Copilot Business, standalone Business, Enterprise, Premium Request, and AI Credit rows are all Global consumption meters.
    expected: async () => github({ currency: 'USD', copilotBusinessUsers: 5, copilotBusinessStandaloneUsers: 2, copilotEnterpriseUsers: 3, premiumRequests: 1000, aiCredits: 2500 }) },
  { name: 'actions included minutes boundary', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', enterpriseUsers: 1, actionsLinuxMinutes: 30000, actionsWindowsMinutes: 15000, actionsMacosMinutes: 5000, actionsIncludedMinutes: 50000 },
    // Included Actions minutes are consumed in Linux, then Windows, then macOS order; exactly 50,000 included minutes leaves no overage lines; the Enterprise seat keeps the case billable.
    expected: async () => github({ currency: 'USD', enterpriseUsers: 1, actionsLinuxMinutes: 30000, actionsWindowsMinutes: 15000, actionsMacosMinutes: 5000, actionsIncludedMinutes: 50000 }) },
  { name: 'standard one core and ARM runners draw from allowance', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', enterpriseUsers: 1, actionsLinuxSlimMinutes: 1000, actionsLinuxArmMinutes: 1000, actionsWindowsArmMinutes: 1000 },
    // GitHub Actions docs list Linux 1-core, Linux 2-core ARM, and Windows 2-core ARM as baseline standard runners; Enterprise Cloud includes 50,000 standard-runner minutes, so only the seat bills.
    expected: async () => github({ currency: 'USD', enterpriseUsers: 1, actionsLinuxSlimMinutes: 1000, actionsLinuxArmMinutes: 1000, actionsWindowsArmMinutes: 1000 }) },
  { name: 'actions overage and larger runners', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', actionsLinuxMinutes: 30000, actionsWindowsMinutes: 20000, actionsMacosMinutes: 100, actionsIncludedMinutes: 50000, largerRunners: [{ runner: 'Linux B4', minutes: 100 }, { runner: 'Windows B8', minutes: 50 }, { runner: 'macOS L', minutes: 25 }] },
    // After 50,000 included standard minutes, only 100 macOS overage minutes bill; larger runners always bill per job minute from their SKU rows.
    expected: async () => github({ currency: 'USD', actionsLinuxMinutes: 30000, actionsWindowsMinutes: 20000, actionsMacosMinutes: 100, actionsIncludedMinutes: 50000, largerRunners: [{ runner: 'Linux B4', minutes: 100 }, { runner: 'Windows B8', minutes: 50 }, { runner: 'macOS L', minutes: 25 }] }) },
  { name: 'shared artifact and package storage is 25 cents', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', sharedStorageGb: 100 },
    // GitHub Actions and Packages docs say artifacts and Packages share storage; Retail API GitHub Storage / Packages is $0.25 per GB-month for the excess entered here.
    expected: async () => github({ currency: 'USD', sharedStorageGb: 100 }) },
  { name: 'codespaces packages storage lfs and transfer', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', codespaces: [{ cores: 2, hours: 10 }, { cores: 8, hours: 5 }], codespacesStorageGb: 20, sharedStorageGb: 30, packagesTransferGb: 40, lfsStorageGb: 50, lfsTransferGb: 60, actionsCacheStorageGb: 70, actionsTransferGb: 80 },
    // Retail API charges Codespaces compute per hour, Codespaces/LFS/cache storage per GiB-month, shared artifact+Packages storage at $0.25/GB-month, and bandwidth per GB.
    expected: async () => github({ currency: 'USD', codespaces: [{ cores: 2, hours: 10 }, { cores: 8, hours: 5 }], codespacesStorageGb: 20, sharedStorageGb: 30, packagesTransferGb: 40, lfsStorageGb: 50, lfsTransferGb: 60, actionsCacheStorageGb: 70, actionsTransferGb: 80 }) },
  { name: 'codespaces team totals multiply developers by hours', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', codespaces: [{ cores: 4, developers: 10, hours: 8 }, { cores: 16, developers: 2, hours: 5 }] },
    // GitHub Codespaces docs say compute is summed for all codespaces billable to the account; this case totals developers * hours for each machine size.
    expected: async () => github({ currency: 'USD', codespaces: [{ cores: 4, developers: 10, hours: 8 }, { cores: 16, developers: 2, hours: 5 }] }) },
  { name: 'git lfs enterprise 250 GiB free quota', region: 'eastus2', currency: 'USD', component: { type: 'github-enterprise', enterpriseUsers: 1, lfsStorageGb: 300, lfsTransferGb: 260 },
    // Git LFS docs list 250 GiB storage and 250 GiB monthly bandwidth included with Enterprise Cloud; only 50 GiB storage and 10 GiB transfer overage bill.
    expected: async () => github({ currency: 'USD', enterpriseUsers: 1, lfsStorageGb: 300, lfsTransferGb: 260 }) },
  { name: 'global meters same for west europe', region: 'westeurope', currency: 'USD', component: { type: 'github-enterprise', enterpriseUsers: 1, copilotEnterpriseUsers: 1, actionsLinuxMinutes: 1000 },
    // GitHub Retail API meters are Global, not Azure-region-specific; West Europe uses the same Global rows as East US 2.
    expected: async () => github({ currency: 'USD', enterpriseUsers: 1, copilotEnterpriseUsers: 1, actionsLinuxMinutes: 1000 }) },
  { name: 'EUR mixed GitHub estimate', region: 'westeurope', currency: 'EUR', component: { type: 'github-enterprise', enterpriseUsers: 2, copilotBusinessUsers: 2, actionsLinuxMinutes: 1000, codespaces: [{ cores: 4, hours: 10 }], sharedStorageGb: 10 },
    // Retail API queried in EUR returns the Global Enterprise, Copilot Business, Codespaces D4, and shared artifact+Packages storage prices in EUR; Enterprise included minutes cover Linux Actions.
    expected: async () => github({ currency: 'EUR', enterpriseUsers: 2, copilotBusinessUsers: 2, actionsLinuxMinutes: 1000, codespaces: [{ cores: 4, hours: 10 }], sharedStorageGb: 10 }) },
] };
