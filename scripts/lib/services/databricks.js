'use strict';
// Azure Databricks: DBU (Databricks unit) meters by workload and tier, optional Photon and security
// add-ons, serverless workloads, disaster-recovery replication, clean-room collaborators and the
// DBCU pre-purchase (1 or 3 years). The virtual machines, disks and storage under classic clusters are
// separate Azure bills; price them as 'vm' / 'disk' / 'blob' components.
// Meters: serviceName 'Azure Databricks' (classic DBUs, global prices) and productName 'Azure Databricks Regional'
// (serverless and a few others, regional prices).
const { rows, single, meterLine, line, meterInfo, termMonths, PricingError, fmtN, HOURS, DAYS, q } = require('../kit');

const n = v => Number(v || 0);
const SVC = 'Azure Databricks';

// workload -> { standard?, premium, photon? } meter names (without " DBU")
const WORKLOADS = {
  'all-purpose': { label: 'All-purpose compute', standard: 'Standard All-purpose Compute', premium: 'Premium All-purpose Compute', photon: { standard: 'Standard All-Purpose Photon', premium: 'Premium All-Purpose Photon' } },
  jobs: { label: 'Jobs compute', standard: 'Standard Jobs Compute', premium: 'Premium Jobs Compute', photon: { standard: 'Standard Jobs Compute Photon', premium: 'Premium Jobs Compute Photon' } },
  'jobs-light': { label: 'Jobs Light compute', standard: 'Standard Jobs Light Compute', premium: 'Premium Jobs Light Compute' },
  'sql-classic': { label: 'Classic SQL warehouse', standard: 'Standard SQL Analytics', premium: 'Premium SQL Analytics' },
  'dlt-core': { label: 'Lakeflow Spark Declarative Pipelines Core', premium: 'Premium Core Compute Delta Live Tables', photon: { premium: 'Premium Core Compute Photon Delta Live Tables' } },
  'dlt-pro': { label: 'Lakeflow Spark Declarative Pipelines Pro', premium: 'Premium Pro Compute Delta Live Tables', photon: { premium: 'Premium Pro Compute Photon Delta Live Tables' } },
  'dlt-advanced': { label: 'Lakeflow Spark Declarative Pipelines Advanced', premium: 'Premium Advanced Compute Delta Live Tables', photon: { premium: 'Premium Advanced Compute Photon Delta Live Tables' } },
  'sql-pro': { label: 'SQL warehouse Pro', premium: 'Premium SQL Compute Pro', regional: true },
  'sql-serverless': { label: 'Serverless SQL warehouse', premium: 'Premium Serverless SQL', regional: true },
  'serverless-jobs': { label: 'Serverless jobs / automated compute', premium: 'Premium Automated Serverless Compute', regional: true },
  'serverless-interactive': { label: 'Serverless interactive compute', premium: 'Premium Interactive Serverless Compute', regional: true },
  'serverless-database': { label: 'Serverless database compute', premium: 'Premium Database Serverless Compute', regional: true },
  'model-training': { label: 'Model training', premium: 'Premium Model Training', regional: true },
  'model-serving': { label: 'Serverless real-time inference', premium: 'Premium Serverless Realtime Inferencing', regional: true },
  'anthropic-serving': { label: 'Anthropic model serving', premium: 'Premium Anthropic Serverless Inference', regional: true },
  'serverless-gpu-block': { label: 'Serverless GPU compute capacity block', premium: 'Premium Serverless GPU Compute Capacity Block', regional: true }
};
// Enhanced Security and Compliance is a percentage of list DBU spend (10%). Mission Critical is 30% of list
// (includes Enhanced Security and Compliance and Managed Disaster Recovery), half price until 2027-06-30.
const ADDON = { enhanced: { meter: 'Premium Enhanced Security and Compliance', pct: () => 0.10, label: 'Enhanced Security and Compliance' }, 'mission-critical': { meter: 'Premium Enhanced Security and Compliance - Mission Critical Add-on', pct: () => (Date.now() <= Date.parse('2027-06-30T23:59:59Z') ? 0.15 : 0.30), label: 'Mission Critical' } };

