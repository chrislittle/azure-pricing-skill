'use strict';
// Microsoft Defender ISOC (preview): pay-as-you-go ingestion of additional (non-native) security data per GB
// (serviceName 'Microsoft Defender', regional). Native Defender XDR data is not ingested into the workspace and is not billed here.
// The field keeps the name gbAnalyzed (the Retail meter is called "Pay As You Go Analysis"); it means GB ingested.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'defender-isoc',
  label: 'Microsoft Defender ISOC (pay-as-you-go data ingestion)',
  family: 'security',
  calculator: ['microsoft-defender-isoc'],
  keywords: ['isoc', 'integrated security operations', 'security operations center', 'soc', 'siem', 'defender portal', 'log ingestion', 'logs ingested', 'ingest', 'security data'],
  fields: {
    gbAnalyzed: { req: true, min: 0, ask: 'How many GB a month of ADDITIONAL security logs (from non-Microsoft tools or extra Microsoft sources through data connectors) will be ingested into the Defender ISOC workspace? Do not count native Defender data (Endpoint, Office 365, Identity, Cloud Apps): it is not ingested or billed here. If they know GB per day instead, enter 0 here and fill gbPerDay. If unknown, suggest 100 GB and record it as an assumption.' },
    gbPerDay: { def: 0, min: 0, ask: 'Only if they know the additional data per day: GB ingested per day (added to the monthly figure, so leave the monthly figure at 0).' },
    days: { def: 30, int: true, min: 1, max: 31, ask: 'Days a month the gbPerDay volume applies (30 by default).' }
  },
  examples: [
    { type: 'defender-isoc', gbAnalyzed: 100 },
    { type: 'defender-isoc', gbAnalyzed: 0, gbPerDay: 85, days: 30 }
  ],
  readback: c => {
    const parts = [];
    if (n(c.gbAnalyzed) || !n(c.gbPerDay)) parts.push(`${fmtN(n(c.gbAnalyzed))} GB of additional (non-native) data ingested a month`);
    if (n(c.gbPerDay)) parts.push(`${fmtN(n(c.gbPerDay))} GB a day x ${fmtN(n(c.days ?? 30))} days`);
    return `Defender ISOC (preview): ${parts.join(' plus ')}, pay as you go`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Native Defender data (Endpoint, Office 365, Identity, Cloud Apps) is not ingested into the ISOC workspace and is not billed here.',
    'The Microsoft Defender Suite, Microsoft 365 E5 or E7 license the preview requires is not in this estimate.'
  ]),
  price: async (c, ctx) => {
    const days = c.days ?? 30;
    if (n(c.gbAnalyzed) < 0 || n(c.gbPerDay) < 0) throw new PricingError('GB ingested cannot be negative.');
    if (!Number.isInteger(days) || days < 1 || days > 31) throw new PricingError('days must be a whole number from 1 to 31.');
    const gb = n(c.gbAnalyzed) + n(c.gbPerDay) * days;
    const rs = await rows(`serviceName eq 'Microsoft Defender' and productName eq 'Microsoft Defender ISOC' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Defender ISOC is not priced in ${ctx.region}. Try a region where it is offered, for example eastus2, westeurope or usgovarizona.`);
    const meter = single(rs.filter(r => r.meterName === 'Pay As You Go Analysis'), `Defender ISOC data ingestion in ${ctx.region}`);
    return {
      lines: [meterLine('Security', 'Microsoft Defender', `Defender ISOC pay-as-you-go ingestion of additional security data, ${fmtN(gb)} GB a month`, meter, gb, ctx, { unit: 'GB' })],
      notes: [
        'The per-GB price includes 90 days of retention for the ingested data; longer retention has no published meter and is not estimated.',
        'Defender ISOC is in preview, so prices and availability may change.',
        'Price per GB differs by region.'
      ],
      facts: { gbIngested: gb, gbAnalyzed: n(c.gbAnalyzed), gbPerDay: n(c.gbPerDay), days }
    };
  }
};
