'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const HOURS_PER_MONTH = 730;
const DEFAULTS = {
  spark: { vcpu: 4, memory: 16, family: 'memory' },
  hadoop: { vcpu: 16, memory: 56, family: 'general' },
  'interactive-query': { vcpu: 8, memory: 56, family: 'memory' },
  hbase: { vcpu: 4, memory: 14, family: 'general' },
  kafka: { vcpu: 4, memory: 14, family: 'general' },
};
const SIZE_CATALOG = [
  { name: 'D4a v4', label: 'D4a v4/D4as v4', vcpu: 4, memory: 16 },
  { name: 'E4ads v5', label: 'E4ads v5', vcpu: 4, memory: 32 },
  { name: 'D8a v4', label: 'D8a v4/D8as v4', vcpu: 8, memory: 32 },
  { name: 'E8ads v5', label: 'E8ads v5', vcpu: 8, memory: 64 },
  { name: 'D16a v4', label: 'D16a v4/D16as v4', vcpu: 16, memory: 64 },
  { name: 'E16ads v5', label: 'E16ads v5', vcpu: 16, memory: 128 },
  { name: 'D32a v4', label: 'D32a v4/D32as v4', vcpu: 32, memory: 128 },
  { name: 'D3 v2', label: 'Dv23', vcpu: 4, memory: 14, extended: true },
  { name: 'D12 v2', label: 'Dv212', vcpu: 4, memory: 28, extended: true },
  { name: 'D13 v2', label: 'Dv213', vcpu: 8, memory: 56, extended: true },
  { name: 'D5 v2', label: 'Dv25', vcpu: 16, memory: 56, extended: true },
];
const CALC_SLUG = 'hdinsight';
const calcCache = new Map();
const ZOOKEEPER = { name: 'A4 v2', label: 'A4 v2', vcpu: 4, memory: 8 };
const ID_BROKER = { name: 'A2 v2', label: 'A2 v2', vcpu: 2, memory: 4 };

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function freeZookeeper(clusterType) { return clusterType === 'spark' || clusterType === 'hadoop'; }
async function retailRows(region, currency) { return dedupe(await query(`serviceName eq 'HDInsight' and armRegionName eq '${region}'`, currency)); }
function one(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one HDInsight Retail API row for ${what}, found ${hits.length}`); return hits[0]; }
function defaults(clusterType) { return DEFAULTS[clusterType] || DEFAULTS.spark; }
function pickNode(clusterType, vcpu, memory) {
  const d = defaults(clusterType);
  const needVcpu = vcpu || d.vcpu;
  const needMemory = memory || d.memory;
  const candidates = SIZE_CATALOG.filter(s => s.vcpu >= needVcpu && s.memory >= needMemory && !s.extended);
  if (!candidates.length) throw new Error(`no HDInsight current node for ${needVcpu} vCPU/${needMemory} GiB`);
  return candidates[0];
}
async function product() {
  if (calcCache.has(CALC_SLUG)) return calcCache.get(CALC_SLUG);
  const res = await fetch(`https://azure.microsoft.com/api/v2/pricing/${CALC_SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HDInsight calculator HTTP ${res.status}`);
  const data = await res.json();
  calcCache.set(CALC_SLUG, data);
  return data;
}
async function premiumPrice(region) {
  const data = await product();
  const r = calc.calcRegion(data, region);
  const p = data.offers['premium-addon'] && data.offers['premium-addon'].prices && data.offers['premium-addon'].prices[r];
  if (!p) throw new Error(`HDInsight calculator missing premium-addon/${r}`);
  return p.value;
}

