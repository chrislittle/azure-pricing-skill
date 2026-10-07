'use strict';
// Azure Data Explorer (Kusto) cluster, modelled as a whole: engine VMs + the Azure Data Explorer markup
// (per engine vCore-hour, not charged on dev/test clusters) + data management VMs + blob storage for the
// compressed data (+ premium SSD disks for the premium-storage engine sizes). Only the markup is an
// 'Azure Data Explorer' meter; the VMs are 'Virtual Machines' meters and the data is 'Storage'
// General Block Blob v2 (Hot). The sizing rules follow the Azure pricing calculator for Data Explorer.
const { rows, single, regionFilter, meterLine, line, meterInfo, query, dedupe, q, PricingError, fmtN, termMonths, HOURS } = require('../kit');
const { lifecycle, explain } = require('../lifecycle');

const n = v => Number(v || 0);
const G = 'Analytics', S = 'Azure Data Explorer';

// Engine sizes: key -> [armSkuName, vCPUs, hot cache GB per node, workload, premium P30 disks per node].
// Hot cache sizes are the calculator's and the pricing page's. Only Current and Extended VM series are listed.
const SKUS = {};
const armOf = key => 'Standard_' + key.replace(/^([a-z]+)(\d+)([a-z]*)-v(\d)(?:-\d+tb)?$/, (m, a, b, c, d) => `${a.toUpperCase()}${b}${c}_v${d}`);
const add = (key, vcpu, hot, workload, p30) => { SKUS[key] = [armOf(key), vcpu, hot, workload, p30 || 0]; };
[[2, 30], [4, 66], [8, 140], [16, 285]].forEach(([v, h]) => add(`e${v}a-v4`, v, h, 'compute'));
[[2, 55], [4, 116], [8, 240], [16, 485]].forEach(([v, h]) => {
  for (const f of [`e${v}d-v4`, `e${v}d-v5`, `e${v}ads-v5`, `ec${v}ads-v5`]) add(f, v, h, 'compute');
});
[2, 4, 8, 16].forEach(v => { add(`e${v}ads-v6`, v, 55, 'compute'); add(`d${v}ads-v6`, v, 976, 'compute'); add(`d${v}ds-v6`, v, 976, 'compute'); });
add('d32d-v4', 32, 976, 'compute'); add('d32d-v5', 32, 976, 'compute');
for (const fam of ['las-v3', 'ls-v3', 'las-v4', 'ls-v4']) {
  const [pre, ver] = fam.split('-');
  add(`${pre.replace('l', 'l8')}-${ver}`, 8, 1750, 'storage'); add(`${pre.replace('l', 'l16')}-${ver}`, 16, 3500, 'storage'); add(`${pre.replace('l', 'l32')}-${ver}`, 32, 7000, 'storage');
}
// Storage optimized with premium SSD (P30) data disks: 8 vCPU sizes take 1 or 2 disks, 16 vCPU sizes 3 or 4.
for (const [prefix, vers] of [['e', ['as-v4', 'as-v5', 'as-v6', 's-v4', 's-v5', 's-v6']], ['ec', ['as-v5']]]) {
  for (const f of vers) {
    const [suf, ver] = f.split('-');
    for (const d of [1, 2]) add(`${prefix}8${suf}-${ver}-${d}tb`, 8, d * 1024, 'storage', d);
    for (const d of [3, 4]) add(`${prefix}16${suf}-${ver}-${d}tb`, 16, d * 1024, 'storage', d);
  }
}
// Data management nodes are chosen by the service from the engine size; these are the sizes used.
const DM = { 'd2a-v4': ['Standard_D2a_v4', 2], 'd4a-v4': ['Standard_D4a_v4', 4], 'd8a-v4': ['Standard_D8a_v4', 8] };

