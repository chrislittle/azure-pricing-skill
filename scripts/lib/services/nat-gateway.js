'use strict';
// Azure NAT Gateway (Standard and StandardV2): hourly gateway charge, data processed per GB, and the optional
// StandardV2 flow logs flat fee. Meters: serviceName 'NAT Gateway', regionless (Global). Standard and StandardV2
// share the same gateway and data prices (StandardV2 only has its own flow-logs meter).
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'nat-gateway',
  label: 'Azure NAT Gateway',
  family: 'networking-core',
  calculator: ['virtual-network-nat'],
  keywords: ['nat gateway', 'outbound internet', 'snat', 'outbound connectivity', 'port exhaustion', 'static outbound ip'],
  fields: {
    gateways: { req: true, int: true, min: 1, ask: 'How many NAT gateways? One gateway serves all the subnets that use it in a virtual network; usually one per virtual network or per region.' },
    sku: { def: 'standard', enum: ['standard', 'standardv2'], ask: 'Must the outbound connection survive an availability-zone outage? Yes -> standardv2 (zone-redundant, same price); otherwise standard.' },
    dataProcessedGB: { req: true, min: 0, ask: 'Roughly how many GB a month go out to the internet through the gateway, plus the replies coming back? Both directions of those connections are counted. If unknown, suggest 500 GB and record it as an assumption.' },
    flowLogs: { def: false, ask: 'Only for standardv2: will they turn on NAT gateway flow logs? true or false.' },
    hours: { def: 730, int: true, min: 0, max: 744, ask: 'Hours a month each gateway exists (730 = all month; it bills while it exists even with no traffic or no subnets attached; a partial hour counts as a full hour, so give whole hours).' }
  },
  context: ['production', 'internetFacing', 'zoneResilience'],
  examples: [
    { type: 'nat-gateway', gateways: 1, dataProcessedGB: 500 },
    { type: 'nat-gateway', gateways: 3, sku: 'standardv2', dataProcessedGB: 4000, flowLogs: true, hours: 730 }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    const parts = [`${fmtN(n(c.gateways))} gateway(s), ${hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month`}`];
    parts.push(`${fmtN(n(c.dataProcessedGB))} GB a month processed (outbound plus replies)`);
    if (c.flowLogs) parts.push('with flow logs turned on');
    return `NAT Gateway ${c.sku === 'standardv2' ? 'StandardV2 (zone-redundant)' : 'Standard'}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The public IP addresses or prefixes attached to the gateway (see the public-ip component; StandardV2 gateways need StandardV2 public IPs)',
    'Where flow logs are sent (Log Analytics, storage account or Event Hubs), billed on its own',
    'Outbound internet bandwidth (data transfer out), billed in addition to NAT Gateway data processing'
  ],
  price: async (c, ctx) => {
    const sku = (c.sku || 'standard').toLowerCase();
    if (!['standard', 'standardv2'].includes(sku)) throw new PricingError(`Unknown NAT gateway sku "${c.sku}". Use standard or standardv2.`);
    const gateways = n(c.gateways);
    const hours = c.hours ?? HOURS;
    if (gateways < 1) throw new PricingError('gateways must be at least 1.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (n(c.dataProcessedGB) < 0) throw new PricingError('dataProcessedGB cannot be negative.');
    if (c.flowLogs && sku !== 'standardv2') throw new PricingError('NAT gateway flow logs are a StandardV2 feature; use sku "standardv2".');
    const gov = /^usgov/i.test(ctx.region || '');
    if (gov && c.flowLogs) throw new PricingError('NAT gateway flow logs have no published price in US Gov regions, so they cannot be priced here. Remove flowLogs or estimate them separately.');
    if (sku === 'standardv2' && ['canadaeast', 'indiasouthcentral', 'swedensouth', 'westindia'].includes(ctx.region)) throw new PricingError('NAT Gateway StandardV2 is not available in Canada East, India South Central, Sweden South or West India. Use sku standard or another region.');
    // US Gov has its own, higher, gateway and data prices; every other region uses the regionless Global rows.
    const rs = await rows(`serviceName eq 'NAT Gateway' and armRegionName eq '${gov ? 'US Gov' : 'Global'}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError('NAT Gateway prices were not returned.');
    const m = (name, what) => single(rs.filter(r => r.meterName === name), `NAT Gateway ${what}`);
    const G = 'Networking', S = 'NAT Gateway', lines = [];
    lines.push(meterLine(G, S, `NAT gateway ${sku === 'standardv2' ? 'StandardV2' : 'Standard'}, ${fmtN(gateways)} gateway(s) x ${fmtN(hours)} hours`, m('Standard Gateway', 'gateway hours'), gateways * hours, ctx, { unit: 'hours' }));
    if (n(c.dataProcessedGB)) lines.push(meterLine(G, S, `Data processed (outbound plus returning replies), ${fmtN(c.dataProcessedGB)} GB`, m('Standard Data Processed', 'data processed'), n(c.dataProcessedGB), ctx, { unit: 'GB' }));
    if (c.flowLogs) lines.push(meterLine(G, S, `StandardV2 flow logs, ${fmtN(gateways)} gateway(s) x ${fmtN(hours)} hours`, m('StandardV2 Log Enabled', 'flow logs'), gateways * Math.min(1, hours / 720), ctx, { unit: 'gateway-months' }));
    const notes = [
      ...(gov ? ['US Gov regions use the US Gov NAT Gateway prices, which are higher than commercial.'] : []),
      'The gateway is billed per hour from the moment it is created (a partial hour counts as a full hour), whether or not subnets or public IPs are attached. All outbound data and the returning replies are billed per GB.',
      'Standard and StandardV2 cost the same; StandardV2 adds zone redundancy. Outbound bandwidth charges apply on top of NAT Gateway data processing.'
    ];
    if (c.flowLogs) notes.push('Flow logs are a flat monthly fee, prorated hourly against a 720-hour month.');
    return { lines, notes, facts: { sku, gateways, dataProcessedGB: n(c.dataProcessedGB), flowLogs: !!c.flowLogs, hours } };
  }
};
