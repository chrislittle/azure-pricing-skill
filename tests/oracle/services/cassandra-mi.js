'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const HOURS = 730;
const SLUG = 'managed-instance-apache-cassandra';
const cache = new Map();

async function product() {
  if (cache.has(SLUG)) return cache.get(SLUG);
  for (const v of ['v2', 'v3']) {
    const res = await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
    if (res.ok) { const j = await res.json(); cache.set(SLUG, j); return j; }
  }
  throw new Error(`calculator has no price data for ${SLUG}`);
}
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function offerName(nodeSize) { return String(nodeSize).toLowerCase().replace(/^standard_/, '').replace(/_/g, ''); }
function requireMinNodes(nodesPerDatacenter) { if (nodesPerDatacenter < 3) throw new Error('Cassandra MI requires at least 3 nodes per datacenter'); }
function pickOne(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one ${what}, found ${hits.length}`); return hits[0]; }
async function calcRate(offer, region, key) {
  const data = await product();
  const o = data.offers[offer];
  if (!o) throw new Error(`calculator ${SLUG}: no offer ${offer}`);
  const r = calc.calcRegion(data, region);
  const p = o.prices?.[key]?.[r] || o.prices?.[key]?.global;
  if (!p) throw new Error(`calculator ${SLUG}/${offer}: no ${key} price for ${r}`);
  return p.value;
}
async function cass({ region, nodeSize, nodesPerDatacenter, datacenters = 1, disksPerNode = 4, backupCopies = 2, backupGbPerCopy = 0, hours = HOURS }) {
  requireMinNodes(nodesPerDatacenter);
  const nodes = nodesPerDatacenter * datacenters;
  const compute = await calcRate(offerName(nodeSize), region, 'perhour');
  const disk = await calcRate('storage', region, 'permonth');
  const backup = await calcRate('backup', region, 'permonth');
  const extraCopies = Math.max(0, backupCopies - 2);
  const lines = [
    line(`${nodeSize}: ${nodes} node(s) * ${hours} h * ${compute}`, nodes * hours * compute),
    line(`P30 data disks: ${nodes} node(s) * ${disksPerNode} disk(s) * ${disk}`, nodes * disksPerNode * disk),
  ];
  if (extraCopies && backupGbPerCopy) lines.push(line(`Backup copies over two included: ${extraCopies} * ${backupGbPerCopy} GB * ${backup}`, extraCopies * backupGbPerCopy * backup));
  return { monthlyList: total(lines), lines };
}
function normMeterName(s) {
  return String(s || '').replace(/\bvcore\b/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}
async function plainLinuxVmPaygRate({ region, currency = 'USD', nodeSize }) {
  const rows = dedupe(await query(`serviceName eq 'Virtual Machines' and armRegionName eq '${region}'`, currency, { maxPages: 120 }));
  const plainName = nodeSize.replace(/^Standard_/, '').replace(/_/g, ' ');
  return pickOne(rows, r => r.type === 'Consumption'
    && r.armSkuName === nodeSize
    && r.skuName === plainName
    && r.meterName === plainName
    && r.unitOfMeasure === '1 Hour'
    && !/Windows/i.test(r.productName), `${nodeSize} plain Linux VM PAYG meter`);
}
async function policyRetailComputeRate({ region, currency = 'USD', nodeSize }) {
  const vm = await plainLinuxVmPaygRate({ region, currency, nodeSize });
  const rows = dedupe(await query(`armRegionName eq '${region}' and contains(productName, 'Cassandra')`, currency));
  const standard = normMeterName(nodeSize);
  const legacy = normMeterName(nodeSize.replace(/^Standard_/, ''));
  const candidates = rows.filter(r => r.type === 'Consumption'
    && r.productName === 'Azure Managed Instance for Apache Cassandra - Compute'
    && r.unitOfMeasure === '1 Hour'
    && [r.skuName, r.armSkuName, r.meterName].some(x => {
      const n = normMeterName(x);
      return n === standard || n === legacy || n.endsWith(standard);
    }));
  const floor = Math.max(0.05, vm.retailPrice * 0.5);
  let kept = candidates.filter(r => r.retailPrice >= floor);
  if (!kept.length) throw new Error(`no Cassandra ${nodeSize} meters left after floor ${floor}`);
  const suffix = nodeSize.replace(/^Standard_/, '');
  const standardNamed = kept.filter(r => new RegExp(`(^|_)Standard_${suffix}$`, 'i').test(r.skuName));
  if (standardNamed.length) kept = standardNamed;
  kept.sort((a, b) => (b.retailPrice - a.retailPrice) || String(b.effectiveStartDate || '').localeCompare(String(a.effectiveStartDate || '')) || String(b.meterId || '').localeCompare(String(a.meterId || '')));
  return { meter: kept[0], vm, floor };
}
async function cassPolicyRetailCompute({ region, nodeSize, nodesPerDatacenter, datacenters = 1, disksPerNode = 4, backupCopies = 2, backupGbPerCopy = 0, hours = HOURS }) {
  requireMinNodes(nodesPerDatacenter);
  const nodes = nodesPerDatacenter * datacenters;
  const { meter: compute, vm, floor } = await policyRetailComputeRate({ region, nodeSize });
  const disk = await calcRate('storage', region, 'permonth');
  const backup = await calcRate('backup', region, 'permonth');
  const extraCopies = Math.max(0, backupCopies - 2);
  const lines = [
    line(`${nodeSize} policy Retail meter ${compute.skuName}/${compute.meterName}: ${nodes} node(s) * ${hours} h * ${compute.retailPrice} (VM ${vm.retailPrice}, floor ${round2(floor)})`, nodes * hours * compute.retailPrice, { meterId: compute.meterId }),
    line(`P30 data disks: ${nodes} node(s) * ${disksPerNode} disk(s) * ${disk}`, nodes * disksPerNode * disk),
  ];
  if (extraCopies && backupGbPerCopy) lines.push(line(`Backup copies over two included: ${extraCopies} * ${backupGbPerCopy} GB * ${backup}`, extraCopies * backupGbPerCopy * backup));
  return { monthlyList: total(lines), lines };
}
async function cassRetail({ region, currency = 'EUR', nodeSize, nodesPerDatacenter, datacenters = 1, disksPerNode = 4, backupCopies = 2, backupGbPerCopy = 0, hours = HOURS }) {
  requireMinNodes(nodesPerDatacenter);
  const rows = dedupe(await query(`armRegionName eq '${region}' and contains(productName, 'Cassandra')`, currency));
  const label = nodeSize.replace(/^Standard_/, 'Standard_');
  const compute = pickOne(rows, r => r.type === 'Consumption' && r.productName === 'Azure Managed Instance for Apache Cassandra - Compute' && r.skuName === `Apache_Cassandra_${label}` && r.meterName === `${label} vCore` && r.unitOfMeasure === '1 Hour', `${label} compute meter`);
  const disk = pickOne(rows, r => r.type === 'Consumption' && r.productName === 'Azure Managed Instance for Apache Cassandra - Compute' && r.skuName === 'P30' && r.meterName === 'P30 Disk' && r.unitOfMeasure === '1/Month', 'P30 Disk meter');
  const backup = pickOne(rows, r => r.type === 'Consumption' && r.productName === 'Azure Managed Instance for Apache Cassandra - Compute' && r.skuName === 'Backup' && r.meterName === 'Backup Data Stored' && r.unitOfMeasure === '1 GB/Month', 'Backup Data Stored meter');
  const nodes = nodesPerDatacenter * datacenters;
  const extraCopies = Math.max(0, backupCopies - 2);
  const lines = [
    line(`Retail ${compute.meterName}: ${nodes} * ${hours} h * ${compute.retailPrice}`, nodes * hours / unitSize(compute.unitOfMeasure) * compute.retailPrice, { meterId: compute.meterId }),
    line(`Retail P30 disks: ${nodes} * ${disksPerNode} * ${disk.retailPrice}`, nodes * disksPerNode / unitSize(disk.unitOfMeasure) * disk.retailPrice, { meterId: disk.meterId }),
  ];
  if (extraCopies && backupGbPerCopy) lines.push(line(`Retail backup over two included copies: ${extraCopies} * ${backupGbPerCopy} GB * ${backup.retailPrice}`, extraCopies * backupGbPerCopy / unitSize(backup.unitOfMeasure) * backup.retailPrice, { meterId: backup.meterId }));
  return { monthlyList: total(lines), lines };
}

module.exports = { type: 'cassandra-mi', source: 'both', cases: [
  { name: 'three e8s v5 nodes four p30 disks two included backups', region: 'eastus2', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, backupCopies: 2, backupGbPerCopy: 500 },
    // Calculator v3 e8sv5 compute is hourly per node; storage is monthly per 1-TB P30 disk; first two backup copies are included. The P30 Disk Mount meter is shared-disk attach pricing, not Cassandra MI data-disk pricing, so it is excluded.
    expected: async () => cass({ region: 'eastus2', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, backupCopies: 2, backupGbPerCopy: 500 }) },
  { name: 'backup just above free copies', region: 'eastus2', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, backupCopies: 3, backupGbPerCopy: 500 },
    // Two backup copies are free; the third copy bills 500 GB at the calculator backup GB-month rate.
    expected: async () => cass({ region: 'eastus2', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, backupCopies: 3, backupGbPerCopy: 500 }) },
  { name: 'two datacenters multiply node and disk counts', region: 'eastus2', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_D8s_v5', nodesPerDatacenter: 3, datacenters: 2, disksPerNode: 2 },
    // Minimum three nodes are required in each datacenter; each datacenter has its own full node and disk set.
    expected: async () => cass({ region: 'eastus2', nodeSize: 'Standard_D8s_v5', nodesPerDatacenter: 3, datacenters: 2, disksPerNode: 2 }) },
  { name: 'part-time compute keeps disks monthly', region: 'eastus2', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, hours: 100 },
    // Compute uses the requested 100 hours; P30 disks remain monthly charges.
    expected: async () => cass({ region: 'eastus2', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, hours: 100 }) },
  { name: 'v4 e8 meter policy chooses Standard naming over cheaper legacy', region: 'eastus2', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_E8_v4', nodesPerDatacenter: 3, disksPerNode: 1 },
    // Multi-meter policy: drop meters below 50% of the plain Linux VM or below $0.05/h, prefer skuName Standard_<size>, then highest price. Calculator still lags at the older E8_v4 0.504/hr offer.
    expected: async () => cassPolicyRetailCompute({ region: 'eastus2', nodeSize: 'Standard_E8_v4', nodesPerDatacenter: 3, disksPerNode: 1 }) },
  { name: 'brazil southeast e2s v5 ignores placeholder penny meter', region: 'brazilsoutheast', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_E2s_v5', nodesPerDatacenter: 3, disksPerNode: 1 },
    // Retail API includes a Standard E2s V5 placeholder at $0.01/h; policy drops it because it is below $0.05/h and below 50% of the Linux VM rate, then keeps the Standard_E2s_v5-named meter.
    expected: async () => cassPolicyRetailCompute({ region: 'brazilsoutheast', nodeSize: 'Standard_E2s_v5', nodesPerDatacenter: 3, disksPerNode: 1 }) },
  { name: 'israel central d8s v4 drops subfloor Standard meter', region: 'israelcentral', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_D8s_v4', nodesPerDatacenter: 3, disksPerNode: 1 },
    // Standard_D8s_v4 is only $0.04/h in Israel Central, below the $0.05 absolute floor and below 50% of Linux VM PAYG; policy therefore chooses the remaining D8s_v4 meter.
    expected: async () => cassPolicyRetailCompute({ region: 'israelcentral', nodeSize: 'Standard_D8s_v4', nodesPerDatacenter: 3, disksPerNode: 1 }) },
  { name: 'australia east d8s v4 date tie prefers Standard naming', region: 'australiaeast', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_D8s_v4', nodesPerDatacenter: 3, disksPerNode: 1 },
    // Australia East D8s_v4 and Standard_D8s_v4 share the same effectiveStartDate; policy ignores date and prefers Standard_<size> naming after floor filtering.
    expected: async () => cassPolicyRetailCompute({ region: 'australiaeast', nodeSize: 'Standard_D8s_v4', nodesPerDatacenter: 3, disksPerNode: 1 }) },
  { name: 'us gov texas e8 v4 drops placeholder Standard meter', region: 'usgovtexas', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_E8_v4', nodesPerDatacenter: 3, disksPerNode: 1 },
    // US Gov Texas has a newer Standard_E8_v4 placeholder at $0.01/h; policy drops it and chooses the billable E8_v4 meter that survives the Linux VM floor.
    expected: async () => cassPolicyRetailCompute({ region: 'usgovtexas', nodeSize: 'Standard_E8_v4', nodesPerDatacenter: 3, disksPerNode: 1 }) },
  { name: 'west europe e8s v5 regional prices', region: 'westeurope', currency: 'USD', component: { type: 'cassandra-mi', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, backupCopies: 3, backupGbPerCopy: 100 },
    // Calculator v3 West Europe has distinct compute, P30 disk, and backup rates.
    expected: async () => cass({ region: 'westeurope', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, backupCopies: 3, backupGbPerCopy: 100 }) },
  { name: 'eur retail e8s v5 with extra backup', region: 'westeurope', currency: 'EUR', component: { type: 'cassandra-mi', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, backupCopies: 3, backupGbPerCopy: 100 },
    // EUR case uses exact Retail API meters: Apache_Cassandra_Standard_E8s_v5 compute, P30 Disk monthly storage, and Backup Data Stored beyond two included copies.
    expected: async () => cassRetail({ region: 'westeurope', currency: 'EUR', nodeSize: 'Standard_E8s_v5', nodesPerDatacenter: 3, disksPerNode: 4, backupCopies: 3, backupGbPerCopy: 100 }) },
] };
