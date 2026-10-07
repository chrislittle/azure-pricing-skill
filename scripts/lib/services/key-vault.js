'use strict';
// Azure Key Vault (vaults, Standard and Premium) and Key Vault Managed HSM pools.
// Meters: serviceName 'Key Vault', regional. Operations are billed per 10,000; HSM-protected
// advanced keys (RSA 3072/4096, ECC) are graduated per key per month.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const OTHER = ['advancedOperations', 'certificateRenewals', 'keyRotations', 'hsmKeys', 'advancedHsmKeys', 'storageKeyRenewals', 'managedHsmPools'];

module.exports = {
  type: 'key-vault',
  label: 'Azure Key Vault',
  family: 'security',
  calculator: ['key-vault'],
  keywords: ['key vault', 'secrets', 'keys', 'certificates', 'hsm', 'managed hsm', 'encryption keys', 'tls certificates'],
  fields: {
    tier: { def: 'standard', enum: ['standard', 'premium'], ask: 'Must the encryption keys be kept in a hardware security module (HSM), for example for compliance? Yes -> premium; otherwise standard.' },
    operations: { req: true, ask: 'Roughly how many times a month do your apps read or use secrets, keys or certificates? Each call is one operation. If unknown, suggest 100,000 and record it as an assumption. Use 0 if they only need a Managed HSM pool.' },
    advancedOperations: { def: 0, ask: 'Only if they use RSA 3072/4096-bit or elliptic-curve keys: how many operations a month with those keys?' },
    certificateRenewals: { def: 0, ask: 'How many certificates does Key Vault renew for you each month (for example TLS certificates from a certificate authority)?' },
    keyRotations: { def: 0, ask: 'How many automatic key rotations a month, if any?' },
    hsmKeys: { def: 0, ask: 'Premium only: how many HSM-protected RSA 2048-bit keys? Count every key version used in the last 30 days (each rotation creates a new version, billed as a separate key).' },
    advancedHsmKeys: { def: 0, ask: 'Premium only: how many HSM-protected RSA 3072/4096-bit or elliptic-curve keys? Count every key version used in the last 30 days.' },
    storageKeyRenewals: { def: 0, ask: 'Only if Key Vault manages and rotates Azure Storage account keys for them: how many renewals a month?' },
    managedHsmPools: { def: 0, ask: 'Only if they need a dedicated, single-tenant Managed HSM pool: how many pools? (Most people need 0.)' },
    hours: { def: 730, ask: 'Managed HSM pools only: hours a month each pool exists (730 = all month; a deleted pool keeps billing until it is purged).' }
  },
  context: ['production'],
  examples: [
    { type: 'key-vault', tier: 'standard', operations: 500000 },
    { type: 'key-vault', tier: 'premium', operations: 2000000, advancedOperations: 100000, hsmKeys: 10, advancedHsmKeys: 300, certificateRenewals: 2, keyRotations: 5, storageKeyRenewals: 2 },
    { type: 'key-vault', tier: 'premium', operations: 0, managedHsmPools: 1 }
  ],
  readback: c => {
    const parts = [];
    if (n(c.operations) || !OTHER.some(k => n(c[k]))) parts.push(`${fmtN(n(c.operations))} operations a month`);
    if (n(c.advancedOperations)) parts.push(`${fmtN(c.advancedOperations)} operations with RSA 3072/4096 or elliptic-curve keys`);
    if (n(c.hsmKeys)) parts.push(`${fmtN(c.hsmKeys)} HSM-protected RSA 2048-bit key versions`);
    if (n(c.advancedHsmKeys)) parts.push(`${fmtN(c.advancedHsmKeys)} HSM-protected RSA 3072/4096 or elliptic-curve key versions`);
    if (n(c.certificateRenewals)) parts.push(`${fmtN(c.certificateRenewals)} certificate renewals a month`);
    if (n(c.keyRotations)) parts.push(`${fmtN(c.keyRotations)} automatic key rotations a month`);
    if (n(c.storageKeyRenewals)) parts.push(`${fmtN(c.storageKeyRenewals)} storage account key renewals a month`);
    if (n(c.managedHsmPools)) parts.push(`${fmtN(c.managedHsmPools)} Managed HSM pool(s), ${(c.hours ?? HOURS) === HOURS ? 'running all month' : `${fmtN(c.hours)} hours a month`}`);
    return `Key Vault ${c.tier || 'standard'}: ${parts.join(', ')}`;
  },
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    const sku = tier === 'premium' ? 'Premium' : 'Standard';
    const premiumOnly = ['hsmKeys', 'advancedHsmKeys'].filter(k => n(c[k]) > 0);
    if (tier !== 'premium' && premiumOnly.length) throw new PricingError(`HSM-protected keys (${premiumOnly.join(', ')}) need tier "premium".`);
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const rs = await rows(`serviceName eq 'Key Vault' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Key Vault is not priced in ${ctx.region}.`);
    // Standard and Premium share meterIds for common meters (rows() keeps one copy), so match on the
    // meter name; prefer this SKU's row when the SKUs have their own meterIds (e.g. key rotation).
    const kv = rs.filter(r => r.productName === 'Key Vault');
    const m = (name, what) => { const all = kv.filter(r => r.meterName === name); const own = all.filter(r => r.skuName === sku); return single(own.length ? own : all, `Key Vault ${sku} ${what}`); };
    const G = 'Security', S = 'Key Vault', lines = [];
    if (n(c.operations) || !OTHER.some(k => n(c[k]))) lines.push(meterLine(G, S, `Key Vault ${sku}: operations on secrets, software keys${tier === 'premium' ? ', RSA 2048-bit HSM keys' : ''} and certificates, ${fmtN(n(c.operations))}/month`, m('Operations', 'operations'), n(c.operations), ctx));
    if (n(c.advancedOperations)) lines.push(meterLine(G, S, `Operations with RSA 3072/4096-bit or elliptic-curve keys, ${fmtN(c.advancedOperations)}/month`, m('Advanced Key Operations', 'advanced key operations'), n(c.advancedOperations), ctx));
    if (n(c.certificateRenewals)) lines.push(meterLine(G, S, `Certificate renewals, ${fmtN(c.certificateRenewals)}/month`, m('Certificate Renewal Request', 'certificate renewals'), n(c.certificateRenewals), ctx));
    if (n(c.keyRotations)) lines.push(meterLine(G, S, `Automatic key rotations, ${fmtN(c.keyRotations)}/month`, m('Automated Key Rotation', 'key rotations'), n(c.keyRotations), ctx));
    if (n(c.storageKeyRenewals)) lines.push(meterLine(G, S, `Storage account key renewals, ${fmtN(c.storageKeyRenewals)}/month`, m('Secret Renewal', 'storage account key renewals'), n(c.storageKeyRenewals), ctx));
    if (n(c.hsmKeys)) lines.push(meterLine(G, S, `HSM-protected RSA 2048-bit key versions, ${fmtN(c.hsmKeys)}`, m('Premium HSM-protected RSA 2048-bit key', 'HSM RSA 2048 keys'), n(c.hsmKeys), ctx, { unit: 'keys / month' }));
    if (n(c.advancedHsmKeys)) {
      const adv = m('Premium HSM-protected Advanced Key', 'HSM advanced keys');
      lines.push(meterLine(G, S, `HSM-protected RSA 3072/4096-bit or elliptic-curve key versions, ${fmtN(c.advancedHsmKeys)}${adv.length > 1 ? ' (graduated)' : ''}`, adv, n(c.advancedHsmKeys), ctx, { unit: 'keys / month' }));
    }
    if (n(c.managedHsmPools)) {
      const pool = single(rs.filter(r => r.productName === 'Key Vault HSM Pool' && r.meterName === 'Standard B1 Instance'), 'Managed HSM pool');
      lines.push(meterLine(G, 'Key Vault Managed HSM', `Managed HSM pool Standard B1, ${fmtN(c.managedHsmPools)} pool(s) x ${fmtN(hours)} hours`, pool, n(c.managedHsmPools) * hours, ctx, { unit: 'hours' }));
    }
    const notes = ['Key Vault bills every authenticated API call as an operation, in blocks of 10,000. Vaults themselves have no monthly charge.'];
    if (tier === 'premium' && (n(c.hsmKeys) || n(c.advancedHsmKeys))) notes.push('Each version of an HSM-protected key used in the last 30 days is billed as a separate key.');
    if (tier === 'premium' && n(c.advancedHsmKeys)) notes.push('HSM-protected RSA 3072/4096-bit and elliptic-curve keys are priced per key per month in graduated bands; the band prices apply to the total number of such keys.');
    if (n(c.managedHsmPools)) notes.push('A deleted Managed HSM pool keeps billing at the full hourly rate until it is purged.');
    if (tier === 'premium' || n(c.managedHsmPools)) notes.push('Azure Dedicated HSM is not priced here: it is closed to new customers and being retired.');
    return { lines, notes, facts: { tier, operations: n(c.operations), advancedOperations: n(c.advancedOperations), keyRotations: n(c.keyRotations), hsmKeyCount: n(c.hsmKeys) + n(c.advancedHsmKeys), managedHsmPools: n(c.managedHsmPools) } };
  }
};
