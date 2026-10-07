'use strict';
// GitHub, only what is billed through Azure meters (an Azure-subscription-billed GitHub organisation):
// Enterprise seats, Advanced Security / code security / secret protection committers, Copilot seats,
// premium requests and AI credits, Actions minutes and storage, Codespaces, Packages, LFS and data transfer.
// Meters: serviceName 'GitHub', regionless ('Global'). Queried per product because several products share meter ids.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const S = 'GitHub';
const plural = (v, one, many) => `${fmtN(v)} ${v === 1 ? one : many}`;

const STANDARD_SKUS = ['linux b1', 'linux b2', 'linux arm b2', 'windows b2', 'windows arm b2'];
const includedMinutes = c => (c.actionsIncludedMinutes != null ? n(c.actionsIncludedMinutes) : n(c.enterpriseUsers) > 0 ? 50000 : 0);
const devs = r => (r.developers == null ? 1 : n(r.developers));
const runnerName = r => {
  if (r.runner) return String(r.runner);
  const os = String(r.os || '').toLowerCase();
  if (os === 'macos') {
    if (r.size) return `macOS ${String(r.size).toUpperCase()}`;
    if (n(r.cores) === 3 || n(r.cores) === 4) return 'macOS';
    throw new PricingError('For a macOS larger runner give the size: "M", "L" or "XL". Standard macOS runners (3 or 4 cores) go in actionsMacosMinutes.');
  }
  const osName = os === 'windows' ? 'Windows' : 'Linux';
  if (r.size) return `${osName} ${String(r.size).toUpperCase()}`;
  if (r.gpu) return n(r.cores) && n(r.cores) !== 4 ? `${osName} GPU B${n(r.cores)}` : `${osName} GPU`;
  return `${osName}${r.arm ? ' ARM' : ''} B${n(r.cores)}`;
};

