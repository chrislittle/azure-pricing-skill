'use strict';
/**
 * INDEPENDENT PRICING ORACLE for Azure retail pricing.
 *
 * Every function below performs its own Azure Retail Prices API query with explicit
 * filters and does its own arithmetic. No shared "smart" resolver, on purpose: each
 * function is small, explicit and hand-written so it can be audited line by line.
 *
 * Core math rules (see ORACLE_NOTES.md):
 *   cost = (quantity / unitSize) * retailPrice      where unitSize comes from unitOfMeasure
 *   '1 Hour' -> 1, '10K' -> 10000, '1M' -> 1000000, '1K' -> 1000, '100' -> 100,
 *   '1/Month' -> 1 (already a monthly charge), '1 GB/Month' -> 1, '1 GiB/Hour' -> 1
 *   Tiered meters: normalize the quantity into billing units FIRST, then walk the
 *   tierMinimumUnits bands ascending.
 *   Rows are de-duplicated on (meterId, tierMinimumUnits, retailPrice, type) first.
 *   730 hours per month.
 *
 * Line shape:
 *   { desc, meterId, meterName, productName, skuName, unitOfMeasure,
 *     unitPrice, qty, qtyUnitsNote, monthlyList [, bands] }
 * monthlyList per line is rounded to 2 dp; a result's monthlyList is the SUM OF
 * ROUNDED LINES. Discounts are applied later, per line: round2(line * (1 - d)).
 */

const { query, dedupe, unitSize, round2 } = require('./api');

const HOURS_PER_MONTH = 730;
const DAYS_PER_MONTH = HOURS_PER_MONTH / 24; // 30.416666...