function diskMeter(diskTier) {
  if (diskTier === 'premium-zrs') return 'P30 - ZRS Disk';
  if (diskTier === 'premium') return 'P30 Disk';
  return 'S30 Disk';
}
async function hdinsightRetail({ region, currency = 'USD', clusterType = 'spark', workerNodes, workerVcpu, workerMemoryGiB, headVcpu, headMemoryGiB, edgeNodes = 0, edgeVcpu = 4, edgeMemoryGiB = 16, hours = HOURS_PER_MONTH, managedDisks = 0, diskTier = 'standard', diskOperations = 0, enterpriseSecurity = false, idBroker = false }) {
  const rs = await retailRows(region, currency);
  const worker = pickNode(clusterType, workerVcpu, workerMemoryGiB);
  const head = pickNode(clusterType, headVcpu, headMemoryGiB);
  const edge = edgeNodes ? pickNode(clusterType, edgeVcpu, edgeMemoryGiB) : null;
  const lines = [];
  let espCores = 0;
  for (const [role, count, size] of [['worker', workerNodes, worker], ['head', 2, head], ['edge', edgeNodes, edge]]) if (count && size) {
    const m = one(rs, r => r.productName !== 'HDInsight ID Broker' && (r.skuName === size.label || r.meterName === size.label || r.meterName.includes(size.label)) && r.type === 'Consumption', `${role} ${size.name}`);
    espCores += count * size.vcpu;
    lines.push(line(`${currency} ${clusterType} ${role}: ${count} * ${size.name} (${size.vcpu} vCPU/${size.memory} GiB) * ${hours} hours * ${m.retailPrice}`, count * hours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (freeZookeeper(clusterType)) {
    lines.push(line(`${currency} ${clusterType} ZooKeeper nodes are included/free`, 0));
  } else {
    const m = one(rs, r => r.productName !== 'HDInsight ID Broker' && (r.skuName === ZOOKEEPER.label || r.meterName === ZOOKEEPER.label) && r.type === 'Consumption', 'ZooKeeper A4 v2');
    lines.push(line(`${currency} ${clusterType} ZooKeeper: 3 * ${ZOOKEEPER.name} * ${hours} hours * ${m.retailPrice}`, 3 * hours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (managedDisks) {
    const meter = diskMeter(diskTier);
    const m = one(rs, r => r.productName === 'HDInsight Storage' && r.meterName === meter && r.type === 'Consumption', meter);
    lines.push(line(`${currency} ${meter}: ${managedDisks} disks * ${m.retailPrice}`, managedDisks / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (diskTier === 'standard' && diskOperations) {
    const m = one(rs, r => r.productName === 'HDInsight Storage' && r.skuName === 'S30' && r.meterName === 'Operations' && r.type === 'Consumption', 'S30 Operations');
    lines.push(line(`${currency} standard disk operations: ${diskOperations}K operations * ${m.retailPrice} per 10K`, (diskOperations * 1000) / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (enterpriseSecurity) {
    if (freeZookeeper(clusterType)) espCores += 3 * 2;
    const p = await premiumPrice(region);
    lines.push(line(`${currency} Enterprise Security Package: ${espCores} cores * ${hours} hours * ${p}`, espCores * hours * p, { sourceOffer: 'premium-addon' }));
  }
  if (idBroker) {
    const m = one(rs, r => r.productName === 'HDInsight ID Broker' && r.skuName === ID_BROKER.label && r.type === 'Consumption', 'ID Broker A2 v2');
    lines.push(line(`${currency} ID Broker: 2 * ${ID_BROKER.name} * ${hours} hours * ${m.retailPrice}`, 2 * hours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}
function clusterCase(clusterType) {
  const extra = clusterType === 'kafka' ? { managedDisks: 8 } : {};
  return { name: `${clusterType} current minimum cluster`, region: 'eastus2', currency: 'USD', component: { type: 'hdinsight', clusterType, workerNodes: 4, hours: 10, ...extra },
    // Node sizes are selected from current VM families by Microsoft minimum vCPU/memory; Spark/Hadoop ZooKeeper is included, Kafka/HBase/IQ bill three A4 v2 ZooKeeper nodes.
    expected: async () => hdinsightRetail({ region: 'eastus2', clusterType, workerNodes: 4, hours: 10, ...extra }) };
}

module.exports = {
  type: 'hdinsight',
  source: 'retail-api',
  cases: [
    clusterCase('hadoop'), clusterCase('spark'), clusterCase('interactive-query'), clusterCase('hbase'), clusterCase('kafka'),
    { name: 'spark default calculator shape has free zookeeper', region: 'eastus2', currency: 'USD', component: { type: 'hdinsight', clusterType: 'spark', workerNodes: 4, workerVcpu: 4, workerMemoryGiB: 16, headVcpu: 4, headMemoryGiB: 16, hours: 730 },
      // Spark/Hadoop ZooKeeper is free; the documented default example is 4 workers + 2 heads, with no ZooKeeper charge.
      expected: async () => hdinsightRetail({ region: 'eastus2', clusterType: 'spark', workerNodes: 4, workerVcpu: 4, workerMemoryGiB: 16, headVcpu: 4, headMemoryGiB: 16, hours: 730 }) },
    { name: 'spark custom memory selects next current size and edge node', region: 'eastus2', currency: 'USD', component: { type: 'hdinsight', clusterType: 'spark', workerNodes: 2, workerVcpu: 8, workerMemoryGiB: 56, headVcpu: 4, headMemoryGiB: 16, edgeNodes: 1, edgeVcpu: 4, edgeMemoryGiB: 16, hours: 25 },
      // vCPU/memory selection rounds workers to E8ads v5 while 4 vCPU / 16 GiB head and edge nodes use current D4a v4.
      expected: async () => hdinsightRetail({ region: 'eastus2', clusterType: 'spark', workerNodes: 2, workerVcpu: 8, workerMemoryGiB: 56, headVcpu: 4, headMemoryGiB: 16, edgeNodes: 1, edgeVcpu: 4, edgeMemoryGiB: 16, hours: 25 }) },
    { name: 'kafka standard disks and operations', region: 'eastus2', currency: 'USD', component: { type: 'hdinsight', clusterType: 'kafka', workerNodes: 3, managedDisks: 24, diskTier: 'standard', diskOperations: 1000, hours: 100 },
      // Kafka bills workers/heads, three A4 v2 ZooKeeper nodes, required S30 disks, and standard-disk operations per 10K operations.
      expected: async () => hdinsightRetail({ region: 'eastus2', clusterType: 'kafka', workerNodes: 3, managedDisks: 24, diskTier: 'standard', diskOperations: 1000, hours: 100 }) },
    { name: 'hbase premium disks', region: 'eastus2', currency: 'USD', component: { type: 'hdinsight', clusterType: 'hbase', workerNodes: 2, managedDisks: 8, diskTier: 'premium', hours: 100 },
      // HBase accelerated writes can use P30 disks; ZooKeeper nodes are billable for HBase.
      expected: async () => hdinsightRetail({ region: 'eastus2', clusterType: 'hbase', workerNodes: 2, managedDisks: 8, diskTier: 'premium', hours: 100 }) },
    { name: 'kafka premium zrs disks', region: 'eastus2', currency: 'USD', component: { type: 'hdinsight', clusterType: 'kafka', workerNodes: 1, managedDisks: 2, diskTier: 'premium-zrs', hours: 10 },
      // Premium ZRS uses the distinct P30 - ZRS Disk meter from Retail API rather than the regional calculator's non-ZRS P30 row.
      expected: async () => hdinsightRetail({ region: 'eastus2', clusterType: 'kafka', workerNodes: 1, managedDisks: 2, diskTier: 'premium-zrs', hours: 10 }) },
    { name: 'enterprise security and id broker', region: 'eastus2', currency: 'USD', component: { type: 'hdinsight', clusterType: 'spark', workerNodes: 4, enterpriseSecurity: true, idBroker: true, hours: 100 },
      // ESP is a per-core-hour add-on over cluster nodes, including hidden Spark/Hadoop ZooKeeper cores; ID Broker adds two A2 v2 broker nodes.
      expected: async () => hdinsightRetail({ region: 'eastus2', clusterType: 'spark', workerNodes: 4, enterpriseSecurity: true, idBroker: true, hours: 100 }) },
    { name: 'eur west europe spark cluster', region: 'westeurope', currency: 'EUR', component: { type: 'hdinsight', clusterType: 'spark', workerNodes: 2, managedDisks: 4, diskTier: 'standard', diskOperations: 10, hours: 20 },
      // EUR Retail API prices current selected node-size rows, S30 disk row, and S30 Operations row in native currency.
      expected: async () => hdinsightRetail({ region: 'westeurope', currency: 'EUR', clusterType: 'spark', workerNodes: 2, managedDisks: 4, diskTier: 'standard', diskOperations: 10, hours: 20 }) },
  ],
};
