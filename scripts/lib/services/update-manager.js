'use strict';
// Azure Update Manager (calculator slug update-management-center). Free for Azure VMs and Arc-enabled
// Azure Local VMs. Azure Arc-enabled servers are charged per server per month, daily prorated
// (assuming 31 days of connected usage), unless covered by Defender for Servers Plan 2, Extended
// Security Updates, Windows Server Software Assurance / pay-as-you-go enabled by Azure Arc.
// Meters: serviceName 'Azure Update Manager', regionless ('Global'; 'US Gov' in Azure Government).
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'update-manager',
  label: 'Azure Update Manager',
  family: 'management',
  calculator: ['update-management-center'],
  keywords: ['update manager', 'patching', 'patch management', 'windows updates', 'arc servers', 'update management', 'os updates'],
  fields: {
    arcServers: { req: true, int: true, min: 0, ask: 'How many servers OUTSIDE Azure (on-premises or other clouds, connected with Azure Arc) do you want to patch and keep up to date? Azure virtual machines are free, so do not count them. Use 0 if all are in Azure.' },
    benefitServers: { def: 0, int: true, min: 0, ask: 'Of those Arc-connected servers, how many are already free? Free ones are: servers covered by Microsoft Defender for Servers Plan 2 or Extended Security Updates; Windows Server machines with Software Assurance or pay-as-you-go through Azure Arc (Linux servers cannot use this); and Arc servers that already used the old Automation Update Management as of 1 September 2023. Do not count Azure Local VMs created through an Arc resource bridge: they are free, so leave them out of the server count. If unknown, suggest 0 and record it as an assumption.' },
    azureVMs: { def: 0, int: true, min: 0, ask: 'How many Azure virtual machines will also be patched? They are free; the count is only recorded.' },
    days: { def: 31, int: true, min: 0, max: 31, ask: 'On how many days of the month are the Arc-connected servers connected and managed (checked or patched, or on a schedule)? Billing is per day out of 31. If they are managed all month, use 31.' }
  },
  context: ['production'],
  readback: c => {
    const parts = [`${fmtN(n(c.arcServers))} Azure Arc-enabled server(s)`];
    if (n(c.benefitServers)) parts.push(`${fmtN(c.benefitServers)} of them covered by a free benefit`);
    if (n(c.arcServers)) parts.push(`managed ${fmtN(n(c.days ?? 31))} days a month`);
    if (n(c.azureVMs)) parts.push(`${fmtN(c.azureVMs)} Azure VM(s) (free)`);
    return `Azure Update Manager: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('update-manager-extras') ? [] : [
    'The Azure Arc-enabled servers themselves and any Log Analytics ingestion for update reports and workbooks',
    'Other services bundled into Essential Machine Management for Arc servers, which Microsoft prices separately'
  ],
  examples: [
    { type: 'update-manager', arcServers: 50 },
    { type: 'update-manager', arcServers: 120, benefitServers: 30, days: 20, azureVMs: 200 }
  ],
  price: async (c, ctx) => {
    const arc = n(c.arcServers), benefit = n(c.benefitServers), days = n(c.days ?? 31);
    if (benefit > arc) throw new PricingError(`benefitServers (${benefit}) cannot be more than arcServers (${arc}).`);
    if (days < 0 || days > 31) throw new PricingError('days must be between 0 and 31.');
    const scope = /^usgov/i.test(ctx.region || '') ? 'US Gov' : 'Global';
    const rs = await rows(`serviceName eq 'Azure Update Manager' and armRegionName eq '${scope}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Update Manager is not priced for ${ctx.region}.`);
    const basic = single(rs.filter(r => r.meterName === 'Basic Server'), 'Update Manager Basic Server');
    const charged = arc - benefit, serverMonths = charged * days / 31;
    const lines = [];
    if (charged > 0 && days > 0) lines.push(meterLine('Management', 'Azure Update Manager', `Update Manager for Arc-enabled servers: ${fmtN(charged)} charged server(s) x ${fmtN(days)} of 31 days`, basic, serverMonths, ctx, { unit: 'server-months' }));
    const notes = [
      'Update Manager is free for Azure VMs. For Azure Arc-enabled servers it is charged per server per month, at a daily prorated value for the days the server is connected and managed (31 days = a full month).',
      'Not charged: Azure VMs; Arc-enabled Azure Local VMs created through an Arc resource bridge; Arc servers with Extended Security Updates; servers in a subscription with Defender for Servers Plan 2 (not through a security connector); Windows Server machines (not Linux) with Software Assurance or pay-as-you-go enabled by Azure Arc; and Arc servers that used Automation Update Management as of 1 September 2023.',
      'Microsoft now also lists Update Manager among the Essential Machine Management capabilities for Arc-enabled servers (Learn quotes $9.01 per server per month for servers not otherwise covered); this estimate uses the Update Manager meter in the Retail Prices API, so confirm which one applies.'
    ];
    if (!lines.length) notes.push('Nothing is charged: no Arc-enabled server is left after the free cases (Azure VMs are free).');
    return { lines, notes, facts: { arcServers: arc, benefitServers: benefit, chargedServers: charged, days, azureVMs: n(c.azureVMs) } };
  }
};

