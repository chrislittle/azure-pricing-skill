'use strict';
// Azure Health Data Services (FHIR service, DICOM service, MedTech service, de-identification service).
// Meters: serviceName 'Azure API for FHIR', productName 'Azure Health Data Services' (second-generation
// meters). The older 'Azure Health Data APIs' meters belong to Azure API for FHIR, retired on 30 September 2026,
// and the Healthcare Agent Service / model meters under the same serviceName are separate products: none are priced here.
// Prices are identical in every region the service is sold in, but meterIds differ for some meters, so match on meter name.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
// Monthly free allowances, taken from the Azure Pricing Calculator: each of these dimensions has a $0 "less-than-N" offer
// (api-requests 50K, events 100K, structured/blob storage 1 GB, transformations/de-identification/transcode 500 MB)
// and a paid "more-than-N" offer. The Retail Prices API shows them only as separate "Free - ..." meters, so subtract before pricing.
const FREE = { 'Structured Storage': 1, 'Blob Storage': 1, 'API Requests': 50000, Notifications: 100000, Transformations: 0.5, 'Structured De-Identification': 0.5, 'Transcode DICOM': 0.5 };
const OTHER = ['blobStorageGb', 'apiRequests', 'notifications', 'transformationsGb', 'fhirDeidGb', 'deidMb', 'exportBatchGb', 'exportStreamingGb', 'transcodeDicomGb'];

