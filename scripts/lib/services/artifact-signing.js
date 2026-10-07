'use strict';
// Azure Artifact Signing (formerly Trusted Signing). Retail API serviceName is still 'Trusted Signing'; regionless.
// Basic/Premium account fee per month plus a per-signature overage after the monthly quota.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
// Included monthly signatures per account tier (Learn: "Change an Artifact Signing account SKU"). The retail
// meters for the included signatures are $0, so the quota cannot be read from the price data.
const QUOTA = { basic: 5000, premium: 100000 };
// Regions where accounts can be created (Learn quickstart); the price is global.
const ACCOUNT_REGIONS = ['brazilsouth', 'centralus', 'eastus', 'japaneast', 'koreacentral', 'northcentralus', 'northeurope', 'polandcentral', 'southcentralus', 'switzerlandnorth', 'westcentralus', 'westeurope', 'westus', 'westus2', 'westus3'];

module.exports = {
  type: 'artifact-signing',
  label: 'Azure Artifact Signing (formerly Trusted Signing)',
  family: 'security',
  calculator: ['artifact-signing'],
  keywords: ['code signing', 'signing certificate', 'sign software', 'sign installers', 'trusted signing', 'artifact signing', 'authenticode', 'signatures'],
  fields: {
    tier: { def: 'basic', enum: ['basic', 'premium'], ask: 'Do you need more than one signing certificate of the same kind (for example separate public-trust certificates for different products or teams)? Yes -> premium (it allows up to 10 of each kind). Otherwise basic: it keeps signing after its 5,000 included signatures a month at the same per-signature price, and is cheaper than premium until about 23,000 signatures a month per account. If unknown, suggest basic and record it as an assumption.' },
    accounts: { def: 1, ask: 'How many Artifact Signing accounts do you need? Most teams need 1.' },
    signatures: { req: true, ask: 'Roughly how many times a month will your build pipeline sign a file (each signature is one signing operation, counting every file you sign), in total across all accounts? If unknown, suggest 1,000 and record it as an assumption.' }
  },
  context: ['production'],
  examples: [
    { type: 'artifact-signing', tier: 'basic', signatures: 1000 },
    { type: 'artifact-signing', tier: 'premium', accounts: 2, signatures: 250000 }
  ],
  readback: c => `Artifact Signing ${c.tier || 'basic'}: ${fmtN(n(c.accounts) || 1)} account(s), ${fmtN(n(c.signatures))} signatures a month in total (${fmtN(QUOTA[c.tier || 'basic'])} included per account each month)`,
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.includes('identity-validation')) ? [] : ['Identity validation of your organization (no charge listed in the price data) and the build or CI compute that runs the signing'],
  price: async (c, ctx) => {
    const tier = (c.tier || 'basic').toLowerCase();
    if (!QUOTA[tier]) throw new PricingError(`Artifact Signing tier must be "basic" or "premium", got "${c.tier}".`);
    const accounts = c.accounts == null ? 1 : n(c.accounts);
    if (!Number.isInteger(accounts) || accounts < 1) throw new PricingError('Artifact Signing needs a whole number of accounts, at least 1.');
    const sig = n(c.signatures);
    if (!Number.isFinite(sig) || sig < 0) throw new PricingError('Signatures a month cannot be negative.');
    const rs = await rows(`serviceName eq 'Trusted Signing' and priceType eq 'Consumption'`, ctx);
    const name = tier === 'premium' ? 'Premium Account' : 'Basic Account';
    const acct = single(rs.filter(r => r.meterName === name), `Artifact Signing ${name}`);
    const basic = single(rs.filter(r => r.meterName === 'Basic Account'), 'Artifact Signing Basic Account');
    const over = single(rs.filter(r => r.meterName === 'Signature Overage'), 'Artifact Signing signature overage');
    const included = QUOTA[tier] * accounts;
    const extra = Math.max(0, sig - included);
    const G = 'Security', S = 'Trusted Signing';
    const lines = [meterLine(G, S, `Artifact Signing ${tier} account, ${fmtN(accounts)} account(s) (includes ${fmtN(QUOTA[tier])} signatures per account each month)`, acct, accounts, ctx, { unit: 'accounts / month' })];
    if (extra > 0) lines.push(meterLine(G, S, `Signatures beyond the included ${fmtN(included)} a month: ${fmtN(extra)} of ${fmtN(sig)}`, over, extra, ctx, { unit: 'signatures / month' }));
    const cost = (acct, quota) => acct[0].retailPrice * accounts + Math.max(0, sig - quota * accounts) * over[0].retailPrice;
    const premium = tier === 'premium' ? acct : single(rs.filter(r => r.meterName === 'Premium Account'), 'Artifact Signing Premium Account');
    const basicCost = cost(basic, QUOTA.basic), premiumCost = cost(premium, QUOTA.premium), tierCost = tier === 'premium' ? premiumCost : basicCost;
    const breakEven = QUOTA.basic + Math.round((premium[0].retailPrice - basic[0].retailPrice) / over[0].retailPrice);
    const basicCheaper = tier === 'premium' && basicCost < premiumCost;
    const premiumCheaper = tier === 'basic' && premiumCost < basicCost;
    const money = v => `${fmtN(Math.round(v * 100) / 100)} ${ctx.currency || 'USD'}`;
    const notes = [`Each ${tier} account includes ${fmtN(QUOTA[tier])} signatures a month; more are billed per signature.`];
    notes.push('Each account has its own quota, and this estimate assumes signatures are spread evenly across accounts. The account fee is for the whole month and is not pro-rated; billing starts when the account is created.');
    if (basicCheaper) notes.push(`Basic would cost less at this volume (${money(basicCost)} against ${money(premiumCost)} a month): it keeps signing after its included signatures at the same per-signature price. Premium only pays off above about ${fmtN(breakEven)} signatures a month per account, or when you need more than one certificate of the same kind.`);
    if (premiumCheaper) notes.push(`Premium would cost less at this volume (${money(premiumCost)} against ${money(basicCost)} a month): its quota of ${fmtN(QUOTA.premium)} signatures per account is much larger. Basic is only cheaper below about ${fmtN(breakEven)} signatures a month per account.`);
    if (!ACCOUNT_REGIONS.includes(ctx.region)) notes.push(`Artifact Signing accounts can only be created in: ${ACCOUNT_REGIONS.join(', ')}. The price is the same in every region.`);
    if (extra === 0) notes.push('Signing volume is within the included monthly signatures, so only the account fee applies.');
    return { lines, notes, facts: { tier, accounts, signatures: sig, includedSignatures: included, overageSignatures: extra, basicCheaper, premiumCheaper, breakEvenSignaturesPerAccount: breakEven } };
  }
};