// Auto-selection order (the calculator's): series of engine sizes, each smallest hot cache first.
const seriesOf = re => Object.keys(SKUS).filter(k => re.test(k)).sort((a, b) => SKUS[a][2] - SKUS[b][2]);
const COMPUTE_ORDER = [/^e\d+ads-v5$/, /^e\d+d-v5$/, /^e\d+d-v4$/, /^d32d-v5$/, /^d32d-v4$/, /^e\d+a-v4$/].map(seriesOf);
const COMPUTE_LAST = ['e16ads-v5', 'e16d-v5', 'e16d-v4', 'd32d-v5', 'd32d-v4', 'e16a-v4'];
const STORAGE_ORDER = [/^l\d+as-v3$/, /^l\d+s-v3$/, /^e\d+as-v5-\dtb$/, /^e\d+as-v4-\dtb$/, /^e\d+s-v5-\dtb$/, /^e\d+s-v4-\dtb$/].map(seriesOf);
const STORAGE_LAST = ['l32as-v3', 'l32s-v3', 'e16s-v5-4tb', 'e16s-v4-4tb'];
const DEV_ORDER = ['e2ads-v5', 'e2d-v5', 'e2d-v4', 'e2a-v4'];
const HOT_THRESHOLD_GB = 480;
const RECOVERABILITY_DAYS = 14, STORAGE_OVERHEAD = 1.3, OPS_PER_TB_DAY = 750000, DAYS = 30;

// The first series with a size whose hot cache fits in 3 nodes; otherwise the series' last-resort (largest) size.
function pick(order, lastResort, hotGB) {
  let d = '';
  for (const series of order) for (const k of series) {
    const last = lastResort.includes(k);
    if (d === '' && !last) { if (3 >= Math.max(2, hotGB / SKUS[k][2])) d = k; } else if (d === '' && last) d = k;
  }
  return d;
}

const label = k => {
  const m = /^([a-z]+)(\d+)([a-z]*)-v(\d)(?:-(\d)tb)?$/.exec(k);
  return m ? `${m[1].toUpperCase()}${m[2]}${m[3]} v${m[4]}${m[5] ? ` (${m[5]} TB premium SSD per server)` : ''}` : k.toUpperCase();
};
const env = c => (String(c.environment || 'production').toLowerCase());

// Refuse End of Life VM sizes with the lifecycle explanation, whether or not they are in the size list.
function checkLifecycle(arm, what) {
  const e = explain(arm);
  if (e) throw new PricingError(`${what} ${arm} cannot be priced. ${e}`);
}
function unknownSize(key, field, known) {
  const arm = armOf(String(key).toLowerCase());
  if (!lifecycle(arm).modern) checkLifecycle(arm, `The ${field}`);
  throw new PricingError(`Unknown ${field} "${key}". Use one of: ${known.join(', ')}.`);
}

function dmDefault(cores, dailyGB) {
  if (cores >= 16) return dailyGB > 10000 ? 'd8a-v4' : 'd4a-v4';
  return cores === 8 ? 'd4a-v4' : 'd2a-v4';
}

// Engine VM size and node count (sized from the hot cache when engineInstances is not given).
function size(c) {
  const dev = env(c) === 'dev';
  const workload = String(c.workload || 'auto').toLowerCase();
  let comp = n(c.compressionRatio ?? 7);
  if (!(comp >= 1)) comp = 7;
  const daily = n(c.dailyIngestionGB), retention = n(c.retentionDays ?? 365), hotDays = Math.min(n(c.hotCacheDays ?? 30), retention);
  const hotGB = daily / comp * hotDays;
  const storedGB = daily / comp * (retention + RECOVERABILITY_DAYS) * STORAGE_OVERHEAD;
  const minNodes = dev ? 1 : 2;
  let sku = c.engineSku ? String(c.engineSku).toLowerCase() : null, resolved = workload;
  if (!sku) {
    if (dev) sku = DEV_ORDER[0];
    else if (workload === 'compute') sku = pick(COMPUTE_ORDER, COMPUTE_LAST, hotGB);
    else if (workload === 'storage') sku = pick(STORAGE_ORDER, STORAGE_LAST, hotGB);
    else { resolved = hotGB < HOT_THRESHOLD_GB ? 'compute' : 'storage'; sku = resolved === 'compute' ? pick(COMPUTE_ORDER, COMPUTE_LAST, hotGB) : pick(STORAGE_ORDER, STORAGE_LAST, hotGB); }
  }
  const s = SKUS[sku];
  const auto = c.engineInstances == null || c.engineInstances === '';
  const engineNodes = auto ? (dev || !s ? minNodes : Math.max(minNodes, Math.ceil(hotGB / s[2]))) : n(c.engineInstances);
  const dmAuto = !c.dataManagementSku;
  const dmSku = dmAuto ? dmDefault(s ? s[1] : 8, daily) : String(c.dataManagementSku).toLowerCase();
  const dmNodes = c.dataManagementInstances == null || c.dataManagementInstances === '' ? minNodes : n(c.dataManagementInstances);
  return { dev, workload: s ? s[3] : resolved, sku, s, storedGB, hotGB, comp, auto, skuAuto: !c.engineSku, engineNodes, minNodes, dmSku, dmAuto, dmNodes };
}

