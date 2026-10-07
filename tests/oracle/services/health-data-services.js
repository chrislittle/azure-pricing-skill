'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const CALC_URL = 'https://azure.microsoft.com/api/v3/pricing/health-data-services/calculator/?culture=en-us';
const CALC_REGION = { eastus2: 'us-east-2', westeurope: 'europe-west' };
let calcDataPromise;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function pickRows(rows, pred, what) {
  const hits = rows.filter(pred);
  if (!hits.length) throw new Error(`expected Retail API rows for ${what}, found ${hits.length}`);
  return hits;
}

function pickOne(rows, pred, what) {
  const hits = pickRows(rows, pred, what);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

function tiered(rows, qty) {
  const tiers = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  let cost = 0;
  const bands = [];
  for (let i = 0; i < tiers.length; i++) {
    const start = tiers[i].tierMinimumUnits;
    const end = i + 1 < tiers.length ? tiers[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    const units = Math.min(qty, end) - start;
    const bandCost = units * tiers[i].retailPrice;
    cost += bandCost;
    bands.push({ fromUnits: start, toUnits: end === Infinity ? null : end, units, unitPrice: tiers[i].retailPrice, cost: round2(bandCost) });
  }
  return { cost, bands };
}

async function calculatorData() {
  if (!calcDataPromise) {
    calcDataPromise = fetch(CALC_URL, { headers: { accept: 'application/json' } }).then(async res => {
      if (!res.ok) throw new Error(`Health Data Services calculator fetch failed: HTTP ${res.status}`);
      return res.json();
    });
  }
  return calcDataPromise;
}

function calcRegion(region) {
  const r = CALC_REGION[region];
  if (!r) throw new Error(`no Health Data Services calculator region mapping for ${region}`);
  return r;
}

function calcUnitPrice(data, offer, unit, region) {
  const r = calcRegion(region);
  const p = data.offers[offer]?.prices?.[unit]?.[r];
  if (!p) throw new Error(`calculator offer ${offer}/${unit} has no price for ${r}`);
  return p.value;
}

function calcGraduated(data, offer, unit, region, qty) {
  const r = calcRegion(region);
  const table = data.offers[offer]?.graduatedPrices?.[unit]?.[r]?.prices;
  if (!table) throw new Error(`calculator graduated offer ${offer}/${unit} has no prices for ${r}`);
  let previous = 0;
  let cost = 0;
  const bands = [];
  for (const band of table) {
    const limit = band.limit;
    const units = Math.max(0, Math.min(qty, limit) - previous);
    if (units) {
      const bandCost = units * band.price.value;
      cost += bandCost;
      bands.push({ fromUnits: previous, toUnits: limit > 1e100 ? null : limit, units, unitPrice: band.price.value, cost: round2(bandCost) });
    }
    previous = limit;
    if (qty <= limit) break;
  }
  return { cost, bands };
}

async function retailRows(region, currency) {
  return dedupe(await query(`productName eq 'Azure Health Data Services' and armRegionName eq '${region}'`, currency));
}

async function retailStreamingLine(rows, qty) {
  if (!qty) return null;
  const meterRows = pickRows(rows, r => r.skuName === 'Export Streaming' && r.meterName === 'Export Streaming' && r.unitOfMeasure === '1 GB' && r.type === 'Consumption', 'Export Streaming');
  const g = tiered(meterRows, qty / unitSize(meterRows[0].unitOfMeasure));
  return line(`exportStreamingGb: ${qty} GB through Retail API Export Streaming graduated bands`, g.cost, { meterId: meterRows[0].meterId, bands: g.bands });
}

async function healthDataServicesCalc(opts) {
  const { region } = opts;
  const data = await calculatorData();
  const lines = [];
  const priced = [
    ['structuredStorageGb', 1, 'structured-stoarage-more-than-1GB', 'pergbpermonth', 1, 'GB structured storage'],
    ['blobStorageGb', 1, 'blob-stoarage-more-than-1GB', 'pergbpermonth', 1, 'GB blob storage'],
    ['apiRequests', 50000, 'api-requests-more-than-50K', 'perhundredthousandapitransactions', 100000, 'API requests'],
    ['notifications', 100000, 'events-more-than-100K', 'permillion', 1000000, 'notification events'],
    ['transformationsGb', 0.5, 'fhir-transformations-more-than-500MB', 'pergb', 1, 'GB transformations'],
    ['fhirDeidGb', 0.5, 'deidentification-more-than-500MB', 'pergb', 1, 'GB structured de-identification'],
    ['transcodeDicomGb', 0.5, 'transcode-dicom-more-than-500MB', 'pergb', 1, 'GB DICOM transcoding'],
  ];
  for (const [field, free, offer, unit, divisor, label] of priced) {
    const qty = opts[field] || 0;
    if (!qty) continue;
    const paidQty = Math.max(0, qty - free);
    const price = calcUnitPrice(data, offer, unit, region);
    lines.push(line(`${field}: max(0, ${qty} - ${free} free ${label}) / ${divisor} * ${price}`, (paidQty / divisor) * price, { sourceOffer: offer }));
  }
  if (opts.deidMb) {
    const g = calcGraduated(data, 'unstructured-de-identification-50MB', 'permb', region, opts.deidMb);
    lines.push(line(`deidMb: ${opts.deidMb} MB through calculator 50 MB graduated band`, g.cost, { sourceOffer: 'unstructured-de-identification-50MB', bands: g.bands }));
  }
  if (opts.exportBatchGb) {
    const g = calcGraduated(data, 'export-batch', 'pergb', region, opts.exportBatchGb);
    lines.push(line(`exportBatchGb: ${opts.exportBatchGb} GB through calculator export-batch graduated bands`, g.cost, { sourceOffer: 'export-batch', bands: g.bands }));
  }
  const stream = await retailStreamingLine(await retailRows(region, 'USD'), opts.exportStreamingGb || 0);
  if (stream) lines.push(stream);
  return { monthlyList: totalOf(lines), lines };
}

async function healthDataServicesRetail(opts) {
  const { region, currency = 'USD' } = opts;
  const rows = await retailRows(region, currency);
  const lines = [];
  const simple = [
    ['structuredStorageGb', 'Structured Storage', 'Structured Storage', '1 GB/Month', 1],
    ['blobStorageGb', 'Blob Storage', 'Blob Storage', '1 GB/Month', 1],
    ['apiRequests', 'API Requests', 'API Requests', '100K', 50000],
    ['notifications', 'Notifications', 'Notifications', '1M', 100000],
    ['transformationsGb', 'Transformations', 'Transformations', '1 GB', 0.5],
    ['fhirDeidGb', 'Structured De-Identification', 'Structured De-Identification', '1 GB', 0.5],
    ['transcodeDicomGb', 'Transcode DICOM', 'Transcode DICOM', '1 GB', 0.5],
  ];
  for (const [field, skuName, meterName, uom, free] of simple) {
    const qty = opts[field] || 0;
    if (!qty) continue;
    const m = pickOne(rows, r => r.skuName === skuName && r.meterName === meterName && r.unitOfMeasure === uom && r.type === 'Consumption', meterName);
    const paidQty = Math.max(0, qty - free);
    lines.push(line(`${field}: max(0, ${qty} - ${free} free) / ${m.unitOfMeasure} * ${m.retailPrice}`, (paidQty / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (opts.deidMb) {
    const meterRows = pickRows(rows, r => r.skuName === 'De-Id' && r.meterName === 'De-Id' && r.unitOfMeasure === '1 MB' && r.type === 'Consumption', 'De-Id');
    const g = tiered(meterRows, opts.deidMb);
    lines.push(line(`deidMb: ${opts.deidMb} MB through De-Id graduated bands`, g.cost, { meterId: meterRows[0].meterId, bands: g.bands }));
  }
  for (const [field, meterName] of [['exportBatchGb', 'Export Batch']]) {
    const qty = opts[field] || 0;
    if (!qty) continue;
    const meterRows = pickRows(rows, r => r.skuName === meterName && r.meterName === meterName && r.unitOfMeasure === '1 GB' && r.type === 'Consumption', meterName);
    const g = tiered(meterRows, qty / unitSize(meterRows[0].unitOfMeasure));
    lines.push(line(`${field}: ${qty} GB through ${meterName} graduated bands`, g.cost, { meterId: meterRows[0].meterId, bands: g.bands }));
  }
  const stream = await retailStreamingLine(rows, opts.exportStreamingGb || 0);
  if (stream) lines.push(stream);
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'health-data-services',
  source: 'both',
  cases: [
    {
      name: 'free monthly allowances all inside',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'health-data-services', structuredStorageGb: 1, blobStorageGb: 1, apiRequests: 50000, notifications: 100000, transformationsGb: 0.5, fhirDeidGb: 0.5, transcodeDicomGb: 0.5 },
      // Calculator v3 has explicit $0 offers for <=1 GB structured/blob, <=50K API requests, <=100K events, and <=0.5 GB transformations/de-identification/DICOM transcoding.
      expected: async () => healthDataServicesCalc({ region: 'eastus2', structuredStorageGb: 1, blobStorageGb: 1, apiRequests: 50000, notifications: 100000, transformationsGb: 0.5, fhirDeidGb: 0.5, transcodeDicomGb: 0.5 }),
    },
    {
      name: 'free monthly allowances just above',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'health-data-services', structuredStorageGb: 1.25, blobStorageGb: 1.25, apiRequests: 60000, notifications: 150000, transformationsGb: 0.75, fhirDeidGb: 0.75, transcodeDicomGb: 0.75 },
      // Calculator v3 paid offers apply only to usage above the free monthly allowances: 0.25 GB storage/process, 10K API requests, and 50K events.
      expected: async () => healthDataServicesCalc({ region: 'eastus2', structuredStorageGb: 1.25, blobStorageGb: 1.25, apiRequests: 60000, notifications: 150000, transformationsGb: 0.75, fhirDeidGb: 0.75, transcodeDicomGb: 0.75 }),
    },
    {
      name: 'storage and api requests',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'health-data-services', structuredStorageGb: 100, blobStorageGb: 250, apiRequests: 1000000 },
      // Calculator v3 charges only storage above the 1 GB grants and API requests above 50K, using the published paid offers.
      expected: async () => healthDataServicesCalc({ region: 'eastus2', structuredStorageGb: 100, blobStorageGb: 250, apiRequests: 1000000 }),
    },
    {
      name: 'de-id just below 50 MB free band',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'health-data-services', structuredStorageGb: 0, deidMb: 49 },
      // Calculator v3 unstructured-de-identification-50MB graduated offer prices 0-50 MB at $0.
      expected: async () => healthDataServicesCalc({ region: 'eastus2', structuredStorageGb: 0, deidMb: 49 }),
    },
    {
      name: 'de-id just above 50 MB free band',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'health-data-services', structuredStorageGb: 0, deidMb: 51 },
      // Calculator v3 unstructured-de-identification-50MB graduated offer bills only 1 MB above the 50 MB free band.
      expected: async () => healthDataServicesCalc({ region: 'eastus2', structuredStorageGb: 0, deidMb: 51 }),
    },
    {
      name: 'all processing dimensions',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'health-data-services', structuredStorageGb: 25, notifications: 2000000, transformationsGb: 10, fhirDeidGb: 5, exportBatchGb: 2, exportStreamingGb: 2, transcodeDicomGb: 100 },
      // Calculator v3 allowances apply before notifications, transformations, FHIR de-id, and DICOM transcoding; export-batch is calculator graduated and streaming export uses Retail API graduated rows.
      expected: async () => healthDataServicesCalc({ region: 'eastus2', structuredStorageGb: 25, notifications: 2000000, transformationsGb: 10, fhirDeidGb: 5, exportBatchGb: 2, exportStreamingGb: 2, transcodeDicomGb: 100 }),
    },
    {
      name: 'west europe same published service meters',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'health-data-services', structuredStorageGb: 10, blobStorageGb: 1000, apiRequests: 250000, exportBatchGb: 0.5 },
      // Calculator v3 West Europe paid offers are used after the 1 GB storage and 50K API free allowances; export batch first GB uses the tier-0 price.
      expected: async () => healthDataServicesCalc({ region: 'westeurope', structuredStorageGb: 10, blobStorageGb: 1000, apiRequests: 250000, exportBatchGb: 0.5 }),
    },
    {
      name: 'eur storage requests and de-id',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'health-data-services', structuredStorageGb: 50, blobStorageGb: 50, apiRequests: 500000, deidMb: 75 },
      // EUR Retail API rows are queried natively; the same free allowances are applied independently, including 1 GB storage, 50K API requests, and 50 MB De-Id.
      expected: async () => healthDataServicesRetail({ region: 'westeurope', currency: 'EUR', structuredStorageGb: 50, blobStorageGb: 50, apiRequests: 500000, deidMb: 75 }),
    },
  ],
};
