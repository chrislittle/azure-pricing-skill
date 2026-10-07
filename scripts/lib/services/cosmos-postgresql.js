'use strict';
// Azure Cosmos DB for PostgreSQL clusters (Citus). Retail serviceName 'Azure Database for PostgreSQL', products
// 'Azure Cosmos DB for PostgreSQL Compute- Coordinator Node | Worker Node | Burstable' (per vCore-hour; burstable is per node-hour)
// and 'Azure Cosmos DB for PostgreSQL General Purpose Storage' (per GiB-month per node). Reservations are whole-term per vCore.
// The product is on a retirement path; the rules file warns about that.
const { rows, single, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const SVC = "serviceName eq 'Azure Database for PostgreSQL'";
const COORD = 'Azure Cosmos DB for PostgreSQL Compute- Coordinator Node', WORKER = 'Azure Cosmos DB for PostgreSQL Compute- Worker Node', BURST = 'Azure Cosmos DB for PostgreSQL Compute- Burstable';
const STORAGE = 'Azure Cosmos DB for PostgreSQL General Purpose Storage';

// Published compute and storage choices (Learn: Azure Cosmos DB for PostgreSQL compute and storage).
const COORD_VCORES = [4, 8, 16, 32, 64, 96], WORKER_VCORES = [4, 8, 16, 32, 64, 96, 104], SINGLE_VCORES = [2, 4, 8, 16, 32, 64], BURST_VCORES = [1, 2];
const COORD_GIB = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768], WORKER_GIB = COORD_GIB.filter(g => g >= 512);
const SINGLE_GIB = [128, 256, 512, 1024, 2048], BURST_GIB = [32, 64, 128];

const list = a => a.map(fmtN).join(', ');

