'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
const HOURS = 730;
const SLUG = 'netapp';
const CALC_REGION = { eastus2: 'us-east-2', westeurope: 'europe-west', usgovvirginia: 'usgov-virginia' };
const REGION_LABEL = { eastus2: 'US East 2', centralus: 'US Central', westeurope: 'EU West', usgovvirginia: 'US Gov VA', usgovarizona: 'US Gov AZ', usgovtexas: 'US Gov TX' };
const SCHEDULE_OFFER = { '10min': 'crr-minutes', hourly: 'crr-hourly', daily: 'crr-daily' };
const SERVICE_OFFER = {
  standard: { single: 'azure-netapp-files-standard-capacity', double: 'azure-netapp-files-standard-double-encrypted-capacity' },
  premium: { single: 'azure-netapp-files-premium-capacity', double: 'azure-netapp-files-premium-double-encrypted-capacity' },
  ultra: { single: 'azure-netapp-files-ultra-capacity', double: 'azure-netapp-files-ultra-double-encrypted-capacity' },
  elastic: { single: 'azure-netapp-files-elastic-zone-redundant-storage', double: 'azure-netapp-files-elastic-zone-redundant-storage' },
};
const calcCache = new Map();
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function calcProduct(slug) {
  if (calcCache.has(slug)) return calcCache.get(slug);
  let last;
  for (const v of ['v2', 'v3']) {
    const res = await fetch(`https://azure.microsoft.com/api/${v}/pricing/${slug}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
    if (res.ok) { const j = await res.json(); calcCache.set(slug, j); return j; }
    last = new Error(`calculator ${v} HTTP ${res.status}`);
  }
  throw last;
}
async function calcPrice(offer, region) {
  const d = await calcProduct(SLUG);
  const r = CALC_REGION[region];
  const p = d.offers[offer]?.prices?.[r] || d.offers[offer]?.prices?.global;
  if (!p) throw new Error(`no calculator offer ${offer} in ${region}`);
  return p.value;
}
async function retailRows(region, currency) {
  return dedupe(await query(`serviceName eq 'Azure NetApp Files' and armRegionName eq '${region}'`, currency));
}
async function retailPrice(region, currency, pred, what) {
  const row = (await retailRows(region, currency)).find(r => r.type === 'Consumption' && pred(r));
  if (!row) throw new Error(`no NetApp meter for ${what}`);
  return row;
}
async function offerOrRetail(o, offer, pred, what) {
  if ((o.currency || 'USD') === 'USD') return { value: await calcPrice(offer, o.region), sourceOffer: offer };
  const row = await retailPrice(o.region, o.currency, pred, what);
  return { value: row.retailPrice, meterId: row.meterId };
}
async function netapp(o) {
  const level = o.serviceLevel || 'standard';
  const hours = o.hours ?? HOURS;
  const gib = (o.capacityTiB || 0) * 1024;
  const lines = [];
  if (o.commitment === 'ri1y' || o.commitment === 'ri3y') {
    const term = o.commitment === 'ri1y' ? 'oneyear' : 'threeyear';
    const months = o.commitment === 'ri1y' ? 12 : 36;
    const pibBlocks = Math.floor((o.capacityTiB || 0) / 1024);
    const afterPib = (o.capacityTiB || 0) - pibBlocks * 1024;
    const hundredBlocks = Math.floor(afterPib / 100);
    const remainderTiB = afterPib - hundredBlocks * 100;
    if (pibBlocks) {
      const offer = `netapp-reserved-capacity-${level}-One-pibpermonth-${term}`;
      const whole = await calcPrice(offer, o.region);
      lines.push(line(`${level} ${pibBlocks} * 1 PiB reservation, whole term ${whole} / ${months} months`, (whole / months) * pibBlocks, { sourceOffer: offer, wholeTermPrice: whole, termMonths: months }));
    }
    if (hundredBlocks) {
      const offer = `netapp-reserved-capacity-${level}-Hundred-tibpermonth-${term}`;
      const whole = await calcPrice(offer, o.region);
      lines.push(line(`${level} ${hundredBlocks} * 100 TiB reservation, whole term ${whole} / ${months} months`, (whole / months) * hundredBlocks, { sourceOffer: offer, wholeTermPrice: whole, termMonths: months }));
    }
    if (remainderTiB) {
      const cap = await offerOrRetail(o, SERVICE_OFFER[level][o.encryption || 'single'],
        r => r.skuName === `${level[0].toUpperCase()}${level.slice(1)}${o.encryption === 'double' ? ' Double Encrypted' : ''}` && /Capacity$/.test(r.meterName), `${level} payg reservation remainder`);
      lines.push(line(`${level} reservation remainder ${remainderTiB} TiB * 1024 GiB/TiB * ${hours} h * ${cap.value}`, remainderTiB * 1024 * hours * cap.value, cap));
    }
  } else if (level === 'flexible') {
    const cap = await offerOrRetail(o, 'azure-netapp-files-flexible-service-level-capacity',
      r => r.skuName === 'Flexible Service Level' && r.meterName === 'Flexible Service Level Capacity', 'flexible capacity');
    const coolPct = (o.coolPercent || 0) / 100;
    const coolGib = gib * coolPct;
    const hotGib = gib - coolGib;
    if (hotGib) lines.push(line(`Flexible hot capacity ${hotGib} GiB * ${hours} h * ${cap.value}`, hotGib * hours * cap.value, cap));
    if (coolGib) {
      const cool = await offerOrRetail(o, 'azure-netapp-files-standard-data-at-rest-cool-tier',
        r => r.skuName === 'Standard Storage with Cool Access' && r.meterName === 'Standard Storage with Cool Access Capacity', 'cool capacity');
      lines.push(line(`Flexible cool-at-rest ${coolGib} GiB * ${hours} h * ${cool.value}`, coolGib * hours * cool.value, cool));
      const rw = await offerOrRetail(o, 'azure-netapp-files-standard-data-transfer-cool-tier',
        r => r.skuName === 'Standard Storage with Cool Access' && r.meterName === 'Standard Storage with Cool Access Data Transfer', 'cool transfer');
      const rwGib = coolGib * ((o.coolReadWritePercent ?? 20) / 100);
      lines.push(line(`Cool access read/write ${rwGib} GiB * ${rw.value}`, rwGib * rw.value, rw));
    }
    const free = (o.capacityPools || 1) * 128;
    const over = Math.max(0, (o.throughputMiBps || 128) - free);
    if (over) {
      const th = await offerOrRetail(o, 'azure-netapp-files-flexible-service-level-throughput',
        r => r.skuName === 'Flexible Service Level' && r.meterName === 'Flexible Service Level Throughput MiBps', 'flexible throughput');
      lines.push(line(`Flexible throughput overage (${o.throughputMiBps}-${free}) MiB/s * ${hours} h * ${th.value}`, over * hours * th.value, th));
    }
  } else {
    const coolPct = (level !== 'elastic' ? (o.coolPercent || 0) : 0) / 100;
    const coolGib = gib * coolPct;
    const hotGib = gib - coolGib;
    const cap = await offerOrRetail(o, SERVICE_OFFER[level][o.encryption || 'single'],
      r => r.skuName === `${level[0].toUpperCase()}${level.slice(1)}${o.encryption === 'double' ? ' Double Encrypted' : ''}` && /Capacity$/.test(r.meterName), `${level} capacity`);
    if (hotGib) lines.push(line(`${level} capacity ${hotGib} GiB * ${hours} h * ${cap.value}`, hotGib * hours * cap.value, cap));
    if (coolGib) {
      const cool = await offerOrRetail(o, 'azure-netapp-files-standard-data-at-rest-cool-tier',
        r => r.skuName === 'Standard Storage with Cool Access' && r.meterName === 'Standard Storage with Cool Access Capacity', 'cool capacity');
      lines.push(line(`Standard cool-at-rest ${coolGib} GiB * ${hours} h * ${cool.value}`, coolGib * hours * cool.value, cool));
      const rw = await offerOrRetail(o, 'azure-netapp-files-standard-data-transfer-cool-tier',
        r => r.skuName === 'Standard Storage with Cool Access' && r.meterName === 'Standard Storage with Cool Access Data Transfer', 'cool transfer');
      const rwGib = coolGib * ((o.coolReadWritePercent ?? 20) / 100);
      lines.push(line(`Cool access read/write ${rwGib} GiB * ${rw.value}`, rwGib * rw.value, rw));
    }
  }
  if (o.backupGiB) {
    const b = await offerOrRetail(o, 'backup', r => r.skuName === 'Backup' && r.meterName === 'Backup Capacity', 'backup');
    lines.push(line(`Backup ${o.backupGiB} GiB * ${b.value}`, o.backupGiB * b.value, b));
  }
  if (o.restoreGiB) {
    const r = await offerOrRetail(o, 'restore', x => x.skuName === 'Volume Restore' && x.meterName === 'Volume Restore Capacity', 'restore');
    lines.push(line(`Restore ${o.restoreGiB} GiB * ${r.value}`, o.restoreGiB * r.value, r));
  }
  if (o.replicationGiB) {
    const offer = SCHEDULE_OFFER[o.replicationSchedule || 'hourly'];
    const suffix = (o.replicationSchedule === '10min') ? 'Minutes' : (o.replicationSchedule === 'daily' ? 'Days' : 'Hours');
    const src = REGION_LABEL[o.region];
    const dst = REGION_LABEL[o.replicationDestination];
    const specificSku = src && dst ? `Cross Region Replication - ${src} to ${dst}` : null;
    let priced = null;
    if (specificSku) {
      try {
        const row = await retailPrice(o.region, o.currency || 'USD', r => r.skuName === specificSku && r.meterName.endsWith(`${suffix}`), 'paired-region cross-region replication');
        priced = { value: row.retailPrice, meterId: row.meterId };
      } catch (_) {}
    }
    if (!priced && o.replicationDestination) {
      priced = await offerOrRetail({ ...o, region: o.replicationDestination }, offer, r => r.skuName === 'Cross Region Replication' && r.meterName.endsWith(`${suffix}`), 'destination-region generic cross-region replication');
    }
    if (!priced) priced = await offerOrRetail(o, offer, r => r.skuName === 'Cross Region Replication' && r.meterName.endsWith(`${suffix}`), 'cross-region replication');
    lines.push(line(`Cross-region replication ${o.replicationGiB} GiB/mo ${o.replicationSchedule || 'hourly'} * ${priced.value}`, o.replicationGiB * priced.value, priced));
  }
  return { monthlyList: totalOf(lines), lines };
}
module.exports = { type: 'netapp-files', source: 'both', cases: [
  { name: 'standard service level full month', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 1, hours: 730 },
    // Calculator offer azure-netapp-files-standard-capacity is GiB-hour: 1 TiB * 1024 GiB/TiB * 730 h.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'standard', capacityTiB: 1, hours: 730 }) },
  { name: 'premium double encryption part month', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'premium', encryption: 'double', capacityTiB: 2, hours: 100 },
    // Premium double-encrypted capacity uses its calculator GiB-hour offer; hours are not assumed full-month.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'premium', encryption: 'double', capacityTiB: 2, hours: 100 }) },
  { name: 'standard cool access and transfer', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 4, coolPercent: 75, coolReadWritePercent: 20, hours: 730 },
    // Hot GiB use standard capacity, cool GiB use cool-at-rest GiB-hour, and 20% of cool GiB is billed as cool transfer.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'standard', capacityTiB: 4, coolPercent: 75, coolReadWritePercent: 20, hours: 730 }) },
  { name: 'flexible throughput above free allowance', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'flexible', capacityTiB: 4, capacityPools: 2, throughputMiBps: 400, hours: 730 },
    // Flexible includes 128 MiB/s per pool free; only throughput above 256 MiB/s is billed per MiB/s-hour.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'flexible', capacityTiB: 4, capacityPools: 2, throughputMiBps: 400, hours: 730 }) },
  { name: 'ultra reserved capacity whole term amortized', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'ultra', capacityTiB: 100, commitment: 'ri3y' },
    // Reservation calculator price is the whole 3-year term for a 100 TiB block; monthly oracle divides by 36.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'ultra', capacityTiB: 100, commitment: 'ri3y' }) },
  { name: 'premium one pib reservation plus payg remainder', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'premium', capacityTiB: 1050, commitment: 'ri1y', hours: 730 },
    // Reservation uses one 1 PiB whole-term block divided by 12 months; the 26 TiB remainder is billed PAYG by GiB-hour.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'premium', capacityTiB: 1050, commitment: 'ri1y', hours: 730 }) },
  { name: 'paired region replication eastus2 to centralus', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 1, replicationGiB: 100, replicationSchedule: 'hourly', replicationDestination: 'centralus', hours: 730 },
    // Paired-region CRR uses the specific Retail API/calculator row for US East 2 to US Central Hours, not the generic CRR Hours price.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'standard', capacityTiB: 1, replicationGiB: 100, replicationSchedule: 'hourly', replicationDestination: 'centralus', hours: 730 }) },
  { name: 'destination region generic replication fallback', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 1, replicationGiB: 100, replicationSchedule: 'hourly', replicationDestination: 'westeurope', hours: 730 },
    // If no source-to-destination specific CRR meter exists, use the destination region's generic hourly CRR price.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'standard', capacityTiB: 1, replicationGiB: 100, replicationSchedule: 'hourly', replicationDestination: 'westeurope', hours: 730 }) },
  { name: 'us gov virginia standard capacity', region: 'usgovvirginia', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 1, hours: 730 },
    // US Gov Virginia has its own calculator region slug and higher standard GiB-hour price.
    expected: () => netapp({ region: 'usgovvirginia', serviceLevel: 'standard', capacityTiB: 1, hours: 730 }) },
  { name: 'us gov paired replication virginia to arizona', region: 'usgovvirginia', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 1, replicationGiB: 100, replicationSchedule: 'daily', replicationDestination: 'usgovarizona', hours: 730 },
    // US Gov paired CRR uses the specific US Gov VA to US Gov AZ daily meter.
    expected: () => netapp({ region: 'usgovvirginia', serviceLevel: 'standard', capacityTiB: 1, replicationGiB: 100, replicationSchedule: 'daily', replicationDestination: 'usgovarizona', hours: 730 }) },
  { name: 'premium cool access', region: 'eastus2', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'premium', capacityTiB: 2, coolPercent: 25, coolReadWritePercent: 10, hours: 730 },
    // Cool access now applies to premium too: premium hot GiB plus cool-at-rest GiB-hour and cool transfer GiB.
    expected: () => netapp({ region: 'eastus2', serviceLevel: 'premium', capacityTiB: 2, coolPercent: 25, coolReadWritePercent: 10, hours: 730 }) },
  { name: 'westeurope backup restore replication', region: 'westeurope', currency: 'USD',
    component: { type: 'netapp-files', serviceLevel: 'elastic', capacityTiB: 2, backupGiB: 500, restoreGiB: 100, replicationGiB: 250, replicationSchedule: '10min', hours: 730 },
    // Non-US calculator prices: elastic GiB-hour plus backup GiB-month, restore GiB, and 10-minute CRR GiB.
    expected: () => netapp({ region: 'westeurope', serviceLevel: 'elastic', capacityTiB: 2, backupGiB: 500, restoreGiB: 100, replicationGiB: 250, replicationSchedule: '10min', hours: 730 }) },
  { name: 'eur standard cool via retail api', region: 'westeurope', currency: 'EUR',
    component: { type: 'netapp-files', serviceLevel: 'standard', capacityTiB: 1, coolPercent: 50, coolReadWritePercent: 10, hours: 24 },
    // EUR case intentionally uses Retail API meters for standard capacity, cool-at-rest GiB-hour, and cool transfer GiB.
    expected: () => netapp({ region: 'westeurope', currency: 'EUR', serviceLevel: 'standard', capacityTiB: 1, coolPercent: 50, coolReadWritePercent: 10, hours: 24 }) },
] };