module.exports = {
  type: 'databricks',
  label: 'Azure Databricks',
  family: 'analytics',
  calculator: ['databricks'],
  keywords: ['databricks', 'dbu', 'spark', 'lakehouse', 'delta live tables', 'lakeflow', 'lakebase', 'anthropic', 'notebooks', 'machine learning platform', 'sql warehouse'],
  fields: {
    workload: { def: 'jobs', enum: Object.keys(WORKLOADS), ask: 'What will they run? Scheduled batch pipelines -> jobs; people working in notebooks -> all-purpose; BI/SQL queries -> sql-pro (or sql-serverless for no cluster management); streaming/ETL pipelines (Lakeflow Spark Declarative Pipelines, formerly Delta Live Tables) -> dlt-core, dlt-pro or dlt-advanced (serverless pipelines bill on serverless-jobs); training models -> model-training; serving a model -> model-serving; Anthropic models -> anthropic-serving; serverless GPU capacity blocks -> serverless-gpu-block; serverless notebooks/jobs -> serverless-interactive / serverless-jobs. If unknown, suggest jobs and record it as an assumption. For several workloads under one prepurchase, use the workloads list (one component, one DBCU pool).' },
    workloads: { def: [], ask: 'Optional. Several workloads in one component, each { workload, photon, dbusPerHour, hours }; they share one DBCU prepurchase pool. Leave empty for a single workload.' },
    tier: { def: 'premium', ask: 'Premium is the only tier: the Azure Databricks Standard tier retires on October 1, 2026 and new Standard workspaces are not supported. Do not ask; record premium.' },
    photon: { def: false, ask: 'Will they use the Photon engine (faster SQL/DataFrame processing)? Photon bills at a higher DBU rate per hour (about 2x for all-purpose compute, 2.5x for jobs, 2.9x for Lakeflow pipelines on the Databricks DBU rate table), so use the Photon DBU rate for the node sizes.' },
    dbusPerHour: { min: 0, ask: 'How many DBUs does the workload use per hour while it runs? Each virtual machine size has a published DBU rate per hour in the Databricks documentation (add the driver and all workers); SQL warehouse sizes use 4 (2X-Small), 6 (X-Small), 12 (Small), 24 (Medium), 40 (Large), 80 (X-Large), 144 (2X-Large), 272 (3X-Large) and 528 (4X-Large) DBUs per hour. If unknown, ask for the number of nodes and VM size, look up the rate, and record it as an assumption.' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours a month does it run? Clusters bill only while running; a scheduled job that runs 2 hours a day is about 60 hours. 730 = always on.' },
    securityAddOn: { def: 'none', enum: ['none', 'enhanced', 'mission-critical'], ask: 'Do they need the compliance security profile (standards such as HIPAA, PCI-DSS, HITRUST, IRAP Protected, UK Cyber Essentials Plus, Canada Protected B)? Yes -> enhanced (10% of list DBU spend); mission-critical (includes enhanced security plus Managed Disaster Recovery) is 30% of list, half price until 2027-06-30; otherwise none. Both are a percentage of list spend, not a per-DBU charge.' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Pay-as-you-go DBUs, or compare a 1- or 3-year prepurchase of Databricks commit units (DBCU)? Only worth it when DBU spend is steady and at least about $12,000 a year.' },
    dbcuUnits: { def: 0, int: true, min: 0, ask: 'Only for a prepurchase: how many DBCUs to buy (12,500 up to 6,000,000 depending on term)? 0 = pick the cheapest plan, which can be larger than the estimated usage.' },
    lakebaseDsu: { def: 0, int: true, min: 0, ask: 'Only for Lakebase: how many Databricks Storage Units (DSU) of Lakebase storage? 0 if none.' },
    drReplicationGB: { def: 0, min: 0, ask: 'Only if they use Databricks disaster-recovery replication (needs the Mission Critical add-on): how many GB are replicated per month? 0 if none.' },
    cleanRoomCollaborators: { def: 0, int: true, min: 0, ask: 'Only if they use Databricks Clean Rooms: how many collaborators are active every day of the month? 0 if none.' }
  },
  context: ['production', 'steadyUsage', 'idlePeriods'],
  examples: [
    { type: 'databricks', workload: 'jobs', dbusPerHour: 24, hours: 120 },
    {
      type: 'databricks', workload: 'all-purpose', photon: true, dbusPerHour: 40, hours: 600,
      securityAddOn: 'mission-critical', drReplicationGB: 500, cleanRoomCollaborators: 2
    },
    { type: 'databricks', workload: 'sql-serverless', dbusPerHour: 80, hours: 730, commitment: 'ri1y' },
    { type: 'databricks', workloads: [{ workload: 'jobs', dbusPerHour: 30, hours: 730 }, { workload: 'all-purpose', dbusPerHour: 40, hours: 500 }], commitment: 'ri1y', securityAddOn: 'enhanced' }
  ],
  readback: c => {
    const items = (Array.isArray(c.workloads) && c.workloads.length ? c.workloads : [c]);
    const parts = items.map(x => {
      const w = WORKLOADS[x.workload || 'jobs'];
      const total = n(x.dbusPerHour) * n(x.hours ?? HOURS);
      return `${w ? w.label : x.workload}${x.photon ? ' with Photon' : ''} (premium): ${fmtN(n(x.dbusPerHour))} DBUs per hour x ${fmtN(x.hours ?? HOURS)} hours a month = ${fmtN(total)} DBUs`;
    });
    if (c.securityAddOn && c.securityAddOn !== 'none') parts.push(`${c.securityAddOn} security and compliance add-on (a percentage of list DBU spend)`);
    if (n(c.lakebaseDsu)) parts.push(`${fmtN(c.lakebaseDsu)} Lakebase storage DSUs`);
    if (n(c.drReplicationGB)) parts.push(`${fmtN(c.drReplicationGB)} GB disaster-recovery replication`);
    if (n(c.cleanRoomCollaborators)) parts.push(`${fmtN(c.cleanRoomCollaborators)} clean room collaborator(s)`);
    const commit = c.commitment || 'payg';
    if (commit !== 'payg') parts.push(`${commit === 'ri1y' ? '1-year' : '3-year'} DBCU prepurchase${n(c.dbcuUnits) ? ` of ${fmtN(c.dbcuUnits)} DBCUs` : ' (cheapest plan chosen automatically)'}`);
    return `Azure Databricks: ${parts.join('; ')}`;
  },
  notIncluded: (types, spec) => {
    const ex = (spec && spec.excluded) || [];
    if (ex.some(e => /virtual machine|\bvm\b|disk|storage/i.test(String(e)))) return [];
    const out = [];
    if (!types.has('vm')) out.push('The virtual machines (and their disks and networking) that run classic Databricks clusters are a separate Azure bill, not Databricks DBUs; add them as vm components. Serverless workloads include the compute.');
    if (!types.has('blob')) out.push('The storage account holding the data and the Databricks managed storage are billed separately.');
    out.push('Lakebase point-in-time-recovery and snapshot storage have no Azure Retail Prices meter, so they are not priced; Genie (150 free DBUs a month, promotional price to 2027-01-31) is not included.');
    return out;
  },
  price: async (c, ctx) => {
    const commit = c.commitment || 'payg';
    const tier = c.tier || 'premium';
    if (tier === 'standard') throw new PricingError('The Azure Databricks Standard tier retires on October 1, 2026 and new Standard workspaces are not supported (Azure Databricks pricing page); price the Premium tier.');
    if (tier !== 'premium') throw new PricingError('tier must be premium.');
    if (!['payg', 'ri1y', 'ri3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y or ri3y.`);
    const multi = Array.isArray(c.workloads) && c.workloads.length > 0;
    if (c.workloads !== undefined && !Array.isArray(c.workloads)) throw new PricingError('workloads must be a list.');
    if (multi) {
      const dropped = ['workload', 'photon', 'dbusPerHour', 'hours'].filter(k => c[k] !== undefined);
      if (dropped.length) throw new PricingError('When workloads is used, put ' + dropped.join(', ') + ' inside each workloads entry; top-level values would be ignored.');
      c.workloads.forEach((x, i) => {
        const where = 'workloads[' + i + ']';
        if (!x || typeof x !== 'object' || Array.isArray(x)) throw new PricingError(where + ' must be an object.');
        for (const k of Object.keys(x)) if (!['workload', 'photon', 'dbusPerHour', 'hours'].includes(k)) throw new PricingError(where + ': unknown field "' + k + '". Allowed: workload, photon, dbusPerHour, hours.');
        if (x.photon !== undefined && typeof x.photon !== 'boolean') throw new PricingError(where + ': photon must be true or false.');
        if (x.workload !== undefined && typeof x.workload !== 'string') throw new PricingError(where + ': workload must be text.');
        for (const k of ['dbusPerHour', 'hours']) if (x[k] !== undefined && (typeof x[k] !== 'number' || !Number.isFinite(x[k]) || x[k] < 0)) throw new PricingError(where + ': ' + k + ' must be a number of 0 or more.');
        if (x.dbusPerHour === undefined) throw new PricingError(where + ': dbusPerHour is required.');
      });
    }
    const items = multi ? c.workloads : [c];
    if (commit !== 'payg') {
      if (ctx.ledger && ctx.ledger.dbxCommit) throw new PricingError('A second Databricks component has a DBCU prepurchase. One DBCU pool covers every workload, so put all workloads in one component using the workloads list.');
      if (ctx.ledger) ctx.ledger.dbxCommit = true;
    }
    const addon = c.securityAddOn || 'none';
    if (addon !== 'none' && !ADDON[addon]) throw new PricingError('securityAddOn must be none, enhanced or mission-critical.');
    if (n(c.drReplicationGB) && addon !== 'mission-critical') throw new PricingError('Databricks disaster-recovery replication requires the Mission Critical add-on (Azure Databricks pricing page); set securityAddOn to mission-critical.');
    for (const k of ['dbcuUnits', 'lakebaseDsu', 'cleanRoomCollaborators']) if (n(c[k]) && !Number.isInteger(n(c[k]))) throw new PricingError(`${k} must be a whole number.`);

    // Classic prices are global (also listed per region); regional meters exist per region only.
    const all = await rows(`serviceName eq '${SVC}' and priceType eq 'Consumption' and (armRegionName eq '${q(ctx.region)}' or armRegionName eq 'Global')`, ctx);
    const pick = name => {
      const m = all.filter(r => r.meterName === name);
      const inRegion = m.filter(r => r.armRegionName === ctx.region);
      return single(inRegion.length ? inRegion : m, `${name.replace(/ DBU$/, '')} in ${ctx.region}`);
    };
    const G = 'Analytics', lines = [], notes = [];
    let dbuTotal = 0, dbuHoursTotal = 0;
    for (const x of items) {
      const wl = x.workload || 'jobs', w = WORKLOADS[wl];
      if (!w) throw new PricingError(`Unknown workload "${wl}". Use ${Object.keys(WORKLOADS).join(', ')}.`);
      if (x.photon && !w.photon) throw new PricingError(`Photon is not a separate option for ${w.label}.`);
      const hrs = n(x.hours ?? HOURS), dph = n(x.dbusPerHour);
      if (hrs > 744) throw new PricingError(`${w.label}: hours cannot exceed 744 in a month.`);
      const dbu = dph * hrs;
      if (!(dbu > 0)) throw new PricingError('dbusPerHour and hours must be greater than 0.');
      const meterName = (w.photon && x.photon ? w.photon.premium : w.premium) + ' DBU';
      lines.push(meterLine(G, SVC, `${w.label}${x.photon ? ' with Photon' : ''}, premium tier: ${fmtN(dph)} DBUs/hour x ${fmtN(hrs)} hours = ${fmtN(dbu)} DBUs`, pick(meterName), dbu, ctx, { unit: 'DBU-hours' }));
      dbuTotal += dbu;
    }
    let fxUsd = 1;
    const dbuLines = lines.slice();
    const S = dbuLines.reduce((s, l) => s + l.list, 0);
    const wlOf = x => x.workload || 'jobs', hrsOf = x => n(x.hours ?? HOURS);
    const apH = items.filter(x => wlOf(x) === 'all-purpose').map(hrsOf), sqlH = items.filter(x => /^sql-/.test(wlOf(x))).map(hrsOf);
    const facts = { workload: items[0].workload || 'jobs', tier, photon: items.some(x => x.photon), dbuHours: dbuTotal, commitment: commit,
      hasAllPurpose: apH.length > 0, allPurposeMinHours: apH.length ? Math.min(...apH) : null, allPurposeMaxHours: apH.length ? Math.max(...apH) : null, sqlMaxHours: sqlH.length ? Math.max(...sqlH) : null, hours: n(items[0].hours ?? HOURS), workloadCount: items.length, monthlyDbuList: S };

    if (addon !== 'none') {
      const a = ADDON[addon], pct = a.pct();
      const m = pick(`${a.meter} DBU`);
      lines.push(line(G, SVC, `${a.label} add-on: ${Math.round(pct * 100)}% of ${fmtN(Math.round(S * 100) / 100)} list DBU spend${addon === 'mission-critical' && pct < 0.3 ? ' (promotional half price until 2027-06-30)' : ''}`, S, 'list spend', pct, S * pct, meterInfo(m[0]), { unitLabel: 'per list-spend unit' }));
      notes.push(addon === 'mission-critical'
        ? 'The Mission Critical add-on is 30% of list Azure Databricks spend (half price, 15%, until 2027-06-30) and includes Enhanced Security and Compliance and Managed Disaster Recovery.'
        : 'Enhanced Security and Compliance is 10% of list Azure Databricks DBU spend for the workspace, not a per-DBU price. It is calculated on list price, before any DBCU prepurchase.');
    }
    if (n(c.lakebaseDsu)) lines.push(meterLine(G, SVC, `Lakebase storage, ${fmtN(c.lakebaseDsu)} DSUs`, pick('Premium Databricks Storage Unit DSU'), n(c.lakebaseDsu), ctx, { unit: 'DSU' }));
    if (n(c.drReplicationGB)) lines.push(meterLine(G, SVC, `Disaster-recovery replication, ${fmtN(c.drReplicationGB)} GB processed`, single(all.filter(r => r.skuName === 'Premium Disaster Recovery Replication' && (r.armRegionName === ctx.region || !all.some(x => x.skuName === r.skuName && x.armRegionName === ctx.region))), 'disaster-recovery replication'), n(c.drReplicationGB), ctx, { unit: 'GB' }));
    if (n(c.cleanRoomCollaborators)) lines.push(meterLine(G, SVC, `Clean Rooms, ${fmtN(c.cleanRoomCollaborators)} collaborator(s) x ${fmtN(Math.round(DAYS * 100) / 100)} days`, pick('Premium Clean Rooms Collaborator Collaborator'), n(c.cleanRoomCollaborators) * DAYS, ctx, { unit: 'collaborator-days' }));
    notes.push('Databricks bills DBUs (Databricks units) per hour of use at a rate that depends on the workload. This is the Databricks software charge only: the virtual machines, disks, networking and storage under classic clusters are billed separately as Azure compute (add them as vm components). Serverless workloads include the compute.');
    if (items.some(x => (x.workload || '') === 'anthropic-serving')) notes.push('Anthropic model serving uses the Premium Anthropic Serverless Inference meter ($0.105 per DBU-hour), the rate in the Azure pricing calculator offer for Anthropic model serving; a separate Retail meter named Premium Model Serving for Anthropic ($0.14, Add-on services) exists and is not used.');
    if (items.some(x => (x.workload || '') === 'serverless-gpu-block')) notes.push('The serverless GPU capacity block meter is priced per DBU-hour as listed; confirm the block size and duration with Databricks.');
    if (n(c.lakebaseDsu)) notes.push('Lakebase point-in-time-recovery and snapshot storage have no Azure Retail Prices meter and are not priced.');
    if (items.some(x => /^dlt-/.test(x.workload || ''))) notes.push('Serverless Lakeflow Spark Declarative Pipelines bill on the serverless-jobs (Automated Serverless Compute) meter, not the Core/Pro/Advanced meters.');

    if (commit !== 'payg') {
      const term = commit === 'ri1y' ? '1 Year' : '3 Years', T = termMonths(term);
      const parse = rs => rs.map(r => ({ r, units: parseFloat(String(r.skuName).replace(/,/g, '')) * (/million/i.test(r.skuName) ? 1e6 : 1) })).filter(x => x.units > 0).sort((a, b) => a.units - b.units);
      const flt = `serviceName eq '${SVC}' and priceType eq 'Reservation' and armRegionName eq 'Global' and reservationTerm eq '${term}'`;
      const rr = parse(await rows(flt, ctx));
      if (!rr.length) throw new PricingError(`No ${term} Databricks commit unit prices found.`);
      // DBCUs are drawn down at USD list units, so convert local spend using the plan price ratio.
      let fx = 1;
      if (ctx.currency !== 'USD') {
        const usd = parse(await rows(flt, { currency: 'USD' }));
        const u = usd.find(x => x.units === rr[0].units);
        if (u && u.r.retailPrice > 0) fx = rr[0].r.retailPrice / u.r.retailPrice;
        fxUsd = fx;
      }
      let pick1;
      if (n(c.dbcuUnits)) {
        pick1 = rr.find(x => x.units === n(c.dbcuUnits));
        if (!pick1) throw new PricingError(`No ${term} plan of ${fmtN(c.dbcuUnits)} DBCUs. Available: ${rr.map(x => fmtN(x.units)).join(', ')}.`);
      } else {
        let best = S * T;
        for (const x of rr) {
          const cost = x.r.retailPrice + Math.max(0, S * T - x.units * fx);
          if (cost < best - 1e-9) { best = cost; pick1 = x; }
        }
        if (!pick1) throw new PricingError(`No ${term} DBCU plan beats pay-as-you-go for estimated DBU spend of ${fmtN(Math.round(S))} a month (${fmtN(Math.round(S * T))} over ${T} months); the smallest plan is ${fmtN(rr[0].units)} DBCUs. Use pay-as-you-go.`);
      }
      const price = pick1.r.retailPrice, coveredTerm = Math.min(pick1.units * fx, S * T);
      const monthly = price / T + Math.max(0, S * T - pick1.units * fx) / T;
      const factor = monthly / S;
      for (const l of dbuLines) { l.list *= factor; l.desc += ` (after the ${fmtN(pick1.units)} DBCU ${term.toLowerCase()} prepurchase)`; }
      notes.push(`${term} prepurchase of ${fmtN(pick1.units)} DBCUs costs ${fmtN(price)} up front (${fmtN(price / T)} a month over ${T} months) and is drawn down at the USD list price of DBU usage across all Databricks workloads and tiers in this estimate. Estimated list spend is ${fmtN(Math.round(S))} a month, ${fmtN(Math.round(coveredTerm / T))} a month of it covered, so the effective discount on DBU lines is ${Math.round((1 - factor) * 100)}%. Unused DBCUs expire at the end of the term. Add-on lines (security, replication, storage) are priced at list: the source does not say DBCUs cover them.`);
      facts.dbcuUnits = pick1.units; facts.dbcuPrice = price;
      if (pick1.units * fx > S * T) facts.commitmentUnderused = true;
    }
    if (commit === 'payg') {
      if (ctx.currency !== 'USD') {
        const f1 = `serviceName eq '${SVC}' and priceType eq 'Reservation' and armRegionName eq 'Global' and reservationTerm eq '1 Year'`;
        const loc = (await rows(f1, ctx))[0], usd = (await rows(f1, { currency: 'USD' })).find(r => loc && r.skuName === loc.skuName);
        if (loc && usd && usd.retailPrice > 0) fxUsd = loc.retailPrice / usd.retailPrice;
      }
      facts.annualDbuList = Math.round(S * 12 / fxUsd);
    } else facts.annualDbuList = Math.round(S * 12 / fxUsd);
    return { lines, notes, facts };
  }
};