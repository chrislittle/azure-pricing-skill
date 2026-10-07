'use strict';
// Microsoft Security Copilot: Security Compute Units (SCUs). Provisioned SCUs are billed per hour,
// overage SCUs per hour of use, and pay-as-you-go SCUs per unit consumed (serviceName 'Microsoft Security Copilot').
// Provisioned and overage meters exist only in a few regions; capacity can be placed in another region than the data.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const CAPACITY_REGIONS = ['eastus', 'westeurope', 'uksouth', 'australiaeast'];
const SOVEREIGN = /^(usgov|usdod|china)/;
const INCLUDED_PER_1000 = 400, INCLUDED_CAP = 10000; // Microsoft 365 E5/E7 monthly SCU allowance

const allowance = c => Math.min(INCLUDED_CAP, Math.floor(n(c.m365E5Licenses) / 1000 * INCLUDED_PER_1000));

module.exports = {
  type: 'security-copilot',
  label: 'Microsoft Security Copilot',
  family: 'security',
  calculator: ['microsoft-security-copilot'],
  keywords: ['security copilot', 'copilot for security', 'scu', 'security compute units', 'ai security assistant', 'soc ai'],
  fields: {
    provisionedScus: { req: true, int: true, min: 0, ask: 'How many Security Compute Units (SCUs) do they want to provision? One SCU is a block of capacity billed per hour; the minimum is 1. Enter 0 if they only use the Microsoft 365 E5/E7 pay-as-you-go path. To size it, use the Security Copilot SCU estimator (securitycopilot.microsoft.com/calculator); if unknown, suggest 1 and record it as an assumption.' },
    hours: { def: 730, int: true, min: 1, max: 744, ask: 'Hours a month the provisioned SCUs are kept on (730 is 24x7). Billing is in whole clock-hours.' },
    overageScuHours: { def: 0, ask: 'Expected extra SCU usage above the provisioned capacity, in SCU-hours a month (for example 2 extra SCUs for 40 hours = 80). Overage is optional and can be capped; leave 0 if unknown.' },
    m365E5Licenses: { def: 0, int: true, min: 0, ask: 'How many paid Microsoft 365 E5 or E7 licenses does the customer have? Each 1,000 licenses include 400 SCUs a month (up to 10,000 SCUs) at no extra cost. Enter 0 if none.' },
    payAsYouGoScus: { def: 0, ask: 'Microsoft 365 E5/E7 customers who go beyond the included SCUs pay per SCU: how many SCUs will they consume in a month in total (before the included allowance is subtracted)? Leave 0 if unknown or if they use provisioned capacity.' }
  },
  examples: [
    { type: 'security-copilot', provisionedScus: 1 },
    { type: 'security-copilot', provisionedScus: 3, hours: 500, overageScuHours: 80 },
    { type: 'security-copilot', provisionedScus: 0, m365E5Licenses: 4000, payAsYouGoScus: 2000 }
  ],
  readback: c => {
    const parts = [];
    const h = c.hours ?? HOURS;
    if (n(c.provisionedScus)) parts.push(`${fmtN(n(c.provisionedScus))} provisioned SCU(s) for ${fmtN(h)} hours a month`);
    if (n(c.overageScuHours)) parts.push(`${fmtN(n(c.overageScuHours))} overage SCU-hours a month`);
    if (n(c.payAsYouGoScus)) parts.push(`${fmtN(n(c.payAsYouGoScus))} pay-as-you-go SCUs consumed a month${n(c.m365E5Licenses) ? ` with ${fmtN(n(c.m365E5Licenses))} Microsoft 365 E5/E7 licenses (${fmtN(allowance(c))} SCUs included free)` : ' (no included allowance)'}`);
    else if (n(c.m365E5Licenses)) parts.push(`${fmtN(n(c.m365E5Licenses))} Microsoft 365 E5/E7 licenses`);
    return `Security Copilot: ${parts.join(', ') || '0 SCUs'}`;
  },
  notIncluded: (types, spec) => {
    if (spec && spec.excluded) return [];
    const out = ['The Microsoft 365 E5/E7 and other Microsoft security licenses that Security Copilot works with are not in this estimate.'];
    const region = String((spec && spec.region) || '').toLowerCase().replace(/\s+/g, '');
    const hasCap = ((spec && spec.options) || []).some(o => (o.components || []).some(x => x.type === 'security-copilot' && (n(x.provisionedScus) || n(x.overageScuHours))));
    if (hasCap && region && !CAPACITY_REGIONS.includes(region) && !SOVEREIGN.test(region)) out.push(`Provisioned and overage SCUs are only priced in East US, West Europe, UK South and Australia East, so those lines use East US rates (not ${spec.region}).`);
    return out;
  },
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS, prov = n(c.provisionedScus), over = n(c.overageScuHours), payg = n(c.payAsYouGoScus), lic = n(c.m365E5Licenses);
    if (!Number.isInteger(prov) || prov < 0) throw new PricingError('provisionedScus must be a whole number (0, or 1 or more).');
    if (!Number.isInteger(lic) || lic < 0) throw new PricingError('m365E5Licenses must be a whole number.');
    if (!Number.isInteger(hours) || hours < 1 || hours > 744) throw new PricingError('hours must be a whole number between 1 and 744.');
    if (over < 0 || payg < 0) throw new PricingError('overageScuHours and payAsYouGoScus cannot be negative.');
    if (!prov && !payg && !over) throw new PricingError('Set provisionedScus (1 or more) or payAsYouGoScus.');
    if (over && !prov) throw new PricingError('Overage SCUs only apply on top of provisioned SCUs; set provisionedScus.');
    const lines = [], notes = [];
    const regionRows = async region => rows(`serviceName eq 'Microsoft Security Copilot' and armRegionName eq '${region}' and priceType eq 'Consumption'`, ctx);
    let capRegion = ctx.region, cap = [];
    if (prov || over) {
      cap = await regionRows(ctx.region);
      if (!cap.some(r => r.skuName === 'Provisioned')) {
        if (SOVEREIGN.test(ctx.region)) throw new PricingError(`Security Copilot provisioned capacity is not priced in ${ctx.region}; it is sold in ${CAPACITY_REGIONS.join(', ')}.`);
        capRegion = CAPACITY_REGIONS[0];
        cap = await regionRows(capRegion);
        if (!cap.some(r => r.skuName === 'Provisioned')) throw new PricingError(`Security Copilot capacity is not priced in ${ctx.region} or ${capRegion}.`);
        notes.push(`Security Copilot provisioned and overage SCUs are only priced in ${CAPACITY_REGIONS.join(', ')}; rates shown are for ${capRegion}.`);
      }
    }
    const G = 'AI', S = 'Microsoft Security Copilot';
    if (prov) lines.push(meterLine(G, S, `Provisioned SCUs, ${fmtN(prov)} SCU(s) x ${fmtN(hours)} hours`, single(cap.filter(r => r.meterName === 'Provisioned Security Compute Unit'), `provisioned SCUs in ${capRegion}`), prov * hours, ctx, { unit: 'SCU-hours' }));
    if (over) lines.push(meterLine(G, S, `Overage SCUs, ${fmtN(over)} SCU-hours a month`, single(cap.filter(r => r.meterName === 'Overage Security Compute Unit'), `overage SCUs in ${capRegion}`), over, ctx, { unit: 'SCU-hours' }));
    let billable = 0;
    if (payg) {
      const free = allowance(c);
      billable = Math.max(0, payg - free);
      const pr = await regionRows(ctx.region);
      lines.push(meterLine(G, S, `Pay-as-you-go SCUs, ${fmtN(payg)} consumed a month${free ? ` minus ${fmtN(free)} included with ${fmtN(lic)} Microsoft 365 E5/E7 licenses = ${fmtN(billable)} billed` : ''}`, single(pr.filter(r => r.meterName === 'Pay As You Go Security Compute Unit'), `pay-as-you-go SCUs in ${ctx.region}`), billable, ctx, { unit: 'SCUs' }));
      notes.push('Microsoft 365 E5 and E7 customers get 400 SCUs a month for every 1,000 paid licenses, up to 10,000 SCUs a month, at no extra cost; SCUs beyond that are billed per SCU.');
    }
    if (prov) notes.push('Provisioned SCUs are billed in whole clock-hours with a one-hour minimum, so changing capacity mid-hour still bills the full hour. Overage SCUs are billed only for what is used, to one decimal place.');
    return { lines, notes, facts: { provisionedScus: prov, hours, overageScuHours: over, payAsYouGoScus: payg, m365E5Licenses: lic, billablePayAsYouGoScus: billable } };
  }
};
