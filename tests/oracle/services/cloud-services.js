'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'cloud-services';
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function canonicalSize(size) { return String(size).replace(/^Standard_/i, '').replace(/_/g, ' '); }
function offerName(size) { return `${canonicalSize(size).toLowerCase().replace(/\s+/g, '')}-standard-payg`; }
async function calcCloud({ region, instances, size, hours = 730 }) {
  const offer = offerName(size); const p = (await calc.offerPrice(SLUG, offer, region)).value;
  const lines = [line(`${canonicalSize(size)} standard: ${instances} instances * ${hours} hours * ${p}`, instances * hours * p, { sourceOffer: offer })];
  return { monthlyList: totalOf(lines), lines };
}
async function retailCloud({ region, currency, instances, size, hours = 730 }) {
  const rs = dedupe(await query(`serviceName eq 'Cloud Services' and armRegionName eq '${region}'`, currency, { maxPages: 30 }));
  const meter = canonicalSize(size);
  const hits = rs.filter(r => r.type === 'Consumption' && r.skuName === meter && r.meterName === meter);
  if (hits.length !== 1) throw new Error(`expected one Cloud Services meter ${meter}, found ${hits.length}`);
  const row = hits[0];
  const lines = [line(`${meter}: ${instances} instances * ${hours} hours * ${row.retailPrice}`, instances * hours / unitSize(row.unitOfMeasure) * row.retailPrice, { meterId: row.meterId })];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = { type: 'cloud-services', source: 'both', cases: [
  { name: 'D2 v2 standard all month', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 2, size: 'D2 v2' },
    // Calculator cloud-services d2v2-standard-payg offer is hourly per role instance; multiply by 2 instances and 730 hours.
    expected: async () => calcCloud({ region: 'eastus2', instances: 2, size: 'D2 v2' }) },
  { name: 'Standard underscore size normalized', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 1, size: 'Standard_D2_v2' },
    // Public questions accept Azure-style Standard_* names; calculator offer d2v2-standard-payg is the same D2 v2 hourly Cloud Services meter.
    expected: async () => calcCloud({ region: 'eastus2', instances: 1, size: 'Standard_D2_v2' }) },
  { name: 'A2 v2 standard part time', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 3, size: 'A2 v2', hours: 100 },
    // Calculator A2 v2 standard pay-as-you-go offer prorates directly by the supplied 100 hours per instance.
    expected: async () => calcCloud({ region: 'eastus2', instances: 3, size: 'A2 v2', hours: 100 }) },
  { name: 'D4 v3 standard larger size', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 1, size: 'D4 v3' },
    // Calculator d4v3-standard-payg covers a larger Dv3 role instance billed hourly.
    expected: async () => calcCloud({ region: 'eastus2', instances: 1, size: 'D4 v3' }) },
  { name: 'F4s v2 compute optimized part time', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 4, size: 'F4s v2', hours: 50 },
    // Calculator f4sv2-standard-payg is an hourly Cloud Services meter; reservations and low-priority are not exposed by the current component spec.
    expected: async () => calcCloud({ region: 'eastus2', instances: 4, size: 'F4s v2', hours: 50 }) },
  { name: 'hours upper boundary 744', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 1, size: 'D2 v2', hours: 744 },
    // Public questions allow up to 744 hours; the calculator D2 v2 hourly offer is multiplied by the boundary value.
    expected: async () => calcCloud({ region: 'eastus2', instances: 1, size: 'D2 v2', hours: 744 }) },
  { name: 'retired A series refused', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 1, size: 'A2' },
    // A-series v1 Cloud Services sizes are retired and should be refused rather than priced from stale calculator rows.
    expectEngineError: /retired VM series|A series v1 retired/i },
  { name: 'retired H series refused', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 1, size: 'H8' },
    // H-series v1 Cloud Services sizes are retired and should be refused rather than priced from stale calculator rows.
    expectEngineError: /retired VM series|H series v1 retired/i },
  { name: 'VM size not offered for Cloud Services refused', region: 'eastus2', currency: 'USD', component: { type: 'cloud-services', instances: 1, size: 'B2s' },
    // Burstable B-series VM sizes are not offered for Cloud Services in East US 2; the engine should refuse with the offered-size list.
    expectEngineError: /No Cloud Services size "B2s"|Sizes offered/i },
  { name: 'west europe regional D2 v2 price', region: 'westeurope', currency: 'USD', component: { type: 'cloud-services', instances: 2, size: 'D2 v2' },
    // Calculator West Europe d2v2-standard-payg is region-specific and higher than East US 2.
    expected: async () => calcCloud({ region: 'westeurope', instances: 2, size: 'D2 v2' }) },
  { name: 'EUR west europe E4 v3 standard', region: 'westeurope', currency: 'EUR', component: { type: 'cloud-services', instances: 1, size: 'E4 v3', hours: 100 },
    // Retail API queried in EUR returns the West Europe E4 v3 Cloud Services hourly consumption meter.
    expected: async () => retailCloud({ region: 'westeurope', currency: 'EUR', instances: 1, size: 'E4 v3', hours: 100 }) },
] };
