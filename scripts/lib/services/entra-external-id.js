'use strict';
// Microsoft Entra External ID (customer / guest identity billed by monthly active users) and its add-ons.
// Meters: serviceName 'Microsoft Entra', productName 'Microsoft Entra External ID', global (armRegionName 'Global').
// Core and Basic MAU have a graduated free first band (50,000 MAU); add-ons and transactions have no free band.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

const SMS = {
  smsLowCostCountries: ['Phone Authentication Low Cost', 'low-cost'],
  smsMidLowCostCountries: ['Phone Authentication Mid Low Cost', 'mid-low-cost'],
  smsMidHighCostCountries: ['Phone Authentication Mid High Cost', 'mid-high-cost'],
  smsHighCostCountries: ['Phone Authentication High Cost', 'high-cost']
};
const smsAsk = band => `Only if multifactor (MFA) or self-service password-reset codes are sent by text message (not ordinary sign-in): how many text messages a month go to phone numbers in ${band} countries? Microsoft groups countries into four cost bands (low, mid-low, mid-high, high) on the External ID pricing page; if the countries are unknown, put the whole volume in mid-high and record it as an assumption.`;

module.exports = {
  type: 'entra-external-id',
  label: 'Microsoft Entra External ID',
  family: 'identity',
  calculator: ['microsoft-entra-external-id'],
  keywords: ['customer identity', 'consumer sign-in', 'ciam', 'external users', 'guest users', 'b2b', 'b2c', 'monthly active users', 'social login', 'sms authentication'],
  fields: {
    tier: { def: 'basic', enum: ['basic', 'core'], ask: 'Do they have a specific External ID agreement or price quote that says Core? If not, use basic (the plan Microsoft publishes) and record it as an assumption; only if they volunteer Core, set core.' },
    monthlyActiveUsers: { req: true, int: true, min: 0, ask: 'How many different customers or guest users sign in to your apps in a month (monthly active users)? The first 50,000 a month are free. If unknown, suggest 10,000 and record it as an assumption.' },
    goLocalUsers: { def: 0, int: true, min: 0, ask: 'Only if customer identity data must be stored in Australia or Japan for data residency: how many monthly active users need that? Otherwise 0.' },
    idGovernanceGuests: { def: 0, int: true, min: 0, ask: 'Only if guests in a workforce tenant are managed with Microsoft Entra ID Governance (for example access reviews): how many guest users a month? Otherwise 0.' },
    gsaGuests: { def: 0, int: true, min: 0, ask: 'Only if guests in a workforce tenant use Global Secure Access: how many guest users a month? Otherwise 0.' },
    smsLowCostCountries: { def: 0, int: true, min: 0, ask: smsAsk('low-cost') },
    smsMidLowCostCountries: { def: 0, int: true, min: 0, ask: smsAsk('mid-low-cost') },
    smsMidHighCostCountries: { def: 0, int: true, min: 0, ask: smsAsk('mid-high-cost') },
    smsHighCostCountries: { def: 0, int: true, min: 0, ask: smsAsk('high-cost') },
    m2mTokens: { def: 0, int: true, min: 0, ask: 'Only if background services or scripts sign in as themselves (no person involved, OAuth client credentials): how many tokens do they request a month? A service refreshing hourly is about 720. Otherwise 0.' }
  },
  context: [],
  examples: [
    { type: 'entra-external-id', monthlyActiveUsers: 120000 },
    {
      type: 'entra-external-id', tier: 'core', monthlyActiveUsers: 200000, goLocalUsers: 30000, idGovernanceGuests: 2000, gsaGuests: 500,
      smsLowCostCountries: 40000, smsMidLowCostCountries: 20000, smsMidHighCostCountries: 10000, smsHighCostCountries: 1000, m2mTokens: 5000000
    }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.monthlyActiveUsers))} monthly active users (first 50,000 free)`];
    if (n(c.goLocalUsers)) parts.push(`${fmtN(c.goLocalUsers)} users with data stored in Australia or Japan (Go-Local)`);
    if (n(c.idGovernanceGuests)) parts.push(`${fmtN(c.idGovernanceGuests)} guests under ID Governance`);
    if (n(c.gsaGuests)) parts.push(`${fmtN(c.gsaGuests)} guests using Global Secure Access`);
    for (const [k, [, band]] of Object.entries(SMS)) if (n(c[k])) parts.push(`${fmtN(c[k])} SMS messages to ${band} countries`);
    if (n(c.m2mTokens)) parts.push(`${fmtN(c.m2mTokens)} machine-to-machine tokens`);
    return `Entra External ID ${c.tier === 'core' ? 'Core' : 'Basic'}: ${parts.join(', ')} a month`;
  },
  price: async (c, ctx) => {
    const tier = (c.tier || 'basic').toLowerCase();
    if (!['basic', 'core'].includes(tier)) throw new PricingError(`Unknown tier "${c.tier}". Use basic or core.`);
    const rs = await rows(`serviceName eq 'Microsoft Entra' and productName eq 'Microsoft Entra External ID' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError('Microsoft Entra External ID prices were not found.');
    const m = (name, what) => single(rs.filter(r => r.meterName === name), what);
    const G = 'Security', S = 'Microsoft Entra External ID', Tier = tier === 'core' ? 'Core' : 'Basic';
    const lines = [];
    const mau = m(`${Tier} Monthly Active Users`, `${Tier} monthly active users`);
    lines.push(meterLine(G, S, `${Tier} monthly active users, ${fmtN(n(c.monthlyActiveUsers))} (first 50,000 free)`, mau, n(c.monthlyActiveUsers), ctx, { unit: 'MAU' }));
    const addOn = (field, meter, desc, unit) => { if (n(c[field])) lines.push(meterLine(G, S, `${desc}, ${fmtN(c[field])}/month`, m(meter, desc), n(c[field]), ctx, { unit })); };
    addOn('goLocalUsers', 'Go-Local Add-on Monthly Active Users', 'Go-Local data residency add-on (monthly active users)', 'MAU');
    addOn('idGovernanceGuests', 'ID Gov for Guests Monthly Active Users', 'ID Governance for guests (monthly active users)', 'MAU');
    addOn('gsaGuests', 'GSA for Guests Monthly Active Users', 'Global Secure Access for guests (monthly active users)', 'MAU');
    for (const [k, [sku, band]] of Object.entries(SMS)) addOn(k, `${sku} Transaction`, `SMS phone authentication, ${band} countries`, 'messages');
    addOn('m2mTokens', 'M2M Authentication Token', 'Machine-to-machine authentication tokens', 'tokens');
    const notes = ['External ID bills monthly active users: unique users who authenticate in a calendar month, combined across all tenants linked to the subscription. The first 50,000 MAU a month are free; add-ons have no free allowance and are billed on top.',
      'Phone (SMS) authentication is billed per text message in one of four country cost bands. Machine-to-machine tokens do not count as MAU.'];
    notes.push('This estimate is for Microsoft Entra External ID. Existing Azure AD B2C tenants and B2B tenants on Azure AD External Identities P1/P2 are billed under their older meters, so check which model the customer is on.');
    if (/^usgov/.test(ctx.region)) notes.push('US Government regions are not offered in the Azure pricing calculator for External ID; these are the commercial (global) prices, so confirm Government pricing with Microsoft.');
    if (tier === 'core') notes.push('The public pricing page lists only the Basic plan; Core is priced from the Retail Prices API.');
    const smsTotal = Object.keys(SMS).reduce((t, k) => t + n(c[k]), 0);
    return { lines, notes, facts: { tier, monthlyActiveUsers: n(c.monthlyActiveUsers), goLocalUsers: n(c.goLocalUsers), smsTotal } };
  }
};
