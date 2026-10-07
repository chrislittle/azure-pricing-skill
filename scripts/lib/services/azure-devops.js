'use strict';
// Azure DevOps Services (calculator slug azure-devops): paid users, Test Plans, Pipelines parallel jobs and larger
// hosted-agent minutes, Artifacts storage, cloud load testing, and GitHub Advanced Security for Azure DevOps committers.
// Meters are Global (not regional). Free grants modelled: 5 Basic users, 1 Microsoft-hosted and 1 self-hosted job,
// 2 GB of Artifacts, 20,000 load-test virtual user minutes.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const INT_FIELDS = ['basicUsers', 'testPlansUsers', 'hostedJobs', 'selfHostedJobs', 'ghasCommitters', 'codeScanningCommitters', 'secretScanningCommitters'];
const NUM_FIELDS = ['aiCredits', 'artifactsGB', 'loadTestVirtualUserMinutes', 'macosMinutes', 'macosXLMinutes', 'linux8CoreMinutes', 'linux16CoreMinutes', 'windows8CoreMinutes', 'windows16CoreMinutes'];
const FREE_BASIC = 5, FREE_ARTIFACTS_GB = 2, FREE_LOADTEST = 20000;

module.exports = {
  type: 'azure-devops',
  label: 'Azure DevOps',
  family: 'devops',
  calculator: ['azure-devops'],
  keywords: ['azure devops', 'ado', 'azure pipelines', 'azure boards', 'azure repos', 'azure artifacts', 'azure test plans', 'parallel jobs', 'ci/cd', 'devops licenses'],
  fields: {
    basicUsers: { req: true, int: true, min: 0, ask: 'How many people need to use Azure DevOps repos, boards, pipelines and artifacts (not counting people who also need Test Plans)? The first 5 are free. People who already have a Visual Studio subscription (Professional, Enterprise or MSDN) are included with their subscription and should not be counted; stakeholders (view-only) are free too.' },
    testPlansUsers: { def: 0, int: true, min: 0, ask: 'How many people need Azure Test Plans (manual and exploratory testing)? They get the Basic access level plus Test Plans for one price. Visual Studio Enterprise subscribers already include it. Leave 0 if none.' },
    hostedJobs: { def: 0, int: true, min: 0, ask: 'How many pipeline jobs need to run at the same time on Microsoft-hosted agents? 0 means the free tier (1 job, 1,800 minutes a month for private projects). Buying parallel jobs replaces the free tier, so N paid jobs cost N times the price (1 paid job removes the minutes cap but does not add a second concurrent job). If unknown, suggest 0, and for a team of about 10 developers suggest 2 or 3.' },
    selfHostedJobs: { def: 1, int: true, min: 1, ask: 'How many pipeline jobs need to run at the same time on your own (self-hosted) agents? The first one is free. If unknown, suggest 1.' },
    artifactsGB: { def: 0, min: 0, ask: 'How many GB of packages (NuGet, npm, Maven, Python, universal) will you store in Azure Artifacts? The first 2 GB are free. Leave 0 if unknown.' },
    macosMinutes: { def: 0, min: 0, ask: 'How many minutes per month of larger hosted macOS builds (macOS standard agent, per-minute billing) will you run? These larger agents are GitHub-hosted and billed per minute with no free minutes, separate from your parallel jobs. Leave 0 if none.' },
    macosXLMinutes: { def: 0, min: 0, ask: 'How many minutes per month of the macOS XL hosted agent? Leave 0 if none.' },
    linux8CoreMinutes: { def: 0, min: 0, ask: 'How many minutes per month on the 8-core Linux larger hosted agent? Leave 0 if none.' },
    linux16CoreMinutes: { def: 0, min: 0, ask: 'How many minutes per month on the 16-core Linux larger hosted agent? Leave 0 if none.' },
    windows8CoreMinutes: { def: 0, min: 0, ask: 'How many minutes per month on the 8-core Windows larger hosted agent? Leave 0 if none.' },
    windows16CoreMinutes: { def: 0, min: 0, ask: 'How many minutes per month on the 16-core Windows larger hosted agent? Leave 0 if none.' },
    loadTestVirtualUserMinutes: { def: 0, min: 0, ask: 'Legacy (cloud-based load testing in Azure DevOps was deprecated; skip unless the customer still uses it): how many virtual user minutes per month (users times minutes of test)? The first 20,000 are free. Leave 0 if none.' },
    aiCredits: { def: 0, min: 0, ask: 'Only if you use GitHub Copilot autofix or code review in Advanced Security for Azure DevOps: how many AI credits per month (a flat price per credit)? Leave 0 if none.' },
    ghasCommitters: { def: 0, int: true, min: 0, ask: 'Only if you want GitHub Advanced Security for Azure DevOps (code scanning, secret scanning and dependency scanning): how many distinct people commit code to the protected repositories in a 90-day period? Leave 0 if none.' },
    codeScanningCommitters: { def: 0, int: true, min: 0, ask: 'Only if you want code scanning alone (not the full Advanced Security bundle): how many distinct committers in 90 days? Leave 0 if none.' },
    secretScanningCommitters: { def: 0, int: true, min: 0, ask: 'Only if you want secret scanning alone: how many distinct committers in 90 days? Leave 0 if none.' }
  },
  context: ['production'],
  examples: [
    { type: 'azure-devops', basicUsers: 25, testPlansUsers: 5, hostedJobs: 3, selfHostedJobs: 2, artifactsGB: 50 },
    { type: 'azure-devops', basicUsers: 8, hostedJobs: 2, macosMinutes: 3000, macosXLMinutes: 1000, linux8CoreMinutes: 2000, loadTestVirtualUserMinutes: 100000, ghasCommitters: 10 },
    { type: 'azure-devops', basicUsers: 100, testPlansUsers: 10, hostedJobs: 5, selfHostedJobs: 10, artifactsGB: 1500, windows16CoreMinutes: 500, codeScanningCommitters: 20, secretScanningCommitters: 15 }
  ],
  readback: c => {
    const parts = [`${fmtN(c.basicUsers)} Basic users (first ${FREE_BASIC} free)`];
    if (n(c.testPlansUsers)) parts.push(`${fmtN(c.testPlansUsers)} Basic + Test Plans users`);
    parts.push(n(c.hostedJobs) ? `${fmtN(c.hostedJobs)} paid Microsoft-hosted parallel job(s)` : 'Microsoft-hosted free tier (1 job)', `${fmtN(c.selfHostedJobs == null ? 1 : c.selfHostedJobs)} self-hosted parallel job(s) (first free)`);
    const add = [['aiCredits', 'AI credits'], ['artifactsGB', 'GB Artifacts storage (first 2 GB free)'], ['macosMinutes', 'minutes macOS agent'], ['macosXLMinutes', 'minutes macOS XL agent'], ['linux8CoreMinutes', 'minutes Linux 8-core agent'], ['linux16CoreMinutes', 'minutes Linux 16-core agent'],
      ['windows8CoreMinutes', 'minutes Windows 8-core agent'], ['windows16CoreMinutes', 'minutes Windows 16-core agent'], ['loadTestVirtualUserMinutes', 'load test virtual user minutes (first 20,000 free)'],
      ['ghasCommitters', 'GitHub Advanced Security committers'], ['codeScanningCommitters', 'code scanning committers'], ['secretScanningCommitters', 'secret scanning committers']];
    for (const [k, t] of add) if (n(c[k])) parts.push(`${fmtN(c[k])} ${t}`);
    return parts.join(', ');
  },
  notIncluded: () => ['Visual Studio subscriptions themselves (priced separately in the calculator; their Azure DevOps access is included), stakeholders (free), and the Azure resources your pipelines deploy to'],
  price: async (c, ctx) => {
    for (const k of INT_FIELDS) if (c[k] != null && (!Number.isInteger(n(c[k])) || n(c[k]) < 0)) throw new PricingError(`${k} must be a whole number, 0 or more.`);
    for (const k of NUM_FIELDS) if (c[k] != null && !(n(c[k]) >= 0)) throw new PricingError(`${k} must be 0 or more.`);
    const hosted = c.hostedJobs == null ? 0 : n(c.hostedJobs), self = c.selfHostedJobs == null ? 1 : n(c.selfHostedJobs);
    if (self < 1) throw new PricingError('selfHostedJobs must be at least 1 (the first is free).');
    const rs = await rows(`(serviceName eq 'Azure DevOps' or (serviceName eq 'GitHub' and contains(meterName,'AzDO'))) and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    const find = (meter, what) => {
      const m = rs.filter(r => r.meterName === meter);
      if (!m.length) throw new PricingError(`${what} is not priced.`);
      return m;
    };
    const G = 'DevOps', S = 'Azure DevOps';
    const lines = [], facts = { basicUsers: n(c.basicUsers), testPlansUsers: n(c.testPlansUsers) };
    const paidBasic = Math.max(0, n(c.basicUsers) - FREE_BASIC);
    if (paidBasic) lines.push(meterLine(G, S, `Basic users: ${fmtN(c.basicUsers)} less ${FREE_BASIC} free = ${fmtN(paidBasic)}`, find('Basic User', 'Basic user license'), paidBasic, ctx, { unit: 'users' }));
    if (n(c.testPlansUsers)) lines.push(meterLine(G, S, `Basic + Test Plans users: ${fmtN(c.testPlansUsers)}`, find('Standard User', 'Test Plans user license'), n(c.testPlansUsers), ctx, { unit: 'users' }));
    if (hosted >= 1) lines.push(meterLine(G, S, `Microsoft-hosted parallel jobs: ${fmtN(hosted)} paid (replaces the free tier)`, find('Microsoft-hosted CI/CD Concurrent Job', 'Microsoft-hosted parallel job'), hosted, ctx, { unit: 'jobs' }));
    if (self > 1) lines.push(meterLine(G, S, `Self-hosted parallel jobs: ${fmtN(self)} less 1 free = ${fmtN(self - 1)}`, find('Self-hosted CI/CD Concurrent Job', 'self-hosted parallel job'), self - 1, ctx, { unit: 'jobs' }));
    for (const [k, meter, label] of [['macosMinutes', 'macOS Standard Job', 'macOS agent'], ['macosXLMinutes', 'macOS XL Job', 'macOS XL agent'], ['linux8CoreMinutes', 'Linux 8-core Job', 'Linux 8-core agent'],
      ['linux16CoreMinutes', 'Linux 16-core Job', 'Linux 16-core agent'], ['windows8CoreMinutes', 'Windows 8-core Job', 'Windows 8-core agent'], ['windows16CoreMinutes', 'Windows 16-core Job', 'Windows 16-core agent']]) {
      if (n(c[k])) lines.push(meterLine(G, S, `${label}: ${fmtN(c[k])} minutes`, find(meter, label), n(c[k]), ctx, { unit: 'minutes' }));
    }
    const art = Math.max(0, n(c.artifactsGB) - FREE_ARTIFACTS_GB);
    if (art) lines.push(meterLine(G, S, `Artifacts storage: ${fmtN(c.artifactsGB)} GB less ${FREE_ARTIFACTS_GB} GB free = ${fmtN(art)} GB`, find('Standard Data Stored', 'Artifacts storage'), art, ctx, { unit: 'GB-months' }));
    const lt = Math.max(0, n(c.loadTestVirtualUserMinutes) - FREE_LOADTEST);
    if (lt) lines.push(meterLine(G, S, `Cloud load testing: ${fmtN(c.loadTestVirtualUserMinutes)} virtual user minutes less ${fmtN(FREE_LOADTEST)} free = ${fmtN(lt)}`, find('Standard Virtual User Minute', 'load testing'), lt, ctx, { unit: 'virtual user minutes' }));
    if (n(c.aiCredits)) lines.push(meterLine('Security', 'GitHub Advanced Security for Azure DevOps', `Copilot AI credits: ${fmtN(c.aiCredits)}`, find('AI Credit for AzDO GAC', 'AI credit'), n(c.aiCredits), ctx, { unit: 'credits' }));
    for (const [k, meter, label] of [['ghasCommitters', 'Advanced Security for AzDO Committer', 'GitHub Advanced Security committers'], ['codeScanningCommitters', 'Code Scanning for AzDO Committer', 'Code scanning committers'], ['secretScanningCommitters', 'Secret Scanning for AzDO Committer', 'Secret scanning committers']]) {
      if (n(c[k])) lines.push(meterLine('Security', 'GitHub Advanced Security for Azure DevOps', `${label}: ${fmtN(c[k])}`, find(meter, label), n(c[k]), ctx, { unit: 'committers' }));
    }
    const notes = ['Azure DevOps prices are the same in every region (Global meters). Users with a Visual Studio subscription, and stakeholders, do not need a paid license. The free Microsoft-hosted job has a monthly minutes cap for private projects. The larger-agent minutes are GitHub-hosted, pay-per-minute and have no free minutes. GitHub Enterprise users get Basic access free, and each Visual Studio Enterprise subscriber adds a free self-hosted job. The $49 Advanced Security bundle is the legacy offer; the pricing page now shows Code Security ($30) and Secret Protection ($19).'];
    if (!lines.length) notes.push('Everything in this estimate falls inside the free grants, so the total is 0.');
    return { lines, notes, facts };
  }
};
