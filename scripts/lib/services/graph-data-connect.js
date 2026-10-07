'use strict';
// Microsoft Graph Data Connect: copies Microsoft 365 datasets into your Azure tenant.
// Meter: serviceName 'Microsoft Graph data connect', one global meter billed per 1,000 objects extracted.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'graph-data-connect',
  label: 'Microsoft Graph Data Connect',
  family: 'analytics',
  calculator: ['graph-data-connect'],
  keywords: ['graph data connect', 'microsoft graph', 'microsoft 365 data', 'm365 data', 'office 365 data', 'email calendar data', 'workplace analytics export', 'teams data export'],
  fields: {
    objects: { req: true, int: true, min: 0, ask: 'Roughly how many Microsoft 365 items (objects) will you copy out per month? An object is one record, for example one email message, one calendar event or one user row. To size it: users x items per user per day x days of data. The calculator default is about 177 items per user per day (87 emails, 74 Teams chats, 8 files, 3 calendar events, 3 call records, 2 tasks), so 1,000 users for 14 days is about 2.5 million. If unknown, suggest 1,000,000 and record it as an assumption.' },
    runs: { def: 1, int: true, min: 1, ask: 'How many separate extraction runs (pipeline runs) will you do per month? Each run is rounded up to the next 1,000 objects. If unknown, use 1 and record it as an assumption.' }
  },
  context: [],
  examples: [
    { type: 'graph-data-connect', objects: 1000000 },
    { type: 'graph-data-connect', objects: 25000000 }
  ],
  readback: c => `Graph Data Connect: ${fmtN(n(c.objects))} objects extracted a month in ${fmtN(n(c.runs ?? 1))} pipeline run(s)`,
  notIncluded: (types, spec) => (spec.excluded || []).includes('gdc-pipeline') ? [] : ['Azure Data Factory (the pipeline that runs the extraction), the Azure storage account that receives the data, and any Azure Synapse or Databricks processing are priced separately.'],
  price: async (c, ctx) => {
    const objects = n(c.objects);
    const runs = n(c.runs ?? 1);
    if (objects < 0) throw new PricingError('objects cannot be negative.');
    if (!Number.isInteger(objects)) throw new PricingError('objects must be a whole number.');
    if (!Number.isInteger(runs) || runs < 1) throw new PricingError('runs must be a whole number of at least 1.');
    if (/^(usgov|usdod|china)/i.test(String(ctx.region || ''))) throw new PricingError('Graph Data Connect is not offered in Azure Government or China regions, so it cannot be priced for ' + ctx.region + '. It is available in North America, Europe, Asia Pacific, the United Kingdom and Australia.');
    const billed = objects ? runs * Math.ceil(objects / runs / 1000) * 1000 : 0;
    const rs = await rows(`serviceName eq 'Microsoft Graph data connect' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    const m = single(rs.filter(r => r.meterName === 'Standard 1K Objects Extracted'), 'Graph Data Connect objects extracted');
    return {
      lines: [meterLine('Analytics', 'Microsoft Graph Data Connect', `Objects extracted, ${fmtN(objects)}/month in ${fmtN(runs)} run(s)`, m, billed, ctx, { unit: 'objects' })],
      notes: ['Graph Data Connect is billed per 1,000 objects extracted; the price is the same in every region. Each pipeline run is billed separately and rounded up to the next 1,000 objects.', 'The Azure Data Factory pipeline and storage that receive the data are billed separately.'],
      facts: { objects, runs }
    };
  }
};
