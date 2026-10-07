'use strict';
// Microsoft Defender External Attack Surface Management (EASM). One meter, billed per billable asset per day
// under serviceName 'Microsoft Defender for Cloud'. Hosts, domains and IP addresses share one price; the 30-day
// trial SKU (price 0) is never used. The calculator's default month is 30 days.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const REGIONS = ['eastasia', 'southeastasia', 'australiaeast', 'brazilsouth', 'canadacentral', 'centralindia', 'northeurope', 'westeurope', 'francecentral', 'germanywestcentral', 'japaneast', 'koreacentral', 'malaysiawest', 'newzealandnorth', 'norwayeast', 'southafricanorth', 'swedencentral', 'switzerlandnorth', 'uaenorth', 'uksouth', 'centralus', 'eastus', 'eastus2', 'northcentralus', 'southcentralus', 'westus', 'westus2', 'westus3'];
const KINDS = [['hosts', 'hostDays', 'host:IP combination(s)'], ['domains', 'domainDays', 'domain(s)'], ['ipAddresses', 'ipDays', 'IP address(es)']];
const daysOf = (c, dk) => c[dk] ?? c.days ?? 30;
const splitOf = c => n(c.hosts) + n(c.domains) + n(c.ipAddresses);

module.exports = {
  type: 'defender-easm',
  label: 'Microsoft Defender External Attack Surface Management',
  family: 'security',
  calculator: ['defender-easm'],
  keywords: ['attack surface', 'easm', 'external attack surface', 'internet exposed assets', 'asset discovery', 'domains and ips'],
  fields: {
    assets: { int: true, min: 0, ask: 'How many billable internet-facing assets does the company have in total (domains, hosts and IP addresses, counted as in the Billable assets page of a Defender EASM trial)? Give either this total or the split into hosts, domains and ipAddresses, not both added together; if both are given they must add up to the same number. If unknown, suggest 500 and record it as an assumption.' },
    hosts: { def: 0, int: true, min: 0, ask: 'Instead of the total: how many hosts (host name and IP address pairs that resolve) are in the approved inventory?' },
    domains: { def: 0, int: true, min: 0, ask: 'Instead of the total: how many domains are in the approved inventory?' },
    ipAddresses: { def: 0, int: true, min: 0, ask: 'Instead of the total: how many IP addresses are in the approved inventory?' },
    days: { def: 30, int: true, min: 1, max: 31, ask: 'Days a month the assets are monitored (30 is a full month and is the calculator default).' },
    hostDays: { int: true, min: 1, max: 31, ask: 'Only if hosts are monitored for a different number of days than the rest.' },
    domainDays: { int: true, min: 1, max: 31, ask: 'Only if domains are monitored for a different number of days than the rest.' },
    ipDays: { int: true, min: 1, max: 31, ask: 'Only if IP addresses are monitored for a different number of days than the rest.' }
  },
  examples: [
    { type: 'defender-easm', assets: 500 },
    { type: 'defender-easm', assets: 1000, hosts: 600, domains: 300, ipAddresses: 100, days: 31, ipDays: 15 }
  ],
  readback: c => {
    const parts = [];
    if (!splitOf(c) && n(c.assets)) parts.push(`${fmtN(n(c.assets))} billable assets x ${fmtN(daysOf(c, 'days'))} days`);
    if (splitOf(c)) for (const [k, dk, label] of KINDS) if (n(c[k])) parts.push(`${fmtN(n(c[k]))} ${label} x ${fmtN(daysOf(c, dk))} days`);
    return `Defender EASM: ${parts.join(', ') || '0 billable assets'} a month (the calculator uses a 30-day month)`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : ['The 30-day free trial and any Microsoft Defender for Cloud or Defender XDR plans are not included.']),
  price: async (c, ctx) => {
    for (const k of ['assets', 'hosts', 'domains', 'ipAddresses']) if (c[k] != null && (!Number.isInteger(c[k]) || c[k] < 0)) throw new PricingError(`${k} must be a whole number of 0 or more.`);
    for (const k of ['days', 'hostDays', 'domainDays', 'ipDays']) if (c[k] != null && (!Number.isInteger(c[k]) || c[k] < 1 || c[k] > 31)) throw new PricingError(`${k} must be a whole number from 1 to 31 (more than 0 and at most 31).`);
    const split = splitOf(c);
    if (n(c.assets) > 0 && split > 0 && n(c.assets) !== split) throw new PricingError(`assets (${fmtN(n(c.assets))}) and hosts + domains + ipAddresses (${fmtN(split)}) disagree: give the total or the split, not both, or make them add up to the same number.`);
    const parts = (split > 0 ? KINDS.map(([k, dk, label]) => [label, n(c[k]), daysOf(c, dk)]) : [['billable assets', n(c.assets), daysOf(c, 'days')]]).filter(p => p[1] > 0);
    if (!parts.length) throw new PricingError('No billable assets: set assets, or hosts, domains and ipAddresses, above 0.');
    const rs = await rows(`serviceName eq 'Microsoft Defender for Cloud' and productName eq 'Defender External Attack Surface Management' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Defender EASM is not priced in ${ctx.region}. It is offered in: ${REGIONS.join(', ')}.`);
    const meter = single(rs.filter(r => r.meterName === 'Defender EASM Standard Asset'), `Defender EASM billable assets in ${ctx.region}`);
    const lines = parts.map(([label, qty, d]) => meterLine('Security', 'Microsoft Defender for Cloud', `Defender EASM: ${fmtN(qty)} ${label} x ${fmtN(d)} days`, meter, qty * d, ctx, { unit: 'asset-days' }));
    return {
      lines,
      notes: [
        'Defender EASM bills each billable asset per day (the meter unit is one asset); only assets in the Approved Inventory state count, and a domain is not counted again when one of its hosts is billable.',
        'The first Defender EASM resource a customer creates gets a 30-day free trial, which is not included here.',
        'The calculator uses a 30-day month by default (500 assets = 500 x 30 x the daily price).'
      ],
      facts: { assets: splitOf(c) || n(c.assets), days: c.days ?? 30 }
    };
  }
};