// Pay-as-you-go, reservation and savings plan rows for one VM size in the region.
async function vmRates(arm, ctx) {
  const rs = (await rows(`serviceName eq 'Virtual Machines' and ${regionFilter(ctx)} and armSkuName eq '${q(arm)}'`, ctx))
    .filter(r => !/Spot|Low Priority/i.test(r.skuName + ' ' + r.meterName) && !/Windows$/i.test(r.productName) && !/Cloud ?Services/i.test(r.productName));
  return { base: rs.find(r => r.type === 'Consumption'), reservations: rs.filter(r => r.type === 'Reservation') };
}

// One VM line (engine or data management) under pay-as-you-go, a reservation (engine only) or a savings plan.
function vmLine(what, lbl, vcpu, count, hours, rates, commit, arm, ctx, notes) {
  const m = /^(ri|sp)(1|3)y$/.exec(commit);
  if (!m) {
    return line('Compute', 'Virtual Machines', `${what} servers: ${fmtN(count)} x ${lbl} (${vcpu} vCPU) x ${fmtN(hours)} hours`, count * hours, 'hours', rates.base.retailPrice, rates.base.retailPrice * count * hours, meterInfo(rates.base));
  }
  const term = m[2] === '1' ? '1 Year' : '3 Years';
  if (m[1] === 'ri') {
    const rr = rates.reservations.find(r => r.reservationTerm === term);
    if (!rr) throw new PricingError(`No ${term} reservation price for ${arm} in ${ctx.region}.`);
    const months = termMonths(term);
    notes.push(`${term} reservation: the whole-term price per VM divided by ${months} months; billed all month whether or not the cluster runs.`);
    return line('Compute', 'Virtual Machines', `${what} servers: ${fmtN(count)} x ${lbl} (${vcpu} vCPU), ${term} reservation`, count, 'VM / month', rr.retailPrice / months, rr.retailPrice / months * count, meterInfo(rr), { termTotal: rr.retailPrice });
  }
  const sp = (rates.base.savingsPlan || []).find(x => x.term === term);
  if (!sp) throw new PricingError(`No ${term} savings plan rate for ${arm} in ${ctx.region}.`);
  return line('Compute', 'Virtual Machines', `${what} servers: ${fmtN(count)} x ${lbl} (${vcpu} vCPU), ${term} savings plan rate`, HOURS * count, 'hours', sp.unitPrice, sp.unitPrice * HOURS * count, meterInfo(rates.base));
}

