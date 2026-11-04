'use strict';
// Plain-language readback of every quantity in a spec. The person must see it and reply before
// the engine will build, so a wrong number (20 TB of storage instead of 2 TB) gets caught by them.
const crypto = require('crypto');
const vmSizes = require('../../catalog/vm-sizes.json');
const REG = require('../../catalog/regions.json');
const { expandSpec } = require('./expand');

const n = v => Number(v).toLocaleString('en-US');
const big = v => v >= 1e6 ? `${n(v)} (${(v / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} million)` : n(v);
const gb = v => v >= 1024 ? `${n(v)} GB (about ${(v / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} TB)` : `${n(v)} GB`;
const hrs = h => h === 0 ? 'not running (0 hours)' : (h == null || h === 730) ? 'running all month' : `${n(h)} hours a month`;
const COMMIT = { payg: 'pay-as-you-go', ri1y: '1-year reservation', ri3y: '3-year reservation', sp1y: '1-year savings plan', sp3y: '3-year savings plan' };
const OS = { linux: 'Linux', windows: 'Windows (license included)', 'windows-ahb': 'Windows (your own licenses, Azure Hybrid Benefit)', rhel: 'Red Hat Enterprise Linux', 'rhel-byos': 'Red Hat (your own subscription)', sles: 'SUSE Linux', 'ubuntu-pro': 'Ubuntu Pro', 'rhel-ha': 'Red Hat Enterprise Linux with high availability', 'rhel-sap': 'Red Hat Enterprise Linux for SAP Business Applications', 'rhel-sap-ha': 'Red Hat Enterprise Linux for SAP with high availability', 'sles-sap': 'SUSE Linux Enterprise Server for SAP Applications', 'sles-hpc': 'SUSE Linux Enterprise Server for HPC', 'sles-basic': 'SUSE Linux (patching only)' };
const DISK = { 'standard-hdd': 'Standard HDD', 'standard-ssd': 'Standard SSD', 'premium-ssd': 'Premium SSD', 'premium-v2': 'Premium SSD v2' };
const cnt = c => (c.count || 1) > 1 ? `${c.count} x ` : '';

