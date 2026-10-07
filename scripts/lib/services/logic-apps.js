'use strict';
// Azure Logic Apps: Consumption (pay per action), Standard (workflow service plan or App Service v3 plan),
// Hybrid (customer-run Kubernetes, billed per vCPU), the legacy Integration Service Environment (ISE),
// plus Integration Accounts and Consumption agent-loop tokens.
// Meters: serviceName 'Logic Apps', 'Logic Apps Integration Account', 'Logic Apps Integration Service Environment*',
// and 'Azure App Service' for the App Service v3 plans.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS, DAYS } = require('../kit');

const n = v => Number(v || 0);
const hrs = c => c.hours ?? HOURS;
// Workflow service plans (WS1-WS3) are billed per vCPU-hour and per GiB-hour of memory.
const WS = { ws1: { vcpu: 1, gib: 3.5 }, ws2: { vcpu: 2, gib: 7 }, ws3: { vcpu: 4, gib: 14 } };
const APP = { p0v3: 'P0v3', p1v3: 'P1 v3', p1mv3: 'P1mv3', p2v3: 'P2 v3', p2mv3: 'P2mv3', p3v3: 'P3 v3' };
const ISO = { i1v2: 'I1 v2', i2v2: 'I2 v2', i3v2: 'I3 v2', i4v2: 'I4 v2', i5v2: 'I5 v2', i6v2: 'I6 v2', i1mv2: 'I1mv2', i2mv2: 'I2mv2', i3mv2: 'I3mv2', i4mv2: 'I4mv2', i5mv2: 'I5mv2' };
const PLAN_LABEL = { i1v2: 'I1v2', i2v2: 'I2v2', i3v2: 'I3v2', i4v2: 'I4v2', i5v2: 'I5v2', i6v2: 'I6v2', i1mv2: 'I1mv2', i2mv2: 'I2mv2', i3mv2: 'I3mv2', i4mv2: 'I4mv2', i5mv2: 'I5mv2',  ws1: 'WS1 (1 vCPU, 3.5 GiB)', ws2: 'WS2 (2 vCPU, 7 GiB)', ws3: 'WS3 (4 vCPU, 14 GiB)', p0v3: 'P0v3', p1v3: 'P1v3', p1mv3: 'P1mv3', p2v3: 'P2v3', p2mv3: 'P2mv3', p3v3: 'P3v3' };

