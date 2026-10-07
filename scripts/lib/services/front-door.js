'use strict';
// Azure Front Door Standard and Premium. Meters: serviceName 'Azure Front Door Service', productName 'Azure Front Door'
// (the older 'Azure Front Door Service' product is Front Door classic, which cannot be created any more).
// Prices are per pricing zone (armRegionName 'Zone 1'..'Zone 8') of the edge location that serves the request:
// base fee per profile, requests per 10,000, data out to the client (graduated) and data from the edge to the origin.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

const AREAS = {
  'north-america': 1, 'asia-pacific': 2, 'south-america': 3, australia: 4, india: 5, europe: 6, 'middle-east-africa': 7, korea: 8
};
const ZONE_LABEL = { 1: 'Zone 1 (North America)', 2: 'Zone 2 (Asia Pacific including Japan)', 3: 'Zone 3 (South America)', 4: 'Zone 4 (Australia)', 5: 'Zone 5 (India)', 6: 'Zone 6 (Europe)', 7: 'Zone 7 (Middle East and Africa)', 8: 'Zone 8 (Korea)' };

// "north-america:60,europe:30,asia-pacific:10" -> { 1: 60, 6: 30, 2: 10 }; a bare name means 100%.
function parseAudience(s) {
  const out = {};
  const parts = String(s || 'north-america').split(',').map(x => x.trim()).filter(Boolean);
  let total = 0;
  for (const p of parts) {
    const [name, pct] = p.split(':').map(x => x.trim().toLowerCase());
    const zone = AREAS[name];
    if (!zone) throw new PricingError(`Unknown viewer area "${name}". Use: ${Object.keys(AREAS).join(', ')} (for example "north-america:60,europe:40").`);
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
  type: 'front-door',
  label: 'Azure Front Door (Standard and Premium)',
  family: 'networking-edge',
  calculator: ['frontdoor-standard-premium'],
  keywords: ['front door', 'cdn', 'global load balancer', 'waf', 'web application firewall', 'content delivery', 'edge', 'website acceleration'],
  fields: {
    tier: { def: 'standard', enum: ['standard', 'premium'], ask: 'Do they need the Microsoft-managed WAF rule sets, bot protection or Private Link connections to the origin? Yes -> premium; if they only need delivery, caching, custom domains and custom WAF rules -> standard.' },
    profiles: { def: 1, int: true, min: 1, ask: 'How many Front Door profiles (a profile holds many endpoints and websites; one is usually enough)?' },
    egressGB: { req: true, ask: 'Roughly how many GB a month will Front Door send to visitors (pages, images, downloads, API responses, after compression)? If unknown, suggest 500 GB for a small site and record it as an assumption.' },
    requestsMillions: { req: true, ask: 'Roughly how many millions of requests a month will visitors make to Front Door? Cached and uncached requests both count, and requests blocked by the WAF too. If unknown, suggest 10 and record it as an assumption.' },
    originGB: { def: 0, ask: 'How many GB a month does Front Door send to your origin (the cache misses and uploads, usually much less than what it sends to visitors)? If unknown and caching is used, suggest 20% of the GB sent to visitors and record it as an assumption.' },
    audience: { def: 'north-america', ask: 'Where are the visitors? Give percentages by area, for example "north-america:60,europe:30,asia-pacific:10". Areas: north-america, europe, middle-east-africa, asia-pacific (includes Japan), south-america, australia, india, korea. Default: all in north-america.' },
    captchaSessionsThousands: { def: 0, ask: 'Premium only, only if the WAF shows CAPTCHA challenges: thousands of CAPTCHA sessions a month.' },
    edgeActionInvocationsMillions: { def: 0, ask: 'Only if they run Edge actions (custom code in the rules engine): millions of invocations a month.' },
    edgeActionOverageSeconds: { def: 0, ask: 'Only with Edge actions: total seconds a month of execution time beyond the first millisecond of each invocation (for example 20 million calls that each run 3 ms use 20 million x 2 ms = 40,000 seconds).' },
    hours: { def: 730, ask: 'Hours a month each profile exists (730 = all month); the base fee is prorated by the hour.' }
  },
  context: ['production', 'internetFacing', 'multiRegionUsers'],
  examples: [
    { type: 'front-door', egressGB: 500, requestsMillions: 10 },
    { type: 'front-door', tier: 'premium', profiles: 2, egressGB: 60000, requestsMillions: 900, originGB: 12000, audience: 'north-america:40,europe:35,asia-pacific:15,india:10', captchaSessionsThousands: 50, edgeActionInvocationsMillions: 50, edgeActionOverageSeconds: 180000, hours: 730 }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    const parts = [`${fmtN(n(c.profiles) || 1)} profile(s), ${hrs === HOURS ? 'all month' : `${fmtN(hrs)} hours a month`}`];
    parts.push(`${fmtN(n(c.egressGB))} GB a month sent to visitors`);
    parts.push(`${fmtN(n(c.requestsMillions))} million requests a month`);
    if (n(c.originGB)) parts.push(`${fmtN(c.originGB)} GB a month sent to the origin`);
    parts.push(`visitors: ${describeAudience(c.audience)}`);
    if (n(c.captchaSessionsThousands)) parts.push(`${fmtN(c.captchaSessionsThousands)} thousand CAPTCHA sessions`);
    if (n(c.edgeActionInvocationsMillions)) parts.push(`${fmtN(c.edgeActionInvocationsMillions)} million Edge action invocations`);
    if (n(c.edgeActionOverageSeconds)) parts.push(`${fmtN(c.edgeActionOverageSeconds)} seconds of Edge action overage execution time`);
    return `Front Door ${c.tier || 'standard'}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The origin (web app, storage, API) behind Front Door; data from an Azure origin to Front Door is free',
    'Private Link connection costs to the origin are included in Premium, but the origin service itself is billed separately'
  ],
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!['standard', 'premium'].includes(tier)) throw new PricingError(`Unknown Front Door tier "${c.tier}". Use standard or premium.`);
    const sku = tier === 'premium' ? 'Premium' : 'Standard';
    const profiles = c.profiles == null ? 1 : n(c.profiles);
    const hours = c.hours ?? HOURS;
    if (profiles < 1) throw new PricingError('profiles must be at least 1.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    for (const k of ['egressGB', 'requestsMillions', 'originGB', 'captchaSessionsThousands', 'edgeActionInvocationsMillions', 'edgeActionOverageSeconds']) if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    if (sku === 'Standard' && n(c.captchaSessionsThousands)) throw new PricingError('CAPTCHA sessions are part of the Premium WAF; use tier "premium".');
    const mix = parseAudience(c.audience);
    const gov = /^usgov/i.test(ctx.region || '');
    if (gov && (n(c.captchaSessionsThousands) || n(c.edgeActionInvocationsMillions) || n(c.edgeActionOverageSeconds))) throw new PricingError('CAPTCHA sessions and Edge actions have no published US Gov price, so they cannot be priced in US Gov regions.');
    if (gov && Object.keys(mix).some(z => z !== '1')) throw new PricingError('In US Gov regions only the US Gov edge zone is priced; use north-america for the audience.');
    const f = `serviceName eq 'Azure Front Door Service' and productName eq 'Azure Front Door' and skuName eq '${sku}' and priceType eq 'Consumption'`;
    // One query per meter and zone: de-duplication would otherwise drop a zone whose price equals another zone's.
    const zoneRows = (meter, zone) => rows(`${f} and meterName eq '${sku} ${meter}' and armRegionName eq '${gov ? 'US Gov ' : ''}Zone ${zone}'`, ctx);
    const G = 'Networking', S = 'Azure Front Door', lines = [];
    // The base fee is the same in every non-government zone; one profile is billed once.
    const base = [];
    for (let z = 1; z <= (gov ? 1 : 8); z++) base.push(...await zoneRows('Base Fees', z));
    lines.push(meterLine(G, S, `Front Door ${sku} base fee, ${fmtN(profiles)} profile(s) x ${fmtN(hours)} hours`, single(base, `Front Door ${sku} base fee`), profiles * hours / HOURS, ctx, { unit: 'profile-months' }));
    for (const zone of Object.keys(mix).map(Number).sort()) {
      const share = mix[zone] / 100;
      const where = ` in ${ZONE_LABEL[zone]}`;
      const req = n(c.requestsMillions) * 1e6 * share;
      if (req) lines.push(meterLine(G, S, `${sku} requests${where}, ${fmtN(n(c.requestsMillions) * share)} million`, single(await zoneRows('Requests', zone), `Front Door ${sku} requests ${ZONE_LABEL[zone]}`), req, ctx, { unit: 'requests' }));
      const out = n(c.egressGB) * share;
      if (out) {
        const m = single(await zoneRows('Data Transfer Out', zone), `Front Door ${sku} data transfer out ${ZONE_LABEL[zone]}`);
        lines.push(meterLine(G, S, `Data sent to visitors${where}, ${fmtN(out)} GB${m.length > 1 ? ' (graduated by volume)' : ''}`, m, out, ctx, { unit: 'GB' }));
      }
      const org = n(c.originGB) * share;
      if (org) lines.push(meterLine(G, S, `Data sent from the edge to the origin${where}, ${fmtN(org)} GB`, single(await zoneRows('Data Transfer In', zone), `Front Door ${sku} data transfer in ${ZONE_LABEL[zone]}`), org, ctx, { unit: 'GB' }));
    }
    // Premium WAF add-ons and Edge actions are billed globally; every zone carries the same price.
    const anyZone = async (meter, what) => {
      const all = [];
      for (let z = 1; z <= (gov ? 1 : 8); z++) all.push(...await zoneRows(meter, z));
      return single(all, `Front Door ${what}`);
    };
    if (n(c.captchaSessionsThousands)) lines.push(meterLine(G, S, `WAF CAPTCHA sessions, ${fmtN(c.captchaSessionsThousands)} thousand`, await anyZone('Captcha Sessions', 'CAPTCHA sessions'), n(c.captchaSessionsThousands) * 1000, ctx, { unit: 'sessions' }));
    if (n(c.edgeActionInvocationsMillions)) lines.push(meterLine(G, S, `Edge action invocations, ${fmtN(c.edgeActionInvocationsMillions)} million`, await anyZone('Invocations', 'Edge action invocations'), n(c.edgeActionInvocationsMillions) * 1e6, ctx, { unit: 'invocations' }));
    if (n(c.edgeActionOverageSeconds)) lines.push(meterLine(G, S, `Edge action overage execution time, ${fmtN(c.edgeActionOverageSeconds)} seconds`, await anyZone('Overage Execution Time', 'Edge action overage execution time'), n(c.edgeActionOverageSeconds), ctx, { unit: 'seconds' }));
    const edge = n(c.edgeActionInvocationsMillions) || n(c.edgeActionOverageSeconds);
    const notes = [
      'The base fee is per profile (not per endpoint) and is prorated by the hour. Requests, data to visitors and data to the origin are billed by the zone of the Front Door edge location that serves the visitor, not by the origin location.',
      'Data from an Azure origin back to Front Door is free. Data to visitors is graduated by monthly volume; cached responses cost no origin traffic. Custom WAF rules and the rules engine are included; Premium also includes the managed WAF rule sets and Private Link origins.',
      'Front Door (classic) is not priced here: it cannot be created for new profiles and retires on March 31, 2027.'
    ];
    if (edge) notes.push('Edge actions are a preview feature. Microsoft also lists a $0.10-a-month Edge Actions base fee meter that is not on the pricing page or calculator; it is not included here.');
    return { lines, notes, facts: { originPct: n(c.egressGB) ? Math.round(n(c.originGB) / n(c.egressGB) * 100) : 0, tier, profiles, egressGB: n(c.egressGB), requestsMillions: n(c.requestsMillions), originGB: n(c.originGB), zones: Object.keys(mix).length, hours } };
  }
};
