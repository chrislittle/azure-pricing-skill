'use strict';
// Azure OpenAI provisioned throughput (PTU). Meters: serviceName 'Foundry Models', productName 'Azure OpenAI', skuName
// 'Provisioned Managed Global|Data Zone|Regional' (per PTU-hour); reservations: productName 'Azure AI Foundry Provisioned
// Throughput Reservation', terms '1 Month' and '1 Year', priced for the whole term per PTU.
const { rows, single, regionFilter, line, meterInfo, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const SVC = "serviceName eq 'Foundry Models' and priceType eq";
const TYPES = {
  global: { sku: 'Provisioned Managed Global', label: 'Global', min: 15, step: 5 },
  'data-zone': { sku: 'Provisioned Managed Data Zone', label: 'Data Zone', min: 15, step: 5 },
  regional: { sku: 'Provisioned Managed Regional', label: 'Regional', min: 50, step: 50 }
};
// Minimum deployment / scale increment per model: [Global and Data Zone [min, step], Regional [min, step]].
// Source: https://learn.microsoft.com/azure/foundry/openai/how-to/provisioned-throughput-sizing (Deployment parameters and throughput values by model).
const SIZING_URL = 'https://learn.microsoft.com/azure/foundry/openai/how-to/provisioned-throughput-sizing';
const GDZ = [15, 5], R50 = [50, 50], R25 = [25, 25];
const R100 = [100, 100];
// Exact model names from the Learn "Deployment parameters and throughput values by model" tables (Azure OpenAI models only; verified 2026-10-06).
const MODELS = {
  'gpt-image-2': [R100, R100],
  'o1': [GDZ, [25, 50]],
  'o3': [GDZ, R50], 'gpt-4o': [GDZ, R50], 'gpt-4.1': [GDZ, R50],
  'gpt-6.1-sol': [GDZ, R50], 'gpt-6-sol': [GDZ, R50], 'gpt-6-astra': [GDZ, R50],
  'gpt-5.6-luna': [GDZ, R50], 'gpt-5.6-terra': [GDZ, R50], 'gpt-5.6-sol': [GDZ, R50],
  'gpt-5.5': [GDZ, R50], 'gpt-5.4': [GDZ, R50], 'gpt-5.3-codex': [GDZ, R50], 'gpt-5.2': [GDZ, R50], 'gpt-5.2-codex': [GDZ, R50],
  'gpt-5.1': [GDZ, R50], 'gpt-5.1-codex': [GDZ, R50], 'gpt-5': [GDZ, R50],
  'gpt-4o-mini': [GDZ, R25], 'o3-mini': [GDZ, R25], 'o4-mini': [GDZ, R25], 'gpt-4.1-mini': [GDZ, R25], 'gpt-4.1-nano': [GDZ, R25],
  'gpt-5-mini': [GDZ, R25], 'gpt-5.4-mini': [GDZ, R25]
};
function sizing(model) {
  const m = String(model || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (Object.prototype.hasOwnProperty.call(MODELS, m)) return { key: m, size: MODELS[m] };
  return { key: m, unknown: true };
}
const COMMIT = { hourly: null, 'reserved-1-month': { term: '1 Month', months: 1, label: '1-month' }, 'reserved-1-year': { term: '1 Year', months: 12, label: '1-year' } };

module.exports = {
  type: 'openai-provisioned',
  label: 'Azure OpenAI provisioned throughput (PTUs)',
  family: 'ai',
  calculator: ['openai-service'],
  keywords: ['provisioned throughput', 'ptu', 'ptus', 'provisioned throughput units', 'azure openai provisioned', 'global provisioned', 'data zone provisioned', 'regional provisioned', 'ptu reservation', 'foundry provisioned', 'ptu-m', 'dedicated openai capacity'],
  fields: {
    model: { req: true, ask: 'Which model will the deployment serve (for example gpt-5.2, gpt-4.1, gpt-4o, o3, gpt-5-mini, gpt-image-2)? The price per PTU does not depend on the model, but the minimum deployment size and step do.' },
    deployment: { req: true, enum: Object.keys(TYPES), ask: 'Which provisioned deployment type: global (cheapest, traffic may be served in any region), data-zone (stays in the US or EU data zone) or regional (stays in one region)?' },
    ptus: { req: true, int: true, min: 1, ask: 'How many provisioned throughput units (PTUs) will you deploy? Sizes depend on the model: Global and Data Zone start at 15 in steps of 5 (gpt-image-2: 100 in steps of 100); Regional starts at 50 in steps of 50 for most models (25 in steps of 25 for mini and nano models; o1 starts at 25 in steps of 50). If unsure, ask for a PTU sizing from the model, requests per minute and prompt and response sizes.' },
    commitment: { def: 'hourly', enum: Object.keys(COMMIT), ask: 'Will the deployment run steadily for production? Hourly billing is the default and suits short tests; a 1-month or 1-year reservation is cheaper for production.' },
    hours: { def: HOURS, min: 1, max: HOURS, ask: 'For hourly billing only: how many hours a month will the deployment exist? Billing continues until the deployment is deleted, so use 730 for always on.' }
  },
  context: ['production'],
  examples: [
    { type: 'openai-provisioned', model: 'gpt-5.2', deployment: 'global', ptus: 100, commitment: 'hourly' },
    { type: 'openai-provisioned', model: 'gpt-5.2', deployment: 'data-zone', ptus: 50, commitment: 'reserved-1-year' },
    { type: 'openai-provisioned', model: 'gpt-5.2', deployment: 'regional', ptus: 100, commitment: 'reserved-1-month' },
    { type: 'openai-provisioned', model: 'gpt-5.2', deployment: 'regional', ptus: 50, commitment: 'hourly', hours: 200 }
  ],
  readback: c => {
    const t = TYPES[c.deployment] || {}, cm = COMMIT[c.commitment || 'hourly'];
    return `Azure OpenAI ${t.label || c.deployment} provisioned throughput${c.model ? ` for ${c.model}` : ''}, ${fmtN(c.ptus)} PTUs, ${cm ? `${cm.label} reservation` : `hourly billing for ${fmtN(c.hours ?? HOURS)} hours`}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Provisioned throughput covers the model capacity only. Fine-tuned model hosting, networking, and monitoring are not in this estimate.', 'Traffic that spills over to a Standard deployment is billed per token and is not included; price it with the openai type.', 'The legacy Commitment model (pre-August-2024 customers; Provisioned Throughput Units monthly and Available/Overage meters) is not estimated.'],
  price: async (c, ctx) => {
    const t = TYPES[c.deployment];
    if (!t) throw new PricingError(`deployment must be one of ${Object.keys(TYPES).join(', ')}.`);
    const ptus = n(c.ptus), commit = c.commitment || 'hourly';
    if (!(commit in COMMIT)) throw new PricingError(`commitment must be one of ${Object.keys(COMMIT).join(', ')}.`);
    const sz = sizing(c.model);
    if (sz.unknown) throw new PricingError(`Unknown model "${c.model}" for this type. Valid models (Learn PTU sizing table, Azure OpenAI models only): ${Object.keys(MODELS).join(', ')}; dated names such as gpt-4o-mini-2024-07-18 are accepted. Non-OpenAI PTU models (for example gpt-oss, DeepSeek, Llama) are not covered by this type. See ${SIZING_URL}.`);
    const sizeRule = c.deployment === 'regional' ? sz.size[1] : sz.size[0];
    if (!sizeRule) throw new PricingError(`${c.model} is not available as a Regional provisioned deployment (Learn lists Regional as not applicable); use Global or Data Zone (see ${SIZING_URL}).`);
    const [min, step] = sizeRule;
    if (ptus < min || (ptus - min) % step) throw new PricingError(`${c.model || 'This model'} ${t.label} provisioned deployments start at ${min} PTUs and scale in steps of ${step}; ${ptus} is not a valid size (see ${SIZING_URL}).`);
    const hours = n(c.hours ?? HOURS), cm = COMMIT[commit];
    const lines = [], notes = [];
    if (sz.key === 'gpt-5-mini' && c.deployment === 'regional') notes.push('Sources conflict on the GPT-5-mini Regional minimum: Learn lists 25 and the Azure pricing page lists 50. Learn was used; confirm before buying.');
    if (!cm) {
      const rs = await rows(`${SVC} 'Consumption' and ${regionFilter(ctx)} and productName eq 'Azure OpenAI' and skuName eq '${t.sku}'`, ctx);
      if (!rs.length) throw new PricingError(`${t.label} provisioned throughput is not priced in ${ctx.region}.`);
      const m = single(rs, `${t.label} provisioned hourly rate`)[0];
      lines.push(line('AI', 'Azure OpenAI', `${t.label} provisioned, ${fmtN(ptus)} PTUs x ${fmtN(hours)} hours`, ptus * hours, 'PTU-hours', m.retailPrice, m.retailPrice * ptus * hours, meterInfo(m)));
      notes.push('Hourly billing runs until the deployment is deleted; a provisioned deployment cannot be paused, and idle capacity is still billed.');
    } else {
      const rs = await rows(`${SVC} 'Reservation' and ${regionFilter(ctx)} and productName eq 'Azure AI Foundry Provisioned Throughput Reservation' and skuName eq '${t.sku}' and reservationTerm eq '${cm.term}'`, ctx);
      let r = rs[0];
      if (!r && c.deployment === 'global') {
        const any = await rows(`${SVC} 'Reservation' and productName eq 'Azure AI Foundry Provisioned Throughput Reservation' and skuName eq '${t.sku}' and reservationTerm eq '${cm.term}'`, ctx);
        r = any.find(x => x.armRegionName === 'eastus2') || any[0];
        if (r) notes.push(`Global reservations are not region-specific; ${ctx.region} has no listed Global reservation row, so the ${r.armRegionName} price was used.`);
      }
      if (!r) throw new PricingError(`${t.label} provisioned throughput has no ${cm.term} reservation price in ${ctx.region}.`);
      lines.push(line('AI', 'Azure OpenAI', `${t.label} provisioned, ${fmtN(ptus)} PTUs, ${cm.label} reservation`, ptus * cm.months, 'PTU-months', r.retailPrice / cm.months, r.retailPrice * ptus / cm.months, meterInfo(r), { unitLabel: 'per PTU-month' }));
      notes.push('A reservation bills every hour of its term. Reserved PTUs not covered by a deployment are wasted, and PTUs deployed above the reservation are billed at the hourly rate.',
        'The reservation is model-independent but specific to the deployment type: a Global reservation does not cover a Regional deployment.');
    }
    return { lines, notes, facts: { model: c.model, deployment: c.deployment, ptus, commitment: commit, hours: cm ? HOURS : hours } };
  }
};


