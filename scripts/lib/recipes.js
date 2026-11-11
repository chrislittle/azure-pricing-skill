'use strict';
// Component pricers. Each returns { lines, notes, facts }.
// line: { group, service, desc, qty, unit, unitPrice, list, meter }
//   list = monthly list cost at full precision (rounded later, per line).
const { query, dedupe, q } = require('./api');
const { parseUnit, tieredCost, meterCost, termMonths } = require('./units');
const catalog = require('../../catalog/catalog.json');
const aiModels = require('../../catalog/ai-models.json').models;
const vmSizes = require('../../catalog/vm-sizes.json');

const HOURS = 730;

class PricingError extends Error {
  constructor(msg, candidates) { super(msg); this.candidates = candidates || []; }
}

function meterInfo(r) {
  return { meterId: r.meterId, serviceName: r.serviceName, productName: r.productName, skuName: r.skuName,
    meterName: r.meterName, unitOfMeasure: r.unitOfMeasure, armRegionName: r.armRegionName, retailPrice: r.retailPrice };
}

async function rows(filter, ctx) { return dedupe(await query(filter, ctx.currency)); }

// Rows for exactly one meter (all tier bands). Throws with candidates if 0 or >1 meters.
function single(rs, what) {
  const ids = [...new Set(rs.map(r => r.meterId))];
  if (ids.length === 0) throw new PricingError(`No price found for ${what}.`);
  if (ids.length > 1) {
    // Identical price under several meterIds (catalog aliases) is safe to collapse.
    const sig = new Set(rs.map(r => r.tierMinimumUnits + ':' + r.retailPrice));
    const perId = rs.filter(r => r.meterId === ids[0]).length;
    if (sig.size === perId) return rs.filter(r => r.meterId === ids[0]);
    throw new PricingError(`Ambiguous meters for ${what}: ${ids.length} candidates.`, rs.slice(0, 12).map(meterInfo));
  }
  return rs;
}

function line(group, service, desc, qty, unit, unitPrice, list, meter, extra) {
  return Object.assign({ group, service, desc, qty, unit, unitPrice, list, meter }, extra || {});
}

const regionFilter = ctx => `armRegionName eq '${q(ctx.region)}'`;

// ---------------------------------------------------------------- VM
function vmSpec(sku) {
  const s = vmSizes[sku];
  return s ? { vcpu: s.v, memGiB: s.m, arch: s.a, maxDataDisks: s.d, premiumIO: !!s.p, uncachedIops: s.io, uncachedMBps: s.mb, family: s.f } : null;
}

async function vmRates(sku, ctx) {
  const rs = (await rows(`serviceName eq 'Virtual Machines' and ${regionFilter(ctx)} and armSkuName eq '${q(sku)}'`, ctx))
    .filter(r => !/Spot|Low Priority/i.test(r.skuName + ' ' + r.meterName) && /^Virtual Machines /.test(r.productName) && !/Cloud ?Services/i.test(r.productName));
  const cons = rs.filter(r => r.type === 'Consumption');
  const base = cons.filter(r => !/Windows$/i.test(r.productName));
  const win = cons.filter(r => /Windows$/i.test(r.productName));
  const res = rs.filter(r => r.type === 'Reservation' && !/Windows$/i.test(r.productName));
  return { base: base[0], win: win[0], reservations: res };
}

async function priceVm(c, ctx) {
  const sku = c.sku;
  if (!sku) throw new PricingError('vm component needs "sku" (e.g. Standard_D4as_v5). Use `azp vm-suggest` to choose one.');
  const spec = vmSpec(sku);
  const count = c.count || 1, hours = c.hours ?? HOURS, os = (c.os || 'linux').toLowerCase();
  const r = await vmRates(sku, ctx);
  if (!r.base) throw new PricingError(`${sku} has no pay-as-you-go price in ${ctx.region}. It may not be offered there.`);
  const lines = [], notes = [], facts = { sku, spec, os, count, hours };
  const label = `${sku.replace('Standard_', '')}${spec ? `, ${spec.vcpu} vCPU, ${spec.memGiB} GiB` : ''}`;
  const commit = c.commitment || 'payg';
  let computeRate = r.base.retailPrice, meter = r.base;
  if (os === 'windows') {
    if (!r.win) throw new PricingError(`No Windows price for ${sku} in ${ctx.region}.`);
    if (r.win.retailPrice < r.base.retailPrice) throw new PricingError(`The Windows rate for ${sku} is below its base compute rate; cannot derive a reliable license charge.`);
    computeRate = r.win.retailPrice; meter = r.win;
  }
  const osLabel = { linux: 'Linux', rhel: 'Linux (RHEL license billed separately)', 'rhel-byos': 'Linux (RHEL, own subscription)', sles: 'Linux (SUSE license billed separately)', windows: 'Windows Server, license included', 'windows-ahb': 'Windows Server, Azure Hybrid Benefit' }[os] || os;
  facts.paygRate = computeRate; facts.baseRate = r.base.retailPrice; facts.winRate = r.win ? r.win.retailPrice : null;

  if (commit === 'payg') {
    const rate = os === 'windows' ? r.base.retailPrice : computeRate;
    lines.push(line('Compute', 'Virtual Machines', `${label}, ${os === 'windows' ? 'Windows Server compute' : osLabel}`, hours * count, 'hours', rate, rate * hours * count, meterInfo(os === 'windows' ? r.base : meter), { per: count > 1 ? `${count} VMs x ${hours} hours` : null, isLicense: false }));
    if (os === 'windows') {
      const lic = r.win.retailPrice - r.base.retailPrice;
      lines.push(line('Compute', 'Virtual Machines', 'Windows Server license', hours * count, 'hours', lic, lic * hours * count, meterInfo(r.win), { isLicense: true }));
      notes.push('Windows pay-as-you-go is split into base compute and the Windows-minus-base license charge, so license discount exclusions do not exclude compute.');
    }
  } else if (/^ri(1|3)y$/.test(commit)) {
    const term = commit === 'ri1y' ? '1 Year' : '3 Years';
    const rr = r.reservations.find(x => x.reservationTerm === term);
    if (!rr) throw new PricingError(`No ${term} reservation price for ${sku} in ${ctx.region}.`);
    const months = termMonths(term);
    const monthly = rr.retailPrice / months;
    lines.push(line('Compute', 'Virtual Machines', `${label}, ${term} reservation (compute only)`, count, 'VM / month', monthly, monthly * count, meterInfo(rr), { termTotal: rr.retailPrice, isLicense: false }));
    notes.push(`${term} reservation: ${rr.retailPrice} is the whole-term price per VM, divided by ${months} months. Billed whether or not the VM runs.`);
    if (os === 'windows') {
      const lic = r.win.retailPrice - r.base.retailPrice;
      lines.push(line('Compute', 'Virtual Machines', `Windows Server license (not covered by reservation)`, HOURS * count, 'hours', lic, lic * HOURS * count, meterInfo(r.win), { isLicense: true }));
    }
    if (hours < HOURS) facts.commitmentUnderused = true;
  } else if (/^sp(1|3)y$/.test(commit)) {
    const term = commit === 'sp1y' ? '1 Year' : '3 Years';
    const sp = (r.base.savingsPlan || []).find(x => x.term === term);
    if (!sp) throw new PricingError(`No ${term} savings plan rate for ${sku} in ${ctx.region}.`);
    // Commitment is billed every hour of the term regardless of runtime.
    lines.push(line('Compute', 'Virtual Machines', `${label}, ${term} compute savings plan rate`, HOURS * count, 'hours', sp.unitPrice, sp.unitPrice * HOURS * count, meterInfo(r.base), { isLicense: false }));
    if (os === 'windows') {
      const lic = r.win.retailPrice - r.base.retailPrice;
      lines.push(line('Compute', 'Virtual Machines', `Windows Server license (not covered by savings plan)`, HOURS * count, 'hours', lic, lic * HOURS * count, meterInfo(r.win), { isLicense: true }));
    }
    if (hours < HOURS) facts.commitmentUnderused = true;
  } else throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y, ri3y, sp1y or sp3y.`);

  if (os === 'rhel' || os === 'sles') {
    if (!spec) throw new PricingError(`Unknown vCPU count for ${sku}; cannot price the ${os.toUpperCase()} license.`);
    const lic = os === 'rhel' ? await rhelLicense(spec.vcpu, ctx) : await slesLicense(spec.vcpu, ctx);
    lines.push(line('Compute', 'VM Licenses', lic.desc, hours * count, 'hours', lic.rate, lic.rate * hours * count, meterInfo(lic.row)));
    facts.licenseRegionless = true;
  }
  return { lines, notes, facts };
}

async function rhelLicense(vcpu, ctx) {
  const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq 'Red Hat Enterprise Linux' and priceType eq 'Consumption'`, ctx);
  const lic = rs.filter(r => r.armRegionName === '' && /VM License$/.test(r.meterName) && !/BYOS|Free/.test(r.meterName));
  let row = lic.find(r => r.meterName.replace('-', ' ') === `${vcpu} vCPU VM License`);
  if (!row) {
    const one = lic.find(r => r.meterName === '1 vCPU VM License');
    if (!one) throw new PricingError('RHEL license meter not found.');
    return { rate: one.retailPrice * vcpu, row: one, desc: `Red Hat Enterprise Linux license, ${vcpu} vCPU (${vcpu} x per-vCPU rate)` };
  }
  return { rate: row.retailPrice, row, desc: `Red Hat Enterprise Linux license, ${vcpu} vCPU tier` };
}

