'use strict';
// Azure Automation: process automation (runbook job run-time minutes and watcher hours), configuration
// management (Azure nodes free, non-Azure nodes per node) and Update Management (retired, no charge).
// Meters: serviceName 'Automation', regional. The first 500 job minutes, 744 watcher hours and 5
// non-Azure nodes each month are free (zero-priced first bands in the API).
// Usage is aggregated across all Automation accounts in a subscription (the option's ledger shares bands).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'automation',
  label: 'Azure Automation',
  family: 'management',
  calculator: ['automation'],
  keywords: ['automation', 'runbook', 'runbooks', 'scheduled scripts', 'watcher', 'desired state configuration', 'dsc', 'configuration management'],
  fields: {
    jobMinutes: { req: true, ask: 'Roughly how many minutes in total do your runbooks (automated scripts) run each month, across all of them? The first 500 minutes are free. If unknown, suggest 2,000 and record it as an assumption. Use 0 if none.' },
    watchers: { def: 0, int: true, min: 0, ask: 'Only if they use watcher tasks (runbooks that watch for events): how many watchers?' },
    hours: { def: 730, ask: 'For watchers: how many hours a month does each watcher run? All month is 730.' },
    nonAzureNodes: { def: 0, int: true, min: 0, ask: 'How many servers outside Azure (on-premises or other clouds) will use configuration management (change tracking, state configuration)? The first 5 are free.' },
    azureNodes: { def: 0, int: true, min: 0, ask: 'How many Azure virtual machines will use configuration management? These are free; the count is only recorded.' },
    updateManagementNodes: { def: 0, int: true, min: 0, ask: 'Only if they plan to use the old Automation Update Management: how many machines? It is free but was retired on 31 August 2024; Azure Update Manager replaces it.' }
  },
  context: ['production'],
  readback: c => {
    const parts = [`${fmtN(n(c.jobMinutes))} runbook minutes a month`];
    if (n(c.watchers)) parts.push(`${fmtN(c.watchers)} watcher(s) x ${fmtN(c.hours ?? HOURS)} hours`);
    if (n(c.nonAzureNodes)) parts.push(`${fmtN(c.nonAzureNodes)} non-Azure node(s) in configuration management`);
    if (n(c.azureNodes)) parts.push(`${fmtN(c.azureNodes)} Azure node(s) in configuration management (free)`);
    if (n(c.updateManagementNodes)) parts.push(`${fmtN(c.updateManagementNodes)} machine(s) in the retired Update Management (free)`);
    return `Azure Automation: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('automation-logs') ? [] : [
    'Log Analytics data ingestion and retention for runbook logs, change tracking and inventory',
    'The virtual machines or servers that runbooks act on'
  ],
  examples: [
    { type: 'automation', jobMinutes: 2000 },
    { type: 'automation', jobMinutes: 20000, watchers: 3, hours: 730, nonAzureNodes: 12, azureNodes: 20, updateManagementNodes: 30 }
  ],
  price: async (c, ctx) => {
    const rs = await rows(`serviceName eq 'Automation' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Automation is not priced in ${ctx.region}.`);
    const m = (name, what, extra) => single(rs.filter(r => r.meterName === name && (!extra || extra(r))), `Automation ${what}`);
    const G = 'Management', S = 'Automation', lines = [], notes = [];
    const hours = c.hours ?? HOURS, wh = n(c.watchers) * hours;
    // The job-minute meter is named 'Basic Runtime'; 'Free Runtime' belongs to the free tier of accounts.
    lines.push(meterLine(G, S, `Process automation: ${fmtN(n(c.jobMinutes))} job run-time minutes (first 500 free)`, m('Basic Runtime', 'job run time'), n(c.jobMinutes), ctx, { unit: 'minutes' }));
    if (n(c.watchers)) lines.push(meterLine(G, S, `Watcher tasks: ${fmtN(c.watchers)} watcher(s) x ${fmtN(hours)} hours = ${fmtN(wh)} hours (first 744 free)`, m('Watcher', 'watcher'), wh, ctx, { unit: 'hours' }));
    if (n(c.nonAzureNodes)) lines.push(meterLine(G, S, `Configuration management, non-Azure nodes: ${fmtN(c.nonAzureNodes)} (first 5 free)`, m('Non-Azure Node', 'non-Azure node'), n(c.nonAzureNodes), ctx, { unit: 'nodes / month' }));
    // Zero-priced dimensions: when a region has no $0 meter for them, skip the line instead of failing the paid ones.
    const freeLine = (count, name, what, desc) => {
      if (!n(count)) return;
      const mr = rs.filter(r => r.meterName === name);
      if (!mr.length) { notes.push(`${what} has no price entry in ${ctx.region}; it is free, so nothing is added.`); return; }
      lines.push(meterLine(G, S, desc, single(mr, `Automation ${what}`), n(count), ctx, { unit: 'nodes / month' }));
    };
    freeLine(c.azureNodes, 'Azure Node', 'Configuration management for Azure nodes', `Configuration management, Azure nodes: ${fmtN(c.azureNodes)} (free)`);
    freeLine(c.updateManagementNodes, 'Basic Node', 'Update Management', `Update Management (retired): ${fmtN(c.updateManagementNodes)} machine(s), free`);
    notes.push('Free each month: 500 job minutes, 744 watcher hours and 5 non-Azure nodes; usage is added up across all Automation accounts in the subscription. These free units are not given on rate plans with a flat discount or fixed monthly credit.');
    notes.push('Configuration management is billed per node, pro-rated hourly, from when a node is registered until it is unregistered; Azure virtual machines are free.');
    if (n(c.updateManagementNodes)) notes.push('Automation Update Management and the Log Analytics agent it used were retired on 31 August 2024; Azure Update Manager (type update-manager) replaces it.');
    return { lines, notes, facts: { jobMinutes: n(c.jobMinutes), watchers: n(c.watchers), watcherHours: wh, nonAzureNodes: n(c.nonAzureNodes), azureNodes: n(c.azureNodes), configNodes: n(c.nonAzureNodes) + n(c.azureNodes), updateManagementNodes: n(c.updateManagementNodes) } };
  }
};



