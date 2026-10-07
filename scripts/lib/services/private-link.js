'use strict';
// Azure Private Link: private endpoints (hourly) and data processed through them (graduated per GB, billed in
// each direction), plus the Standard service endpoint preview (per virtual network). Meters: serviceName 'Virtual Network',
// productName 'Virtual Network Private Link', regionless (Global). Private Link service (the provider side) is free.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'private-link',
  label: 'Azure Private Link',
  family: 'networking-core',
  calculator: ['private-link'],
  keywords: ['private link', 'private endpoint', 'private connectivity', 'privatelink', 'private access', 'service endpoint'],
  fields: {
    privateEndpoints: { req: true, int: true, min: 0, ask: 'How many private endpoints will they create? Each endpoint is one private network address for one Azure service (a storage account, a SQL server, a Key Vault...). Count one per service per virtual network, and one for each sub-service such as blob and file on the same storage account.' },
    inboundGB: { def: 0, ask: 'Roughly how many GB a month are READ through the private endpoints (data coming back from the service, for example reading from storage)? If unknown, suggest 100 GB and record it as an assumption.' },
    outboundGB: { def: 0, ask: 'Roughly how many GB a month are WRITTEN through the private endpoints (data sent to the service, for example uploads to storage)? If unknown, suggest 100 GB and record it as an assumption.' },
    serviceEndpointVnets: { def: 0, int: true, min: 0, ask: 'Only if they use the Standard service endpoint preview (service endpoints that identify the virtual network with a public IP network identifier and a network security perimeter): how many virtual networks use it? Basic service endpoints and service endpoint policies are free and are not this. Most people need 0.' },
    hours: { def: 730, ask: 'Hours a month the endpoints exist (730 = all month). A partial hour is billed as a full hour.' }
  },
  context: ['production', 'privateOnly'],
  examples: [
    { type: 'private-link', privateEndpoints: 3 },
    { type: 'private-link', privateEndpoints: 25, inboundGB: 2000, outboundGB: 1500, serviceEndpointVnets: 2, hours: 730 },
    { type: 'private-link', privateEndpoints: 4, inboundGB: 1500000, outboundGB: 50, hours: 400 }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    const parts = [`${fmtN(n(c.privateEndpoints))} private endpoint(s), ${hrs === HOURS ? 'all month' : `${fmtN(hrs)} hours a month`}`];
    if (n(c.inboundGB)) parts.push(`${fmtN(c.inboundGB)} GB a month read through them (inbound)`);
    if (n(c.outboundGB)) parts.push(`${fmtN(c.outboundGB)} GB a month written through them (outbound)`);
    if (n(c.serviceEndpointVnets)) parts.push(`${fmtN(c.serviceEndpointVnets)} virtual network(s) using the Standard service endpoint (preview)`);
    return `Private Link: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The Azure service each endpoint connects to (storage, database...), billed on its own',
    'Private DNS zones so the service name resolves to the private address (see the dns component)',
    'Fixed Private Endpoint T1, a separate Retail meter that is not on the pricing page or calculator',
    'Private Link service Direct Connect, billed at $0.675 an hour per resource from October 15, 2026 (Learn) and not yet in the Retail API'
  ],
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    for (const k of ['privateEndpoints', 'inboundGB', 'outboundGB', 'serviceEndpointVnets']) if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    const gov = /^usgov/i.test(ctx.region || '');
    // US Gov has its own, higher, prices; every other region uses the regionless Global rows.
    const rs = await rows(`serviceName eq 'Virtual Network' and productName eq 'Virtual Network Private Link' and armRegionName eq '${gov ? 'US Gov' : 'Global'}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError('Private Link prices were not returned.');
    const m = (sku, name, what) => single(rs.filter(r => r.skuName === sku && r.meterName === name), `Private Link ${what}`);
    const G = 'Networking', S = 'Virtual Network', lines = [];
    lines.push(meterLine(G, S, `Private endpoints, ${fmtN(n(c.privateEndpoints))} x ${fmtN(hours)} hours`, m('Standard', 'Standard Private Endpoint', 'private endpoint'), n(c.privateEndpoints) * hours, ctx, { unit: 'endpoint-hours' }));
    if (n(c.inboundGB)) {
      const t = m('Standard', 'Standard Data Processed - Ingress', 'inbound data');
      lines.push(meterLine(G, S, `Inbound data processed (read through endpoints), ${fmtN(c.inboundGB)} GB${t.length > 1 ? ' (cheaper above 1 PB)' : ''}`, t, n(c.inboundGB), ctx, { unit: 'GB' }));
    }
    if (n(c.outboundGB)) {
      const t = m('Standard', 'Standard Data Processed - Egress', 'outbound data');
      lines.push(meterLine(G, S, `Outbound data processed (written through endpoints), ${fmtN(c.outboundGB)} GB${t.length > 1 ? ' (cheaper above 1 PB)' : ''}`, t, n(c.outboundGB), ctx, { unit: 'GB' }));
    }
    if (n(c.serviceEndpointVnets)) lines.push(meterLine(G, S, `Standard service endpoint (preview) virtual networks, ${fmtN(c.serviceEndpointVnets)} x ${fmtN(hours)} hours`, m('Standard Service Endpoint', 'Standard Service Endpoint Virtual Network', 'service endpoint virtual network'), n(c.serviceEndpointVnets) * hours, ctx, { unit: 'vnet-hours' }));
    const notes = [
      'Each private endpoint is billed per hour while it exists, and the data processed through it is billed per GB in the direction of the traffic: writing to a service uses outbound, reading from it uses inbound.' + (gov ? ' US Gov has a single flat per-GB price with no volume bands.' : ' Prices drop above 1 PB and 5 PB a month.'),
      (gov ? 'US Gov regions have their own, higher, Private Link prices.' : 'Private Link prices are the same in every commercial region (US Gov regions are priced higher).') + ' These are premiums on top of normal bandwidth: data transfer charges still apply. There is no charge for the Private Link service (the provider side) itself, except Private Link service Direct Connect resources, billed from October 15, 2026.'
    ];
    if (n(c.serviceEndpointVnets)) notes.push('The Standard service endpoint is a preview feature. Learn says it was free in July 2026 with billing expected after the preview announcement; the Retail API meter carries the $0.10 per virtual-network-hour price used here.');
    return { lines, notes, facts: { privateEndpoints: n(c.privateEndpoints), inboundGB: n(c.inboundGB), outboundGB: n(c.outboundGB), dataProcessedGB: n(c.inboundGB) + n(c.outboundGB), hours } };
  }
};
