'use strict';
// Microsoft Purview. Meters sit under two Retail API serviceNames: 'Azure Purview' (classic Data Map capacity, scanning, insights,
// DevOps policies) and 'Microsoft Purview' (current pay-as-you-go: data governance, advanced resource set, on-demand classification,
// data security, data compliance). All regional except the DevOps policy meter, which is priced under 'Global' / 'US Gov'.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS, DAYS } = require('../kit');

const n = v => Number(v || 0);
const INT = { int: true, min: 0 };
const CLASSIC_MSG = 'Classic Purview account only. ';

// scope: 'classic' (only with model classic), 'unified' (only with model unified), 'both'.
// kind: 'days' = amount x days held; 'once' = amount as given. flat: ignore any zero-priced first band (a Retail API anomaly).
const DIMS = [
  { k: 'scanVcoreHours', scope: 'classic', product: 'Azure Purview Scanning Ingestion and Classification', meter: 'Standard vCore', kind: 'once', unit: 'vCore-hours', g: 'Analytics', what: 'Scanning, ingestion and classification', fmt: v => `${fmtN(v)} scanning vCore-hours`, ask: CLASSIC_MSG + 'Roughly how many vCore-hours of scanning a month? A scan bills duration x vCores used, so a 30-minute scan on 16 vCores is 8 vCore-hours. Scans of on-premises SQL Server (self-hosted runtime) and Power BI online are free for a limited time and not counted; other SQL Server scans are billed.' },
  { k: 'resourceSetVcoreHours', scope: 'classic', product: 'Azure Purview Data Map', meter: 'Resource Set vCore', kind: 'once', unit: 'vCore-hours', g: 'Analytics', what: 'Classic advanced resource set processing', fmt: v => `${fmtN(v)} classic advanced resource set vCore-hours`, ask: CLASSIC_MSG + 'If they use the advanced resource set feature (groups many similar files into one asset): vCore-hours a month? Otherwise 0.' },
  { k: 'insightsGenerationVcoreHours', scope: 'classic', product: 'Azure Purview Data Map', meter: 'Data Map Enrichment - Data Insights Generation vCore', kind: 'once', unit: 'vCore-hours', g: 'Analytics', what: 'Data Map enrichment (insights generation)', fmt: v => `${fmtN(v)} insight-generation vCore-hours`, ask: CLASSIC_MSG + 'vCore-hours a month spent generating Data Map insights (on by default unless turned off)? Otherwise 0.' },
  { k: 'insightsReportCalls', scope: 'classic', product: 'Azure Purview Data Map', meter: 'Data Insights Insights Report Consumption', kind: 'once', unit: 'API calls', g: 'Analytics', what: 'Insights report API calls', fmt: v => `${fmtN(v)} insights report API calls`, ask: CLASSIC_MSG + 'How many times a month do they pull Data Map insights reports through the API? Otherwise 0.', ...INT },
  { k: 'advancedResourceSetVcoreHours', scope: 'unified', product: 'Microsoft Purview Data Map', meter: 'Advanced Resource Set vCore', kind: 'once', unit: 'vCore-hours', g: 'Analytics', what: 'Advanced resource set', fmt: v => `${fmtN(v)} advanced resource set vCore-hours`, ask: 'Current pay-as-you-go model only: if they use the advanced resource set feature (groups many similar files, such as partitioned data lake files, into one asset), how many vCore-hours of processing a month? Otherwise 0.' },
  { k: 'catalogAssets', scope: 'unified', product: 'Microsoft Purview Data Governance', meter: 'Data Catalog Standard Asset', kind: 'days', unit: 'asset-days', g: 'Analytics', what: 'Data Governance catalog governed assets', fmt: v => `${fmtN(v)} governed catalog assets`, ask: 'Current pay-as-you-go model: how many data assets (tables, files, reports) will be governed in the Unified Catalog? Billed per asset per day. If unknown, suggest 10,000 and record it as an assumption.', ...INT },
  { k: 'dgpuBasic', scope: 'unified', product: 'Microsoft Purview Data Governance', meter: 'Data Management Basic Data Governance Processing Unit', kind: 'once', unit: 'DGPUs', g: 'Analytics', what: 'Data governance processing units, Basic', fmt: v => `${fmtN(v)} basic data governance processing units`, ask: 'For data quality and data health checks on simple sources: how many data governance processing units (1 unit = 60 minutes of compute) a month? A rule on 1 million rows typically uses 0.02 per run; 100 runs a day is about 60 a month. Otherwise 0.' },
  { k: 'dgpuStandard', scope: 'unified', product: 'Microsoft Purview Data Governance', meter: 'Data Management Standard Data Governance Processing Unit', kind: 'once', unit: 'DGPUs', g: 'Analytics', what: 'Data governance processing units, Standard', fmt: v => `${fmtN(v)} standard data governance processing units`, ask: 'For data quality checks on the standard performance option: how many processing units a month? Otherwise 0.' },
  { k: 'dgpuAdvanced', scope: 'unified', product: 'Microsoft Purview Data Governance', meter: 'Data Management Advanced Data Governance Processing Unit', kind: 'once', unit: 'DGPUs', g: 'Analytics', what: 'Data governance processing units, Advanced', fmt: v => `${fmtN(v)} advanced data governance processing units`, ask: 'For data quality checks on the advanced performance option: how many processing units a month? Otherwise 0.' },
  { k: 'classificationAssets', scope: 'both', product: 'Microsoft Purview On-Demand Classification', meter: 'Standard Assets', kind: 'once', unit: 'assets', g: 'Security', what: 'On-demand classification', fmt: v => `${fmtN(v)} assets classified on demand`, ask: 'If they run on-demand classification of files: how many assets (files) a month? Otherwise 0.', ...INT },
  { k: 'securityAssets', scope: 'both', product: 'Microsoft Purview Data Security', meter: 'Standard Asset', kind: 'days', unit: 'asset-days', g: 'Security', what: 'Data security assets (outside Microsoft 365)', fmt: v => `${fmtN(v)} data security assets`, ask: 'Pay-as-you-go data security for data outside Microsoft 365 (Microsoft 365 data is covered by its own licence): how many assets are protected? Billed per asset per day. Otherwise 0.', ...INT },
  { k: 'dataSecurityProcessingUnits', scope: 'both', product: 'Microsoft Purview Data Security', meter: 'Standard Data Security Processing Unit', kind: 'once', unit: 'processing units', g: 'Security', what: 'Data security processing units (insider risk)', fmt: v => `${fmtN(v)} data security processing units`, ask: 'Insider risk analysis of activity outside Microsoft 365: how many processing units a month? One unit processes 10,000 user activities (log lines), so 200,000 activities = 20 units. Otherwise 0.' },
  { k: 'inTransitProtectionRequests', scope: 'both', product: 'Microsoft Purview Data Security', meter: 'In Transit Protection Request', kind: 'once', unit: 'requests', g: 'Security', what: 'In-transit protection requests', fmt: v => `${fmtN(v)} in-transit protection requests`, ask: 'For protecting data in transit (for example AI prompts): how many requests a month? Otherwise 0.', ...INT },
  { k: 'ocrTransactions', scope: 'both', product: 'Microsoft Purview Data Security', meter: 'Optical Character Recognition Transaction', kind: 'once', unit: 'transactions', g: 'Security', what: 'Optical character recognition', fmt: v => `${fmtN(v)} OCR transactions`, ask: 'If images are scanned for sensitive text (OCR): how many images a month? The first 2,500 are free. Otherwise 0.', ...INT },
  { k: 'investigationComputeHours', scope: 'both', product: 'Microsoft Purview Data Security', meter: 'Investigations Compute Unit', kind: 'once', unit: 'compute unit-hours', g: 'Security', what: 'Data Security Investigations compute', fmt: v => `${fmtN(v)} investigation compute unit-hours`, ask: 'For Data Security Investigations: how many compute-unit hours of AI-based analysis a month? Otherwise 0.' },
  { k: 'investigationGb', scope: 'both', product: 'Microsoft Purview Data Security', meter: 'Investigations GB', kind: 'days', unit: 'GB-days', g: 'Security', what: 'Data Security Investigations storage', fmt: v => `${fmtN(v)} GB of investigation data`, ask: 'For Data Security Investigations: how many GB of data are held in investigations? Billed per GB per day. Otherwise 0.' },
  { k: 'auditRecords', scope: 'both', product: 'Microsoft Purview Data Compliance', meter: 'Audit Standard Asset', kind: 'once', unit: 'records', g: 'Security', what: 'Audit (Standard) records outside Microsoft 365', fmt: v => `${fmtN(v)} audit records`, ask: 'Pay-as-you-go audit of activity outside Microsoft 365: how many audit records are ingested a month? Billed per record ($15 per million). Otherwise 0.', ...INT },
  { k: 'communicationComplianceStandardRecords', scope: 'both', product: 'Microsoft Purview Data Compliance', meter: 'Communication Compliance Standard Asset', kind: 'once', unit: 'text records', g: 'Security', what: 'Communication Compliance Standard', fmt: v => `${fmtN(v)} standard text records`, ask: 'Communication compliance for messages outside Microsoft 365, standard tier: how many text records a month? A text record is up to 1,000 characters, so a 7,500-character message counts as 8. Otherwise 0.', ...INT },
  { k: 'communicationCompliancePremiumRecords', scope: 'both', product: 'Microsoft Purview Data Compliance', meter: 'Communication Compliance Premium Asset', kind: 'once', unit: 'text records', g: 'Security', what: 'Communication Compliance Premium', fmt: v => `${fmtN(v)} premium text records`, ask: 'Communication compliance for messages outside Microsoft 365, premium tier: how many text records a month (up to 1,000 characters each)? Otherwise 0.', ...INT },
  { k: 'ediscoveryPremiumGb', scope: 'both', product: 'Microsoft Purview Data Compliance', meter: 'eDiscovery Premium GB', kind: 'days', unit: 'GB-days', g: 'Security', flat: true, what: 'eDiscovery Premium storage', fmt: v => `${fmtN(v)} GB in eDiscovery Premium`, ask: 'eDiscovery Premium for data outside Microsoft 365: how many GB of case data are kept? Billed per GB per day. Otherwise 0.' },
  { k: 'ediscoveryGraphExportGb', scope: 'both', product: 'Microsoft Purview Data Compliance', meter: 'eDiscovery Graph API Standard Export', kind: 'once', unit: 'GB', g: 'Security', what: 'eDiscovery Graph API export', fmt: v => `${fmtN(v)} GB exported through the eDiscovery Graph API`, ask: 'If they export eDiscovery data through the Graph API: how many GB a month? The first 50 GB are free. Otherwise 0.' },
  { k: 'retentionGb', scope: 'both', product: 'Microsoft Purview Data Compliance', meter: 'Retention GB', kind: 'days', unit: 'GB-days', g: 'Security', what: 'Retention (meter not yet described on the pricing page)', fmt: v => `${fmtN(v)} GB under retention`, ask: 'Only if they know they are billed for retained data: how many GB are held under retention? Billed per GB per day; Microsoft has not yet documented this meter. Otherwise 0.' },
  { k: 'lifecycleManagementPremiumMessages', scope: 'both', product: 'Microsoft Purview Data Compliance', meter: 'Data Lifecycle Management Premium Asset', kind: 'days', unit: 'message-days', g: 'Security', what: 'Data Lifecycle Management Premium', fmt: v => `${fmtN(v)} text messages under lifecycle management`, ask: 'Premium data lifecycle management outside Microsoft 365: how many text messages are managed by a policy? Each generative AI prompt and each response counts separately. Billed per 1,000 messages per day. Otherwise 0.', ...INT }
];

