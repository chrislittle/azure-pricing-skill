'use strict';
// Azure Virtual Enclaves: one hourly charge per enclave. The meter is regionless (Global, or 'US Gov' for Azure Government).
// The resources the enclave manages (Virtual WAN, Firewall, virtual network, Log Analytics, storage, optional Bastion) are billed separately.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'virtual-enclaves',
  label: 'Azure Virtual Enclaves',
  family: 'security',
  calculator: ['azure-virtual-enclaves'],
  keywords: ['virtual enclaves', 'azure enclave', 'secure enclave', 'enclave', 'isolated workload environment', 'mission enclave', 'secure landing zone'],
  fields: {
    enclaves: { req: true, int: true, min: 1, ask: 'How many separate enclaves (isolated, governed environments for a project, mission or data set) do you need? If unknown, suggest 1 and record it as an assumption.' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours per month will each enclave exist (730 is a full month, which is the normal answer)? Part of an hour is billed as a full hour, so the estimate rounds up.' }
  },
  context: ['production'],
  examples: [
    { type: 'virtual-enclaves', enclaves: 1 },
    { type: 'virtual-enclaves', enclaves: 4, hours: 400 }
  ],
  readback: c => `${fmtN(c.enclaves)} enclave(s), ${fmtN(c.hours == null ? 730 : c.hours)} hours a month`,
  notIncluded: () => ['The community infrastructure the enclave runs on, which is billed separately and the calculator adds on top of the enclave fee: add it as its own components - azure-firewall (Standard by default), virtual-wan (1 hub), bastion (Standard, 2 scale units), connectivity (vpn-gateway, expressroute or VNet peering), Log Analytics (about 7 GB a day in the calculator) and data-transfer (about 50 GB egress) - plus storage and the workloads inside the enclave'],
  price: async (c, ctx) => {
    const count = n(c.enclaves);
    if (!Number.isInteger(count) || count < 1) throw new PricingError('enclaves must be a whole number of at least 1.');
    const hours = c.hours == null ? 730 : n(c.hours);
    if (!(hours >= 0) || hours > 744) throw new PricingError('hours must be between 0 and 744.');
    const billed = Math.ceil(hours);
    const gov = /^usgov|^usdod/.test(ctx.region);
    const rs = await rows(`serviceName eq 'Azure Virtual Enclaves' and armRegionName eq '${gov ? 'US Gov' : 'Global'}' and priceType eq 'Consumption'`, ctx);
    const m = rs.filter(r => r.meterName === 'Standard Service');
    if (!m.length) throw new PricingError('The enclave service fee is not priced for this region.');
    return {
      lines: [meterLine('Security', 'Azure Virtual Enclaves', `Enclave service fee: ${fmtN(count)} enclave(s) x ${fmtN(billed)} hours`, single(m, 'enclave service fee'), count * billed, ctx, { unit: 'enclave-hours' })],
      notes: ['The enclave fee is one flat hourly rate per enclave (partial hours round up); you also pay for the resources it manages - Firewall, Virtual WAN, Bastion, connectivity, Log Analytics and bandwidth - at their own rates, so a real estimate needs those components too. Availability is limited to the regions listed in the Azure Virtual Enclaves pricing calculator; the fee itself is a single global rate.'],
      facts: { enclaves: count, hours: billed }
    };
  }
};
