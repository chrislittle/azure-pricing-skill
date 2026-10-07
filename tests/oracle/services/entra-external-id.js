'use strict';

const { query, dedupe, round2 } = require('../api');

const FREE_MAU = 50000;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

async function retailRows(currency) {
  return dedupe(await query("productName eq 'Microsoft Entra External ID' and armRegionName eq 'Global'", currency));
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

function paidMauLine(rows, tier, monthlyActiveUsers) {
  const sku = tier === 'core' ? 'Core' : 'Basic';
  const r = pickOne(rows, x => x.type === 'Consumption' && x.skuName === sku && x.meterName === `${sku} Monthly Active Users` && x.tierMinimumUnits === FREE_MAU, `${sku} Monthly Active Users paid tier`);
  const billable = Math.max(0, monthlyActiveUsers - FREE_MAU);
  return line(`${sku} monthly active users: ${billable} paid MAU above ${FREE_MAU} free * ${r.retailPrice}`, billable * r.retailPrice, { meterId: r.meterId });
}

function flatLine(rows, skuName, meterName, qty, desc) {
  if (!qty) return null;
  const r = pickOne(rows, x => x.type === 'Consumption' && x.skuName === skuName && x.meterName === meterName, meterName);
  return line(`${desc}: ${qty} * ${r.retailPrice}`, qty * r.retailPrice, { meterId: r.meterId });
}

async function externalId(opts) {
  const { tier = 'basic', monthlyActiveUsers = 0, currency = 'USD' } = opts;
  const rows = await retailRows(currency);
  const lines = [paidMauLine(rows, tier, monthlyActiveUsers)];

  const add = l => { if (l) lines.push(l); };
  add(flatLine(rows, 'Go-Local Add-on', 'Go-Local Add-on Monthly Active Users', opts.goLocalUsers || 0, 'Go-Local data residency MAU'));
  add(flatLine(rows, 'ID Gov for Guests', 'ID Gov for Guests Monthly Active Users', opts.idGovernanceGuests || 0, 'ID Governance guests MAU'));
  add(flatLine(rows, 'GSA for Guests', 'GSA for Guests Monthly Active Users', opts.gsaGuests || 0, 'GSA for guests MAU'));
  add(flatLine(rows, 'Phone Authentication Low Cost', 'Phone Authentication Low Cost Transaction', opts.smsLowCostCountries || 0, 'SMS phone authentication low-cost countries'));
  add(flatLine(rows, 'Phone Authentication Mid Low Cost', 'Phone Authentication Mid Low Cost Transaction', opts.smsMidLowCostCountries || 0, 'SMS phone authentication mid-low-cost countries'));
  add(flatLine(rows, 'Phone Authentication Mid High Cost', 'Phone Authentication Mid High Cost Transaction', opts.smsMidHighCostCountries || 0, 'SMS phone authentication mid-high-cost countries'));
  add(flatLine(rows, 'Phone Authentication High Cost', 'Phone Authentication High Cost Transaction', opts.smsHighCostCountries || 0, 'SMS phone authentication high-cost countries'));
  add(flatLine(rows, 'M2M Authentication', 'M2M Authentication Token', opts.m2mTokens || 0, 'M2M authentication tokens'));

  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'entra-external-id',
  source: 'retail-api',
  cases: [
    {
      name: 'basic just below free MAU grant',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-external-id', tier: 'basic', monthlyActiveUsers: 49999 },
      // Retail API Microsoft Entra External ID Basic MAU has a paid tier beginning at 50,000 MAU.
      expected: async () => externalId({ tier: 'basic', monthlyActiveUsers: 49999 }),
    },
    {
      name: 'basic just above free MAU grant',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-external-id', tier: 'basic', monthlyActiveUsers: 50001 },
      // Retail API Microsoft Entra External ID Basic MAU charges only the one MAU above the 50,000 free tier.
      expected: async () => externalId({ tier: 'basic', monthlyActiveUsers: 50001 }),
    },
    {
      name: 'basic paid tier and all premium add-ons',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-external-id', tier: 'basic', monthlyActiveUsers: 60000, goLocalUsers: 1000, idGovernanceGuests: 100, gsaGuests: 20, smsLowCostCountries: 10, smsMidLowCostCountries: 10, smsMidHighCostCountries: 10, smsHighCostCountries: 10, m2mTokens: 1000 },
      // Retail API Microsoft Entra External ID add-on meters are Global flat per MAU, transaction, or token with no free tier.
      expected: async () => externalId({ tier: 'basic', monthlyActiveUsers: 60000, goLocalUsers: 1000, idGovernanceGuests: 100, gsaGuests: 20, smsLowCostCountries: 10, smsMidLowCostCountries: 10, smsMidHighCostCountries: 10, smsHighCostCountries: 10, m2mTokens: 1000 }),
    },
    {
      name: 'core paid MAU tier from Microsoft Entra External ID meter',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'entra-external-id', tier: 'core', monthlyActiveUsers: 60000 },
      // Retail API product Microsoft Entra External ID, SKU Core, meter Core Monthly Active Users: paid tier starts at 50,000 MAU.
      expected: async () => externalId({ tier: 'core', monthlyActiveUsers: 60000 }),
    },
    {
      name: 'west europe basic paid tier using global meter',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'entra-external-id', tier: 'basic', monthlyActiveUsers: 60000 },
      // Retail API Microsoft Entra External ID meters are Global; region selection does not change the Basic MAU price.
      expected: async () => externalId({ tier: 'basic', monthlyActiveUsers: 60000 }),
    },
    {
      name: 'eur basic paid tier and all premium add-ons',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'entra-external-id', tier: 'basic', monthlyActiveUsers: 60000, goLocalUsers: 1000, idGovernanceGuests: 100, gsaGuests: 20, smsLowCostCountries: 10, smsMidLowCostCountries: 10, smsMidHighCostCountries: 10, smsHighCostCountries: 10, m2mTokens: 1000 },
      // Retail API returns native EUR prices for Basic, add-ons, SMS and M2M Global meters; no USD hard-coding or FX conversion.
      expected: async () => externalId({ currency: 'EUR', tier: 'basic', monthlyActiveUsers: 60000, goLocalUsers: 1000, idGovernanceGuests: 100, gsaGuests: 20, smsLowCostCountries: 10, smsMidLowCostCountries: 10, smsMidHighCostCountries: 10, smsHighCostCountries: 10, m2mTokens: 1000 }),
    },
  ],
};
