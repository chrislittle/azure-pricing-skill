'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'microsoft-fabric';
const HOURS_PER_MONTH = 730;
const TERM = { ri1y: { unit: 'peroneyearreserved', months: 12 }, ri3y: { unit: 'perthreeyearsreserved', months: 36 } };
const cache = new Map();

async function product() {
  if (cache.has(SLUG)) return cache.get(SLUG);
  let last;
  for (const v of ['v2', 'v3']) {
    try {
      const res = await fetch(`https://azure.microsoft.com/api/${v}/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
      if (!res.ok) { last = new Error(`calculator ${v} HTTP ${res.status}`); continue; }
      const j = await res.json(); cache.set(SLUG, j); return j;
    } catch (e) { last = e; }
  }
  throw last;
}
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function price(data, offer, region, unit) {
  const r = calc.calcRegion(data, region);
  const table = data.offers[offer] && data.offers[offer].prices && data.offers[offer].prices[unit];
  if (!table) throw new Error(`Fabric calculator missing ${offer}/${unit}`);
  const p = table[r] || table.global;
  if (!p) throw new Error(`Fabric calculator missing ${offer}/${unit}/${r}`);
  return p.value;
}
async function fabricCalc({ region, capacityUnits = 0, hours = HOURS_PER_MONTH, commitment = 'payg', oneLakeGB = 0, oneLakeCoolGB = 0, oneLakeColdGB = 0, oneLakeCacheGB = 0, oneLakeBcdrGB = 0, oneLakeBcdrCoolGB = 0, oneLakeBcdrColdGB = 0, sqlDatabaseGB = 0, sqlStorageGB = 0, sqlBackupGB = 0 }) {
  const data = await product();
  const lines = [];
  if (capacityUnits) {
    if (commitment === 'payg') {
      const p = price(data, 'available-capacity-usage', region, 'perhour');
      lines.push(line(`Fabric capacity PAYG: ${capacityUnits} CU * ${hours} hours * ${p}`, capacityUnits * hours * p, { sourceOffer: 'available-capacity-usage' }));
    } else {
      const t = TERM[commitment];
      const p = price(data, 'fabric-capacity-reservation', region, t.unit);
      lines.push(line(`Fabric capacity ${commitment}: ${capacityUnits} CU * whole-term ${p} / ${t.months} months`, capacityUnits * p / t.months, { sourceOffer: 'fabric-capacity-reservation', sourceUnit: t.unit }));
    }
  }
  for (const [gb, offer, label] of [
    [oneLakeGB, 'onelake-hot-storage', 'OneLake hot'],
    [oneLakeCoolGB, 'onelake-cool-storage', 'OneLake cool'],
    [oneLakeColdGB, 'onelake-cold-storage', 'OneLake cold'],
    [oneLakeCacheGB, 'onelake-cache', 'OneLake cache'],
    [oneLakeBcdrGB, 'onelake-bcdr-hot-storage', 'OneLake BCDR hot'],
    [oneLakeBcdrCoolGB, 'onelake-bcdr-cool-storage', 'OneLake BCDR cool'],
    [oneLakeBcdrColdGB, 'onelake-bcdr-cold-storage', 'OneLake BCDR cold'],
    [sqlDatabaseGB || sqlStorageGB, 'onelake-sql-storage', 'SQL database storage'],
    [sqlBackupGB, 'onelake-sql-backup-storage', 'SQL backup storage'],
  ]) if (gb) {
    const p = price(data, offer, region, 'pergbpermonth');
    lines.push(line(`${label}: ${gb} GB-month * ${p}`, gb * p, { sourceOffer: offer }));
  }
  return { monthlyList: totalOf(lines), lines };
}
async function retailRows(region, currency) { return dedupe(await query(`serviceName eq 'Microsoft Fabric' and armRegionName eq '${region}'`, currency)); }
function one(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one Fabric Retail API row for ${what}, found ${hits.length}`); return hits[0]; }
function baseCapacityMeter(rows) {
  const hits = rows.filter(r => r.productName === 'Fabric Capacity' && r.type === 'Consumption' && / Capacity Usage CU$/.test(r.meterName) && !/OD|On-Demand|Overage/.test(`${r.skuName} ${r.meterName}`));
  if (!hits.length) throw new Error('missing Fabric base capacity CU meters');
  const min = Math.min(...hits.map(r => r.retailPrice));
  return hits.filter(r => r.retailPrice === min).sort((a, b) => a.meterName.localeCompare(b.meterName))[0];
}
async function fabricRetail({ region, currency = 'EUR', capacityUnits = 0, hours = HOURS_PER_MONTH, commitment = 'payg', oneLakeGB = 0, oneLakeCoolGB = 0, oneLakeColdGB = 0, oneLakeCacheGB = 0, oneLakeBcdrGB = 0, oneLakeBcdrCoolGB = 0, oneLakeBcdrColdGB = 0, sqlDatabaseGB = 0, sqlStorageGB = 0, sqlBackupGB = 0, sparkAutoscaleCuHours = 0, overageCuHours = 0, kqlCacheCuHours = 0 }) {
  const rows = await retailRows(region, currency);
  const lines = [];
  if (capacityUnits) {
    if (commitment === 'payg') {
      const m = baseCapacityMeter(rows);
      lines.push(line(`${currency} Fabric base capacity: ${capacityUnits} CU * ${hours} hours * ${m.retailPrice}`, capacityUnits * hours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId, meterName: m.meterName }));
    } else {
      const term = commitment === 'ri1y' ? '1 Year' : '3 Years';
      const months = commitment === 'ri1y' ? 12 : 36;
      const m = one(rows, r => r.productName === 'Fabric Capacity Reservation' && r.meterName === 'Fabric Capacity CU' && r.type === 'Reservation' && r.reservationTerm === term, `${term} reservation`);
      lines.push(line(`${currency} Fabric ${term}: ${capacityUnits} CU * whole-term ${m.retailPrice} / ${months}`, capacityUnits * m.retailPrice / months, { meterId: m.meterId }));
    }
  }
  for (const [gb, sku, meter, label] of [
    [oneLakeGB, 'OneLake Storage Hot', 'OneLake Storage Hot Data Stored', 'hot'],
    [oneLakeCoolGB, 'OneLake Storage Cool', 'OneLake Storage Cool Data Stored', 'cool'],
    [oneLakeColdGB, 'OneLake Storage Cold', 'OneLake Storage Cold Data Stored', 'cold'],
    [oneLakeCacheGB, 'OneLake Cache', 'OneLake Cache Data Stored', 'cache'],
    [oneLakeBcdrGB, 'OneLake BCDR Storage Hot', 'OneLake BCDR Storage Hot Data Stored', 'BCDR hot'],
    [oneLakeBcdrCoolGB, 'Onelake BCDR Storage Cool', 'Onelake BCDR Storage Cool Data Stored', 'BCDR cool'],
    [oneLakeBcdrColdGB, 'Onelake BCDR Storage Cold', 'Onelake BCDR Storage Cold Data Stored', 'BCDR cold'],
    [sqlDatabaseGB || sqlStorageGB, 'SQL Storage', 'SQL Storage Data Stored', 'SQL database storage'],
    [sqlBackupGB, 'SQL Backup Storage', 'SQL Backup Storage Data Stored', 'SQL backup'],
  ]) if (gb) {
    const m = one(rows, r => r.productName === 'OneLake' && r.skuName === sku && r.meterName === meter && r.type === 'Consumption', label);
    lines.push(line(`${currency} OneLake ${label}: ${gb} GB-month * ${m.retailPrice}`, gb / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (sparkAutoscaleCuHours) {
    const m = one(rows, r => r.productName === 'Fabric Capacity' && r.meterName === 'autoscale for Spark Capacity Usage CU' && r.type === 'Consumption', 'Spark autoscale CU-hours');
    lines.push(line(`${currency} Spark autoscale: ${sparkAutoscaleCuHours} CU-hours * ${m.retailPrice}`, sparkAutoscaleCuHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (overageCuHours) {
    const m = one(rows, r => r.productName === 'Fabric Capacity' && r.meterName === 'Capacity Overage Capacity Usage CU' && r.type === 'Consumption', 'capacity overage CU-hours');
    lines.push(line(`${currency} Capacity overage: ${overageCuHours} CU-hours * ${m.retailPrice}`, overageCuHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  if (kqlCacheCuHours) {
    const m = one(rows, r => r.productName === 'Fabric Capacity' && r.meterName === 'Eventhouse Capacity Usage CU' && r.type === 'Consumption', 'Eventhouse/KQL cache CU-hours');
    lines.push(line(`${currency} Eventhouse/KQL cache: ${kqlCacheCuHours} CU-hours * ${m.retailPrice}`, kqlCacheCuHours / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}
async function oracle(opts) {
  if (opts.currency && opts.currency !== 'USD') return fabricRetail(opts);
  const c = await fabricCalc(opts);
  if (!opts.sparkAutoscaleCuHours && !opts.overageCuHours && !opts.kqlCacheCuHours) return c;
  const r = await fabricRetail({ ...opts, currency: 'USD', capacityUnits: 0, oneLakeGB: 0, oneLakeCoolGB: 0, oneLakeColdGB: 0, oneLakeCacheGB: 0, oneLakeBcdrGB: 0, oneLakeBcdrCoolGB: 0, oneLakeBcdrColdGB: 0, sqlDatabaseGB: 0, sqlStorageGB: 0, sqlBackupGB: 0 });
  const lines = [...c.lines, ...r.lines];
  return { monthlyList: totalOf(lines), lines };
}
function capacityCase(cu) {
  return { name: `F${cu} payg one hour`, region: 'eastus2', currency: 'USD', component: { type: 'fabric', capacityUnits: cu, hours: 1 },
    // Calculator v3 available-capacity-usage is a per-CU-hour PAYG price; multiply by the F SKU's CU count for one hour.
    expected: async () => oracle({ region: 'eastus2', capacityUnits: cu, hours: 1 }) };
}

module.exports = {
  type: 'fabric',
  source: 'both',
  cases: [
    ...[2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096].map(capacityCase),
    { name: 'F64 payg with all OneLake storage types', region: 'eastus2', currency: 'USD', component: { type: 'fabric', capacityUnits: 64, hours: 730, oneLakeGB: 1000, oneLakeCoolGB: 500, oneLakeColdGB: 250, oneLakeCacheGB: 50, oneLakeBcdrGB: 100 },
      // Calculator v3 PAYG CU-hours plus hot, cool, cold, cache, and BCDR hot GB-month offers.
      expected: async () => oracle({ region: 'eastus2', capacityUnits: 64, hours: 730, oneLakeGB: 1000, oneLakeCoolGB: 500, oneLakeColdGB: 250, oneLakeCacheGB: 50, oneLakeBcdrGB: 100 }) },
    { name: 'F32 one year reservation', region: 'eastus2', currency: 'USD', component: { type: 'fabric', capacityUnits: 32, commitment: 'ri1y' },
      // Calculator v3 fabric-capacity-reservation peroneyearreserved is whole-term per CU; divide by 12 months.
      expected: async () => oracle({ region: 'eastus2', capacityUnits: 32, commitment: 'ri1y' }) },
    { name: 'F128 three year reservation west europe', region: 'westeurope', currency: 'USD', component: { type: 'fabric', capacityUnits: 128, commitment: 'ri3y' },
      // Calculator v3 fabric-capacity-reservation perthreeyearsreserved is whole-term per CU; divide by 36 months.
      expected: async () => oracle({ region: 'westeurope', capacityUnits: 128, commitment: 'ri3y' }) },
    { name: 'spark autoscale CU-hours retail', region: 'eastus2', currency: 'USD', component: { type: 'fabric', capacityUnits: 2, hours: 0, sparkAutoscaleCuHours: 100 },
      // Retail API autoscale for Spark Capacity Usage CU is the named Spark autoscale meter; billed per CU-hour.
      expected: async () => oracle({ region: 'eastus2', capacityUnits: 2, hours: 0, sparkAutoscaleCuHours: 100 }) },
    { name: 'bcdr sql kql and overage dimensions', region: 'eastus2', currency: 'USD', component: { type: 'fabric', capacityUnits: 2, hours: 0, oneLakeBcdrCoolGB: 10, oneLakeBcdrColdGB: 20, sqlDatabaseGB: 30, sqlBackupGB: 40, oneLakeCacheGB: 50, overageCuHours: 60 },
      // Calculator v3 covers BCDR cool/cold, SQL database/backup storage, and KQL cache GB-months; Retail API Capacity Overage CU is 3x PAYG in East US 2.
      expected: async () => oracle({ region: 'eastus2', capacityUnits: 2, hours: 0, oneLakeBcdrCoolGB: 10, oneLakeBcdrColdGB: 20, sqlDatabaseGB: 30, sqlBackupGB: 40, oneLakeCacheGB: 50, overageCuHours: 60 }) },
    { name: 'australia central retail fallback', region: 'australiacentral', currency: 'USD', component: { type: 'fabric', capacityUnits: 8, hours: 10 },
      // Calculator lists Australia Central but omits capacity prices there; Retail API has Fabric Capacity Usage CU rows at the regional rate.
      expected: async () => fabricRetail({ region: 'australiacentral', currency: 'USD', capacityUnits: 8, hours: 10 }) },
    { name: 'eur F8 payg and storage', region: 'westeurope', currency: 'EUR', component: { type: 'fabric', capacityUnits: 8, hours: 100, oneLakeGB: 100, oneLakeCoolGB: 100, oneLakeColdGB: 100, oneLakeCacheGB: 10, oneLakeBcdrGB: 20 },
      // EUR Retail API native currency rows: choose the lowest published non-OD/non-overage Fabric Capacity Usage CU meter independently, plus OneLake GB-month meters.
      expected: async () => oracle({ region: 'westeurope', currency: 'EUR', capacityUnits: 8, hours: 100, oneLakeGB: 100, oneLakeCoolGB: 100, oneLakeColdGB: 100, oneLakeCacheGB: 10, oneLakeBcdrGB: 20 }) },
    { name: 'eur F16 one year reservation', region: 'westeurope', currency: 'EUR', component: { type: 'fabric', capacityUnits: 16, commitment: 'ri1y' },
      // EUR Retail API Fabric Capacity Reservation row is a whole-term per-CU 1-year commitment; divide by 12 months.
      expected: async () => oracle({ region: 'westeurope', currency: 'EUR', capacityUnits: 16, commitment: 'ri1y' }) },
  ],
};
