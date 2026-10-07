'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'communications-gateway';
const HOURS = 730;
const INCLUDED_USERS = 999;
const TIER1_END = 25000;
const SERVICE_OFFER = { fixed: 'sbc-service', mobile: 'sbc-service-mobile-network' };
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, amount, extra = {}) { return { desc, monthlyList: round2(amount), ...extra }; }
async function productV3() { const res = await fetch(`https://azure.microsoft.com/api/v3/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!res.ok) throw new Error(`calculator v3 ${SLUG} HTTP ${res.status}`); return res.json(); }
async function priceV3(offer, armRegion, group) { const d = await productV3(); const slug = calc.calcRegion(d, armRegion); const p = d.offers[offer]?.prices?.[group]?.[slug]; if (!p) throw new Error(`communications-gateway calculator v3 missing ${offer}/${group}/${slug}`); return p.value; }
async function retailRows(currency) { return dedupe(await query(`serviceName eq 'Voice Core' and productName eq 'Azure Communications Gateway' and armRegionName eq 'Global'`, currency)); }
async function retailSession(currency) { const rows = await retailRows(currency); const hit = rows.find(r => r.meterName === 'ACG Session'); if (!hit) throw new Error(`Communications Gateway ${currency} ACG Session row not found`); return hit; }
async function calculatorCommunicationsGateway(opts) {
  const { region, network = 'fixed', users, sessions = 0, labs = 0, labHours = HOURS, hours = HOURS } = opts;
  const lines = [];
  const serviceRate = await priceV3(SERVICE_OFFER[network], region, 'perhour');
  lines.push(line(`${network} network service fee includes ${INCLUDED_USERS} users: ${hours} hours * ${serviceRate}`, hours * serviceRate, { sourceOffer: SERVICE_OFFER[network] }));
  const tier1Users = Math.max(0, Math.min(users, TIER1_END) - INCLUDED_USERS);
  if (tier1Users) { const r = await priceV3('sbc-user-tier1', region, 'permonth'); lines.push(line(`Users 1,000-25,000: ${tier1Users} users * ${r}/month`, tier1Users * r, { sourceOffer: 'sbc-user-tier1' })); }
  const tier2Users = Math.max(0, users - TIER1_END);
  if (tier2Users) { const r = await priceV3('sbc-user-tier2', region, 'permonth'); lines.push(line(`Users 25,001+: ${tier2Users} users * ${r}/month`, tier2Users * r, { sourceOffer: 'sbc-user-tier2' })); }
  if (sessions) { const session = await retailSession('USD'); lines.push(line(`Retail API ACG sessions: ${sessions} sessions * ${session.retailPrice}/month`, sessions * session.retailPrice, { meterId: session.meterId })); }
  if (labs) { const labRate = await priceV3('sbc-lab', region, 'perhour'); lines.push(line(`Lab deployments: ${labs} labs * ${labHours} hours * ${labRate}`, labs * labHours * labRate, { sourceOffer: 'sbc-lab' })); }
  return { monthlyList: totalOf(lines), lines };
}
async function retailCommunicationsGatewayEur() {
  const rows = await retailRows('EUR');
  const pick = (meterName) => { const hit = rows.find(r => r.meterName === meterName); if (!hit) throw new Error(`Communications Gateway EUR row not found: ${meterName}`); return hit; };
  const service = pick('Mobile Network Service Fee (includes 999 users)'), tier1 = pick('ACG User (tier 1000-25000)'), tier2 = pick('ACG User (tier 25,001+)'), session = pick('ACG Session'), lab = (rows.find(r => r.meterName === 'ACG Lab' || r.meterName === 'Lab ACG Lab') || (() => { throw new Error('Communications Gateway EUR row not found: ACG Lab'); })());
  const tier1Users = TIER1_END - INCLUDED_USERS;
  const lines = [line(`Retail API mobile service fee: 100 hours * ${service.retailPrice}`, 100 * service.retailPrice, { meterId: service.meterId }), line(`Retail API tier1 users: ${tier1Users} users * ${tier1.retailPrice}`, tier1Users * tier1.retailPrice, { meterId: tier1.meterId }), line(`Retail API tier2 users: 1 user * ${tier2.retailPrice}`, tier2.retailPrice, { meterId: tier2.meterId }), line(`Retail API sessions: 10 sessions * ${session.retailPrice}`, 10 * session.retailPrice, { meterId: session.meterId }), line(`Retail API lab: 1 lab * 50 hours * ${lab.retailPrice}`, 50 * lab.retailPrice, { meterId: lab.meterId })];
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'communications-gateway', source: 'both', cases: [
  { name: 'fixed network included users boundary', region: 'eastus2', currency: 'USD', component: { type: 'communications-gateway', network: 'fixed', users: 999 },
    // Calculator v3 fixed network service fee is hourly and includes the first 999 users, so no user overage is added.
    expected: async () => calculatorCommunicationsGateway({ region: 'eastus2', network: 'fixed', users: 999 }) },
  { name: 'fixed network first billable user', region: 'eastus2', currency: 'USD', component: { type: 'communications-gateway', network: 'fixed', users: 1000 },
    // Calculator v3 sbc-user-tier1 bills user 1000 and above; service fee still covers users 1-999.
    expected: async () => calculatorCommunicationsGateway({ region: 'eastus2', network: 'fixed', users: 1000 }) },
  { name: 'mobile network tier2 boundary', region: 'eastus2', currency: 'USD', component: { type: 'communications-gateway', network: 'mobile', users: 25001 },
    // Calculator v3 mobile service fee plus 24,001 tier1 users and one tier2 user beyond 25,000.
    expected: async () => calculatorCommunicationsGateway({ region: 'eastus2', network: 'mobile', users: 25001 }) },
  { name: 'sessions and lab part-time', region: 'eastus2', currency: 'USD', component: { type: 'communications-gateway', network: 'fixed', users: 1500, sessions: 10, labs: 1, labHours: 50, hours: 100 },
    // Calculator v3 handles service/users/lab offers; ACG Session is only present in Retail API and is per session-month.
    expected: async () => calculatorCommunicationsGateway({ region: 'eastus2', network: 'fixed', users: 1500, sessions: 10, labs: 1, labHours: 50, hours: 100 }) },
  { name: 'west europe fixed non-us', region: 'westeurope', currency: 'USD', component: { type: 'communications-gateway', network: 'fixed', users: 5000 },
    // Calculator v3 West Europe prices the fixed service fee and tier1 users, covering a non-US region.
    expected: async () => calculatorCommunicationsGateway({ region: 'westeurope', network: 'fixed', users: 5000 }) },
  { name: 'eur retail mobile tiers sessions and lab', region: 'eastus2', currency: 'EUR', component: { type: 'communications-gateway', network: 'mobile', users: 25001, sessions: 10, labs: 1, labHours: 50, hours: 100 },
    // Retail API EUR global rows: mobile service fee, tier1/tier2 user meters, ACG Session, and ACG Lab.
    expected: async () => retailCommunicationsGatewayEur() },
] };