module.exports = {
  type: 'health-data-services',
  label: 'Azure Health Data Services',
  family: 'data-platform',
  calculator: ['health-data-services'],
  keywords: ['fhir', 'dicom', 'medtech', 'health data', 'healthcare', 'medical imaging', 'patient records', 'hl7', 'de-identification'],
  fields: {
    structuredStorageGb: { req: true, ask: 'How many GB of structured data will be stored: FHIR health records (patients, observations, encounters and their indexes) plus the metadata of any DICOM images (DICOM metadata is billed as structured storage; the images themselves are the next question)? The first 1 GB a month is free. Use 0 only if they store neither. If unknown, suggest 100 and record it as an assumption.' },
    blobStorageGb: { def: 0, ask: 'How many GB of medical images (the DICOM files themselves) will be stored? The first 1 GB a month is free. If they have no imaging, 0.' },
    apiRequests: { def: 0, int: true, min: 0, ask: 'Roughly how many API calls a month will apps make to the FHIR and DICOM services (reads, writes and searches each count as one request; failed 429 and 5xx responses are not charged)? The first 50,000 a month are free. If unknown, suggest 1,000,000 and record it as an assumption.' },
    notifications: { def: 0, int: true, min: 0, ask: 'Events feature only: how many change events a month will the FHIR or DICOM service publish (for example to Event Grid, whenever a record or image is created, updated or deleted)? The first 100,000 a month are free. If they do not use events, 0.' },
    transformationsGb: { def: 0, ask: 'How many GB a month will be converted between data formats (for example HL7 v2 or C-CDA to FHIR with the convert-data feature)? Device (MedTech) messages converted to FHIR are billed here too, plus API requests. The first 0.5 GB a month is free. If none, 0.' },
    fhirDeidGb: { def: 0, ask: 'How many GB a month of FHIR data will be exported with de-identification (personal details removed)? The first 0.5 GB a month is free. If none, 0.' },
    deidMb: { def: 0, ask: 'Only for the stand-alone de-identification service for free text and documents: how many MB a month will be de-identified? The first 50 MB each month are free. If none, 0.' },
    exportBatchGb: { def: 0, ask: 'How many GB a month will be bulk-exported from FHIR (the $export operation, for example to a data lake)? The first GB is billed at a higher rate than the rest. If none, 0.' },
    exportStreamingGb: { def: 0, ask: 'How many GB a month will be continuously streamed out of FHIR (for example to Fabric or Synapse)? The first GB is billed at a higher rate than the rest. If none, 0.' },
    transcodeDicomGb: { def: 0, ask: 'DICOM only: how many GB a month of images will be converted between image formats (transcoded)? The first 0.5 GB a month is free. If none, 0.' }
  },
  context: ['production'],
  examples: [
    { type: 'health-data-services', structuredStorageGb: 100, apiRequests: 1000000 },
    { type: 'health-data-services', structuredStorageGb: 500, blobStorageGb: 2000, apiRequests: 25000000, notifications: 5000000, transformationsGb: 20, fhirDeidGb: 10, deidMb: 500, exportBatchGb: 50, exportStreamingGb: 30, transcodeDicomGb: 100 }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.structuredStorageGb))} GB structured storage (FHIR data and DICOM metadata)`];
    if (n(c.blobStorageGb)) parts.push(`${fmtN(c.blobStorageGb)} GB DICOM image storage`);
    if (n(c.apiRequests)) parts.push(`${fmtN(c.apiRequests)} API requests a month`);
    if (n(c.notifications)) parts.push(`${fmtN(c.notifications)} FHIR/DICOM change events a month`);
    if (n(c.transformationsGb)) parts.push(`${fmtN(c.transformationsGb)} GB data conversions`);
    if (n(c.fhirDeidGb)) parts.push(`${fmtN(c.fhirDeidGb)} GB de-identified FHIR export`);
    if (n(c.deidMb)) parts.push(`${fmtN(c.deidMb)} MB through the de-identification service`);
    if (n(c.exportBatchGb)) parts.push(`${fmtN(c.exportBatchGb)} GB batch export`);
    if (n(c.exportStreamingGb)) parts.push(`${fmtN(c.exportStreamingGb)} GB streaming export`);
    if (n(c.transcodeDicomGb)) parts.push(`${fmtN(c.transcodeDicomGb)} GB DICOM transcoding`);
    return `Azure Health Data Services: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('health-data-extras') ? [] : [
    'The services that receive exported or streamed data (storage account, Event Hubs, Synapse/Fabric) and the Event Hubs/IoT Hub that feed MedTech.',
    'Outbound data transfer, private endpoints and monitoring/log storage.'
  ],
  price: async (c, ctx) => {
    for (const k of ['structuredStorageGb', ...OTHER]) if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    const rs = await rows(`serviceName eq 'Azure API for FHIR' and productName eq 'Azure Health Data Services' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Health Data Services is not priced in ${ctx.region}.`);
    const m = async (name, what) => {
      const r = rs.filter(x => x.meterName === name);
      if (!r.length) {
        const all = await rows(`serviceName eq 'Azure API for FHIR' and productName eq 'Azure Health Data Services' and meterName eq '${name}' and priceType eq 'Consumption'`, ctx);
        const where = [...new Set(all.map(x => x.armRegionName).filter(Boolean))].sort();
        throw new PricingError(`Health Data Services ${what} is not priced in ${ctx.region}.${where.length ? ` It is sold in: ${where.join(', ')}.` : ''}`);
      }
      return single(r, `Health Data Services ${what}`);
    };
    const G = 'Database', S = 'Azure Health Data Services', lines = [];
    const add = async (qty, desc, meter, what, unit) => {
      if (!(qty > 0) && what !== 'structured storage') return;
      const mr = await m(meter, what), free = FREE[meter] || 0, billable = Math.max(0, qty - free);
      const u = unit === 'GB / month' || unit === 'GB' ? ' GB' : '';
      lines.push(meterLine(G, S, `${desc}${free ? `; first ${fmtN(free)}${u} free, ${fmtN(billable)}${u} billed` : ''}${mr.length > 1 ? ' (graduated)' : ''}`, mr, billable, ctx, unit ? { unit } : undefined));
    };
    await add(n(c.structuredStorageGb), `FHIR structured storage, ${fmtN(n(c.structuredStorageGb))} GB/month`, 'Structured Storage', 'structured storage', 'GB / month');
    await add(n(c.blobStorageGb), `DICOM image (blob) storage, ${fmtN(n(c.blobStorageGb))} GB/month`, 'Blob Storage', 'blob storage', 'GB / month');
    await add(n(c.apiRequests), `FHIR and DICOM API requests, ${fmtN(n(c.apiRequests))}/month`, 'API Requests', 'API requests');
    await add(n(c.notifications), `FHIR/DICOM change events, ${fmtN(n(c.notifications))}/month`, 'Notifications', 'events');
    await add(n(c.transformationsGb), `Data format conversions (convert-data, MedTech), ${fmtN(n(c.transformationsGb))} GB`, 'Transformations', 'transformations', 'GB');
    await add(n(c.fhirDeidGb), `De-identified FHIR export, ${fmtN(n(c.fhirDeidGb))} GB`, 'Structured De-Identification', 'structured de-identification', 'GB');
    await add(n(c.deidMb), `De-identification service, ${fmtN(n(c.deidMb))} MB (first 50 MB free)`, 'De-Id', 'de-identification service', 'MB');
    await add(n(c.exportBatchGb), `Batch export from FHIR, ${fmtN(n(c.exportBatchGb))} GB`, 'Export Batch', 'batch export', 'GB');
    await add(n(c.exportStreamingGb), `Streaming export from FHIR, ${fmtN(n(c.exportStreamingGb))} GB`, 'Export Streaming', 'streaming export', 'GB');
    await add(n(c.transcodeDicomGb), `DICOM transcoding, ${fmtN(n(c.transcodeDicomGb))} GB`, 'Transcode DICOM', 'DICOM transcoding', 'GB');
    const notes = [
      'Azure Health Data Services is pay-as-you-go with no hourly service charge: you pay for stored GB, API requests (per 100,000), change events (per million) and the optional conversion, de-identification, export and transcoding features.',
      'Azure API for FHIR (the older, separately priced service) retired on 30 September 2026 and is not priced here; use the Azure Health Data Services FHIR service.'
    ];
    notes.push('Monthly free allowances (taken off before pricing): first 1 GB structured storage, 1 GB blob storage, 50,000 API requests, 100,000 events, 0.5 GB each of conversions, FHIR de-identification and DICOM transcoding, 50 MB of the de-identification service.');
    if (n(c.exportBatchGb) || n(c.exportStreamingGb)) notes.push('Export is graduated: the first 1 GB each month is billed at a higher rate than the GB after it.');
    if (n(c.blobStorageGb) && !n(c.structuredStorageGb)) notes.push('DICOM images are billed as blob storage and their metadata as structured storage, so DICOM usually needs structured storage too.');
    if (n(c.deidMb)) notes.push('The stand-alone de-identification service includes the first 50 MB each month free, then is billed per MB.');
    return { lines, notes, facts: { region: ctx.region, structuredStorageGb: n(c.structuredStorageGb), blobStorageGb: n(c.blobStorageGb), apiRequests: n(c.apiRequests), notifications: n(c.notifications) } };
  }
};