const LINE = {
  vm: c => { const s = vmSizes[c.sku]; return `${cnt(c)}server ${c.sku}${s ? ` (${s.v} vCPU${(m => m && Number(m[1]) < s.v ? `, only ${m[1]} active and licensed` : '')(/-(\d+)(?=[a-z_]|$)/i.exec(String(c.sku).replace(/^Standard_/, '')))}, ${s.m} GiB memory)` : ''}, ${OS[c.os || 'linux'] || c.os}, ${hrs(c.hours)}, ${COMMIT[c.commitment || 'payg']}${c.sqlLicense && c.sqlLicense !== 'none' ? `, SQL Server ${c.sqlLicense} license included` : ''}${c.biztalk && c.biztalk !== 'none' ? `, BizTalk Server ${c.biztalk}` : ''}${c.oracleJava ? ', Oracle Java SE subscription' : ''}${c.licenseTerm && c.licenseTerm !== 'payg' ? `, ${c.licenseTerm === '1y' ? '1-year' : '3-year'} software subscription for the Linux license` : ''}`; },
  disk: c => `${cnt(c)}${DISK[c.diskType || 'standard-ssd']} disk${c.role ? ` (${c.role})` : ''}, ${gb(c.sizeGiB)} each${c.iops ? `, ${n(c.iops)} IOPS` : ''}${c.throughputMBps ? `, ${n(c.throughputMBps)} MB/s` : ''}, ${(c.redundancy || 'LRS') === 'ZRS' ? 'zone-redundant' : 'locally redundant'}${c.commitment === 'ri1y' ? ', 1-year reservation' : ''}${c.bursting ? `, on-demand bursting${c.burstIops ? ` up to ${n(c.burstIops)} IOPS` : ''} (${n(c.burstMinutesPerDay ?? 30)} minutes a day, ${n(c.burstDaysPerMonth ?? 22)} days a month)` : ''}${c.additionalMounts ? `, shared by ${n(c.additionalMounts)} extra VM(s)` : ''}${c.confidential ? ', confidential OS disk encryption' : ''}${c.transactionsPerMonth ? `, ${big(c.transactionsPerMonth)} transactions a month` : ''}`,
  'public-ip': c => `${c.count === 0 ? 'No single public IPs' : `${cnt(c)}public IP address`}${c.tier && c.tier !== 'standard' ? ` (${c.tier})` : ''}${c.hours != null && c.hours !== 730 ? `, ${hrs(c.hours)}` : ''}${c.prefixAddresses ? `, plus a reserved block of ${n(c.prefixAddresses)} ${c.prefixTier || 'standard'} public IP addresses (prefix${c.prefixAddresses > 16 ? '; above the 16-address default, needs a quota increase request per Learn' : ''})` : ''}`,
  bandwidth: c => `Data sent out to the internet: ${gb(c.egressGB)} per month${c.guess ? ' (an assumption)' : ''}`,
  'load-balancer': c => `${c.tier === 'global' ? 'Global (cross-region) Load Balancer' : 'Standard Load Balancer'}, ${n(c.rules ?? 5)} rules${c.tier === 'global' ? '' : `, ${gb(c.processedGB || 0)} processed per month`}${c.hours != null && c.hours !== 730 ? `, ${hrs(c.hours)}` : ''}`,
  'app-gateway': c => c.tier === 'basic-v2' ? `Application Gateway Basic v2 (no web application firewall), ${n(c.capacityUnits || 1)} capacity unit(s)${c.hours != null && c.hours !== 730 ? `, ${hrs(c.hours)}` : ''}` : `Application Gateway${c.waf === false ? ' without' : ' with'} web application firewall, ${n(c.capacityUnits || 1)} capacity unit(s)${c.captchaSessions ? `, ${big(c.captchaSessions)} CAPTCHA sessions per month` : ''}${c.hours != null && c.hours !== 730 ? `, ${hrs(c.hours)}` : ''}`,
  aks: c => `${c.count > 1 ? c.count + ' x ' : ''}Kubernetes (AKS) cluster management, ${c.tier || 'free'} tier${c.hours != null && c.hours !== 730 ? `, ${hrs(c.hours)}` : ''}`,
  'app-service': c => `${cnt(c)}App Service plan ${c.plan}, ${c.os || 'linux'}, ${hrs(c.hours)}${c.commitment && c.commitment !== 'payg' ? `, ${COMMIT[c.commitment]}` : ''}${c.ipSslConnections ? `, ${n(c.ipSslConnections)} IP SSL connection(s)` : ''}${c.customDomains ? `, ${n(c.customDomains)} new domain(s)` : ''}${c.standardCertificates ? `, ${n(c.standardCertificates)} standard SSL certificate(s)` : ''}${c.wildcardCertificates ? `, ${n(c.wildcardCertificates)} wildcard SSL certificate(s)` : ''}`,
  functions: c => `Azure Functions (${c.plan || 'consumption'}): ${big(c.executions)} calls per month${c.gbSeconds ? `, ${big(c.gbSeconds)} GB-seconds` : c.durationMs ? `, ${n(c.durationMs)} ms${c.memoryMB && c.plan !== 'flex' ? ` and ${n(c.memoryMB)} MB` : ''} per call` : ''}${c.plan === 'flex' ? `, ${n(c.instanceMemoryMB || 2048)} MB instances${c.instanceMemoryMB ? '' : ' (default)'}` : ''}${c.alwaysReadyInstances ? `, ${n(c.alwaysReadyInstances)} always-ready instance(s)` : ''}${c.alwaysReadyExecutions ? `, ${big(c.alwaysReadyExecutions)} always-ready calls` : ''}${c.commitment && c.commitment !== 'payg' ? `, ${c.commitment === 'sp1y' ? '1-year' : '3-year'} savings plan` : ''}`,
  'container-apps': c => `${n(c.apps || 1)} container app(s), each ${c.vcpu ?? 0.5} vCPU and ${c.memGiB ?? 1} GiB, at least ${n(c.replicas ?? 1)} copy running, ${big(c.requests || 0)} requests per month in total`,
  'sql-database': c => `Azure SQL Database ${c.tier || 'general-purpose'}${c.compute === 'serverless' ? ' serverless' : ''}, ${n(c.vcores)} vCores${c.compute === 'serverless' ? ' max' : ''}, ${gb(c.storageGB || 32)} storage, ${c.ahb ? 'your own SQL licenses' : 'SQL license included'}${c.hardware && c.hardware !== 'standard-series' ? `, ${c.hardware}` : ''}${c.zoneRedundant ? ', zone redundant' : ''}${c.haReplicas ? `, ${n(c.haReplicas)} HA replica(s)` : ''}${c.namedReplicas ? `, ${n(c.namedReplicas)} named replica(s)` : ''}${c.commitment && c.commitment !== 'payg' ? `, ${COMMIT[c.commitment] || c.commitment}` : ''}${c.compute === 'serverless' && c.activeHoursPerMonth ? `, active ${n(c.activeHoursPerMonth)} h/month` : ''}${c.backupStorageGB ? `, ${gb(c.backupStorageGB)} backup storage` : ''}${c.ltrStorageGB ? `, ${gb(c.ltrStorageGB)} long-term retention` : ''}`,
  'sql-mi': c => `SQL Managed Instance ${c.tier || 'general-purpose'}, ${n(c.vcores)} vCores, ${gb(c.storageGB || 32)} storage, ${c.ahb ? 'your own SQL licenses' : 'SQL license included'}`,
  postgres: c => `PostgreSQL ${c.tier || 'general-purpose'}, ${n(c.vcores)} vCores, ${gb(c.storageGB || 128)} storage, ${c.ha ? 'with' : 'without'} high availability${c.readReplicas ? `, ${n(c.readReplicas)} read replica(s)` : ''}${c.commitment && c.commitment !== 'payg' ? `, ${COMMIT[c.commitment] || c.commitment}` : ''}${c.storageType === 'premium-ssd-v2' ? ', Premium SSD v2 storage' : c.storageType === 'ultra-disk' ? ', Ultra Disk storage' : ''}${c.autonomousTuning ? ', autonomous tuning' : ''}${c.acceleratedLogs ? ', accelerated logs' : ''}${c.backupStorageGB ? `, ${gb(c.backupStorageGB)} backup storage` : ''}${c.extendedSupport ? ', extended support' : ''}`,
  mysql: c => `MySQL ${c.tier || 'general-purpose'}, ${n(c.vcores)} vCores, ${gb(c.storageGB || 128)} storage, ${c.ha ? 'with' : 'without'} high availability${c.readReplicas ? `, ${n(c.readReplicas)} read replica(s)` : ''}${c.commitment && c.commitment !== 'payg' ? `, ${COMMIT[c.commitment] || c.commitment}` : ''}${c.storageType === 'premium-ssd-v2' ? ', Premium SSD v2 storage' : c.storageType === 'ultra-disk' ? ', Ultra Disk storage' : ''}${c.autonomousTuning ? ', autonomous tuning' : ''}${c.acceleratedLogs ? ', accelerated logs' : ''}${c.backupStorageGB ? `, ${gb(c.backupStorageGB)} backup storage` : ''}${c.extendedSupport ? ', extended support' : ''}`,
  cosmos: c => `Cosmos DB ${c.mode || 'autoscale'}${c.maxRU ? `, up to ${n(c.maxRU)} RU/s${c.averageUtilizationPct ? ` at ${n(c.averageUtilizationPct)}% average` : ''}` : c.mode === 'provisioned' ? `, ${n(c.ru || 400)} RU/s` : c.ru ? `, ${n(c.ru)} RU/s` : c.requestUnits ? `, ${big(c.requestUnits)} RUs per month` : ''}, ${gb(c.storageGB || 0)} stored, ${n(c.regions || 1)} region(s)${c.multiRegionWrites ? ', multi-region writes' : ''}${c.perPartitionFailover ? ', per-partition automatic failover' : ''}${c.zoneRedundantRegions ?? c.zoneRedundant ? `, availability zones in ${c.zoneRedundantRegions ?? n(c.regions || 1)} region(s)` : ''}${c.freeTier ? ', free tier' : ''}${c.commitment && c.commitment !== 'payg' ? `, ${c.commitment === 'ri1y' ? '1-year' : '3-year'} reserved capacity` : ''}${c.backup && c.backup !== 'periodic' ? `, ${c.backup} backup` : ''}${c.analyticalStorageGB ? `, ${gb(c.analyticalStorageGB)} analytical store` : ''}${c.gatewaySku ? `, dedicated gateway ${c.gatewaySku} x ${n(c.gatewayNodes || 1)}` : ''}${c.semanticRerankerQueries ? `, ${big(c.semanticRerankerQueries)} semantic reranker queries` : ''}`,
  blob: c => { const ops = [c.readOps && `${big(c.readOps)} reads`, c.writeOps && `${big(c.writeOps)} writes`, c.retrievalGB && `${gb(c.retrievalGB)} retrieved`].filter(Boolean); if (c.otherOps) ops.push(`${big(c.otherOps)} other operations`); if (c.priorityReadOps) ops.push(`${big(c.priorityReadOps)} high-priority archive reads`); if (c.priorityRetrievalGB) ops.push(`${gb(c.priorityRetrievalGB)} high-priority retrieved`); if (c.sftpHours) ops.push(`SFTP enabled ${c.sftpHours} hours`); if (c.listOps) ops.push(`${big(c.listOps)} list operations`); if (c.iterativeWriteOps) ops.push(`${big(c.iterativeWriteOps)} directory writes`); if (c.iterativeReadOps) ops.push(`${big(c.iterativeReadOps)} directory reads`); if (c.indexTags) ops.push(`${big(c.indexTags)} index tags`); return `Blob storage${c.namespace === 'hierarchical' ? ' (hierarchical namespace)' : ''}: ${gb(c.capacityGB)} stored, ${c.tier || 'Hot'} tier, ${c.redundancy || 'LRS'}${c.commitment && c.commitment !== 'payg' ? `, ${c.commitment === 'ri3y' ? '3-year' : '1-year'} reserved capacity` : ''}${ops.length ? `; ${ops.join(', ')} per month` : ''}`; },
  files: c => `Azure Files (${c.model || 'provisioned-v2-hdd'}): ${gb(c.capacityGB)}, ${c.redundancy || 'LRS'}${c.snapshotGB ? `, ${gb(c.snapshotGB)} of snapshots` : ''}${String(c.model || 'provisioned-v2-hdd').startsWith('provisioned-v2') ? `, ${c.iops != null ? n(c.iops) + ' IOPS' : 'recommended IOPS'}, ${c.throughputMBps != null ? n(c.throughputMBps) + ' MiB/s' : 'recommended throughput'}` : ''}${c.writeOps ? `, ${big(c.writeOps)} writes` : ''}${c.readOps ? `, ${big(c.readOps)} reads` : ''}${c.listOps ? `, ${big(c.listOps)} list operations` : ''}${c.otherOps ? `, ${big(c.otherOps)} other operations` : ''}${c.metadataGB ? `, ${gb(c.metadataGB)} metadata` : ''}${c.retrievalGB ? `, ${gb(c.retrievalGB)} retrieved` : ''}${c.geoReplicationGB ? `, ${gb(c.geoReplicationGB)} geo-replicated` : ''}${c.softDeletedGB ? `, ${gb(c.softDeletedGB)} soft-deleted` : ''}${c.burstBandwidthGiB ? `, ${n(c.burstBandwidthGiB)} GiB burst bandwidth` : ''}${c.burstTransactionsMillions ? `, ${n(c.burstTransactionsMillions)}M burst transactions` : ''}${c.commitment && c.commitment !== 'payg' ? `, ${c.commitment === 'ri1y' ? '1-year' : '3-year'} reserved capacity` : ''}`,
  'log-analytics': c => `Log Analytics: ${n(c.ingestGBPerDay)} GB of logs per day, kept ${n(c.retentionDays || 31)} days${(c.retentionDays || 0) > 730 ? ` (730 interactive + ${n(c.retentionDays - 730)} long-term)` : ''}${c.commitmentTier ? `, ${n(c.commitmentTier)} GB/day commitment tier` : ''}${c.basicLogsGBPerDay ? `, ${n(c.basicLogsGBPerDay)} GB/day Basic Logs` : ''}${c.auxiliaryLogsGBPerDay ? `, ${n(c.auxiliaryLogsGBPerDay)} GB/day Auxiliary Logs` : ''}${c.searchQueryScannedGB || c.searchJobScannedGB ? `, ${gb((c.searchQueryScannedGB || 0) + (c.searchJobScannedGB || 0))} scanned by queries and search jobs` : ''}${c.restoreGB ? `, ${gb(c.restoreGB)} restored for ${n(c.restoreDays ?? 1)} day(s)` : ''}${c.exportGBPerDay ? `, ${n(c.exportGBPerDay)} GB/day exported` : ''}${c.archiveGB ? `, ${gb(c.archiveGB)} archived` : ''}${c.replicatedGBPerDay ? `, ${n(c.replicatedGBPerDay)} GB/day replicated to a second region` : ''}${c.transformIncomingGBPerDay ? `, ${n(c.transformIncomingGBPerDay)} GB/day through transformations dropping ${n(c.transformDroppedPct || 0)}%` : ''}`,
  openai: c => `AI model ${c.model}${c.deployment && c.deployment !== 'global' ? `, ${c.deployment} deployment` : ''}${c.processing && c.processing !== 'standard' ? `, ${c.processing} processing` : ''}${c.fineTuned ? ', fine-tuned' : ''}: ${big(c.inputTokens)} input tokens and ${big(c.outputTokens)} output tokens per month${c.cachedInputTokens ? `, ${big(c.cachedInputTokens)} cached` : ''}${c.cacheWriteTokens ? `, ${big(c.cacheWriteTokens)} cache writes` : ''}${c.cachedAudioInputTokens ? `, ${big(c.cachedAudioInputTokens)} cached audio input` : ''}${c.cachedImageInputTokens ? `, ${big(c.cachedImageInputTokens)} cached image input` : ''}${c.longContextInputTokens ? `, ${big(c.longContextInputTokens)} long-context input` : ''}${c.longContextCachedInputTokens ? `, ${big(c.longContextCachedInputTokens)} long-context cached` : ''}${c.longContextCacheWriteTokens ? `, ${big(c.longContextCacheWriteTokens)} long-context cache writes` : ''}${c.longContextOutputTokens ? `, ${big(c.longContextOutputTokens)} long-context output` : ''}${c.audioInputTokens ? `, ${big(c.audioInputTokens)} audio input` : ''}${c.audioOutputTokens ? `, ${big(c.audioOutputTokens)} audio output` : ''}${c.imageInputTokens ? `, ${big(c.imageInputTokens)} image input` : ''}${c.imageOutputTokens ? `, ${big(c.imageOutputTokens)} image output` : ''}${c.videoSeconds ? `, ${n(c.videoSeconds)} seconds of video` : ''}${c.imageCount ? `, ${n(c.imageCount)} images${c.imageQuality ? ' (' + c.imageQuality + (c.imageSize ? ', ' + c.imageSize : '') + ')' : ''}` : ''}${c.codeInterpreterSessions ? `, ${n(c.codeInterpreterSessions)} code interpreter sessions` : ''}${c.fileSearchCalls ? `, ${n(c.fileSearchCalls)} file search calls` : ''}${c.fileSearchStorageGBDays ? `, ${n(c.fileSearchStorageGBDays)} GB-days file search storage` : ''}${c.trainingTokens ? `, ${big(c.trainingTokens)} training tokens` : ''}${c.hostingHours ? `, ${n(c.hostingHours)} hosting hours` : ''}`,
  meter: c => `${c.desc || (c.filter && c.filter.meterName) || 'Other meter'}: ${c.hours != null ? `${n(c.quantity)} x ${n(c.hours)} hours (${hrs(c.hours)})` : big(c.quantity)}`
};
const SERVICES = require('./services');
for (const [t, s] of Object.entries(SERVICES)) LINE[t] = s.readback;

