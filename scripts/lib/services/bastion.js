'use strict';
// Azure Bastion (Basic, Standard, Premium). The Developer SKU is free and has no Retail Prices API meter.
// Meters: serviceName 'Azure Bastion', regional. Gateway hours per host (Standard and Premium include 2 instances),
// additional instance hours, and outbound data transfer in graduated bands (first 5 GB free).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const TIERS = { basic: 'Basic', standard: 'Standard', premium: 'Premium' };

const bastionNotes = spec => {
  const comps = ((spec && spec.options) || []).map(o => (o.components || []).filter(c => c.type === 'bastion'));
  const out = [];
  if (comps.some(cs => cs.some(c => (c.tier || 'standard') === 'premium'))) out.push('Premium session recordings are stored in a blob storage container you own, which is priced separately.');
  if (comps.some(cs => new Set(cs.map(c => c.tier || 'standard')).size > 1)) out.push('This option mixes Bastion SKUs: each SKU has its own free first 5 GB of outbound data.');
  return out;
};

module.exports = {
  type: 'bastion',
  label: 'Azure Bastion',
  family: 'network-security',
  calculator: ['azure-bastion'],
  keywords: ['bastion', 'jump box', 'rdp', 'ssh', 'secure remote access', 'remote desktop to vm', 'jump host'],
  fields: {
    tier: { req: true, def: 'standard', enum: ['basic', 'standard', 'premium'], ask: 'How will people connect to the virtual machines? Occasional RDP/SSH from the browser, fixed capacity -> basic. Needs more simultaneous sessions, file upload/download, native client or shareable links -> standard. Also needs recording of sessions or private-only deployment -> premium. If unknown, suggest standard and record it as an assumption. (The free Developer SKU connects to one VM at a time for dev/test: if that is enough, no component is needed.)' },
    additionalInstances: { int: true, min: 0, max: 48, def: 0, ask: 'Only for standard or premium: how many extra instances (scale units) beyond the 2 that are included? Each instance handles about 20 concurrent RDP sessions, so add 1 instance per 20 sessions beyond the first 40. If unknown, suggest 0 and record it as an assumption.' },
    outboundGB: { def: 0, ask: 'Roughly how many GB a month of data leave Azure through the Bastion sessions (screen data sent to people)? The first 5 GB a month are free and most remote-admin use is only a few GB. If unknown, use 0 and record it as an assumption (the first 5 GB are free anyway).' },
    hosts: { int: true, min: 1, max: 500, def: 1, ask: 'How many Bastion hosts will they deploy? One host can serve all peered virtual networks; use 1 unless they need separate regions or isolated networks.' },
    hours: { def: 730, ask: 'How many hours a month does each Bastion host exist? 730 = all month; it is billed from deployment until it is deleted, whether or not anyone is connected.' }
  },
  context: ['production'],
  examples: [
    { type: 'bastion', tier: 'basic', outboundGB: 10 },
    { type: 'bastion', tier: 'standard', additionalInstances: 3, outboundGB: 200, hosts: 2, hours: 500 },
    { type: 'bastion', tier: 'premium', additionalInstances: 1, outboundGB: 12000 }
  ],
  readback: c => {
    const tier = c.tier || 'standard';
    const hrs = c.hours ?? HOURS;
    const parts = [`${fmtN(c.hosts ?? 1)} host(s), ${hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month each`}`];
    if (n(c.additionalInstances)) parts.push(`${fmtN(c.additionalInstances)} extra instance(s) per host beyond the 2 included`);
    parts.push(`${fmtN(n(c.outboundGB))} GB of outbound data a month`);
    return `Azure Bastion ${tier}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    ...(types.has('public-ip') ? [] : ['The Standard public IP address a Bastion host requires (unless Premium private-only) is priced separately.']),
    ...bastionNotes(spec),
    'Virtual machines being reached and the AzureBastionSubnet virtual network are priced separately.'
  ],
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!TIERS[tier]) throw new PricingError('tier must be basic, standard or premium (the free Developer SKU needs no component).');
    const sku = TIERS[tier];
    const extra = n(c.additionalInstances), hosts = c.hosts ?? 1, hours = c.hours ?? HOURS, gb = n(c.outboundGB);
    if (tier === 'basic' && extra > 0) throw new PricingError('The Basic tier has a fixed 2 instances; extra instances need standard or premium.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (extra > 48) throw new PricingError('A Bastion host supports at most 50 instances (2 included + 48 additional).');
    const rs = await rows(`serviceName eq 'Azure Bastion' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const m = (name, what) => {
      const hit = rs.filter(r => r.meterName === name);
      if (!hit.length) throw new PricingError(`Azure Bastion ${sku} (${what}) is not priced in ${ctx.region}; try another tier (basic, standard or premium) or a nearby region.`);
      return single(hit, `Azure Bastion ${sku} ${what}`);
    };
    const G = 'Networking', S = 'Azure Bastion', lines = [];
    lines.push(meterLine(G, S, `Azure Bastion ${sku}: ${fmtN(hosts)} host(s) x ${fmtN(hours)} hours (2 instances included)`, m(`${sku} Gateway`, 'gateway'), hosts * hours, ctx, { unit: 'hours' }));
    if (extra) lines.push(meterLine(G, S, `Azure Bastion ${sku}: ${fmtN(extra)} additional instance(s) x ${fmtN(hosts)} host(s) x ${fmtN(hours)} hours`, m(`${sku} Additional Gateway`, 'additional instance'), extra * hosts * hours, ctx, { unit: 'hours' }));
    if (gb > 0) {
      const out = m(`${sku} Data Transfer Out`, 'outbound data');
      const free = out.length > 1 && Number(out[0].retailPrice) === 0;
      lines.push(meterLine(G, S, `Azure Bastion ${sku}: outbound data transfer, ${fmtN(gb)} GB/month${free ? ' (graduated, first 5 GB free)' : ''}`, out, gb, ctx, { unit: 'GB' }));
    }
    const notes = [
      'Azure Bastion bills hourly from the moment a host is deployed until it is deleted, whether or not anyone is connected.',
      'Outbound data is billed per GB in graduated bands; the first 5 GB a month are free per Bastion SKU where that band is priced at 0.'
    ];
    if (gb > 153600) notes.push('Outbound volumes above 150 TB a month are not on the price list ("Contact us"); this estimate prices only the listed bands.');
    if (tier !== 'basic') notes.push('Standard and Premium start with 2 instances in the hourly price; additional instances are billed per instance-hour.');
    else notes.push('The Basic tier runs a fixed 2 instances.');
    return { lines, notes, facts: { tier, hosts, hours, additionalInstances: extra, outboundGB: gb } };
  }
};
