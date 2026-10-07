'use strict';
// Azure Communications Gateway (Operator Connect, Teams Phone Mobile and similar carrier voice integrations).
// Meters: serviceName 'Voice Core' (not the product name), regionless (armRegionName 'Global'). The hourly service
// fee includes the first 999 users; further users are priced in bands that have their own meters (1,000-25,000 and
// 25,001+), so this module applies the bands itself. Sessions are priced per session per month. A lab deployment
// has its own hourly meter.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const INCLUDED_USERS = 999, BAND1_TOP = 25000;

module.exports = {
  type: 'communications-gateway',
  label: 'Azure Communications Gateway',
  family: 'telecom',
  calculator: ['communications-gateway'],
  keywords: ['communications gateway', 'operator connect', 'teams phone mobile', 'telecom', 'voice', 'carrier', 'sbc', 'telephony'],
  fields: {
    network: { def: 'fixed', enum: ['fixed', 'mobile'], ask: 'Will the gateway serve Teams Phone Mobile (a mobile network) at all? Yes, even alongside Operator Connect, Teams Direct Routing or Zoom Phone Cloud Peering -> mobile (a mixed deployment pays the mobile fee). Only Operator Connect, Direct Routing or Zoom Phone Cloud Peering -> fixed. If unknown, suggest fixed and record it as an assumption.' },
    users: { req: true, int: true, min: 0, ask: 'What is the peak number of telephone numbers assigned through the gateway in a month? Count users plus conferencing bridges, voice applications and third-party applications. The service fee already covers the first 999. If unknown, suggest 5,000 and record it as an assumption.' },
    sessions: { def: 0, int: true, min: 0, ask: 'Only if the customer\'s Microsoft quote lists a per-session (ACG Session) charge: how many session units does the quote show? Do not enter call counts. Use 0 otherwise.' },
    labs: { def: 0, int: true, min: 0, ask: 'How many separate lab (test) Communications Gateway deployments does the operator need next to production? Most need 0 or 1.' },
    labHours: { def: 730, min: 0, max: 744, ask: 'Lab deployments only: hours a month each lab exists (730 = all month).' },
    hours: { def: 730, min: 0, max: 744, ask: 'Hours a month the production gateway exists (730 = all month).' }
  },
  context: ['production'],
  examples: [
    { type: 'communications-gateway', users: 500 },
    { type: 'communications-gateway', network: 'mobile', users: 40000, sessions: 200, labs: 1, labHours: 400, hours: 730 }
  ],
  readback: c => {
    const hours = c.hours ?? HOURS;
    const parts = [`${fmtN(n(c.users))} subscribers`, hours === HOURS ? 'running all month' : `${fmtN(hours)} hours a month`];
    if (n(c.sessions)) parts.push(`${fmtN(c.sessions)} session units (as quoted)`);
    if (n(c.labs)) parts.push(`${fmtN(c.labs)} lab deployment(s), ${fmtN(c.labHours ?? HOURS)} hours a month each (lab fee includes 200 users)`);
    return `Communications Gateway (${c.network || 'fixed'} network): ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Azure networking the gateway needs: ExpressRoute circuits, virtual network peering and any third-party cross-connects for MAPS Voice',
    'The operator\'s own telecom network and number-range costs, and charges from the connected communications services (Teams, Zoom)'
  ],
  price: async (c, ctx) => {
    const network = (c.network || 'fixed').toLowerCase();
    if (!['fixed', 'mobile'].includes(network)) throw new PricingError('network must be fixed or mobile.');
    const mobile = network === 'mobile';
    if (/^(usgov|usdod|china|germany(north|central))/i.test(ctx.region || '')) throw new PricingError('Azure Communications Gateway is not offered in government or other sovereign-cloud regions; use a commercial region.');
    const users = n(c.users), sessions = n(c.sessions), labs = n(c.labs);
    const hours = c.hours ?? HOURS, labHours = c.labHours ?? HOURS;
    if (users < 0 || sessions < 0 || labs < 0) throw new PricingError('users, sessions and labs cannot be negative.');
    if (hours < 0 || hours > 744 || labHours < 0 || labHours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const rs = await rows(`serviceName eq 'Voice Core' and armRegionName eq 'Global' and priceType eq 'Consumption' and productName eq 'Azure Communications Gateway'`, ctx);
    if (!rs.length) throw new PricingError('Azure Communications Gateway has no price in the Retail Prices API.');
    const mt = (name, what) => single(rs.filter(r => r.meterName === name), `Communications Gateway ${what}`);
    const G = 'Networking', S = 'Voice Core', lines = [];
    lines.push(meterLine(G, S, `Communications Gateway ${mobile ? 'mobile' : 'fixed'} network service fee (includes the first ${INCLUDED_USERS} users), ${fmtN(hours)} hours`, mt(mobile ? 'Mobile Network Service Fee (includes 999 users)' : 'Fixed Network Service Fee (includes 999 users)', 'service fee'), hours, ctx, { unit: 'hours' }));
    const band1 = Math.max(0, Math.min(users, BAND1_TOP) - INCLUDED_USERS), band2 = Math.max(0, users - BAND1_TOP);
    if (band1) lines.push(meterLine(G, S, `Subscribers 1,000 to 25,000: ${fmtN(band1)} users above the ${INCLUDED_USERS} included`, mt('ACG User (tier 1000-25000)', 'users 1,000-25,000'), band1, ctx, { unit: 'users / month' }));
    if (band2) lines.push(meterLine(G, S, `Subscribers above 25,000: ${fmtN(band2)} users`, mt('ACG User (tier 25,001+)', 'users above 25,000'), band2, ctx, { unit: 'users / month' }));
    if (sessions) lines.push(meterLine(G, S, `Session units from the Microsoft quote (ACG Session), ${fmtN(sessions)} per month`, mt('ACG Session', 'sessions'), sessions, ctx, { unit: 'sessions / month' }));
    if (labs) lines.push(meterLine(G, S, `Lab deployment(s): ${fmtN(labs)} x ${fmtN(labHours)} hours`, mt('Lab ACG Lab', 'lab deployment'), labs * labHours, ctx, { unit: 'hours' }));
    const notes = [
      'The ACG Session meter exists in the price list but Microsoft does not publish what it counts; it is priced only when the quote lists it. Ask the Microsoft account team before using it.',
      'Per-user meters bill the peak number of assigned numbers for the whole billing cycle, not prorated by hours. A lab deployment includes 200 users; no price is published for lab users above that.',
      `The hourly network service fee covers the first ${INCLUDED_USERS} users. Users above that are billed per user per month in two price bands (1,000-25,000, then 25,001 and above); the estimate counts users 1,000 to 25,000 in the first band.`,
      'Azure Communications Gateway prices are the same in every region (the service is not regional in the Retail Prices API).'
    ];
    return { lines, notes, facts: { network, users, billedUsers: band1 + band2, sessions: sessions, labs, hours } };
  }
};
