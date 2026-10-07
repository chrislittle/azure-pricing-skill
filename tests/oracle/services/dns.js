'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'dns';
const HOURS = 730;
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function dnsZone(region) { return region === 'usgovvirginia' ? 'usgov-zone1' : 'zone1'; }
function retailZone(region) { return region === 'usgovvirginia' ? 'US Gov Zone 1' : 'Zone 1'; }
function graduated(bands, qty) { let prev = 0, cost = 0; for (const b of bands) { if (qty <= prev) break; const units = Math.min(qty, b.limit) - prev; cost += units * b.price.value; prev = b.limit; } return cost; }
function graduatedRetail(rows, qty) { const sorted = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits); let cost = 0; for (let i = 0; i < sorted.length; i++) { const start = sorted[i].tierMinimumUnits, end = i + 1 < sorted.length ? sorted[i + 1].tierMinimumUnits : Infinity; if (qty <= start) break; cost += (Math.min(qty, end) - start) * sorted[i].retailPrice; } return cost; }
function manualPrivateQueryBands(currency, zone, rows) {
  if (currency === 'USD') return zone === 'usgov-zone1' ? [{ limit: 1000, price: { value: 0.5 } }, { limit: Infinity, price: { value: 0.25 } }] : [{ limit: 1000, price: { value: 0.4 } }, { limit: Infinity, price: { value: 0.2 } }];
  const first = pick(rows, r => r.skuName === 'Private' && r.meterName === 'Private Queries' && r.armRegionName === 'Zone 1', 'Private Queries').retailPrice;
  return [{ limit: 1000, price: { value: first } }, { limit: Infinity, price: { value: first / 2 } }];
}
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length < 1) throw new Error('no Retail API row for ' + what); return hits[0]; }
async function retailRows(currency) { return dedupe(await query("serviceName eq 'Azure DNS'", currency)); }
async function dns(o) {
  const currency = o.currency || 'USD', region = o.region || 'eastus2', zone = dnsZone(region), rz = retailZone(region), hours = o.hours ?? HOURS, lines = [];
  if (currency === 'USD') {
    const d = await calc.product(SLUG);
    if (o.publicZones) lines.push(line('Public zones: ' + o.publicZones + ' through calculator 25-zone bands', graduated(d.graduatedOffers['zone-public'][zone].prices, o.publicZones), { sourceOffer: 'zone-public', zone }));
    if (o.privateZones) lines.push(line('Private zones: ' + o.privateZones + ' through pricing-page 25-zone bands', graduated(d.graduatedOffers['zone-public'][zone].prices, o.privateZones), { source: 'pricing-page', zone }));
    if (o.publicQueriesMillions) lines.push(line('Public queries: ' + o.publicQueriesMillions + 'M through calculator 1B-query bands', graduated(d.graduatedOffers['queries-public'][zone].prices, o.publicQueriesMillions), { sourceOffer: 'queries-public', zone }));
    if (o.privateQueriesMillions) lines.push(line('Private queries: ' + o.privateQueriesMillions + 'M through pricing-page 1B-query bands', graduated(manualPrivateQueryBands(currency, zone), o.privateQueriesMillions), { source: 'pricing-page' }));
    for (const [field, offerName, label] of [['resolverInboundEndpoints','inbound-endpoint','Private Resolver inbound endpoints'], ['resolverOutboundEndpoints','outbound-enpoint','Private Resolver outbound endpoints'], ['resolverRulesets','ruleset','Private Resolver rulesets']]) {
      if (o[field]) lines.push(line(label + ': ' + o[field] + ' * ' + hours + '/' + HOURS + ' month', o[field] * d.offers[offerName].prices[zone].value * hours / HOURS, { sourceOffer: offerName, zone }));
    }
    if (o.securityPolicyDomains) lines.push(line('DNS security policy domains: ' + o.securityPolicyDomains + ' domains rounded to 1K units * ' + hours + '/' + HOURS + ' month', Math.ceil(o.securityPolicyDomains / 1000) * d.offers['security-policy-domains'].prices[zone].value * hours / HOURS, { sourceOffer: 'security-policy-domains', zone }));
    if (o.securityPolicyQueriesMillions) lines.push(line('DNS security policy queries: ' + o.securityPolicyQueriesMillions + 'M', o.securityPolicyQueriesMillions * d.offers['security-policy-queries'].prices[zone].value, { sourceOffer: 'security-policy-queries', zone }));
  } else {
    const rows = await retailRows(currency);
    if (o.publicZones) lines.push(line('Public zones: ' + o.publicZones + ' through Retail API 25-zone bands', graduatedRetail(rows.filter(r => r.skuName === 'Public' && r.meterName === 'Public Zone' && r.armRegionName === rz), o.publicZones)));
    if (o.privateZones) lines.push(line('Private zones: ' + o.privateZones + ' through Retail API 25-zone bands', graduatedRetail(rows.filter(r => r.skuName === 'Private' && r.meterName === 'Private Zone' && r.armRegionName === rz), o.privateZones)));
    if (o.publicQueriesMillions) lines.push(line('Public queries: ' + o.publicQueriesMillions + 'M through Retail API 1B-query bands', graduatedRetail(rows.filter(r => r.skuName === 'Public' && r.meterName === 'Public Queries' && r.armRegionName === rz), o.publicQueriesMillions)));
    if (o.privateQueriesMillions) lines.push(line('Private queries: ' + o.privateQueriesMillions + 'M through pricing-page 1B-query bands', graduated(manualPrivateQueryBands(currency, zone, rows), o.privateQueriesMillions)));
    for (const [field, meter, label] of [['resolverInboundEndpoints','Private Resolver Inbound Endpoint','inbound'], ['resolverOutboundEndpoints','Private Resolver Outbound Endpoint','outbound'], ['resolverRulesets','Private Resolver DNS Forwarding Ruleset','ruleset']]) if (o[field]) lines.push(line('Private Resolver ' + label + ': ' + o[field] + ' * ' + hours + '/' + HOURS + ' month', o[field] * pick(rows, r => r.meterName === meter && r.armRegionName === rz, meter).retailPrice * hours / HOURS));
    if (o.securityPolicyDomains) lines.push(line('DNS security policy domains: ' + o.securityPolicyDomains + ' domains rounded to 1K units', Math.ceil(o.securityPolicyDomains / 1000) * pick(rows, r => r.meterName === 'DNS Security Policy Domains Managed Domain' && r.armRegionName === rz, 'security domains').retailPrice * hours / HOURS));
    if (o.securityPolicyQueriesMillions) lines.push(line('DNS security policy queries: ' + o.securityPolicyQueriesMillions + 'M', o.securityPolicyQueriesMillions * pick(rows, r => r.meterName === 'DNS Security Policy Queries' && r.armRegionName === rz, 'security queries').retailPrice));
  }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'dns', source: 'both', cases: [
  { name: 'zero usage rejected', region: 'eastus2', currency: 'USD', component: { type: 'dns', publicZones: 0, privateZones: 0, publicQueriesMillions: 0, privateQueriesMillions: 0 },
    // With no zones, queries, resolver endpoints, or policy quantities, there is no billable DNS resource to price.
    expectEngineError: /Nothing to price|at least one/i },
  { name: '25 public zones boundary', region: 'eastus2', currency: 'USD', component: { type: 'dns', publicZones: 25, publicQueriesMillions: 0 },
    // Calculator zone-public offer bills the first 25 public zones at the first tier and no query charge at 0M.
    expected: () => dns({ region: 'eastus2', publicZones: 25 }) },
  { name: '26 public zones and 1000M query boundary', region: 'eastus2', currency: 'USD', component: { type: 'dns', publicZones: 26, publicQueriesMillions: 1000 },
    // Calculator zone-public and queries-public graduated offers cross the 25-zone and 1B-query boundaries.
    expected: () => dns({ region: 'eastus2', publicZones: 26, publicQueriesMillions: 1000 }) },
  { name: 'public queries just above 1B plus private zones', region: 'eastus2', currency: 'USD', component: { type: 'dns', publicZones: 1, privateZones: 26, publicQueriesMillions: 1001, privateQueriesMillions: 25 },
    // Public queries use calculator 1B-query tiers; private zone/query prices use pricing-page private DNS tiers.
    expected: () => dns({ region: 'eastus2', publicZones: 1, privateZones: 26, publicQueriesMillions: 1001, privateQueriesMillions: 25 }) },
  { name: 'private queries just above 1B', region: 'eastus2', currency: 'USD', component: { type: 'dns', publicZones: 0, privateZones: 1, privateQueriesMillions: 1001 },
    // Pricing page private DNS query tiers: first 1B at $0.40/M, additional queries at $0.20/M.
    expected: () => dns({ region: 'eastus2', privateZones: 1, privateQueriesMillions: 1001 }) },
  { name: 'US Gov public zones and queries', region: 'usgovvirginia', currency: 'USD', component: { type: 'dns', publicZones: 30, publicQueriesMillions: 10 },
    // US Gov Zone 1 calculator bands: 25*$0.63 + 5*$0.13 zones and 10M*$0.50 queries = $21.40.
    expected: () => dns({ region: 'usgovvirginia', publicZones: 30, publicQueriesMillions: 10 }) },
  { name: 'very large public and private DNS', region: 'eastus2', currency: 'USD', component: { type: 'dns', publicZones: 100000, privateZones: 100000, publicQueriesMillions: 5000000, privateQueriesMillions: 5000000 },
    // Very large quantities exercise the final graduated zone and query tiers for public and private DNS.
    expected: () => dns({ region: 'eastus2', publicZones: 100000, privateZones: 100000, publicQueriesMillions: 5000000, privateQueriesMillions: 5000000 }) },
  { name: 'private resolver and security policy part time', region: 'westeurope', currency: 'USD', component: { type: 'dns', publicZones: 1, resolverInboundEndpoints: 1, resolverOutboundEndpoints: 1, resolverRulesets: 2, securityPolicyDomains: 2500, securityPolicyQueriesMillions: 12, hours: 365 },
    // Private Resolver monthly offers and DNS security policy domain list are prorated by 365/730 hours; queries are per million.
    expected: () => dns({ region: 'westeurope', publicZones: 1, resolverInboundEndpoints: 1, resolverOutboundEndpoints: 1, resolverRulesets: 2, securityPolicyDomains: 2500, securityPolicyQueriesMillions: 12, hours: 365 }) },
  { name: 'EUR all DNS dimensions', region: 'westeurope', currency: 'EUR', component: { type: 'dns', publicZones: 26, privateZones: 26, publicQueriesMillions: 1001, privateQueriesMillions: 11, resolverInboundEndpoints: 1, resolverOutboundEndpoints: 1, resolverRulesets: 1, securityPolicyDomains: 1000, securityPolicyQueriesMillions: 1 },
    // Retail API EUR Azure DNS rows cover public/private zone and public-query graduated tiers; private queries use pricing-page 1B tiers.
    expected: () => dns({ currency: 'EUR', region: 'westeurope', publicZones: 26, privateZones: 26, publicQueriesMillions: 1001, privateQueriesMillions: 11, resolverInboundEndpoints: 1, resolverOutboundEndpoints: 1, resolverRulesets: 1, securityPolicyDomains: 1000, securityPolicyQueriesMillions: 1 }) },
] };