async function slesLicense(vcpu, ctx) {
  const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq 'SUSE Linux Enterprise Server Standard' and priceType eq 'Consumption'`, ctx);
  const band = vcpu <= 2 ? '1-2 vCPU VM' : vcpu <= 4 ? '3-4 vCPU VM' : '5+ vCPU VM';
  const row = rs.find(r => r.skuName === band && /Support$/.test(r.meterName) && parseUnit(r.unitOfMeasure).kind === 'hour');
  if (!row) throw new PricingError('SUSE license meter not found for ' + band);
  return { rate: row.retailPrice, row, desc: `SUSE Linux Enterprise Server Standard, ${band}` };
}

// ---------------------------------------------------------------- Managed disks
function snapTier(type, sizeGiB) {
  const t = catalog.diskTiers[type];
  if (!t) throw new PricingError(`Unknown disk type "${type}". Use premium-ssd, standard-ssd, standard-hdd, premium-v2.`);
  const hit = t.tiers.find(([, gib]) => gib >= sizeGiB);
  if (!hit) throw new PricingError(`Disk of ${sizeGiB} GiB exceeds the largest ${type} tier.`);
  return { tier: hit[0], tierGiB: hit[1], perf: t.perf[hit[0]], product: t.product };
}

async function priceDisk(c, ctx) {
  const type = (c.diskType || 'standard-ssd').toLowerCase();
  const count = c.count || 1, red = (c.redundancy || 'LRS').toUpperCase();
  const role = c.role ? `, ${c.role}` : '';
  if (type === 'premium-v2') return pricePremiumV2(c, ctx);
  const sizeGiB = c.sizeGiB || (c.tier ? catalog.diskTiers[type].tiers.find(t => t[0] === c.tier.toUpperCase())[1] : null);
  if (!sizeGiB) throw new PricingError('disk component needs sizeGiB.');
  const s = snapTier(type, sizeGiB);
  if (!catalog.diskTiers[type].redundancy.includes(red)) throw new PricingError(`${type} is not offered with ${red}.`);
  const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${s.product}' and skuName eq '${s.tier} ${red}' and priceType eq 'Consumption'`, ctx);
  const disk = single(rs.filter(r => r.meterName === `${s.tier} ${red} Disk`), `${s.tier} ${red} disk`);
  const rate = disk[0].retailPrice;
  const typeLabel = { 'premium-ssd': 'Premium SSD', 'standard-ssd': 'Standard SSD', 'standard-hdd': 'Standard HDD' }[type];
  const lines = [line('Storage', 'Storage', `${s.tier} ${typeLabel} ${red}, ${s.tierGiB.toLocaleString('en-US')} GiB, ${s.perf[0].toLocaleString('en-US')} IOPS${role}`, count, 'disk / month', rate, rate * count, meterInfo(disk[0]))];
  const notes = [];
  if (type !== 'premium-ssd') {
    if (c.transactionsPerMonth) {
      const tx = rs.filter(r => /Disk Operations$/.test(r.meterName) && r.skuName === `${s.tier} ${red}`);
      const txr = tx.length ? tx : (await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${s.product}' and skuName eq 'Disk Transactions ${red}' and priceType eq 'Consumption'`, ctx));
      const m = single(txr.filter(r => /Disk Operations$/.test(r.meterName)), 'disk transactions');
      const mc = meterCost(m, c.transactionsPerMonth * count, ctx.ledger);
      lines.push(line('Storage', 'Storage', `${typeLabel} transactions`, c.transactionsPerMonth * count, 'operations', m[0].retailPrice, mc.cost, meterInfo(m[0]), { unitLabel: m[0].unitOfMeasure }));
    } else notes.push(`${typeLabel} disks also bill per 10,000 transactions. Not modeled; usually small.`);
  }
  return { lines, notes, facts: { type, sizeGiB, tier: s.tier, tierGiB: s.tierGiB, iops: s.perf[0], mbps: s.perf[1], redundancy: red, count, requiredIops: c.iops, requiredMBps: c.throughputMBps, role: c.role } };
}

