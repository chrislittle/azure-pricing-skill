'use strict';
// Microsoft Sentinel (calculator slug azure-sentinel): analytics logs priced pay-as-you-go or by commitment tier
// (Sentinel and Log Analytics ingestion combined in the 'simplified' Sentinel meters), plus the data lake tier,
// basic/auxiliary logs, retention and the add-on meters. Daily-tier meters bill per day, so a month is 365/12 days.
// Security Copilot compute units and the Sentinel pre-purchase plan are not modelled here.
const { rows, single, meterLine, PricingError, fmtN, DAYS } = require('../kit');

const n = v => Number(v || 0);
const TIERS = [50, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10000, 25000, 50000];
const FIELD_NUMS = ['analyticsGBPerDay', 'dataLakeGBPerDay', 'dataProcessingGBPerDay', 'basicLogsGBPerDay', 'auxiliaryLogsGBPerDay', 'dataLakeRetentionMonths', 'totalRetentionMonths', 'basicLogsSearchGBScanned',
  'dataLakeQueryGBScanned', 'searchGBScanned', 'restoreGBDays', 'advancedInsightsHours', 'graphHours', 'sapSystems', 'sapHours'];

module.exports = {
  type: 'sentinel',
  label: 'Microsoft Sentinel',
  family: 'security',
  calculator: ['azure-sentinel'],
  keywords: ['sentinel', 'microsoft sentinel', 'siem', 'security information event management', 'log ingestion', 'data lake', 'commitment tier', 'security analytics'],
  fields: {
    analyticsGBPerDay: { req: true, min: 0, ask: 'About how many GB of security logs per day will you send to Sentinel for detection, alerting and fast queries (the analytics logs tier)? If you do not know, ask how many servers, firewalls and users you have and give a rough estimate (roughly 0.5 to 2 GB per day for a small estate of a few hundred users is common), and record it as an assumption.' },
    commitment: { def: 'payg', enum: ['payg', 'cheapest', ...TIERS.map(String)], ask: 'Do you want to pay per GB (payg), or reserve a daily amount at a discount? For a fixed daily reservation, answer with the GB per day of the tier (50, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10000, 25000 or 50000); the bill is the full tier price even if you ingest less, and any extra above the tier is billed at the same effective per-GB rate. Answer cheapest to compare every option and take the lowest. If unknown, suggest payg for under about 35 GB per day (the 50 GB/day tier is cheaper than pay-as-you-go from about 34 GB/day) and cheapest above that.' },
    analyticsRetentionMonths: { def: 3, min: 0, ask: 'How many months must analytics-tier data stay immediately searchable? The first 3 months are included free; each month beyond that costs per GB. If unknown, suggest 3.' },
    dataLakeGBPerDay: { def: 0, min: 0, ask: 'How many GB per day of high-volume, rarely queried logs (firewall, network, proxy) will go into the cheaper data lake tier only? Leave 0 if none.' },
    dataProcessingGBPerDay: { def: 0, min: 0, ask: 'How many GB per day of data lake data will be processed (transformed, enriched or promoted by jobs and ingestion-time rules)? Leave 0 if none.' },
    dataLakeRetentionMonths: { def: 12, min: 0, ask: 'How many months should data lake data be kept? Leave 12 if unknown. Lake storage is charged for every month the data is kept (about 6:1 compressed).' },
    totalRetentionMonths: { def: 0, min: 0, ask: 'Only if analytics logs must be kept longer than the analytics retention above: total months to retain them (the extra months are kept in the cheaper data lake). Leave 0 to keep analytics data only for the analytics retention.' },
    dataLakeQueryGBScanned: { def: 0, min: 0, ask: 'About how many GB of data lake data will queries scan per month in total (queries per month times GB scanned per query)? Leave 0 if unknown.' },
    basicLogsGBPerDay: { def: 0, min: 0, ask: 'How many GB per day go to basic logs (cheaper ingestion, limited queries, 30 days of search)? Leave 0 if none.' },
    auxiliaryLogsGBPerDay: { def: 0, min: 0, ask: 'How many GB per day go to auxiliary logs (lowest-cost ingestion for rarely queried data)? Leave 0 if none.' },
    basicLogsSearchGBScanned: { def: 0, min: 0, ask: 'About how many GB per month will queries scan on basic logs? Leave 0 if unknown.' },
    searchGBScanned: { def: 0, min: 0, ask: 'About how many GB per month will search jobs scan on basic, auxiliary or long-term retained data? Leave 0 if unknown.' },
    restoreGBDays: { def: 0, min: 0, ask: 'Only if you restore archived data for investigations: how many GB multiplied by days kept restored, per month (at least 2 TB and 12 hours each restore)? Leave 0 if none.' },
    advancedInsightsHours: { def: 0, min: 0, ask: 'Only if you use advanced data insights (notebook and graph analytics): total compute hours per month, which is the pool size in cores (12, 32 or 80) multiplied by the hours it runs. Leave 0 if none.' },
    graphHours: { def: 0, min: 0, ask: 'Only if you use the Sentinel graph: total vCore-hours per month (vCores used multiplied by hours; building the graph uses 49 vCores and queries use 6). Leave 0 if none.' },
    sapSystems: { def: 0, int: true, min: 0, ask: 'Only if you protect SAP: how many connected, active production SAP systems? Leave 0 if none.' },
    sapHours: { def: 730, min: 0, max: 744, ask: 'SAP systems only: hours per month the systems are connected (730 is a full month).' }
  },
  context: ['production'],
  examples: [
    { type: 'sentinel', analyticsGBPerDay: 20 },
    { type: 'sentinel', analyticsGBPerDay: 150, commitment: '100', analyticsRetentionMonths: 6, dataLakeGBPerDay: 200, dataProcessingGBPerDay: 50, dataLakeRetentionMonths: 12, dataLakeQueryGBScanned: 500 },
    { type: 'sentinel', analyticsGBPerDay: 400, commitment: 'cheapest', basicLogsGBPerDay: 30, auxiliaryLogsGBPerDay: 100, searchGBScanned: 1000, sapSystems: 2 }
  ],
  readback: c => {
    const parts = [`${fmtN(c.analyticsGBPerDay)} GB/day analytics logs on ${c.commitment && c.commitment !== 'payg' ? (c.commitment === 'cheapest' ? 'the cheapest commitment tier or pay-as-you-go' : `the ${c.commitment} GB/day commitment tier`) : 'pay-as-you-go'}, ${fmtN(c.analyticsRetentionMonths == null ? 3 : c.analyticsRetentionMonths)} months analytics retention`];
    const add = [['dataLakeGBPerDay', 'GB/day data lake ingestion'], ['dataProcessingGBPerDay', 'GB/day data lake processing'], ['basicLogsGBPerDay', 'GB/day basic logs'], ['auxiliaryLogsGBPerDay', 'GB/day auxiliary logs'], ['dataLakeQueryGBScanned', 'GB/month data lake query scanned'], ['searchGBScanned', 'GB/month search scanned'], ['restoreGBDays', 'GB-days/month restored'], ['advancedInsightsHours', 'compute hours/month advanced data insights'], ['graphHours', 'vCore-hours/month graph'], ['totalRetentionMonths', 'months total analytics retention'], ['basicLogsSearchGBScanned', 'GB/month basic logs query scanned'], ['sapSystems', 'SAP production system(s)']];
    for (const [k, t] of add) if (n(c[k])) parts.push(`${fmtN(c[k])} ${t}`);
    if (n(c.dataLakeGBPerDay)) parts.push(`${fmtN(c.dataLakeRetentionMonths == null ? 12 : c.dataLakeRetentionMonths)} months data lake retention`);
    return parts.join(', ');
  },
  notIncluded: () => ['Security Copilot compute units (see security-copilot), Logic Apps playbook runs, custom machine-learning models, Sentinel pre-purchase plan discounts, and the Azure resources that generate the logs'],
  price: async (c, ctx) => {
    for (const k of FIELD_NUMS) if (c[k] != null && !(n(c[k]) >= 0)) throw new PricingError(`${k} must be 0 or more.`);
    const gb = n(c.analyticsGBPerDay);
    if (!(gb >= 0)) throw new PricingError('analyticsGBPerDay must be 0 or more.');
    const commitment = c.commitment || 'payg';
    if (!['payg', 'cheapest', ...TIERS.map(String)].includes(String(commitment))) throw new PricingError(`commitment must be payg, cheapest or one of ${TIERS.join(', ')}.`);
    const retention = c.analyticsRetentionMonths == null ? 3 : n(c.analyticsRetentionMonths);
    const lakeRet = c.dataLakeRetentionMonths == null ? 12 : n(c.dataLakeRetentionMonths);
    const sapHours = c.sapHours == null ? 730 : n(c.sapHours);
    if (sapHours > 744) throw new PricingError('sapHours must be 744 or less.');
    const sapSystems = n(c.sapSystems);
    if (!Number.isInteger(sapSystems)) throw new PricingError('sapSystems must be a whole number.');

    const rs = await rows(`(serviceName eq 'Sentinel' or serviceName eq 'Log Analytics' or serviceName eq 'Azure Monitor') and armRegionName eq '${ctx.region}' and priceType eq 'Consumption'`, ctx);
    const find = (service, meter, what) => {
      const m = rs.filter(r => r.serviceName === service && r.meterName === meter);
      if (!m.length) throw new PricingError(`${what} is not priced in ${ctx.region}.`);
      return single(m, what);
    };
    const G = 'Security', S = 'Microsoft Sentinel';
    const lines = [];
    const facts = { analyticsGBPerDay: gb, commitment: String(commitment) };
    const monthGB = gb * DAYS;

    // Analytics logs: pay-as-you-go, one commitment tier (with overage at the tier's effective rate), or the cheapest.
    const paygMeters = find('Sentinel', 'Pay-as-you-go Analysis', 'Sentinel pay-as-you-go analytics logs');
    const tierRows = {};
    for (const t of TIERS) { const m = rs.filter(r => r.serviceName === 'Sentinel' && r.meterName === `${t} GB Commitment Tier Capacity Reservation`); if (m.length) tierRows[t] = m; }
    const unitOf = m => m[0].retailPrice;
    const tierCost = t => { const day = unitOf(tierRows[t]); return gb <= t ? day * DAYS : day * DAYS * gb / t; };
    let chosen = String(commitment);
    if (chosen === 'cheapest') {
      let best = { k: 'payg', cost: unitOf(paygMeters) * monthGB };
      for (const t of Object.keys(tierRows)) { const cst = tierCost(Number(t)); if (cst < best.cost) best = { k: String(t), cost: cst }; }
      chosen = best.k;
      facts.cheapestChoice = chosen;
    }
    if (gb > 0) {
      if (chosen === 'payg') {
        lines.push(meterLine(G, S, `Analytics logs pay-as-you-go: ${fmtN(gb)} GB/day x ${fmtN(Math.round(DAYS * 100) / 100)} days`, paygMeters, monthGB, ctx, { unit: 'GB' }));
      } else {
        const t = Number(chosen);
        if (!tierRows[t]) throw new PricingError(`The ${t} GB/day commitment tier is not priced in ${ctx.region}.`);
        const reservedDays = DAYS;
        lines.push(meterLine(G, S, `Analytics logs ${t} GB/day commitment tier: ${fmtN(Math.round(DAYS * 100) / 100)} days${gb < t ? ` (you pay for the full tier although you ingest ${fmtN(gb)} GB/day)` : ''}`, tierRows[t], reservedDays, ctx, { unit: 'days' }));
        if (gb > t) lines.push(meterLine(G, S, `Analytics logs overage above the tier: ${fmtN(gb - t)} GB/day at the tier's effective per-GB rate`, tierRows[t], reservedDays * (gb - t) / t, ctx, { unit: 'tier-days' }));
      }
    }
    // Analytics retention beyond the 3 months included.
    if (gb > 0 && retention > 3) {
      const extra = retention - 3;
      lines.push(meterLine('Log Analytics', 'Log Analytics', `Analytics logs retention beyond 3 months: ${fmtN(monthGB)} GB/month x ${fmtN(extra)} extra month(s) stored`, find('Log Analytics', 'Analytics Logs Data Retention', 'analytics logs retention'), monthGB * extra, ctx, { unit: 'GB-months' }));
    }
    const totalRet = n(c.totalRetentionMonths);
    if (gb > 0 && totalRet > retention) lines.push(meterLine(G, S, `Analytics logs kept in the data lake after analytics retention: ${fmtN(monthGB)} GB/month x ${fmtN(totalRet - retention)} month(s), compressed 6:1`, find('Sentinel', 'Data lake storage Data Stored', 'data lake storage'), monthGB * (totalRet - retention) / 6, ctx, { unit: 'GB-months' }));
    if (n(c.basicLogsSearchGBScanned)) lines.push(meterLine('Azure Monitor', 'Azure Monitor', `Basic logs queries: ${fmtN(c.basicLogsSearchGBScanned)} GB scanned per month`, find('Azure Monitor', 'Search Queries Scanned', 'basic logs queries'), n(c.basicLogsSearchGBScanned), ctx, { unit: 'GB' }));
    if (n(c.basicLogsGBPerDay)) lines.push(meterLine(G, S, `Basic logs ingestion: ${fmtN(c.basicLogsGBPerDay)} GB/day`, find('Sentinel', 'Basic Logs Analysis', 'Sentinel basic logs'), n(c.basicLogsGBPerDay) * DAYS, ctx, { unit: 'GB' }));
    if (n(c.auxiliaryLogsGBPerDay)) lines.push(meterLine(G, S, `Auxiliary logs ingestion: ${fmtN(c.auxiliaryLogsGBPerDay)} GB/day`, find('Sentinel', 'Classic Auxiliary Logs Analysis', 'Sentinel auxiliary logs'), n(c.auxiliaryLogsGBPerDay) * DAYS, ctx, { unit: 'GB' }));
    if (n(c.auxiliaryLogsGBPerDay)) lines.push(meterLine('Azure Monitor', 'Azure Monitor', `Auxiliary logs Log Analytics ingestion: ${fmtN(c.auxiliaryLogsGBPerDay)} GB/day`, find('Azure Monitor', 'Auxiliary Logs Data Ingestion', 'auxiliary logs ingestion'), n(c.auxiliaryLogsGBPerDay) * DAYS, ctx, { unit: 'GB' }));
    const lake = n(c.dataLakeGBPerDay);
    if (lake) {
      lines.push(meterLine(G, S, `Data lake ingestion: ${fmtN(lake)} GB/day`, find('Sentinel', 'Data lake ingestion Data Processed', 'data lake ingestion'), lake * DAYS, ctx, { unit: 'GB' }));
      // Lake-only tables have no free analytics retention window, so every retained month is billed (data compressed about 6:1).
      const stored = lakeRet;
      if (stored > 0) lines.push(meterLine(G, S, `Data lake storage: ${fmtN(lake * DAYS)} GB/month ingested, compressed 6:1, ${fmtN(stored)} month(s) retained`, find('Sentinel', 'Data lake storage Data Stored', 'data lake storage'), lake * DAYS * stored / 6, ctx, { unit: 'GB-months' }));
    }
    if (n(c.dataProcessingGBPerDay)) lines.push(meterLine(G, S, `Data lake processing: ${fmtN(c.dataProcessingGBPerDay)} GB/day`, find('Sentinel', 'Data processing Data Processed', 'data processing'), n(c.dataProcessingGBPerDay) * DAYS, ctx, { unit: 'GB' }));
    if (n(c.dataLakeQueryGBScanned)) lines.push(meterLine(G, S, `Data lake queries: ${fmtN(c.dataLakeQueryGBScanned)} GB scanned per month`, find('Sentinel', 'Data lake query Data Analyzed', 'data lake query'), n(c.dataLakeQueryGBScanned), ctx, { unit: 'GB' }));
    if (n(c.searchGBScanned)) lines.push(meterLine('Azure Monitor', 'Azure Monitor', `Search jobs: ${fmtN(c.searchGBScanned)} GB scanned per month`, find('Azure Monitor', 'Search Jobs Scanned', 'search jobs'), n(c.searchGBScanned), ctx, { unit: 'GB' }));
    if (n(c.restoreGBDays)) lines.push(meterLine('Azure Monitor', 'Azure Monitor', `Data restore: ${fmtN(c.restoreGBDays)} GB-days per month`, find('Azure Monitor', 'Data Restore', 'data restore'), n(c.restoreGBDays), ctx, { unit: 'GB-days' }));
    if (n(c.advancedInsightsHours)) lines.push(meterLine(G, S, `Advanced data insights: ${fmtN(c.advancedInsightsHours)} compute hours per month`, find('Sentinel', 'Advanced Data Insights', 'advanced data insights'), n(c.advancedInsightsHours), ctx, { unit: 'compute hours' }));
    if (n(c.graphHours)) lines.push(meterLine(G, S, `Sentinel graph: ${fmtN(c.graphHours)} vCore-hours per month`, find('Sentinel', 'Graph', 'Sentinel graph'), n(c.graphHours), ctx, { unit: 'hours' }));
    if (sapSystems) lines.push(meterLine(G, S, `Solution for SAP applications: ${fmtN(sapSystems)} system(s) x ${fmtN(sapHours)} hours`, find('Sentinel', 'Solution for SAP Applications Hourly', 'SAP solution'), sapSystems * sapHours, ctx, { unit: 'system-hours' }));

    const notes = ['Analytics logs on Sentinel simplified pricing combine Log Analytics ingestion and Sentinel analysis in one per-GB rate; the first 90 days of retention are free, and some Microsoft data sources are free to ingest, which this estimate does not subtract.',
      'Basic-logs, auxiliary and search charges for Sentinel are the Sentinel analysis rate plus Log Analytics ingestion, both priced here. Month length is 365/12 days (the calculator uses 30). Enabling Sentinel on a workspace gives a 31-day free trial of the first 10 GB/day of analytics logs; this estimate does not apply it.'];
    if (facts.cheapestChoice) notes.push(`Cheapest option for ${fmtN(gb)} GB/day: ${facts.cheapestChoice === 'payg' ? 'pay-as-you-go' : facts.cheapestChoice + ' GB/day commitment tier'}.`);
    return { lines, notes, facts };
  }
};

