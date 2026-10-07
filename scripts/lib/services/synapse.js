'use strict';
// Azure Synapse Analytics: dedicated SQL pool (DWU, storage, geo-backup, reservations), serverless SQL
// (per TB processed), Apache Spark pools (vCore-hours), pipelines / data flows (integration runtime meters)
// and the Azure-SSIS integration runtime. serviceName 'Azure Synapse Analytics', regional.
// Not priced: Data Explorer pools (retired 7 Oct 2025), Compute Optimized data flows (retired 31 Aug 2024) and
// GPU Spark pools (preview deprecated).
// SSIS node sizes are set by the service: the Azure-SSIS integration runtime offers only the sizes in Learn
// (configure-azure-ssis-integration-runtime-performance). Every listed series (Av2, Dv2, Dv3, Ev3) is End of Life
// in the VM lifecycle table, a documented exception because the service sets these sizes. Learn says to use the
// v3 series, so the cheapest v3 size that fits is picked; v2/A-series only when no v3 size fits.
const { rows, query, single, regionFilter, meterLine, line, meterInfo, termMonths, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const SVC = 'Azure Synapse Analytics';
const P = s => `Azure Synapse Analytics ${s}`;
// Azure-SSIS IR node sizes (Learn list; vCPU / GiB), rank 1 = v3, 0 = v2/A.
const SSIS_SIZES = [
  ['A4 v2', 4, 8, 0], ['A8 v2', 8, 16, 0], ['D1 v2', 1, 3.5, 0], ['D2 v2', 2, 7, 0], ['D3 v2', 4, 14, 0], ['D4 v2', 8, 28, 0],
  ['D2 v3', 2, 8, 1], ['D4 v3', 4, 16, 1], ['D8 v3', 8, 32, 1], ['D16 v3', 16, 64, 1], ['D32 v3', 32, 128, 1], ['D64 v3', 64, 256, 1],
  ['E2 v3', 2, 16, 1], ['E4 v3', 4, 32, 1], ['E8 v3', 8, 64, 1], ['E16 v3', 16, 128, 1], ['E32 v3', 32, 256, 1], ['E64 v3', 64, 432, 1], ['E64i v3', 64, 432, 1]
].map(([name, vcpu, mem, rank]) => ({ name, vcpu, mem, rank }));
const SPARK_VCORES = { small: 4, medium: 8, large: 16, xlarge: 32, xxlarge: 64, xxxlarge: 80 };
const SPARK_LABEL = { small: 'Small (4 vCores)', medium: 'Medium (8 vCores)', large: 'Large (16 vCores)', xlarge: 'XLarge (32 vCores)', xxlarge: 'XXLarge (64 vCores)', xxxlarge: 'XXXLarge (80 vCores, isolated)' };
const FLOW_PRODUCT = { basic: 'Data Flow - Basic', standard: 'Data Flow - Standard' };
const IR = { azure: 'Azure Hosted IR', 'self-hosted': 'Self Hosted IR', 'managed-vnet': 'Azure Hosted Managed VNET IR' };
const IR_LABEL = { azure: 'Azure integration runtime', 'self-hosted': 'self-hosted integration runtime', 'managed-vnet': 'Azure integration runtime in a managed virtual network' };

const normSize = s => String(s || '').toLowerCase().replace(/^standard_/, '').replace(/[\s_]+/g, '');

module.exports = {
  type: 'synapse',
  label: 'Azure Synapse Analytics',
  family: 'analytics',
  calculator: ['synapse-analytics'],
  keywords: ['synapse', 'data warehouse', 'dedicated sql pool', 'serverless sql', 'spark pool', 'data lake analytics', 'pipelines', 'dwu', 'big data'],
  fields: {
    dedicatedDwu: { req: true, int: true, min: 0, max: 30000, ask: 'Do they need a dedicated SQL pool (a provisioned data warehouse)? How big: 100 is the smallest, 1,000 is a typical mid-size warehouse, up to 30,000. Enter 0 if they only query files in a data lake or use Spark/pipelines. If unknown, suggest 1000 and record it as an assumption.' },
    dedicatedHours: { def: 730, min: 0, max: 744, ask: 'How many hours a month is the dedicated pool running (not paused)? Pausing stops compute billing but not storage. 730 = all month (at most 744).' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y'], ask: 'Pay-as-you-go, or compare a 1- or 3-year reservation for the dedicated pool? Only worth it if the pool runs most hours of the month. ri1y = 1-year, ri3y = 3-year.' },
    dedicatedStorageTB: { def: 0, ask: 'Dedicated pool only: how many TB of data are stored in the warehouse? Storage is billed per TB even while the pool is paused.' },
    geoBackupTB: { def: 0, ask: 'Dedicated pool only: how many TB of geo-redundant disaster-recovery backups are kept (about the size of the data, if geo-backup is on; 0 if off)?' },
    serverlessTB: { def: 0, ask: 'Serverless SQL (querying files in a data lake without a pool): roughly how many TB of data do queries read per month? Billed per TB processed; each query counts at least 10 MB.' },
    sparkNodes: { def: 0, int: true, min: 0, ask: 'Spark pools: how many nodes are running at a time? A Spark pool instance has at least 3 nodes (one head and two workers), so use 3 or more. 0 if they do not use Spark.' },
    sparkNodeSize: { def: 'medium', enum: ['small', 'medium', 'large', 'xlarge', 'xxlarge', 'xxxlarge'], ask: 'Spark node size: small = 4 vCores, medium = 8, large = 16, xlarge = 32, xxlarge = 64, xxxlarge = 80 (isolated compute). If unknown, suggest medium and record it as an assumption.' },
    sparkHours: { def: 730, min: 0, max: 744, ask: 'Spark: how many hours a month are the nodes running? Spark pools auto-pause when idle; use the hours jobs actually run (at most 744).' },
    dataFlowVcoreHours: { def: 0, ask: 'Pipeline data flows (visual transformations): roughly how many vCore-hours a month? A data flow uses at least 8 vCores, so a 30-minute run is at least 4 vCore-hours. 0 if none.' },
    dataFlowType: { def: 'basic', enum: ['basic', 'standard'], ask: 'Data flow compute: basic = General Purpose, the default; standard = Memory Optimized, for transformations that need more memory per core and costs more per vCore-hour. If unknown suggest basic and record it as an assumption.' },
    pipelineRuns: { def: 0, int: true, min: 0, ask: 'Pipelines: how many activity runs (each step in a pipeline run) per month?' },
    pipelineRuntime: { def: 'azure', enum: ['azure', 'self-hosted', 'managed-vnet'], ask: 'Where do pipelines run: azure = the default Azure integration runtime; self-hosted = on their own machine for on-premises data; managed-vnet = Azure runtime inside a managed private network.' },
    dataMovementHours: { def: 0, ask: 'Pipelines: how many data-integration-unit (DIU) hours a month of copy activities? A default copy uses 4 DIUs, so one hour of copying is about 4 DIU-hours. For a self-hosted runtime this is plain hours of copying.' },
    pipelineActivityHours: { def: 0, ask: 'Pipelines: how many hours a month do non-copy pipeline activities run (Lookup, Get Metadata, Delete and schema operations)? Mapping data flows are priced separately above.' },
    externalActivityHours: { def: 0, ask: 'Pipelines: how many hours a month do external activities run (for example calls to Databricks or stored procedures)?' },
    pipelineOperations: { def: 0, int: true, min: 0, ask: 'Pipelines: how many create/read/update/delete/monitor operations a month? The first 1 million are free; most people never exceed that.' },
    synapseLinkVcores: { def: 0, int: true, min: 0, ask: 'Only if they use Azure Synapse Link for SQL (continuous replication from SQL Server 2022 or Azure SQL Database into a dedicated pool): how many vCores does the link run on? 0 if none.' },
    synapseLinkHours: { def: 730, min: 0, max: 744, ask: 'Synapse Link for SQL: how many hours a month does the link run (at most 744)?' },
    ssisNodes: { def: 0, int: true, min: 0, ask: 'Only if they run SSIS packages in Azure: how many nodes? 0 if none.' },
    ssisNodeVcpu: { def: 4, int: true, min: 1, ask: 'SSIS: how many vCPUs per node? Package execution is mostly CPU-bound; 4 is a common start. The service maps the answer to the node sizes the Azure-SSIS integration runtime offers. If unknown, suggest 4 and record it as an assumption.' },
    ssisNodeMemoryGiB: { def: 16, min: 1, ask: 'SSIS: how much memory per node, in GiB? Memory-heavy packages (large lookups, big data flows) need more; 16 GiB goes with 4 vCPUs. If unknown, suggest 16 and record it as an assumption.' },
    ssisEdition: { def: 'standard', enum: ['standard', 'enterprise'], ask: 'SSIS edition: standard unless they need Enterprise-only features.' },
    ssisLicense: { def: 'included', enum: ['included', 'hybrid'], ask: 'SSIS: do they own SQL Server licenses with Software Assurance (Azure Hybrid Benefit)? Yes -> hybrid; otherwise included.' },
    ssisHours: { def: 730, min: 0, max: 744, ask: 'SSIS: how many hours a month are the nodes running (at most 744)?' }
  },
  testRegions: ['eastus2', 'westeurope', 'westus3'],
  context: ['production', 'steadyUsage', 'idlePeriods'],
  examples: [
    { type: 'synapse', dedicatedDwu: 1000, dedicatedStorageTB: 10 },
    {
      type: 'synapse', dedicatedDwu: 500, dedicatedHours: 400, dedicatedStorageTB: 5, geoBackupTB: 5,
      serverlessTB: 20, sparkNodes: 3, sparkNodeSize: 'large', sparkHours: 200, synapseLinkVcores: 4, synapseLinkHours: 300, dataFlowVcoreHours: 100, dataFlowType: 'standard',
      pipelineRuns: 50000, pipelineRuntime: 'azure', dataMovementHours: 120, pipelineActivityHours: 40, externalActivityHours: 10, pipelineOperations: 3000000,
      ssisNodes: 2, ssisNodeVcpu: 4, ssisNodeMemoryGiB: 16, ssisEdition: 'standard', ssisLicense: 'hybrid', ssisHours: 100
    }
  ],
  readback: c => {
    const parts = [];
    const commit = c.commitment || 'payg';
    if (n(c.dedicatedDwu)) {
      const term = commit === 'ri1y' ? '1-year reservation' : commit === 'ri3y' ? '3-year reservation' : 'pay-as-you-go';
      parts.push(`dedicated SQL pool of ${fmtN(c.dedicatedDwu)} DWU (${term}), ${commit === 'payg' ? `running ${fmtN(c.dedicatedHours ?? HOURS)} hours a month` : 'billed every hour of the term'}`);
      if (n(c.dedicatedStorageTB)) parts.push(`${fmtN(c.dedicatedStorageTB)} TB of warehouse storage`);
      if (n(c.geoBackupTB)) parts.push(`${fmtN(c.geoBackupTB)} TB of geo-redundant backups`);
    }
    if (n(c.serverlessTB)) parts.push(`${fmtN(c.serverlessTB)} TB a month processed by serverless SQL`);
    if (n(c.sparkNodes)) parts.push(`${fmtN(c.sparkNodes)} Spark node(s) of size ${c.sparkNodeSize || 'medium'}, ${fmtN(c.sparkHours ?? HOURS)} hours a month`);
    if (n(c.dataFlowVcoreHours)) parts.push(`${fmtN(c.dataFlowVcoreHours)} data flow vCore-hours (${c.dataFlowType || 'basic'})`);
    const rt = IR_LABEL[c.pipelineRuntime || 'azure'];
    if (n(c.pipelineRuns)) parts.push(`${fmtN(c.pipelineRuns)} pipeline activity runs on the ${rt}`);
    if (n(c.dataMovementHours)) parts.push(`${fmtN(c.dataMovementHours)} data-integration-unit hours of data movement`);
    if (n(c.pipelineActivityHours)) parts.push(`${fmtN(c.pipelineActivityHours)} pipeline activity hours`);
    if (n(c.externalActivityHours)) parts.push(`${fmtN(c.externalActivityHours)} external activity hours`);
    if (n(c.pipelineOperations)) parts.push(`${fmtN(c.pipelineOperations)} pipeline operations`);
    if (n(c.synapseLinkVcores)) parts.push(`Synapse Link for SQL on ${fmtN(c.synapseLinkVcores)} vCores, ${fmtN(c.synapseLinkHours ?? HOURS)} hours a month`);
    if (n(c.ssisNodes)) parts.push(`${fmtN(c.ssisNodes)} SSIS ${c.ssisEdition || 'standard'} node(s) of ${n(c.ssisNodeVcpu ?? 4)} vCPUs / ${n(c.ssisNodeMemoryGiB ?? 16)} GiB (${c.ssisLicense === 'hybrid' ? 'Azure Hybrid Benefit' : 'license included'}), ${fmtN(c.ssisHours ?? HOURS)} hours a month`);
    return `Azure Synapse Analytics: ${parts.length ? parts.join('; ') : 'no billable quantities yet'}`;
  },
  notIncluded: (types, spec) => {
    const out = [];
    const ex = (spec && spec.excluded) || [];
    const skip = re => ex.some(e => re.test(String(e)));
    if (!skip(/data lake|storage account|adls/i)) out.push('The Azure Data Lake Storage account that holds the workspace files and the data queried by serverless SQL or Spark is billed separately; add it as a blob component.');
    if (!skip(/self-hosted|shir|virtual machine/i) && spec && JSON.stringify(spec).includes('self-hosted')) out.push('The machine that runs a self-hosted integration runtime is yours and is not in this estimate.');
    out.push('Synapse Commit Unit pre-purchase plans (discounts of up to 28% on Synapse usage other than storage) are not priced; compare them with Microsoft for steady, large Synapse spend.');
    return out;
  },
  price: async (c, ctx) => {
    const rs = await rows(`serviceName eq '${SVC}' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Synapse Analytics is not priced in ${ctx.region}.`);
    const by = (product, extra) => rs.filter(r => r.productName === P(product) && (!extra || extra(r)));
    const lines = [], notes = [];
    const commit = c.commitment || 'payg';
    if (!['payg', 'ri1y', 'ri3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y or ri3y.`);
    const dwu = n(c.dedicatedDwu);
    const G = 'Analytics';
    const facts = { dedicatedDwu: dwu, commitment: commit, dedicatedHours: c.dedicatedHours ?? HOURS, serverlessTB: n(c.serverlessTB), sparkNodes: n(c.sparkNodes), dataFlowVcoreHours: n(c.dataFlowVcoreHours), pipelineRuns: n(c.pipelineRuns) };

    if (dwu > 0) {
      const hours = c.dedicatedHours ?? HOURS;
      const sku = `DW${dwu}c`;
      const pool = by('Dedicated SQL Pool', r => r.skuName === sku);
      if (!pool.length) {
        const have = [...new Set(by('Dedicated SQL Pool').map(r => r.skuName))].sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2))).join(', ');
        throw new PricingError(`No dedicated SQL pool size "${sku}" in ${ctx.region}. Available: ${have || 'none'}. dedicatedDwu must be one of those sizes without the DW and c.`);
      }
      if (commit === 'payg') {
        lines.push(meterLine(G, SVC, `Dedicated SQL pool ${sku} (${fmtN(dwu)} data warehouse units), ${fmtN(hours)} hours running`, single(pool, `dedicated SQL pool ${sku}`), hours, ctx, { unit: 'hours' }));
        notes.push('A dedicated SQL pool bills for every hour it is running. Pausing it stops compute charges; storage keeps billing.');
      } else {
        if (dwu % 100) throw new PricingError('A dedicated pool reservation is bought in units of 100 DWU; dedicatedDwu must be a multiple of 100.');
        const term = commit === 'ri1y' ? '1 Year' : '3 Years';
        const rr = (await rows(`serviceName eq '${SVC}' and ${regionFilter(ctx)} and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx)).filter(r => r.skuName === 'DW100c');
        if (!rr.length) throw new PricingError(`No ${term} dedicated SQL pool reservation price in ${ctx.region}.`);
        const units = dwu / 100, months = termMonths(term), monthly = rr[0].retailPrice / months;
        lines.push(line(G, SVC, `Dedicated SQL pool, ${term} reservation of ${fmtN(dwu)} DWU (${fmtN(units)} units of 100 DWU)`, units, 'units / month', monthly, monthly * units, meterInfo(rr[0]), { termTotal: rr[0].retailPrice }));
        notes.push(`${term} reservation: ${rr[0].retailPrice} is the whole-term price per 100 DWU, divided by ${months} months. It is billed every hour whether or not the pool is paused, so it only pays off if the pool runs most of the month.`);
        if (hours < HOURS) facts.commitmentUnderused = true;
      }
      // Some regions list only the 'SQL Storage' / 'SQL Disaster Recovery Storage' products (same Standard LRS / RA-GRS meters and prices).
    const fb = (a, b) => { const x = by(a); return x.length ? x : by(b); };
    const storageRows = fb('SQL Provisioned Storage', 'SQL Storage'), drRows = fb('SQL Provisioned Disaster Recovery Storage', 'SQL Disaster Recovery Storage');
    if (n(c.dedicatedStorageTB)) lines.push(meterLine(G, SVC, `Dedicated SQL pool storage, ${fmtN(c.dedicatedStorageTB)} TB`, single(storageRows, 'dedicated pool storage'), n(c.dedicatedStorageTB), ctx, { unit: 'TB / month' }));
      if (n(c.geoBackupTB)) lines.push(meterLine(G, SVC, `Geo-redundant disaster-recovery backups, ${fmtN(c.geoBackupTB)} TB (${fmtN(n(c.geoBackupTB) * 1024)} GB)`, single(drRows, `geo-backup storage (not offered in ${ctx.region})`), n(c.geoBackupTB) * 1024, ctx, { unit: 'GB / month' }));
    } else if (n(c.dedicatedStorageTB) || n(c.geoBackupTB)) {
      throw new PricingError('Dedicated pool storage and geo-backups need dedicatedDwu greater than 0.');
    }

    if (n(c.serverlessTB)) {
      lines.push(meterLine(G, SVC, `Serverless SQL pool, ${fmtN(c.serverlessTB)} TB of data processed`, single(by('Serverless SQL Pool'), 'serverless SQL'), n(c.serverlessTB), ctx, { unit: 'TB' }));
      notes.push('Serverless SQL is billed per TB of data processed; each query is rounded up to the nearest 1 MB with a 10 MB minimum.');
    }

    if (n(c.sparkNodes)) {
      const size = c.sparkNodeSize || 'medium';
      if (!SPARK_VCORES[size]) throw new PricingError(`Unknown sparkNodeSize "${size}". Use ${Object.keys(SPARK_VCORES).join(', ')}.`);
      if (n(c.sparkNodes) < 3) throw new PricingError('A Synapse Spark pool instance has at least 3 nodes (one head and two workers); sparkNodes must be 3 or more.');
      const product = 'Serverless Apache Spark Pool - Memory Optimized';
      const hours = c.sparkHours ?? HOURS, vc = SPARK_VCORES[size] * n(c.sparkNodes);
      lines.push(meterLine(G, SVC, `Apache Spark pool: ${fmtN(c.sparkNodes)} x ${SPARK_LABEL[size]} = ${fmtN(vc)} vCores x ${fmtN(hours)} hours`, single(by(product), product), vc * hours, ctx, { unit: 'vCore-hours' }));
      notes.push('Spark pools bill per vCore-hour while nodes run; a pool that auto-pauses does not bill while idle.');
    }

    if (n(c.dataFlowVcoreHours)) {
      const t = c.dataFlowType || 'basic';
      if (!FLOW_PRODUCT[t]) throw new PricingError(`Unknown dataFlowType "${t}". Use basic or standard (Compute Optimized data flows were retired on 31 August 2024).`);
      lines.push(meterLine(G, SVC, `Data flow (${t}), ${fmtN(c.dataFlowVcoreHours)} vCore-hours`, single(by(FLOW_PRODUCT[t]), 'data flow'), n(c.dataFlowVcoreHours), ctx, { unit: 'vCore-hours' }));
      notes.push('A data flow cluster runs on at least 8 vCores and bills for execution and debugging time.');
    }

    const rt = c.pipelineRuntime || 'azure';
    if (!IR[rt]) throw new PricingError(`Unknown pipelineRuntime "${rt}". Use azure, self-hosted or managed-vnet.`);
    const ir = by('Pipelines', r => r.skuName === IR[rt]);
    const irLine = (qty, meterName, desc, unit) => {
      if (!n(qty)) return;
      lines.push(meterLine(G, SVC, desc, single(ir.filter(r => r.meterName === `${IR[rt]} ${meterName}`), `${IR_LABEL[rt]} ${meterName}`), n(qty), ctx, { unit }));
    };
    irLine(c.pipelineRuns, 'Orchestration Activity Run', `Pipeline orchestration on the ${IR_LABEL[rt]}, ${fmtN(n(c.pipelineRuns))} activity runs`, 'activity runs');
    irLine(c.dataMovementHours, 'Data Movement', `Copy data movement on the ${IR_LABEL[rt]}, ${fmtN(n(c.dataMovementHours))} `+(rt === 'self-hosted' ? 'hours' : 'DIU-hours'), rt === 'self-hosted' ? 'hours' : 'DIU-hours');
    irLine(c.pipelineActivityHours, 'Pipeline Activity', `Pipeline activities on the ${IR_LABEL[rt]}, ${fmtN(n(c.pipelineActivityHours))} hours`, 'hours');
    irLine(c.externalActivityHours, 'External Pipeline Activity', `External pipeline activities on the ${IR_LABEL[rt]}, ${fmtN(n(c.externalActivityHours))} hours`, 'hours');
    if (n(c.pipelineOperations)) {
      const opsRows = by('Pipelines', r => r.skuName === 'Operations' && r.meterName === 'Operations');
      if (!opsRows.length) notes.push(`Pipeline read/write/monitor operations are not priced: the Retail Prices API lists no Operations meter in ${ctx.region} (in other regions the first 1,000,000 operations a month are free and the rest are billed per 50,000); confirm in the Azure pricing calculator.`);
      else lines.push(meterLine(G, SVC, `Pipeline read/write/monitor operations, ${fmtN(c.pipelineOperations)} (first 1,000,000 free)`, single(opsRows, 'pipeline operations'), n(c.pipelineOperations), ctx, { unit: 'operations' }));
    }

    if (n(c.synapseLinkVcores)) {
      // Priced on a Global (regionless) meter, so read it outside the regional filter.
      const sl = (await rows(`serviceName eq '${SVC}' and productName eq 'Azure Synapse Link for SQL' and priceType eq 'Consumption'`, ctx));
      const inRegion = sl.filter(r => r.armRegionName === ctx.region);
      const hours = c.synapseLinkHours ?? HOURS;
      lines.push(meterLine(G, SVC, `Synapse Link for SQL: ${fmtN(c.synapseLinkVcores)} vCores x ${fmtN(hours)} hours`, single(inRegion.length ? inRegion : sl, 'Synapse Link for SQL'), n(c.synapseLinkVcores) * hours, ctx, { unit: 'vCore-hours' }));
    }

    if (n(c.ssisNodes)) {
      const ed = (c.ssisEdition || 'standard') === 'enterprise' ? 'Enterprise' : 'Standard';
      const lic = c.ssisLicense === 'hybrid' ? 'AHB' : 'License Included';
      // Standard and Enterprise nodes can share a meterId, which rows() would collapse; read them raw.
      const ssisAll = (await query(`serviceName eq '${SVC}' and ${regionFilter(ctx)} and priceType eq 'Consumption' and contains(productName, 'SSIS ${ed}')`, ctx.currency)).filter(r => r.productName.startsWith(`Azure Synapse SSIS ${ed} `));
      const wantV = n(c.ssisNodeVcpu ?? 4), wantM = n(c.ssisNodeMemoryGiB ?? 16);
      const offered = SSIS_SIZES.map(sz => ({ sz, row: ssisAll.find(r => r.meterName.endsWith(` ${lic}`) && normSize(r.skuName) === normSize(sz.name)) })).filter(x => x.row);
      const fit = offered.filter(x => x.sz.vcpu >= wantV && x.sz.mem >= wantM)
        .sort((a, b) => b.sz.rank - a.sz.rank || a.row.retailPrice - b.row.retailPrice);
      if (!fit.length) throw new PricingError(`The Azure-SSIS integration runtime has no ${ed} node size in ${ctx.region} with ${wantV} vCPUs and ${wantM} GiB of memory. Largest offered: ${offered.length ? Math.max(...offered.map(x => x.sz.vcpu)) + ' vCPUs' : 'none'}. Ask for fewer vCPUs or less memory.`);
      const vm = [fit[0].row];
      if (fit[0].sz.rank === 0) notes.push(`Azure-SSIS IR v2/A-series node ${fit[0].sz.name} is priced only because no v3 size has ${wantV} vCPUs and ${wantM} GiB; Learn says: "If you already use the v2 series nodes, please switch to use the v3 series nodes as soon as possible."`);
      notes.push(`The Azure-SSIS integration runtime offers only the node sizes on its Data Factory documentation list (Standard_A4_v2 to Standard_E64_v3), all older VM series with retirement announced; the service sets these sizes, so ${fit[0].sz.name} (${fit[0].sz.vcpu} vCPUs / ${fit[0].sz.mem} GiB) is the cheapest listed size that fits, preferring the v3 series as Learn recommends.`);
      const hours = c.ssisHours ?? HOURS;
      lines.push(meterLine(G, 'Azure Synapse SSIS', `Azure-SSIS ${ed} node ${vm[0].skuName} (${lic === 'AHB' ? 'Azure Hybrid Benefit' : 'license included'}): ${fmtN(c.ssisNodes)} node(s) x ${fmtN(hours)} hours`, single(vm, 'SSIS node'), n(c.ssisNodes) * hours, ctx, { unit: 'hours' }));
    }

    if (!lines.length) throw new PricingError('Nothing to price: set dedicatedDwu, serverlessTB, sparkNodes, dataFlowVcoreHours, synapseLinkVcores or a pipeline quantity.');
    if (n(c.sparkNodes) && c.sparkNodeSize === 'xxxlarge') notes.push('The XXXLarge (80 vCores) Spark node size (Isolate Compute) is only available in East US, West US 2, South Central US, US Gov Arizona and US Gov Virginia (Apache Spark pool configurations, Learn); confirm the region.');
    notes.push('Prices are for the Synapse service meters. Data Explorer pools (retired 7 October 2025), Compute Optimized data flows (retired 31 August 2024) and GPU Spark pools (deprecated) are not offered.');
    return { lines, notes, facts };
  }
};