module.exports = {
  type: 'data-explorer',
  label: 'Azure Data Explorer',
  family: 'analytics',
  calculator: ['data-explorer'],
  keywords: ['data explorer', 'kusto', 'adx', 'log analytics store', 'time series', 'telemetry analytics', 'kql', 'fast analytics'],
  fields: {
    dailyIngestionGB: { req: true, min: 0, ask: 'How much new data will be loaded into the cluster each day, in GB, before compression (for example logs or telemetry)? If unknown, suggest 100 GB a day and record it as an assumption.' },
    environment: { def: 'production', enum: ['production', 'dev'], ask: 'Is this for production use or just for learning and testing? production = at least 2 engine servers, with an availability guarantee; dev = one small server, no availability guarantee and no Data Explorer service charge.' },
    retentionDays: { def: 365, min: 0, ask: 'For how many days must the data stay available to query? If unknown, suggest 365 and record it as an assumption.' },
    hotCacheDays: { def: 30, min: 0, ask: 'For how many of the most recent days must queries be fast (kept on the servers\' local disks, the hot cache)? Older data stays in cheaper storage and is slower. If unknown, suggest 30 and record it as an assumption.' },
    compressionRatio: { def: 7, min: 1, ask: 'How much does the data shrink when loaded (raw size divided by stored size)? The Azure pricing calculator assumes 7; use that and record it as an assumption if unknown. Structured logs often compress more.' },
    workload: { def: 'auto', enum: ['auto', 'compute', 'storage'], ask: 'Which matters more? Leave it as auto and the size is chosen like the Azure pricing calculator does: little hot data (under about 480 GB) -> compute optimized servers; more -> storage optimized servers, which hold more cached data per server at a lower cost per GB. Many queries per second over little recent data -> compute; fewer queries over a lot of cached data -> storage.' },
    engineSku: { def: null, enum: Object.keys(SKUS), ask: 'Only if they already know the engine server size, for example e8ads-v5 (8 cores, compute optimized), l8as-v3 (8 cores, local-SSD storage optimized) or e8as-v5-2tb (8 cores with 2 TB of premium SSD). Otherwise leave it out and the size is chosen from the hot cache (dev -> e2ads-v5).' },
    engineInstances: { def: null, int: true, min: 1, max: 1000, ask: 'Only if they already know how many engine servers they need. Otherwise leave it out: the number is worked out so the hot cache fits (never fewer than 2 for production, 1 for dev), and the result is shown as an assumption.' },
    dataManagementSku: { def: null, enum: Object.keys(DM), ask: 'Data management servers load the data and are chosen by the service from the engine size (2 or 4 engine vCPUs -> d2a-v4, 8 -> d4a-v4, 16 or more -> d4a-v4, or d8a-v4 above 10 TB a day). Leave it out unless you know the size.' },
    dataManagementInstances: { def: null, int: true, min: 1, max: 100, ask: 'Number of data management servers. Leave it out: the service uses 2 for production and 1 for dev.' },
    hours: { def: HOURS, min: 0, max: 744, ask: 'How many hours a month does the cluster run (730 = all month)? A stopped cluster stops billing for servers and the Data Explorer charge, but storage keeps billing.' },
    zoneRedundantStorage: { def: false, ask: 'Must the stored data survive the loss of one datacenter zone? Yes -> true (zone-redundant storage costs more); otherwise false.' },
    storageWriteOperations: { def: null, int: true, min: 0, ask: 'Only if known: how many storage write operations a month? Ingesting data creates them; small files create many. If unknown, leave it out and the estimate uses the calculator\'s figure (750,000 operations per TB loaded per day x 30). Use 0 to leave them out.' },
    storageReadOperations: { def: null, int: true, min: 0, ask: 'Only if known: how many storage read operations a month? If unknown, leave it out and the estimate uses the calculator\'s figure (750,000 per TB per day x 30). Use 0 to leave them out.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Will they commit to run the cluster for 1 or 3 years for a lower price? Reservation (ri1y, ri3y) covers the engine servers and the Data Explorer charge; savings plan (sp1y, sp3y, recommended by Microsoft for the servers) covers the engine and data management servers, and the Data Explorer charge stays pay-as-you-go. No commitment -> payg. Commitments are billed all month whether or not the cluster runs.' },
    markupCommitment: { def: null, enum: ['payg', 'ri1y', 'ri3y'], ask: 'Only if the Data Explorer charge should have a different commitment than the servers (a reservation on the charge applies to Data Explorer in every region). Leave it out and it follows commitment (reservations) or is pay-as-you-go (savings plans).' }
  },
  context: ['production', 'steadyUsage', 'zoneResilience'],
  examples: [
    { type: 'data-explorer', dailyIngestionGB: 50, environment: 'dev' },
    { type: 'data-explorer', dailyIngestionGB: 200, retentionDays: 180, hotCacheDays: 14, compressionRatio: 6, workload: 'compute', engineSku: 'e8ads-v5', engineInstances: 3 },
    { type: 'data-explorer', dailyIngestionGB: 1000, retentionDays: 365, hotCacheDays: 60, workload: 'storage', zoneRedundantStorage: true, hours: 600, storageWriteOperations: 20000000, storageReadOperations: 50000000 },
    { type: 'data-explorer', dailyIngestionGB: 500, commitment: 'sp1y' }
  ],
  readback: c => {
    const z = size(c);
    const hrs = n(c.hours ?? HOURS);
    const parts = [
      `${z.dev ? 'dev/test' : 'production'} cluster, ${hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month`}`,
      `${fmtN(n(c.dailyIngestionGB))} GB a day loaded (compression ${fmtN(z.comp)}x), kept ${fmtN(n(c.retentionDays ?? 365))} days, ${fmtN(n(c.hotCacheDays ?? 30))} days hot`,
      `${fmtN(z.engineNodes)} engine server(s) of ${z.s ? label(z.sku) : z.sku}${z.s ? ` (${z.s[1]} vCPU each)` : ''}${z.auto && !z.dev ? ' sized from the hot cache' : ''}`,
      `${fmtN(z.dmNodes)} data management server(s) of ${DM[z.dmSku] ? label(z.dmSku) : z.dmSku}`,
      `about ${fmtN(Math.round(z.storedGB))} GB stored (including 14 days of recoverability) on ${c.zoneRedundantStorage ? 'zone-redundant' : 'locally redundant'} storage`
    ];
    if (c.storageWriteOperations != null) parts.push(`${fmtN(n(c.storageWriteOperations))} storage write operations a month`);
    if (c.storageReadOperations != null) parts.push(`${fmtN(n(c.storageReadOperations))} storage read operations a month`);
    const cm = String(c.commitment || 'payg');
    if (cm !== 'payg') parts.push(`${cm.startsWith('sp') ? 'savings plan' : 'reservation'}, ${cm.endsWith('1y') ? '1' : '3'}-year`);
    return `Data Explorer: ${parts.join('; ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('adx-network') ? [] : ['Network traffic leaving the region (bandwidth), the sources that feed the cluster (Event Hubs, IoT Hub, Data Factory), and a support plan are priced separately.'],
  price: async (c, ctx) => {
    const z = size(c);
    const commit = String(c.commitment || 'payg').toLowerCase();
    const hours = n(c.hours ?? HOURS);
    const daily = n(c.dailyIngestionGB);
    if (!z.s) unknownSize(c.engineSku, 'engineSku', Object.keys(SKUS));
    if (!DM[z.dmSku]) unknownSize(c.dataManagementSku, 'dataManagementSku', Object.keys(DM));
    checkLifecycle(z.s[0], 'The engine size');
    checkLifecycle(DM[z.dmSku][0], 'The data management size');
    if (!['production', 'dev'].includes(env(c))) throw new PricingError('environment must be production or dev.');
    if (!['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'].includes(commit)) throw new PricingError('commitment must be payg, ri1y, ri3y, sp1y or sp3y.');
    const mc = String(c.markupCommitment || (commit.startsWith('ri') ? commit : 'payg')).toLowerCase();
    if (!['payg', 'ri1y', 'ri3y'].includes(mc)) throw new PricingError('markupCommitment must be payg, ri1y or ri3y.');
    if (daily < 0 || n(c.retentionDays ?? 365) < 0 || n(c.hotCacheDays ?? 30) < 0) throw new PricingError('Quantities cannot be negative.');
    if (c.compressionRatio != null && !(n(c.compressionRatio) >= 1)) throw new PricingError('compressionRatio must be at least 1 (raw size divided by stored size).');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (!Number.isInteger(z.engineNodes) || !Number.isInteger(z.dmNodes)) throw new PricingError('engineInstances and dataManagementInstances must be whole numbers.');
    if (z.engineNodes > 1000) throw new PricingError('A cluster is limited to 1,000 engine servers.');
    if (z.engineNodes < z.minNodes) throw new PricingError(`A ${z.dev ? 'dev' : 'production'} cluster needs at least ${z.minNodes} engine server(s).`);
    if (z.dev && (z.engineNodes > 1 || z.s[1] !== 2)) throw new PricingError(`A dev/test cluster is a single 2-vCPU engine server (for example ${DEV_ORDER.join(', ')}); use environment "production" for anything larger.`);
    if (z.dev && (commit !== 'payg' || mc !== 'payg')) throw new PricingError('Reservations and savings plans do not apply to dev/test clusters.');
    if (z.dmNodes < 1) throw new PricingError('A cluster needs at least 1 data management server.');
    const lines = [], notes = [];
    const vCores = z.engineNodes * z.s[1];

    // Engine VMs
    const eng = await vmRates(z.s[0], ctx);
    if (!eng.base) throw new PricingError(`${z.s[0]} has no price in ${ctx.region}; the engine size is not offered there. Choose another size or region.`);
    const lbl = label(z.sku);
    lines.push(vmLine('Engine', lbl, z.s[1], z.engineNodes, hours, eng, commit, z.s[0], ctx, notes));
    if (commit.startsWith('sp')) notes.push(`${commit === 'sp1y' ? '1-year' : '3-year'} savings plan: the commitment is billed every hour of the term (730 hours a month) whether or not the cluster runs.`);

    // Premium SSD data disks (premium-storage engine sizes only)
    if (z.s[4]) {
      const ds = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Premium SSD Managed Disks' and skuName eq 'P30 LRS' and priceType eq 'Consumption'`, ctx);
      const p30 = single(ds.filter(r => r.meterName === 'P30 LRS Disk'), 'Premium SSD P30 disk');
      const disks = z.s[4] * z.engineNodes;
      const frac = commit === 'payg' ? hours / HOURS : 1;
      lines.push(meterLine('Storage', 'Storage', `Premium SSD P30 disks: ${fmtN(z.s[4])} per server x ${fmtN(z.engineNodes)} server(s)`, p30, disks * frac, ctx, { unit: 'disk-months' }));
    }

    // Azure Data Explorer markup (engine vCores only, never on dev)
    if (!z.dev) {
      const mk = await rows(`serviceName eq 'Azure Data Explorer' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
      if (!mk.length) throw new PricingError(`Azure Data Explorer is not priced in ${ctx.region}.`);
      const m = single(mk.filter(r => r.meterName === 'Standard Engine Cluster Markup'), 'Data Explorer engine markup');
      if (mc === 'payg') {
        lines.push(meterLine(G, S, `Data Explorer markup, ${fmtN(vCores)} engine vCores x ${fmtN(hours)} hours`, m, vCores * hours, ctx, { unit: 'vCore hours' }));
      } else {
        // The reservation is listed under one region only but applies to Data Explorer in every region.
        const term = mc === 'ri1y' ? '1 Year' : '3 Years', months = termMonths(term);
        const rr = (await rows(`serviceName eq 'Azure Data Explorer' and priceType eq 'Reservation'`, ctx)).find(r => r.reservationTerm === term);
        if (!rr) throw new PricingError(`The Retail Prices API has no ${term} Data Explorer markup reservation price. Use payg for the markup.`);
        lines.push(line(G, S, `Data Explorer markup, ${fmtN(vCores)} engine vCores, ${term} reservation`, vCores, 'vCore / month', rr.retailPrice / months, rr.retailPrice / months * vCores, meterInfo(rr), { termTotal: rr.retailPrice }));
        notes.push(`The Data Explorer markup reservation is priced per vCore for the whole ${term} term, divided by ${months} months. Microsoft says a Data Explorer reservation applies to all deployments in all regions, so the same price is used in ${ctx.region}.`);
      }
      notes.push('The Data Explorer markup is charged per engine vCore-hour; it is not charged for data management servers or dev/test clusters.');
    } else notes.push('A dev/test cluster has no Data Explorer markup and no availability guarantee (SLA).');

    // Data management VMs (size follows the engine size; reservations are not applied, savings plans are)
    const [dmArm, dmCores] = DM[z.dmSku];
    const dm = await vmRates(dmArm, ctx);
    if (!dm.base) throw new PricingError(`${dmArm} has no price in ${ctx.region}; choose another dataManagementSku.`);
    lines.push(vmLine('Data management', label(z.dmSku), dmCores, z.dmNodes, hours, dm, commit.startsWith('sp') ? commit : 'payg', dmArm, ctx, notes));
    notes.push(`The service chooses the data management servers from the engine size (Da_v4 series when available); ${label(z.dmSku)} x ${z.dmNodes} ${z.dmAuto ? 'follows the calculator\'s rule for the engine size' : 'was given'}. They are billed as VMs with no Data Explorer markup${commit.startsWith('ri') ? ', and no reservation is applied to them here' : ''}.`);

    // Storage: compressed data, hot LRS/ZRS blob (always 730 hours, even if the cluster is stopped)
    const red = c.zoneRedundantStorage ? 'ZRS' : 'LRS';
    const st = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'General Block Blob v2' and skuName eq 'Hot ${red}' and priceType eq 'Consumption'`, ctx);
    if (!st.length) throw new PricingError(`Hot ${red} blob storage is not priced in ${ctx.region}.`);
    const gb = Math.round(z.storedGB * 100) / 100;
    lines.push(meterLine('Storage', 'Storage', `Stored data (compressed), ${fmtN(Math.round(gb))} GB on hot ${red} storage${st.filter(r => r.meterName === `Hot ${red} Data Stored`).length > 1 ? ' (graduated)' : ''}`, single(st.filter(r => r.meterName === `Hot ${red} Data Stored`), `Hot ${red} data stored`), gb, ctx, { unit: 'GB / month' }));
    const estOps = daily / 1000 * OPS_PER_TB_DAY * DAYS;
    const writeOps = c.storageWriteOperations == null || c.storageWriteOperations === '' ? estOps : n(c.storageWriteOperations);
    const readOps = c.storageReadOperations == null || c.storageReadOperations === '' ? estOps : n(c.storageReadOperations);
    const ops = async (qty, re, what) => {
      if (!qty) return;
      const raw = dedupe((await query(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'General Block Blob v2' and skuName eq 'Hot ${red}' and priceType eq 'Consumption'`, ctx.currency)).filter(r => re.test(r.meterName)));
      lines.push(meterLine('Storage', 'Storage', `Storage ${what} operations, ${fmtN(Math.round(qty))}/month`, single(raw, `Hot ${red} ${what} operations`), qty, ctx, { unit: 'operations' }));
    };
    await ops(writeOps, /Write Operations$/, 'write');
    await ops(readOps, /Read Operations$/, 'read');
    if (c.storageWriteOperations == null || c.storageReadOperations == null) notes.push(`Storage operations not given were estimated like the Azure pricing calculator: ${fmtN(Math.round(estOps))} a month (750,000 per TB loaded per day x 30) for each of reads and writes.`);
    notes.push(`Stored data is estimated like the Azure pricing calculator: daily loading / compression x (retention days + ${RECOVERABILITY_DAYS} days of recoverability) x ${STORAGE_OVERHEAD} (${fmtN(daily)} / ${fmtN(z.comp)} x (${fmtN(n(c.retentionDays ?? 365))} + ${RECOVERABILITY_DAYS}) x ${STORAGE_OVERHEAD} = ${fmtN(Math.round(z.storedGB))} GB), billed all month even when the cluster is stopped.`);
    if (z.auto && !z.dev) notes.push(`The ${fmtN(z.engineNodes)} engine server(s) ${z.skuAuto ? `(${lbl}, ${z.workload} optimized, chosen from the ${fmtN(Math.round(z.hotGB))} GB hot cache like the Azure pricing calculator)` : ''} were sized so the ${fmtN(Math.round(z.hotGB))} GB hot cache fits in the listed cache of ${fmtN(z.s[2])} GB each (minimum ${z.minNodes}); Azure reserves part of that disk, so check the size in the portal's SKU picker.`);
    if (z.dev && z.hotGB > z.s[2]) notes.push(`The ${fmtN(Math.round(z.hotGB))} GB hot cache is more than the ${fmtN(z.s[2])} GB cache of the single dev/test server; older hot data would be served from storage.`);
    return { lines, notes, facts: { environment: env(c), workload: z.workload, engineSku: z.sku, engineNodes: z.engineNodes, engineVCores: vCores, dataManagementNodes: z.dmNodes, storedGB: gb, hotCacheGB: Math.round(z.hotGB), retentionDays: n(c.retentionDays ?? 365), hours, commitment: commit, markupCommitment: mc, zoneRedundantStorage: !!c.zoneRedundantStorage, autoSized: z.auto } };
  }
};
