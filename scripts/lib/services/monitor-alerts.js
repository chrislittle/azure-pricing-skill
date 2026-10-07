'use strict';
// Azure Monitor alert rules and notifications. Meters: serviceName 'Azure Monitor', product 'Azure Monitor', regional alert meters
// ('Alerts Metric Monitored', 'Alerts Dynamic Threshold', 'Alerts System Log Monitored at N Minute Frequency',
// 'Alerts Resource Monitored at N Minute Frequency', per rule or time series per month) and Global notification meters
// (emails, push, webhooks, ITSM events, SMS and voice per country code). Free grants come from the meters' own tier bands.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const FREQ = [1, 5, 10, 15];

// Calculator countries -> international calling code used in the SMS and voice meter names.
const COUNTRIES = { australia: 61, austria: 43, belgium: 32, brazil: 55, chile: 56, china: 86, 'czech-republic': 420, denmark: 45, estonia: 372, finland: 358, france: 33, germany: 49, 'hong-kong': 852, india: 91, ireland: 353, israel: 972, italy: 39, japan: 81, jordan: 962, luxembourg: 352, malaysia: 60, mexico: 52, netherlands: 31, 'new-zealand': 64, norway: 47, portugal: 351, romania: 40, russia: 7, singapore: 65, 'south-africa': 27, 'south-korea': 82, spain: 34, sweden: 46, switzerland: 41, taiwan: 886, 'united-arab-emirates': 971, 'united-kingdom': 44, 'united-states': 1, canada: 1 };
const COUNTRY_LIST = Object.keys(COUNTRIES);

const MONITOR = "serviceName eq 'Azure Monitor' and priceType eq 'Consumption'";

