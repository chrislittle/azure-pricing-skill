'use strict';
// Azure Monitor metrics: Managed Prometheus / Azure Monitor workspace samples, advanced platform metrics, platform metric API
// calls, metrics export and platform logs to storage or event hubs. Meters: serviceName 'Azure Monitor', priced per 10M samples,
// per 1K samples or API calls, or per GB; each is regional except 'Native Metric Queries', which is also published as Global.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const MONITOR = "serviceName eq 'Azure Monitor' and priceType eq 'Consumption'";
const SECONDS_PER_MONTH = 730 * 3600;
// Calculator default collection: samples per minute per Linux node, Windows node, container and pod; billed over a 30-day month.
const DEFAULT_SAMPLES_PER_MIN = { linux: 2750, windows: 1000, container: 125, pod: 125 };
const MIN_PER_MONTH = 60 * 24 * 30;

module.exports = {
  type: 'monitor-metrics',
  label: 'Azure Monitor metrics (Prometheus, platform metrics, export)',
  family: 'monitoring',
  calculator: ['monitor'],
  keywords: ['azure monitor metrics', 'managed prometheus', 'prometheus', 'azure monitor workspace', 'metric samples', 'samples ingested', 'otel metrics', 'opentelemetry metrics', 'advanced platform metrics', 'metrics export', 'platform logs', 'platform metric api', 'metrics api calls', 'aks prometheus'],
  fields: {
    linuxNodes: { def: 0, int: true, min: 0, ask: 'To estimate Managed Prometheus with default collection for AKS or Arc Kubernetes: how many Linux nodes will be scraped? Use 0 if none, or if you will give the sample volume directly.' },
    windowsNodes: { def: 0, int: true, min: 0, ask: 'How many Windows nodes will be scraped by Managed Prometheus (default collection)? Use 0 if none.' },
    containers: { def: 0, int: true, min: 0, ask: 'About how many containers run across the scraped nodes (default collection adds a small per-container volume)? Ask for the container count of the cluster or estimate it from the workload; 0 understates the cost.' },
    pods: { def: 0, int: true, min: 0, ask: 'About how many pods run across the scraped nodes (default collection adds a small per-pod volume)? Ask for the pod count of the cluster or estimate it from the workload; 0 understates the cost.' },
    aksNodes: { def: 0, int: true, min: 0, ask: 'ADVANCED, only for a custom scrape configuration: how many nodes expose a known number of series? Leave 0 to use the default-collection fields above.' },
    metricsPerNode: { def: 10000, int: true, min: 1, ask: 'ADVANCED (with aksNodes): how many metric time series does each node expose to Prometheus? Use 10,000 if unknown.' },
    scrapeIntervalSeconds: { def: 30, int: true, min: 1, ask: 'ADVANCED (with aksNodes): how often is each metric scraped, in seconds? 30 is the Managed Prometheus default.' },
    ingestedSamplesMillions: { def: 0, min: 0, ask: 'If you already know it: how many million metric samples will be sent to an Azure Monitor workspace each month (Prometheus or OpenTelemetry)? Use 0 if you gave nodes above or have none.' },
    dashboardUsers: { def: 0, int: true, min: 0, ask: 'To estimate query samples from Grafana dashboards: how many people open dashboards each day? Use 0 if unknown or if you give the query volume directly.' },
    dashboardsPerUser: { def: 7, int: true, min: 1, ask: 'How many dashboards does each person open per day? Use 7 (the calculator default) if unknown.' },
    samplesPerDashboard: { def: 50000, int: true, min: 1, ask: 'About how many samples does one dashboard load query? Use 50,000 (the calculator default) if unknown.' },
    alertAndRecordingRules: { def: 0, int: true, min: 0, ask: 'How many Prometheus alert rules plus recording rules will run against the workspace? Rules are evaluated against every node, so this drives query samples. Use 0 if none.' },
    querySamplesMillions: { def: 0, min: 0, ask: 'About how many million samples will dashboards, Grafana and Prometheus alert rules query (read) each month? Give this only if you know the volume; otherwise use the dashboard and rule fields above. Use 0 if unknown.' },
    advancedPlatformSamplesMillions: { def: 0, min: 0, ask: 'How many million samples a month from advanced platform metrics (a premium metrics feature for selected Azure resources) will you ingest? Use 0 if none.' },
    platformMetricApiCalls: { def: 0, int: true, min: 0, ask: 'How many Azure Monitor metrics API calls will tools make each month to read platform metrics (for example, third-party monitoring tools)? The first 1,000,000 are free. Use 0 if none.' },
    metricsExportSamplesMillions: { def: 0, min: 0, ask: 'How many million platform metric samples will you export through data collection rules each month? Use 0 if none.' },
    platformLogsGb: { def: 0, min: 0, ask: 'How many GB of platform logs a month will diagnostic settings send to a storage account, event hub or partner solution (not to Log Analytics)? Use 0 if none.' }
  },
  context: ['production'],
  examples: [
    { type: 'monitor-metrics', linuxNodes: 20, containers: 400, pods: 300, dashboardUsers: 10, dashboardsPerUser: 3, samplesPerDashboard: 20000, alertAndRecordingRules: 10 },
    { type: 'monitor-metrics', linuxNodes: 20, querySamplesMillions: 50000 },
    { type: 'monitor-metrics', ingestedSamplesMillions: 8000, querySamplesMillions: 20000, advancedPlatformSamplesMillions: 500 },
    { type: 'monitor-metrics', platformMetricApiCalls: 3000000, metricsExportSamplesMillions: 200, platformLogsGb: 400 },
    { type: 'monitor-metrics', aksNodes: 5, metricsPerNode: 5000, scrapeIntervalSeconds: 60 }
  ],
  readback: c => {
    const parts = [];
    if (n(c.linuxNodes) || n(c.windowsNodes) || n(c.containers) || n(c.pods)) parts.push(`Managed Prometheus default collection: ${fmtN(n(c.linuxNodes))} Linux node(s), ${fmtN(n(c.windowsNodes))} Windows node(s), ${fmtN(n(c.containers))} container(s), ${fmtN(n(c.pods))} pod(s)`);
    if (n(c.dashboardUsers)) parts.push(`${fmtN(c.dashboardUsers)} dashboard user(s) a day opening ${fmtN(c.dashboardsPerUser ?? 7)} dashboard(s) each, ${fmtN(c.samplesPerDashboard ?? 50000)} samples per dashboard`);
    if (n(c.alertAndRecordingRules)) parts.push(`${fmtN(c.alertAndRecordingRules)} Prometheus alert and recording rules`);
    if (n(c.aksNodes)) parts.push(`Managed Prometheus on ${fmtN(c.aksNodes)} node(s), ${fmtN(c.metricsPerNode ?? 10000)} series each every ${fmtN(c.scrapeIntervalSeconds ?? 30)} s`);
    if (n(c.ingestedSamplesMillions)) parts.push(`${fmtN(c.ingestedSamplesMillions)}M samples ingested/month`);
    if (n(c.querySamplesMillions)) parts.push(`${fmtN(c.querySamplesMillions)}M query samples/month`);
    if (n(c.advancedPlatformSamplesMillions)) parts.push(`${fmtN(c.advancedPlatformSamplesMillions)}M advanced platform samples/month`);
    if (n(c.platformMetricApiCalls)) parts.push(`${fmtN(c.platformMetricApiCalls)} metrics API calls/month`);
    if (n(c.metricsExportSamplesMillions)) parts.push(`${fmtN(c.metricsExportSamplesMillions)}M exported samples/month`);
    if (n(c.platformLogsGb)) parts.push(`${fmtN(c.platformLogsGb)} GB platform logs to storage/event hub`);
    return `Azure Monitor metrics: ${parts.join(', ') || 'no billable items'}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Platform metrics themselves are free. Log Analytics ingestion, Managed Grafana, and Container insights logs are priced separately and are not in this estimate. The Azure Copilot Observability Agent (billed in agent credits) and the Metrics emitted AzMon pipeline meter are not included.'],
  price: async (c, ctx) => {
    const lines = [], notes = [];
    const nodes = n(c.aksNodes), explicit = n(c.ingestedSamplesMillions);
    const lin = n(c.linuxNodes), win = n(c.windowsNodes), cont = n(c.containers), pods = n(c.pods);
    const defaultCollection = lin + win + cont + pods > 0;
    if ((nodes ? 1 : 0) + (explicit ? 1 : 0) + (defaultCollection ? 1 : 0) > 1) throw new PricingError('Give only one ingestion estimate: default collection (linuxNodes, windowsNodes, containers, pods), aksNodes (custom series), or ingestedSamplesMillions (known volume).');
    const interval = n(c.scrapeIntervalSeconds ?? 30);
    if (interval < 1) throw new PricingError('scrapeIntervalSeconds must be at least 1.');
    let ingested = 0;
    if (nodes) ingested = nodes * n(c.metricsPerNode ?? 10000) * (SECONDS_PER_MONTH / interval);
    else if (defaultCollection) ingested = (lin * DEFAULT_SAMPLES_PER_MIN.linux + win * DEFAULT_SAMPLES_PER_MIN.windows + cont * DEFAULT_SAMPLES_PER_MIN.container + pods * DEFAULT_SAMPLES_PER_MIN.pod) * MIN_PER_MONTH;
    else ingested = explicit * 1e6;
    const users = n(c.dashboardUsers), rules = n(c.alertAndRecordingRules);
    if (n(c.querySamplesMillions) && (users || rules)) throw new PricingError('Give either querySamplesMillions (known volume) or the dashboard and rule fields, not both.');
    const scrapedNodes = lin + win + nodes;
    if (rules && !scrapedNodes) throw new PricingError('alertAndRecordingRules needs the node count (linuxNodes, windowsNodes or aksNodes) because rules run against every node.');
    const estQuery = users * n(c.dashboardsPerUser ?? 7) * n(c.samplesPerDashboard ?? 50000) * 30 + rules * scrapedNodes * 5e5 * 730;
    const querySamples = n(c.querySamplesMillions) * 1e6 + estQuery;
    if (ingested > 1e13 || querySamples > 1e14) notes.push('This sample volume is far beyond typical Azure Monitor workspace limits; check the inputs and the workspace active time series limits.');
    const getRows = (product, global) => rows(`${MONITOR} and ${regionFilter(ctx)} and skuName eq '${product}'`, ctx).then(async r => r.length || !global ? r : rows(`${MONITOR} and armRegionName eq 'Global' and skuName eq '${product}'`, ctx));
    const add = async (qty, product, desc, unit, what, global) => {
      if (!n(qty)) return;
      const rs = await getRows(product, global);
      if (!rs.length) throw new PricingError(`${what} is not priced (sku "${product}") in ${ctx.region}.`);
      lines.push(meterLine('Monitoring', 'Azure Monitor', desc, single(rs, what), n(qty), ctx, { unit }));
    };
    if (ingested) {
      const label = nodes ? `${fmtN(Math.round(ingested / 1e6))}M samples (${fmtN(nodes)} nodes x ${fmtN(n(c.metricsPerNode ?? 10000))} series every ${interval} s)` : defaultCollection ? `${fmtN(Math.round(ingested / 1e6))}M samples (default collection: ${fmtN(lin)} Linux, ${fmtN(win)} Windows nodes, ${fmtN(cont)} containers, ${fmtN(pods)} pods)` : `${fmtN(explicit)}M samples`;
      const [ing, proc] = await Promise.all([getRows('Metric Samples Ingested'), getRows('Metric Samples Processed')]);
      if (ing.length && proc.length) {
        await add(ingested, 'Metric Samples Ingested', `Metric samples ingested, ${label}/month`, 'samples', 'Metric samples ingested');
        await add(ingested, 'Metric Samples Processed', `Metric samples processed (billed per ingested sample), ${label}/month`, 'samples', 'Metric samples processed');
        notes.push('Ingestion is priced as the published meters samples ingested plus samples processed, assuming each ingested sample is processed once; together they equal the combined "Metrics ingestion" rate in most regions, and the invoice may show the single meter name "Metrics ingestion Metric samples". Data is retained 18 months at no extra charge.');
        if (/^usgov/.test(ctx.region)) notes.push('In US Government regions the published split meters add up to USD 0.16 per 10M samples, but the combined "Metrics ingestion" meter and the calculator show USD 0.20; the actual bill may be higher.');
      } else {
        await add(ingested, 'Metrics ingestion', `Metric samples ingested and processed, ${label}/month`, 'samples', 'Metrics ingestion');
        notes.push(`Only the combined "Metrics ingestion" meter is published for ${ctx.region}, so it was used instead of the separate ingested and processed meters. Data is retained 18 months at no extra charge.`);
      }
    }
    await add(querySamples, 'Prometheus Metrics Queries', `Query samples processed, ${fmtN(+(querySamples / 1e6).toFixed(3))}M/month${estQuery ? ' (estimated from dashboards and rules)' : ''}`, 'samples', 'Query samples processed');
    await add(n(c.advancedPlatformSamplesMillions) * 1e6, 'Advanced Platform Metric Samples Ingested', `Advanced platform metric samples ingested, ${fmtN(n(c.advancedPlatformSamplesMillions))}M/month`, 'samples', 'Advanced platform metric samples');
    await add(n(c.platformMetricApiCalls), 'Native Metric Queries', `Platform metric API calls, ${fmtN(n(c.platformMetricApiCalls))}/month (first 1,000,000 free)`, 'API calls', 'Platform metric API calls', true);
    await add(n(c.metricsExportSamplesMillions) * 1e6, 'Metrics Export', `Metrics export, ${fmtN(n(c.metricsExportSamplesMillions))}M samples/month`, 'samples', 'Metrics export');
    await add(n(c.platformLogsGb), 'Platform Logs', `Platform logs processed to storage or event hub, ${fmtN(n(c.platformLogsGb))} GB/month`, 'GB', 'Platform logs');
    if (!lines.length) throw new PricingError('monitor-metrics has nothing to price: set a Prometheus node or sample count, a query volume, or any other metrics quantity above zero.');
    notes.push('Platform metrics, the metrics explorer and metric alerts on platform metrics are free; only the items above are billed.');
    return { lines, notes, facts: { ingestedSamplesMillions: Math.round(ingested / 1e6), linuxNodes: lin, scrapeIntervalSeconds: interval, aksNodes: nodes, querySamplesMillions: Math.round(querySamples / 1e6), advancedPlatformSamplesMillions: n(c.advancedPlatformSamplesMillions), platformMetricApiCalls: n(c.platformMetricApiCalls), metricsExportSamplesMillions: n(c.metricsExportSamplesMillions), platformLogsGb: n(c.platformLogsGb) } };
  }
};

