'use strict';
// Azure Content Delivery Network, Standard from Microsoft (classic). Meters: serviceName 'Content Delivery Network',
// productName 'Azure CDN from Microsoft'. Prices are per pricing zone (armRegionName 'Zone 1'..'Zone 5'): Zone 1 is
// North America, Europe, Middle East and Africa; the zone is where the serving edge node is, not where the origin is.
// Azure CDN from Edgio/Verizon and from Akamai were retired and cannot be created, so they are refused here.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

// area name -> pricing zone number
const AREAS = {
  'north-america': 1, europe: 1, 'middle-east-africa': 1, 'asia-pacific': 2, 'south-america': 3, australia: 4, 'new-zealand': 4, india: 5
};
const ZONE_LABEL = { 1: 'Zone 1 (North America, Europe, Middle East and Africa)', 2: 'Zone 2 (Asia Pacific including Japan)', 3: 'Zone 3 (South America)', 4: 'Zone 4 (Australia and New Zealand)', 5: 'Zone 5 (India)' };

// "north-america:60,europe:30,asia-pacific:10" -> { 1: 90, 2: 10 }; a bare name means 100%.
function parseAudience(s) {
  const out = {};
  const parts = String(s || 'north-america').split(',').map(x => x.trim()).filter(Boolean);
  let total = 0;
  for (const p of parts) {
    const [name, pct] = p.split(':').map(x => x.trim().toLowerCase());
    const zone = AREAS[name];
    if (!zone) throw new PricingError(`Unknown viewer area "${name}". Use: ${Object.keys(AREAS).join(', ')} (for example "north-america:60,asia-pacific:40").`);
    const share = pct == null ? (parts.length === 1 ? 100 : NaN) : Number(pct);
    if (!(share > 0)) throw new PricingError(`Give a percentage for each viewer area, for example "${name}:60".`);
    out[zone] = (out[zone] || 0) + share;
    total += share;
  }
  if (Math.abs(total - 100) > 0.5) throw new PricingError(`Viewer area percentages add up to ${total}, not 100.`);
  return out;
}

// "north-america:60,europe:40" -> "60% North America, 40% Europe"
function describeAudience(s) {
  const parts = String(s || 'north-america').split(',').map(x => x.trim()).filter(Boolean);
  return parts.map(p => { const [name, pct] = p.split(':'); const label = name.trim().replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); return pct == null ? label : `${pct.trim()}% ${label}`; }).join(', ');
}

