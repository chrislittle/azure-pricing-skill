'use strict';
// Application Insights (workspace-based and classic share the same data pricing): data ingestion and retention billed as
// Log Analytics 'Analytics Logs' meters, plus availability tests billed under Azure Monitor / Application Insights.
// Meters: serviceName 'Log Analytics' (Analytics Logs Data Ingestion / Data Retention), serviceName 'Azure Monitor'
// 'Standard Web Test Execution' (per execution), serviceName 'Application Insights' 'Basic Multi-step Web Test' (per test per month).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const DAYS_PER_MONTH = 730 / 24;
const INCLUDED_DAYS = 90; // Tables related to Application Insights keep data 90 days at no charge (Learn: data-retention-configure)

module.exports = {
  type: 'app-insights',
  label: 'Application Insights (telemetry data and availability tests)',
  family: 'monitoring',
  calculator: ['monitor'],
  keywords: ['application insights', 'app insights', 'appinsights', 'apm', 'application performance monitoring', 'telemetry', 'availability test', 'web test', 'standard web test', 'multi-step web test', 'ping test', 'workspace-based application insights'],
  fields: {
    ingestGbPerMonth: { req: true, min: 0, ask: 'About how much telemetry will the application send to Application Insights each month, in GB? A small web app usually sends 1 to 10 GB a month, a busy API or microservices system 50 to 500 GB or more. If they have it running already, use the Daily cap or Usage and estimated costs page. If unknown, suggest 20 GB and record it as an assumption.' },
    retentionDays: { def: 90, int: true, min: 30, max: 730, ask: 'How many days should the telemetry stay queryable? The first 90 days are included; longer retention is billed per GB-month. Use 90 if unknown.' },
    standardTests: { def: 0, int: true, min: 0, ask: 'How many availability tests (Standard web tests, which check a URL on a schedule from several Azure locations) should run? Use 0 if none.' },
    testLocations: { def: 5, int: true, min: 1, max: 16, ask: 'From how many locations should each availability test run (1 to 16; Microsoft recommends at least 5)?' },
    testFrequencyMinutes: { def: 5, int: true, min: 5, max: 15, ask: 'How often should each availability test run from each location: every 5, 10 or 15 minutes (the default is 5)?' },
    multiStepTests: { def: 0, int: true, min: 0, ask: 'Does the customer still use legacy multi-step web tests (recorded multi-page scripts)? How many? Use 0 if none; Standard tests are the current replacement.' },
    hours: { def: 730, ask: 'Do the availability tests run all month (730 hours) or only part of it?' }
  },
  context: ['production'],
  examples: [
    { type: 'app-insights', ingestGbPerMonth: 20 },
    { type: 'app-insights', ingestGbPerMonth: 150, retentionDays: 180, standardTests: 4, testLocations: 5, testFrequencyMinutes: 5 },
    { type: 'app-insights', ingestGbPerMonth: 60, standardTests: 2, testLocations: 3, testFrequencyMinutes: 10, multiStepTests: 2, hours: 500 }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.ingestGbPerMonth))} GB of telemetry a month, kept ${fmtN(c.retentionDays ?? 90)} days`];
    if (n(c.standardTests)) parts.push(`${fmtN(c.standardTests)} Standard availability test(s) from ${fmtN(c.testLocations ?? 5)} location(s) every ${fmtN(c.testFrequencyMinutes ?? 5)} minutes`);
    if (n(c.multiStepTests)) parts.push(`${fmtN(c.multiStepTests)} multi-step web test(s)`);
    if (n(c.standardTests) || n(c.multiStepTests)) parts.push(`tests active ${fmtN(c.hours ?? HOURS)} hours a month`);
    return `Application Insights: ${parts.join('; ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Workspace commitment tiers, Basic and Auxiliary log plans, data export, long-term archive, alerts, and the legacy per-node Enterprise tier are not in this estimate.'],
  price: async (c, ctx) => {
    const gb = n(c.ingestGbPerMonth), days = n(c.retentionDays ?? INCLUDED_DAYS), hours = c.hours ?? HOURS;
    const tests = n(c.standardTests), loc = n(c.testLocations ?? 5), freq = n(c.testFrequencyMinutes ?? 5), ms = n(c.multiStepTests);
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (![5, 10, 15].includes(freq)) throw new PricingError('testFrequencyMinutes must be 5, 10 or 15.');
    if (days < 30 || days > 730) throw new PricingError('retentionDays must be between 30 and 730.');
    const lines = [], notes = [];
    const la = await rows(`serviceName eq 'Log Analytics' and ${regionFilter(ctx)} and skuName eq 'Analytics Logs' and priceType eq 'Consumption'`, ctx);
    const ingRows = la.filter(r => r.meterName === 'Analytics Logs Data Ingestion');
    if (!ingRows.length) throw new PricingError(`Application Insights data ingestion is not priced in ${ctx.region}. Choose a nearby region that Azure Monitor supports.`);
    const ing = single(ingRows, 'Application Insights data ingestion');
    lines.push(meterLine('Monitoring', 'Application Insights', `Telemetry ingestion, ${fmtN(gb)} GB/month (first 5 GB free)`, ing, gb, ctx, { unit: 'GB' }));
    if (days > INCLUDED_DAYS) {
      const ret = single(la.filter(r => r.meterName === 'Analytics Logs Data Retention'), 'Application Insights retention');
      const extraGb = gb * (days - INCLUDED_DAYS) / DAYS_PER_MONTH;
      lines.push(meterLine('Monitoring', 'Application Insights', `Retention beyond ${INCLUDED_DAYS} days (${fmtN(days)} days kept), ${fmtN(Math.round(extraGb * 100) / 100)} GB-months`, ret, extraGb, ctx, { unit: 'GB / month' }));
    }
    if (tests) {
      const rs = await rows(`serviceName eq 'Azure Monitor' and ${regionFilter(ctx)} and meterName eq 'Standard Web Test Execution' and priceType eq 'Consumption'`, ctx);
      const m = single(rs, 'Standard web test executions');
      const execs = tests * loc * (60 / freq) * hours;
      lines.push(meterLine('Monitoring', 'Application Insights', `Standard web tests, ${fmtN(tests)} test(s) x ${fmtN(loc)} location(s) every ${fmtN(freq)} min, ${fmtN(hours)} hours (${fmtN(Math.round(execs))} executions)`, m, execs, ctx, { unit: 'executions' }));
    }
    if (ms) {
      const rs = await rows(`serviceName eq 'Application Insights' and ${regionFilter(ctx)} and meterName eq 'Multi-step Web Test' and priceType eq 'Consumption'`, ctx);
      const m = single(rs, 'Multi-step web test');
      const active = ms * hours / HOURS;
      lines.push(meterLine('Monitoring', 'Application Insights', `Multi-step web tests, ${fmtN(ms)} test(s) active ${fmtN(hours)} of ${fmtN(HOURS)} hours (prorated daily while active)`, m, active, ctx, { unit: 'tests / month' }));
      notes.push('Multi-step web tests are a legacy feature; Microsoft documents Standard tests as the current availability test type. Multi-step tests are billed per test, prorated daily for each active test, regardless of locations or frequency.');
    }
    notes.push('Workspace-based and classic Application Insights resources bill ingestion and retention at the same per-GB rates, through the Log Analytics workspace; the first 5 GB of ingestion each month is free per billing account and is shared with other Log Analytics usage in the same estimate.');
    notes.push(`Application Insights tables keep data for ${INCLUDED_DAYS} days at no charge; only retention beyond that is billed.`);
    notes.push('URL ping tests are free, but Microsoft removes them on 30 September 2028; Standard tests replace them and are billed per execution.');
    if (tests) notes.push('Availability test results are also stored as telemetry and count toward ingestion; add them to the monthly GB if volume matters.');
    return { lines, notes, facts: { ingestGbPerMonth: gb, retentionDays: days, standardTests: tests, testLocations: loc, testFrequencyMinutes: freq, multiStepTests: ms, hours } };
  }
};
