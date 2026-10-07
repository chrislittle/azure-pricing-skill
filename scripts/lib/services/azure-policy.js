'use strict';
// Azure Policy: only the parts that are charged. Azure Policy on Azure resources is free.
// Charged: Azure Automanage machine configuration (guest configuration) per Azure Arc-enabled server,
// Azure Policy for Kubernetes per vCPU on Arc-enabled clusters (first 6 vCPUs free), and the Premium
// P1 / P2 per-resource tiers that appear in the Retail Prices API.
// Meters: serviceName 'Azure Policy', regionless ('Global'; 'US Gov' in Azure Government regions).
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'azure-policy',
  label: 'Azure Policy (charged parts only)',
  family: 'management',
  calculator: ['azure-policy'],
  keywords: ['azure policy', 'policy', 'guest configuration', 'machine configuration', 'governance', 'compliance', 'arc servers'],
  fields: {
    guestConfigServers: { req: true, int: true, min: 0, ask: 'How many servers OUTSIDE Azure (on-premises or other clouds, connected with Azure Arc) will have machine-configuration (guest configuration) policies assigned? Azure virtual machines cost nothing, so do not count them. Use 0 if none.' },
    exemptServers: { def: 0, int: true, min: 0, ask: 'Of those servers, how many are already free for this? Free ones are: servers in a subscription with Microsoft Defender for Servers Plan 2; servers already managed by Azure Automation State Configuration or change tracking; servers only assigned the Defender for Cloud security benchmark or Regulatory Compliance initiatives; and Windows Server machines with Software Assurance or pay-as-you-go through Azure Arc. If unknown, suggest 0 and record it as an assumption.' },
    kubernetesVcpus: { def: 0, int: true, min: 0, ask: 'How many vCPUs in total do the Azure Arc-enabled Kubernetes clusters you want to govern with Azure Policy have? Use 0 if none.' },
    kubernetesClusters: { def: 1, int: true, min: 1, ask: 'How many Arc-enabled Kubernetes clusters are those vCPUs spread across? The first 6 vCPUs of each cluster are free.' },
    premiumP1Resources: { def: 0, int: true, min: 0, ask: 'Advanced, only if a Microsoft contact has told them a per-resource Azure Policy Premium (P1) charge applies: how many resources? Most people use 0.' },
    premiumP2Resources: { def: 0, int: true, min: 0, ask: 'Advanced, only if a Microsoft contact has told them a per-resource Azure Policy Premium (P2) charge applies: how many resources? Most people use 0.' },
    hours: { def: 730, ask: 'Servers are billed by the hour, and servers that are offline (disconnected or powered off) for the whole hour are not billed. How many hours a month are the servers connected? If they are on all month, use 730.' }
  },
  context: ['production'],
  readback: c => {
    const parts = [`${fmtN(n(c.guestConfigServers))} Arc-enabled server(s) with machine configuration policies`];
    if (n(c.exemptServers)) parts.push(`${fmtN(c.exemptServers)} of them already free`);
    if (n(c.guestConfigServers) && (c.hours ?? HOURS) < HOURS) parts.push(`${fmtN(c.hours)} hours a month`);
    else if (n(c.guestConfigServers)) parts.push('all month');
    if (n(c.kubernetesVcpus)) parts.push(`${fmtN(c.kubernetesVcpus)} Arc-enabled Kubernetes vCPUs in ${fmtN(c.kubernetesClusters ?? 1)} cluster(s)`);
    if (n(c.premiumP1Resources)) parts.push(`${fmtN(c.premiumP1Resources)} Premium P1 resources`);
    if (n(c.premiumP2Resources)) parts.push(`${fmtN(c.premiumP2Resources)} Premium P2 resources`);
    return `Azure Policy charged items: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('azure-policy-logs') ? [] : [
    'Log Analytics or Storage costs if policy compliance data or guest configuration reports are exported',
    'The Azure Arc-enabled servers themselves and any Defender for Cloud plans'
  ],
  examples: [
    { type: 'azure-policy', guestConfigServers: 25 },
    { type: 'azure-policy', guestConfigServers: 40, exemptServers: 10, hours: 500, kubernetesVcpus: 64, kubernetesClusters: 4, premiumP1Resources: 300, premiumP2Resources: 120 }
  ],
  price: async (c, ctx) => {
    const gov = /^usgov/i.test(ctx.region || '');
    const scope = gov ? 'US Gov' : 'Global';
    const rs = await rows(`serviceName eq 'Azure Policy' and armRegionName eq '${scope}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Policy is not priced for ${ctx.region}.`);
    const m = (name, what) => single(rs.filter(r => r.meterName === name), `Azure Policy ${what}`);
    const G = 'Management', S = 'Azure Policy', lines = [], notes = [];
    const total = n(c.guestConfigServers), servers = total - n(c.exemptServers), hours = c.hours ?? HOURS;
    if (n(c.exemptServers) > total) throw new PricingError(`exemptServers (${n(c.exemptServers)}) cannot be more than guestConfigServers (${total}).`);
    if (servers) lines.push(meterLine(G, S, `Machine configuration (guest configuration), ${fmtN(servers)} Arc-enabled server(s) x ${fmtN(hours)} hours of the month`, m('Guest Configuration Policy/Server', 'machine configuration'), servers * hours / HOURS, ctx, { unit: 'server-months' }));
    if (n(c.kubernetesVcpus)) {
      // The API's graduated band gives 6 free vCPUs in total; the free grant is per cluster, so bill beyond 6 per cluster at the paid rate.
      const paid = m('Kubernetes Policy/vCPU/Month', 'Kubernetes policy').filter(r => r.retailPrice > 0).map(r => Object.assign({}, r, { tierMinimumUnits: 0 }));
      if (!paid.length) throw new PricingError('No paid Kubernetes policy price found.');
      const clusters = n(c.kubernetesClusters ?? 1), billable = Math.max(0, n(c.kubernetesVcpus) - 6 * clusters);
      lines.push(meterLine(G, S, `Azure Policy for Kubernetes on Arc-enabled clusters: ${fmtN(c.kubernetesVcpus)} vCPUs in ${fmtN(clusters)} cluster(s), ${fmtN(billable)} billable (first 6 per cluster free)`, paid, billable, ctx, { unit: 'vCPU / month' }));
      notes.push('Azure Policy for Kubernetes is priced in the Retail Prices API (first 6 vCPUs free, then per vCPU) but no current public Microsoft pricing page lists it, and the free 6 vCPUs per cluster follows the Arc Kubernetes pattern; confirm before quoting.');
    }
    if (n(c.premiumP1Resources)) lines.push(meterLine(G, S, `Azure Policy Premium tier P1 (per-resource), ${fmtN(c.premiumP1Resources)} resources`, m('Premium P1 Tier Resource', 'Premium P1'), n(c.premiumP1Resources), ctx, { unit: 'resources / month' }));
    if (n(c.premiumP2Resources)) lines.push(meterLine(G, S, `Azure Policy Premium tier P2 (per-resource), ${fmtN(c.premiumP2Resources)} resources`, m('Premium P2 Tier Resource', 'Premium P2'), n(c.premiumP2Resources), ctx, { unit: 'resources / month' }));
    if (!lines.length) {
      // Keep one zero-priced line so the estimate shows the free Basic tier meter.
      lines.push(meterLine(G, S, 'Azure Policy on Azure resources (Basic tier), free', m('Basic Tier Resource', 'Basic tier'), 1, ctx, { unit: 'resources / month' }));
    }
    notes.push('Azure Policy on Azure resources is free; only the items above are charged. Azure virtual machines cost nothing for guest configuration. Policy prices are the same in every region.');
    if (servers) notes.push('Machine configuration is billed per server that is registered and has at least one guest configuration assigned, pro-rated hourly; the price is the same however many policies the server has.');
    if (n(c.premiumP1Resources) || n(c.premiumP2Resources)) notes.push('The Premium P1/P2 per-resource meters are listed in the Azure Retail Prices API but are not described on Microsoft\'s public Azure Policy pricing page; confirm that they apply before quoting them.');
    return { lines, notes, facts: { guestConfigServers: total, chargedServers: servers, exemptServers: n(c.exemptServers), kubernetesClusters: n(c.kubernetesClusters ?? 1), kubernetesVcpus: n(c.kubernetesVcpus), premiumP1Resources: n(c.premiumP1Resources), premiumP2Resources: n(c.premiumP2Resources), hours } };
  }
};