const REGION_MAP = {
  'Central US': 'centralus',
  'East US 2': 'eastus2',
  'East US': 'eastus',
  'Germany West Central': 'germanywestcentral',
};
function arm(region) {
  if (REGION_MAP[region]) return REGION_MAP[region];
  return String(region).toLowerCase().replace(/\s+/g, '');
}
function q(s) { return String(s).replace(/'/g, "''"); }

/** Generic tiered-band walker. rows must share a meterId. qty is already in billing units. */
function tiered(rows, qty) {
  const tiers = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  let cost = 0;
  const bands = [];
  for (let i = 0; i < tiers.length; i++) {
    const start = tiers[i].tierMinimumUnits;
    const end = (i + 1 < tiers.length) ? tiers[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    const units = Math.min(qty, end) - start;
    const c = units * tiers[i].retailPrice;
    cost += c;
    bands.push({ fromUnits: start, toUnits: end === Infinity ? null : end, units, unitPrice: tiers[i].retailPrice, cost });
  }
  return { cost, bands };
}

function line(desc, row, qty, qtyUnitsNote, cost) {
  return {
    desc,
    meterId: row.meterId,
    meterName: row.meterName,
    productName: row.productName,
    skuName: row.skuName,
    unitOfMeasure: row.unitOfMeasure,
    unitPrice: row.retailPrice,
    qty,
    qtyUnitsNote,
    monthlyList: round2(cost),
  };
}

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function pick(rows, pred, what) {
  const hits = rows.filter(pred);
  if (!hits.length) throw new Error(`Oracle: no meter row found for ${what}`);
  // Deterministic: cheapest first, then meterId, so repeat runs are stable.
  hits.sort((a, b) => a.retailPrice - b.retailPrice || String(a.meterId).localeCompare(String(b.meterId)));
  return hits[0];
}

// ---------------------------------------------------------------------------
// Virtual Machines
// ---------------------------------------------------------------------------

/**
 * priceVm({region, sku, os, count, hours, currency, mode})
 *   os:   'linux' | 'windows' | 'windows-ahb' | 'rhel'
 *   mode: 'payg' (default) | 'ri1y' | 'ri3y' | 'sp1y' | 'sp3y'
 *
 * Linux / Windows-AHB / RHEL all bill the NON-Windows product meter (the AHB
 * discount is literally "stop paying the Windows product meter"). 'windows' uses
 * the "... Windows" product meter. Spot and Low Priority rows are excluded, and
 * only type 'Consumption' (not 'DevTestConsumption') is used.
 * RHEL additionally adds the regionless RHEL license meter (see priceRhelLicense).
 */
async function priceVm({ region, sku, os = 'linux', count = 1, hours = HOURS_PER_MONTH, currency = 'USD', mode = 'payg', vcpu, includeRhelLicense = true }) {
  const r = arm(region);
  const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${r}' and armSkuName eq '${q(sku)}'`;
  const rows = dedupe(await query(filter, currency));

  const windows = os === 'windows';
  // NOTE: skuName formatting is inconsistent across VM families ('Standard_D4s_v5' vs
  // 'E8as v6'), so the armSkuName filter above is what pins the size; here we only strip
  // the Spot / Low Priority variants and select the OS product family.
  // 'Dasv5 Series Cloud Services' rows also come back under the same armSkuName and do NOT
  // contain 'Windows', so the product name is pinned to the 'Virtual Machines ...' family.
  const base = rows.filter(x =>
    /^Virtual Machines /.test(x.productName) &&
    !/Spot|Low Priority/i.test(x.skuName) &&
    !/Spot|Low Priority/i.test(x.meterName) &&
    (windows ? /\bWindows$/i.test(x.productName) : !/Windows/i.test(x.productName))
  );

  const consumption = pick(base, x => x.type === 'Consumption', `${sku} ${os} Consumption in ${region}`);
  const lines = [];
  const notes = [];

  const osLabel = { linux: 'Linux', windows: 'Windows (license included)', 'windows-ahb': 'Windows + Azure Hybrid Benefit', rhel: 'RHEL (compute only)' }[os] || os;

  if (mode === 'payg') {
    const cost = (hours / unitSize(consumption.unitOfMeasure)) * consumption.retailPrice * count;
    lines.push(line(`VM ${sku} ${osLabel} x${count} @ ${hours} h/mo`, consumption, hours * count, `${hours} hours x ${count} instance(s)`, cost));
  } else if (mode === 'ri1y' || mode === 'ri3y') {
    const term = mode === 'ri1y' ? '1 Year' : '3 Years';
    const months = mode === 'ri1y' ? 12 : 36;
    const res = pick(base, x => x.type === 'Reservation' && x.reservationTerm === term, `${sku} ${os} Reservation ${term} in ${region}`);
    const cost = (res.retailPrice / months) * count;
    const l = line(`VM ${sku} ${osLabel} x${count} - ${term} reserved instance (amortized)`, res, count, `${count} instance(s); retailPrice ${res.retailPrice} is the WHOLE-TERM total, divided by ${months} months`, cost);
    l.wholeTermPrice = res.retailPrice;
    l.termMonths = months;
    lines.push(l);
    notes.push(`Reservation retailPrice (${res.retailPrice}) is the whole-term total per instance; monthly = ${res.retailPrice}/${months}.`);
  } else if (mode === 'sp1y' || mode === 'sp3y') {
    const term = mode === 'sp1y' ? '1 Year' : '3 Years';
    const sp = (consumption.savingsPlan || []).find(x => x.term === term);
    if (!sp) throw new Error(`Oracle: no savings plan term ${term} for ${sku} in ${region}`);
    const cost = sp.unitPrice * hours * count;
    const l = line(`VM ${sku} ${osLabel} x${count} - ${term} compute savings plan @ ${hours} h/mo`, consumption, hours * count, `${hours} hours x ${count} instance(s) at savings-plan effective hourly rate`, cost);
    l.unitPrice = sp.unitPrice;
    l.savingsPlanTerm = term;
    lines.push(l);
    notes.push(`Savings plan unitPrice (${sp.unitPrice}) is the effective hourly rate (api-version 2023-01-01-preview only).`);
  } else {
    throw new Error(`Oracle: unknown VM mode ${mode}`);
  }

  if (os === 'rhel' && includeRhelLicense) {
    const v = vcpu || vcpuOf(sku);
    const rh = await priceRhelLicense({ vcpu: v, hours, count, currency });
    lines.push(...rh.lines);
    notes.push(...rh.notes);
  }
  if (os === 'windows-ahb') {
    notes.push('Azure Hybrid Benefit: priced on the non-Windows product meter, so the Windows Server license component is $0.');
  }

  return { lines, monthlyList: totalOf(lines), notes };
}

/** Best-effort vCPU count from an Azure VM SKU name (Standard_<family><n><suffix>). */
function vcpuOf(sku) {
  const m = String(sku).match(/^Standard_[A-Za-z]+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * priceRhelLicense({vcpu, hours, count, currency})
 * REGIONLESS meter: armRegionName is '' under serviceName 'Virtual Machines Licenses',
 * productName 'Red Hat Enterprise Linux'. For PAYG (on-demand) RHEL images the ONLY
 * charge is the "<N> vCPU VM License" meter; Red Hat support is already included in
 * that consumption price (Learn: "Support cost is integrated into the consumption cost
 * of on-demand images"). The separate "1-4 vCPU VM Support" / "5+ vCPU VM Support"
 * meters apply to BYOS / Cloud Access customers and are NOT added for PAYG.
 */
async function priceRhelLicense({ vcpu, hours = HOURS_PER_MONTH, count = 1, currency = 'USD' }) {
  const filter = `serviceName eq 'Virtual Machines Licenses' and productName eq 'Red Hat Enterprise Linux' and armRegionName eq ''`;
  const rows = dedupe(await query(filter, currency));
  const wanted = `${vcpu} vCPU VM License`;
  const row = pick(rows,
    x => x.type === 'Consumption' && x.meterName === wanted && x.unitOfMeasure === '1 Hour' && x.retailPrice > 0,
    `RHEL PAYG license meter "${wanted}"`);
  const cost = (hours / unitSize(row.unitOfMeasure)) * row.retailPrice * count;
  return {
    lines: [line(`RHEL PAYG license, ${vcpu} vCPU x${count} @ ${hours} h/mo (regionless meter)`, row, hours * count, `${hours} hours x ${count} instance(s)`, cost)],
    monthlyList: round2(cost),
    notes: [`RHEL license meter is regionless (armRegionName ''). vCPU band meter "${row.meterName}" under skuName "${row.skuName}" @ ${row.retailPrice}/hr. Red Hat support is bundled into the PAYG license price, so the separate "*vCPU VM Support" meters are NOT added.`],
  };
}

// ---------------------------------------------------------------------------
// Managed disks
// ---------------------------------------------------------------------------

const DISK_PRODUCT = { P: 'Premium SSD Managed Disks', E: 'Standard SSD Managed Disks', S: 'Standard HDD Managed Disks' };

/**
 * priceManagedDisk({region, tier:'P40'|'E10'|..., redundancy:'LRS'|'ZRS', count, currency})
 * Tier meters are flat monthly ('1/Month'). We take meterName exactly "<tier> <red> Disk"
 * so we exclude "... Disk Mount" (shared-disk mount fee) and "... Disk Operations"
 * (Standard SSD/HDD transaction meter). productName is pinned to the managed-disk product
 * so we never pick the identically-named "Premium Page Blob" rows.
 */
async function priceManagedDisk({ region, tier, redundancy = 'LRS', count = 1, currency = 'USD', sizeGiB }) {
  const r = arm(region);
  const fam = String(tier)[0].toUpperCase();
  const product = DISK_PRODUCT[fam];
  if (!product) throw new Error(`Oracle: unknown disk tier family for ${tier}`);
  const skuName = `${tier} ${redundancy}`;
  const filter = `serviceName eq 'Storage' and armRegionName eq '${r}' and productName eq '${q(product)}' and skuName eq '${q(skuName)}'`;
  const rows = dedupe(await query(filter, currency));
  const row = pick(rows, x => x.type === 'Consumption' && x.meterName === `${skuName} Disk`, `managed disk ${skuName} in ${region}`);
  const cost = row.retailPrice * count; // '1/Month' -> already a monthly price per disk
  const desc = `Managed disk ${tier} ${redundancy}${sizeGiB ? ` (${sizeGiB} GiB requirement)` : ''} x${count}`;
  return {
    lines: [line(desc, row, count, `${count} disk(s); unitOfMeasure '1/Month' = flat monthly price per disk`, cost)],
    monthlyList: round2(cost),
    notes: [`${tier} ${redundancy} is a fixed-size tier billed per disk per month, not per GiB.`],
  };
}

/**
 * pricePremiumV2({region, sizeGiB, iops, throughputMBps, currency})
 * Premium SSD v2 bills provisioned GiB, provisioned IOPS and provisioned MB/s separately.
 * The free baseline of 3,000 IOPS and 125 MB/s is expressed directly in the API as a
 * $0 band with tierMinimumUnits 0 and a paid band starting at 3000 / 125.
 * Verified against https://learn.microsoft.com/azure/virtual-machines/disks-types
 */
async function pricePremiumV2({ region, sizeGiB, iops, throughputMBps, redundancy = 'LRS', currency = 'USD' }) {
  const r = arm(region);
  const filter = `serviceName eq 'Storage' and armRegionName eq '${r}' and productName eq 'Azure Premium SSD v2' and skuName eq 'Premium ${q(redundancy)}'`;
  const rows = dedupe(await query(filter, currency));

  const capRows = rows.filter(x => x.type === 'Consumption' && /Provisioned Capacity$/.test(x.meterName));
  const iopsRows = rows.filter(x => x.type === 'Consumption' && /Provisioned IOPS$/.test(x.meterName));
  const tputRows = rows.filter(x => x.type === 'Consumption' && /Provisioned Throughput \(MBps\)$/.test(x.meterName));
  if (!capRows.length || !iopsRows.length || !tputRows.length) throw new Error(`Oracle: Premium SSD v2 meters missing in ${region}`);

  const lines = [];

  const cap = capRows[0]; // '1 GiB/Hour'
  const capCost = sizeGiB * HOURS_PER_MONTH * cap.retailPrice;
  lines.push(line(`Premium SSD v2 provisioned capacity ${sizeGiB} GiB`, cap, sizeGiB * HOURS_PER_MONTH, `${sizeGiB} GiB x ${HOURS_PER_MONTH} h`, capCost));

  const io = tiered(iopsRows, iops);
  const ioRow = iopsRows.slice().sort((a, b) => b.tierMinimumUnits - a.tierMinimumUnits)[0];
  const ioCost = io.cost * HOURS_PER_MONTH;
  const ioLine = line(`Premium SSD v2 provisioned IOPS ${iops} (first ${ioRow.tierMinimumUnits} free)`, ioRow, iops * HOURS_PER_MONTH, `${iops} IOPS x ${HOURS_PER_MONTH} h; first ${ioRow.tierMinimumUnits} IOPS are a $0 band`, ioCost);
  ioLine.bands = io.bands;
  lines.push(ioLine);

  const tp = tiered(tputRows, throughputMBps);
  const tpRow = tputRows.slice().sort((a, b) => b.tierMinimumUnits - a.tierMinimumUnits)[0];
  const tpCost = tp.cost * HOURS_PER_MONTH;
  const tpLine = line(`Premium SSD v2 provisioned throughput ${throughputMBps} MB/s (first ${tpRow.tierMinimumUnits} free)`, tpRow, throughputMBps * HOURS_PER_MONTH, `${throughputMBps} MB/s x ${HOURS_PER_MONTH} h; first ${tpRow.tierMinimumUnits} MB/s are a $0 band`, tpCost);
  tpLine.bands = tp.bands;
  lines.push(tpLine);

  return {
    lines,
    monthlyList: totalOf(lines),
    notes: ['Premium SSD v2 includes 3,000 IOPS and 125 MB/s free with the provisioned capacity; the API encodes this as a $0 band with the paid band starting at tierMinimumUnits 3000 / 125.'],
  };
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/** pricePublicIp({region, count, hours, currency}) - Standard static IPv4. */
async function pricePublicIp({ region, count = 1, hours = HOURS_PER_MONTH, currency = 'USD' }) {
  const r = arm(region);
  const filter = `serviceName eq 'Virtual Network' and armRegionName eq '${r}' and productName eq 'IP Addresses' and skuName eq 'Standard'`;
  const rows = dedupe(await query(filter, currency));
  const row = pick(rows, x => x.type === 'Consumption' && x.meterName === 'Standard IPv4 Static Public IP', `Standard static public IPv4 in ${region}`);
  const cost = (hours / unitSize(row.unitOfMeasure)) * row.retailPrice * count;
  return {
    lines: [line(`Standard static public IPv4 x${count} @ ${hours} h/mo`, row, hours * count, `${hours} hours x ${count} IP(s)`, cost)],
    monthlyList: round2(cost),
    notes: [],
  };
}

/**
 * priceBandwidth({region, egressGB, currency})
 * Internet egress on the DEFAULT routing preference (Microsoft global network).
 * Meter: serviceName 'Bandwidth', productName 'Rtn Preference: MGN', skuName 'Standard',
 * meterName 'Standard Data Transfer Out'. This is the default that applies unless the
 * customer explicitly opts into "Internet" routing preference (productName
 * 'Bandwidth - Routing Preference: Internet', which is cheaper but not the default).
 * The first band (tierMinimumUnits 0) is priced 0 => the first 100 GB/month are free.
 */
async function priceBandwidth({ region, egressGB, currency = 'USD' }) {
  const r = arm(region);
  const filter = `serviceName eq 'Bandwidth' and armRegionName eq '${r}' and productName eq 'Rtn Preference: MGN' and skuName eq 'Standard' and meterName eq 'Standard Data Transfer Out'`;
  const rows = dedupe(await query(filter, currency)).filter(x => x.type === 'Consumption');
  if (!rows.length) throw new Error(`Oracle: no internet egress meter in ${region}`);
  const t = tiered(rows, egressGB);
  const top = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  const freeUpTo = top.length > 1 ? top[1].tierMinimumUnits : 0;
  const repr = top[1] || top[0];
  const l = line(`Internet egress ${egressGB} GB (first ${freeUpTo} GB free, tiered)`, repr, egressGB, `${egressGB} GB in the month, banded by tierMinimumUnits`, t.cost);
  l.bands = t.bands;
  return {
    lines: [l],
    monthlyList: round2(t.cost),
    notes: [`Egress priced on the default Microsoft-network routing preference meter (productName 'Rtn Preference: MGN'). First ${freeUpTo} GB/month are free (a $0 band at tierMinimumUnits 0).`],
  };
}

/**
 * priceLoadBalancer({rules, processedGB, hours, currency})
 * Standard Load Balancer is priced on GLOBAL meters (armRegionName 'Global'):
 *   "Standard Included LB Rules and Outbound Rules"  $/hour, covers the first 5 rules
 *   "Standard Overage LB Rules and Outbound Rules"   $/hour per rule beyond 5
 *   "Standard Data Processed"                        $/GB
 */
async function priceLoadBalancer({ rules = 5, processedGB = 0, hours = HOURS_PER_MONTH, currency = 'USD' }) {
  const filter = `serviceName eq 'Load Balancer' and armRegionName eq 'Global' and productName eq 'Load Balancer' and skuName eq 'Standard'`;
  const rows = dedupe(await query(filter, currency)).filter(x => x.type === 'Consumption' && x.retailPrice > 0);

  const inc = pick(rows, x => x.meterName === 'Standard Included LB Rules and Outbound Rules', 'Standard LB included rules');
  const lines = [];
  lines.push(line(`Standard Load Balancer, first 5 rules @ ${hours} h/mo`, inc, hours, `${hours} hours (flat, covers up to 5 rules)`, (hours / unitSize(inc.unitOfMeasure)) * inc.retailPrice));

  if (rules > 5) {
    const ovr = pick(rows, x => x.meterName === 'Standard Overage LB Rules and Outbound Rules', 'Standard LB overage rules');
    const extra = rules - 5;
    lines.push(line(`Standard Load Balancer, ${extra} additional rule(s) @ ${hours} h/mo`, ovr, hours * extra, `${hours} hours x ${extra} rule(s) beyond the included 5`, hours * extra * ovr.retailPrice));
  }

  if (processedGB > 0) {
    const dp = pick(rows, x => x.meterName === 'Standard Data Processed', 'Standard LB data processed');
    lines.push(line(`Standard Load Balancer data processed ${processedGB} GB`, dp, processedGB, `${processedGB} GB`, (processedGB / unitSize(dp.unitOfMeasure)) * dp.retailPrice));
  }

  return { lines, monthlyList: totalOf(lines), notes: ['Standard Load Balancer meters are global (armRegionName "Global"); the first 5 rules are covered by the flat hourly "Included" meter.'] };
}

// ---------------------------------------------------------------------------
// AKS / App Service
// ---------------------------------------------------------------------------

/** priceAksStandardTier({region, hours, currency}) - AKS Standard tier control plane (uptime SLA). */
async function priceAksStandardTier({ region, hours = HOURS_PER_MONTH, currency = 'USD' }) {
  const r = arm(region);
  const filter = `serviceName eq 'Azure Kubernetes Service' and armRegionName eq '${r}' and productName eq 'Azure Kubernetes Service' and skuName eq 'Standard'`;
  const rows = dedupe(await query(filter, currency));
  const row = pick(rows, x => x.type === 'Consumption' && x.meterName === 'Standard Uptime SLA', `AKS Standard tier in ${region}`);
  const cost = (hours / unitSize(row.unitOfMeasure)) * row.retailPrice;
  return {
    lines: [line(`AKS Standard tier control plane (uptime SLA) @ ${hours} h/mo`, row, hours, `${hours} hours`, cost)],
    monthlyList: round2(cost),
    notes: ['AKS Free tier has no control-plane charge; Standard tier (financially backed uptime SLA) is the "Standard Uptime SLA" meter.'],
  };
}

/**
 * priceAppService({region, plan:'P1v3', os:'windows'|'linux', count, hours, currency})
 * Windows App Service Plans use the product WITHOUT the "- Linux" suffix.
 */
async function priceAppService({ region, plan = 'P1v3', os = 'windows', count = 1, hours = HOURS_PER_MONTH, currency = 'USD' }) {
  const r = arm(region);
  const map = {
    P1v3: { product: 'Azure App Service Premium v3 Plan', sku: 'P1 v3', meter: 'P1 v3 App' },
    P1mv3: { product: 'Azure App Service Premium v3 Plan', sku: 'P1mv3', meter: 'P1mv3 App' },
    P0v3: { product: 'Azure App Service Premium v3 Plan', sku: 'P0 v3', meter: 'P0 v3 App' },
    P1v2: { product: 'Azure App Service Premium v2 Plan', sku: 'P1 v2', meter: 'P1 v2 App' },
  };
  const m = map[plan];
  if (!m) throw new Error(`Oracle: unmapped App Service plan ${plan}`);
  const product = os === 'linux' ? `${m.product} - Linux` : m.product;
  const filter = `serviceName eq 'Azure App Service' and armRegionName eq '${r}' and productName eq '${q(product)}' and skuName eq '${q(m.sku)}'`;
  const rows = dedupe(await query(filter, currency));
  const row = pick(rows, x => x.type === 'Consumption' && x.meterName === m.meter, `App Service ${plan} ${os} in ${region}`);
  const cost = (hours / unitSize(row.unitOfMeasure)) * row.retailPrice * count;
  return {
    lines: [line(`App Service ${plan} ${os} x${count} @ ${hours} h/mo`, row, hours * count, `${hours} hours x ${count} instance(s)`, cost)],
    monthlyList: round2(cost),
    notes: [`Windows App Service uses productName '${product}' (the Linux variant is a separate, cheaper product).`],
  };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * sqlLicenseMeter(serviceName, gpProductName, currency)
 *
 * Azure SQL PaaS splits vCore pricing into TWO meters (verified against the API and Learn):
 *   1. "<service> General Purpose - Compute Gen5"  -> the BASE COMPUTE rate (= the Azure Hybrid
 *      Benefit price). Regional.
 *   2. "<service> General Purpose - SQL License"   -> the SQL Server license component.
 *      skuName 'vCore', meterName 'vCore', unitOfMeasure '1 Hour', and it is a GLOBAL meter
 *      (armRegionName eq 'Global'), priced PER vCORE at $0.099966/hr worldwide.
 *
 * Learn, "Azure Hybrid Benefit - Azure SQL Database & SQL Managed Instance":
 *   "'License Included' pricing is made up of base compute and SQL license components.
 *    Azure Hybrid Benefit pricing is made up of base compute and software assurance components."
 *
 * So a customer WITHOUT SQL Server licenses pays compute + license; an AHB customer pays
 * compute only. Note this meter's skuName is a bare 'vCore' (there are no '<n> vCore' rows),
 * so unlike the compute meter it MUST be multiplied by the vCore count.
 */
async function sqlLicenseMeter(serviceName, licenseProductName, currency = 'USD') {
  const f = `serviceName eq '${serviceName}' and armRegionName eq 'Global' and productName eq '${licenseProductName}' and skuName eq 'vCore'`;
  const rows = dedupe(await query(f, currency));
  return pick(rows, x => x.type === 'Consumption' && x.meterName === 'vCore' && x.retailPrice > 0, `${licenseProductName} (Global)`);
}

/**
 * priceSqlDatabaseGP({region, vcores, storageGB, hours, licenseIncluded, currency})
 * Azure SQL Database, General Purpose, provisioned, Gen5.
 * Compute meter: productName 'SQL Database Single/Elastic Pool General Purpose - Compute Gen5',
 * skuName '<n> vCore', meterName 'vCore'. The retailPrice on the '<n> vCore' row is the
 * hourly BASE COMPUTE price for the WHOLE n-vCore database (exactly n x the '1 vCore' price).
 * License meter (only when licenseIncluded, i.e. the customer has no SQL Server licenses):
 *   GLOBAL 'SQL Database Single/Elastic Pool General Purpose - SQL License', per vCore per hour.
 * Storage meter: productName 'SQL Database Single/Elastic Pool General Purpose - Storage',
 * meterName 'General Purpose Data Stored', $/GB/month, billed on provisioned size.
 */
async function priceSqlDatabaseGP({ region, vcores, storageGB, hours = HOURS_PER_MONTH, licenseIncluded = true, currency = 'USD' }) {
  const r = arm(region);
  const cf = `serviceName eq 'SQL Database' and armRegionName eq '${r}' and productName eq 'SQL Database Single/Elastic Pool General Purpose - Compute Gen5' and skuName eq '${vcores} vCore'`;
  const crows = dedupe(await query(cf, currency));
  const c = pick(crows, x => x.type === 'Consumption' && x.meterName === 'vCore', `SQL DB GP Gen5 ${vcores} vCore in ${region}`);
  const cCost = (hours / unitSize(c.unitOfMeasure)) * c.retailPrice;

  const sf = `serviceName eq 'SQL Database' and armRegionName eq '${r}' and productName eq 'SQL Database Single/Elastic Pool General Purpose - Storage' and skuName eq 'General Purpose'`;
  const srows = dedupe(await query(sf, currency));
  const s = pick(srows, x => x.type === 'Consumption' && x.meterName === 'General Purpose Data Stored' && x.retailPrice > 0, `SQL DB GP storage in ${region}`);
  const sCost = storageGB * s.retailPrice;

  const lines = [
    line(`Azure SQL DB General Purpose Gen5 ${vcores} vCore - base compute @ ${hours} h/mo`, c, hours, `${hours} hours; the '${vcores} vCore' row price is the base-compute hourly rate for the whole ${vcores}-vCore database (this is also the Azure Hybrid Benefit price)`, cCost),
  ];
  const notes = [];

  if (licenseIncluded) {
    const l = await sqlLicenseMeter('SQL Database', 'SQL Database Single/Elastic Pool General Purpose - SQL License', currency);
    const lQty = vcores * hours;
    const lCost = (lQty / unitSize(l.unitOfMeasure)) * l.retailPrice;
    lines.push(line(`Azure SQL DB General Purpose SQL Server license - ${vcores} vCore @ ${hours} h/mo`, l, lQty, `${vcores} vCore x ${hours} hours = ${lQty} vCore-hours; GLOBAL meter, per-vCore rate`, lCost));
    notes.push('License-included pricing: base compute meter PLUS the global "General Purpose - SQL License" meter ($0.099966 per vCore-hour). With Azure Hybrid Benefit the license line disappears and only base compute is paid.');
  } else {
    notes.push('Azure Hybrid Benefit: only the base compute meter is billed; the "General Purpose - SQL License" meter is not charged.');
  }

  lines.push(line(`Azure SQL DB General Purpose data storage ${storageGB} GB`, s, storageGB, `${storageGB} GB provisioned`, sCost));
  notes.push('Backup/PITR storage is not included in this estimate - the customer did not specify retention beyond the default.');
  return { lines, monthlyList: totalOf(lines), notes };
}

/**
 * priceSqlMiGP({region, vcores, storageGB, hours, licenseIncluded, currency})
 * SQL Managed Instance, General Purpose, Gen5.
 * Same two-meter structure as SQL Database: regional base compute + GLOBAL SQL License meter.
 * The first 32 GB of instance storage is free (Learn), so only (storageGB - 32) is billed.
 */
async function priceSqlMiGP({ region, vcores, storageGB, hours = HOURS_PER_MONTH, licenseIncluded = true, currency = 'USD' }) {
  const r = arm(region);
  const cf = `serviceName eq 'SQL Managed Instance' and armRegionName eq '${r}' and productName eq 'SQL Managed Instance General Purpose - Compute Gen5' and skuName eq '${vcores} vCore'`;
  const crows = dedupe(await query(cf, currency));
  const c = pick(crows, x => x.type === 'Consumption' && x.meterName === 'vCore', `SQL MI GP Gen5 ${vcores} vCore in ${region}`);
  const cCost = (hours / unitSize(c.unitOfMeasure)) * c.retailPrice;

  const sf = `serviceName eq 'SQL Managed Instance' and armRegionName eq '${r}' and productName eq 'SQL Managed Instance General Purpose - Storage' and skuName eq 'General Purpose'`;
  const srows = dedupe(await query(sf, currency));
  const s = pick(srows, x => x.type === 'Consumption' && x.meterName === 'General Purpose Data Stored', `SQL MI GP storage in ${region}`);
  const billableGB = Math.max(0, storageGB - 32);
  const sCost = billableGB * s.retailPrice;

  const lines = [
    line(`Azure SQL Managed Instance GP Gen5 ${vcores} vCore - base compute @ ${hours} h/mo`, c, hours, `${hours} hours; the '${vcores} vCore' row price is the base-compute hourly rate for the whole ${vcores}-vCore instance (this is also the Azure Hybrid Benefit price)`, cCost),
  ];
  const notes = [];

  if (licenseIncluded) {
    const l = await sqlLicenseMeter('SQL Managed Instance', 'SQL Managed Instance General Purpose - SQL License', currency);
    const lQty = vcores * hours;
    const lCost = (lQty / unitSize(l.unitOfMeasure)) * l.retailPrice;
    lines.push(line(`SQL Managed Instance GP SQL Server license - ${vcores} vCore @ ${hours} h/mo`, l, lQty, `${vcores} vCore x ${hours} hours = ${lQty} vCore-hours; GLOBAL meter, per-vCore rate`, lCost));
    notes.push('License-included pricing: base compute meter PLUS the global "General Purpose - SQL License" meter ($0.099966 per vCore-hour). With Azure Hybrid Benefit the license line disappears and only base compute is paid.');
  } else {
    notes.push('Azure Hybrid Benefit: only the base compute meter is billed; the "General Purpose - SQL License" meter is not charged.');
  }

  lines.push(line(`SQL MI GP storage ${storageGB} GB (first 32 GB included free)`, s, billableGB, `${storageGB} GB provisioned minus 32 GB included = ${billableGB} GB billed`, sCost));
  notes.push('SQL Managed Instance includes the first 32 GB of storage free; you are billed on the MAXIMUM configured storage, not consumed.');
  return { lines, monthlyList: totalOf(lines), notes };
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * priceFunctionsConsumption({region, executions, gbSeconds, currency})
 * Consumption plan = serviceName 'Functions', productName 'Functions', skuName 'Standard'.
 *   "Standard Total Executions"  unitOfMeasure '10'         -> 1 billing unit = 10 executions.
 *                                tierMinimumUnits 100000 units = 1,000,000 executions free.
 *   "Standard Execution Time"    unitOfMeasure '1 GB Second' -> tierMinimumUnits 400000 GB-s free.
 * The free grants are therefore taken straight from the API, not from memory.
 */
async function priceFunctionsConsumption({ region, executions, gbSeconds, currency = 'USD' }) {
  const r = arm(region);
  const filter = `serviceName eq 'Functions' and armRegionName eq '${r}' and productName eq 'Functions' and skuName eq 'Standard'`;
  const rows = dedupe(await query(filter, currency)).filter(x => x.type === 'Consumption');

  const execRows = rows.filter(x => x.meterName === 'Standard Total Executions');
  const timeRows = rows.filter(x => x.meterName === 'Standard Execution Time');
  if (!execRows.length || !timeRows.length) throw new Error(`Oracle: Functions consumption meters missing in ${region}`);

  const execUnitSize = unitSize(execRows[0].unitOfMeasure); // 10
  const execUnits = executions / execUnitSize;
  const e = tiered(execRows, execUnits);
  const eRepr = execRows.slice().sort((a, b) => b.tierMinimumUnits - a.tierMinimumUnits)[0];
  const eFree = eRepr.tierMinimumUnits * execUnitSize;
  const eLine = line(`Functions Consumption executions: ${executions.toLocaleString('en-US')} (first ${eFree.toLocaleString('en-US')} free)`, eRepr, execUnits, `${executions} executions / ${execUnitSize} per billing unit = ${execUnits} units`, e.cost);
  eLine.bands = e.bands;

  const t = tiered(timeRows, gbSeconds);
  const tRepr = timeRows.slice().sort((a, b) => b.tierMinimumUnits - a.tierMinimumUnits)[0];
  const tLine = line(`Functions Consumption execution time: ${gbSeconds.toLocaleString('en-US')} GB-s (first ${tRepr.tierMinimumUnits.toLocaleString('en-US')} GB-s free)`, tRepr, gbSeconds, `${gbSeconds} GB-seconds`, t.cost);
  tLine.bands = t.bands;

  const lines = [eLine, tLine];
  return {
    lines,
    monthlyList: totalOf(lines),
    notes: [`Free grants come straight from the API tier structure: executions meter unitOfMeasure '${execRows[0].unitOfMeasure}' with a $0 band up to tierMinimumUnits ${eRepr.tierMinimumUnits} (= ${eFree} executions), and execution time $0 up to ${tRepr.tierMinimumUnits} GB-s.`],
  };
}

// ---------------------------------------------------------------------------
// Blob storage
// ---------------------------------------------------------------------------

/**
 * priceBlob({region, tier:'Hot'|'Cool'|'Cold'|'Archive', redundancy, capacityGB, writeOps, readOps, currency})
 * productName 'General Block Blob v2'. Data-stored meters can be tiered (Hot LRS has
 * 0 / 51200 / 512000 GB bands). Operation meters are per 10,000 operations ('10K').
 */
async function priceBlob({ region, tier = 'Hot', redundancy = 'LRS', capacityGB = 0, writeOps = 0, readOps = 0, currency = 'USD' }) {
  const r = arm(region);
  const skuName = `${tier} ${redundancy}`;
  const filter = `serviceName eq 'Storage' and armRegionName eq '${r}' and productName eq 'General Block Blob v2' and skuName eq '${q(skuName)}'`;
  const rows = dedupe(await query(filter, currency)).filter(x => x.type === 'Consumption');
  const lines = [];

  if (capacityGB > 0) {
    const storeRows = rows.filter(x => /Data Stored$/.test(x.meterName) && !/Free/i.test(x.meterName));
    if (!storeRows.length) throw new Error(`Oracle: no blob data stored meter for ${skuName} in ${region}`);
    const t = tiered(storeRows, capacityGB);
    const repr = storeRows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits)[0];
    const l = line(`Blob ${tier} ${redundancy} data stored ${capacityGB} GB`, repr, capacityGB, `${capacityGB} GB/month`, t.cost);
    if (storeRows.length > 1) l.bands = t.bands;
    lines.push(l);
  }
  if (writeOps > 0) {
    const w = pick(rows, x => /Write Operations$/.test(x.meterName), `blob write ops ${skuName}`);
    const units = writeOps / unitSize(w.unitOfMeasure);
    lines.push(line(`Blob ${tier} ${redundancy} write operations ${writeOps.toLocaleString('en-US')}`, w, units, `${writeOps} ops / ${unitSize(w.unitOfMeasure)} per billing unit = ${units} units`, units * w.retailPrice));
  }
  if (readOps > 0) {
    const rd = pick(rows, x => /Read Operations$/.test(x.meterName) && !/Priority/i.test(x.meterName), `blob read ops ${skuName}`);
    const units = readOps / unitSize(rd.unitOfMeasure);
    lines.push(line(`Blob ${tier} ${redundancy} read operations ${readOps.toLocaleString('en-US')}`, rd, units, `${readOps} ops / ${unitSize(rd.unitOfMeasure)} per billing unit = ${units} units`, units * rd.retailPrice));
  }

  return {
    lines,
    monthlyList: totalOf(lines),
    notes: [`Operation meters are per ${unitSize('10K')} operations (unitOfMeasure '10K') - dividing by 10,000 is mandatory.`],
  };
}

// ---------------------------------------------------------------------------
// Azure OpenAI / Foundry Models
// ---------------------------------------------------------------------------

// Explicit meter map for Global Standard (non-batch, non-cached, non-provisioned,
// non-fine-tuned) text models named in the scenario accept list. Discovered by
// inspecting serviceName 'Foundry Models' rows; sku naming is inconsistent across
// model generations ('glbl' vs 'Gl' vs 'Glbl'), so it is pinned explicitly.
const OPENAI_MODELS = {
  'gpt-5-nano': { product: 'Azure OpenAI GPT5', inSku: 'GPT 5 Nano Inpt Glbl', outSku: 'GPT 5 Nano outpt Glbl' },
  'gpt-5-mini': { product: 'Azure OpenAI GPT5', inSku: 'GPT 5 Mini Inpt Glbl', outSku: 'GPT 5 Mini outpt Glbl' },
  'gpt-4.1-nano': { product: 'Azure OpenAI', inSku: 'gpt 4.1 nano Inp glbl', outSku: 'gpt 4.1 nano Outp glbl' },
  'gpt-4.1-mini': { product: 'Azure OpenAI', inSku: 'gpt 4.1 mini Inp glbl', outSku: 'gpt 4.1 mini Outp glbl' },
  'gpt-4o-mini': { product: 'Azure OpenAI', inSku: 'gpt-4o-mini-0718-Inp-glbl', outSku: 'gpt-4o-mini-0718-Outp-glbl' },
};

/**
 * priceOpenAiTokens({region, model, inputTokens, outputTokens, deployment:'Global', currency})
 * Token meters live under serviceName 'Foundry Models'. unitOfMeasure is '1K' for the
 * gpt-4.x generation and '1M' for the gpt-5 generation - the unit multiplier matters a lot.
 */
async function priceOpenAiTokens({ region, model, inputTokens, outputTokens, deployment = 'Global', currency = 'USD' }) {
  const r = arm(region);
  const m = OPENAI_MODELS[model];
  if (!m) throw new Error(`Oracle: unmapped OpenAI model ${model}`);
  if (deployment !== 'Global') throw new Error('Oracle: only Global Standard deployment is mapped');

  const filter = `serviceName eq 'Foundry Models' and armRegionName eq '${r}' and productName eq '${q(m.product)}' and (skuName eq '${q(m.inSku)}' or skuName eq '${q(m.outSku)}')`;
  const rows = dedupe(await query(filter, currency)).filter(x => x.type === 'Consumption');
  const inRow = pick(rows, x => x.skuName === m.inSku, `${model} Global Standard input tokens in ${region}`);
  const outRow = pick(rows, x => x.skuName === m.outSku, `${model} Global Standard output tokens in ${region}`);

  const inUnits = inputTokens / unitSize(inRow.unitOfMeasure);
  const outUnits = outputTokens / unitSize(outRow.unitOfMeasure);
  const lines = [
    line(`${model} Global Standard input tokens: ${inputTokens.toLocaleString('en-US')}`, inRow, inUnits, `${inputTokens} tokens / ${unitSize(inRow.unitOfMeasure)} per billing unit ('${inRow.unitOfMeasure}') = ${inUnits} units`, inUnits * inRow.retailPrice),
    line(`${model} Global Standard output tokens: ${outputTokens.toLocaleString('en-US')}`, outRow, outUnits, `${outputTokens} tokens / ${unitSize(outRow.unitOfMeasure)} per billing unit ('${outRow.unitOfMeasure}') = ${outUnits} units`, outUnits * outRow.retailPrice),
  ];
  return {
    lines,
    monthlyList: totalOf(lines),
    notes: [`Meters: '${inRow.meterName}' (${inRow.unitOfMeasure}) and '${outRow.meterName}' (${outRow.unitOfMeasure}) under productName '${m.product}'. Batch, cached-input, provisioned and fine-tuned meters are deliberately excluded.`],
  };
}

// ---------------------------------------------------------------------------
// Cosmos DB
// ---------------------------------------------------------------------------

/**
 * priceCosmosAutoscale({region, maxRU, hours, storageGB, currency})
 * Autoscale throughput: productName 'Azure Cosmos DB autoscale', meterName '<AP> 100 RUs',
 * unitOfMeasure '1/Hour' where 1 unit = 100 RU/s for 1 hour. Autoscale bills the MAXIMUM
 * provisioned RU/s unless the container actually scales down, so the oracle prices max RU/s
 * for every hour (the worst case and the conventional estimate).
 * Storage: productName 'Azure Cosmos DB', skuName 'RUs', meterName 'Data Stored' $/GB/month.
 */
async function priceCosmosAutoscale({ region, maxRU, hours = HOURS_PER_MONTH, storageGB = 0, currency = 'USD' }) {
  const r = arm(region);
  const tf = `serviceName eq 'Azure Cosmos DB' and armRegionName eq '${r}' and productName eq 'Azure Cosmos DB autoscale'`;
  const trows = dedupe(await query(tf, currency)).filter(x => x.type === 'Consumption' && /100 RUs$/.test(x.meterName) && x.retailPrice > 0);
  const t = pick(trows, () => true, `Cosmos autoscale 100 RU/s meter in ${region}`);
  const units = (maxRU / 100) * hours;
  const tCost = units * t.retailPrice;

  const lines = [line(`Cosmos DB autoscale up to ${maxRU} RU/s @ ${hours} h/mo`, t, units, `${maxRU}/100 = ${maxRU / 100} units of 100 RU/s x ${hours} hours = ${units} unit-hours`, tCost)];

  if (storageGB > 0) {
    const sf = `serviceName eq 'Azure Cosmos DB' and armRegionName eq '${r}' and productName eq 'Azure Cosmos DB' and skuName eq 'RUs' and meterName eq 'Data Stored'`;
    const srows = dedupe(await query(sf, currency)).filter(x => x.type === 'Consumption');
    const s = pick(srows, x => x.retailPrice > 0, `Cosmos transactional storage in ${region}`);
    lines.push(line(`Cosmos DB transactional storage ${storageGB} GB`, s, storageGB, `${storageGB} GB/month`, storageGB * s.retailPrice));
  }

  return {
    lines,
    monthlyList: totalOf(lines),
    notes: [`Autoscale is billed per 100 RU/s per hour on the MAXIMUM provisioned throughput. All autoscale AP1-AP4 meters carry the same price (${t.retailPrice}); '${t.meterName}' is used. Single region, so no multi-region multiplier. Backup: two free periodic backup copies are included, so no backup line.`],
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL flexible server
// ---------------------------------------------------------------------------

const PG_SERIES = {
  D4ds_v5: 'Azure Database for PostgreSQL Flexible Server General Purpose Ddsv5 Series Compute',
  D4ads_v5: 'Azure Database for PostgreSQL Flexible Server General Purpose Dadsv5 Series Compute',
  D4ds_v4: 'Azure Database for PostgreSQL Flexible Server General Purpose Ddsv4 Series Compute',
  D4s_v3: 'Azure Database for PostgreSQL Flexible Server General Purpose Dsv3 Series Compute',
};

/**
 * pricePostgresFlex({region, sku:'D4ds_v5', vcores, ha, storageGB, hours, currency})
 * Zone-redundant HA provisions a full standby: Learn states HA "doubles your deployment
 * costs", and the v5 compute billing model was explicitly corrected in April 2024 so that
 * HA-enabled servers show billing quantities multiplied by 2. The oracle therefore doubles
 * BOTH the compute and the storage line. Backup storage up to 100% of provisioned storage
 * at the default 7-day retention is free, so there is no backup line.
 */
async function pricePostgresFlex({ region, sku = 'D4ds_v5', vcores = 4, ha = false, storageGB = 0, hours = HOURS_PER_MONTH, currency = 'USD' }) {
  const r = arm(region);
  const product = PG_SERIES[sku];
  if (!product) throw new Error(`Oracle: unmapped PostgreSQL SKU ${sku}`);
  const cf = `serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${r}' and productName eq '${q(product)}' and skuName eq '${vcores} vCore'`;
  const crows = dedupe(await query(cf, currency));
  const c = pick(crows, x => x.type === 'Consumption' && x.meterName === 'vCore', `PostgreSQL flex ${sku} ${vcores} vCore in ${region}`);
  const mult = ha ? 2 : 1;
  const cCost = (hours / unitSize(c.unitOfMeasure)) * c.retailPrice * mult;

  const sf = `serviceName eq 'Azure Database for PostgreSQL' and armRegionName eq '${r}' and productName eq 'Azure Database for PostgreSQL Flex Server Storage' and skuName eq 'Storage'`;
  const srows = dedupe(await query(sf, currency));
  const s = pick(srows, x => x.type === 'Consumption' && x.meterName === 'Storage Data Stored', `PostgreSQL flex storage in ${region}`);
  const sCost = storageGB * s.retailPrice * mult;

  const lines = [
    line(`PostgreSQL Flexible Server ${sku} General Purpose ${vcores} vCore${ha ? ' x2 (zone-redundant HA: primary + standby)' : ''} @ ${hours} h/mo`, c, hours * mult, `${hours} hours x ${mult} server(s)`, cCost),
    line(`PostgreSQL Flexible Server storage ${storageGB} GB${ha ? ' x2 (primary + standby)' : ''}`, s, storageGB * mult, `${storageGB} GB x ${mult}`, sCost),
  ];
  return {
    lines,
    monthlyList: totalOf(lines),
    notes: [
      'Zone-redundant HA provisions a standby billed at the same rate as the primary; Learn: "This option doubles your deployment costs" and "If you use the v5 tier with HA-enabled servers, you now see billing quantities multiplied by 2". Compute AND storage are doubled.',
      'Default 7-day backup retention is free up to 100% of provisioned storage, so no backup storage line is added.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Log Analytics
// ---------------------------------------------------------------------------

/**
 * priceLogAnalytics({region, ingestGBPerDay, currency})
 * PAYG Analytics Logs ingestion: serviceName 'Log Analytics', skuName 'Analytics Logs',
 * meterName 'Analytics Logs Data Ingestion'. The 5 GB/month free allowance is encoded in
 * the API as a $0 band with tierMinimumUnits 5, so it is applied automatically by the
 * tier walk (the free allowance is per billing account, not per workspace - see notes).
 * The 100 GB/day commitment tier ('Azure Monitor' / '100 GB Commitment Tier Capacity
 * Reservation', '1/Day') is computed too and only reported as the selected option if it
 * is actually cheaper.
 * Month length = 730/24 = 30.4167 days for consistency with 730 hours/month.
 */
async function priceLogAnalytics({ region, ingestGBPerDay, currency = 'USD' }) {
  const r = arm(region);
  const monthlyGB = ingestGBPerDay * DAYS_PER_MONTH;

  const pf = `serviceName eq 'Log Analytics' and armRegionName eq '${r}' and skuName eq 'Analytics Logs' and meterName eq 'Analytics Logs Data Ingestion'`;
  const prows = dedupe(await query(pf, currency)).filter(x => x.type === 'Consumption');
  if (!prows.length) throw new Error(`Oracle: no Log Analytics ingestion meter in ${region}`);
  const t = tiered(prows, monthlyGB);
  const repr = prows.slice().sort((a, b) => b.tierMinimumUnits - a.tierMinimumUnits)[0];
  const freeGB = repr.tierMinimumUnits;

  const cf = `serviceName eq 'Azure Monitor' and armRegionName eq '${r}' and skuName eq '100 GB Commitment Tier'`;
  const crows = dedupe(await query(cf, currency)).filter(x => x.type === 'Consumption' && /Capacity Reservation$/.test(x.meterName));
  let commitmentMonthly = null, cRow = null;
  if (crows.length) {
    cRow = crows[0];
    commitmentMonthly = cRow.retailPrice * DAYS_PER_MONTH; // '1/Day'
  }

  const useCommitment = commitmentMonthly !== null && commitmentMonthly < t.cost;
  const lines = [];
  if (useCommitment) {
    lines.push(line(`Log Analytics 100 GB/day commitment tier (cheaper than PAYG here)`, cRow, DAYS_PER_MONTH, `${DAYS_PER_MONTH.toFixed(4)} days/month x ${cRow.retailPrice}/day`, commitmentMonthly));
  } else {
    const l = line(`Log Analytics Analytics-Logs ingestion ${monthlyGB.toFixed(2)} GB/month (${ingestGBPerDay} GB/day, first ${freeGB} GB free)`, repr, monthlyGB, `${ingestGBPerDay} GB/day x ${DAYS_PER_MONTH.toFixed(4)} days = ${monthlyGB.toFixed(4)} GB`, t.cost);
    l.bands = t.bands;
    lines.push(l);
  }

  return {
    lines,
    monthlyList: totalOf(lines),
    notes: [
      `Month length = 730/24 = ${DAYS_PER_MONTH.toFixed(4)} days, for consistency with 730 hours/month.`,
      `The ${freeGB} GB/month free Analytics Logs allowance is taken straight from the API ($0 band, paid band starts at tierMinimumUnits ${freeGB}). It is a per-billing-account allowance, so if the customer already consumes it elsewhere the true cost is ${round2(monthlyGB * repr.retailPrice)}.`,
      `100 GB/day commitment tier would cost ${commitmentMonthly === null ? 'n/a' : round2(commitmentMonthly)}/month - ${useCommitment ? 'cheaper, so it is used' : 'more expensive here, so PAYG is used'}.`,
      'Analytics Logs include 31 days of retention at no extra charge; no retention line is added because the customer did not ask for longer retention.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Container Apps
// ---------------------------------------------------------------------------

/**
 * priceContainerAppsConsumption({region, apps, vcpu, memGiB, replicas, hours, requests, idle, currency})
 * Consumption plan meters (serviceName 'Azure Container Apps', skuName 'Standard'):
 *   'Standard vCPU Active Usage'   '1 Second'      $/vCPU-second
 *   'Standard Memory Active Usage' '1 GiB Second'  $/GiB-second
 *   'Standard vCPU Idle Usage' / 'Standard Memory Idle Usage' - reduced idle rates
 *   'Standard Requests'            '1M'            $/million requests
 * Free grants per subscription per calendar month (Learn, "Billing in Azure Container Apps"):
 *   180,000 vCPU-seconds, 360,000 GiB-seconds, 2,000,000 HTTP requests.
 * These are NOT expressed in the API (all tierMinimumUnits are 0), so they are subtracted
 * explicitly. Default is the ACTIVE rate (upper bound); idle rates require a replica to be
 * running under 0.01 vCPU with no requests and <1000 B/s of traffic.
 */
async function priceContainerAppsConsumption({ region, apps = 1, vcpu, memGiB, replicas = 1, hours = HOURS_PER_MONTH, requests = 0, idle = false, currency = 'USD' }) {
  const r = arm(region);
  const filter = `serviceName eq 'Azure Container Apps' and armRegionName eq '${r}' and skuName eq 'Standard'`;
  const rows = dedupe(await query(filter, currency)).filter(x => x.type === 'Consumption');

  const kind = idle ? 'Idle' : 'Active';
  const cpuRow = pick(rows, x => x.meterName === `Standard vCPU ${kind} Usage`, `Container Apps vCPU ${kind} usage in ${region}`);
  const memRow = pick(rows, x => x.meterName === `Standard Memory ${kind} Usage`, `Container Apps memory ${kind} usage in ${region}`);
  const reqRow = pick(rows, x => x.meterName === 'Standard Requests', `Container Apps requests in ${region}`);

  const FREE_VCPU_S = 180000, FREE_GIB_S = 360000, FREE_REQ = 2000000;
  const seconds = hours * 3600;
  const vcpuSeconds = apps * replicas * vcpu * seconds;
  const gibSeconds = apps * replicas * memGiB * seconds;

  const billVcpu = Math.max(0, vcpuSeconds - FREE_VCPU_S);
  const billGib = Math.max(0, gibSeconds - FREE_GIB_S);
  const billReq = Math.max(0, requests - FREE_REQ);

  const lines = [
    line(`Container Apps vCPU ${kind.toLowerCase()} usage: ${vcpuSeconds.toLocaleString('en-US')} vCPU-s (first ${FREE_VCPU_S.toLocaleString('en-US')} free)`, cpuRow, billVcpu, `${apps} app(s) x ${replicas} replica(s) x ${vcpu} vCPU x ${hours} h x 3600 s = ${vcpuSeconds} vCPU-s; minus ${FREE_VCPU_S} free grant`, billVcpu * cpuRow.retailPrice),
    line(`Container Apps memory ${kind.toLowerCase()} usage: ${gibSeconds.toLocaleString('en-US')} GiB-s (first ${FREE_GIB_S.toLocaleString('en-US')} free)`, memRow, billGib, `${apps} app(s) x ${replicas} replica(s) x ${memGiB} GiB x ${hours} h x 3600 s = ${gibSeconds} GiB-s; minus ${FREE_GIB_S} free grant`, billGib * memRow.retailPrice),
  ];
  if (requests > 0) {
    const units = billReq / unitSize(reqRow.unitOfMeasure);
    lines.push(line(`Container Apps HTTP requests: ${requests.toLocaleString('en-US')} (first ${FREE_REQ.toLocaleString('en-US')} free)`, reqRow, units, `${requests} - ${FREE_REQ} free = ${billReq}; / ${unitSize(reqRow.unitOfMeasure)} per billing unit = ${units} units`, units * reqRow.retailPrice));
  }

  return {
    lines,
    monthlyList: totalOf(lines),
    notes: [
      'Free grants (180,000 vCPU-s, 360,000 GiB-s, 2M requests per subscription per calendar month) are NOT represented in the retail price API - all tierMinimumUnits are 0 - so they are subtracted explicitly per Learn "Billing in Azure Container Apps".',
      `Priced at the ${kind.toUpperCase()} rate. Idle rates only apply when a replica has started, is processing no HTTP requests, uses <0.01 vCPU and receives <1000 B/s; that cannot be assumed for a production microservice, so active is the correct (and conservative) estimate.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Azure Files
// ---------------------------------------------------------------------------

/**
 * priceAzureFiles({region, tier, redundancy, capacityGB, currency})
 * tier:
 *   'ProvisionedV2HDD' -> Azure Files Provisioned v2, HDD <red>. Bills provisioned storage
 *      (GiB/hour), provisioned IOPS (1/hour) and provisioned throughput MiB/s (1/hour).
 *      There is no free IOPS/throughput band for HDD in the API, so the default baseline
 *      from the Learn recommendation formulas is provisioned:
 *          IOPS       = MIN(MAX(1000 + CEILING(0.2  * GiB), 500), 50000)
 *          Throughput = MIN(MAX(60   + CEILING(0.02 * GiB), 60),  5120)  MiB/s
 *   'Hot'  -> pay-as-you-go 'Files v2' / '<Hot> <red>' data stored per GB/month
 *   'TransactionOptimized' -> pay-as-you-go 'Files v2' / 'Standard <red>' data stored
 */
async function priceAzureFiles({ region, tier = 'ProvisionedV2HDD', redundancy = 'LRS', capacityGB, currency = 'USD' }) {
  const r = arm(region);

  if (tier === 'ProvisionedV2HDD') {
    const filter = `serviceName eq 'Storage' and armRegionName eq '${r}' and productName eq 'Azure Files Provisioned v2' and skuName eq 'HDD ${q(redundancy)}'`;
    const rows = dedupe(await query(filter, currency)).filter(x => x.type === 'Consumption');
    const st = pick(rows, x => x.meterName === `HDD ${redundancy} Provisioned Storage`, `Files provisioned v2 HDD storage in ${region}`);
    const io = pick(rows, x => x.meterName === `HDD ${redundancy} Provisioned IOPS`, `Files provisioned v2 HDD IOPS in ${region}`);
    const tp = pick(rows, x => x.meterName === `HDD ${redundancy} Provisioned Throughput MiBPS`, `Files provisioned v2 HDD throughput in ${region}`);

    const baselineIops = Math.min(Math.max(1000 + Math.ceil(0.2 * capacityGB), 500), 50000);
    const baselineTput = Math.min(Math.max(60 + Math.ceil(0.02 * capacityGB), 60), 5120);

    const lines = [
      line(`Azure Files provisioned v2 HDD ${redundancy}: ${capacityGB} GiB provisioned storage`, st, capacityGB * HOURS_PER_MONTH, `${capacityGB} GiB x ${HOURS_PER_MONTH} h`, capacityGB * HOURS_PER_MONTH * st.retailPrice),
      line(`Azure Files provisioned v2 HDD ${redundancy}: ${baselineIops} provisioned IOPS (Learn default baseline)`, io, baselineIops * HOURS_PER_MONTH, `MIN(MAX(1000 + CEILING(0.2 x ${capacityGB}), 500), 50000) = ${baselineIops} IOPS x ${HOURS_PER_MONTH} h`, baselineIops * HOURS_PER_MONTH * io.retailPrice),
      line(`Azure Files provisioned v2 HDD ${redundancy}: ${baselineTput} MiB/s provisioned throughput (Learn default baseline)`, tp, baselineTput * HOURS_PER_MONTH, `MIN(MAX(60 + CEILING(0.02 x ${capacityGB}), 60), 5120) = ${baselineTput} MiB/s x ${HOURS_PER_MONTH} h`, baselineTput * HOURS_PER_MONTH * tp.retailPrice),
    ];
    return {
      lines,
      monthlyList: totalOf(lines),
      notes: [`Provisioned v2 HDD has no free IOPS/throughput band in the API (unlike SSD, which has explicit "... Free" meters), so the Learn recommendation-formula defaults are provisioned and billed: ${baselineIops} IOPS and ${baselineTput} MiB/s for ${capacityGB} GiB.`],
    };
  }

  const skuName = tier === 'TransactionOptimized' ? `Standard ${redundancy}` : `${tier} ${redundancy}`;
  const meter = tier === 'TransactionOptimized' ? `${redundancy} Data Stored` : `${tier} ${redundancy} Data Stored`;
  const filter = `serviceName eq 'Storage' and armRegionName eq '${r}' and productName eq 'Files v2' and skuName eq '${q(skuName)}'`;
  const rows = dedupe(await query(filter, currency)).filter(x => x.type === 'Consumption');
  const st = pick(rows, x => x.meterName === meter, `Azure Files ${skuName} data stored in ${region}`);
  const cost = capacityGB * st.retailPrice;
  const label = tier === 'TransactionOptimized' ? 'transaction optimized' : tier.toLowerCase();
  return {
    lines: [line(`Azure Files pay-as-you-go ${label} ${redundancy}: ${capacityGB} GB stored`, st, capacityGB, `${capacityGB} GB/month`, cost)],
    monthlyList: round2(cost),
    notes: ['Pay-as-you-go Azure Files bills data stored plus transactions; no transaction volume was supplied by the customer, so only the data-stored component is priced.'],
  };
}

module.exports = {
  HOURS_PER_MONTH, DAYS_PER_MONTH, arm, round2, unitSize, tiered, vcpuOf, OPENAI_MODELS,
  priceVm, priceRhelLicense, priceManagedDisk, pricePremiumV2, pricePublicIp, priceBandwidth,
  priceLoadBalancer, priceAksStandardTier, priceAppService, priceSqlDatabaseGP, priceSqlMiGP,
  priceFunctionsConsumption, priceBlob, priceOpenAiTokens, priceCosmosAutoscale,
  pricePostgresFlex, priceLogAnalytics, priceContainerAppsConsumption, priceAzureFiles,
};
