'use strict';

const { query, dedupe, round2 } = require('../api');

const INCLUDED_SIGNATURES = { basic: 5000, premium: 100000 };

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function artifactSigning({ tier = 'basic', accounts = 1, signatures = 0, currency = 'USD' }) {
  const rows = dedupe(await query(`serviceName eq 'Trusted Signing' and armRegionName eq 'Global'`, currency));
  const account = pickOne(rows, r => r.skuName.toLowerCase() === tier && r.meterName === `${tier === 'basic' ? 'Basic' : 'Premium'} Account` && r.type === 'Consumption', `${tier} account`);
  const overage = pickOne(rows, r => r.meterName === 'Signature Overage' && r.type === 'Consumption', 'signature overage');
  const included = INCLUDED_SIGNATURES[tier] * accounts;
  const overageSignatures = Math.max(0, signatures - included);
  const lines = [
    line(`${tier} accounts: ${accounts} * ${account.retailPrice}/month`, accounts * account.retailPrice, { meterId: account.meterId }),
  ];
  if (overageSignatures) {
    lines.push(line(`signature overage: (${signatures} - ${included}) * ${overage.retailPrice}`, overageSignatures * overage.retailPrice, { meterId: overage.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'artifact-signing',
  source: 'retail-api',
  cases: [
    {
      name: 'basic account at included signature boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'basic', accounts: 1, signatures: 5000 },
      // Retail API Trusted Signing Basic Account is a flat monthly account meter; Learn SKU table says Basic includes 5,000 signatures.
      expected: async () => artifactSigning({ tier: 'basic', accounts: 1, signatures: 5000 }),
    },
    {
      name: 'basic account just above included signature boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'basic', accounts: 1, signatures: 5001 },
      // Retail API Signature Overage meter applies after the Basic 5,000-signature monthly quota: one overage signature * overage price.
      expected: async () => artifactSigning({ tier: 'basic', accounts: 1, signatures: 5001 }),
    },
    {
      name: 'premium account at included signature boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'premium', accounts: 1, signatures: 100000 },
      // Retail API Trusted Signing Premium Account is a flat monthly account meter; Learn SKU table says Premium includes 100,000 signatures.
      expected: async () => artifactSigning({ tier: 'premium', accounts: 1, signatures: 100000 }),
    },
    {
      name: 'premium account just above included signature boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'premium', accounts: 1, signatures: 100001 },
      // Retail API Signature Overage meter applies after the Premium 100,000-signature monthly quota: one overage signature * overage price.
      expected: async () => artifactSigning({ tier: 'premium', accounts: 1, signatures: 100001 }),
    },
    {
      name: 'multiple basic accounts pool included signatures',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'basic', accounts: 2, signatures: 12000 },
      // Trusted Signing meters are Global; two Basic accounts are two account fees and 12,000 - (2 * 5,000) overage signatures.
      expected: async () => artifactSigning({ tier: 'basic', accounts: 2, signatures: 12000 }),
    },
    {
      name: 'basic just below premium break-even',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'basic', accounts: 1, signatures: 22998 },
      // Basic break-even with Premium is 23,000 signatures: 9.99 + (22,998 - 5,000) * 0.005, rounded per line.
      expected: async () => artifactSigning({ tier: 'basic', accounts: 1, signatures: 22998 }),
    },
    {
      name: 'basic at premium break-even',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'basic', accounts: 1, signatures: 23000 },
      // Basic at 23,000 signatures: 9.99 account + 18,000 overage signatures * $0.005 = $99.99, equal to Premium account price.
      expected: async () => artifactSigning({ tier: 'basic', accounts: 1, signatures: 23000 }),
    },
    {
      name: 'premium at basic break-even volume',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'premium', accounts: 1, signatures: 23000 },
      // Premium includes up to 100,000 signatures, so at the 23,000 Basic break-even volume it is just the Premium account meter.
      expected: async () => artifactSigning({ tier: 'premium', accounts: 1, signatures: 23000 }),
    },
    {
      name: 'basic just above premium break-even',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'artifact-signing', tier: 'basic', accounts: 1, signatures: 23001 },
      // One signature above break-even: Basic account plus 18,001 overage signatures exceeds the Premium account price.
      expected: async () => artifactSigning({ tier: 'basic', accounts: 1, signatures: 23001 }),
    },
    {
      name: 'premium EUR with overage',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'artifact-signing', tier: 'premium', accounts: 2, signatures: 250000 },
      // EUR Retail API rows: two Premium account-months plus 50,000 signatures over the combined 200,000-signature included quota.
      expected: async () => artifactSigning({ tier: 'premium', accounts: 2, signatures: 250000, currency: 'EUR' }),
    },
  ],
};