function readback(spec) {
  const region = String(spec.region || '').toLowerCase().replace(/\s+/g, '');
  const CTXL = { production: ['Production workload', 'Development or test'], internetFacing: ['Reached from the internet', 'Reached only from your network'], interruptible: ['Can be stopped and restarted if Azure needs the capacity', 'Must not be interrupted'], steadyUsage: ['Long-term, steady use (1 year or more)', 'Usage may change; no long-term commitment'], idlePeriods: ['Idle for long stretches (nights or weekends)', 'Busy most of the time'], zoneResilience: ['Must survive a datacenter failure', 'Single datacenter is acceptable'], privateOnly: ['Private network access only', 'Public access allowed'], multiRegionUsers: ['Users in several countries or continents', 'Users mostly in one area'] };
  const ctx = Object.entries(spec.context || {}).filter(([k, v]) => CTXL[k] && typeof v === 'boolean').map(([k, v]) => CTXL[k][v ? 0 : 1]);
  const head = [
    `Region: ${REG[region] || spec.region}`,
    `Discount: ${spec.discountPct ? `${spec.discountPct}% off list` : 'none (list prices)'}${spec.currency && spec.currency.toUpperCase() !== 'USD' ? `, priced in ${spec.currency.toUpperCase()}` : ''}`,
    ...(ctx.length ? [`About the workload: ${ctx.join('; ')}`] : [])
  ];
  spec = expandSpec(spec);
  const opts = (spec.options || []).map(o => {
    const phase = o.scenario.phase && o.scenario.phase !== o.scenario.name ? ` (${o.scenario.phase})` : '';
    const context = Object.entries(o.context || {}).filter(([k, v]) => CTXL[k] && typeof v === 'boolean').map(([k, v]) => CTXL[k][v ? 0 : 1]);
    return { name: `${o.scenario.name}${phase} - ${o.purchasing}`, lines: [
      ...(context.length ? [`For this scope: ${context.join('; ')}`] : []),
      ...(o.components || []).map(c => (LINE[c.type] || (() => c.type))(c, spec))
    ] };
  });
  const missing = notIncluded(spec);
  const said = spec.customerSaid && spec.customerSaid.requirements ? String(spec.customerSaid.requirements).replace(/\s+/g, ' ').trim() : '';
  const canon = JSON.stringify([head, opts, missing, spec.replacedSizes || []]);
  const code = 'AZP-' + crypto.createHash('sha256').update(canon).digest('hex').slice(0, 6).toUpperCase();
  const text = [
    'Before I price this, please check these numbers against what you told me:',
    ...(said ? [`You told me: "${said}"`] : []),
    ...head.map(h => `- ${h}`),
    ...opts.flatMap(o => [`${o.name}`, ...o.lines.map(l => `  - ${l}`)]),
    ...((spec.replacedSizes || []).length ? ['Sizes replaced:', ...spec.replacedSizes.map(r => `  - You mentioned ${r.requested}, which Microsoft lists as End of Life; priced ${r.priced} instead`)] : []),
    ...(missing.length ? ['Not included:', ...missing.map(m => `  - ${m}`)] : []),
    `Is every number right, and is anything missing? (check ${code})`
  ].join('\n');
  return { code, text };
}

