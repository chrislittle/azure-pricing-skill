'use strict';
// Azure Traffic Manager: DNS-based traffic routing. Meters: serviceName 'Traffic Manager', regionless (Global).
// DNS queries are graduated per million; health checks are per monitored endpoint per month, with add-ons for
// fast-interval and HTTPS checks; plus nested endpoints, Traffic View and real user measurements.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'traffic-manager',
  label: 'Azure Traffic Manager',
  family: 'networking-edge',
  calculator: ['traffic-manager'],
  keywords: ['traffic manager', 'dns load balancing', 'failover', 'geo routing', 'global routing', 'health probe', 'multi-region'],
  fields: {
    dnsQueriesMillions: { req: true, ask: 'Roughly how many millions of DNS lookups a month will clients send to the Traffic Manager name? Lookups answered from other DNS servers\' caches are not counted, so a longer cache time (TTL) means fewer. If unknown, suggest 5 for a small app and record it as an assumption.' },
    azureEndpoints: { def: 0, int: true, min: 0, ask: 'How many of the places traffic can be sent to are Azure services (App Service, public IPs, cloud services) monitored by health checks? Count every enabled endpoint, including any set to always serve traffic, because those are still billed for basic health checks.' },
    externalEndpoints: { def: 0, int: true, min: 0, ask: 'How many of the places traffic can be sent to are outside Azure (on-premises or another cloud, monitored by health checks)? Count every enabled endpoint, including any set to always serve traffic. An Azure service added as an external endpoint is billed at the external rate.' },
    fastAzureEndpoints: { def: 0, int: true, min: 0, ask: 'Of those Azure endpoints, how many need fast health checks (every 10 seconds instead of every 30)? Only if failover must happen within seconds.' },
    fastExternalEndpoints: { def: 0, int: true, min: 0, ask: 'Of those external endpoints, how many need fast health checks (every 10 seconds)?' },
    httpsAzureEndpoints: { def: 0, int: true, min: 0, ask: 'Of those Azure endpoints, how many are health-checked over HTTPS instead of plain HTTP/TCP?' },
    httpsExternalEndpoints: { def: 0, int: true, min: 0, ask: 'Of those external endpoints, how many are health-checked over HTTPS?' },
    nestedEndpoints: { def: 0, int: true, min: 0, ask: 'Only if they chain Traffic Manager profiles (for example one profile per region behind a global one): how many nested endpoints?' },
    trafficViewMillions: { def: 0, ask: 'Only if they turn on Traffic View (a report of where users come from and how they perform): millions of data points processed a month.' },
    realUserMeasurementsMillions: { def: 0, ask: 'Only if they use Real User Measurements (browsers report latency back to Azure): millions of measurements a month.' }
  },
  context: ['production', 'internetFacing', 'multiRegionUsers'],
  examples: [
    { type: 'traffic-manager', dnsQueriesMillions: 5, azureEndpoints: 2 },
    { type: 'traffic-manager', dnsQueriesMillions: 1500, azureEndpoints: 4, externalEndpoints: 2, fastAzureEndpoints: 2, fastExternalEndpoints: 1, httpsAzureEndpoints: 2, httpsExternalEndpoints: 1, nestedEndpoints: 2, trafficViewMillions: 20, realUserMeasurementsMillions: 10 }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.dnsQueriesMillions))} million DNS queries a month`];
    if (n(c.azureEndpoints)) parts.push(`${fmtN(c.azureEndpoints)} Azure endpoint(s) health-checked`);
    if (n(c.externalEndpoints)) parts.push(`${fmtN(c.externalEndpoints)} external endpoint(s) health-checked`);
    if (n(c.fastAzureEndpoints)) parts.push(`${fmtN(c.fastAzureEndpoints)} Azure endpoint(s) with fast (10-second) checks`);
    if (n(c.fastExternalEndpoints)) parts.push(`${fmtN(c.fastExternalEndpoints)} external endpoint(s) with fast (10-second) checks`);
    if (n(c.httpsAzureEndpoints)) parts.push(`${fmtN(c.httpsAzureEndpoints)} Azure endpoint(s) checked over HTTPS`);
    if (n(c.httpsExternalEndpoints)) parts.push(`${fmtN(c.httpsExternalEndpoints)} external endpoint(s) checked over HTTPS`);
    if (n(c.nestedEndpoints)) parts.push(`${fmtN(c.nestedEndpoints)} nested endpoint(s)`);
    if (n(c.trafficViewMillions)) parts.push(`${fmtN(c.trafficViewMillions)} million Traffic View data points`);
    if (n(c.realUserMeasurementsMillions)) parts.push(`${fmtN(c.realUserMeasurementsMillions)} million real user measurements`);
    return `Traffic Manager: ${parts.join(', ')}`;
  },
  price: async (c, ctx) => {
    for (const k of Object.keys(module.exports.fields)) if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    const gov = /^usgov/i.test(ctx.region || '');
    for (const [add, base, what] of [['fastAzureEndpoints', 'azureEndpoints', 'fast health checks on Azure endpoints'], ['httpsAzureEndpoints', 'azureEndpoints', 'HTTPS health checks on Azure endpoints'], ['fastExternalEndpoints', 'externalEndpoints', 'fast health checks on external endpoints'], ['httpsExternalEndpoints', 'externalEndpoints', 'HTTPS health checks on external endpoints']]) {
      if (n(c[add]) > n(c[base])) throw new PricingError(`${what} (${n(c[add])}) cannot exceed the endpoints with basic health checks (${n(c[base])}): fast and HTTPS checks are add-ons to the basic health check, so raise ${base} too.`);
    }
    if (gov && n(c.trafficViewMillions)) throw new PricingError('Traffic View is not offered in US Gov regions.');
    // US Gov has its own, higher, prices; every other region uses the regionless Global rows.
    const rs = await rows(`serviceName eq 'Traffic Manager' and armRegionName eq '${gov ? 'US Gov' : 'Global'}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError('Traffic Manager prices were not returned.');
    // De-duplication keeps one row per meterId, and DNS Queries shares one meterId across SKUs, so match that meter on its name alone (same price for every SKU).
    const m = (sku, name, what) => {
      const hit = rs.filter(r => (sku === null || r.skuName === sku) && r.meterName === name);
      if (gov && !hit.length) throw new PricingError(`Traffic Manager ${what} has no published US Gov price, so it cannot be priced here.`);
      return single(hit, `Traffic Manager ${what}`);
    };
    const G = 'Networking', S = 'Traffic Manager', lines = [];
    const q = m(null, 'DNS Queries', 'DNS queries');
    lines.push(meterLine(G, S, `DNS queries, ${fmtN(n(c.dnsQueriesMillions))} million/month${n(c.dnsQueriesMillions) > 1000 ? ' (cheaper after the first billion)' : ''}`, q, n(c.dnsQueriesMillions) * 1e6, ctx));
    const add = (key, sku, name, what, desc) => { if (n(c[key])) lines.push(meterLine(G, S, `${desc}, ${fmtN(c[key])}`, m(sku, name, what), n(c[key]), ctx, { unit: 'endpoints / month' })); };
    add('azureEndpoints', 'Azure Endpoint', 'Azure Endpoint Health Checks', 'Azure endpoint health checks', 'Health checks on Azure endpoints');
    add('externalEndpoints', 'Non-Azure Endpoint', 'Non-Azure Endpoint Health Checks', 'external endpoint health checks', 'Health checks on external (non-Azure) endpoints');
    add('fastAzureEndpoints', 'Azure Endpoint', 'Azure Endpoint Fast Interval Health Check Add-ons', 'Azure fast-interval add-on', 'Fast (10-second) health check add-on on Azure endpoints');
    add('fastExternalEndpoints', 'Non-Azure Endpoint', 'Non-Azure Endpoint Fast Interval Health Check Add-ons', 'external fast-interval add-on', 'Fast (10-second) health check add-on on external endpoints');
    add('httpsAzureEndpoints', 'Azure Endpoint', 'Azure Endpoint HTTPS Health Check Add-On', 'Azure HTTPS add-on', 'HTTPS health check add-on on Azure endpoints');
    add('httpsExternalEndpoints', 'Non-Azure Endpoint', 'Non-Azure Endpoint HTTPS Health Check Add-On', 'external HTTPS add-on', 'HTTPS health check add-on on external endpoints');
    add('nestedEndpoints', 'Nested Endpoint', 'Nested Endpoint Nested Endpoint', 'nested endpoints', 'Nested endpoints');
    if (n(c.trafficViewMillions)) lines.push(meterLine(G, S, `Traffic View data points processed, ${fmtN(c.trafficViewMillions)} million/month`, m('Traffic View', 'Traffic View Data Points Processed', 'Traffic View data points'), n(c.trafficViewMillions) * 1e6, ctx));
    if (n(c.realUserMeasurementsMillions)) lines.push(meterLine(G, S, `Real User Measurements, ${fmtN(c.realUserMeasurementsMillions)} million/month`, m('Azure Region', 'Azure Region Real User Measurements', 'real user measurements'), n(c.realUserMeasurementsMillions) * 1e6, ctx));
    const notes = [
      'Traffic Manager has one commercial price for every region (US Gov regions have their own, higher, prices). DNS queries are counted only when they reach Traffic Manager name servers, so DNS caching by internet providers lowers the count; the price per million drops after the first billion queries a month.',
      'Each endpoint with health checks is billed per month; fast-interval and HTTPS checks are add-ons on top of the endpoint health check. Endpoints outside Azure cost more than Azure endpoints. Endpoints set to always serve traffic are still billed for basic health checks.'
    ];
    return { lines, notes, facts: { dnsQueriesMillions: n(c.dnsQueriesMillions), azureEndpoints: n(c.azureEndpoints), externalEndpoints: n(c.externalEndpoints), nestedEndpoints: n(c.nestedEndpoints), endpoints: n(c.azureEndpoints) + n(c.externalEndpoints), fastEndpoints: n(c.fastAzureEndpoints) + n(c.fastExternalEndpoints), trafficViewMillions: n(c.trafficViewMillions) } };
  }
};