module.exports = {
  type: 'cosmos-postgresql',
  label: 'Azure Cosmos DB for PostgreSQL cluster',
  family: 'databases',
  calculator: ['cosmos-db'],
  keywords: ['cosmos db for postgresql', 'cosmos postgresql', 'citus', 'hyperscale citus', 'distributed postgres', 'sharded postgres', 'postgres coordinator worker', 'multi-tenant postgres', 'scale out postgresql'],
  fields: {
    layout: { def: 'multi-node', enum: ['multi-node', 'single-node', 'burstable'], ask: 'Is this a distributed (scale-out) cluster with a coordinator and several worker nodes (multi-node), a single server with room to grow later (single-node), or a small low-cost dev/test server (burstable, 1 or 2 vCores)? If unknown, assume multi-node for production and burstable for dev/test, and record it as an assumption.' },
    vcores: { req: true, int: true, min: 1, ask: 'How many vCores per node? For multi-node this is the coordinator size (4, 8, 16, 32, 64 or 96); single-node allows 2 to 64; burstable 1 or 2. If they cannot say, suggest 4 and record it as an assumption.' },
    workers: { def: 2, int: true, min: 2, ask: 'Multi-node only: how many worker nodes (2 or more; clusters can scale out to hundreds)? Workers hold and process the distributed data. If unknown, suggest 2 and record it as an assumption.' },
    workerVcores: { def: 0, int: true, min: 0, ask: 'Multi-node only: how many vCores per worker node (4, 8, 16, 32, 64, 96 or 104)? Use 0 to match the coordinator size.' },
    storageGib: { def: 128, min: 1, ask: 'How much storage in GiB per node for the coordinator, or for the single/burstable node? Sizes: 128, 256, 512, 1024, ... up to 32768 for multi-node; burstable 32, 64, 128. If unknown, assume 128 and record it as an assumption.' },
    workerStorageGib: { def: 512, min: 1, ask: 'Multi-node only: how much storage in GiB on each worker node (512, 1024, 2048 ... 32768)? Size it from the total data volume divided by the worker count, with headroom.' },
    ha: { def: false, bool: true, ask: 'Does the cluster need high availability? That adds a standby copy of every node (and its storage) in another availability zone, so compute and storage cost about double.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y'], ask: 'Will the cluster run steadily for a year or more? Pay-as-you-go is the default; a 1- or 3-year reservation (ri1y, ri3y) or a 1-year Azure savings plan for databases (sp1y, an hourly spend commitment) applies to multi-node and single-node compute (regular, not burstable).' },
    hours: { def: 730, ask: 'Does the cluster run all month (730 hours) or only part of it? It bills for every hour it exists.' }
  },
  context: ['production', 'steadyUsage'],
  examples: [
    { type: 'cosmos-postgresql', vcores: 4, workers: 2, workerVcores: 8, storageGib: 128, workerStorageGib: 512 },
    { type: 'cosmos-postgresql', vcores: 8, workers: 4, workerVcores: 16, storageGib: 256, workerStorageGib: 1024, ha: true, commitment: 'ri1y' },
    { type: 'cosmos-postgresql', layout: 'single-node', vcores: 8, storageGib: 1024 },
    { type: 'cosmos-postgresql', layout: 'burstable', vcores: 2, storageGib: 64, hours: 400 }
  ],
  readback: c => {
    const layout = c.layout || 'multi-node', hrs = c.hours ?? HOURS;
    const when = hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month`;
    const tail = `${c.ha ? ', with high availability (standby nodes)' : ''}${c.commitment && c.commitment !== 'payg' ? `, ${c.commitment.endsWith('1y') ? '1-year' : '3-year'} ${c.commitment.startsWith('sp') ? 'savings plan' : 'reservation'}` : ''}, ${when}`;
    if (layout === 'multi-node') return `Azure Cosmos DB for PostgreSQL multi-node cluster: coordinator ${fmtN(c.vcores)} vCores with ${fmtN(c.storageGib ?? 128)} GiB, plus ${fmtN(c.workers ?? 2)} worker(s) of ${fmtN(c.workerVcores || c.vcores)} vCores with ${fmtN(c.workerStorageGib ?? 512)} GiB each${tail}`;
    return `Azure Cosmos DB for PostgreSQL ${layout} cluster, ${fmtN(c.vcores)} vCore(s), ${fmtN(c.storageGib ?? 128)} GiB${tail}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Backup storage above 100% of provisioned storage (zero in the Retail Prices API, but the pricing page lists a charge from December 2025), cross-region backup restore, read replicas, and data transfer are not in this estimate.'],
  price: async (c, ctx) => {
    const layout = String(c.layout || 'multi-node').toLowerCase();
    if (!['multi-node', 'single-node', 'burstable'].includes(layout)) throw new PricingError(`Unknown layout "${c.layout}". Use multi-node, single-node or burstable.`);
    const hours = c.hours ?? HOURS, v = n(c.vcores), ha = !!c.ha, commit = String(c.commitment || 'payg').toLowerCase();
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (!['payg', 'ri1y', 'ri3y', 'sp1y'].includes(commit)) throw new PricingError(`Unknown commitment "${c.commitment}". Use payg, ri1y, ri3y or sp1y.`);
    const gib = n(c.storageGib ?? 128), copies = ha ? 2 : 1;
    const multi = layout === 'multi-node', burst = layout === 'burstable';
    const vOk = multi ? COORD_VCORES : burst ? BURST_VCORES : SINGLE_VCORES;
    if (!vOk.includes(v)) throw new PricingError(`${layout} clusters allow ${list(vOk)} vCores; ${v} is not offered.`);
    const sOk = multi ? COORD_GIB : burst ? BURST_GIB : SINGLE_GIB;
    if (!sOk.includes(gib)) throw new PricingError(`${layout} nodes allow ${list(sOk)} GiB of storage; ${gib} is not offered.`);
    if (layout === 'single-node' && gib >= 1024 && v < 8) throw new PricingError('1,024 and 2,048 GiB single-node storage need 8 vCores or more.');
    if (commit !== 'payg' && burst) throw new PricingError('Reservations and savings plans are not offered here for burstable compute; use commitment payg, or choose single-node regular compute.');
    if (ha && burst) throw new PricingError('Burstable clusters do not support high availability; set ha to false.');
    const sp = commit === 'sp1y';
    const tag = commit === 'payg' ? '' : sp ? ', 1-year savings plan' : `, ${commit === 'ri1y' ? '1-year' : '3-year'} reserved capacity`, term = commit === 'ri3y' ? '3 Years' : '1 Year', months = commit === 'ri3y' ? 36 : 12;
    const haTag = ha ? ' x 2 (primary + standby)' : '';
    const lines = [], notes = [];
    const compute = async (product, vc, nodes, what) => {
      const rs = await rows(`${SVC} and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
      const m = rs.find(r => /^(1 )?vCore$/.test(r.skuName) && r.meterName === 'vCore');
      if (!m) throw new PricingError(`Azure Cosmos DB for PostgreSQL ${what} compute is not offered in ${ctx.region}; try a nearby region where the service is available.`);
      const qty = vc * nodes * copies;
      if (sp) {
        const p = (m.savingsPlan || []).find(x => x.term === '1 Year');
        if (!p) throw new PricingError(`${what} has no 1-year savings plan price in ${ctx.region}; use payg or a reservation (ri1y, ri3y).`);
        return lines.push(line('Database', 'Cosmos DB for PostgreSQL', `${what}, ${fmtN(vc)} vCores x ${fmtN(nodes)} node(s)${haTag}, ${fmtN(hours)} hours${tag}`, qty * hours, 'vCore-hours', p.unitPrice, p.unitPrice * qty * hours, meterInfo(m)));
      }
      if (commit === 'payg') return lines.push(line('Database', 'Cosmos DB for PostgreSQL', `${what}, ${fmtN(vc)} vCores x ${fmtN(nodes)} node(s)${haTag}, ${fmtN(hours)} hours`, qty * hours, 'vCore-hours', m.retailPrice, m.retailPrice * qty * hours, meterInfo(m)));
      const rr = await rows(`${SVC} and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx);
      const r = rr.find(x => /^(1 )?vCore$/.test(x.skuName));
      if (!r) throw new PricingError(`${what} has no ${term} reservation price in ${ctx.region}.`);
      lines.push(line('Database', 'Cosmos DB for PostgreSQL', `${what}, ${fmtN(vc)} vCores x ${fmtN(nodes)} node(s)${haTag}${tag}`, qty * months, 'vCore-months', r.retailPrice / months, r.retailPrice * qty / months, meterInfo(r), { unitLabel: 'per vCore-month' }));
    };
    let storageNodes = 1, workers = 0, wv = 0, wg = 0;
    if (burst) {
      const rs = await rows(`${SVC} and ${regionFilter(ctx)} and productName eq '${BURST}' and skuName eq '${v} vCore' and priceType eq 'Consumption'`, ctx);
      if (!rs.length) throw new PricingError(`Burstable compute is not priced in ${ctx.region}.`);
      const m = single(rs, 'Burstable compute');
      lines.push(meterLine('Database', 'Cosmos DB for PostgreSQL', `Burstable node, ${v} vCore, ${fmtN(hours)} hours`, m, hours, ctx, { unit: 'node-hours' }));
      notes.push('The burstable meters are a price per node-hour for the 1- or 2-vCore size, not per vCore.');
    } else if (multi) {
      workers = n(c.workers ?? 2); wv = n(c.workerVcores) || v; wg = n(c.workerStorageGib ?? 512);
      if (workers < 2) throw new PricingError('workers must be at least 2.');
      if (workers > 20) notes.push(`${fmtN(workers)} worker nodes is above the 20 the pricing tables list; the same per-node price is used, but check the cluster size limits with Microsoft.`);
      if (!WORKER_VCORES.includes(wv)) throw new PricingError(`Worker nodes allow ${list(WORKER_VCORES)} vCores; ${wv} is not offered.`);
      if (!WORKER_GIB.includes(wg)) throw new PricingError(`Worker nodes allow ${list(WORKER_GIB)} GiB of storage; ${wg} is not offered.`);
      await compute(COORD, v, 1, 'Coordinator node');
      await compute(WORKER, wv, workers, 'Worker nodes');
      storageNodes = 1;
    } else {
      await compute(COORD, v, 1, 'Single-node compute');
      notes.push('Single-node clusters are priced at the coordinator node rate' + (commit === 'payg' ? '.' : ', and reservations use the coordinator reserved vCore rate (Learn: reserve single nodes by selecting coordinator vCores).'));
    }
    const srs = await rows(`${SVC} and ${regionFilter(ctx)} and productName eq '${STORAGE}' and priceType eq 'Consumption'`, ctx);
    const st = single(srs.filter(r => r.meterName === 'General Purpose Data Stored'), 'Cosmos DB for PostgreSQL storage');
    lines.push(meterLine('Database', 'Cosmos DB for PostgreSQL', `${multi ? 'Coordinator storage' : 'Storage'}, ${fmtN(gib)} GiB${haTag}`, st, gib * storageNodes * copies, ctx, { unit: 'GiB / month' }));
    if (multi) lines.push(meterLine('Database', 'Cosmos DB for PostgreSQL', `Worker storage, ${fmtN(wg)} GiB x ${fmtN(workers)} node(s)${haTag}`, st, wg * workers * copies, ctx, { unit: 'GiB / month' }));
    if (ha) notes.push('High availability runs one standby node (and its storage) for each primary node, so compute and storage are counted twice.');
    notes.push('Storage bills per GiB-month for the provisioned size on every node. Backup storage is listed at zero in the Retail Prices API, but the pricing page says backup storage beyond 100% of provisioned storage is charged per GiB-month from 1 December 2025, so large backup footprints may add cost.');
    if (sp) notes.push('A savings plan for databases is an hourly spend commitment; the price shown is the savings-plan rate for each hour of use. Per Learn, it applies to infrastructure and software IP costs for database services, including Azure Cosmos DB for PostgreSQL; storage stays pay-as-you-go. Retail lists a 1-year term only.');
    else if (commit !== 'payg') notes.push('A reservation discounts compute only, and bills every hour of the term.');
    return { lines, notes, facts: { layout, vcores: v, workers, workerVcores: wv, ha, commitment: commit, storageGib: gib, hours } };
  }
};