// Components that usually come together. Listed so the person can spot what was left out.
function notIncluded(spec) {
  const scopes = new Map();
  for (const [i, o] of (spec.options || []).entries()) {
    const id = o.scenario ? o.scenario.id : i;
    if (!scopes.has(id)) scopes.set(id, []);
    scopes.get(id).push(o);
  }
  if (scopes.size > 1) return [...scopes.values()].flatMap(options => {
    const first = options[0];
    const name = first.scenario ? first.scenario.name : first.name;
    return notIncluded(Object.assign({}, spec, { options, context: Object.assign({}, spec.context, first.context) })).map(m => `${name}: ${m}`);
  });
  spec = Object.assign({}, spec, { context: Object.assign({}, spec.context, spec.options && spec.options[0] && spec.options[0].context) });
  const types = new Set((spec.options || []).flatMap(o => (o.components || []).map(c => c.type)));
  const has = (...t) => t.some(x => types.has(x));
  const excluded = (spec.excluded || []).map(String);
  const isExcl = re => excluded.some(e => re.test(e));
  const out = [];
  if (has('bandwidth') && !has('blob', 'files', 'vm', 'app-service', 'container-apps', 'aks', 'functions', 'meter')) out.push('Where the data is stored or served from (no storage or server is priced)');
  if (has('vm') && !has('disk', 'aks') && !isExcl(/disk|storage/i)) out.push('Disks for the servers (every server needs at least an operating system disk)');
  if (has('aks') && !has('vm')) out.push('The node servers that run the Kubernetes workloads');
  if (has('load-balancer', 'app-gateway') && !has('vm', 'app-service', 'aks', 'container-apps')) out.push('The servers or apps behind the load balancer or gateway');
  if (spec.context && spec.context.internetFacing && !has('bandwidth') && has('vm', 'blob', 'app-service', 'container-apps', 'aks') && !isExcl(/egress|bandwidth|data transfer|internet/i)) out.push('Data sent out to the internet each month');
  for (const [t, s] of Object.entries(SERVICES)) if (types.has(t) && s.notIncluded) for (const m of s.notIncluded(types, spec) || []) if (!out.includes(m)) out.push(m);
  for (const e of excluded) out.push(`${e} (as agreed)`);
  return out;
}

module.exports = { readback, notIncluded };
