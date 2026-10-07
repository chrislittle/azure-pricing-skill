'use strict';
// Azure Data Factory (v2): pipeline orchestration and activities (Azure, self-hosted and managed VNet integration runtimes),
// data movement (DIU-hours), read/write and monitoring operations, inactive pipelines, mapping data flows
// (with optional 1- or 3-year reservations), SSIS integration runtime (Standard/Enterprise, license included or Azure Hybrid Benefit),
// and Managed Airflow. Not priced (no calculator offer or pricing-page price):
// ADF v1 (legacy), Wrangling Data Flow meters, Managed Airflow additional-node pricing (no Retail meter), Compute Optimized data flows, and the Retail 'Operations' meter
// (1M free band; the pricing page lists only Read/Write and Monitoring at 0.5 and 0.25 per 50,000, so those Cloud meters are used).
// Meters: serviceName 'Azure Data Factory v2', regional.
const { rows, single, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');

const n = v => Number(v || 0);
const hrs = c => c.hours ?? HOURS;
const IR = { azure: 'Cloud', 'self-hosted': 'Self Hosted', 'managed-vnet': 'Azure Managed VNET' };
const IR_LABEL = { azure: 'Azure integration runtime', 'self-hosted': 'self-hosted integration runtime', 'managed-vnet': 'managed virtual network integration runtime' };
const FLOW = { 'general-purpose': 'Azure Data Factory v2 Data Flow - General Purpose', 'memory-optimized': 'Azure Data Factory v2 Data Flow - Memory Optimized' };
const SSIS_SIZES = ['a1v2', 'a2v2', 'a4v2', 'a8v2', 'd1v2', 'd2v2', 'd3v2', 'd4v2', 'd2v3', 'd4v3', 'd8v3', 'd16v3', 'd32v3', 'd64v3', 'e2v3', 'e4v3', 'e8v3', 'e16v3', 'e32v3', 'e64v3', 'e64iv3', 'e80idsv4'];
const skuOf = s => { const m = s.match(/^([ade])(\d+)(i?d?s?)v(\d)$/); return `${m[1].toUpperCase()}${m[2]}${m[3]} v${m[4]}`; };

module.exports = {
  type: 'data-factory',
  label: 'Azure Data Factory',
  family: 'analytics',
  calculator: ['data-factory'],
  keywords: ['data factory', 'etl', 'pipelines', 'data movement', 'copy data', 'data flows', 'ssis', 'data integration', 'airflow'],
  fields: {
    activityRuns: { req: true, int: true, ask: 'Roughly how many activity runs a month? Every step of a pipeline that runs (copy, lookup, stored procedure, ForEach iteration...) is one run, and each trigger run and each debug run counts too. Example: 20 pipelines x 5 activities x 30 days x 4 times a day = 12,000. If unknown, suggest 10,000 and record it as an assumption.' },
    integrationRuntime: { def: 'azure', enum: ['azure', 'self-hosted', 'managed-vnet'], ask: 'Where does the work run? In Azure over public endpoints -> azure; on a machine in your own network or on-premises -> self-hosted; inside a private managed network (private endpoints) -> managed-vnet.' },
    dataMovementDiuHours: { def: 0, ask: 'How much copy work is done? Copy activities use data integration units (DIUs); multiply DIUs by hours. Example: 10 copies a day x 0.25 hours x 4 DIUs x 30 days = 300 DIU-hours. If unknown, suggest 100 DIU-hours and record it as an assumption.' },
    pipelineActivityHours: { def: 0, ask: 'Hours a month that non-copy activities (Lookup, Get Metadata, Delete, validation, web calls) execute inside Data Factory. Usually small; if unknown leave 0.' },
    externalActivityHours: { def: 0, ask: 'Hours a month that external activities run (stored procedures, Databricks, HDInsight, Synapse and other jobs that Data Factory only starts and monitors). If unknown leave 0.' },
    readWriteOperations: { def: 0, int: true, ask: 'Number of pipeline/dataset/linked-service entities created, read, updated or deleted a month (billed per 50,000). Usually tiny; leave 0 if unknown.' },
    monitoringOperations: { def: 0, int: true, ask: 'Number of pipeline, activity and trigger run records retrieved by monitoring a month (billed per 50,000). Usually tiny; leave 0 if unknown.' },
    inactivePipelines: { def: 0, int: true, ask: 'How many pipelines exist but have no trigger runs in a whole month? Each costs a small monthly fee.' },
    dataFlowVcores: { def: 0, int: true, ask: 'Mapping data flows (visual Spark transformations): how many vCores in the cluster? Choose 8, 16, 32, 48, 80, 144 or 272 (minimum 8). Leave 0 if they do not use data flows.' },
    dataFlowHours: { def: 0, ask: 'How many hours a month does the data flow cluster run (including time-to-live idle time)? Example: 3 runs a day x 0.5 hours x 30 days = 45 hours.' },
    cdcHours: { def: 0, ask: 'Only if they use change data capture (CDC) resources: how many hours a month do they run? CDC runs on a 4-vCore general-purpose cluster.' },
    dataFlowType: { def: 'general-purpose', enum: ['general-purpose', 'memory-optimized'], ask: 'What kind of data flow work? Typical joins and transformations -> general-purpose; very large joins/aggregations needing lots of memory -> memory-optimized.' },
    dataFlowCommitment: { def: 'payg', enum: ['payg', '1-year', '3-year'], ask: 'Only if data flows run most of the month: pay as you go, or a 1- or 3-year reservation ? Reservations for memory-optimized exist only in some regions. A reservation is billed for every hour of the term, so it only pays off if data flows run most of the month.' },
    ssisNodes: { def: 0, int: true, ask: 'Only if they run SSIS packages in Azure: how many nodes (virtual machines) in the SSIS integration runtime?' },
    ssisSize: { def: 'd4v3', enum: SSIS_SIZES, ask: 'SSIS only: VM size for each node. If unknown suggest d4v3 (4 vCPU, 16 GB) and record it as an assumption. Larger packages -> d8v3 or e8v3.' },
    ssisEdition: { def: 'standard', enum: ['standard', 'enterprise'], ask: 'SSIS only: do the packages need Enterprise features (for example advanced connectors and transforms)? If unsure, standard.' },
    ssisLicense: { def: 'license-included', enum: ['license-included', 'ahb'], ask: 'SSIS only: do you already own SQL Server licenses with Software Assurance (Azure Hybrid Benefit)? Yes -> ahb; otherwise license-included.' },
    airflowSize: { def: 'small', enum: ['small', 'large'], ask: 'Managed Airflow only: small or large environment?' },
    airflowEnvironments: { def: 0, int: true, ask: 'Only if they use Managed Airflow for workflow scheduling: how many Airflow environments?' },
    hours: { def: 730, ask: 'SSIS and Managed Airflow only: hours a month these run. 730 means all month; if they are started and stopped on a schedule, use the real hours.' }
  },
  context: ['production', 'steadyUsage'],
  examples: [
    { type: 'data-factory', activityRuns: 20000, dataMovementDiuHours: 300 },
    { type: 'data-factory', integrationRuntime: 'azure', activityRuns: 250000, dataMovementDiuHours: 1200, pipelineActivityHours: 40, externalActivityHours: 600, readWriteOperations: 200000, monitoringOperations: 300000, inactivePipelines: 12, dataFlowVcores: 16, dataFlowHours: 120, dataFlowType: 'memory-optimized', ssisNodes: 2, ssisSize: 'd4v3', ssisEdition: 'standard', ssisLicense: 'ahb', hours: 400, airflowEnvironments: 1, airflowSize: 'large' },
    { type: 'data-factory', integrationRuntime: 'self-hosted', activityRuns: 60000, dataMovementDiuHours: 500, pipelineActivityHours: 20, externalActivityHours: 100 },
    { type: 'data-factory', integrationRuntime: 'managed-vnet', activityRuns: 60000, dataMovementDiuHours: 500, pipelineActivityHours: 20, externalActivityHours: 100 },
    { type: 'data-factory', activityRuns: 10000, dataFlowVcores: 8, dataFlowHours: 730, dataFlowType: 'general-purpose', dataFlowCommitment: '1-year' },
    { type: 'data-factory', activityRuns: 10000, ssisNodes: 1, ssisSize: 'e8v3', ssisEdition: 'enterprise', ssisLicense: 'license-included' }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.activityRuns))} activity runs a month on the ${IR_LABEL[c.integrationRuntime || 'azure']}`];
    if (n(c.dataMovementDiuHours)) parts.push(`${fmtN(c.dataMovementDiuHours)} copy DIU-hours`);
    if (n(c.pipelineActivityHours)) parts.push(`${fmtN(c.pipelineActivityHours)} pipeline-activity hours`);
    if (n(c.externalActivityHours)) parts.push(`${fmtN(c.externalActivityHours)} external-activity hours`);
    if (n(c.readWriteOperations)) parts.push(`${fmtN(c.readWriteOperations)} read/write operations`);
    if (n(c.monitoringOperations)) parts.push(`${fmtN(c.monitoringOperations)} monitoring operations`);
    if (n(c.inactivePipelines)) parts.push(`${fmtN(c.inactivePipelines)} inactive pipelines`);
    if (n(c.dataFlowVcores)) parts.push(c.dataFlowCommitment && c.dataFlowCommitment !== 'payg' ? `data flows on ${fmtN(c.dataFlowVcores)} ${c.dataFlowType || 'general-purpose'} vCores with a ${c.dataFlowCommitment} reservation (billed all month)` : `data flows on ${fmtN(c.dataFlowVcores)} ${c.dataFlowType || 'general-purpose'} vCores for ${fmtN(n(c.dataFlowHours))} hours`);
    if (n(c.cdcHours)) parts.push(`change data capture for ${fmtN(c.cdcHours)} hours`);
    const h = hrs(c) < HOURS ? `${fmtN(hrs(c))} hours a month` : 'running all month';
    if (n(c.ssisNodes)) parts.push(`SSIS ${c.ssisEdition || 'standard'}: ${fmtN(c.ssisNodes)} x ${String(c.ssisSize || 'd4v3').toUpperCase()} node(s), ${c.ssisLicense === 'ahb' ? 'Azure Hybrid Benefit' : 'license included'}, ${h}`);
    if (n(c.airflowEnvironments)) parts.push(`${fmtN(c.airflowEnvironments)} ${c.airflowSize || 'small'} Managed Airflow environment(s), ${h}`);
    return `Data Factory: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : ['Storage, databases and compute that the pipelines read from, write to or start (Databricks, Synapse, SQL...), and the machine for a self-hosted integration runtime.', 'Data flows also bill the managed disk and blob storage used for execution and debugging, and copying data out of Azure incurs network bandwidth charges.']),
  price: async (c, ctx) => {
    const ir = (c.integrationRuntime || 'azure').toLowerCase();
    if (!IR[ir]) throw new PricingError(`Unknown integrationRuntime "${ir}". Use azure, self-hosted or managed-vnet.`);
    const flowType = (c.dataFlowType || 'general-purpose').toLowerCase();
    if (!FLOW[flowType]) throw new PricingError(`Unknown dataFlowType "${flowType}".`);
    const vcores = n(c.dataFlowVcores);
    if (vcores && ![8, 16, 32, 48, 80, 144, 272].includes(vcores)) throw new PricingError(`Data flow clusters come in 8, 16, 32, 48, 80, 144 or 272 vCores; got ${vcores}.`);
    const commit = (c.dataFlowCommitment || 'payg').toLowerCase();
    if (!['payg', '1-year', '3-year'].includes(commit)) throw new PricingError('dataFlowCommitment must be payg, 1-year or 3-year.');
    const rs = await rows(`serviceName eq 'Azure Data Factory v2' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Data Factory v2 is not priced in ${ctx.region}.`);
    const adf = rs.filter(r => r.productName === 'Azure Data Factory v2');
    const pick = (meter, what) => single(adf.filter(r => r.meterName === meter), `Data Factory ${what}`);
    const pickRe = (re, what) => single(adf.filter(r => re.test(r.meterName)), `Data Factory ${what}`);
    const G = 'Analytics', S = 'Azure Data Factory v2', lines = [], notes = [];
    const P = IR[ir], L = IR_LABEL[ir];
    lines.push(meterLine(G, S, `Orchestration activity runs on the ${L}: ${fmtN(n(c.activityRuns))}/month`, pick(`${P} Orchestration Activity Run`, 'orchestration activity runs'), n(c.activityRuns), ctx));
    if (n(c.dataMovementDiuHours)) lines.push(meterLine(G, S, `Copy data movement on the ${L}: ${fmtN(c.dataMovementDiuHours)} DIU-hours`, pick(`${P} Data Movement`, 'data movement'), n(c.dataMovementDiuHours), ctx, { unit: 'DIU-hours' }));
    if (n(c.pipelineActivityHours)) lines.push(meterLine(G, S, `Pipeline activities on the ${L}: ${fmtN(c.pipelineActivityHours)} hours`, pick(`${P} Pipeline Activity`, 'pipeline activity'), n(c.pipelineActivityHours), ctx, { unit: 'hours' }));
    if (n(c.externalActivityHours)) lines.push(meterLine(G, S, `External pipeline activities on the ${L}: ${fmtN(c.externalActivityHours)} hours`, pick(`${P} External Pipeline Activity`, 'external pipeline activity'), n(c.externalActivityHours), ctx, { unit: 'hours' }));
    if (n(c.readWriteOperations)) lines.push(meterLine(G, S, `Read/write operations: ${fmtN(c.readWriteOperations)}/month`, pickRe(/Read Write Operations$/, 'read/write operations'), n(c.readWriteOperations), ctx));
    if (n(c.monitoringOperations)) lines.push(meterLine(G, S, `Monitoring operations: ${fmtN(c.monitoringOperations)}/month`, pickRe(/Monitoring Operations$/, 'monitoring operations'), n(c.monitoringOperations), ctx));
    if (n(c.inactivePipelines)) lines.push(meterLine(G, S, `Inactive pipelines: ${fmtN(c.inactivePipelines)}`, pickRe(/^Inactive Pipeline$/, 'inactive pipelines'), n(c.inactivePipelines), ctx, { unit: 'pipelines / month' }));
    notes.push('Orchestration is billed per 1,000 activity runs, copy work per DIU-hour, and other activities per activity-hour (a started activity is rounded up to the next minute).');
    const facts = { integrationRuntime: ir, activityRuns: n(c.activityRuns), dataFlowVcores: vcores, dataFlowCommitment: commit, dataFlowHours: n(c.dataFlowHours), ssisNodes: n(c.ssisNodes), hours: hrs(c) };
    if (vcores) {
      const dfHours = n(c.dataFlowHours);
      if (commit === 'payg') {
        if (dfHours <= 0) throw new PricingError('dataFlowHours is needed to price data flows.');
        const dfRows = rs.filter(r => r.productName === FLOW[flowType]);
        lines.push(meterLine(G, S, `Data flows (${flowType}): ${fmtN(vcores)} vCores x ${fmtN(dfHours)} hours`, single(dfRows, `${flowType} data flow vCore`), vcores * dfHours, ctx, { unit: 'vCore-hours' }));
        notes.push('Data flows bill vCores x the hours the cluster is up, including time-to-live idle time; the smallest cluster is 8 vCores.');
      } else {
        const term = commit === '1-year' ? '1 Year' : '3 Years';
        const rr = await rows(`serviceName eq 'Azure Data Factory v2' and ${regionFilter(ctx)} and priceType eq 'Reservation' and productName eq '${FLOW[flowType]}'`, ctx);
        const row = rr.find(r => r.reservationTerm === term);
        if (!row) throw new PricingError(`No ${term} data flow reservation price in ${ctx.region}.`);
        const months = termMonths(term);
        const monthly = row.retailPrice / months;
        lines.push(line(G, S, `Data flows (${flowType}): ${fmtN(vcores)} reserved vCores, ${term} reservation`, vcores, 'vCores / month', monthly, monthly * vcores, meterInfo(row), { termTotal: row.retailPrice }));
        notes.push(`${term} reservation: ${row.retailPrice} is the whole-term price per vCore, divided by ${months} months. Billed for every hour whether or not data flows run (dataFlowHours is not used).`);
        if (dfHours && dfHours < HOURS) facts.commitmentUnderused = true;
      }
    }
    if (n(c.cdcHours)) {
      const gp = rs.filter(r => r.productName === FLOW['general-purpose']);
      lines.push(meterLine(G, S, `Change data capture: 4 vCores x ${fmtN(c.cdcHours)} hours (general-purpose rate)`, single(gp, 'general-purpose data flow vCore'), 4 * n(c.cdcHours), ctx, { unit: 'vCore-hours' }));
    }
    if (n(c.ssisNodes)) {
      const size = (c.ssisSize || 'd4v3').toLowerCase();
      if (!SSIS_SIZES.includes(size)) throw new PricingError(`Unknown ssisSize "${size}".`);
      const edition = (c.ssisEdition || 'standard').toLowerCase();
      if (!['standard', 'enterprise'].includes(edition)) throw new PricingError('ssisEdition must be standard or enterprise.');
      const lic = (c.ssisLicense || 'license-included').toLowerCase();
      if (!['license-included', 'ahb'].includes(lic)) throw new PricingError('ssisLicense must be license-included or ahb.');
      const sku = skuOf(size);
      const ssis = await rows(`serviceName eq 'Azure Data Factory v2' and ${regionFilter(ctx)} and priceType eq 'Consumption' and skuName eq '${sku}' and contains(productName, 'SSIS ${edition === 'enterprise' ? 'Enterprise' : 'Standard'}')`, ctx);
      const meter = `${sku} ${lic === 'ahb' ? 'AHB' : 'License Included'}`;
      const hours = hrs(c);
      lines.push(meterLine(G, S, `SSIS integration runtime ${edition}, ${sku}${lic === 'ahb' ? ' with Azure Hybrid Benefit' : ' (license included)'}: ${fmtN(c.ssisNodes)} node(s) x ${fmtN(hours)} hours`, single(ssis.filter(r => r.meterName === meter), `SSIS ${edition} ${meter}`), n(c.ssisNodes) * hours, ctx, { unit: 'hours' }));
      notes.push('The SSIS integration runtime bills per node-hour while it is running; stop it when not in use. With Azure Hybrid Benefit you pay only the VM rate and bring your own SQL Server licenses.');
      facts.ssisLicense = lic;
    }
    if (n(c.airflowEnvironments)) {
      const size = (c.airflowSize || 'small').toLowerCase();
      if (!['small', 'large'].includes(size)) throw new PricingError('airflowSize must be small or large.');
      const af = rs.filter(r => /Managed Airflow$/.test(r.productName) && r.skuName.toLowerCase() === size);
      const hours = hrs(c);
      lines.push(meterLine(G, S, `Managed Airflow ${size}: ${fmtN(c.airflowEnvironments)} environment(s) x ${fmtN(hours)} hours`, single(af, `Managed Airflow ${size}`), n(c.airflowEnvironments) * hours, ctx, { unit: 'hours' }));
      notes.push('Managed Airflow environments bill per environment-hour while they exist.');
    }
    notes.push('Not priced: Wrangling data flows, extra Managed Airflow worker nodes, legacy Data Factory v1 and the Retail "Operations" meter with a 1M free band (the pricing page lists only Read/Write and Monitoring operations, without a free grant).');
    return { lines, notes, facts };
  }
};