async function pricePremiumV2(c, ctx) {
  const pv = catalog.premiumV2, count = c.count || 1;
  const size = c.sizeGiB, iops = Math.max(c.iops || pv.freeIops, pv.freeIops), mbps = Math.max(c.throughputMBps || pv.freeMBps, pv.freeMBps);
  if (!size) throw new PricingError('premium-v2 disk needs sizeGiB.');
  if (iops > Math.min(pv.maxIops, size * pv.iopsPerGiB)) throw new PricingError(`Premium SSD v2 of ${size} GiB supports at most ${Math.min(pv.maxIops, size * pv.iopsPerGiB)} IOPS.`);
  const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${pv.product}' and skuName eq 'Premium LRS' and priceType eq 'Consumption'`, ctx);
  if (!rs.length) throw new PricingError(`Premium SSD v2 is not priced in ${ctx.region}; it may not be available there.`);
  const cap = single(rs.filter(r => r.meterName === 'Premium LRS Provisioned Capacity'), 'Premium SSD v2 capacity');
  const io = single(rs.filter(r => r.meterName === 'Premium LRS Provisioned IOPS'), 'Premium SSD v2 IOPS');
  const tp = single(rs.filter(r => r.meterName === 'Premium LRS Provisioned Throughput (MBps)'), 'Premium SSD v2 throughput');
  const role = c.role ? `, ${c.role}` : '';
  const lines = [];
  lines.push(line('Storage', 'Storage', `Premium SSD v2 capacity, ${size.toLocaleString('en-US')} GiB${role}`, size * HOURS * count, 'GiB-hours', cap[0].retailPrice, size * HOURS * count * cap[0].retailPrice, meterInfo(cap[0])));
  const ioc = tieredCost(io, iops);
  lines.push(line('Storage', 'Storage', `Premium SSD v2 IOPS, ${iops.toLocaleString('en-US')} provisioned (first ${pv.freeIops.toLocaleString('en-US')} free)`, iops * HOURS * count, 'IOPS-hours', io.find(r => r.retailPrice > 0).retailPrice, ioc.cost * HOURS * count, meterInfo(io[0])));
  const tpc = tieredCost(tp, mbps);
  lines.push(line('Storage', 'Storage', `Premium SSD v2 throughput, ${mbps} MB/s provisioned (first ${pv.freeMBps} free)`, mbps * HOURS * count, 'MBps-hours', tp.find(r => r.retailPrice > 0).retailPrice, tpc.cost * HOURS * count, meterInfo(tp[0])));
  return { lines, notes: ['Premium SSD v2 bills capacity, IOPS and throughput separately; 3,000 IOPS and 125 MB/s are included free per disk.'], facts: { type: 'premium-v2', sizeGiB: size, iops, mbps, count, role: c.role } };
}

// ---------------------------------------------------------------- Networking
async function pricePublicIp(c, ctx) {
  const count = c.count || 1, hours = c.hours ?? HOURS;
  const rs = await rows(`serviceName eq 'Virtual Network' and ${regionFilter(ctx)} and productName eq 'IP Addresses' and priceType eq 'Consumption'`, ctx);
  const m = single(rs.filter(r => r.meterName === 'Standard IPv4 Static Public IP'), 'Standard public IP');
  return { lines: [line('Networking', 'Virtual Network', 'Standard static public IPv4 address', hours * count, 'hours', m[0].retailPrice, m[0].retailPrice * hours * count, meterInfo(m[0]))], notes: [], facts: { count } };
}

async function priceBandwidth(c, ctx) {
  const gb = c.egressGB || 0;
  const rs = await rows(`serviceName eq 'Bandwidth' and ${regionFilter(ctx)} and productName eq 'Rtn Preference: MGN' and meterName eq 'Standard Data Transfer Out' and priceType eq 'Consumption'`, ctx);
  const m = single(rs, 'internet egress');
  const mc = meterCost(m, gb, ctx.ledger);
  const top = m.filter(r => r.retailPrice > 0).sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits)[0];
  const bands = mc.bands.map(b => `${b.units.toLocaleString('en-US')} GB at ${b.price}`).join('; ');
  return { lines: [line('Networking', 'Bandwidth', `Internet egress, ${gb.toLocaleString('en-US')} GB/month (graduated: ${bands || 'free band'})`, gb, 'GB', top ? top.retailPrice : 0, mc.cost, meterInfo(m[0]), { tiered: true })], notes: ['Internet egress is graduated: the first 100 GB each month is free and the per-GB rate falls at higher volumes.'], facts: { egressGB: gb, bands: mc.bands, guess: !!c.guess } };
}

async function priceLoadBalancer(c, ctx) {
  const rules = c.rules || 5, gb = c.processedGB || 0, hours = c.hours ?? HOURS;
  const rs = await rows(`serviceName eq 'Load Balancer' and armRegionName eq 'Global' and skuName eq 'Standard' and priceType eq 'Consumption'`, ctx);
  const inc = single(rs.filter(r => r.meterName === 'Standard Included LB Rules and Outbound Rules'), 'LB included rules');
  const over = single(rs.filter(r => r.meterName === 'Standard Overage LB Rules and Outbound Rules'), 'LB overage rules');
  const dp = single(rs.filter(r => r.meterName === 'Standard Data Processed'), 'LB data processed');
  const lines = [line('Networking', 'Load Balancer', 'Standard Load Balancer, first 5 rules', hours, 'hours', inc[0].retailPrice, inc[0].retailPrice * hours, meterInfo(inc[0]))];
  if (rules > 5) lines.push(line('Networking', 'Load Balancer', `Additional rules (${rules - 5})`, (rules - 5) * hours, 'rule-hours', over[0].retailPrice, over[0].retailPrice * (rules - 5) * hours, meterInfo(over[0])));
  lines.push(line('Networking', 'Load Balancer', `Data processed, ${gb.toLocaleString('en-US')} GB`, gb, 'GB', dp[0].retailPrice, dp[0].retailPrice * gb, meterInfo(dp[0])));
  return { lines, notes: [], facts: { rules, processedGB: gb } };
}