module.exports = {
  type: 'cdn',
  label: 'Azure Content Delivery Network (Standard from Microsoft, classic)',
  family: 'networking-edge',
  calculator: ['cdn'],
  keywords: ['cdn', 'content delivery', 'static content', 'edge caching', 'downloads', 'media delivery', 'azureedge'],
  fields: {
    provider: { def: 'microsoft', enum: ['microsoft', 'verizon', 'akamai'], ask: 'Do not ask. Always microsoft: Azure CDN from Edgio/Verizon and from Akamai are retired and cannot be priced. New projects should use the front-door component instead.' },
    egressGB: { req: true, min: 0, ask: 'Roughly how many GB a month will the CDN deliver to visitors (downloads, images, scripts, video)? If unknown, suggest 500 GB for a small site and record it as an assumption.' },
    audience: { def: 'north-america', ask: 'Where are the visitors? Give percentages by area, for example "north-america:60,europe:30,asia-pacific:10". Areas: north-america, europe, middle-east-africa, asia-pacific (includes Japan), south-america, australia, new-zealand, india. North America, Europe and Middle East/Africa cost the same (Zone 1). Default: all in north-america.' },
    rules: { def: 0, int: true, min: 0, ask: 'Only if they use the CDN rules engine to rewrite or redirect requests: how many rules in total? Five are free; each extra costs a monthly fee.' },
    rulesRequestsMillions: { def: 0, min: 0, ask: 'Only if they use the rules engine: millions of requests a month that the rules process.' }
  },
  context: ['production', 'internetFacing', 'multiRegionUsers'],
  examples: [
    { type: 'cdn', egressGB: 500 },
    { type: 'cdn', egressGB: 60000, audience: 'north-america:40,europe:30,asia-pacific:20,india:10', rules: 12, rulesRequestsMillions: 200 }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.egressGB))} GB a month delivered to visitors`];
    parts.push(`viewers: ${describeAudience(c.audience)}`);
    if (n(c.rules)) parts.push(`${fmtN(c.rules)} rules engine rule(s)`);
    if (n(c.rulesRequestsMillions)) parts.push(`${fmtN(c.rulesRequestsMillions)} million requests processed by rules`);
    return `Azure CDN Standard from Microsoft (classic): ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The storage or web server behind the CDN (the origin); data from an Azure origin to the CDN is free',
    'A web application firewall: WAF on CDN is charged separately per policy, rule and request (the preview is closed to new customers)',
    'Custom Dedicated IP (a separate $600-a-month Retail meter that is not on the pricing page or calculator)'
  ],
  price: async (c, ctx) => {
    const provider = (c.provider || 'microsoft').toLowerCase();
    if (provider === 'verizon') throw new PricingError('Azure CDN from Edgio (formerly Verizon) was retired on January 15, 2025 and cannot be priced. Use the front-door component (Azure Front Door Standard/Premium).');
    if (provider === 'akamai') throw new PricingError('Azure CDN from Akamai is retired and cannot be created. Use the front-door component (Azure Front Door Standard/Premium).');
    if (n(c.egressGB) < 0 || n(c.rules) < 0 || n(c.rulesRequestsMillions) < 0) throw new PricingError('Quantities cannot be negative.');
    const mix = parseAudience(c.audience);
    const gov = /^usgov/i.test(ctx.region || '');
    if (gov && Object.keys(mix).some(z => z !== '1')) throw new PricingError('In US Gov regions only the US Gov edge zone is priced; use north-america, europe or middle-east-africa for the audience.');
    // One query per zone and meter: de-duplication would otherwise drop a zone whose price equals another zone's.
    const inZone = (name, zone) => rows(`serviceName eq 'Content Delivery Network' and productName eq 'Azure CDN from Microsoft' and priceType eq 'Consumption' and armRegionName eq '${gov ? 'US Gov ' : ''}Zone ${zone}' and meterName eq '${name}'`, ctx);
    const G = 'Networking', S = 'Content Delivery Network', lines = [];
    for (const zone of Object.keys(mix).map(Number).sort()) {
      const gb = n(c.egressGB) * mix[zone] / 100;
      if (!gb) continue;
      const m = single(await inZone('Standard Data Transfer', zone), `CDN data transfer ${ZONE_LABEL[zone]}`);
      lines.push(meterLine(G, S, `CDN data delivered from ${ZONE_LABEL[zone]}, ${fmtN(gb)} GB (graduated by volume)`, m, gb, ctx, { unit: 'GB' }));
    }
    if (n(c.rules)) {
      const m = single(await inZone('Standard Rule', 1), 'CDN rules engine rules');
      lines.push(meterLine(G, S, `CDN rules engine rules, ${fmtN(c.rules)} rule(s)${gov ? '' : ' (first 5 free)'}`, m, n(c.rules), ctx, { unit: 'rules / month' }));
    }
    if (n(c.rulesRequestsMillions)) {
      const m = single(await inZone('Standard Requests', 1), 'CDN rules engine requests');
      lines.push(meterLine(G, S, `Requests processed by the CDN rules engine, ${fmtN(c.rulesRequestsMillions)} million/month`, m, n(c.rulesRequestsMillions) * 1e6, ctx, { unit: 'requests' }));
    }
    if (!lines.length) throw new PricingError('Nothing to price: set egressGB (GB delivered to visitors).');
    const over = Object.entries(mix).filter(([z, pct]) => n(c.egressGB) * pct / 100 > (z === '5' ? 500000 : 1000000));
    const notes = [
      'CDN data transfer is priced by the zone of the edge node that serves the visitor, not by the origin location, and is graduated by monthly volume (aggregated across the billing month). Zone 1 covers North America, Europe, Middle East and Africa.',
      'Azure CDN Standard from Microsoft (classic) cannot be created for new profiles since August 15, 2025 and retires on September 30, 2027; Azure CDN from Edgio (Verizon) was retired on January 15, 2025.'
    ];
    if (over.length) notes.push('The pricing page says "Contact us" for volumes above 1,000 TB a month in a zone (above 500 TB in Zone 5). The figure uses the Retail API list price for those bands, so ask Microsoft for a quote.');
    return { lines, notes, facts: { egressGB: n(c.egressGB), rules: n(c.rules), zones: Object.keys(mix).length, classic: true } };
  }
};