module.exports = {
  type: 'logic-apps',
  label: 'Azure Logic Apps',
  family: 'integration',
  calculator: ['logic-apps'],
  keywords: ['logic apps', 'workflow', 'automation', 'connectors', 'integration', 'low code', 'b2b', 'edi', 'orchestration'],
  fields: {
    plan: { req: true, enum: ['consumption', 'standard', 'hybrid', 'ise'], ask: 'Is it light or spiky automation you want to pay for per run (consumption)? Or busy, always-on workflows that need networking/VNet integration and predictable cost (standard)? Run on your own Kubernetes (hybrid)? Or the Integration Service Environment (ise, retired on 31 August 2024, so only for existing environments)? If unknown, suggest consumption and record it as an assumption.' },
    actionsPerDay: { def: 0, ask: 'Consumption only: how many built-in actions run per day in total (HTTP, conditions, loops, data operations; every step that runs counts, including each loop iteration)? The first 4,000 actions a month are free. If unknown, suggest 1,000 and record it as an assumption.' },
    standardConnectorCallsPerDay: { def: 0, ask: 'Consumption or standard: how many calls per day go through standard managed connectors (for example Office 365, SharePoint, Azure Blob, Teams)?' },
    enterpriseConnectorCallsPerDay: { def: 0, ask: 'Consumption or standard: how many calls per day go through enterprise connectors (for example SAP, IBM MQ, Oracle, BizTalk-style connectors)?' },
    dataRetentionGb: { def: 0, ask: 'Consumption only: how many GB of run history and inputs/outputs do you keep (log retention)? If unknown, leave 0. On Standard, run history is stored in your own storage account instead.' },
    agentInputTokens: { def: 0, ask: 'Consumption only, if workflows use agent loops: how many input (prompt) tokens a month? 1 million tokens is roughly 750,000 words.' },
    agentOutputTokens: { def: 0, ask: 'Consumption only, if workflows use agent loops: how many output (response) tokens a month?' },
    hostingPlan: { def: 'ws1', enum: ['ws1', 'ws2', 'ws3', 'p0v3', 'p1v3', 'p1mv3', 'p2v3', 'p2mv3', 'p3v3', ...Object.keys(ISO)], ask: 'Standard only: how big should each instance be? Small -> ws1 (1 vCPU, 3.5 GiB); medium -> ws2 (2 vCPU, 7 GiB); large -> ws3 (4 vCPU, 14 GiB). Or an App Service v3 plan if they already have one: p0v3 (1 vCPU, 4 GiB), p1v3 (2/8), p1mv3 (2/16), p2v3 (4/16), p2mv3 (4/32), p3v3 (8/32). Need a fully isolated, private environment (App Service Environment v3)? Use the Isolated v2 sizes i1v2 to i6v2 (memory-optimised i1mv2 to i5mv2).' },
    instances: { def: 1, int: true, min: 1, ask: 'Standard only: how many instances of the plan (2 or more for redundancy)?' },
    os: { def: 'windows', enum: ['windows', 'linux'], ask: 'Standard on an App Service v3 or Isolated v2 plan only: Windows or Linux?' },
    hybridVcpus: { def: 0, ask: 'Hybrid only: how many vCPUs does your Kubernetes environment give to Logic Apps?' },
    iseTier: { def: 'developer', enum: ['developer', 'premium'], ask: 'Integration Service Environment only: developer (non-production) or premium (production)?' },
    iseScaleUnits: { def: 0, int: true, ask: 'Premium Integration Service Environment only: how many extra scale units beyond the one base unit?' },
    basicIntegrationAccounts: { def: 0, int: true, ask: 'B2B/EDI only: how many Basic integration accounts (small partner counts, up to 2 trading partners)?' },
    standardIntegrationAccounts: { def: 0, int: true, ask: 'B2B/EDI only: how many Standard integration accounts (up to 1,000 trading partners)?' },
    premiumIntegrationAccounts: { def: 0, int: true, ask: 'B2B/EDI only: how many Premium integration accounts (unlimited trading partners)?' },
    hours: { def: 730 }
  },
  context: ['production'],
  examples: [
    { type: 'logic-apps', plan: 'consumption', actionsPerDay: 20000, standardConnectorCallsPerDay: 2000 },
    { type: 'logic-apps', plan: 'consumption', actionsPerDay: 100000, standardConnectorCallsPerDay: 10000, enterpriseConnectorCallsPerDay: 500, dataRetentionGb: 50, agentInputTokens: 20000000, agentOutputTokens: 5000000, basicIntegrationAccounts: 1, standardIntegrationAccounts: 1, premiumIntegrationAccounts: 1 },
    { type: 'logic-apps', plan: 'standard', hostingPlan: 'ws1', instances: 2, standardConnectorCallsPerDay: 5000, enterpriseConnectorCallsPerDay: 200 },
    { type: 'logic-apps', plan: 'standard', hostingPlan: 'p1v3', os: 'linux', instances: 2 },
    { type: 'logic-apps', plan: 'hybrid', hybridVcpus: 8 },
    { type: 'logic-apps', plan: 'ise', iseTier: 'premium', iseScaleUnits: 2 },
    { type: 'logic-apps', plan: 'ise', iseTier: 'developer' }
  ],
  readback: c => {
    const plan = c.plan || 'consumption';
    const hours = hrs(c) < HOURS ? `${fmtN(hrs(c))} hours a month` : 'running all month';
    const parts = [];
    if (plan === 'consumption') {
      parts.push(`${fmtN(n(c.actionsPerDay))} built-in actions a day`);
      if (n(c.dataRetentionGb)) parts.push(`${fmtN(c.dataRetentionGb)} GB of run history kept`);
      if (n(c.agentInputTokens)) parts.push(`${fmtN(c.agentInputTokens)} agent input tokens a month`);
      if (n(c.agentOutputTokens)) parts.push(`${fmtN(c.agentOutputTokens)} agent output tokens a month`);
    } else if (plan === 'standard') {
      const hp = c.hostingPlan || 'ws1';
      parts.push(`${fmtN(n(c.instances) || 1)} x ${PLAN_LABEL[hp] || hp} instance(s)${APP[hp] ? ` on ${c.os || 'windows'}` : ''}, ${hours}`);
    } else if (plan === 'hybrid') parts.push(`${fmtN(n(c.hybridVcpus))} vCPUs of your own Kubernetes, ${hours}`);
    else if (plan === 'ise') parts.push(`${c.iseTier || 'developer'} environment${(c.iseTier || 'developer') === 'premium' ? ` with ${fmtN(n(c.iseScaleUnits))} extra scale unit(s)` : ''}, ${hours}`);
    if (plan === 'consumption' || plan === 'standard') {
      if (n(c.standardConnectorCallsPerDay)) parts.push(`${fmtN(c.standardConnectorCallsPerDay)} standard connector calls a day`);
      if (n(c.enterpriseConnectorCallsPerDay)) parts.push(`${fmtN(c.enterpriseConnectorCallsPerDay)} enterprise connector calls a day`);
    }
    if (n(c.basicIntegrationAccounts)) parts.push(`${fmtN(c.basicIntegrationAccounts)} basic integration account(s)`);
    if (n(c.standardIntegrationAccounts)) parts.push(`${fmtN(c.standardIntegrationAccounts)} standard integration account(s)`);
    if (n(c.premiumIntegrationAccounts)) parts.push(`${fmtN(c.premiumIntegrationAccounts)} premium integration account(s)`);
    return `Logic Apps ${plan}: ${parts.join(', ')}`;
  },
  price: async (c, ctx) => {
    const plan = (c.plan || 'consumption').toLowerCase();
    const hours = hrs(c);
    const G = 'Integration', S = 'Logic Apps', lines = [], notes = [];
    const facts = { plan, actionsPerDay: n(c.actionsPerDay), instances: c.instances ?? 1 };
    const la = await rows(`serviceName eq 'Logic Apps' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const pick = (rs, name, what, uom) => single(rs.filter(r => r.meterName === name && (!uom || r.unitOfMeasure === uom)), `Logic Apps ${what}`);
    if (!['consumption', 'standard', 'hybrid', 'ise'].includes(plan)) throw new PricingError(`Unknown Logic Apps plan "${plan}". Use consumption, standard, hybrid or ise.`);
    const perMonth = v => n(v) * DAYS;
    const connectors = prefix => {
      if (n(c.standardConnectorCallsPerDay)) lines.push(meterLine(G, S, `Standard connector calls: ${fmtN(c.standardConnectorCallsPerDay)}/day (about ${fmtN(Math.round(perMonth(c.standardConnectorCallsPerDay)))}/month)`, pick(la, `${prefix} Standard Connector Actions`, 'standard connector actions'), perMonth(c.standardConnectorCallsPerDay), ctx));
      if (n(c.enterpriseConnectorCallsPerDay)) lines.push(meterLine(G, S, `Enterprise connector calls: ${fmtN(c.enterpriseConnectorCallsPerDay)}/day (about ${fmtN(Math.round(perMonth(c.enterpriseConnectorCallsPerDay)))}/month)`, pick(la, `${prefix} Enterprise Connector Actions`, 'enterprise connector actions'), perMonth(c.enterpriseConnectorCallsPerDay), ctx));
    };
    if (plan === 'consumption') {
      if (n(c.actionsPerDay) || !(n(c.standardConnectorCallsPerDay) || n(c.enterpriseConnectorCallsPerDay) || n(c.dataRetentionGb) || n(c.agentInputTokens) || n(c.agentOutputTokens) || n(c.basicIntegrationAccounts) || n(c.standardIntegrationAccounts) || n(c.premiumIntegrationAccounts))) lines.push(meterLine(G, S, `Consumption built-in actions: ${fmtN(n(c.actionsPerDay))}/day (about ${fmtN(Math.round(perMonth(c.actionsPerDay)))}/month, first 4,000 free)`, pick(la, 'Consumption Built-in Actions', 'built-in actions'), perMonth(c.actionsPerDay), ctx));
      connectors('Consumption');
      if (n(c.dataRetentionGb)) lines.push(meterLine(G, S, `Run history retention, ${fmtN(c.dataRetentionGb)} GB/month`, pick(la, 'Consumption Data Retention', 'data retention'), n(c.dataRetentionGb), ctx));
      if (n(c.agentInputTokens)) lines.push(meterLine(G, S, `Agent loop input tokens, ${fmtN(c.agentInputTokens)}/month`, pick(la, 'Consumption Agent Loop Input Token', 'agent input tokens'), n(c.agentInputTokens), ctx));
      if (n(c.agentOutputTokens)) lines.push(meterLine(G, S, `Agent loop output tokens, ${fmtN(c.agentOutputTokens)}/month`, pick(la, 'Consumption Agent Loop Output Token', 'agent output tokens'), n(c.agentOutputTokens), ctx));
      notes.push('Consumption bills every action that runs (including each loop iteration and failed retries); the first 4,000 built-in actions a month are free. Per-day quantities are multiplied by 30.42 days a month.');
    } else {
      if (n(c.agentInputTokens) || n(c.agentOutputTokens)) throw new PricingError('Agent-loop tokens are a Consumption-plan charge only.');
      if (n(c.dataRetentionGb)) notes.push('Run-history retention is not a Logic Apps meter on this plan: the history is stored in your own Azure Storage account and billed there, so it is not added here.');
      if (n(c.actionsPerDay)) notes.push('Built-in actions are not billed on this plan (they are covered by the plan price).');
    }
    if (plan === 'standard') {
      const hp = (c.hostingPlan || 'ws1').toLowerCase();
      const inst = c.instances ?? 1;
      if (!Number.isInteger(inst) || inst < 1) throw new PricingError('instances must be a whole number of at least 1.');
      if (WS[hp]) {
        const v = WS[hp];
        lines.push(meterLine(G, S, `Standard ${PLAN_LABEL[hp]}: ${fmtN(inst)} instance(s) x ${v.vcpu} vCPU x ${fmtN(hours)} hours`, pick(la, 'Standard vCPU Duration', 'Standard vCPU'), inst * v.vcpu * hours, ctx, { unit: 'vCPU hours' }));
        lines.push(meterLine(G, S, `Standard ${PLAN_LABEL[hp]}: ${fmtN(inst)} instance(s) x ${v.gib} GiB x ${fmtN(hours)} hours`, pick(la, 'Standard Memory Duration', 'Standard memory'), inst * v.gib * hours, ctx, { unit: 'GiB hours' }));
        notes.push('A Standard workflow service plan is billed per vCPU-hour and per GiB-hour of memory for every hour it exists, whether or not workflows run. Built-in connectors are included.');
      } else if (APP[hp]) {
        const os = (c.os || 'windows').toLowerCase();
        const aps = await rows(`serviceName eq 'Azure App Service' and ${regionFilter(ctx)} and priceType eq 'Consumption' and skuName eq '${APP[hp]}'`, ctx);
        const prod = os === 'linux' ? 'Azure App Service Premium v3 Plan - Linux' : 'Azure App Service Premium v3 Plan';
        const row = single(aps.filter(r => r.productName === prod && r.meterName === `${APP[hp]} App`), `App Service ${APP[hp]} ${os} plan`);
        lines.push(meterLine('Web', 'Azure App Service', `Logic Apps Standard on App Service ${PLAN_LABEL[hp]} (${os}): ${fmtN(inst)} instance(s) x ${fmtN(hours)} hours`, row, inst * hours, ctx, { unit: 'hours' }));
        notes.push('On an App Service v3 plan, Logic Apps Standard is billed at the App Service plan price per instance-hour. Built-in connectors are included.');
      } else if (ISO[hp]) {
        const os = (c.os || 'windows').toLowerCase();
        const aps = await rows(`serviceName eq 'Azure App Service' and ${regionFilter(ctx)} and priceType eq 'Consumption' and skuName eq '${ISO[hp]}'`, ctx);
        const prod = os === 'linux' ? 'Azure App Service Isolated v2 Plan - Linux' : 'Azure App Service Isolated v2 Plan';
        const rs = aps.filter(r => r.productName === prod && r.meterName === `${ISO[hp]} App`);
        if (!rs.length) throw new PricingError(`Isolated v2 ${PLAN_LABEL[hp]} (${os}) is not priced in ${ctx.region}; App Service Environment v3 is not offered in every region or size.`);
        lines.push(meterLine('Web', 'Azure App Service', `Logic Apps Standard on Isolated v2 ${PLAN_LABEL[hp]} (${os}): ${fmtN(inst)} instance(s) x ${fmtN(hours)} hours`, single(rs, `App Service ${ISO[hp]} ${os} plan`), inst * hours, ctx, { unit: 'hours' }));
        notes.push('Isolated v2 runs Logic Apps Standard inside an App Service Environment v3 (Learn: the App Service plan is supported only with ASE v3). Plan prices here are per instance-hour; the Isolated v2 plan size is the compute charge.');
      } else throw new PricingError(`Unknown hostingPlan "${hp}".`);
      connectors('Consumption');
      facts.hostingPlan = hp;
    }
    if (plan === 'hybrid') {
      if (n(c.hybridVcpus) <= 0) throw new PricingError('Hybrid plan needs hybridVcpus (the number of vCPUs in your Kubernetes environment).');
      if (!la.some(r => r.meterName === 'Hybrid vCPU Duration')) throw new PricingError(`Logic Apps hybrid is not offered in ${ctx.region}.`);
      lines.push(meterLine(G, S, `Hybrid: ${fmtN(c.hybridVcpus)} vCPUs x ${fmtN(hours)} hours`, pick(la, 'Hybrid vCPU Duration', 'Hybrid vCPU'), n(c.hybridVcpus) * hours, ctx, { unit: 'vCPU hours' }));
      connectors('Consumption');
      notes.push('Hybrid bills per vCPU-hour for the Kubernetes capacity given to Logic Apps; the cluster itself is yours to run and pay for.');
      facts.hybridVcpus = n(c.hybridVcpus);
    }
    if (plan === 'ise') {
      const tier = (c.iseTier || 'developer').toLowerCase();
      if (n(c.standardConnectorCallsPerDay) || n(c.enterpriseConnectorCallsPerDay)) notes.push('Connector calls are included in the Integration Service Environment price.');
      if (!la.some(r => /^Logic Apps Integration Service Environment/.test(r.productName))) throw new PricingError(`The Logic Apps Integration Service Environment is not offered in ${ctx.region}; it was retired on 31 August 2024.`);
      if (tier === 'developer') {
        const rs = la.filter(r => r.productName === 'Logic Apps Integration Service Environment - Developer');
        lines.push(meterLine(G, 'Logic Apps Integration Service Environment', `Integration Service Environment Developer: 1 base unit x ${fmtN(hours)} hours`, pick(rs, 'Base Unit', 'ISE Developer base unit'), hours, ctx, { unit: 'hours' }));
      } else if (tier === 'premium') {
        const rs = la.filter(r => r.productName === 'Logic Apps Integration Service Environment');
        lines.push(meterLine(G, 'Logic Apps Integration Service Environment', `Integration Service Environment Premium: 1 base unit x ${fmtN(hours)} hours`, pick(rs, 'Base Unit', 'ISE base unit'), hours, ctx, { unit: 'hours' }));
        if (n(c.iseScaleUnits)) lines.push(meterLine(G, 'Logic Apps Integration Service Environment', `Premium scale units: ${fmtN(c.iseScaleUnits)} x ${fmtN(hours)} hours`, pick(rs, 'Scale Unit', 'ISE scale unit'), n(c.iseScaleUnits) * hours, ctx, { unit: 'hours' }));
      } else throw new PricingError('iseTier must be developer or premium.');
      notes.push('The Integration Service Environment was retired on 31 August 2024; this prices the legacy meters for an existing environment. New workloads should use Logic Apps Standard.');
      facts.iseTier = tier;
    }
    const accts = [['basicIntegrationAccounts', 'Basic', 'Basic Unit'], ['standardIntegrationAccounts', 'Standard', 'Standard Unit'], ['premiumIntegrationAccounts', 'Premium', 'Premium Unit']].filter(a => n(c[a[0]]));
    if (accts.length) {
      const ia = la.filter(r => r.productName === 'Logic Apps Integration Account');
      for (const [k, label, meter] of accts) lines.push(meterLine(G, 'Logic Apps Integration Account', `${label} integration account x ${fmtN(c[k])}${hours < HOURS ? `, ${fmtN(hours)} hours` : ''}`, pick(ia, meter, `${label} integration account`), n(c[k]) * hours / HOURS, ctx, { unit: 'accounts / month' }));
      notes.push('Integration accounts hold B2B/EDI partners, agreements and maps, and are billed per account per month (prorated by hours running) on any plan. Trading partners: Basic 2, Standard 1,000, Premium unlimited.');
    }
    notes.push('Not priced here: Connector Namespace (standalone connectors, its own Connectors meters) and Logic Apps Automation (preview). Standard and Hybrid managed-connector calls use the Consumption connector rate.');
    facts.integrationAccounts = n(c.basicIntegrationAccounts) + n(c.standardIntegrationAccounts) + n(c.premiumIntegrationAccounts);
    return { lines, notes, facts };
  }
};