async function priceAppGateway(c, ctx) {
  const waf = c.waf !== false, cu = c.capacityUnits ?? 1, hours = c.hours ?? HOURS;
  const product = waf ? 'Application Gateway WAF v2' : 'Application Gateway Standard v2';
  const rs = await rows(`serviceName eq 'Application Gateway' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
  const fixed = single(rs.filter(r => r.meterName === 'Standard Fixed Cost'), product + ' fixed');
  const cap = single(rs.filter(r => r.meterName === 'Standard Capacity Units'), product + ' capacity units');
  return { lines: [
    line('Networking', 'Application Gateway', `${product}, gateway hours`, hours, 'hours', fixed[0].retailPrice, fixed[0].retailPrice * hours, meterInfo(fixed[0])),
    line('Networking', 'Application Gateway', `${product}, ${cu} capacity unit(s) average`, cu * hours, 'CU-hours', cap[0].retailPrice, cap[0].retailPrice * cu * hours, meterInfo(cap[0]))],
    notes: ['Application Gateway v2 capacity units scale with traffic, connections and rules; the average used here is an assumption.'], facts: { waf, capacityUnits: cu } };
}

// ---------------------------------------------------------------- Containers / PaaS compute
async function priceAks(c, ctx) {
  const tier = (c.tier || 'free').toLowerCase(), hours = c.hours ?? HOURS;
  if (tier === 'free') return { lines: [], notes: ['AKS Free tier: no charge for cluster management; no financially backed uptime SLA.'], facts: { tier } };
  const rs = await rows(`serviceName eq 'Azure Kubernetes Service' and ${regionFilter(ctx)} and productName eq 'Azure Kubernetes Service' and priceType eq 'Consumption'`, ctx);
  const name = tier === 'premium' ? 'Standard Long Term Support' : 'Standard Uptime SLA';
  const m = single(rs.filter(r => r.meterName === name), 'AKS ' + tier);
  return { lines: [line('Containers', 'Azure Kubernetes Service', `AKS ${tier === 'premium' ? 'Premium (long-term support)' : 'Standard'} tier cluster management`, hours, 'hours', m[0].retailPrice, m[0].retailPrice * hours, meterInfo(m[0]))], notes: ['AKS nodes are billed as virtual machines and disks, listed separately.'], facts: { tier } };
}

async function priceAppService(c, ctx) {
  const plan = c.plan, os = (c.os || 'linux').toLowerCase(), count = c.count || 1, hours = c.hours ?? HOURS;
  const p = catalog.appService[plan];
  if (!p) throw new PricingError(`Unknown App Service plan "${plan}". Known: ${Object.keys(catalog.appService).join(', ')}.`);
  const product = `Azure App Service ${p.product}${os === 'linux' ? ' - Linux' : ''}`;
  const rs = await rows(`serviceName eq 'Azure App Service' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
  const sku = p.sku || plan;
  const m = single(rs.filter(r => r.skuName === sku && !/Free/i.test(r.meterName)), `${plan} (${os})`);
  const spec = p.memGiB ? `${p.vcpu} vCPU, ${p.memGiB} GiB` : `${p.vcpu} vCPU`;
  return { lines: [line('App Service', 'Azure App Service', `${plan} plan, ${os === 'linux' ? 'Linux' : 'Windows'}, ${spec}, ${count} instance${count > 1 ? 's' : ''}`, hours * count, 'instance-hours', m[0].retailPrice, m[0].retailPrice * hours * count, meterInfo(m[0]))], notes: [], facts: { plan, os, count } };
}

async function priceFunctions(c, ctx) {
  const plan = (c.plan || 'consumption').toLowerCase();
  const ex = c.executions || 0;
  const gbs = c.gbSeconds ?? (c.durationMs && c.memoryMB ? ex * (c.durationMs / 1000) * (Math.ceil(c.memoryMB / 128) * 128 / 1024) : 0);
  let product, execName, timeName, sku;
  if (plan === 'flex') { product = 'Flex Consumption'; sku = 'On Demand'; execName = 'On Demand Total Executions'; timeName = 'On Demand Execution Time'; }
  else { product = 'Functions'; sku = 'Standard'; execName = 'Standard Total Executions'; timeName = 'Standard Execution Time'; }
  const rs = await rows(`serviceName eq 'Functions' and ${regionFilter(ctx)} and productName eq '${product}' and skuName eq '${sku}' and priceType eq 'Consumption'`, ctx);
  const e = single(rs.filter(r => r.meterName === execName), 'Functions executions');
  const t = single(rs.filter(r => r.meterName === timeName), 'Functions execution time');
  const ec = meterCost(e, ex, ctx.ledger), tc = meterCost(t, gbs, ctx.ledger);
  const freeEx = e.find(r => r.retailPrice === 0) ? (e.find(r => r.retailPrice > 0).tierMinimumUnits * parseUnit(e[0].unitOfMeasure).size) : 0;
  const freeT = t.find(r => r.retailPrice === 0) ? t.find(r => r.retailPrice > 0).tierMinimumUnits * parseUnit(t[0].unitOfMeasure).size : 0;
  return { lines: [
    line('Serverless', 'Functions', `${plan === 'flex' ? 'Flex Consumption' : 'Consumption'} plan executions, ${ex.toLocaleString('en-US')}/month (first ${freeEx.toLocaleString('en-US')} free)`, ex, 'executions', e.find(r => r.retailPrice > 0).retailPrice, ec.cost, meterInfo(e[0]), { unitLabel: `per ${e[0].unitOfMeasure}` }),
    line('Serverless', 'Functions', `Execution time, ${Math.round(gbs).toLocaleString('en-US')} GB-seconds/month (first ${freeT.toLocaleString('en-US')} free)`, gbs, 'GB-seconds', t.find(r => r.retailPrice > 0).retailPrice, tc.cost, meterInfo(t[0]))],
    notes: ['Functions free grants are per subscription per month and are already deducted.', 'A Functions app also needs a storage account (small cost, not modeled unless listed).'],
    facts: { plan, executions: ex, gbSeconds: gbs, freeGrant: true } };
}

// Free grants are not in the API; values from Learn (verified 2026-09-30).
const ACA_FREE = { vcpuSec: 180000, gibSec: 360000, requests: 2000000, learn: 'https://learn.microsoft.com/azure/container-apps/billing' };
async function priceContainerApps(c, ctx) {
  const apps = c.apps || 1, vcpu = c.vcpu || 0.5, mem = c.memGiB || 1, replicas = c.replicas ?? 1, hours = c.hours ?? HOURS;
  const activeFrac = c.activeFraction ?? 1, req = c.requests || 0;
  const rs = await rows(`serviceName eq 'Azure Container Apps' and ${regionFilter(ctx)} and skuName eq 'Standard' and priceType eq 'Consumption'`, ctx);
  const get = n => single(rs.filter(r => r.meterName === n), n);
  const va = get('Standard vCPU Active Usage'), vi = get('Standard vCPU Idle Usage'), ma = get('Standard Memory Active Usage'), mi = get('Standard Memory Idle Usage'), rq = get('Standard Requests');
  const secs = hours * 3600 * replicas * apps;
  const vActive = vcpu * secs * activeFrac, vIdle = vcpu * secs * (1 - activeFrac);
  const mActive = mem * secs * activeFrac, mIdle = mem * secs * (1 - activeFrac);
  // Free grant applies to active usage first (conservative: grant reduces active seconds).
  const L = ctx.ledger || {}; const grant = (k, free, q) => { const used = L[k] || 0; L[k] = used + q; return Math.max(0, q - Math.max(0, free - used)); };
  const vA = grant('aca-vcpu', ACA_FREE.vcpuSec, vActive), mA = grant('aca-gib', ACA_FREE.gibSec, mActive), rqB = grant('aca-req', ACA_FREE.requests, req);
  const lines = [
    line('Containers', 'Azure Container Apps', `vCPU active usage, ${apps} app(s) x ${replicas} replica(s) x ${vcpu} vCPU (${ACA_FREE.vcpuSec.toLocaleString('en-US')} vCPU-s free)`, vA, 'vCPU-seconds', va[0].retailPrice, vA * va[0].retailPrice, meterInfo(va[0])),
    line('Containers', 'Azure Container Apps', `Memory active usage, ${mem} GiB per replica (${ACA_FREE.gibSec.toLocaleString('en-US')} GiB-s free)`, mA, 'GiB-seconds', ma[0].retailPrice, mA * ma[0].retailPrice, meterInfo(ma[0]))];
  if (activeFrac < 1) {
    lines.push(line('Containers', 'Azure Container Apps', 'vCPU idle usage', vIdle, 'vCPU-seconds', vi[0].retailPrice, vIdle * vi[0].retailPrice, meterInfo(vi[0])));
    lines.push(line('Containers', 'Azure Container Apps', 'Memory idle usage', mIdle, 'GiB-seconds', mi[0].retailPrice, mIdle * mi[0].retailPrice, meterInfo(mi[0])));
  }
  lines.push(line('Containers', 'Azure Container Apps', `Requests, ${req.toLocaleString('en-US')}/month (first ${ACA_FREE.requests.toLocaleString('en-US')} free)`, rqB, 'requests', rq[0].retailPrice, meterCost(rq, rqB).cost, meterInfo(rq[0]), { unitLabel: `per ${rq[0].unitOfMeasure}` }));
  return { lines, notes: [`Consumption plan free grants (180,000 vCPU-s, 360,000 GiB-s, 2 million requests) apply per subscription per month and are deducted here. Source: ${ACA_FREE.learn}`, activeFrac === 1 ? 'Replicas modeled as active the whole month (worst case). Idle replicas bill at a much lower idle rate.' : `Replicas modeled as active ${Math.round(activeFrac * 100)}% of the time.`], facts: { freeGrant: true } };
}

// ---------------------------------------------------------------- Databases
async function sqlLicenseRow(product, ctx) {
  const rs = await rows(`productName eq '${product}' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
  return single(rs.filter(r => r.meterName === 'vCore'), product)[0];
}

async function priceSqlDb(c, ctx) {
  const tier = (c.tier || 'general-purpose').toLowerCase(), vcores = c.vcores, hours = c.hours ?? HOURS, gb = c.storageGB || 32;
  if (!vcores) throw new PricingError('sql-database needs vcores.');
  const tierName = tier === 'business-critical' ? 'Business Critical' : 'General Purpose';
  const product = `SQL Database Single/Elastic Pool ${tierName} - Compute Gen5`;
  const rs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
  const perV = single(rs.filter(r => r.skuName === '1 vCore' && r.meterName === 'vCore'), `${tierName} per-vCore compute`)[0];
  const lines = [line('Database', 'SQL Database', `${tierName} Gen5 compute, ${vcores} vCores`, vcores * hours, 'vCore-hours', perV.retailPrice, perV.retailPrice * vcores * hours, meterInfo(perV))];
  const ahb = !!c.ahb;
  if (!ahb) {
    const lic = await sqlLicenseRow(`SQL Database Single/Elastic Pool ${tierName} - SQL License`, ctx);
    lines.push(line('Database', 'SQL Database', `SQL Server license, ${vcores} vCores (license included)`, vcores * hours, 'vCore-hours', lic.retailPrice, lic.retailPrice * vcores * hours, meterInfo(lic)));
  }
  const srs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database Single/Elastic Pool ${tierName} - Storage' and priceType eq 'Consumption'`, ctx);
  const st = single(srs.filter(r => r.meterName === `${tierName} Data Stored`), 'SQL storage');
  lines.push(line('Database', 'SQL Database', `Data storage, ${gb.toLocaleString('en-US')} GB`, gb, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb, meterInfo(st[0])));
  return { lines, notes: ['Azure SQL compute is priced per vCore; the SQL Server license is a separate global meter unless Azure Hybrid Benefit applies.', 'Point-in-time backup storage up to 100% of database size is included; long-term retention is extra.'], facts: { vcores, ahb, tier } };
}

async function priceSqlMi(c, ctx) {
  const tier = (c.tier || 'general-purpose').toLowerCase(), vcores = c.vcores, hours = c.hours ?? HOURS, gb = c.storageGB || 32;
  if (!vcores) throw new PricingError('sql-mi needs vcores.');
  const tierName = tier === 'business-critical' ? 'Business Critical' : 'General Purpose';
  const product = `SQL Managed Instance ${tierName} - Compute Gen5`;
  const rs = await rows(`serviceName eq 'SQL Managed Instance' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
  const row = single(rs.filter(r => r.skuName === `${vcores} vCore` && r.meterName === 'vCore'), `MI ${vcores} vCore`)[0];
  const perV = row.retailPrice / vcores;
  const lines = [line('Database', 'SQL Managed Instance', `${tierName} Gen5 compute, ${vcores} vCores`, vcores * hours, 'vCore-hours', perV, row.retailPrice * hours, meterInfo(row))];
  if (!c.ahb) {
    const lic = await sqlLicenseRow(`SQL Managed Instance ${tierName} - SQL License`, ctx);
    lines.push(line('Database', 'SQL Managed Instance', `SQL Server license, ${vcores} vCores (license included)`, vcores * hours, 'vCore-hours', lic.retailPrice, lic.retailPrice * vcores * hours, meterInfo(lic)));
  }
  const srs = await rows(`serviceName eq 'SQL Managed Instance' and ${regionFilter(ctx)} and productName eq 'SQL Managed Instance ${tierName} - Storage' and priceType eq 'Consumption'`, ctx);
  const st = single(srs.filter(r => r.meterName === `${tierName} Data Stored`), 'MI storage');
  const billable = Math.max(0, gb - 32);
  lines.push(line('Database', 'SQL Managed Instance', `Data storage, ${gb.toLocaleString('en-US')} GB (first 32 GB included)`, billable, 'GB / month', st[0].retailPrice, st[0].retailPrice * billable, meterInfo(st[0])));
  return { lines, notes: ['SQL Managed Instance includes 32 GB of storage; additional storage bills per GB.'], facts: { vcores, ahb: !!c.ahb, tier } };
}

async function priceFlexDb(c, ctx, engine) {
  const svc = engine === 'postgres' ? 'Azure Database for PostgreSQL' : 'Azure Database for MySQL';
  const tierName = (c.tier || 'general-purpose') === 'memory-optimized' ? 'Memory Optimized' : 'General Purpose';
  const series = c.series || 'Ddsv5', vcores = c.vcores, hours = c.hours ?? HOURS, gb = c.storageGB || 128, ha = !!c.ha;
  if (!vcores) throw new PricingError(`${engine} needs vcores.`);
  const product = `${svc} Flexible Server ${tierName} ${series} Series Compute`;
  const rs = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
  if (!rs.length) throw new PricingError(`${product} is not priced in ${ctx.region}. Try series Ddsv5, Dadsv5 or Ddsv6.`);
  // Some series publish a per-vCore row; others only publish "<n> vCore" rows that are whole-server prices.
  let perV = rs.find(r => r.skuName === 'vCore' && r.meterName === 'vCore');
  if (!perV) {
    const sized = rs.filter(r => r.meterName === 'vCore' && /^\d+ vCore$/.test(r.skuName));
    const exact = sized.find(r => parseInt(r.skuName) === vcores);
    const ref = exact || sized[0];
    if (!ref) throw new PricingError(`No vCore price for ${product}.`);
    perV = Object.assign({}, ref, { retailPrice: ref.retailPrice / parseInt(ref.skuName) });
  }
  const mult = ha ? 2 : 1;
  const lines = [line('Database', svc, `${tierName} ${series} compute, ${vcores} vCores${ha ? ', primary + zone-redundant standby' : ''}`, vcores * hours * mult, 'vCore-hours', perV.retailPrice, perV.retailPrice * vcores * hours * mult, meterInfo(perV))];
  const stProduct = engine === 'postgres' ? 'Azure Database for PostgreSQL Flex Server Storage' : 'Azure Database for MySQL Flexible Server Storage';
  const srs = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq '${stProduct}' and priceType eq 'Consumption'`, ctx);
  const st = single(srs.filter(r => r.meterName === 'Storage Data Stored'), `${engine} storage`);
  lines.push(line('Database', svc, `Storage, ${gb.toLocaleString('en-US')} GB${ha ? ' x 2 (standby has its own copy)' : ''}`, gb * mult, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb * mult, meterInfo(st[0])));
  return { lines, notes: ha ? ['High availability runs a standby server: compute and storage are billed twice.', 'Backup storage up to 100% of provisioned storage is included.'] : ['Backup storage up to 100% of provisioned storage is included.'], facts: { ha, vcores, engine } };
}

async function priceCosmos(c, ctx) {
  const mode = (c.mode || 'autoscale').toLowerCase(), regions = c.regions || 1, gb = c.storageGB || 0, hours = c.hours ?? HOURS;
  const rs = await rows(`serviceName eq 'Azure Cosmos DB' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
  const lines = [], notes = [];
  if (mode === 'serverless') {
    const m = single(rs.filter(r => r.productName === 'Azure Cosmos DB serverless' && r.meterName === '1M RUs'), 'Cosmos serverless RUs');
    const ru = c.requestUnits || 0;
    lines.push(line('Database', 'Azure Cosmos DB', `Serverless request units, ${ru.toLocaleString('en-US')}/month`, ru, 'RUs', m[0].retailPrice, meterCost(m, ru).cost, meterInfo(m[0]), { unitLabel: 'per 1M' }));
  } else if (mode === 'autoscale') {
    const max = c.maxRU || 4000;
    const m = single(rs.filter(r => r.productName === 'Azure Cosmos DB autoscale' && / 100 RUs$/.test(r.meterName)), 'Cosmos autoscale');
    const units = max / 100;
    lines.push(line('Database', 'Azure Cosmos DB', `Autoscale throughput, up to ${max.toLocaleString('en-US')} RU/s, billed at maximum${regions > 1 ? `, ${regions} regions` : ''}`, units * hours * regions, '100 RU/s-hours', m[0].retailPrice, m[0].retailPrice * units * hours * regions, meterInfo(m[0])));
    notes.push(`Autoscale bills each hour at the highest RU/s reached, between 10% and 100% of the maximum. Shown at 100% (worst case); the floor is ${(m[0].retailPrice * units * hours * regions * 0.1).toFixed(2)} list per month.`);
  } else {
    const ru = c.ru || 400;
    const m = single(rs.filter(r => r.productName === 'Azure Cosmos DB' && r.meterName === '100 RU/s' && !/Free/i.test(r.skuName)), 'Cosmos provisioned');
    lines.push(line('Database', 'Azure Cosmos DB', `Provisioned throughput, ${ru.toLocaleString('en-US')} RU/s${regions > 1 ? `, ${regions} regions` : ''}`, (ru / 100) * hours * regions, '100 RU/s-hours', m[0].retailPrice, m[0].retailPrice * (ru / 100) * hours * regions, meterInfo(m[0])));
  }
  if (gb) {
    const st = single(rs.filter(r => r.productName === 'Azure Cosmos DB' && r.meterName === 'Data Stored' && !/Free/i.test(r.skuName)), 'Cosmos storage');
    lines.push(line('Database', 'Azure Cosmos DB', `Transactional storage, ${gb.toLocaleString('en-US')} GB${regions > 1 ? ` x ${regions} regions` : ''}`, gb * regions, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb * regions, meterInfo(st[0])));
  }
  return { lines, notes, facts: { mode, maxRU: c.maxRU, regions } };
}

// ---------------------------------------------------------------- Storage accounts
async function priceBlob(c, ctx) {
  const tier = c.tier || 'Hot', red = (c.redundancy || 'LRS').toUpperCase(), gb = c.capacityGB || 0;
  const sku = `${tier} ${red}`;
  const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'General Block Blob v2' and skuName eq '${q(sku)}' and priceType eq 'Consumption'`, ctx);
  if (!rs.length) throw new PricingError(`Blob ${sku} is not priced in ${ctx.region}.`);
  const find = re => rs.filter(r => re.test(r.meterName));
  const lines = [];
  const cap = single(find(new RegExp(`^${tier} ${red} Data Stored$`)), `${sku} capacity`);
  const cc = meterCost(cap, gb, ctx.ledger);
  lines.push(line('Storage', 'Storage', `Blob ${tier} ${red} capacity, ${gb.toLocaleString('en-US')} GB${cap.length > 1 ? ' (graduated)' : ''}`, gb, 'GB / month', cap[0].retailPrice, cc.cost, meterInfo(cap[0])));
  const ops = [['writeOps', /Write Operations$/, 'Write operations'], ['readOps', /Read Operations$/, 'Read operations'], ['otherOps', /^All Other Operations$/, 'Other operations']];
  for (const [k, re, label] of ops) {
    if (!c[k]) continue;
    const m = single(find(re).filter(r => !/Priority/.test(r.meterName)), `${sku} ${label}`);
    lines.push(line('Storage', 'Storage', `${label}, ${c[k].toLocaleString('en-US')}/month`, c[k], 'operations', m[0].retailPrice, meterCost(m, c[k], ctx.ledger).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` }));
  }
  if (c.retrievalGB) {
    const m = single(find(/Data Retrieval$/).filter(r => !/Priority/.test(r.meterName)), `${sku} retrieval`);
    lines.push(line('Storage', 'Storage', `Data retrieval, ${c.retrievalGB.toLocaleString('en-US')} GB/month`, c.retrievalGB, 'GB', m[0].retailPrice, m[0].retailPrice * c.retrievalGB, meterInfo(m[0])));
  }
  const early = { Cool: 30, Cold: 90, Archive: 180 }[tier];
  return { lines, notes: early ? [`${tier} tier has a ${early}-day minimum storage period; deleting or moving data earlier incurs an early-deletion charge.`] : [], facts: { tier, redundancy: red, capacityGB: gb, hasOps: ops.some(([k]) => c[k]) } };
}

async function priceFiles(c, ctx) {
  const model = (c.model || 'provisioned-v2-hdd').toLowerCase(), red = (c.redundancy || 'LRS').toUpperCase(), gb = c.capacityGB || 0;
  const lines = [], notes = [];
  if (model.startsWith('provisioned-v2')) {
    const media = model.endsWith('ssd') ? 'SSD' : 'HDD';
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Azure Files Provisioned v2' and skuName eq '${media} ${red}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Files provisioned v2 ${media} ${red} is not priced in ${ctx.region}.`);
    const ssd = media === 'SSD';
    const iops = c.iops || Math.min(Math.max((ssd ? 3000 : 1000) + Math.ceil((ssd ? 1 : 0.2) * gb), ssd ? 3000 : 500), ssd ? 102400 : 50000);
    const mbps = c.throughputMBps || Math.min(Math.max((ssd ? 100 : 60) + Math.ceil((ssd ? 0.1 : 0.02) * gb), ssd ? 100 : 60), ssd ? 10340 : 5120);
    const g = n => rs.filter(r => r.meterName === `${media} ${red} ${n}`);
    const st = single(g('Provisioned Storage'), 'Files storage'), io = single(g('Provisioned IOPS'), 'Files IOPS'), tp = single(g('Provisioned Throughput MiBPS'), 'Files throughput');
    lines.push(line('Storage', 'Storage', `Azure Files provisioned v2 ${media} ${red}, ${gb.toLocaleString('en-US')} GiB provisioned`, gb * HOURS, 'GiB-hours', st[0].retailPrice, st[0].retailPrice * gb * HOURS, meterInfo(st[0])));
    const freeIo = ssd ? 3000 : 0, freeTp = ssd ? 100 : 0;
    lines.push(line('Storage', 'Storage', `Provisioned IOPS, ${iops.toLocaleString('en-US')}${ssd ? ' (first 3,000 free)' : ' (recommended default)'}`, (iops - freeIo) * HOURS, 'IOPS-hours', io[0].retailPrice, io[0].retailPrice * (iops - freeIo) * HOURS, meterInfo(io[0])));
    lines.push(line('Storage', 'Storage', `Provisioned throughput, ${mbps.toLocaleString('en-US')} MiB/s${ssd ? ' (first 100 free)' : ' (recommended default)'}`, (mbps - freeTp) * HOURS, 'MiBps-hours', tp[0].retailPrice, tp[0].retailPrice * (mbps - freeTp) * HOURS, meterInfo(tp[0])));
    notes.push('Provisioned v2: you pay for provisioned storage, IOPS and throughput, not for transactions. IOPS and throughput use the Azure-recommended defaults for the provisioned size unless specified. Source: https://learn.microsoft.com/azure/storage/files/understanding-billing');
  } else {
    const tierMap = { 'payg-hot': 'Hot', 'payg-cool': 'Cool', 'payg-transaction-optimized': 'Standard' };
    const t = tierMap[model];
    if (!t) throw new PricingError(`Unknown Azure Files model "${model}". Use provisioned-v2-hdd, provisioned-v2-ssd, payg-hot, payg-cool, payg-transaction-optimized.`);
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Files v2' and skuName eq '${t} ${red}' and priceType eq 'Consumption'`, ctx);
    const st = single(rs.filter(r => r.meterName === (t === 'Standard' ? `${red} Data Stored` : `${t} ${red} Data Stored`)), 'Files data stored');
    lines.push(line('Storage', 'Storage', `Azure Files pay-as-you-go ${t === 'Standard' ? 'transaction optimized' : t.toLowerCase()} ${red}, ${gb.toLocaleString('en-US')} GB stored`, gb, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb, meterInfo(st[0])));
    for (const [k, re, label] of [['writeOps', /Write Operations$/, 'Write operations'], ['readOps', /Read Operations$/, 'Read operations'], ['listOps', /List Operations$/, 'List operations']]) {
      if (!c[k]) continue;
      const m = single(rs.filter(r => re.test(r.meterName)), label);
      lines.push(line('Storage', 'Storage', `${label}, ${c[k].toLocaleString('en-US')}/month`, c[k], 'operations', m[0].retailPrice, meterCost(m, c[k], ctx.ledger).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` }));
    }
    notes.push('Pay-as-you-go Azure Files also bills transactions; they can exceed the storage cost on busy shares. Transactions not listed above are not modeled.');
  }
  return { lines, notes, facts: { model, capacityGB: gb } };
}

// ---------------------------------------------------------------- Monitoring / AI
async function priceLogAnalytics(c, ctx) {
  const perDay = c.ingestGBPerDay || 0, gbMonth = perDay * (730 / 24), retentionDays = c.retentionDays || 31;
  const rs = await rows(`serviceName eq 'Log Analytics' and ${regionFilter(ctx)} and skuName eq 'Analytics Logs' and priceType eq 'Consumption'`, ctx);
  const ing = single(rs.filter(r => r.meterName === 'Analytics Logs Data Ingestion'), 'Log Analytics ingestion');
  const mc = meterCost(ing, gbMonth, ctx.ledger);
  const lines = [line('Monitoring', 'Log Analytics', `Analytics Logs ingestion, ${perDay} GB/day (~${Math.round(gbMonth).toLocaleString('en-US')} GB/month, first 5 GB free)`, gbMonth, 'GB', ing.find(r => r.retailPrice > 0).retailPrice, mc.cost, meterInfo(ing[0]))];
  if (retentionDays > 31) {
    const ret = single(rs.filter(r => r.meterName === 'Analytics Logs Data Retention'), 'retention');
    const extraGb = gbMonth * ((retentionDays - 31) / (730 / 24));
    lines.push(line('Monitoring', 'Log Analytics', `Retention beyond 31 days (${retentionDays} days)`, extraGb, 'GB / month', ret[0].retailPrice, ret[0].retailPrice * extraGb, meterInfo(ret[0])));
  }
  let commitment = null;
  const crs = await rows(`serviceName eq 'Azure Monitor' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
  const tiers = crs.filter(r => /GB Commitment Tier Capacity Reservation$/.test(r.meterName)).map(r => ({ gb: parseInt(r.meterName), perDay: r.retailPrice })).sort((a, b) => a.gb - b.gb);
  if (tiers.length) commitment = { smallest: tiers[0], payg100PerDay: 100 * ing.find(r => r.retailPrice > 0).retailPrice };
  return { lines, notes: ['730/24 = 30.42 days per month. Interactive retention of 31 days is included (90 days for Microsoft Sentinel-enabled workspaces).'], facts: { perDay, commitment } };
}

async function priceOpenAi(c, ctx) {
  const key = (c.model || '').toLowerCase();
  const m = aiModels[key];
  if (!m) throw new PricingError(`Unknown model "${c.model}". Known: ${Object.keys(aiModels).join(', ')}. For others use a "meter" component.`);
  // Foundry Models meters are regional rows even for Global deployments; use the requested region, fall back to eastus2.
  let rs = await rows(`serviceName eq 'Foundry Models' and ${regionFilter(ctx)} and productName eq '${q(m.product)}' and priceType eq 'Consumption'`, ctx);
  let priceRegion = ctx.region;
  if (!rs.some(r => r.meterName === m.input)) { rs = await rows(`serviceName eq 'Foundry Models' and armRegionName eq 'eastus2' and productName eq '${q(m.product)}' and priceType eq 'Consumption'`, ctx); priceRegion = 'eastus2'; }
  const lines = [];
  for (const [k, n, label] of [['inputTokens', m.input, 'Input tokens'], ['cachedInputTokens', m.cached, 'Cached input tokens'], ['outputTokens', m.output, 'Output tokens']]) {
    const qty = c[k] || 0; if (!qty) continue;
    const r = single(rs.filter(x => x.meterName === n), `${key} ${label}`);
    lines.push(line('AI', 'Foundry Models', `${key} Global Standard, ${label.toLowerCase()}, ${(qty / 1e6).toLocaleString('en-US')}M/month`, qty, 'tokens', r[0].retailPrice, meterCost(r, qty).cost, meterInfo(r[0]), { unitLabel: `per ${r[0].unitOfMeasure}` }));
  }
  const notes = ['Token meters are priced per 1K or 1M tokens as published; quantities are divided accordingly.'];
  if (m.note) notes.push(m.note);
  if (priceRegion !== ctx.region) notes.push(`Global Standard model rates taken from ${priceRegion}; Global Standard pricing is not region-specific.`);
  return { lines, notes, facts: { model: key, legacy: !!m.legacy } };
}

// ---------------------------------------------------------------- Generic escape hatch
async function priceMeter(c, ctx) {
  const f = c.filter || {};
  const parts = Object.entries(f).map(([k, v]) => `${k} eq '${q(v)}'`);
  if (!parts.some(p => p.startsWith('armRegionName'))) parts.push(regionFilter(ctx));
  parts.push(`priceType eq 'Consumption'`);
  const rs = await rows(parts.join(' and '), ctx);
  const m = single(rs, c.desc || JSON.stringify(f));
  const qty = c.quantity || 0;
  const u = parseUnit(m[0].unitOfMeasure);
  const cost = u.kind === 'hour' && c.hours ? meterCost(m, qty * c.hours, ctx.ledger).cost : meterCost(m, qty, ctx.ledger).cost;
  const q2 = u.kind === 'hour' && c.hours ? qty * c.hours : qty;
  return { lines: [line(c.group || 'Other', m[0].serviceName, c.desc || `${m[0].productName} - ${m[0].meterName}`, q2, c.unit || m[0].unitOfMeasure, m[0].retailPrice, cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` })], notes: [], facts: { generic: true } };
}

const PRICERS = {
  'vm': priceVm, 'disk': priceDisk, 'public-ip': pricePublicIp, 'bandwidth': priceBandwidth,
  'load-balancer': priceLoadBalancer, 'app-gateway': priceAppGateway, 'aks': priceAks,
  'app-service': priceAppService, 'functions': priceFunctions, 'container-apps': priceContainerApps,
  'sql-database': priceSqlDb, 'sql-mi': priceSqlMi,
  'postgres': (c, x) => priceFlexDb(c, x, 'postgres'), 'mysql': (c, x) => priceFlexDb(c, x, 'mysql'),
  'cosmos': priceCosmos, 'blob': priceBlob, 'files': priceFiles, 'log-analytics': priceLogAnalytics,
  'openai': priceOpenAi, 'meter': priceMeter
};

module.exports = { PRICERS, PricingError, vmSpec, vmRates, snapTier, HOURS, ACA_FREE };