const fields = {
  model: { def: 'unified', enum: ['unified', 'classic'], ask: 'Is this a classic Azure Purview account that pays for a Data Map (capacity units) and scans, or the current Microsoft Purview pay-as-you-go model with the Unified Catalog? Current/new customers -> unified (default); an existing account billed for Data Map capacity -> classic. Classic charges do not apply once a customer uses the current billing model.' },
  dataMapCapacityUnits: { def: 0, min: 0, ask: 'Classic model only: how many Data Map capacity units? One unit covers 25 operations a second and 10 GB of metadata; the map starts at 1 and scales automatically up to 10. Use 0 for the current pay-as-you-go model (no Data Map charge) or if they only need security or compliance features.' },
  devopsPolicies: { def: 0, ...INT, ask: CLASSIC_MSG + 'How many DevOps policies (access policies for data sources) are active? Billed per policy per hour.' },
  hours: { def: 730, ask: 'Classic only: hours a month the Data Map and DevOps policies exist (730 = all month).' },
  days: { def: DAYS, min: 0, max: 31, ask: 'Days a month the per-day items (governed assets, stored GB, managed messages) are held (about 30.4 = all month).' }
};
for (const d of DIMS) fields[d.k] = Object.assign({ def: 0, ask: d.ask }, d.int ? { int: true, min: 0 } : { min: 0 });

