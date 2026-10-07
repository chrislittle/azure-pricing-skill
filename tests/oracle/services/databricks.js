'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const HOURS_PER_MONTH = 730;
const CALC_SLUG = 'databricks';
const calcCache = new Map();
const TERM = { ri1y: { label: '1 Year', months: 12 }, ri3y: { label: '3 Years', months: 36 } };
const DBCU_NAMES = new Map([[12500, '12,500 DBCUs'], [25000, '25,000 DBCUs'], [37500, '37,500 DBCUs'], [50000, '50,000 DBCUs'], [75000, '75,000 DBCUs'], [100000, '100,000 DBCUs'], [150000, '150,000 DBCUs'], [200000, '200,000 DBCUs'], [300000, '300,000 DBCUs'], [350000, '350,000 DBCUs'], [500000, '500,000 DBCUs'], [600000, '600,000 DBCUs'], [750000, '750,000 DBCUs'], [1000000, '1 Million DBCUs'], [1050000, '1.05 Million DBCUs'], [1500000, '1.5 Million DBCUs'], [2000000, '2 Million DBCUs'], [2250000, '2.25 Million DBCUs'], [3000000, '3 Million DBCUs'], [4500000, '4.5 Million DBCUs'], [6000000, '6 Million DBCUs']]);
const DBCU_UNITS = new Map([...DBCU_NAMES].map(([k, v]) => [v, k]));
const MISSION_PROMO_END = Date.UTC(2027, 5, 30, 23, 59, 59);
function cap(tier) { return tier === 'standard' ? 'Standard' : 'Premium'; }
const WORKLOAD_METER = {
  'all-purpose': tier => `${cap(tier)} All-purpose Compute DBU`,
  jobs: tier => `${cap(tier)} Jobs Compute DBU`,
  'jobs-light': tier => `${cap(tier)} Jobs Light Compute DBU`,
  'sql-classic': tier => `${cap(tier)} SQL Analytics DBU`,
  'dlt-core': tier => `${cap(tier)} Core Compute Delta Live Tables DBU`,
  'dlt-pro': tier => `${cap(tier)} Pro Compute Delta Live Tables DBU`,
  'dlt-advanced': tier => `${cap(tier)} Advanced Compute Delta Live Tables DBU`,
  'sql-pro': () => 'Premium SQL Compute Pro DBU',
  'sql-serverless': () => 'Premium Serverless SQL DBU',
  'serverless-jobs': () => 'Premium Automated Serverless Compute DBU',
  'serverless-interactive': () => 'Premium Interactive Serverless Compute DBU',
  'serverless-database': () => 'Premium Database Serverless Compute DBU',
  'model-training': () => 'Premium Model Training DBU',
  'model-serving': () => 'Premium Serverless Realtime Inferencing DBU',
  'serverless-gpu-block': () => 'Premium Serverless GPU Compute Capacity Block DBU',
};
async function product() {
  if (calcCache.has(CALC_SLUG)) return calcCache.get(CALC_SLUG);
  const res = await fetch(`https://azure.microsoft.com/api/v3/pricing/${CALC_SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Databricks calculator HTTP ${res.status}`);
  const data = await res.json(); calcCache.set(CALC_SLUG, data); return data;
}
async function calcPrice(offer, region, unit) {
  const data = await product(); const r = calc.calcRegion(data, region);
  const p = data.offers[offer] && data.offers[offer].prices && data.offers[offer].prices[unit] && (data.offers[offer].prices[unit][r] || data.offers[offer].prices[unit].global);
  if (!p) throw new Error(`Databricks calculator missing ${offer}/${unit}/${r}`);
  return p.value;
}
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function one(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one Databricks Retail API row for ${what}, found ${hits.length}`); return hits[0]; }
async function rows(region, currency) { return dedupe(await query(`serviceName eq 'Azure Databricks' and armRegionName eq '${region}'`, currency)); }
async function allRows(currency) { return dedupe(await query(`serviceName eq 'Azure Databricks'`, currency)); }
async function reservationRows(currency) { return dedupe(await query(`serviceName eq 'Azure Databricks' and priceType eq 'Reservation'`, currency)); }
async function workloadMeter(region, currency, workload, tier, photon) {
  const meterName = photon && ['all-purpose', 'jobs'].includes(workload) ? `${cap(tier)} ${workload === 'jobs' ? 'Jobs Compute' : 'All-Purpose'} Photon DBU` : WORKLOAD_METER[workload](tier);
  let hits = (await rows(region, currency)).filter(r => r.meterName === meterName && r.type === 'Consumption' && r.retailPrice > 0);
  if (!hits.length) hits = (await allRows(currency)).filter(r => r.armRegionName === 'Global' && r.meterName === meterName && r.type === 'Consumption' && r.retailPrice > 0);
  if (hits.length !== 1) throw new Error(`expected one Databricks Retail API row for ${meterName}, found ${hits.length}`);
  return hits[0];
}
function planCandidates(rr, term) {
  return rr.filter(r => r.armRegionName === 'Global' && r.reservationTerm === term.label && DBCU_UNITS.has(r.skuName))
    .map(r => ({ row: r, units: DBCU_UNITS.get(r.skuName), monthly: r.retailPrice / term.months }))
    .sort((a, b) => a.units - b.units);
}
function overageMonthly({ monthlyLocal, monthlyUsd, annualUsd, units }) {
  const overageUsdUnits = Math.max(0, annualUsd - units);
  if (!overageUsdUnits) return 0;
  const localPerUsdList = monthlyUsd ? monthlyLocal / monthlyUsd : 1;
  return (overageUsdUnits / 12) * localPerUsdList;
}
async function pickPlan({ currency, commitment, units, monthlyLocal, monthlyUsd }) {
  const t = TERM[commitment]; const rr = await reservationRows(currency); const candidates = planCandidates(rr, t); const annualUsd = monthlyUsd * 12;
  if (units) { const hit = candidates.find(c => c.units === units); if (!hit) throw new Error(`missing ${currency} Databricks prepurchase plan ${units} ${t.label}`); return { ...hit, overage: overageMonthly({ monthlyLocal, monthlyUsd, annualUsd, units }) }; }
  const ranked = candidates.map(c => ({ ...c, overage: overageMonthly({ monthlyLocal, monthlyUsd, annualUsd, units: c.units }) })).map(c => ({ ...c, total: c.monthly + c.overage })).sort((a, b) => a.total - b.total || a.units - b.units);
  if (!ranked.length) throw new Error(`missing ${currency} Databricks prepurchase plans for ${t.label}`);
  return ranked[0];
}
async function databricks({ region, currency = 'USD', workload = 'jobs', tier = 'premium', photon = false, dbusPerHour, hours = HOURS_PER_MONTH, securityAddOn = 'none', commitment = 'payg', dbcuUnits = 0, drReplicationGB = 0, cleanRoomCollaborators = 0, lakebaseDsu = 0 }) {
  const rs = await rows(region, currency); const lines = []; const usageDbuHours = dbusPerHour * hours;
  let meterName, meter, usdMeter, usageList, usageListUsd;
  if (workload === 'anthropic-serving') {
    meterName = 'Anthropic Serverless Inference DBU'; const p = await calcPrice('sql-anthropic-model-serving', region, 'perhour'); usageList = usageDbuHours * p; usageListUsd = usageList;
  } else {
    meter = await workloadMeter(region, currency, workload, tier, photon); usdMeter = currency === 'USD' ? meter : await workloadMeter(region, 'USD', workload, tier, photon); meterName = meter.meterName;
    usageList = usageDbuHours / unitSize(meter.unitOfMeasure) * meter.retailPrice; usageListUsd = usageDbuHours / unitSize(usdMeter.unitOfMeasure) * usdMeter.retailPrice;
  }
  if (commitment === 'payg') lines.push(line(`${currency} ${meterName}: ${dbusPerHour} DBU/hour * ${hours} hours`, usageList, meter ? { meterId: meter.meterId } : { sourceOffer: 'sql-anthropic-model-serving' }));
  else { const t = TERM[commitment]; const plan = await pickPlan({ currency, commitment, units: dbcuUnits, monthlyLocal: usageList, monthlyUsd: usageListUsd }); lines.push(line(`${currency} Databricks prepurchase ${DBCU_NAMES.get(plan.units)} ${t.label}: whole-term ${plan.row.retailPrice} / ${t.months}`, plan.monthly, { meterId: plan.row.meterId })); if (plan.overage) lines.push(line(`${currency} DBU overage: annual USD list ${round2(usageListUsd * 12)} - ${plan.units} DBCUs, converted to monthly ${currency} list`, plan.overage)); }
  if (securityAddOn !== 'none') { const pct = securityAddOn === 'enhanced' ? 0.10 : (Date.now() <= MISSION_PROMO_END ? 0.15 : 0.30); lines.push(line(`${currency} ${securityAddOn} security add-on: ${round2(pct * 100)}% of workload list ${usageList}`, usageList * pct)); }
  if (drReplicationGB) { const m = one(rs, r => r.meterName === 'Data Processed' && r.skuName === 'Premium Disaster Recovery Replication' && r.type === 'Consumption', 'DR replication'); lines.push(line(`${currency} DR replication: ${drReplicationGB} GB * ${m.retailPrice}`, drReplicationGB / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId })); }
  if (cleanRoomCollaborators) { const m = one(rs, r => r.meterName === 'Premium Clean Rooms Collaborator Collaborator' && r.type === 'Consumption', 'Clean Rooms collaborator'); lines.push(line(`${currency} Clean Rooms: ${cleanRoomCollaborators} collaborators * 30.4167 days * ${m.retailPrice}`, cleanRoomCollaborators * (HOURS_PER_MONTH / 24) / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId })); }
  if (lakebaseDsu) { const m = one(rs, r => r.meterName === 'Premium Databricks Storage Unit DSU' && r.type === 'Consumption', 'Lakebase DSU'); lines.push(line(`${currency} Lakebase storage: ${lakebaseDsu} DSU * ${m.retailPrice}`, lakebaseDsu / unitSize(m.unitOfMeasure) * m.retailPrice, { meterId: m.meterId })); }
  return { monthlyList: totalOf(lines), lines };
}
async function databricksPool({ region, currency = 'USD', commitment = 'ri1y', dbcuUnits = 0, workloads }) {
  let monthlyLocal = 0, monthlyUsd = 0; const detail = [];
  for (const w of workloads) { const meter = await workloadMeter(region, currency, w.workload, 'premium', !!w.photon); const usdMeter = currency === 'USD' ? meter : await workloadMeter(region, 'USD', w.workload, 'premium', !!w.photon); const dbuHours = w.dbusPerHour * (w.hours || HOURS_PER_MONTH); const local = dbuHours / unitSize(meter.unitOfMeasure) * meter.retailPrice; const usd = dbuHours / unitSize(usdMeter.unitOfMeasure) * usdMeter.retailPrice; monthlyLocal += local; monthlyUsd += usd; detail.push(`${w.workload}: ${round2(local)} ${currency} list (${round2(usd)} USD list)`); }
  const t = TERM[commitment]; const plan = await pickPlan({ currency, commitment, units: dbcuUnits, monthlyLocal, monthlyUsd });
  const lines = [line(`${currency} shared Databricks prepurchase ${DBCU_NAMES.get(plan.units)} ${t.label}: one pool across ${workloads.length} workloads; ${detail.join('; ')}`, plan.monthly, { meterId: plan.row.meterId })];
  if (plan.overage) lines.push(line(`${currency} shared DBU overage: annual USD list ${round2(monthlyUsd * 12)} - ${plan.units} DBCUs`, plan.overage));
  return { monthlyList: totalOf(lines), lines };
}
function wlCase(workload, extra = {}) {
  return { name: `${workload} workload`, region: extra.region || 'eastus2', currency: extra.currency || 'USD', component: { type: 'databricks', workload, tier: extra.tier || 'premium', photon: !!extra.photon, dbusPerHour: extra.dbusPerHour || 10, hours: extra.hours || 10 }, expected: async () => databricks({ region: extra.region || 'eastus2', currency: extra.currency || 'USD', workload, tier: extra.tier || 'premium', photon: !!extra.photon, dbusPerHour: extra.dbusPerHour || 10, hours: extra.hours || 10 }) };
}
module.exports = { type: 'databricks', source: 'retail-api', cases: [
  wlCase('all-purpose'), wlCase('all-purpose', { photon: true }), wlCase('jobs'), wlCase('jobs', { photon: true }), wlCase('jobs-light'), wlCase('sql-classic'), wlCase('dlt-core'), wlCase('dlt-pro'), wlCase('dlt-advanced'), wlCase('sql-pro'), wlCase('sql-serverless'), wlCase('serverless-jobs'), wlCase('serverless-interactive'), wlCase('serverless-database'), wlCase('model-training'), wlCase('model-serving'),
  { name: 'serverless gpu capacity block workload', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'serverless-gpu-block', tier: 'premium', dbusPerHour: 10, hours: 10 }, expected: async () => databricks({ region: 'eastus2', workload: 'serverless-gpu-block', tier: 'premium', dbusPerHour: 10, hours: 10 }) },
  { name: 'anthropic serverless inference workload', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'anthropic-serving', tier: 'premium', dbusPerHour: 100, hours: 100 }, expected: async () => databricks({ region: 'eastus2', workload: 'anthropic-serving', tier: 'premium', dbusPerHour: 100, hours: 100 }) },
  { name: 'westeurope serverless sql in usd', region: 'westeurope', currency: 'USD', component: { type: 'databricks', workload: 'sql-serverless', tier: 'premium', dbusPerHour: 12, hours: 200 }, expected: async () => databricks({ region: 'westeurope', workload: 'sql-serverless', tier: 'premium', dbusPerHour: 12, hours: 200 }) },
  { name: 'tiny workload should stay payg instead of dbcu', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 1, hours: 10, commitment: 'ri1y', dbcuUnits: 0 }, expectEngineError: /pay-as-you-go|too small|minimum/i },
  { name: 'nested workloads reject tier', region: 'eastus2', currency: 'USD', component: { type: 'databricks', commitment: 'ri1y', dbcuUnits: 12500, workloads: [{ workload: 'jobs', tier: 'premium', dbusPerHour: 10, hours: 10 }] }, expectEngineError: /tier|unknown field/i },
  { name: 'standard tier refused', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'jobs', tier: 'standard', dbusPerHour: 10, hours: 10 }, expectEngineError: /standard/i },
  { name: 'lakebase dsu storage', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 1, hours: 1, lakebaseDsu: 1000 }, expected: async () => databricks({ region: 'eastus2', workload: 'jobs', tier: 'premium', dbusPerHour: 1, hours: 1, lakebaseDsu: 1000 }) },
  { name: 'premium jobs enhanced security percent add-on', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 25, hours: 40, securityAddOn: 'enhanced' }, expected: async () => databricks({ region: 'eastus2', workload: 'jobs', tier: 'premium', dbusPerHour: 25, hours: 40, securityAddOn: 'enhanced' }) },
  { name: 'mission critical security clean rooms and DR', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'all-purpose', tier: 'premium', dbusPerHour: 5, hours: 100, securityAddOn: 'mission-critical', cleanRoomCollaborators: 2, drReplicationGB: 500 }, expected: async () => databricks({ region: 'eastus2', workload: 'all-purpose', tier: 'premium', dbusPerHour: 5, hours: 100, securityAddOn: 'mission-critical', cleanRoomCollaborators: 2, drReplicationGB: 500 }) },
  { name: 'one year 12500 DBCU prepurchase', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 10, hours: 100, commitment: 'ri1y', dbcuUnits: 12500 }, expected: async () => databricks({ region: 'eastus2', workload: 'jobs', tier: 'premium', dbusPerHour: 10, hours: 100, commitment: 'ri1y', dbcuUnits: 12500 }) },
  { name: 'three year 37500 DBCU prepurchase', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 10, hours: 100, commitment: 'ri3y', dbcuUnits: 37500 }, expected: async () => databricks({ region: 'eastus2', workload: 'jobs', tier: 'premium', dbusPerHour: 10, hours: 100, commitment: 'ri3y', dbcuUnits: 37500 }) },
  { name: 'one year prepurchase with annual overage', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 1000, hours: 730, commitment: 'ri1y', dbcuUnits: 12500 }, expected: async () => databricks({ region: 'eastus2', workload: 'jobs', tier: 'premium', dbusPerHour: 1000, hours: 730, commitment: 'ri1y', dbcuUnits: 12500 }) },
  { name: 'cheapest one year prepurchase auto plan', region: 'eastus2', currency: 'USD', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 2500, hours: 10, commitment: 'ri1y', dbcuUnits: 0 }, expected: async () => databricks({ region: 'eastus2', workload: 'jobs', tier: 'premium', dbusPerHour: 2500, hours: 10, commitment: 'ri1y', dbcuUnits: 0 }) },
  { name: 'one DBCU pool across jobs and all-purpose workloads', region: 'eastus2', currency: 'USD', component: { type: 'databricks', commitment: 'ri1y', dbcuUnits: 12500, workloads: [{ workload: 'jobs', dbusPerHour: 100, hours: 100 }, { workload: 'all-purpose', dbusPerHour: 50, hours: 100 }] }, expected: async () => databricksPool({ region: 'eastus2', workloads: [{ workload: 'jobs', dbusPerHour: 100, hours: 100 }, { workload: 'all-purpose', dbusPerHour: 50, hours: 100 }], commitment: 'ri1y', dbcuUnits: 12500 }) },
  { name: 'eur west europe jobs', region: 'westeurope', currency: 'EUR', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 12, hours: 25 }, expected: async () => databricks({ region: 'westeurope', currency: 'EUR', workload: 'jobs', tier: 'premium', dbusPerHour: 12, hours: 25 }) },
  { name: 'eur dbcu uses usd list units', region: 'westeurope', currency: 'EUR', component: { type: 'databricks', workload: 'jobs', tier: 'premium', dbusPerHour: 12, hours: 25, commitment: 'ri1y', dbcuUnits: 12500 }, expected: async () => databricks({ region: 'westeurope', currency: 'EUR', workload: 'jobs', tier: 'premium', dbusPerHour: 12, hours: 25, commitment: 'ri1y', dbcuUnits: 12500 }) },
] };
