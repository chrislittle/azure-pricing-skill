'use strict';
// Azure Cloud Services (extended support): web and worker role instances billed per instance-hour by VM size.
// DEPRECATED: Microsoft retires the service on 2027-03-31. Meters: serviceName 'Cloud Services', regional, one
// meter per size. Scope: the sizes in the Azure calculator, minus retired series (A v1 and H v1 are refused);
// low-priority meters are excluded because no Cloud Services (extended support) documentation offers them.
// Exception to the skill's VM lifecycle policy: every priceable role size is on the End of Life list (no Current or
// Extended Cloud Services meters exist), so they are priced with a per-size note and a cited advisory instead of refused.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const norm = s => String(s || '').toLowerCase().replace(/^standard_/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const ALLOWED = new Set(['Av2 Series', 'D Series', 'Dv2 Series', 'Dv3 Series', 'Ev3 Series', 'FSv2 Series', 'G Series']);
const NOT_OFFERED = new Set(['d15i v2', 'e64i v3']);
const LEGACY = ['extrasmall', 'small', 'medium', 'large', 'extralarge'];
const SERIES_NAME = { 'Av2 Series': 'Av2', 'D Series': 'D', 'Dv2 Series': 'Dv2', 'Dv3 Series': 'Dv3', 'Ev3 Series': 'Ev3', 'FSv2 Series': 'Fsv2', 'G Series': 'G' };

module.exports = {
  type: 'cloud-services',
  label: 'Azure Cloud Services (extended support)',
  family: 'compute-other',
  calculator: ['cloud-services'],
  keywords: ['cloud services', 'web role', 'worker role', 'cloud service', 'paas roles', 'extended support', 'cspkg'],
  fields: {
    instances: { req: true, int: true, min: 1, ask: 'How many role instances (virtual machines running the web and worker roles) will the cloud service run in total? If unknown, suggest 2 and record it as an assumption.' },
    size: { def: 'D2 v2', ask: 'Which instance size do the roles use? Give the size from their service definition (for example "D2 v2", "D4 v3", "F4s v2", "E4 v3" or "Standard_D2_v2"), or if they do not know it, how many CPU cores and how much memory each instance needs. If unknown, suggest "D2 v2" (2 cores, 7 GB) and record it as an assumption.' },
    hours: { def: HOURS, min: 0, max: 744, ask: 'Hours a month each instance runs (730 = all month; a stopped but still allocated instance keeps billing).' }
  },
  context: ['production'],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Storage for diagnostics and the package, and any SQL or other databases the roles use',
    'Load balancer, public IP addresses (each billed separately) and outbound data transfer',
    'Azure Key Vault, which Microsoft requires for managing certificates',
    'Reserved instances and savings plans: no reservation prices are published for Cloud Services in the Azure Retail Prices API',
    'Low-priority role instances: the calculator lists a Low Priority tier, but no Cloud Services (extended support) documentation offers it, so it is not priced'
  ]),
  examples: [
    { type: 'cloud-services', instances: 2, size: 'D2 v2' },
    { type: 'cloud-services', instances: 4, size: 'F4s v2', hours: 300 },
    { type: 'cloud-services', instances: 3, size: 'A2 v2', hours: 730 }
  ],
  readback: c => {
    const hrs = c.hours ?? HOURS;
    return `Cloud Services: ${fmtN(n(c.instances))} ${c.size || 'D2 v2'} role instance(s), ${hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month`}`;
  },
  price: async (c, ctx) => {
    const count = n(c.instances), size = String(c.size || 'D2 v2').trim(), key = norm(size), hours = c.hours ?? HOURS;
    if (!(count >= 1)) throw new PricingError('instances must be at least 1.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (LEGACY.includes(key) || /^(basic )?a\d+$/.test(key) || /^h\d+/.test(key)) {
      throw new PricingError(`Role size "${size}" belongs to a retired VM series (A series v1 retired 31 August 2024, H series v1 retired 31 August 2022) and cannot be created or run. Use a size such as D2 v2, D4 v3, E4 v3 or F4s v2.`);
    }
    if (NOT_OFFERED.has(key)) throw new PricingError(`"${size}" is not a size offered for Cloud Services (extended support). See https://learn.microsoft.com/azure/cloud-services-extended-support/available-sizes`);
    const rs = (await rows(`serviceName eq 'Cloud Services' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx)).filter(r => ALLOWED.has(r.productName.replace('Cloud Services ', '')) && !/ Low Priority$/.test(r.meterName));
    if (!rs.length) throw new PricingError(`Cloud Services is not priced in ${ctx.region}.`);
    const hit = rs.filter(r => norm(r.meterName) === key);
    if (!hit.length) {
      const sizes = [...new Set(rs.map(r => r.meterName))].sort();
      throw new PricingError(`No Cloud Services size "${size}" in ${ctx.region}. Sizes offered there: ${sizes.join(', ')}.`);
    }
    const m = single(hit, `Cloud Services ${size}`);
    const series = SERIES_NAME[m[0].productName.replace('Cloud Services ', '')];
    const line = meterLine('Compute', 'Cloud Services', `Cloud Services ${m[0].meterName} role instances (${series} series), ${fmtN(count)} x ${fmtN(hours)} hours`, m, count * hours, ctx, { unit: 'hours' });
    const notes = [
      'Cloud Services (extended support) is deprecated and Microsoft retires it on 2027-03-31; plan a migration (Microsoft names Service Fabric managed cluster as the target) before then.',
      `The ${series} series is on Microsoft's End of Life VM list and is subject to capacity growth restrictions (new subscriptions cannot deploy it; no additional quota for existing ones), so check capacity before committing.`,
      'The rate shown is the per-instance-hour rate in the calculator and Retail Prices API; Microsoft does not document a separate operating system charge for role instances.',
      'An instance is billed for every hour it is allocated, even if the application is stopped.'
    ];
    return { lines: [line], notes, facts: { size: m[0].meterName, series, endOfLifeSeries: true, instances: count, hours } };
  }
};
