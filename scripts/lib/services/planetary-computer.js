'use strict';
// Microsoft Planetary Computer Pro (GeoCatalog). Regional meters under serviceName 'Microsoft Planetary Computer Pro'.
// Offered in a limited set of regions (not eastus2).
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
// Representative vCPU-hours per GiB ingested (Learn: Planetary Computer Pro service usage metrics)
const INGEST = { 'sentinel-2': 0.5, 'micro-cog': 0.423, 'aerial-orthomosaic': 0.2, naip: 0.03 };

module.exports = {
  type: 'planetary-computer',
  label: 'Microsoft Planetary Computer Pro',
  family: 'ai-services',
  calculator: ['planetary-computer-pro'],
  keywords: ['planetary computer', 'geospatial', 'satellite imagery', 'geocatalog', 'earth observation', 'stac', 'raster data'],
  testRegions: ['westeurope', 'uksouth'],
  fields: {
    storageGb: { req: true, ask: 'How many GB of geospatial data (satellite or aerial imagery, rasters) will they keep stored? This is after conversion to cloud-optimised formats, which can differ slightly from the raw size. If unknown, suggest 1,000 and record it as an assumption.' },
    ingestedGb: { def: 0, ask: 'How many GB of new data will they load (ingest) each month? It is converted into compute hours using the data type below.' },
    dataType: { def: 'sentinel-2', enum: ['sentinel-2', 'micro-cog', 'aerial-orthomosaic', 'naip'], ask: 'What does the imagery look like? Sentinel-2 satellite scenes -> sentinel-2; many small already-optimised (COG) tiles -> micro-cog; large aerial orthomosaic mosaics -> aerial-orthomosaic; US NAIP aerial imagery already in COG format -> naip. If unsure, suggest sentinel-2 (the most expensive to ingest).' },
    ingestVcpuHours: { def: 0, ask: 'If they already know the compute hours (vCPU-hours) for loading data each month, enter them here; added to the estimate from ingested GB.' },
    operations: { def: 0, int: true, min: 0, ask: 'How many times a month will apps read or view stored data (tile requests, downloads, metadata lookups)? Searching the catalog itself is not counted. If unknown, suggest 1,000,000.' },
    bandwidthGb: { def: 0, ask: 'How many GB a month will be downloaded out of the Azure region where the catalog lives (downloads that leave Azure or go to another region)? Map tiles served through the Data API do not count.' },
    disasterRecovery: { def: false, ask: 'Do they want the business continuity and disaster recovery (BCDR) option? Yes -> true. It raises the per-GB storage rate and the per-read rate for all stored data and reads; nothing extra is added on top.' }
  },
  context: [],
  examples: [
    { type: 'planetary-computer', storageGb: 2000 },
    { type: 'planetary-computer', storageGb: 10000, ingestedGb: 500, dataType: 'naip', ingestVcpuHours: 20, operations: 5000000, bandwidthGb: 300, disasterRecovery: true }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.storageGb))} GB stored`];
    if (n(c.ingestedGb)) parts.push(`${fmtN(c.ingestedGb)} GB ingested a month (${c.dataType || 'sentinel-2'} imagery)`);
    if (n(c.ingestVcpuHours)) parts.push(`${fmtN(c.ingestVcpuHours)} extra ingestion vCPU-hours`);
    if (n(c.operations)) parts.push(`${fmtN(c.operations)} read operations a month`);
    if (n(c.bandwidthGb)) parts.push(`${fmtN(c.bandwidthGb)} GB leaving the region`);
    if (c.disasterRecovery) parts.push('with the disaster recovery (BCDR) option, which uses higher storage and read rates');
    return `Planetary Computer Pro: ${parts.join(', ')}`;
  },
  price: async (c, ctx) => {
    const type = (c.dataType || 'sentinel-2').toLowerCase();
    if (!INGEST[type]) throw new PricingError(`dataType must be one of: ${Object.keys(INGEST).join(', ')}.`);
    for (const k of ['storageGb', 'ingestedGb', 'ingestVcpuHours', 'operations', 'bandwidthGb']) if (n(c[k]) < 0) throw new PricingError(`${k} must not be negative.`);
    const rs = await rows(`serviceName eq 'Microsoft Planetary Computer Pro' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Microsoft Planetary Computer Pro is not offered in ${ctx.region}; try eastus, westeurope, uksouth, canadacentral, northcentralus or usgovvirginia.`);
    const m = name => single(rs.filter(r => r.meterName === name), `Planetary Computer Pro ${name}`);
    const G = 'AI', S = 'Microsoft Planetary Computer Pro', lines = [], dr = !!c.disasterRecovery;
    lines.push(meterLine(G, S, `Geospatial storage${dr ? ' (BCDR rate)' : ''}, ${fmtN(n(c.storageGb))} GB`, m(dr ? 'BCDR Geospatial Storage Data Stored' : 'Geospatial Storage Data Stored'), n(c.storageGb), ctx, { unit: 'GB / month' }));
    const vcpu = n(c.ingestedGb) * INGEST[type] + n(c.ingestVcpuHours);
    if (vcpu) lines.push(meterLine(G, S, `Ingestion and transformation, ${fmtN(Math.round(vcpu * 100) / 100)} vCPU-hours${n(c.ingestedGb) ? ` (${fmtN(c.ingestedGb)} GB of ${type} imagery x ${INGEST[type]} vCPU-hours per GB)` : ''}`, m('Ingest and Transform vCPU'), vcpu, ctx, { unit: 'vCPU-hours' }));
    if (n(c.operations)) lines.push(meterLine(G, S, `Geospatial data read operations${dr ? ' (BCDR rate)' : ''}, ${fmtN(c.operations)}/month`, m(dr ? 'BCDR Geospatial Data Read Operations' : 'Geospatial Data Operations'), n(c.operations), ctx));
    if (n(c.bandwidthGb)) lines.push(meterLine(G, S, `Bandwidth out of the region, ${fmtN(c.bandwidthGb)} GB`, m('Bandwidth Data Transfer'), n(c.bandwidthGb), ctx, { unit: 'GB' }));
    const notes = ['The BCDR option is priced as the Azure Pricing Calculator does: it replaces the storage and read rates with the higher BCDR rates and adds no separate copy. Microsoft has not published a BCDR description.', 'Quantities are in binary gigabytes (GiB). Searching the catalog (STAC API) and map tiles served through the Data API are not billed as operations or bandwidth.',
      'Ingestion compute is estimated from Microsoft\'s representative vCPU-hours per GiB for similar data; actual usage varies.'];
    return { lines, notes, facts: { storageGb: n(c.storageGb), ingestedGb: n(c.ingestedGb), vcpuHours: vcpu, disasterRecovery: !!c.disasterRecovery } };
  }
};

