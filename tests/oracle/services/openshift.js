'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS = 730;
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function rows(currency) { return dedupe(await query("serviceName eq 'Virtual Machines Licenses' and contains(productName, 'Azure Red Hat OpenShift')", currency, { maxPages: 60 })); }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one OpenShift row for ${what}, found ${hits.length}`); return hits[0]; }
function product(architecture) { return architecture === 'hosted' ? 'Azure Red Hat OpenShift Compute Optimized HCP' : 'Azure Red Hat OpenShift General Purpose'; }
async function aro({ currency, workerNodes, vcpusPerNode, commitment = 'payg', architecture = 'standard', hours = HOURS }) {
  const rs = await rows(currency); const prod = product(architecture); const sku = `${vcpusPerNode} vCPU`; const lines = [];
  if (commitment === 'payg') {
    const row = pick(rs, r => r.productName === prod && r.skuName === sku && r.type === 'Consumption', `${prod} ${sku} PAYG`);
    lines.push(line(`${architecture} OpenShift license: ${workerNodes} nodes * ${hours} hours * ${row.retailPrice}`, workerNodes * hours / unitSize(row.unitOfMeasure) * row.retailPrice, { meterId: row.meterId }));
  } else {
    const term = commitment === 'ri1y' ? '1 Year' : '3 Years'; const months = commitment === 'ri1y' ? 12 : 36;
    const row = pick(rs, r => r.productName === prod && r.skuName === sku && r.type === 'Reservation' && r.reservationTerm === term, `${prod} ${sku} ${term}`);
    lines.push(line(`${architecture} OpenShift ${term} reservation amortized: ${workerNodes} nodes * ${row.retailPrice}/${months}`, workerNodes * row.retailPrice / months, { meterId: row.meterId, wholeTermPrice: row.retailPrice }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = { type: 'openshift', source: 'retail-api', cases: [
  { name: 'standard payg minimum workers', region: 'eastus2', currency: 'USD', component: { type: 'openshift', workerNodes: 3, vcpusPerNode: 4, commitment: 'payg', architecture: 'standard' },
    // Retail API regionless Azure Red Hat OpenShift General Purpose 4 vCPU consumption meter is per node-hour; 3 workers run 730 hours.
    expected: async () => aro({ currency: 'USD', workerNodes: 3, vcpusPerNode: 4, commitment: 'payg', architecture: 'standard' }) },
  { name: 'standard part-time payg', region: 'eastus2', currency: 'USD', component: { type: 'openshift', workerNodes: 4, vcpusPerNode: 4, commitment: 'payg', architecture: 'standard', hours: 100 },
    // Retail API 4 vCPU General Purpose consumption meter is hourly, so PAYG prorates by the supplied 100 hours.
    expected: async () => aro({ currency: 'USD', workerNodes: 4, vcpusPerNode: 4, commitment: 'payg', architecture: 'standard', hours: 100 }) },
  { name: 'one year reserved license', region: 'eastus2', currency: 'USD', component: { type: 'openshift', workerNodes: 3, vcpusPerNode: 4, commitment: 'ri1y', architecture: 'standard' },
    // Retail API Reservation price for 4 vCPU General Purpose is the whole 1-year amount per node; monthly oracle amortizes over 12 months.
    expected: async () => aro({ currency: 'USD', workerNodes: 3, vcpusPerNode: 4, commitment: 'ri1y', architecture: 'standard' }) },
  { name: 'three year reserved license', region: 'eastus2', currency: 'USD', component: { type: 'openshift', workerNodes: 5, vcpusPerNode: 4, commitment: 'ri3y', architecture: 'standard' },
    // Retail API Reservation price for 4 vCPU General Purpose is the whole 3-year amount per node; monthly oracle amortizes over 36 months.
    expected: async () => aro({ currency: 'USD', workerNodes: 5, vcpusPerNode: 4, commitment: 'ri3y', architecture: 'standard' }) },
  { name: 'hosted control plane payg', region: 'eastus2', currency: 'USD', component: { type: 'openshift', workerNodes: 3, vcpusPerNode: 4, commitment: 'payg', architecture: 'hosted' },
    // Retail API hosted-control-plane (HCP) OpenShift rows are separate Global consumption meters; no reservation rows are published for this architecture.
    expected: async () => aro({ currency: 'USD', workerNodes: 3, vcpusPerNode: 4, commitment: 'payg', architecture: 'hosted' }) },
  { name: 'west europe uses regionless license rows', region: 'westeurope', currency: 'USD', component: { type: 'openshift', workerNodes: 3, vcpusPerNode: 4, commitment: 'payg', architecture: 'standard' },
    // OpenShift license meters in Retail API are regionless (blank/Global), so West Europe uses the same published license price as East US 2.
    expected: async () => aro({ currency: 'USD', workerNodes: 3, vcpusPerNode: 4, commitment: 'payg', architecture: 'standard' }) },
  { name: 'EUR standard payg', region: 'westeurope', currency: 'EUR', component: { type: 'openshift', workerNodes: 3, vcpusPerNode: 8, commitment: 'payg', architecture: 'standard' },
    // Retail API queried in EUR returns the regionless 8 vCPU General Purpose consumption meter in EUR.
    expected: async () => aro({ currency: 'EUR', workerNodes: 3, vcpusPerNode: 8, commitment: 'payg', architecture: 'standard' }) },
] };