const CLASSIC_KEYS = ['dataMapCapacityUnits', 'devopsPolicies', ...DIMS.filter(d => d.scope === 'classic').map(d => d.k)];
const UNIFIED_KEYS = DIMS.filter(d => d.scope === 'unified').map(d => d.k);

module.exports = {
  type: 'purview',
  label: 'Microsoft Purview',
  family: 'security',
  calculator: ['purview'],
  keywords: ['purview', 'data governance', 'data catalog', 'data map', 'data lineage', 'data classification', 'compliance', 'ediscovery', 'data security', 'data quality'],
  fields,
  context: [],
  examples: [
    { type: 'purview', dataMapCapacityUnits: 0, catalogAssets: 5000, dgpuBasic: 20 },
    { type: 'purview', model: 'classic', dataMapCapacityUnits: 3, hours: 730, scanVcoreHours: 400, resourceSetVcoreHours: 20, insightsGenerationVcoreHours: 10, insightsReportCalls: 5000, devopsPolicies: 4 },
    {
      type: 'purview', model: 'unified', dataMapCapacityUnits: 0, days: 30, advancedResourceSetVcoreHours: 30, catalogAssets: 20000, dgpuBasic: 50, dgpuStandard: 20, dgpuAdvanced: 2, classificationAssets: 250000,
      securityAssets: 5000, dataSecurityProcessingUnits: 4, inTransitProtectionRequests: 100000, ocrTransactions: 10000,
      investigationComputeHours: 40, investigationGb: 200, auditRecords: 500000, communicationComplianceStandardRecords: 100000,
      communicationCompliancePremiumRecords: 50000, ediscoveryPremiumGb: 300, ediscoveryGraphExportGb: 120, retentionGb: 1000,
      lifecycleManagementPremiumMessages: 200000
    }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    const parts = [];
    if (n(c.dataMapCapacityUnits)) parts.push(`Data Map of ${fmtN(c.dataMapCapacityUnits)} capacity unit(s) running ${hrs === HOURS ? 'all month' : fmtN(hrs) + ' hours a month'}`);
    if (n(c.devopsPolicies)) parts.push(`${fmtN(c.devopsPolicies)} DevOps policies for ${fmtN(hrs)} hours`);
    for (const d of DIMS) if (n(c[d.k])) parts.push(d.fmt(n(c[d.k])));
    if (c.days != null && DIMS.some(d => d.kind === 'days' && n(c[d.k]))) parts.push(`per-day items held ${fmtN(c.days)} days`);
    if (!parts.length) parts.push('nothing selected');
    return `Microsoft Purview (${c.model === 'classic' ? 'classic account' : 'current pay-as-you-go model'}): ${parts.join(', ')}`;
  },
  price: async (c, ctx) => {
    const model = (c.model || 'unified').toLowerCase();
    if (!['unified', 'classic'].includes(model)) throw new PricingError('model must be "unified" or "classic".');
    const hours = c.hours ?? HOURS, days = c.days ?? DAYS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (days < 0 || days > 31) throw new PricingError('days must be between 0 and 31.');
    for (const k of ['dataMapCapacityUnits', 'devopsPolicies', ...DIMS.map(d => d.k)]) if (n(c[k]) < 0) throw new PricingError(`${k} must not be negative.`);
    const cu = n(c.dataMapCapacityUnits);
    if (model === 'classic' && cu < 1) throw new PricingError('A classic Purview account always has a Data Map of at least 1 capacity unit; set dataMapCapacityUnits to 1 or more.');
    if (cu > 0 && cu < 1) throw new PricingError('A Purview Data Map has a minimum of 1 capacity unit; use 0 for no Data Map.');
    if (model === 'unified') {
      const bad = CLASSIC_KEYS.filter(k => n(c[k]) > 0);
      if (bad.length) throw new PricingError(`${bad.join(', ')} apply only to a classic Purview account (model "classic"). Data Map and scan charges do not apply to customers on the current billing model.`);
    } else {
      const bad = UNIFIED_KEYS.filter(k => n(c[k]) > 0);
      if (bad.length) throw new PricingError(`${bad.join(', ')} apply only to the current pay-as-you-go model (model "unified"); using them with Data Map and scan charges would double count.`);
    }
    const rs = await rows(`(serviceName eq 'Azure Purview' or serviceName eq 'Microsoft Purview') and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Microsoft Purview is not priced in ${ctx.region}.`);
    const lines = [];
    const need = (pred, what) => {
      const m = rs.filter(pred);
      if (!m.length) throw new PricingError(`${what} is not offered in ${ctx.region}; try another region such as eastus2 or westeurope.`);
      return single(m, what);
    };
    if (cu) {
      const m = need(r => r.productName === 'Azure Purview Data Map' && r.meterName === 'Standard Capacity Unit', 'The Purview Data Map');
      lines.push(meterLine('Analytics', 'Azure Purview', `Data Map: ${fmtN(cu)} capacity unit(s) x ${fmtN(hours)} hours`, m, cu * hours, ctx, { unit: 'capacity unit-hours' }));
    }
    if (n(c.devopsPolicies)) {
      const gr = ctx.region.startsWith('usgov') ? 'US Gov' : 'Global';
      const dm = (await rows(`serviceName eq 'Azure Purview' and armRegionName eq '${gr}' and priceType eq 'Consumption'`, ctx)).filter(r => r.productName === 'Azure Purview Data Policy' && r.meterName === 'Policy');
      if (!dm.length) throw new PricingError(`DevOps policies are not priced for ${ctx.region}.`);
      lines.push(meterLine('Analytics', 'Azure Purview', `DevOps policies: ${fmtN(c.devopsPolicies)} x ${fmtN(hours)} hours`, single(dm, 'Purview DevOps policies'), n(c.devopsPolicies) * hours, ctx, { unit: 'policy-hours' }));
    }
    for (const d of DIMS) {
      const v = n(c[d.k]);
      if (!v) continue;
      let m = need(r => r.productName === d.product && r.meterName === d.meter, `Purview ${d.what}`);
      if (d.flat) { const top = m.reduce((a, b) => (b.retailPrice > a.retailPrice ? b : a)); m = [Object.assign({}, top, { tierMinimumUnits: 0 })]; }
      const qty = d.kind === 'days' ? v * days : v;
      lines.push(meterLine(d.g, m[0].serviceName, `${d.what}: ${d.fmt(v)}${d.kind === 'days' ? ` for ${fmtN(Math.round(days * 100) / 100)} days` : ''}`, m, qty, ctx, { unit: d.unit }));
    }
    if (!lines.length) throw new PricingError('Select at least one Purview quantity (for the classic model a Data Map capacity unit count).');
    const notes = [];
    if (cu) notes.push('The Data Map is billed hourly for the capacity units needed (25 operations a second and 10 GB of metadata each, minimum 1, maximum 10 by default). The estimate assumes the average you gave. Classic Data Map and scan charges stop applying once a customer moves to the current billing model.');
    if (n(c.scanVcoreHours)) notes.push('Scans of on-premises SQL Server (self-hosted runtime) and Power BI online have a zero rate for a limited time and are not listed; other SQL Server scans are billed.');
    if (DIMS.some(d => d.kind === 'days' && n(c[d.k]))) notes.push('Per-day meters are billed for every day the amount is held; the estimate assumes the amount you gave for the number of days you gave.');
    if (n(c.retentionGb)) notes.push('The Retention meter appears in the Retail Prices API but is not yet described on the Azure pricing page or calculator.');
    if (n(c.ediscoveryPremiumGb)) notes.push('eDiscovery Premium is priced at the published flat per-GB-day rate.');
    return { lines, notes, facts: { model, dataMapCapacityUnits: cu, scanVcoreHours: n(c.scanVcoreHours), governedAssets: n(c.catalogAssets), insightsGenerationVcoreHours: n(c.insightsGenerationVcoreHours), hours } };
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Storage and compute of the data sources being scanned, and private endpoints or self-hosted integration runtime machines, are billed separately']
};