module.exports = {
  type: 'github-enterprise',
  label: 'GitHub Enterprise (billed through Azure)',
  family: 'developer-tools',
  calculator: ['githubenterprise'],
  keywords: ['github', 'github enterprise', 'copilot', 'github actions', 'advanced security', 'codespaces', 'code scanning', 'developer seats'],
  fields: {
    enterpriseUsers: { def: 0, int: true, min: 0, ask: 'How many people need a GitHub Enterprise seat (everyone who is a member of the organisation and uses private repositories)? Use 0 if they only need add-ons.' },
    advancedSecurityCommitters: { def: 0, int: true, min: 0, ask: 'How many developers who commit to repositories need GitHub Advanced Security (code scanning plus secret scanning together)? Count people who made a commit in the last 90 days.' },
    codeSecurityCommitters: { def: 0, int: true, min: 0, ask: 'Only if they want code scanning (finding vulnerabilities in code) without secret scanning: how many committing developers?' },
    secretProtectionCommitters: { def: 0, int: true, min: 0, ask: 'Only if they want secret scanning and push protection (stopping leaked passwords and keys) without code scanning: how many committing developers?' },
    codeQualityCommitters: { def: 0, int: true, min: 0, ask: 'Only if they want GitHub Code Quality: how many committing developers?' },
    azdoAdvancedSecurityCommitters: { def: 0, int: true, min: 0, ask: 'Only for code kept in Azure DevOps (not GitHub): how many committing developers need Advanced Security (code scanning plus secret scanning together)?' },
    azdoCodeSecurityCommitters: { def: 0, int: true, min: 0, ask: 'Only for code kept in Azure DevOps: how many committing developers need code scanning alone?' },
    azdoSecretProtectionCommitters: { def: 0, int: true, min: 0, ask: 'Only for code kept in Azure DevOps: how many committing developers need secret scanning alone?' },
    copilotBusinessUsers: { def: 0, int: true, min: 0, ask: 'How many people need GitHub Copilot Business (AI coding assistant with organisation controls)? Use this for organisations on GitHub Enterprise.' },
    copilotBusinessStandaloneUsers: { def: 0, int: true, min: 0, ask: 'How many people need GitHub Copilot Business in an organisation that does NOT have GitHub Enterprise seats?' },
    copilotEnterpriseUsers: { def: 0, int: true, min: 0, ask: 'How many people need GitHub Copilot Enterprise (adds chat over the organisation\'s own code and knowledge)?' },
    premiumRequests: { def: 0, int: true, min: 0, ask: 'Copilot "premium requests" beyond what the seats include: roughly how many a month? Each one is a request to a premium AI model or agent. If unknown, use 0 and record that usage-based AI charges are not estimated.' },
    aiCredits: { def: 0, int: true, min: 0, ask: 'Usage-based GitHub AI credits (1 credit = 1 cent) beyond what seats include: roughly how many credits a month? If unknown, use 0 and record it as an assumption.' },
    actionsLinuxMinutes: { def: 0, int: true, min: 0, ask: 'GitHub Actions: how many minutes a month of build and automation time on standard Linux runners (2 cores)?' },
    actionsLinuxSlimMinutes: { def: 0, int: true, min: 0, ask: 'GitHub Actions: how many minutes a month on the smallest standard Linux runner (1 core, "ubuntu-slim")? Use 0 if not used.' },
    actionsLinuxArmMinutes: { def: 0, int: true, min: 0, ask: 'GitHub Actions: how many minutes a month on standard Linux ARM runners (2 cores)? Use 0 if not used.' },
    actionsWindowsMinutes: { def: 0, int: true, min: 0, ask: 'GitHub Actions: how many minutes a month on standard Windows runners (2 cores)?' },
    actionsWindowsArmMinutes: { def: 0, int: true, min: 0, ask: 'GitHub Actions: how many minutes a month on standard Windows ARM runners (2 cores)? Use 0 if not used.' },
    actionsMacosMinutes: { def: 0, int: true, min: 0, ask: 'GitHub Actions: how many minutes a month on standard macOS runners (3 or 4 cores)?' },
    actionsIncludedMinutes: { int: true, min: 0, ask: 'Free standard-runner minutes already included in the plan. GitHub Enterprise Cloud includes 50,000 a month and that is assumed when there are Enterprise seats; give another number (or 0 to price everything) only if they know it differs.' },
    largerRunners: { def: [], ask: 'Bigger or special Actions runners, if any, as a list. Each item gives the operating system and number of cores, for example {"os": "linux", "cores": 8, "minutes": 3000}; add "arm": true for ARM machines or "gpu": true for GPU machines (4 cores unless stated). For macOS give "size": "M", "L" or "XL" instead of cores. Special machine classes use "size": "HP", "MO64", "MO160", "SO2" or "SO8". These are always charged, never covered by included minutes.' },
    sharedStorageGb: { def: 0, int: true, min: 0, ask: 'GitHub Actions build artifacts and GitHub Packages share one storage allowance (Enterprise Cloud: 50 GB). How many GB do the two use together ABOVE that allowance? Enter only the excess.' },
    actionsCacheStorageGb: { def: 0, int: true, min: 0, ask: 'GitHub Actions dependency cache or custom runner image storage above the free allowance (10 GB per repository for cache): how many GB? Use 0 if unsure.' },
    codespaces: { def: [], ask: 'GitHub Codespaces (cloud development machines): a list like {"cores": 4, "developers": 20, "hours": 80}, meaning how many developers use machines of that size and how many hours each uses them per month. Sizes: 2, 4, 8, 16 or 32 cores.' },    codespacesStorageGb: { def: 0, ask: 'GitHub Codespaces storage: how many GB are kept for the month?' },
    packagesTransferGb: { def: 0, int: true, min: 0, ask: 'GitHub Packages data transfer out above the free allowance: how many GB a month?' },
    lfsStorageGb: { def: 0, int: true, min: 0, ask: 'Git Large File Storage (LFS): how many GB stored in total? 250 GB is free with GitHub Enterprise Cloud and is subtracted automatically when there are Enterprise seats.' },
    lfsTransferGb: { def: 0, int: true, min: 0, ask: 'Git LFS data downloaded: how many GB a month in total? 250 GB is free with GitHub Enterprise Cloud and is subtracted automatically when there are Enterprise seats.' },
    actionsTransferGb: { def: 0, int: true, min: 0, ask: 'GitHub Actions data transfer out (artifact and cache downloads from outside): how many GB a month?' }
  },
  context: [],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'GitHub plans and add-ons that are not billed through an Azure subscription (billed by credit card or invoice directly with GitHub)',
    'Self-hosted runners, whose virtual machines are billed as normal Azure compute',
    'Pre-purchase plans (prepaid GitHub commit units) and negotiated discounts: they discount usage rather than add to it',
    'Sandbox compute for agents and usage not covered by the quantities entered'
  ]),
  examples: [
    { type: 'github-enterprise', enterpriseUsers: 50 },
    {
      type: 'github-enterprise', enterpriseUsers: 100, advancedSecurityCommitters: 40, codeSecurityCommitters: 5, secretProtectionCommitters: 5, codeQualityCommitters: 10,
      azdoAdvancedSecurityCommitters: 10, azdoCodeSecurityCommitters: 2, azdoSecretProtectionCommitters: 3, copilotBusinessUsers: 60, copilotBusinessStandaloneUsers: 5, copilotEnterpriseUsers: 10,
      premiumRequests: 5000, aiCredits: 20000, actionsLinuxMinutes: 60000, actionsWindowsMinutes: 5000, actionsMacosMinutes: 1000, actionsLinuxSlimMinutes: 4000, actionsLinuxArmMinutes: 2000, actionsWindowsArmMinutes: 500,
      largerRunners: [{ os: 'linux', cores: 4, minutes: 3000 }, { os: 'windows', cores: 8, minutes: 500 }], sharedStorageGb: 30, actionsCacheStorageGb: 20,
      codespaces: [{ cores: 4, developers: 10, hours: 80 }, { cores: 8, developers: 5, hours: 40 }], codespacesStorageGb: 100, packagesTransferGb: 20, lfsStorageGb: 50, lfsTransferGb: 30, actionsTransferGb: 15
    }
  ],
  readback: c => {
    const p = [];
    const add = (k, text) => { if (n(c[k])) p.push(text(n(c[k]))); };
    add('enterpriseUsers', v => `${plural(v, 'Enterprise seat', 'Enterprise seats')}`);
    add('advancedSecurityCommitters', v => `Advanced Security (code and secret scanning) for ${plural(v, 'committer', 'committers')}`);
    add('codeSecurityCommitters', v => `code scanning only for ${plural(v, 'committer', 'committers')}`);
    add('secretProtectionCommitters', v => `secret scanning only for ${plural(v, 'committer', 'committers')}`);
    add('codeQualityCommitters', v => `Code Quality for ${plural(v, 'committer', 'committers')}`);
    add('azdoAdvancedSecurityCommitters', v => `Azure DevOps Advanced Security for ${plural(v, 'committer', 'committers')}`);
    add('azdoCodeSecurityCommitters', v => `Azure DevOps code scanning only for ${plural(v, 'committer', 'committers')}`);
    add('azdoSecretProtectionCommitters', v => `Azure DevOps secret scanning only for ${plural(v, 'committer', 'committers')}`);
    add('copilotBusinessUsers', v => `${plural(v, 'Copilot Business seat', 'Copilot Business seats')}`);
    add('copilotBusinessStandaloneUsers', v => `${plural(v, 'Copilot Business seat', 'Copilot Business seats')} without Enterprise`);
    add('copilotEnterpriseUsers', v => `${plural(v, 'Copilot Enterprise seat', 'Copilot Enterprise seats')}`);
    add('premiumRequests', v => `${fmtN(v)} Copilot premium requests a month`);
    add('aiCredits', v => `${fmtN(v)} AI credits a month`);
    add('actionsLinuxMinutes', v => `${fmtN(v)} Actions minutes on Linux`);
    add('actionsWindowsMinutes', v => `${fmtN(v)} Actions minutes on Windows`);
    add('actionsMacosMinutes', v => `${fmtN(v)} Actions minutes on macOS`);
    add('actionsLinuxSlimMinutes', v => `${fmtN(v)} Actions minutes on Linux 1-core`);
    add('actionsLinuxArmMinutes', v => `${fmtN(v)} Actions minutes on Linux ARM`);
    add('actionsWindowsArmMinutes', v => `${fmtN(v)} Actions minutes on Windows ARM`);
    const inc = includedMinutes(c);
    if (inc) p.push(`${fmtN(inc)} included standard minutes subtracted`);
    for (const r of c.largerRunners || []) { let nm; try { nm = runnerName(r); } catch (e) { nm = "larger"; } p.push(`${fmtN(n(r.minutes))} minutes on the ${nm} runner`); }
    add('sharedStorageGb', v => `${fmtN(v)} GB shared artifacts and Packages storage above the allowance`);
    add('actionsCacheStorageGb', v => `${fmtN(v)} GB Actions cache and image storage`);
    for (const r of c.codespaces || []) p.push(`Codespaces ${fmtN(n(r.cores))}-core, ${fmtN(devs(r))} developer(s) x ${fmtN(n(r.hours))} hours`);
    add('codespacesStorageGb', v => `${fmtN(v)} GB Codespaces storage`);
    add('packagesTransferGb', v => `${fmtN(v)} GB Packages data transfer out`);
    add('lfsStorageGb', v => `${fmtN(v)} GB Git LFS storage`);
    add('lfsTransferGb', v => `${fmtN(v)} GB Git LFS data transfer`);
    if (n(c.enterpriseUsers) && (n(c.lfsStorageGb) || n(c.lfsTransferGb))) p.push('250 GB free LFS storage and transfer subtracted');
    add('actionsTransferGb', v => `${fmtN(v)} GB Actions data transfer out`);
    return `GitHub billed through Azure: ${p.length ? p.join(', ') : 'nothing selected'}`;
  },
  price: async (c, ctx) => {
    const cache = {};
    const prod = async name => cache[name] || (cache[name] = await rows(`serviceName eq 'GitHub' and productName eq '${name}' and priceType eq 'Consumption' and armRegionName eq 'Global'`, ctx));
    const meter = async (product, sku, what) => {
      const rs = (await prod(product)).filter(r => r.skuName === sku);
      if (!rs.length) throw new PricingError(`No price found for ${what} (${product} / ${sku}).`);
      return single(rs, what);
    };
    const lines = [], notes = [];
    const seat = async (key, product, sku, label) => {
      if (!n(c[key])) return;
      lines.push(meterLine('Developer tools', S, `${label}, ${plural(n(c[key]), 'user', 'users')} x 1 month`, await meter(product, sku, label), n(c[key]), ctx, { unit: 'users / month' }));
    };
    await seat('enterpriseUsers', 'GitHub Enterprise (GHE)', 'Enterprise', 'GitHub Enterprise seat');
    await seat('advancedSecurityCommitters', 'GitHub Advanced Security GHE', 'Advanced Security GHE', 'GitHub Advanced Security committer (code and secret scanning)');
    await seat('codeSecurityCommitters', 'GitHub Advanced Security GHE', 'Code Scanning for GHE', 'GitHub code scanning committer');
    await seat('secretProtectionCommitters', 'GitHub Advanced Security GHE', 'Secret Scanning for GHE', 'GitHub secret scanning committer');
    await seat('codeQualityCommitters', 'GitHub Code Quality', 'Code Quality for GHE', 'GitHub Code Quality committer');
    await seat('azdoAdvancedSecurityCommitters', 'GitHub Advanced Security', 'Advanced Security for AzDO', 'Azure DevOps Advanced Security committer');
    await seat('azdoCodeSecurityCommitters', 'GitHub Advanced Security', 'Code Scanning for AzDO', 'Azure DevOps code scanning committer');
    await seat('azdoSecretProtectionCommitters', 'GitHub Advanced Security', 'Secret Scanning for AzDO', 'Azure DevOps secret scanning committer');
    await seat('copilotBusinessUsers', 'GitHub Copilot', 'Business', 'GitHub Copilot Business seat');
    await seat('copilotBusinessStandaloneUsers', 'GitHub Copilot', 'Business for non-GHE customers', 'GitHub Copilot Business seat (organisation without Enterprise)');
    await seat('copilotEnterpriseUsers', 'GitHub Copilot', 'Enterprise', 'GitHub Copilot Enterprise seat');
    if (n(c.premiumRequests)) lines.push(meterLine('Developer tools', S, `Copilot premium requests, ${fmtN(n(c.premiumRequests))}/month`, await meter('GitHub Copilot', 'Premium Request', 'Copilot premium requests'), n(c.premiumRequests), ctx, { unit: 'requests' }));
    if (n(c.aiCredits)) lines.push(meterLine('Developer tools', S, `GitHub AI credits, ${fmtN(n(c.aiCredits))}/month`, await meter('GitHub Copilot', 'AI Credit', 'GitHub AI credits'), n(c.aiCredits), ctx, { unit: 'credits' }));

    // Included minutes are applied to the cheapest standard runners first (GitHub does not publish the order).
    let allowance = includedMinutes(c);
    const std = [
      ['actionsLinuxSlimMinutes', 'Linux B1', 'Linux 1-core', / Job$/],
      ['actionsLinuxArmMinutes', 'Linux ARM B2', 'Linux ARM 2-core', / Job$/],
      ['actionsLinuxMinutes', 'Linux', 'Linux 2-core', /Overage$/],
      ['actionsWindowsArmMinutes', 'Windows ARM B2', 'Windows ARM 2-core', / Job$/],
      ['actionsWindowsMinutes', 'Windows', 'Windows 2-core', /Overage$/],
      ['actionsMacosMinutes', 'macOS', 'macOS', /Overage$/]
    ];
    const stdRows = [];
    for (const [key, sku, label, mn] of std) {
      if (!n(c[key])) continue;
      const rs = (await prod('GitHub Actions')).filter(x => x.skuName === sku && mn.test(x.meterName));
      if (!rs.length) throw new PricingError(`No price found for Actions ${label} minutes.`);
      stdRows.push({ key, label, rs, unit: single(rs, `Actions ${label} minutes`).retailPrice });
    }
    stdRows.sort((x, y) => x.unit - y.unit);
    for (const { key, label, rs } of stdRows) {
      const total = n(c[key]);
      const free = Math.min(allowance, total); allowance -= free;
      const billable = total - free;
      if (billable) lines.push(meterLine('Developer tools', S, `GitHub Actions ${label} standard runners, ${fmtN(billable)} minutes${free ? ` (${fmtN(total)} used, ${fmtN(free)} included)` : ''}`, single(rs, `Actions ${label} minutes`), billable, ctx, { unit: 'minutes' }));
    }
    if (stdRows.length && includedMinutes(c)) notes.push('Included minutes are assumed to cover the cheapest standard runners first, which gives the higher bill; GitHub does not publish the order or the weighting between operating systems.');
    for (const r of c.largerRunners || []) {
      const mins = n(r.minutes);
      if (!mins) continue;
      const name = runnerName(r);
      if (STANDARD_SKUS.includes(name.toLowerCase()) || name === 'macOS') throw new PricingError(`${name === 'macOS' ? 'Standard macOS' : name} is a standard runner: enter its minutes in the standard-runner fields (actionsLinuxSlimMinutes, actionsLinuxMinutes, actionsLinuxArmMinutes, actionsWindowsMinutes, actionsWindowsArmMinutes or actionsMacosMinutes) so included minutes apply.`);
      const rs = (await prod('GitHub Actions')).filter(x => x.skuName.toLowerCase() === name.toLowerCase() && / Job$/.test(x.meterName));
      if (!rs.length) throw new PricingError(`Unknown Actions runner "${name}". Give the operating system and cores, for example Linux 8 cores, Windows 16 cores, Linux ARM 4 cores, a GPU machine (4 cores, or 12, 24, 36), macOS size M, L or XL, or a size HP, MO64, MO160, SO2 or SO8.`, (await prod('GitHub Actions')).filter(x => / Job$/.test(x.meterName) && !STANDARD_SKUS.includes(x.skuName.toLowerCase())).map(x => ({ skuName: x.skuName })));
      lines.push(meterLine('Developer tools', S, `GitHub Actions ${rs[0].skuName} larger runner, ${fmtN(mins)} minutes`, single(rs, `Actions ${name}`), mins, ctx, { unit: 'minutes' }));
    }
    for (const r of c.codespaces || []) {
      const cores = n(r.cores), per = n(r.hours), d = devs(r), hrs = per * d;
      if (!Number.isInteger(d) || d < 0) throw new PricingError('Codespaces developers must be a whole number.');
      if (!hrs) continue;
      if (![2, 4, 8, 16, 32].includes(cores)) throw new PricingError('Codespaces machines have 2, 4, 8, 16 or 32 cores.');
      if (per < 0 || per > 744) throw new PricingError('Codespaces hours per developer must be between 0 and 744 a month.');
      lines.push(meterLine('Developer tools', S, `GitHub Codespaces ${fmtN(cores)}-core, ${fmtN(d)} developer(s) x ${fmtN(per)} hours`, await meter('GitHub Codespaces - Linux', `Development Optimized D${cores}`, `Codespaces ${cores}-core`), hrs, ctx, { unit: 'hours' }));
    }
    const gb = async (key, product, sku, label, unit) => { if (n(c[key])) lines.push(meterLine('Developer tools', S, `${label}, ${fmtN(n(c[key]))} GB${unit === 'GB / month' ? ' stored' : ''}`, await meter(product, sku, label), n(c[key]), ctx, { unit })); };
    await gb('sharedStorageGb', 'GitHub Storage', 'Packages', 'GitHub Actions artifacts and Packages shared storage above the allowance', 'GB / month');
    await gb('actionsCacheStorageGb', 'GitHub Storage', 'Actions', 'GitHub Actions cache and custom image storage', 'GB / month');
    await gb('codespacesStorageGb', 'GitHub Storage', 'Codespaces', 'GitHub Codespaces storage', 'GB / month');
    const lfsFree = n(c.enterpriseUsers) ? 250 : 0;
    const cs = c;
    c = { ...c, lfsStorageGb: Math.max(0, n(c.lfsStorageGb) - lfsFree), lfsTransferGb: Math.max(0, n(c.lfsTransferGb) - lfsFree) };
    await gb('lfsStorageGb', 'GitHub Storage', 'LFS', 'Git LFS storage above the free 250 GB', 'GB / month');
    await gb('packagesTransferGb', 'GitHub Packages', 'Standard', 'GitHub Packages data transfer out (above allowance)', 'GB');
    await gb('lfsTransferGb', 'GitHub Bandwidth', 'LFS', 'Git LFS data transfer out above the free 250 GB', 'GB');
    await gb('actionsTransferGb', 'GitHub Bandwidth', 'Action', 'GitHub Actions data transfer out', 'GB');

    if (!lines.length) throw new PricingError('Nothing to price: set at least one quantity such as enterpriseUsers.');
    notes.push('These meters apply only when the GitHub organisation is billed through an Azure subscription. They have no regional prices: the same global rate applies everywhere.');
    notes.push('Security products are billed per active committer (a developer who committed in the last 90 days); seats are billed per user per month.');
    if (n(cs.enterpriseUsers) && (n(cs.lfsStorageGb) || n(cs.lfsTransferGb))) notes.push('Git LFS: the 250 GB of free storage and 250 GB of free monthly transfer in GitHub Enterprise Cloud were subtracted from the amounts entered.');
    if ((c.largerRunners || []).length) notes.push('Larger runners are always charged, even when included standard minutes are available.');
    if (n(c.premiumRequests) && n(c.aiCredits)) notes.push('Premium requests and AI credits are separate usage meters: enter only the usage that is billed under each.');
    return { lines, notes, facts: { enterpriseUsers: n(c.enterpriseUsers), committers: n(c.advancedSecurityCommitters) + n(c.codeSecurityCommitters) + n(c.secretProtectionCommitters), azdoCommitters: n(c.azdoAdvancedSecurityCommitters) + n(c.azdoCodeSecurityCommitters) + n(c.azdoSecretProtectionCommitters), copilotUsers: n(c.copilotBusinessUsers) + n(c.copilotBusinessStandaloneUsers) + n(c.copilotEnterpriseUsers), actionsMinutes: n(c.actionsLinuxMinutes) + n(c.actionsWindowsMinutes) + n(c.actionsMacosMinutes) + n(c.actionsLinuxSlimMinutes) + n(c.actionsLinuxArmMinutes) + n(c.actionsWindowsArmMinutes) } };
  }
};
