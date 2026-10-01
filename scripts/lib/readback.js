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
const hrs = h => (h || 730) >= 730 ? 'running all month' : `${n(h)} hours a month`;
const COMMIT = { payg: 'pay-as-you-go', ri1y: '1-year reservation', ri3y: '3-year reservation', sp1y: '1-year savings plan', sp3y: '3-year savings plan' };
const OS = { linux: 'Linux', windows: 'Windows (license included)', 'windows-ahb': 'Windows (your own licenses, Azure Hybrid Benefit)', rhel: 'Red Hat Enterprise Linux', 'rhel-byos': 'Red Hat (your own subscription)', sles: 'SUSE Linux' };
const DISK = { 'standard-hdd': 'Standard HDD', 'standard-ssd': 'Standard SSD', 'premium-ssd': 'Premium SSD', 'premium-v2': 'Premium SSD v2' };
const cnt = c => (c.count || 1) > 1 ? `${c.count} x ` : '';

const LINE = {
  vm: c => { const s = vmSizes[c.sku]; return `${cnt(c)}server ${c.sku}${s ? ` (${s.v} vCPU, ${s.m} GiB memory)` : ''}, ${OS[c.os || 'linux'] || c.os}, ${hrs(c.hours)}, ${COMMIT[c.commitment || 'payg']}`; },
  disk: c => `${cnt(c)}${DISK[c.diskType || 'standard-ssd']} disk${c.role ? ` (${c.role})` : ''}, ${gb(c.sizeGiB)} each${c.iops ? `, ${n(c.iops)} IOPS` : ''}${c.throughputMBps ? `, ${n(c.throughputMBps)} MB/s` : ''}, ${(c.redundancy || 'LRS') === 'ZRS' ? 'zone-redundant' : 'locally redundant'}`,
  'public-ip': c => `${cnt(c)}public IP address`,
  bandwidth: c => `Data sent out to the internet: ${gb(c.egressGB)} per month${c.guess ? ' (an assumption)' : ''}`,
  'load-balancer': c => `Standard Load Balancer, ${n(c.rules || 5)} rules, ${gb(c.processedGB || 0)} processed per month`,
  'app-gateway': c => `Application Gateway${c.waf === false ? ' without' : ' with'} web application firewall, ${n(c.capacityUnits || 1)} capacity unit(s)`,
  aks: c => `Kubernetes (AKS) cluster management, ${c.tier || 'free'} tier`,
  'app-service': c => `${cnt(c)}App Service plan ${c.plan}, ${c.os || 'linux'}, ${hrs(c.hours)}`,
  functions: c => `Azure Functions (${c.plan || 'consumption'}): ${big(c.executions)} calls per month${c.gbSeconds ? `, ${big(c.gbSeconds)} GB-seconds` : c.durationMs ? `, ${n(c.durationMs)} ms and ${n(c.memoryMB)} MB per call` : ''}`,
  'container-apps': c => `${n(c.apps || 1)} container app(s), each ${c.vcpu ?? 0.5} vCPU and ${c.memGiB ?? 1} GiB, at least ${n(c.replicas ?? 1)} copy running, ${big(c.requests || 0)} requests per month in total`,
  'sql-database': c => `Azure SQL Database ${c.tier || 'general-purpose'}, ${n(c.vcores)} vCores, ${gb(c.storageGB || 32)} storage, ${c.ahb ? 'your own SQL licenses' : 'SQL license included'}`,
  'sql-mi': c => `SQL Managed Instance ${c.tier || 'general-purpose'}, ${n(c.vcores)} vCores, ${gb(c.storageGB || 32)} storage, ${c.ahb ? 'your own SQL licenses' : 'SQL license included'}`,
  postgres: c => `PostgreSQL ${c.tier || 'general-purpose'}, ${n(c.vcores)} vCores, ${gb(c.storageGB || 128)} storage, ${c.ha ? 'with' : 'without'} high availability`,
  mysql: c => `MySQL ${c.tier || 'general-purpose'}, ${n(c.vcores)} vCores, ${gb(c.storageGB || 128)} storage, ${c.ha ? 'with' : 'without'} high availability`,
  cosmos: c => `Cosmos DB ${c.mode || 'autoscale'}${c.maxRU ? `, up to ${n(c.maxRU)} RU/s` : c.ru ? `, ${n(c.ru)} RU/s` : c.requestUnits ? `, ${big(c.requestUnits)} RUs per month` : ''}, ${gb(c.storageGB || 0)} stored, ${n(c.regions || 1)} region(s)`,
  blob: c => { const ops = [c.readOps && `${big(c.readOps)} reads`, c.writeOps && `${big(c.writeOps)} writes`, c.retrievalGB && `${gb(c.retrievalGB)} retrieved`].filter(Boolean); return `Blob storage: ${gb(c.capacityGB)} stored, ${c.tier || 'Hot'} tier, ${c.redundancy || 'LRS'}${ops.length ? `; ${ops.join(', ')} per month` : ''}`; },
  files: c => `Azure Files (${c.model || 'provisioned-v2-hdd'}): ${gb(c.capacityGB)}, ${c.redundancy || 'LRS'}`,
  'log-analytics': c => `Log Analytics: ${n(c.ingestGBPerDay)} GB of logs per day, kept ${n(c.retentionDays || 31)} days`,
  openai: c => `AI model ${c.model}: ${big(c.inputTokens)} input tokens and ${big(c.outputTokens)} output tokens per month${c.cachedInputTokens ? `, ${big(c.cachedInputTokens)} cached` : ''}`,
  meter: c => `${c.desc || (c.filter && c.filter.meterName) || 'Other meter'}: ${big(c.quantity)}${c.hours ? `, ${hrs(c.hours)}` : ''}`
};

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
  const opts = (spec.options || []).map((o, i) => ({ name: `Option ${i + 1}: ${o.name}`, lines: (o.components || []).map(c => (LINE[c.type] || (() => c.type))(c)) }));
  const missing = notIncluded(spec);
  const said = spec.customerSaid && spec.customerSaid.requirements ? String(spec.customerSaid.requirements).replace(/\s+/g, ' ').trim() : '';
  const canon = JSON.stringify([head, opts.map(o => o.lines), missing, spec.replacedSizes || []]);
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
  for (const e of excluded) out.push(`${e} (as agreed)`);
  return out;
}

module.exports = { readback, notIncluded };
