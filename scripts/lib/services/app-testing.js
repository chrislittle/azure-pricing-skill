'use strict';
// Azure App Testing (formerly Azure Load Testing and Microsoft Playwright Testing): JMeter/Locust/URL load tests
// billed per virtual-user hour (graduated), an optional per-resource fee, and Playwright cloud-browser test minutes.
// Meters: serviceName 'Azure App Testing', regional (Playwright meters exist only in some regions).
const { rows, query, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'app-testing',
  label: 'Azure App Testing (Load Testing and Playwright)',
  family: 'developer-tools',
  calculator: ['load-testing'],
  keywords: ['load testing', 'performance testing', 'jmeter', 'locust', 'playwright', 'browser testing', 'virtual users', 'stress test'],
  fields: {
    virtualUserHours: { req: true, int: false, min: 0, ask: 'How many load-testing virtual user hours a month come from tests NOT described in the run fields below? One virtual user hour = one simulated user for one hour (users x minutes / 60 x runs; 1,000 users for 30 minutes = 500). Use 0 if every load test is described by the run fields below, or if they only need Playwright browser testing.' },
    testRuns: { def: 0, int: true, min: 0, ask: 'To describe load tests by their shape: how many test runs a month of this kind? Each run is billed for its own usage (virtual users x minutes / 60), added to the hours above, and never less than the minimum per run (10 virtual users per engine for at least 10 minutes). Leave 0 if the hours above cover everything.' },
    virtualUsers: { def: 0, int: true, min: 0, ask: 'Only if testRuns is set: how many virtual users does each run simulate?' },
    runMinutes: { def: 0, min: 0, max: 1440, ask: 'Only if testRuns is set: how long does each run last, in minutes?' },
    engines: { def: 1, int: true, min: 1, max: 400, ask: 'Only if testRuns is set: how many load-generating engines does each run use? A quick URL-based test uses one engine per 250 virtual users; otherwise it is a setting of the test. If unknown, use virtual users divided by 250 rounded up (at least 1) and record it as an assumption.' },
    loadTestingResources: { def: 0, int: true, min: 0, ask: 'Number of Azure Load Testing resources that carry the per-resource monthly fee. The fee appears in the Azure Retail Prices API but not on Microsoft\'s public pricing page, and it is not offered in every region; use 0 unless they want it included.' },
    playwrightLinuxMinutes: { def: 0, min: 0, ask: 'Playwright browser testing: how many test minutes a month on Linux cloud browsers? Test minutes are the total time tests run in the cloud browsers (50 tests of 12 seconds = 10 minutes). Use 0 if not used.' },
    playwrightWindowsMinutes: { def: 0, min: 0, ask: 'Playwright browser testing: how many test minutes a month on Windows cloud browsers?' },
    playwrightTrialMinutes: { def: 0, min: 0, ask: 'Is this the first Playwright workspace in the Azure subscription, still in its 30-day free trial? Then enter the free minutes they will use (at most 100; higher input is capped); they are taken off the Linux minutes first, then Windows. Otherwise 0.' }
  },  context: [],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The application being tested and its hosting, plus any network or storage it uses',
    'Azure Monitor / Application Insights data collected while monitoring the tested app',
    'Test scripts and CI/CD pipeline minutes (for example GitHub Actions or Azure Pipelines) that start the tests'
  ]),
  testRegions: ['eastus', 'westeurope'], // Playwright minutes are sold in only some regions (not eastus2)
  examples: [
    { type: 'app-testing', virtualUserHours: 500 },
    { type: 'app-testing', virtualUserHours: 12000, testRuns: 20, virtualUsers: 5, runMinutes: 180, engines: 1, loadTestingResources: 2, playwrightLinuxMinutes: 8000, playwrightWindowsMinutes: 1500, playwrightTrialMinutes: 100 }
  ],
  readback: c => {
    const p = [];
    const runUsers = n(c.virtualUsers), runMin = n(c.runMinutes), eng = n(c.engines) || 1;
    if (n(c.virtualUserHours) || !n(c.testRuns)) p.push(`${fmtN(n(c.virtualUserHours))} load-testing virtual user hours a month`);
    if (n(c.testRuns)) p.push(`${n(c.virtualUserHours) ? 'plus ' : ''}${fmtN(c.testRuns)} runs a month of ${fmtN(runUsers)} virtual users for ${fmtN(runMin)} minutes on ${fmtN(eng)} engine(s)${runUsers * runMin < 10 * eng * Math.max(runMin, 10) ? ' (billed at the per-run minimum)' : ''}`);
    if (n(c.loadTestingResources)) p.push(`${fmtN(c.loadTestingResources)} load testing resource fee(s)`);
    if (n(c.playwrightLinuxMinutes)) p.push(`${fmtN(c.playwrightLinuxMinutes)} Playwright minutes on Linux`);
    if (n(c.playwrightWindowsMinutes)) p.push(`${fmtN(c.playwrightWindowsMinutes)} Playwright minutes on Windows`);
    if (n(c.playwrightTrialMinutes)) p.push(`${fmtN(c.playwrightTrialMinutes)} of them free in the 30-day trial`);
    return `App Testing: ${p.join(', ')}`;
  },
  price: async (c, ctx) => {
    const vuh = n(c.virtualUserHours), runs = n(c.testRuns), lin = n(c.playwrightLinuxMinutes), win = n(c.playwrightWindowsMinutes), res = n(c.loadTestingResources);
    if ([vuh, runs, lin, win, res, n(c.virtualUsers), n(c.runMinutes), n(c.playwrightTrialMinutes)].some(v => v < 0)) throw new PricingError('Quantities cannot be negative.');
    if (!(vuh || runs || lin || win || res)) throw new PricingError('Nothing to price: set virtualUserHours, testRuns or Playwright minutes.');
    const rs = await rows(`serviceName eq 'Azure App Testing' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const where = async meterName => [...new Set((await query(`serviceName eq 'Azure App Testing' and meterName eq '${meterName}' and priceType eq 'Consumption'`, ctx.currency)).map(r => r.armRegionName))].sort().join(', ') || 'none found';
    if (!rs.length) throw new PricingError(`Azure App Testing is not priced in ${ctx.region}. Regions that have it: ${await where('JMeter Virtual User Additional Usage')}.`);
    const pick = (meterName, what) => single(rs.filter(r => r.meterName === meterName), what);
    const G = 'Developer tools', S = 'Azure App Testing', lines = [], notes = [];

    // Each run is billed at least 10 virtual users per engine for at least 10 minutes (from March 2026).
    let runVuh = 0, minimumApplied = false;
    if (runs) {
      const mins = n(c.runMinutes), users = n(c.virtualUsers), eng = Math.max(1, n(c.engines) || 1);
      if (!mins || !users) throw new PricingError('testRuns needs virtualUsers and runMinutes.');
      const actual = users * mins / 60;
      const billablePerRun = Math.max(users * mins, 10 * eng * Math.max(mins, 10)) / 60;
      minimumApplied = billablePerRun > actual;
      runVuh = runs * billablePerRun;
      notes.push(`Each run is ${minimumApplied ? 'billed at the minimum' : 'billed at its actual usage'}: ${fmtN(Math.round(billablePerRun * 100) / 100)} virtual user hours per run (minimum 10 virtual users per engine for at least 10 minutes).`);
    }
    const billedVuh = vuh + runVuh;
    if (billedVuh) {
      const m = pick('JMeter Virtual User Additional Usage', 'load testing virtual user hours');
      lines.push(meterLine(G, S, `Load testing virtual user hours, ${fmtN(Math.round(billedVuh * 100) / 100)}/month${m.length > 1 ? ' (graduated: cheaper after 10,000)' : ''}`, m, billedVuh, ctx, { unit: 'virtual user hours' }));
    }
    if (res) {
      const fee = rs.filter(r => r.meterName === 'JMeter Load Testing Resource');
      if (fee.length) lines.push(meterLine(G, S, `Load testing resource fee, ${fmtN(res)} resource(s)`, single(fee, 'load testing resource'), res, ctx, { unit: 'resources / month' }));
      else notes.push(`No per-resource fee is published in ${ctx.region}, so none was added. Regions that publish one: ${await where('JMeter Load Testing Resource')}.`);
    }

    if (lin || win) {
      if (!rs.some(r => r.meterName === 'Playwright Linux Test Minutes')) throw new PricingError(`Playwright test minutes are not priced in ${ctx.region}. Regions that have them: ${await where('Playwright Linux Test Minutes')}.`);
      // The trial minutes are taken off Linux first, then Windows: an assumption, as Microsoft does not say how a mixed workload uses them.
      let free = Math.min(n(c.playwrightTrialMinutes), 100);
      const freeLin = Math.min(free, lin); free -= freeLin;
      const freeWin = Math.min(free, win);
      const free0 = m => meterLine(G, S, `Playwright free trial minutes, ${fmtN(freeLin + freeWin)} (included, no charge)`, m, freeLin + freeWin, ctx, { unit: 'minutes' });
      if (freeLin + freeWin) { const fm = rs.filter(r => r.meterName === 'Playwright Free Test Minutes'); if (fm.length) lines.push(free0(single(fm, 'Playwright free test minutes'))); }
      if (lin - freeLin > 0) lines.push(meterLine(G, S, `Playwright cloud browsers on Linux, ${fmtN(lin - freeLin)} test minutes${freeLin ? ` (${fmtN(lin)} used, ${fmtN(freeLin)} free trial)` : ''}`, pick('Playwright Linux Test Minutes', 'Playwright Linux minutes'), lin - freeLin, ctx, { unit: 'minutes' }));
      if (win - freeWin > 0) lines.push(meterLine(G, S, `Playwright cloud browsers on Windows, ${fmtN(win - freeWin)} test minutes${freeWin ? ` (${fmtN(win)} used, ${fmtN(freeWin)} free trial)` : ''}`, pick('Playwright Windows Test Minutes', 'Playwright Windows minutes'), win - freeWin, ctx, { unit: 'minutes' }));
      notes.push('Playwright test minutes are the total time tests run in the cloud browsers. The 30-day free trial (first 100 minutes) applies only to the first workspace in a subscription; this estimate takes the trial minutes off Linux first, then Windows.');
    }
    if (billedVuh) notes.push('A virtual user hour is virtual users x test duration in hours; active users are counted every 10 seconds and fractions are billed.');
    return { lines, notes, facts: { virtualUserHours: billedVuh, testRuns: runs, resources: res, playwrightMinutes: lin + win, playwrightTrialMinutes: Math.min(n(c.playwrightTrialMinutes), 100) } };
  }
};