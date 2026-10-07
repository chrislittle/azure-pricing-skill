'use strict';
// Microsoft Fabric: F-SKU capacity (pay-as-you-go per CU-hour, or 1/3-year reservation per CU), Spark
// autoscale billing, capacity overage, and OneLake storage (hot / cool / cold, their disaster-recovery
// copies, Eventhouse cache, SQL database storage and backups).
// Meters: serviceName 'Microsoft Fabric', regional. Every workload "Capacity Usage" meter carries the same
// per-CU-hour price, so capacity is priced on one of them; F SKU number = number of CUs.
const { rows, single, regionFilter, meterLine, line, meterInfo, termMonths, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const CUS = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];

module.exports = {
  type: 'fabric',
  label: 'Microsoft Fabric',
  family: 'analytics',
  calculator: ['microsoft-fabric'],
  keywords: ['fabric', 'lakehouse', 'onelake', 'data warehouse', 'power bi capacity', 'analytics platform', 'data engineering', 'f sku', 'eventhouse', 'sql database in fabric'],
  fields: {
    capacityUnits: { req: true, int: true, enum: CUS, ask: 'How big a Fabric capacity? The F number is the size: F2 = 2, F8 = 8, F64 = 64 and so on (2 up to 8192, doubling each step). F64 is the smallest where report viewers do not need their own Power BI licence. The Fabric capacity estimator on the Fabric pricing page can size it from the workloads; if unknown, suggest 64 for a team and record it as an assumption.' },
    hours: { def: 730, ask: 'How many hours a month will the capacity be running (not paused)? 730 = all month. Pausing stops pay-as-you-go capacity billing but not OneLake storage, and does not lower the cost of a reservation.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Pay-as-you-go, or compare a 1- or 3-year reservation of the capacity? Only worth it if it runs all month. ri1y = 1-year, ri3y = 3-year.' },
    oneLakeGB: { def: 0, ask: 'How many GB of data are stored in OneLake and read regularly (hot storage)? Always ask this one.' },
    oneLakeCoolGB: { def: 0, ask: 'How many GB of OneLake data are rarely read, a few times a month at most (cool storage)? 0 if none.' },
    oneLakeColdGB: { def: 0, ask: 'How many GB of OneLake data are almost never read (cold storage)? 0 if none.' },
    oneLakeCacheGB: { def: 0, ask: 'Only if they use Eventhouse / KQL databases (Real-Time Intelligence) or Activator: how many GB are kept in the hot cache? 0 if none.' },
    oneLakeBcdrGB: { def: 0, ask: 'How many GB of hot OneLake data have a business-continuity / disaster-recovery copy kept in another region? 0 if none.' },
    oneLakeBcdrCoolGB: { def: 0, ask: 'How many GB of cool OneLake data have a disaster-recovery copy? 0 if none.' },
    oneLakeBcdrColdGB: { def: 0, ask: 'How many GB of cold OneLake data have a disaster-recovery copy? 0 if none.' },
    sqlDatabaseGB: { def: 0, ask: 'Only if they use SQL database in Fabric: how many GB of database storage? 0 if none.' },
    sqlBackupGB: { def: 0, ask: 'Only if they use SQL database in Fabric: how many GB of backup storage? 0 if unknown.' },
    overageCuHours: { def: 0, ask: 'Only if capacity overage is switched on (usage above the purchased capacity is billed instead of throttled): how many CU-hours a month above the capacity? 0 if none.' },
    sparkAutoscaleCuHours: { def: 0, ask: 'Only if they use Spark autoscale billing (serverless Spark billed separately from the capacity): how many CU-hours a month? One CU is two Spark vCores, so vCore-hours / 2. 0 if none.' }
  },
  context: ['production', 'steadyUsage', 'idlePeriods'],
  examples: [
    { type: 'fabric', capacityUnits: 64 },
    {
      type: 'fabric', capacityUnits: 128, hours: 500, oneLakeGB: 5000, oneLakeCoolGB: 20000, oneLakeColdGB: 50000, oneLakeCacheGB: 200,
      oneLakeBcdrGB: 1000, oneLakeBcdrCoolGB: 4000, oneLakeBcdrColdGB: 10000, sqlDatabaseGB: 300, sqlBackupGB: 600, overageCuHours: 100, sparkAutoscaleCuHours: 1500
    },
    { type: 'fabric', capacityUnits: 64, commitment: 'ri1y', oneLakeGB: 2000 }
  ],
  readback: c => {
    const commit = c.commitment || 'payg';
    const parts = [`Fabric capacity F${fmtN(n(c.capacityUnits))} (${fmtN(n(c.capacityUnits))} capacity units), ${commit === 'payg' ? `pay-as-you-go, running ${fmtN(c.hours ?? HOURS)} hours a month` : `${commit === 'ri1y' ? '1-year' : '3-year'} reservation, billed every hour of the term`}`];
    if (n(c.oneLakeGB)) parts.push(`${fmtN(c.oneLakeGB)} GB hot OneLake storage`);
    if (n(c.oneLakeCoolGB)) parts.push(`${fmtN(c.oneLakeCoolGB)} GB cool OneLake storage`);
    if (n(c.oneLakeColdGB)) parts.push(`${fmtN(c.oneLakeColdGB)} GB cold OneLake storage`);
    if (n(c.oneLakeCacheGB)) parts.push(`${fmtN(c.oneLakeCacheGB)} GB OneLake cache (Eventhouse/KQL, Activator)`);
    if (n(c.oneLakeBcdrGB)) parts.push(`${fmtN(c.oneLakeBcdrGB)} GB hot OneLake disaster-recovery copy`);
    if (n(c.oneLakeBcdrCoolGB)) parts.push(`${fmtN(c.oneLakeBcdrCoolGB)} GB cool OneLake disaster-recovery copy`);
    if (n(c.oneLakeBcdrColdGB)) parts.push(`${fmtN(c.oneLakeBcdrColdGB)} GB cold OneLake disaster-recovery copy`);
    if (n(c.sqlDatabaseGB)) parts.push(`${fmtN(c.sqlDatabaseGB)} GB SQL database storage`);
    if (n(c.sqlBackupGB)) parts.push(`${fmtN(c.sqlBackupGB)} GB SQL backup storage`);
    if (n(c.overageCuHours)) parts.push(`${fmtN(c.overageCuHours)} capacity overage CU-hours`);
    if (n(c.sparkAutoscaleCuHours)) parts.push(`${fmtN(c.sparkAutoscaleCuHours)} Spark autoscale CU-hours`);
    return parts.join('; ');
  },
  notIncluded: (types, spec) => {
    const ex = (spec && spec.excluded) || [];
    const out = [];
    if (!ex.some(e => /power bi|licen[sc]e/i.test(String(e)))) out.push('Power BI licences (Pro or Premium Per User) for people who create content, and for viewers on capacities smaller than F64, are per user and are not in this estimate.');
    if (!ex.some(e => /mirror|cosmos|on-demand/i.test(String(e)))) out.push('Mirroring storage above the free allowance (1 TB per capacity unit, lost while the capacity is paused), Cosmos DB in Fabric storage, backup and restore, and the per-workload on-demand meters are not priced.');
    return out;
  },
  price: async (c, ctx) => {
    const commit = c.commitment || 'payg';
    if (!['payg', 'ri1y', 'ri3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y or ri3y.`);
    const cu = n(c.capacityUnits);
    if (!CUS.includes(cu)) throw new PricingError(`capacityUnits must be one of ${CUS.join(', ')} (the F SKU number).`);
    const rs = await rows(`serviceName eq 'Microsoft Fabric' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Microsoft Fabric is not priced in ${ctx.region}.`);
    const G = 'Analytics', S = 'Microsoft Fabric';
    const lines = [], notes = [];
    const hours = c.hours ?? HOURS;
    const facts = { capacityUnits: cu, commitment: commit, hours, oneLakeGB: n(c.oneLakeGB) + n(c.oneLakeCoolGB) + n(c.oneLakeColdGB) };

    // All workload capacity meters share the base per-CU-hour price; a few regions lack the Power BI one.
    const cuMeter = () => {
      let m = rs.filter(r => r.productName === 'Fabric Capacity' && r.meterName === 'Power BI Capacity Usage CU');
      if (m.length) return single(m, `Fabric capacity CU-hours in ${ctx.region}`);
      const base = rs.filter(r => r.productName === 'Fabric Capacity' && /Capacity Usage CU$/.test(r.meterName) && !/On-Demand|Overage|autoscale/i.test(r.meterName));
      if (!base.length) throw new PricingError(`Fabric capacity prices are not published for ${ctx.region}.`);
      const freq = new Map();
      for (const r of base) freq.set(r.retailPrice, (freq.get(r.retailPrice) || 0) + 1);
      const modal = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return [base.find(r => r.retailPrice === modal)];
    };

    if (commit === 'payg') {
      lines.push(meterLine(G, S, `Fabric capacity F${fmtN(cu)}: ${fmtN(cu)} capacity units x ${fmtN(hours)} hours`, cuMeter(), cu * hours, ctx, { unit: 'CU-hours' }));
      notes.push('Fabric capacity is billed per capacity-unit hour while it runs; the F number is the number of capacity units. All workloads (warehouse, Spark, Power BI, pipelines) share the one capacity at the same CU-hour price. Pausing stops capacity charges; OneLake storage keeps billing.');
    } else {
      const term = commit === 'ri1y' ? '1 Year' : '3 Years';
      const rr = (await rows(`serviceName eq 'Microsoft Fabric' and ${regionFilter(ctx)} and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx))[0];
      if (!rr) throw new PricingError(`No ${term} Fabric capacity reservation price in ${ctx.region}.`);
      const months = termMonths(term), monthly = rr.retailPrice / months;
      lines.push(line(G, S, `Fabric capacity F${fmtN(cu)}: ${term} reservation of ${fmtN(cu)} capacity units`, cu, 'CU / month', monthly, monthly * cu, meterInfo(rr), { termTotal: rr.retailPrice }));
      notes.push(`${term} reservation: ${rr.retailPrice} is the whole-term price per capacity unit, divided by ${months} months. It is billed every hour whether or not the capacity is paused, and covers capacity compute only; OneLake storage is billed separately at pay-as-you-go rates.`);
      if (hours < HOURS) facts.commitmentUnderused = true;
    }

    const prod = (product, name, gb, label, group) => {
      if (!n(gb)) return;
      const re = new RegExp(`^${name}$`, 'i');
      lines.push(meterLine(group || 'Storage', S, `${label}, ${fmtN(gb)} GB`, single(rs.filter(r => r.productName === product && re.test(r.meterName)), label), n(gb), ctx, { unit: 'GB / month' }));
    };
    const store = (gb, name, label) => prod('OneLake', name, gb, `OneLake ${label}`);
    store(c.oneLakeGB, 'OneLake Storage Hot Data Stored', 'hot storage');
    store(c.oneLakeCoolGB, 'OneLake Storage Cool Data Stored', 'cool storage');
    store(c.oneLakeColdGB, 'OneLake Storage Cold Data Stored', 'cold storage');
    store(c.oneLakeCacheGB, 'OneLake Cache Data Stored', 'cache (Eventhouse/KQL hot cache, Activator)');
    store(c.oneLakeBcdrGB, 'OneLake BCDR Storage Hot Data Stored', 'disaster-recovery copy (hot)');
    store(c.oneLakeBcdrCoolGB, 'OneLake BCDR Storage Cool Data Stored', 'disaster-recovery copy (cool)');
    store(c.oneLakeBcdrColdGB, 'OneLake BCDR Storage Cold Data Stored', 'disaster-recovery copy (cold)');
    store(c.sqlDatabaseGB, 'SQL Storage Data Stored', 'SQL database storage');
    store(c.sqlBackupGB, 'SQL Backup Storage Data Stored', 'SQL backup storage');
    if (n(c.sparkAutoscaleCuHours)) {
      lines.push(meterLine(G, S, `Spark autoscale billing, ${fmtN(c.sparkAutoscaleCuHours)} CU-hours`, single(rs.filter(r => r.productName === 'Fabric Capacity' && r.meterName === 'autoscale for Spark Capacity Usage CU'), 'Spark autoscale billing'), n(c.sparkAutoscaleCuHours), ctx, { unit: 'CU-hours' }));
      notes.push('Spark autoscale billing is pay-as-you-go and does not use the purchased capacity or its reservation.');
    }
    if (n(c.overageCuHours)) {
      lines.push(meterLine(G, S, `Capacity overage, ${fmtN(c.overageCuHours)} CU-hours`, single(rs.filter(r => r.productName === 'Fabric Capacity' && r.meterName === 'Capacity Overage Capacity Usage CU'), 'capacity overage'), n(c.overageCuHours), ctx, { unit: 'CU-hours' }));
      notes.push('Capacity overage is billed at three times the pay-as-you-go CU-hour rate and is not discounted by a reservation.');
    }
    if (lines.length > 1) notes.push('OneLake storage is billed per GB and does not consume capacity units. Mirrored data up to 1 TB per capacity unit is free and is not included here.');
    return { lines, notes, facts };
  }
};
