'use strict';
// Azure DNS: public and private zones, DNS queries, DNS Private Resolver (inbound/outbound endpoints, forwarding
// rulesets) and DNS security policy (domain lists + queries). Meters: serviceName 'Azure DNS'.
// Zone, query and resolver meters are regionless (armRegionName ''); the security policy meters are only
// published per pricing zone (Zone 1-4, identical prices), so those are matched on the zone rows.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'dns',
  label: 'Azure DNS',
  family: 'networking-edge',
  calculator: ['dns'],
  keywords: ['dns', 'domain name', 'private dns', 'dns zone', 'name resolution', 'dns resolver', 'dns forwarding', 'dns queries'],
  fields: {
    publicZones: { req: true, int: true, min: 0, ask: 'How many public DNS zones will Azure host (usually one per internet domain, for example contoso.com)? Use 0 if they only need private DNS.' },
    privateZones: { def: 0, int: true, min: 0, ask: 'How many private DNS zones (names that only resolve inside their virtual networks, for example privatelink.blob.core.windows.net)? Each Private Link service type usually needs its own zone.' },
    publicQueriesMillions: { def: 0, ask: 'Roughly how many millions of DNS lookups a month will the public zones receive? If unknown, suggest 10 for a small site and record it as an assumption. Lookups answered from other servers\' caches are not counted.' },
    privateQueriesMillions: { def: 0, ask: 'Roughly how many millions of DNS lookups a month will the private zones receive from virtual machines and other resources?' },
    resolverInboundEndpoints: { def: 0, int: true, min: 0, ask: 'Only if on-premises networks must look up names in Azure private zones: how many DNS Private Resolver inbound endpoints (usually 1 per virtual network or region)?' },
    resolverOutboundEndpoints: { def: 0, int: true, min: 0, ask: 'Only if Azure must look up on-premises or other private names: how many DNS Private Resolver outbound endpoints (usually 1 per virtual network or region)?' },
    resolverRulesets: { def: 0, int: true, min: 0, ask: 'How many DNS forwarding rulesets (a ruleset lists which domains are sent to which DNS server)? Needed with an outbound endpoint, usually 1 or more.' },
    securityPolicyDomains: { def: 0, int: true, min: 0, ask: 'Only if they filter or block DNS lookups with a DNS security policy: how many domains are in their domain lists in total? The Microsoft threat-intelligence list counts too if used; ask Microsoft or the portal for its size. Billed per 1,000 domains.' },
    securityPolicyDomainLists: { def: 1, int: true, min: 1, ask: 'Only with a DNS security policy: how many separate domain lists hold those domains? Each list is billed per 1,000 domains, so many small lists cost more than one big one. Assume equal sizes.' },
    securityPolicyQueriesMillions: { def: 0, ask: 'Only with a DNS security policy: millions of DNS lookups a month that are checked against its rules.' },
    hours: { def: 730, ask: 'Private Resolver endpoints, rulesets and security policy domain lists only: hours a month they exist (730 = all month; they are billed per month and prorated by the hour when removed early).' }
  },
  context: ['production', 'privateOnly'],
  examples: [
    { type: 'dns', publicZones: 1, publicQueriesMillions: 10 },
    { type: 'dns', publicZones: 30, privateZones: 40, publicQueriesMillions: 1500, privateQueriesMillions: 200, resolverInboundEndpoints: 2, resolverOutboundEndpoints: 1, resolverRulesets: 2, securityPolicyDomains: 2500, securityPolicyQueriesMillions: 50, hours: 730 },
    { type: 'dns', publicZones: 0, privateZones: 5, privateQueriesMillions: 20, resolverInboundEndpoints: 1, hours: 365 }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.publicZones))} public zone(s)`];
    if (n(c.privateZones)) parts.push(`${fmtN(c.privateZones)} private zone(s)`);
    if (n(c.publicQueriesMillions)) parts.push(`${fmtN(c.publicQueriesMillions)} million public DNS queries a month`);
    if (n(c.privateQueriesMillions)) parts.push(`${fmtN(c.privateQueriesMillions)} million private DNS queries a month`);
    const hrs = c.hours ?? HOURS;
    const time = hrs === HOURS ? 'all month' : `${fmtN(hrs)} hours a month`;
    if (n(c.resolverInboundEndpoints)) parts.push(`${fmtN(c.resolverInboundEndpoints)} Private Resolver inbound endpoint(s), ${time}`);
    if (n(c.resolverOutboundEndpoints)) parts.push(`${fmtN(c.resolverOutboundEndpoints)} Private Resolver outbound endpoint(s), ${time}`);
    if (n(c.resolverRulesets)) parts.push(`${fmtN(c.resolverRulesets)} forwarding ruleset(s), ${time}`);
    if (n(c.securityPolicyDomains)) parts.push(`DNS security policy with ${fmtN(c.securityPolicyDomains)} domains in ${fmtN(c.securityPolicyDomainLists || 1)} list(s), ${time}`);
    if (n(c.securityPolicyQueriesMillions)) parts.push(`${fmtN(c.securityPolicyQueriesMillions)} million queries checked by the DNS security policy`);
    return `Azure DNS: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Domain name registration (Azure DNS hosts zones but does not sell domain names)'
  ],
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    for (const k of ['publicZones', 'privateZones', 'publicQueriesMillions', 'privateQueriesMillions', 'resolverInboundEndpoints', 'resolverOutboundEndpoints', 'resolverRulesets', 'securityPolicyDomains', 'securityPolicyDomainLists', 'securityPolicyQueriesMillions']) {
      if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    }
    const rs = await rows(`serviceName eq 'Azure DNS' and priceType eq 'Consumption'`, ctx);
    const gov = /^usgov/i.test(ctx.region || '');
    // De-duplication keeps one row per meterId, which may be the regionless copy or any Zone copy; copies carry the same price.
    // US Gov regions have their own (higher) US Gov Zone 1/2 rows.
    const pool = rs.filter(r => gov ? /^US Gov Zone [12]$/.test(r.armRegionName) : (!r.armRegionName || r.armRegionName === 'Global' || /^Zone [1-4]$/.test(r.armRegionName)));
    const g = (sku, name, what) => single(pool.filter(r => r.skuName === sku && r.meterName === name), `Azure DNS ${what}`);
    const z = (name, what) => single(pool.filter(r => r.meterName === name), `Azure DNS ${what}`);
    const G = 'Networking', S = 'Azure DNS', lines = [];
    const month = hours / HOURS;
    const notes = [];
    if (n(c.publicZones)) {
      const m = g('Public', 'Public Zone', 'public zones');
      lines.push(meterLine(G, S, `Public DNS zones, ${fmtN(c.publicZones)} zone(s)${n(c.publicZones) > 25 ? ' (first 25 at the higher price)' : ''}`, m, n(c.publicZones), ctx, { unit: 'zones / month' }));
    }
    if (n(c.privateZones)) {
      const m = g('Private', 'Private Zone', 'private zones');
      lines.push(meterLine(G, S, `Private DNS zones, ${fmtN(c.privateZones)} zone(s)${n(c.privateZones) > 25 ? ' (first 25 at the higher price)' : ''}`, m, n(c.privateZones), ctx, { unit: 'zones / month' }));
    }
    const pubQ = n(c.publicQueriesMillions) ? g('Public', 'Public Queries', 'public queries') : null;
    if (pubQ) lines.push(meterLine(G, S, `Public DNS queries, ${fmtN(c.publicQueriesMillions)} million/month${n(c.publicQueriesMillions) > 1000 ? ' (cheaper after the first billion)' : ''}`, pubQ, n(c.publicQueriesMillions) * 1e6, ctx));
    if (n(c.privateQueriesMillions)) {
      let m = g('Private', 'Private Queries', 'private queries');
      if (m.length === 1) {
        // The commercial Retail meter lists one flat rate, but the pricing page and calculator drop private queries above 1 billion to the public-query rate.
        const pub = pubQ || g('Public', 'Public Queries', 'public queries');
        const upper = [...pub].sort((a, b) => b.tierMinimumUnits - a.tierMinimumUnits)[0];
        if (upper.tierMinimumUnits > 0) m = [...m, { ...m[0], tierMinimumUnits: upper.tierMinimumUnits, retailPrice: upper.retailPrice, unitPrice: upper.unitPrice }];
        if (n(c.privateQueriesMillions) > 1000) notes.push('Private query volume above 1 billion a month is priced at the lower published rate (the same as public queries above 1 billion) per the Azure DNS pricing page and calculator; the Retail Prices API lists a single flat private-query rate, so a real bill could differ.');
      }
      lines.push(meterLine(G, S, `Private DNS queries, ${fmtN(c.privateQueriesMillions)} million/month${n(c.privateQueriesMillions) > 1000 ? ' (cheaper after the first billion)' : ''}`, m, n(c.privateQueriesMillions) * 1e6, ctx));
    }
    if (n(c.resolverInboundEndpoints)) lines.push(meterLine(G, S, `DNS Private Resolver inbound endpoints, ${fmtN(c.resolverInboundEndpoints)} x ${fmtN(hours)} hours`, g('Private Resolver', 'Private Resolver Inbound Endpoint', 'resolver inbound endpoint'), n(c.resolverInboundEndpoints) * month, ctx, { unit: 'endpoint-months' }));
    if (n(c.resolverOutboundEndpoints)) lines.push(meterLine(G, S, `DNS Private Resolver outbound endpoints, ${fmtN(c.resolverOutboundEndpoints)} x ${fmtN(hours)} hours`, g('Private Resolver', 'Private Resolver Outbound Endpoint', 'resolver outbound endpoint'), n(c.resolverOutboundEndpoints) * month, ctx, { unit: 'endpoint-months' }));
    if (n(c.resolverRulesets)) lines.push(meterLine(G, S, `DNS forwarding rulesets, ${fmtN(c.resolverRulesets)} x ${fmtN(hours)} hours`, g('Private Resolver', 'Private Resolver DNS Forwarding Ruleset', 'forwarding ruleset'), n(c.resolverRulesets) * month, ctx, { unit: 'ruleset-months' }));
    // Billed per 1,000 domains in each list, so each list is rounded up on its own; lists are assumed to be the same size.
    const lists = n(c.securityPolicyDomains) ? Math.max(1, n(c.securityPolicyDomainLists) || 1) : 0;
    const thousands = lists * Math.ceil(n(c.securityPolicyDomains) / lists / 1000);
    if (thousands) lines.push(meterLine(G, S, `DNS security policy domain lists, ${fmtN(c.securityPolicyDomains)} domains in ${fmtN(lists)} list(s) (${fmtN(thousands)} x 1,000) x ${fmtN(hours)} hours`, z('DNS Security Policy Domains Managed Domain', 'security policy domains'), thousands * month, ctx, { unit: '1,000 domains-months' }));
    if (n(c.securityPolicyQueriesMillions)) lines.push(meterLine(G, S, `DNS security policy queries, ${fmtN(c.securityPolicyQueriesMillions)} million/month`, z('DNS Security Policy Queries', 'security policy queries'), n(c.securityPolicyQueriesMillions) * 1e6, ctx));
    if (!lines.length) throw new PricingError('Nothing to price: set at least one zone, query count, resolver endpoint or security policy quantity.');
    notes.unshift(
      'Zones are billed per zone per month (calculated daily, so partial months are prorated). Public and private zones are billed on separate meters, so each type has its own first-25 higher-priced band; queries are likewise totalled per type. Bands and query totals are counted per subscription, so estimate several subscriptions as one dns component each.',
      'Private Resolver endpoints and forwarding rulesets are monthly prices prorated by the hour.'
    );
    if (gov) notes.push('US Gov regions use the US Gov DNS prices, which are higher than commercial.');
    if (thousands) notes.push('Security policy domain lists are billed per 1,000 domains per list per month, each list rounded up to whole thousands (lists assumed equal in size); security policy queries are only billed when rules are configured.');
    return { lines, notes, facts: { publicZones: n(c.publicZones), privateZones: n(c.privateZones), publicQueriesMillions: n(c.publicQueriesMillions), privateQueriesMillions: n(c.privateQueriesMillions), resolverEndpoints: n(c.resolverInboundEndpoints) + n(c.resolverOutboundEndpoints), resolverOutboundEndpoints: n(c.resolverOutboundEndpoints), resolverRulesets: n(c.resolverRulesets), securityPolicyDomains: n(c.securityPolicyDomains), hours } };
  }
};