module.exports = {
  type: 'monitor-alerts',
  label: 'Azure Monitor alert rules and notifications',
  family: 'monitoring',
  calculator: ['monitor'],
  keywords: ['azure monitor alerts', 'alert rule', 'metric alert', 'log alert', 'log search alert', 'activity log alert', 'action group', 'sms alert', 'voice call alert', 'email notification', 'webhook', 'itsm connector', 'alerting', 'monitor notifications'],
  fields: {
    metricTimeSeries: { def: 0, int: true, min: 0, ask: 'How many metric alert conditions will you watch? Count each resource (and each dimension value) a rule monitors as one time series; for example 1 rule on 20 VMs is 20. The first 10 each month are free. Use 0 if none.' },
    dynamicThresholdTimeSeries: { def: 0, int: true, min: 0, ask: 'How many of the metric time series use dynamic thresholds (machine-learning baseline instead of a fixed number)? Dynamic threshold is billed on top of the normal metric alert price. Use 0 if none.' },
    logAlertRules: { def: 0, int: true, min: 0, ask: 'How many log search alert rules (a KQL query that runs on a schedule) will you have? Use 0 if none.' },
    simpleLogAlertRules: { def: 0, int: true, min: 0, ask: 'How many simple log search alert rules (a basic query that alerts on a count or a single result) will you have? They are billed like 1-minute log alert rules. Use 0 if none.' },
    logAlertResources: { def: 0, int: true, min: 0, ask: 'Do any log alert rules split their results by resource or dimension value (at scale)? How many time series (each resource or dimension value the query splits by) in total across those rules? The first time series of each such rule is included in the rule price. Use 0 if none.' },
    atScaleLogAlertRules: { int: true, min: 1, ask: 'How many of the log alert rules are at-scale rules that split by resource or dimension? The first time series of each is free. Defaults to all log alert rules. Only matters if you gave a time series count above.' },
    logFrequencyMinutes: { def: 5, int: true, min: 1, max: 15, ask: 'How often should the log alert rules evaluate, in minutes (1, 5, 10 or 15)? Faster evaluation costs more. Use 5 if unknown.' },
    emails: { def: 0, int: true, min: 0, ask: 'About how many alert emails will be sent each month? (The first 1,000 are free.) Use 0 if none.' },
    pushNotifications: { def: 0, int: true, min: 0, ask: 'About how many push notifications to the Azure mobile app each month? (The first 1,000 are free.) Use 0 if none.' },
    webhooks: { def: 0, int: true, min: 0, ask: 'About how many webhook calls will alerts make each month? (The first 100,000 are free.) Use 0 if none.' },
    secureWebhooks: { def: 0, int: true, min: 0, ask: 'About how many secure webhook calls (Microsoft Entra-authenticated) each month? (The first 1,000 are free.) Use 0 if none.' },
    itsmEvents: { def: 0, int: true, min: 0, ask: 'About how many ITSM connector events (tickets created or updated in a tool like ServiceNow) each month? (The first 1,000 are free.) Use 0 if none.' },
    smsCountry: { def: 'united-states', enum: COUNTRY_LIST, ask: 'In which country are the people who receive SMS alerts? SMS price depends on the country.' },
    smsOtherCountries: { def: '', ask: 'Do SMS alerts also go to other countries? List them as country:count pairs separated by commas, for example "united-kingdom:50,germany:20". Leave blank if not.' },
    smsMessages: { def: 0, int: true, min: 0, ask: 'About how many SMS alert messages each month? (US: first 100 free.) Use 0 if none.' },
    voiceCountry: { def: 'united-states', enum: COUNTRY_LIST, ask: 'In which country are the people who receive voice call alerts?' },
    voiceOtherCountries: { def: '', ask: 'Do voice call alerts also go to other countries? List them as country:count pairs separated by commas, for example "germany:20". Leave blank if not.' },
    voiceCalls: { def: 0, int: true, min: 0, ask: 'About how many voice call alerts each month? (The first 10 are free.) Use 0 if none.' }
  },
  context: ['production'],
  examples: [
    { type: 'monitor-alerts', metricTimeSeries: 60, logAlertRules: 8, logFrequencyMinutes: 5, emails: 4000 },
    { type: 'monitor-alerts', metricTimeSeries: 25, dynamicThresholdTimeSeries: 25, logAlertRules: 3, atScaleLogAlertRules: 2, logFrequencyMinutes: 1, logAlertResources: 200, simpleLogAlertRules: 2, webhooks: 300000, secureWebhooks: 5000, itsmEvents: 2500, pushNotifications: 3000 },
    { type: 'monitor-alerts', metricTimeSeries: 15, smsCountry: 'united-states', smsMessages: 400, smsOtherCountries: 'canada:50,germany:20', voiceCountry: 'germany', voiceCalls: 60 },
    { type: 'monitor-alerts', logAlertRules: 2, logFrequencyMinutes: 15, smsCountry: 'united-kingdom', smsMessages: 150 }
  ],
  readback: c => {
    const parts = [];
    const metricShown = Math.max(n(c.metricTimeSeries), n(c.dynamicThresholdTimeSeries));
    if (metricShown) parts.push(`${fmtN(metricShown)} metric alert time series`);
    if (n(c.dynamicThresholdTimeSeries)) parts.push(`${fmtN(c.dynamicThresholdTimeSeries)} dynamic-threshold time series`);
    if (n(c.logAlertRules)) parts.push(`${fmtN(c.logAlertRules)} log alert rule(s) every ${fmtN(c.logFrequencyMinutes ?? 5)} min`);
    if (n(c.simpleLogAlertRules)) parts.push(`${fmtN(c.simpleLogAlertRules)} simple log search alert rule(s)`);
    if (n(c.logAlertResources)) parts.push(`${fmtN(c.logAlertResources)} time series on ${fmtN(c.atScaleLogAlertRules ?? c.logAlertRules ?? 1)} at-scale log alert rule(s) every ${fmtN(c.logFrequencyMinutes ?? 5)} min`);
    for (const [k, l] of [['emails', 'emails'], ['pushNotifications', 'push notifications'], ['webhooks', 'webhooks'], ['secureWebhooks', 'secure webhooks'], ['itsmEvents', 'ITSM events']]) if (n(c[k])) parts.push(`${fmtN(c[k])} ${l}/month`);
    if (n(c.smsMessages) || c.smsOtherCountries) parts.push(`${[n(c.smsMessages) ? `${fmtN(c.smsMessages)} to ${c.smsCountry || 'united-states'}` : '', c.smsOtherCountries || ''].filter(Boolean).join(' and ')} SMS/month`);
    if (n(c.voiceCalls) || c.voiceOtherCountries) parts.push(`${[n(c.voiceCalls) ? `${fmtN(c.voiceCalls)} to ${c.voiceCountry || 'united-states'}` : '', c.voiceOtherCountries || ''].filter(Boolean).join(' and ')} voice calls/month`);
    return `Azure Monitor alerts: ${parts.join(', ') || 'no billable items'}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Activity log, service health and resource health alerts are free and not listed. Health criteria and Standard API call meters are not modeled. The telemetry the rules query (Log Analytics ingestion), and Logic Apps or Functions that alerts trigger, are not in this estimate.'],
  price: async (c, ctx) => {
    const lines = [], notes = [];
    const freq = n(c.logFrequencyMinutes ?? 5);
    if (!FREQ.includes(freq)) throw new PricingError(`logFrequencyMinutes must be one of ${FREQ.join(', ')}.`);
    const fetch = async (meterName, global) => {
      const where = [regionFilter(ctx), "armRegionName eq 'Global'"];
      for (const w of global ? where.reverse() : where) {
        const rs = await rows(`${MONITOR} and ${w} and meterName eq '${meterName}'`, ctx);
        if (rs.length) { if (!global && w !== where[0]) notes.push(`"${meterName}" is not published for ${ctx.region}; the Global list rate was used and may differ from the regional price.`); return rs; }
      }
      return [];
    };
    const add = async (qty, meterName, desc, unit, what, global) => {
      if (!n(qty)) return;
      const rs = await fetch(meterName, global);
      if (!rs.length) throw new PricingError(`${what} is not priced (meter "${meterName}") in ${ctx.region}.`);
      lines.push(meterLine('Monitoring', 'Azure Monitor', desc, single(rs, what), n(qty), ctx, { unit }));
    };
    const dt = n(c.dynamicThresholdTimeSeries);
    let metric = n(c.metricTimeSeries);
    if (dt > metric) {
      notes.push(`Dynamic threshold is billed on top of the underlying metric alert, so metric time series were raised from ${fmtN(metric)} to ${fmtN(dt)}.`);
      metric = dt;
    }
    const simple = n(c.simpleLogAlertRules), rules = n(c.logAlertRules);
    const atScaleRules = n(c.atScaleLogAlertRules ?? rules);
    if (rules && atScaleRules > rules) throw new PricingError('atScaleLogAlertRules cannot exceed logAlertRules.');
    const extraTs = Math.max(0, n(c.logAlertResources) - atScaleRules);
    await add(metric, 'Alerts Metric Monitored', `Metric alert time series, ${fmtN(metric)} (first 10 free)`, 'time series / month', 'Metric alert time series');
    await add(dt, 'Alerts Dynamic Threshold', `Dynamic-threshold alert time series, ${fmtN(dt)}`, 'time series / month', 'Dynamic threshold time series');
    await add(rules, `Alerts System Log Monitored at ${freq} Minute Frequency`, `Log search alert rules, ${fmtN(rules)} rule(s) evaluated every ${freq} min`, 'rules / month', 'Log alert rules');
    await add(simple, 'Alerts System Log Monitored at 1 Minute Frequency', `Simple log search alert rules, ${fmtN(simple)}`, 'rules / month', 'Simple log search alert rules');
    if (n(c.logAlertResources)) {
      if (!rules) throw new PricingError('At-scale log alert time series need at least one log alert rule (logAlertRules).');
      await add(extraTs, `Alerts Resource Monitored at ${freq} Minute Frequency`, `At-scale log alert time series beyond the first per rule, ${fmtN(extraTs)} (${fmtN(n(c.logAlertResources))} total, ${fmtN(atScaleRules)} included free) evaluated every ${freq} min`, 'time series / month', 'At-scale log alert time series');
    }
    await add(c.emails, 'Emails', `Email notifications, ${fmtN(n(c.emails))}/month (first 1,000 free)`, 'emails', 'Email notifications', true);
    await add(c.pushNotifications, 'Notifications Push Notification', `Push notifications, ${fmtN(n(c.pushNotifications))}/month (first 1,000 free)`, 'notifications', 'Push notifications', true);
    await add(c.webhooks, 'Notifications Web hook', `Webhook calls, ${fmtN(n(c.webhooks))}/month (first 100,000 free)`, 'webhook calls', 'Webhook calls', true);
    await add(c.secureWebhooks, 'Notifications Secure web hook', `Secure webhook calls, ${fmtN(n(c.secureWebhooks))}/month (first 1,000 free)`, 'secure webhook calls', 'Secure webhook calls', true);
    await add(c.itsmEvents, 'Notifications ITSM Connector Create/Update Event', `ITSM connector events, ${fmtN(n(c.itsmEvents))}/month (first 1,000 free)`, 'events', 'ITSM events', true);
    const countryList = (main, count, extra, what) => {
      const out = [];
      if (n(count)) out.push([main || 'united-states', n(count)]);
      for (const part of String(extra || '').split(',').map(x => x.trim()).filter(Boolean)) {
        const [name, q] = part.split(':').map(x => x.trim().toLowerCase());
        if (!COUNTRIES[name] || !(n(q) > 0)) throw new PricingError(`${what} "${part}" must be country:count with a country from ${COUNTRY_LIST.join(', ')}.`);
        out.push([name, n(q)]);
      }
      return out;
    };
    for (const [country, qty] of countryList(c.smsCountry, c.smsMessages, c.smsOtherCountries, 'smsOtherCountries')) {
      const cc = COUNTRIES[country];
      if (!cc) throw new PricingError(`Unknown smsCountry "${country}". Use one of ${COUNTRY_LIST.join(', ')}.`);
      await add(qty, `SMS Country Code ${cc} Notification`, `SMS to ${country} (+${cc}), ${fmtN(qty)}/month${cc === 1 ? ' (first 100 free)' : ''}`, 'SMS', `SMS to +${cc}`, true);
    }
    for (const [country, qty] of countryList(c.voiceCountry, c.voiceCalls, c.voiceOtherCountries, 'voiceOtherCountries')) {
      const cc = COUNTRIES[country];
      if (!cc) throw new PricingError(`Unknown voiceCountry "${country}". Use one of ${COUNTRY_LIST.join(', ')}.`);
      await add(qty, cc === 1 ? 'Voice Calls' : `Voice Calls Voice Call Country Code ${cc}`, `Voice calls to ${country} (+${cc}), ${fmtN(qty)}/month (first 10 free per country)`, 'calls', `Voice calls to +${cc}`, true);
    }
    if (!lines.length) throw new PricingError('monitor-alerts has nothing to price: set at least one alert rule or notification count above zero.');
    notes.push('Metric alert time series are billed per monitored time series per month; each resource and dimension value a rule watches counts separately.',
      'Free grants (10 metric time series, 1,000 emails, 100,000 webhooks, 100 US SMS, 10 voice calls and so on) are part of the published price bands and are applied once per month.');
    if (n(c.secureWebhooks)) notes.push('The pricing page states 1 free secure webhook, while the Retail meter bands give 1,000; the Retail bands are used (impact is under one cent).');
    return { lines, notes, facts: { metricTimeSeries: metric, dynamicThresholdTimeSeries: n(c.dynamicThresholdTimeSeries), logAlertRules: rules, simpleLogAlertRules: simple, billableAlertItems: metric + rules + simple, oneMinuteLogRules: (freq === 1 ? rules : 0) + simple, logAlertResources: n(c.logAlertResources), logFrequencyMinutes: freq, emails: n(c.emails), smsMessages: n(c.smsMessages), voiceCalls: n(c.voiceCalls) } };
  }
};
