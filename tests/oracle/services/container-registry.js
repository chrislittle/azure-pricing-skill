'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'container-registry';
const DAYS = 730 / 24;
const INCLUDED_GB = { basic: 10, standard: 100, premium: 500 };

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function offer(offerName, region) { return (await calc.offerPrice(SLUG, offerName, region)).value; }
async function rows(region, currency) { return dedupe(await query(`serviceName eq 'Container Registry' and armRegionName eq '${region}'`, currency)); }
function pick(rows, pred, what) { const hits = rows.filter(pred); if (hits.length !== 1) throw new Error(`expected one ACR row for ${what}, found ${hits.length}`); return hits[0]; }
function graduated(rows, qty, desc) {
  const tiers = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  const lines = [];
  for (let i = 0; i < tiers.length; i++) {
    const start = tiers[i].tierMinimumUnits;
    const end = i + 1 < tiers.length ? tiers[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    const units = Math.min(qty, end) - start;
    lines.push(line(`${desc}: ${units} seconds from ${start} to ${end === Infinity ? 'infinity' : end} * ${tiers[i].retailPrice}`, units * tiers[i].retailPrice, { meterId: tiers[i].meterId }));
  }
  return lines;
}
async function acrCalc({ region, tier, registries = 1, days = DAYS, storageGb = 0, geoReplicas = 0, replicaRegions = [], connectedRegistries = 0, buildVcpuMinutes = 0 }) {
  const lines = [];
  const base = await offer(tier, region);
  lines.push(line(`${tier} registry units: ${registries} * ${days} days * ${base}`, registries * days * base, { sourceOffer: tier }));
  const overGb = Math.max(0, storageGb - INCLUDED_GB[tier]);
  if (overGb) { const p = await offer('storage', region); lines.push(line(`${tier} storage over included ${INCLUDED_GB[tier]} GB: ${registries} * ${overGb} GB-month * ${p}`, registries * overGb * p, { sourceOffer: 'storage' })); }
  if (tier === 'premium' && geoReplicas) {
    for (let i = 0; i < geoReplicas; i++) {
      const rr = replicaRegions[i] || region;
      const rep = await offer('premium', rr); const st = await offer('storage', rr);
      lines.push(line(`premium geo-replication unit in ${rr}: ${registries} * ${days} days * ${rep}`, registries * days * rep, { sourceOffer: 'premium' }));
      if (overGb) lines.push(line(`premium geo-replication storage in ${rr}: ${registries} * ${overGb} excess GB-month * ${st}`, registries * overGb * st, { sourceOffer: 'storage' }));
    }
  }
  if (tier === 'premium' && connectedRegistries) { const p = await offer('connected-registry-premium', region); lines.push(line(`connected registries: ${connectedRegistries} * ${days} days * ${p}`, connectedRegistries * days * p, { sourceOffer: 'connected-registry-premium' })); }
  const buildSeconds = buildVcpuMinutes * 60;
  if (buildSeconds) {
    const data = await calc.product(SLUG); const cr = calc.calcRegion(data, region); const bands = data.graduatedOffers.build[cr].prices;
    let remaining = buildSeconds; let start = 0;
    for (const b of bands) { const end = b.limit; const units = Math.max(0, Math.min(remaining, end - start)); if (units) lines.push(line(`ACR Tasks build: ${units} vCPU-seconds at ${b.price.value}`, units * b.price.value, { sourceOffer: 'build' })); remaining -= units; start = end; if (remaining <= 0) break; }
  }
  return { monthlyList: totalOf(lines), lines };
}
async function acrRetail({ region, currency, tier, registries = 1, days = DAYS, storageGb = 0, geoReplicas = 0, replicaRegions = [], connectedRegistries = 0, buildVcpuMinutes = 0 }) {
  const rs = await rows(region, currency); const sku = tier[0].toUpperCase() + tier.slice(1); const lines = [];
  const base = pick(rs, r => r.skuName === sku && r.meterName === `${sku} Registry Unit`, `${sku} Registry Unit`);
  lines.push(line(`${sku} Registry Unit: ${registries} * ${days} days * ${base.retailPrice}`, registries * days / unitSize(base.unitOfMeasure) * base.retailPrice, { meterId: base.meterId }));
  const overGb = Math.max(0, storageGb - INCLUDED_GB[tier]);
  if (overGb) { const st = pick(rs, r => r.skuName === sku && r.meterName === 'Data Stored', `${sku} Data Stored`); lines.push(line(`${sku} data over included ${INCLUDED_GB[tier]} GB: ${registries} * ${overGb} * ${st.retailPrice}`, registries * overGb * st.retailPrice, { meterId: st.meterId })); }
  if (tier === 'premium' && geoReplicas) {
    for (let i = 0; i < geoReplicas; i++) {
      const rr = replicaRegions[i] || region;
      const rrs = rr === region ? rs : await rows(rr, currency);
      const rep = pick(rrs, r => r.meterName === 'Premium Registry Replication Unit', `Premium Registry Replication Unit ${rr}`);
      const st = pick(rrs, r => r.meterName === 'Premium GB Registry Replication Data Stored', `Premium replication storage ${rr}`);
      lines.push(line(`Premium Registry Replication Unit in ${rr}: ${registries} * ${days} days * ${rep.retailPrice}`, registries * days * rep.retailPrice, { meterId: rep.meterId }));
      if (overGb) lines.push(line(`Premium replication data stored in ${rr}: ${registries} * ${overGb} excess GB * ${st.retailPrice}`, registries * overGb * st.retailPrice, { meterId: st.meterId }));
    }
  }
  if (tier === 'premium' && connectedRegistries) { const cr = pick(rs, r => r.meterName === 'Premium Connected registry', 'Premium Connected registry'); lines.push(line(`Premium Connected registry: ${connectedRegistries} * ${days} days * ${cr.retailPrice}`, connectedRegistries * days * cr.retailPrice, { meterId: cr.meterId })); }
  if (buildVcpuMinutes) lines.push(...graduated(rs.filter(r => r.skuName === sku && r.meterName === 'Task vCPU Duration'), buildVcpuMinutes * 60, `${sku} Task vCPU Duration`));
  return { monthlyList: totalOf(lines), lines };
}

module.exports = { type: 'container-registry', source: 'both', cases: [
  { name: 'basic included storage boundary', region: 'eastus2', currency: 'USD', component: { type: 'container-registry', tier: 'basic', registries: 1, storageGb: 10 },
    // Calculator Basic Registry Unit is per day; Basic includes 10 GB so no Data Stored line at the boundary.
    expected: async () => acrCalc({ region: 'eastus2', tier: 'basic', storageGb: 10 }) },
  { name: 'standard storage just above included', region: 'eastus2', currency: 'USD', component: { type: 'container-registry', tier: 'standard', registries: 2, storageGb: 101 },
    // Calculator Standard Registry Unit per day plus Data Stored for only 1 GB above the 100 GB included band.
    expected: async () => acrCalc({ region: 'eastus2', tier: 'standard', registries: 2, storageGb: 101 }) },
  { name: 'premium geo replicas and connected registries', region: 'eastus2', currency: 'USD', component: { type: 'container-registry', tier: 'premium', storageGb: 600, geoReplicas: 2, connectedRegistries: 3 },
    // Calculator Premium Registry Unit applies to primary and each geo-replica; replica storage is charged per replicated GB-month; connected registries are per day.
    expected: async () => acrCalc({ region: 'eastus2', tier: 'premium', storageGb: 600, geoReplicas: 2, connectedRegistries: 3 }) },
  { name: 'build free band at 100 vCPU-minutes', region: 'eastus2', currency: 'USD', component: { type: 'container-registry', tier: 'standard', storageGb: 100, buildVcpuMinutes: 100 },
    // Calculator graduated build offer has first 6,000 vCPU-seconds (100 minutes) at $0, then $0.0001/second.
    expected: async () => acrCalc({ region: 'eastus2', tier: 'standard', storageGb: 100, buildVcpuMinutes: 100 }) },
  { name: 'build just above free band', region: 'eastus2', currency: 'USD', component: { type: 'container-registry', tier: 'standard', storageGb: 100, buildVcpuMinutes: 101 },
    // Calculator graduated build offer charges only the 60 seconds above the 6,000-second free band.
    expected: async () => acrCalc({ region: 'eastus2', tier: 'standard', storageGb: 100, buildVcpuMinutes: 101 }) },
  { name: 'premium replica in another region', region: 'eastus2', currency: 'USD', component: { type: 'container-registry', tier: 'premium', storageGb: 620, geoReplicas: 2, replicaRegions: ['westeurope'] },
    // Calculator prices the first listed replica from West Europe and the second unspecified replica at the registry region; storage over 500 GB is charged per replica.
    expected: async () => acrCalc({ region: 'eastus2', tier: 'premium', storageGb: 620, geoReplicas: 2, replicaRegions: ['westeurope'] }) },
  { name: 'west europe premium same calculator rates', region: 'westeurope', currency: 'USD', component: { type: 'container-registry', tier: 'premium', storageGb: 550, geoReplicas: 1 },
    // Calculator West Europe currently exposes the same Premium, storage, and replication offer values as East US 2.
    expected: async () => acrCalc({ region: 'westeurope', tier: 'premium', storageGb: 550, geoReplicas: 1 }) },
  { name: 'EUR retail premium with all dimensions', region: 'eastus2', currency: 'EUR', component: { type: 'container-registry', tier: 'premium', storageGb: 510, geoReplicas: 1, connectedRegistries: 1, buildVcpuMinutes: 101 },
    // Retail API EUR rows price registry units, storage, replication, connected registry, and graduated Task vCPU Duration natively in EUR.
    expected: async () => acrRetail({ region: 'eastus2', currency: 'EUR', tier: 'premium', storageGb: 510, geoReplicas: 1, connectedRegistries: 1, buildVcpuMinutes: 101 }) },
  { name: 'EUR west europe premium with replica', region: 'westeurope', currency: 'EUR', component: { type: 'container-registry', tier: 'premium', storageGb: 540, geoReplicas: 1, buildVcpuMinutes: 101 },
    // Retail API queried live in EUR for West Europe prices the premium registry, 40 GB over included storage, one replica, and the 60 billable build seconds above the free band.
    expected: async () => acrRetail({ region: 'westeurope', currency: 'EUR', tier: 'premium', storageGb: 540, geoReplicas: 1, buildVcpuMinutes: 101 }) },
] };
