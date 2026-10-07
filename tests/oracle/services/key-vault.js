'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'key-vault';
const OPS_UNIT = 10000;
const HOURS_PER_MONTH = 730;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

async function calculatorOffer(offer, region) {
  const p = await calc.offerPrice(SLUG, offer, region);
  return p.value;
}

async function calculatorGraduatedAdvancedHsm(region, keys) {
  const data = await calc.product(SLUG);
  const calcRegion = calc.calcRegion(data, region);
  const table = data.graduatedOffers['ecc-rsa4-hsm-protected-keys-premium'][calcRegion];
  if (!table) throw new Error(`calculator has no advanced HSM graduated prices for ${calcRegion}`);

  let previous = 0;
  let cost = 0;
  const bands = [];
  for (const band of table.prices) {
    const limit = band.limit;
    const units = Math.max(0, Math.min(keys, limit) - previous);
    if (units > 0) {
      const unitPrice = band.price.value;
      const bandCost = units * unitPrice;
      cost += bandCost;
      bands.push({ from: previous, to: limit, keys: units, unitPrice, cost: round2(bandCost) });
    }
    previous = limit;
    if (keys <= limit) break;
  }
  return { cost, bands };
}

async function calculatorKeyVault({ region, tier = 'standard', operations = 0, advancedOperations = 0, certificateRenewals = 0, keyRotations = 0, storageKeyRenewals = 0, hsmKeys = 0, advancedHsmKeys = 0, managedHsmPools = 0, hours = HOURS_PER_MONTH }) {
  const lines = [];

  if (operations) {
    const price = await calculatorOffer(`secretssoftwareprotectedkeys-${tier}`, region);
    lines.push(line(`${tier} operations: ${operations} operations / 10K * ${price}`, (operations / OPS_UNIT) * price, { sourceOffer: `secretssoftwareprotectedkeys-${tier}` }));
  }

  if (advancedOperations) {
    const price = await calculatorOffer(`eccrsa4operationkeys-${tier}`, region);
    lines.push(line(`${tier} advanced key operations: ${advancedOperations} operations / 10K * ${price}`, (advancedOperations / OPS_UNIT) * price, { sourceOffer: `eccrsa4operationkeys-${tier}` }));
  }

  if (certificateRenewals) {
    const price = await calculatorOffer(`certificaterenewals-${tier}`, region);
    lines.push(line(`${tier} certificate renewals: ${certificateRenewals} * ${price}`, certificateRenewals * price, { sourceOffer: `certificaterenewals-${tier}` }));
  }

  if (keyRotations) {
    const price = await calculatorOffer(`secretskeyrotation-${tier}`, region);
    lines.push(line(`${tier} automated key rotations: ${keyRotations} * ${price}`, keyRotations * price, { sourceOffer: `secretskeyrotation-${tier}` }));
  }

  if (storageKeyRenewals) {
    const price = await calculatorOffer('storageaccountkeys-premium', region);
    lines.push(line(`storage account key renewals: ${storageKeyRenewals} * ${price}`, storageKeyRenewals * price, { sourceOffer: 'storageaccountkeys-premium' }));
  }

  if (hsmKeys) {
    const price = await calculatorOffer('hsmprotectedkeys-premium', region);
    lines.push(line(`premium RSA 2048 HSM-protected keys: ${hsmKeys} * ${price}`, hsmKeys * price, { sourceOffer: 'hsmprotectedkeys-premium' }));
  }

  if (advancedHsmKeys) {
    const g = await calculatorGraduatedAdvancedHsm(region, advancedHsmKeys);
    lines.push(line(`premium advanced HSM-protected keys: graduated ${advancedHsmKeys} keys`, g.cost, { sourceOffer: 'ecc-rsa4-hsm-protected-keys-premium', bands: g.bands }));
  }

  if (managedHsmPools) {
    const price = await calculatorOffer('hsmb1standard-standard', region);
    lines.push(line(`managed HSM Standard B1 pools: ${managedHsmPools} * ${hours} hours * ${price}`, managedHsmPools * hours * price, { sourceOffer: 'hsmb1standard-standard' }));
  }

  return { monthlyList: totalOf(lines), lines };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function retailStandardEur({ region, operations, keyRotations, currency }) {
  const filter = `serviceName eq 'Key Vault' and armRegionName eq '${region}' and productName eq 'Key Vault' and skuName eq 'Standard'`;
  const rows = dedupe(await query(filter, currency));
  const ops = pickOne(rows, r => r.meterName === 'Operations' && r.unitOfMeasure === '10K' && r.type === 'Consumption', 'standard operations');
  const rotations = pickOne(rows, r => r.meterName === 'Automated Key Rotation' && r.unitOfMeasure === '1 Rotation' && r.type === 'Consumption', 'standard automated key rotation');
  const lines = [
    line(`EUR Retail API standard operations: ${operations} / ${unitSize(ops.unitOfMeasure)} * ${ops.retailPrice}`, (operations / unitSize(ops.unitOfMeasure)) * ops.retailPrice, { meterId: ops.meterId }),
    line(`EUR Retail API standard automated key rotations: ${keyRotations} * ${rotations.retailPrice}`, keyRotations * rotations.retailPrice, { meterId: rotations.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

async function retailPremiumEur({ region, operations, hsmKeys, currency }) {
  const filter = `serviceName eq 'Key Vault' and armRegionName eq '${region}' and productName eq 'Key Vault' and skuName eq 'Premium'`;
  const rows = dedupe(await query(filter, currency));
  const ops = pickOne(rows, r => r.meterName === 'Operations' && r.unitOfMeasure === '10K' && r.type === 'Consumption', 'premium operations');
  const keys = pickOne(rows, r => r.meterName === 'Premium HSM-protected RSA 2048-bit key' && r.unitOfMeasure === '1' && r.type === 'Consumption', 'premium RSA 2048 HSM key');
  const lines = [
    line(`EUR Retail API premium operations: ${operations} / ${unitSize(ops.unitOfMeasure)} * ${ops.retailPrice}`, (operations / unitSize(ops.unitOfMeasure)) * ops.retailPrice, { meterId: ops.meterId }),
    line(`EUR Retail API premium RSA 2048 HSM-protected keys: ${hsmKeys} * ${keys.retailPrice}`, hsmKeys * keys.retailPrice, { meterId: keys.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'key-vault',
  source: 'both',
  cases: [
    {
      name: 'standard transactions, advanced ops, cert renewals and rotations',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'standard', operations: 100000, advancedOperations: 20000, certificateRenewals: 2, keyRotations: 3 },
      // Calculator offers: operations and advanced operations are per 10K; renewals and rotations are per event.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'standard', operations: 100000, advancedOperations: 20000, certificateRenewals: 2, keyRotations: 3 }),
    },
    {
      name: 'premium base plus RSA 2048 HSM keys',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 50000, advancedOperations: 10000, certificateRenewals: 1, keyRotations: 2, hsmKeys: 10 },
      // Calculator premium offers mirror standard operation units; RSA 2048 HSM-protected keys are per key-month.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'premium', operations: 50000, advancedOperations: 10000, certificateRenewals: 1, keyRotations: 2, hsmKeys: 10 }),
    },
    {
      name: 'advanced HSM keys just below first graduated boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 0, advancedHsmKeys: 249 },
      // Calculator graduated offer ecc-rsa4-hsm-protected-keys-premium: first band ends at 250 keys.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'premium', advancedHsmKeys: 249 }),
    },
    {
      name: 'advanced HSM keys just above first graduated boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 0, advancedHsmKeys: 251 },
      // Calculator graduated offer: 250 keys at first-band price, then 1 key at second-band price.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'premium', advancedHsmKeys: 251 }),
    },
    {
      name: 'advanced HSM keys just above 1500 graduated boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 0, advancedHsmKeys: 1501 },
      // Calculator graduated offer: 250 keys in band 1, 1,250 in band 2, then 1 key in band 3.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'premium', advancedHsmKeys: 1501 }),
    },
    {
      name: 'advanced HSM keys just above 4000 graduated boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 0, advancedHsmKeys: 4001 },
      // Calculator graduated offer: first three bands through 4,000 keys, then 1 key in the final band.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'premium', advancedHsmKeys: 4001 }),
    },
    {
      name: 'premium HSM keys in Mexico Central regional bands',
      region: 'mexicocentral',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 0, hsmKeys: 10, advancedHsmKeys: 251 },
      // Calculator Mexico Central: RSA 2048 HSM keys use hsmprotectedkeys-premium; advanced HSM keys use Mexico's higher graduated bands.
      expected: async () => calculatorKeyVault({ region: 'mexicocentral', tier: 'premium', hsmKeys: 10, advancedHsmKeys: 251 }),
    },
    {
      name: 'non-US region with higher calculator rates',
      region: 'mexicocentral',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'standard', operations: 100000, advancedOperations: 10000, certificateRenewals: 1, keyRotations: 1 },
      // Calculator Mexico Central uses higher regional prices for operations, advanced operations and certificate renewals.
      expected: async () => calculatorKeyVault({ region: 'mexicocentral', tier: 'standard', operations: 100000, advancedOperations: 10000, certificateRenewals: 1, keyRotations: 1 }),
    },
    {
      name: 'managed HSM pool part-time hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 0, managedHsmPools: 2, hours: 100 },
      // Calculator hsmb1standard-standard is hourly; apply the component's part-time hours to each pool.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'premium', managedHsmPools: 2, hours: 100 }),
    },
    {
      name: 'storage account key renewals',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 0, storageKeyRenewals: 7 },
      // Calculator storageaccountkeys-premium offer is charged per storage account key renewal.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'premium', storageKeyRenewals: 7 }),
    },
    {
      name: 'managed HSM only with zero operations',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'key-vault', tier: 'premium', operations: 0, managedHsmPools: 1 },
      // Calculator hsmb1standard-standard is hourly; with no Key Vault operations, one all-month pool is 730 hours.
      expected: async () => calculatorKeyVault({ region: 'eastus2', tier: 'premium', managedHsmPools: 1 }),
    },
    {
      name: 'premium EUR retail API operations and HSM keys',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'key-vault', tier: 'premium', operations: 50000, hsmKeys: 3 },
      // Retail API EUR premium rows: Operations meter is per 10K; RSA 2048 HSM-protected key meter is per key-month.
      expected: async () => retailPremiumEur({ region: 'eastus2', operations: 50000, hsmKeys: 3, currency: 'EUR' }),
    },
    {
      name: 'standard EUR retail API operations and rotations',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'key-vault', tier: 'standard', operations: 100000, keyRotations: 3 },
      // Retail API EUR rows: Operations meter is per 10K; Automated Key Rotation meter is per rotation.
      expected: async () => retailStandardEur({ region: 'eastus2', operations: 100000, keyRotations: 3, currency: 'EUR' }),
    },
  ],
};
