'use strict';
// Component pricers. Each returns { lines, notes, facts }.
// line: { group, service, desc, qty, unit, unitPrice, list, meter }
//   list = monthly list cost at full precision (rounded later, per line).
const { query, q, parseUnit, tieredCost, meterCost, termMonths, HOURS, DAYS, PricingError, meterInfo, rows, single, line, regionFilter, meterLine } = require('./kit');
const catalog = require('../../catalog/catalog.json');
const aiModels = require('../../catalog/ai-models.json').models;
const vmSizes = require('../../catalog/vm-sizes.json');
const SERVICES = require('./services');

// ---------------------------------------------------------------- VM
function vmSpec(sku) {
  const s = vmSizes[sku];
  return s ? { vcpu: s.v, licensedVcpu: activeVcpu(sku, s.v), memGiB: s.m, arch: s.a, maxDataDisks: s.d, premiumIO: !!s.p, uncachedIops: s.io, uncachedMBps: s.mb, family: s.f } : null;
}

// Constrained-core sizes (E8-4ds_v5, M64-32ms) run the full memory and storage of the parent size with fewer active
// vCPUs; per-vCPU software licenses (SQL Server, Red Hat, SUSE) are billed on the active count.
function activeVcpu(sku, vcpu) {
  const m = /-(\d+)(?=[a-z_]|$)/i.exec(String(sku).replace(/^Standard_/, ''));
  return m && Number(m[1]) < vcpu ? Number(m[1]) : vcpu;
}

async function vmRates(sku, ctx) {
  const rs = (await rows(`serviceName eq 'Virtual Machines' and ${regionFilter(ctx)} and armSkuName eq '${q(sku)}'`, ctx))
    .filter(r => !/Spot|Low Priority/i.test(r.skuName + ' ' + r.meterName) && !/Cloud ?Services|Dedicated ?Host/i.test(r.productName));
  const cons = rs.filter(r => r.type === 'Consumption');
  const base = cons.filter(r => !/(Windows( VM)?| Win)$/i.test(r.productName));
  const win = cons.filter(r => /(Windows( VM)?| Win)$/i.test(r.productName));
  const res = rs.filter(r => r.type === 'Reservation' && !/(Windows( VM)?| Win)$/i.test(r.productName));
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
  const label = `${sku.replace('Standard_', '')}${spec ? `, ${spec.vcpu} vCPU${spec.licensedVcpu < spec.vcpu ? ` (${spec.licensedVcpu} active)` : ''}, ${spec.memGiB} GiB` : ''}`;
  const commit = c.commitment || 'payg';
  let computeRate = r.base.retailPrice, meter = r.base;
  if (os === 'windows') {
    if (!r.win) throw new PricingError(`No Windows price for ${sku} in ${ctx.region}.`);
    computeRate = r.win.retailPrice; meter = r.win;
  }
  const osLabel = { linux: 'Linux', rhel: 'Linux (RHEL license billed separately)', 'rhel-byos': 'Linux (RHEL, own subscription)', sles: 'Linux (SUSE license billed separately)', windows: 'Windows Server, license included', 'windows-ahb': 'Windows Server, Azure Hybrid Benefit' }[os] || (LIC_OS[os] ? `Linux (${LIC_OS[os].name} license billed separately)` : os);
  facts.paygRate = computeRate; facts.baseRate = r.base.retailPrice; facts.winRate = r.win ? r.win.retailPrice : null;

  if (commit === 'payg') {
    lines.push(line('Compute', 'Virtual Machines', `${label}, ${osLabel}`, hours * count, 'hours', computeRate, computeRate * hours * count, meterInfo(meter), { per: count > 1 ? `${count} VMs x ${hours} hours` : null }));
  } else if (/^ri(1|3)y$/.test(commit)) {
    const term = commit === 'ri1y' ? '1 Year' : '3 Years';
    const rr = r.reservations.find(x => x.reservationTerm === term);
    if (!rr) throw new PricingError(`No ${term} reservation price for ${sku} in ${ctx.region}.`);
    const months = termMonths(term);
    const monthly = rr.retailPrice / months;
    lines.push(line('Compute', 'Virtual Machines', `${label}, ${term} reservation (compute only)`, count, 'VM / month', monthly, monthly * count, meterInfo(rr), { termTotal: rr.retailPrice }));
    notes.push(`${term} reservation: ${rr.retailPrice} is the whole-term price per VM, divided by ${months} months. Billed whether or not the VM runs.`);
    if (os === 'windows') {
      const lic = r.win.retailPrice - r.base.retailPrice;
      lines.push(line('Compute', 'Virtual Machines', `Windows Server license (not covered by reservation)`, HOURS * count, 'hours', lic, lic * HOURS * count, meterInfo(r.win)));
    }
    if (hours < HOURS) facts.commitmentUnderused = true;
  } else if (/^sp(1|3)y$/.test(commit)) {
    const term = commit === 'sp1y' ? '1 Year' : '3 Years';
    const sp = (r.base.savingsPlan || []).find(x => x.term === term);
    if (!sp) throw new PricingError(`No ${term} savings plan rate for ${sku} in ${ctx.region}.`);
    // Commitment is billed every hour of the term regardless of runtime.
    lines.push(line('Compute', 'Virtual Machines', `${label}, ${term} compute savings plan rate`, HOURS * count, 'hours', sp.unitPrice, sp.unitPrice * HOURS * count, meterInfo(r.base)));
    if (os === 'windows') {
      const lic = r.win.retailPrice - r.base.retailPrice;
      lines.push(line('Compute', 'Virtual Machines', `Windows Server license (not covered by savings plan)`, HOURS * count, 'hours', lic, lic * HOURS * count, meterInfo(r.win)));
    }
    if (hours < HOURS) facts.commitmentUnderused = true;
  } else throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y, ri3y, sp1y or sp3y.`);

  const known = ['linux', 'windows', 'windows-ahb', 'rhel-byos'];
  if (!known.includes(os) && !LIC_OS[os]) throw new PricingError(`Unknown os "${os}". Use ${[...known, ...Object.keys(LIC_OS)].join(', ')}.`);
  const winOs = os === 'windows' || os === 'windows-ahb';
  if (c.sqlLicense && c.sqlLicense !== 'none' && (os === 'sles' || os === 'ubuntu-pro')) lines[0].desc = lines[0].desc.replace(/ \(.*license billed separately\)$/, ` (${os === 'sles' ? 'SUSE' : 'Ubuntu Pro'} included in the SQL Server license line)`);
  const sqlEd = c.sqlLicense && c.sqlLicense !== 'none' ? c.sqlLicense : null, bizEd = c.biztalk && c.biztalk !== 'none' ? c.biztalk : null;
  const lv = spec ? spec.licensedVcpu : 0;
  if ((LIC_OS[os] || sqlEd || bizEd || c.oracleJava) && !spec) throw new PricingError(`Unknown vCPU count for ${sku}; cannot price the per-vCPU license.`);
  if (bizEd && !winOs) throw new PricingError('BizTalk Server runs on Windows: use os windows (or windows-ahb with your own Windows license).');
  if (sqlEd && LIC_OS[os] && !['rhel', 'sles', 'ubuntu-pro'].includes(os)) throw new PricingError(`SQL Server images are priced on Linux (Ubuntu), Ubuntu Pro, Red Hat Enterprise Linux, SUSE or Windows, not ${os}.`);
  const licTerm = c.licenseTerm || 'payg';
  if (licTerm !== 'payg' && !(LIC_OS[os] && LIC_OS[os].reservable)) throw new PricingError('A 1- or 3-year software subscription is sold for Red Hat Enterprise Linux (rhel), SUSE Linux Enterprise Server (sles) and SUSE for SAP (sles-sap) only.');
  if (licTerm !== 'payg' && sqlEd) throw new PricingError('Software subscriptions apply to the Red Hat or SUSE license alone; remove sqlLicense or use licenseTerm payg.');
  const addLic = lic => lines.push(line('Compute', 'VM Licenses', lic.desc, lic.fixedMonthly ? count : hours * count, lic.fixedMonthly ? 'license / month' : 'hours', lic.rate, lic.rate * (lic.fixedMonthly ? 1 : hours) * count, meterInfo(lic.row), lic.fixedMonthly ? { termTotal: lic.termTotal } : undefined));
  const sqlHost = os === 'sles' ? 'sles' : os === 'ubuntu-pro' ? 'ubuntu-pro' : 'plain';
  if (LIC_OS[os] && !(sqlEd && (os === 'sles' || os === 'ubuntu-pro'))) {
    const lic = await bandLicense(LIC_OS[os], lv, ctx, licTerm);
    addLic(lic);
    if (licTerm !== 'payg') notes.push(`${licTerm === '1y' ? '1-year' : '3-year'} software subscription: the whole-term price ${lic.termTotal} is divided by ${lic.months} months and is billed whether or not the VM runs.`);
    facts.licenseRegionless = true;
  }
  if (sqlEd) {
    const lic = await sqlVmLicense(sqlEd, lv, ctx, sqlHost);
    addLic(lic);
    notes.push(sqlHost === 'plain' ? 'SQL Server on a VM adds a per-vCPU license charge on top of the VM price (not covered by reservations or savings plans). With Azure Hybrid Benefit you bring your own license and this charge does not apply.' : `This SQL Server image's license meter already includes the ${sqlHost === 'sles' ? 'SUSE Linux Enterprise Server priority support' : 'Ubuntu Pro subscription'}, so no separate OS license line is added. With Azure Hybrid Benefit you bring your own SQL Server license and the SQL part does not apply.`);
    if (spec && lv < spec.vcpu) notes.push(`${sku} is a constrained-core size: SQL Server is licensed on its ${lv} active vCPUs, not the ${spec.vcpu} it exposes memory and storage for.`);
    facts.licenseRegionless = true; facts.sqlLicense = sqlEd; facts.sqlHost = sqlHost;
  }
  if (bizEd) {
    const lic = await bandLicense({ product: bizEd === 'enterprise' ? 'BizTalk Server Enterprise' : 'BizTalk Server Standard', name: `BizTalk Server ${bizEd === 'enterprise' ? 'Enterprise' : 'Standard'}` }, lv, ctx, 'payg');
    addLic(lic); facts.licenseRegionless = true; facts.biztalk = bizEd;
  }
  if (c.oracleJava) {
    const lic = await bandLicense({ product: 'Java Development Environment', name: 'Oracle Java SE subscription' }, lv, ctx, 'payg');
    addLic(lic); facts.licenseRegionless = true; facts.oracleJava = true;
    notes.push('Oracle Java SE subscription is billed per vCPU-hour on top of the VM price.');
  }
  facts.licensedVcpu = lv || null;
  return { lines, notes, facts };
}

// Per-vCPU software on top of the VM: product names in the "Virtual Machines Licenses" service (rows are global).
const LIC_OS = {
  rhel: { product: 'Red Hat Enterprise Linux', name: 'Red Hat Enterprise Linux', reservable: true },
  'rhel-ha': { product: 'Red Hat Enterprise Linux with HA', name: 'Red Hat Enterprise Linux with High Availability' },
  'rhel-sap': { product: 'RHEL for SAP Business Applications', name: 'RHEL for SAP Business Applications' },
  'rhel-sap-ha': { product: 'Red Hat Enterprise Linux for SAP with HA', name: 'RHEL for SAP with High Availability' },
  sles: { product: 'SUSE Linux Enterprise Server Standard', name: 'SUSE Linux Enterprise Server Standard (24x7 support)', reservable: true },
  'sles-sap': { product: 'SUSE for SAP Linux Enterprise Server', name: 'SUSE Linux Enterprise Server for SAP Applications (24x7 support)', reservable: true },
  'sles-hpc': { product: 'SUSE Linux Enterprise Server for HPC Standard', name: 'SUSE Linux Enterprise Server for HPC (24x7 support)' },
  'sles-basic': { product: 'SUSE Linux Enterprise Server Basic', name: 'SUSE Linux Enterprise Server Basic (patching only)' },
  'ubuntu-pro': { product: 'Ubuntu Pro', name: 'Ubuntu Pro' }
};

// Per-vCPU-hour software meters come as exact sizes ("8 vCPU VM License"), bands ("1-4", "5+") or a single-vCPU rate.
const isGlobal = r => !r.armRegionName || r.armRegionName === 'Global';
const bandOf = txt => { const m = /^(\d+)(?:\s*-\s*(\d+)|(\+))?[ -]*vCPU/i.exec(String(txt).replace(/-vCPU/i, ' vCPU').trim()); return m ? { lo: Number(m[1]), hi: m[3] ? Infinity : m[2] ? Number(m[2]) : Number(m[1]) } : null; };
function pickBand(rs, vcpu, field) {
  const bands = rs.map(r => ({ r, b: bandOf(r[field]) })).filter(x => x.b);
  return (bands.find(x => x.b.lo === vcpu && x.b.hi === vcpu) || bands.find(x => x.b.lo <= vcpu && vcpu <= x.b.hi && x.b.hi !== x.b.lo) || {}).r;
}
async function bandLicense(def, vcpu, ctx, term) {
  const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq '${def.product}' and priceType eq 'Consumption'`, ctx);
  const lic = rs.filter(r => isGlobal(r) && /vCPU( VM)? (License|Support)$/i.test(r.meterName.replace(/-vCPU/i, ' vCPU')) && !/BYO|Free|Minimum|XS /i.test(r.meterName) && parseUnit(r.unitOfMeasure).kind === 'hour');
  let row = pickBand(lic, vcpu, 'meterName');
  if (term !== 'payg') {
    const yrs = term === '1y' ? '1 Year' : '3 Years', months = term === '1y' ? 12 : 36;
    const rr = (await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq '${def.product}' and priceType eq 'Reservation' and reservationTerm eq '${yrs}'`, ctx)).filter(isGlobal);
    const hit = pickBand(rr, vcpu, 'skuName');
    if (!hit) throw new PricingError(`No ${yrs.toLowerCase()} software subscription for ${def.name} at ${vcpu} vCPU in ${ctx.region}; the reservation is sold for specific vCPU sizes. Use licenseTerm payg.`);
    return { rate: hit.retailPrice / months, row: hit, fixedMonthly: true, termTotal: hit.retailPrice, months, desc: `${def.name} license, ${vcpu} vCPU, ${yrs.toLowerCase()} subscription` };
  }
  if (row) return { rate: row.retailPrice, row, desc: `${def.name} license, ${vcpu} vCPU${bandOf(row.meterName).lo !== bandOf(row.meterName).hi ? ` (${row.meterName.replace(/ VM (License|Support)$/, '').replace(/-vCPU/, ' vCPU')} tier)` : ''}` };
  const one = lic.find(r => { const b = bandOf(r.meterName); return b && b.lo === 1 && b.hi === 1; }) || rs.find(r => isGlobal(r) && /^1 vCore License$/.test(r.meterName));
  if (!one) throw new PricingError(`${def.name} license meter not found for ${vcpu} vCPU.`);
  return { rate: one.retailPrice * vcpu, row: one, desc: `${def.name} license, ${vcpu} vCPU (${vcpu} x per-vCPU rate)` };
}

async function sqlVmLicense(edition, vcpu, ctx, host = 'plain') {
  const ed = { web: 'Web', standard: 'Standard', enterprise: 'Enterprise' }[edition];
  if (!ed) throw new PricingError('sqlLicense must be none, web, standard or enterprise.');
  const name = `SQL Server ${ed}${host === 'sles' ? ' SLES' : host === 'ubuntu-pro' ? ' Ubuntu Pro' : ''}`;
  const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq '${name}' and priceType eq 'Consumption'`, ctx);
  const lic = rs.filter(r => isGlobal(r) && /vCPU VM License$|vCore License$/.test(r.meterName));
  let row = pickBand(lic, vcpu, 'meterName');
  if (!row && vcpu <= 4) row = lic.find(r => r.meterName === '4 vCPU VM License');
  const label = host === 'sles' ? `${name} (SQL Server on SUSE with priority support)` : name;
  if (row) return { rate: row.retailPrice, row, desc: `${label} license, ${vcpu} vCPU${bandOf(row.meterName) && bandOf(row.meterName).lo !== bandOf(row.meterName).hi ? ' (priced as the ' + row.meterName.replace(' VM License', '') + ' tier)' : ''}` };
  const one = lic.find(r => r.meterName === '1 vCPU VM License' || r.meterName === '1 vCore License');
  if (!one) throw new PricingError(`${name} license meter not found.`);
  return { rate: one.retailPrice * vcpu, row: one, desc: `${label} license, ${vcpu} vCPU (${vcpu} x per-vCPU rate)` };
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
  const count = c.count ?? 1, red = (c.redundancy || 'LRS').toUpperCase();
  if (!(count >= 1)) throw new PricingError('disk count must be at least 1.');
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
  const commit = c.commitment || 'payg', big = ['P30', 'P40', 'P50', 'P60', 'P70', 'P80'].includes(s.tier);
  const diskDesc = `${s.tier} ${typeLabel} ${red}, ${s.tierGiB.toLocaleString('en-US')} GiB, ${s.perf[0].toLocaleString('en-US')} IOPS${role}`;
  const lines = [], notes = [];
  if (commit === 'ri1y') {
    if (type !== 'premium-ssd' || !big || red !== 'LRS') throw new PricingError('Disk reservations are sold for Premium SSD LRS disks of size P30 (1,024 GiB) and larger, for 1 year.');
    const rr = (await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${s.product}' and skuName eq '${s.tier} ${red}' and priceType eq 'Reservation'`, ctx)).find(r => r.reservationTerm === '1 Year' && r.meterName === `${s.tier} ${red} Disk`);
    if (!rr) throw new PricingError(`No 1-year reservation price for ${s.tier} ${red} in ${ctx.region}.`);
    lines.push(line('Storage', 'Storage', `${diskDesc}, 1-year reservation`, count, 'disk / month', rr.retailPrice / 12, rr.retailPrice / 12 * count, meterInfo(rr), { termTotal: rr.retailPrice }));
    notes.push(`1-year disk reservation: ${rr.retailPrice} is the whole-term price per disk, divided by 12 months. Billed whether or not the disk is attached.`);
  } else if (commit !== 'payg') throw new PricingError('Disks support commitment payg or ri1y (1-year reservation on Premium SSD P30 and larger).');
  else lines.push(line('Storage', 'Storage', diskDesc, count, 'disk / month', rate, rate * count, meterInfo(disk[0])));
  if (type !== 'premium-ssd') {
    if (c.transactionsPerMonth) {
      const tx = rs.filter(r => /Disk Operations$/.test(r.meterName) && r.skuName === `${s.tier} ${red}`);
      const txr = tx.length ? tx : (await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${s.product}' and skuName eq 'Disk Transactions ${red}' and priceType eq 'Consumption'`, ctx));
      const m = single(txr.filter(r => /Disk Operations$/.test(r.meterName)), 'disk transactions');
      const mc = meterCost(m, c.transactionsPerMonth * count, ctx.ledger);
      lines.push(line('Storage', 'Storage', `${typeLabel} transactions`, c.transactionsPerMonth * count, 'operations', m[0].retailPrice, mc.cost, meterInfo(m[0]), { unitLabel: m[0].unitOfMeasure }));
    } else notes.push(`${typeLabel} disks also bill per 10,000 transactions. Not modeled; usually small. The calculator also caps billable transactions per disk size (not modeled).`);
  }
  if (c.additionalMounts) {
    const mm = rs.filter(r => r.meterName === `${s.tier} ${red} Disk Mount`);
    if (!mm.length) throw new PricingError(`Shared-disk mounts are not priced for ${s.tier} ${red} in ${ctx.region}.`);
    const m = single(mm, 'disk mount');
    lines.push(line('Storage', 'Storage', `Shared disk, ${c.additionalMounts} additional mount(s) per disk`, c.additionalMounts * count, 'mounts / month', m[0].retailPrice, m[0].retailPrice * c.additionalMounts * count, meterInfo(m[0])));
    notes.push('A shared disk bills each additional VM mount in addition to the disk itself.');
  }
  if (c.bursting) {
    if (type !== 'premium-ssd' || !['P30', 'P40', 'P50', 'P60', 'P70', 'P80'].includes(s.tier)) throw new PricingError('On-demand bursting can be enabled on Premium SSD disks larger than 512 GiB, P30 to P80 (P20 and smaller burst for free by default).');
    const brs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${s.product}' and priceType eq 'Consumption' and contains(meterName,'Burst')`, ctx);
    const en = single(brs.filter(r => r.meterName === `${red} Burst Enablement`), 'disk burst enablement'), tx = single(brs.filter(r => r.meterName === `${red} Burst Transactions`), 'disk burst transactions');
    lines.push(line('Storage', 'Storage', `On-demand bursting enabled, ${count} disk(s)`, count, 'disk / month', en[0].retailPrice, en[0].retailPrice * count, meterInfo(en[0])));
    if (c.burstIops > 30000) throw new PricingError('On-demand bursting reaches at most 30,000 IOPS (Learn, managed disks bursting); burstIops cannot be higher.');
    const peak = Math.min(c.burstIops || 30000, 30000), mins = c.burstMinutesPerDay ?? 30, days = c.burstDaysPerMonth ?? 22;
    const over = Math.max(0, peak - s.perf[0]) * 60 * mins * days * count;
    lines.push(line('Storage', 'Storage', `Burst transactions above ${s.perf[0].toLocaleString('en-US')} IOPS: peak ${peak.toLocaleString('en-US')} IOPS for ${mins} minutes a day, ${days} days`, over, 'transactions', tx[0].retailPrice, meterCost(tx, over).cost, meterInfo(tx[0]), { unitLabel: 'per ' + tx[0].unitOfMeasure }));
    notes.push('On-demand bursting (up to 30,000 IOPS and 1,000 MB/s) charges a monthly enablement fee plus a fee per 10,000 burst transactions above the provisioned IOPS.');
  }
  if (c.confidential) {
    const cm = (await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${s.product}' and priceType eq 'Consumption' and contains(meterName,'Confidential')`, ctx)).filter(r => r.meterName === `Confidential Compute Encryption ${red} Provisioned Capacity`);
    const m = single(cm, 'confidential disk encryption');
    lines.push(line('Storage', 'Storage', `Confidential OS disk encryption, ${s.tierGiB.toLocaleString('en-US')} GiB x ${count} disk(s)`, s.tierGiB * HOURS * count, 'GiB-hours', m[0].retailPrice, m[0].retailPrice * s.tierGiB * HOURS * count, meterInfo(m[0])));
    notes.push('Confidential OS disk encryption applies to the OS disk of Confidential VMs only.');
  }
  return { lines, notes, facts: { type, sizeGiB, tier: s.tier, tierGiB: s.tierGiB, iops: s.perf[0], mbps: s.perf[1], redundancy: red, count, requiredIops: c.iops, requiredMBps: c.throughputMBps, role: c.role, commitment: commit, bursting: !!c.bursting } };
}

async function pricePremiumV2(c, ctx) {
  const pv = catalog.premiumV2, count = c.count ?? 1;
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
  if (c.confidential) {
    const cm = (await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${pv.product}' and priceType eq 'Consumption' and contains(meterName,'Confidential')`, ctx)).filter(r => r.meterName === 'Confidential Compute Encryption LRS Provisioned Capacity');
    const m = single(cm, 'confidential Premium SSD v2 encryption');
    lines.push(line('Storage', 'Storage', `Confidential OS disk encryption, ${size.toLocaleString('en-US')} GiB x ${count} disk(s)`, size * HOURS * count, 'GiB-hours', m[0].retailPrice, m[0].retailPrice * size * HOURS * count, meterInfo(m[0])));
  }
  return { lines, notes: ['Premium SSD v2 bills capacity, IOPS and throughput separately; 3,000 IOPS and 125 MB/s are included free per disk.'], facts: { type: 'premium-v2', sizeGiB: size, iops, mbps, count, role: c.role } };
}

// ---------------------------------------------------------------- Networking
async function pricePublicIp(c, ctx) {
  const count = c.count ?? 1, hours = c.hours ?? HOURS, tier = (c.tier || 'standard').toLowerCase();
  const T = { standard: ['Standard IPv4 Static Public IP', 'Standard static public IPv4 address'], 'standard-v2': ['Standard IPv4 Static Public IP', 'Standard v2 static public IPv4 address'], global: ['Global IPv4 Static Public IP', 'Global (cross-region) static public IPv4 address'], 'basic-static': ['Basic IPv4 Static Public IP', 'Basic static public IPv4 address'], 'basic-dynamic': ['Basic IPv4 Dynamic Public IP', 'Basic dynamic public IPv4 address'] }[tier];
  if (!T) throw new PricingError(`Unknown public IP tier "${tier}". Use standard, standard-v2, global, basic-static or basic-dynamic.`);
  const rs = await rows(`serviceName eq 'Virtual Network' and ${regionFilter(ctx)} and productName eq 'IP Addresses' and priceType eq 'Consumption'`, ctx);
  const m = single(rs.filter(r => r.meterName === T[0]), T[1]);
  const lines = [], notes = [];
  if (count) lines.push(line('Networking', 'Virtual Network', T[1], hours * count, 'hours', m[0].retailPrice, m[0].retailPrice * hours * count, meterInfo(m[0])));
  const pre = c.prefixAddresses || 0;
  if (pre && ![2, 4, 8, 16, 32, 64, 128, 256].includes(pre)) throw new PricingError('prefixAddresses must be a public IP prefix size: 2, 4, 8, 16, 32, 64, 128 or 256 addresses (or 0 for none).');
  if (pre) {
    const ptier = (c.prefixTier || 'standard').toLowerCase();
    if (!['standard', 'global'].includes(ptier)) throw new PricingError('prefixTier must be standard or global.');
    const prs = await rows(`serviceName eq 'Virtual Network' and ${regionFilter(ctx)} and productName eq 'Public IP Prefix' and priceType eq 'Consumption'`, ctx);
    const pm = single(prs.filter(r => ptier === 'global' ? r.meterName === 'Global Static Public IP' : r.meterName === 'Standard Static IP Addresses'), `${ptier} public IP prefix`);
    lines.push(line('Networking', 'Virtual Network', `Public IP prefix, ${pre} ${ptier} addresses reserved as a block`, hours * pre, 'IP-hours', pm[0].retailPrice, pm[0].retailPrice * hours * pre, meterInfo(pm[0])));
    if (pre > 16) notes.push('Learn (Azure Public IP address prefix, Limitations): "You can create a prefix of up to 16 IP addresses for Microsoft owned prefixes. Review Network limits increase requests and Azure limits for more information if larger prefixes are required." A prefix of ' + pre + ' addresses needs a networking quota increase request, and each prefix counts its full size against the regional public IP quota.');
  notes.push('A public IP prefix reserves a contiguous block of static addresses; each address in the block bills hourly whether or not it is assigned.');
  }
  if (tier.startsWith('basic')) notes.push('Basic SKU public IPs were retired on 30 September 2025 (Learn, Upgrade Basic Public IP to Standard SKU: "On September 30, 2025, Basic SKU public IPs were retired."); this price is for reference only, new deployments must use Standard.');
  return { lines, notes, facts: { count, tier, prefixAddresses: pre } };
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
  const tierIn = (c.tier || 'regional').toLowerCase();
  if (!['regional', 'global'].includes(tierIn)) throw new PricingError('load-balancer tier must be regional (Standard) or global (cross-region).');
  const global = tierIn === 'global', sku = global ? 'Global' : 'Standard';
  const rules = c.rules ?? 5, gb = c.processedGB || 0, hours = c.hours ?? HOURS;
  const gov = /^(usgov|usdod)/.test(ctx.region);
  const rs = await rows(`serviceName eq 'Load Balancer' and armRegionName eq '${gov ? 'US Gov' : 'Global'}' and skuName eq '${sku}' and priceType eq 'Consumption'`, ctx);
  const inc = single(rs.filter(r => r.meterName === `${sku} Included LB Rules and Outbound Rules`), 'LB included rules');
  const over = single(rs.filter(r => r.meterName === `${sku} Overage LB Rules and Outbound Rules`), 'LB overage rules');
  const lines = [], notes = [];
  const nm = global ? 'Global (cross-region) Load Balancer' : 'Standard Load Balancer';
  if (rules > 0) lines.push(line('Networking', 'Load Balancer', `${nm}, first 5 rules`, hours, 'hours', inc[0].retailPrice, inc[0].retailPrice * hours, meterInfo(inc[0])));
  else notes.push('No load-balancing or outbound rules are configured, so there is no hourly charge (Azure Load Balancer pricing FAQ: there is no hourly charge for the Standard Load Balancer when no rules are configured).');
  if (rules > 5) lines.push(line('Networking', 'Load Balancer', `Additional rules (${rules - 5})`, (rules - 5) * hours, 'rule-hours', over[0].retailPrice, over[0].retailPrice * (rules - 5) * hours, meterInfo(over[0])));
  if (global) notes.push('Global Load Balancer data processing carries no additional charge (Azure Load Balancer pricing page); the regional load balancers behind it bill their own rules and data.');
  else {
    const dp = single(rs.filter(r => r.meterName === 'Standard Data Processed'), 'LB data processed');
    lines.push(line('Networking', 'Load Balancer', `Data processed, ${gb.toLocaleString('en-US')} GB`, gb, 'GB', dp[0].retailPrice, dp[0].retailPrice * gb, meterInfo(dp[0])));
  }
  return { lines, notes, facts: { rules, processedGB: gb, tier: tierIn } };
}

async function priceAppGateway(c, ctx) {
  const basic = (c.tier || 'v2').toLowerCase() === 'basic-v2';
  if (!['v2', 'basic-v2'].includes((c.tier || 'v2').toLowerCase())) throw new PricingError('app-gateway tier must be v2 or basic-v2.');
  const waf = !basic && c.waf !== false, cu = c.capacityUnits ?? 1, hours = c.hours ?? HOURS, captcha = c.captchaSessions || 0;
  if (basic && c.waf === true) throw new PricingError('Application Gateway Basic v2 does not include a web application firewall; use tier v2 with waf true.');
  if (captcha && !waf) throw new PricingError('captchaSessions applies only to Application Gateway WAF v2 (waf true, tier v2).');
  const product = basic ? 'Application Gateway Basic v2' : waf ? 'Application Gateway WAF v2' : 'Application Gateway Standard v2';
  const pre = basic ? 'Basic' : 'Standard';
  const rs = await rows(`serviceName eq 'Application Gateway' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
  const fixed = single(rs.filter(r => r.meterName === `${pre} Fixed Cost`), product + ' fixed');
  const cap = single(rs.filter(r => r.meterName === `${pre} Capacity Units`), product + ' capacity units');
  const lines = [
    line('Networking', 'Application Gateway', `${product}, gateway hours`, hours, 'hours', fixed[0].retailPrice, fixed[0].retailPrice * hours, meterInfo(fixed[0])),
    line('Networking', 'Application Gateway', `${product}, ${cu} capacity unit(s) average`, cu * hours, 'CU-hours', cap[0].retailPrice, cap[0].retailPrice * cu * hours, meterInfo(cap[0]))];
  const notes = ['Application Gateway v2 capacity units scale with traffic, connections and rules; the average used here is an assumption.'];
  if (captcha) {
    const cs = single(rs.filter(r => r.meterName === 'Standard Captcha Sessions'), 'WAF CAPTCHA sessions');
    lines.push(meterLine('Networking', 'Application Gateway', `WAF CAPTCHA sessions, ${captcha.toLocaleString('en-US')}/month`, cs, captcha, ctx));
  }
  if (basic) notes.push('Basic v2 is the lower-cost Application Gateway v2 tier and has no web application firewall; use tier v2 with waf for internet-facing production sites.');
  return { lines, notes, facts: { waf, capacityUnits: cu, tier: basic ? 'basic-v2' : 'v2', captchaSessions: captcha } };
}

// ---------------------------------------------------------------- Containers / PaaS compute
async function priceAks(c, ctx) {
  const tier = (c.tier || 'free').toLowerCase(), hours = c.hours ?? HOURS, count = c.count || 1;
  if (!['free', 'standard', 'premium'].includes(tier)) throw new PricingError(`AKS tier "${c.tier}" is not priced here; use free, standard or premium (Automatic is a separate module).`);
  if (tier === 'free') return { lines: [], notes: ['AKS Free tier: no charge for cluster management; no financially backed uptime SLA.'], facts: { tier } };
  const rs = await rows(`serviceName eq 'Azure Kubernetes Service' and ${regionFilter(ctx)} and productName eq 'Azure Kubernetes Service' and priceType eq 'Consumption'`, ctx);
  const name = tier === 'premium' ? 'Standard Long Term Support' : 'Standard Uptime SLA';
  const m = single(rs.filter(r => r.meterName === name), 'AKS ' + tier);
  return { lines: [line('Containers', 'Azure Kubernetes Service', `${count > 1 ? count + ' x ' : ''}AKS ${tier === 'premium' ? 'Premium (long-term support)' : 'Standard'} tier cluster management`, hours * count, 'hours', m[0].retailPrice, m[0].retailPrice * hours * count, meterInfo(m[0]))], notes: ['AKS nodes are billed as virtual machines and disks, listed separately.'], facts: { tier } };
}

// Whole-term reservation price / term months, or the savings-plan hourly rate x 730 (billed every hour of the term).
function commitRate(commit, base, reservations, what, ctx) {
  const m = /^(ri|sp)(1|3)y$/.exec(commit);
  if (!m) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y, ri3y, sp1y or sp3y.`);
  const term = m[2] === '1' ? '1 Year' : '3 Years';
  if (m[1] === 'ri') {
    const rr = (reservations || []).find(x => x.reservationTerm === term);
    if (!rr) throw new PricingError(`No ${term} reservation price for ${what} in ${ctx.region}.`);
    const months = termMonths(term);
    return { kind: 'ri', term, row: rr, termTotal: rr.retailPrice, monthly: rr.retailPrice / months, months };
  }
  const sp = (base.savingsPlan || []).find(x => x.term === term);
  if (!sp) throw new PricingError(`No ${term} savings plan rate for ${what} in ${ctx.region}.`);
  return { kind: 'sp', term, row: base, rate: sp.unitPrice, monthly: sp.unitPrice * HOURS };
}

async function priceAppService(c, ctx) {
  const plan = c.plan, os = (c.os || 'linux').toLowerCase(), count = c.count || 1, hours = c.hours ?? HOURS;
  const key = Object.keys(catalog.appService).find(k => k.toLowerCase() === String(plan || '').toLowerCase());
  const p = catalog.appService[key];
  if (!p) throw new PricingError(`Unknown App Service plan "${plan}". Known: ${Object.keys(catalog.appService).join(', ')}.`);
  if (!p.os.includes(os)) throw new PricingError(`App Service plan ${key} is not offered on ${os}. It is available on: ${p.os.join(', ')}.`);
  const commit = c.commitment || 'payg';
  const product = `Azure App Service ${p.product}${os === 'linux' ? ' - Linux' : ''}`;
  const norm = x => String(x).replace(/ /g, '').toLowerCase();
  const find = async priceType => (await rows(`serviceName eq 'Azure App Service' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq '${priceType}'`, ctx)).filter(r => norm(r.skuName) === norm(p.sku || key));
  let rs = await find('Consumption');
  if (!rs.length && /^(Free|Shared)/.test(p.product)) rs = (await rows(`serviceName eq 'Azure App Service' and armRegionName eq 'Global' and productName eq '${product}' and priceType eq 'Consumption'`, ctx)).filter(r => norm(r.skuName) === norm(p.sku || key));
  if (!rs.length) throw new PricingError(`App Service plan ${key} (${os}) is not priced in ${ctx.region}; it may not be offered there.`);
  const m = single(rs, `${key} (${os})`);
  const spec = p.memGiB ? `${p.vcpu ? p.vcpu + ' vCPU' : 'shared CPU'}, ${p.memGiB} GiB` : `${p.vcpu} vCPU`;
  const label = `${key} plan, ${os === 'linux' ? 'Linux' : 'Windows'}, ${spec}`;
  const lines = [], notes = [], facts = { plan: key, os, count, tier: p.product.replace(/ Plan$/, ''), commitment: commit, hours };
  if (commit === 'payg') {
    lines.push(line('App Service', 'Azure App Service', `${label}, ${count} instance${count > 1 ? 's' : ''}`, hours * count, 'instance-hours', m[0].retailPrice, m[0].retailPrice * hours * count, meterInfo(m[0])));
  } else {
    const res = /^ri/.test(commit) ? await find('Reservation') : [];
    const cr = commitRate(commit, m[0], res, `${key} (${os})`, ctx);
    if (cr.kind === 'ri') {
      lines.push(line('App Service', 'Azure App Service', `${label}, ${cr.term} reservation, ${count} instance${count > 1 ? 's' : ''}`, count, 'instance / month', cr.monthly, cr.monthly * count, meterInfo(cr.row), { termTotal: cr.termTotal }));
      notes.push(`${cr.term} reservation: ${cr.termTotal} is the whole-term price per instance, divided by ${cr.months} months. Billed whether or not the plan runs.`);
    } else {
      lines.push(line('App Service', 'Azure App Service', `${label}, ${cr.term} savings plan rate, ${count} instance${count > 1 ? 's' : ''}`, HOURS * count, 'instance-hours', cr.rate, cr.rate * HOURS * count, meterInfo(m[0])));
      notes.push(`${cr.term} savings plan: the commitment is billed every hour of the term (730 hours a month) whether or not the plan runs.`);
    }
    if (hours < HOURS) facts.commitmentUnderused = true;
  }
  if (p.product === 'Free Plan') notes.push('Free plan: no charge, but shared infrastructure with daily CPU quotas, no SLA and no scale-out; for evaluation only.');
  if (p.product === 'Shared Plan') notes.push('Shared plan: runs on shared infrastructure with CPU quotas and no SLA, Windows only; for development and testing.');
  const ipn = c.ipSslConnections || 0;
  if (ipn) {
    if (/^(Free|Shared)/.test(p.product)) throw new PricingError('IP SSL needs a Basic or higher plan.');
    const ip = single(await rows(`serviceName eq 'Azure App Service' and ${regionFilter(ctx)} and productName eq 'Azure App Service SSL Connections' and skuName eq 'IP SSL' and priceType eq 'Consumption'`, ctx), 'IP SSL connection');
    const freeIp = /^(Standard|Premium)/.test(p.product) ? 1 : 0;
    const paid = Math.max(0, ipn - freeIp);
    lines.push(line('App Service', 'Azure App Service', `IP SSL connections, ${ipn}${freeIp ? ' (first one included, as in the Azure Pricing Calculator)' : ''}`, paid, 'connections / month', ip[0].retailPrice, ip[0].retailPrice * paid, meterInfo(ip[0])));
  }
  const gl = (sku, desc) => rows(`serviceName eq 'Azure App Service' and armRegionName eq 'Global' and skuName eq '${sku}' and priceType eq 'Consumption'`, ctx).then(r => single(r, desc));
  for (const [k, sku, label, perYear] of [['customDomains', 'Custom Domain', 'Custom domain registrations', 1], ['standardCertificates', 'Standard SSL - 1 Year', 'Standard SSL certificates (1 year)', 1], ['wildcardCertificates', 'Wildcard SSL - 1 Year', 'Wildcard SSL certificates (1 year)', 1]]) {
    const n = c[k] || 0; if (!n) continue;
    const g = await gl(sku, label);
    lines.push(line('App Service', 'Azure App Service', `${label}, ${n}, yearly price spread over 12 months`, n, 'per year', g[0].retailPrice, g[0].retailPrice * n / 12, meterInfo(g[0])));
  }
  if (c.ipSslConnections == null && !ipn) notes.push('SNI SSL bindings are free on Basic and higher plans; IP SSL bindings cost extra (ipSslConnections).');
  return { lines, notes, facts: Object.assign(facts, { ipSslConnections: ipn }) };
}

async function priceFunctions(c, ctx) {
  const plan = (c.plan || 'consumption').toLowerCase();
  const ex = c.executions || 0, commit = (c.commitment || 'payg').toLowerCase();
  if (!['consumption', 'flex'].includes(plan)) throw new PricingError(`Unknown Functions plan "${plan}". Use consumption or flex.`);
  const flex = plan === 'flex', mem = c.instanceMemoryMB;
  if (mem !== undefined && ![512, 2048, 4096].includes(mem)) throw new PricingError(`instanceMemoryMB must be 512, 2048 or 4096 (got ${mem}).`);
  if (!flex && c.memoryMB > 1536) throw new PricingError('Consumption plan instances are limited to 1,536 MB of memory per call (memoryMB). For more memory use the Flex Consumption plan with instanceMemoryMB 2048 or 4096.');
  if (c.alwaysReadyInstances !== undefined && (!Number.isInteger(c.alwaysReadyInstances) || c.alwaysReadyInstances < 0)) throw new PricingError('alwaysReadyInstances must be a whole number of instances.');
  if (!flex && (mem || c.alwaysReadyInstances || c.alwaysReadyExecutions)) throw new PricingError('instanceMemoryMB and always-ready settings apply to the flex plan only.');
  if (!flex && commit !== 'payg') throw new PricingError('Savings plans apply to Flex Consumption only; the Consumption plan has no commitment option.');
  if (!['payg', 'sp1y', 'sp3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}" for Functions. Use payg, sp1y or sp3y.`);
  const memGB = (mem || 2048) / 1024;
  // Flex bills the configured instance memory (default 2,048 MB); Consumption bills observed memory rounded up to 128 MB.
  const gbsOf = n => c.durationMs ? n * (c.durationMs / 1000) * (flex ? memGB : c.memoryMB ? Math.ceil(c.memoryMB / 128) * 128 / 1024 : 0) : 0;
  const gbs = c.gbSeconds ?? (c.durationMs && (flex || c.memoryMB) ? gbsOf(ex) : 0);
  if (!flex && c.durationMs && !c.memoryMB && c.gbSeconds === undefined) throw new PricingError('Consumption plan needs memoryMB per call (or gbSeconds) to price execution time.');
  let product, execName, timeName, sku;
  if (flex) { product = 'Flex Consumption'; sku = 'On Demand'; execName = 'On Demand Total Executions'; timeName = 'On Demand Execution Time'; }
  else { product = 'Functions'; sku = 'Standard'; execName = 'Standard Total Executions'; timeName = 'Standard Execution Time'; }
  const rs = await rows(`serviceName eq 'Functions' and ${regionFilter(ctx)} and productName eq '${product}' and skuName eq '${sku}' and priceType eq 'Consumption'`, ctx);
  if (flex && !rs.length) throw new PricingError(`Flex Consumption is not available in ${ctx.region}. Pick a region where Flex Consumption is offered, or use the Consumption plan.`);
  const e = single(rs.filter(r => r.meterName === execName), 'Functions executions');
  const t = single(rs.filter(r => r.meterName === timeName), 'Functions execution time');
  const spRate = row => { const m = /^sp(1|3)y$/.exec(commit), term = m[1] === '1' ? '1 Year' : '3 Years', sp = (row.savingsPlan || []).find(x => x.term === term); if (!sp) throw new PricingError(`No ${term} savings plan rate for ${row.meterName} in ${ctx.region}.`); return sp.retailPrice; };
  const lines = [];
  const unitSize = r => parseUnit(r.unitOfMeasure).size;
  const freeEx = e.find(r => r.retailPrice === 0) ? (e.find(r => r.retailPrice > 0).tierMinimumUnits * parseUnit(e[0].unitOfMeasure).size) : 0;
  const freeT = t.find(r => r.retailPrice === 0) ? t.find(r => r.retailPrice > 0).tierMinimumUnits * parseUnit(t[0].unitOfMeasure).size : 0;
  const exLabel = `${flex ? 'Flex Consumption' : 'Consumption'} plan executions, ${ex.toLocaleString('en-US')}/month`;
  if (commit === 'payg') {
    const ec = meterCost(e, ex, ctx.ledger), tc = meterCost(t, gbs, ctx.ledger);
    lines.push(
      line('Serverless', 'Functions', `${exLabel} (first ${freeEx.toLocaleString('en-US')} free)`, ex, 'executions', e.find(r => r.retailPrice > 0).retailPrice, ec.cost, meterInfo(e[0]), { unitLabel: `per ${e[0].unitOfMeasure}` }),
      line('Serverless', 'Functions', `Execution time, ${Math.round(gbs).toLocaleString('en-US')} GB-seconds/month (first ${freeT.toLocaleString('en-US')} free)`, gbs, 'GB-seconds', t.find(r => r.retailPrice > 0).retailPrice, tc.cost, meterInfo(t[0])));
  } else {
    const er = e.find(r => r.retailPrice > 0), tr = t.find(r => r.retailPrice > 0);
    lines.push(
      line('Serverless', 'Functions', `${exLabel}, ${commit === 'sp1y' ? '1-year' : '3-year'} savings plan rate (no free grant)`, ex, 'executions', spRate(er), spRate(er) * ex / unitSize(er), meterInfo(er), { unitLabel: `per ${er.unitOfMeasure}` }),
      line('Serverless', 'Functions', `Execution time, ${Math.round(gbs).toLocaleString('en-US')} GB-seconds/month, ${commit === 'sp1y' ? '1-year' : '3-year'} savings plan rate (no free grant)`, gbs, 'GB-seconds', spRate(tr), spRate(tr) * gbs / unitSize(tr), meterInfo(tr)));
  }
  const notes = ['Functions free grants are per subscription per month and are already deducted.', 'A Functions app also needs a storage account (small cost, not modeled unless listed).'];
  if (commit !== 'payg') notes[0] = 'Savings plan rates replace the pay-as-you-go rates; the monthly free grants do not apply under a savings plan in the calculator.';
  if (flex) notes.push(`Flex Consumption bills on-demand time at the configured instance memory size (${mem || 2048} MB${mem ? '' : ', the default'}) for each second an instance executes, not the memory a call uses.${c.memoryMB ? ' memoryMB is ignored on Flex; set instanceMemoryMB instead.' : ''}`);
  const ar = c.alwaysReadyInstances || 0, arEx = c.alwaysReadyExecutions || 0;
  if (flex && (ar || arEx)) {
    const ars = await rows(`serviceName eq 'Functions' and ${regionFilter(ctx)} and productName eq 'Flex Consumption' and skuName eq 'Always Ready' and priceType eq 'Consumption'`, ctx);
    const price = (name, what) => { const r = single(ars.filter(x => x.meterName === name), what); return { r, rate: commit === 'payg' ? r[0].retailPrice : spRate(r[0]) }; };
    const tag = commit === 'payg' ? '' : `, ${commit === 'sp1y' ? '1-year' : '3-year'} savings plan rate`;
    if (ar) {
      const base = price('Always Ready Baseline', 'Always ready baseline'), q = ar * memGB * HOURS * 3600;
      lines.push(line('Serverless', 'Functions', `Always-ready baseline, ${ar} instance(s) x ${mem || 2048} MB, 24x7${tag}`, q, 'GB-seconds', base.rate, base.rate * q, meterInfo(base.r[0])));
    }
    if (arEx) {
      const ee = price('Always Ready Total Executions', 'Always ready executions');
      lines.push(line('Serverless', 'Functions', `Always-ready executions, ${arEx.toLocaleString('en-US')}/month${tag}`, arEx, 'executions', ee.rate, ee.rate * arEx / unitSize(ee.r[0]), meterInfo(ee.r[0]), { unitLabel: `per ${ee.r[0].unitOfMeasure}` }));
      const aq = c.durationMs ? gbsOf(arEx) : 0;
      if (aq) { const et = price('Always Ready Execution Time', 'Always ready execution time'); lines.push(line('Serverless', 'Functions', `Always-ready execution time, ${Math.round(aq).toLocaleString('en-US')} GB-seconds/month${tag}`, aq, 'GB-seconds', et.rate, et.rate * aq, meterInfo(et.r[0]))); }
    }
    notes.push('Always-ready instances bill a baseline per GB-second all month; executions they serve bill the always-ready execution rates, and on-demand executions bill separately above.');
  }
  return { lines, notes, facts: { plan, executions: ex, gbSeconds: gbs, instanceMemoryMB: flex ? (mem || 2048) : undefined, freeGrant: commit === 'payg', commitment: commit, alwaysReadyInstances: ar } };
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

// Retail publishes the savings-plan (savings plan for databases) price in a savingsPlan array on the consumption row; express it as a ratio of that row's own price.
function spRatio(row, commit) {
  const term = commit === 'sp1y' ? '1 Year' : '3 Years';
  const sp = (row.savingsPlan || []).find(x => x.term === term);
  const base = row.srcPrice ?? row.retailPrice;
  if (!sp || !base) throw new PricingError(`No ${term.toLowerCase()} savings plan price is published for this meter in the Retail Prices API; use payg or a reservation.`);
  return sp.unitPrice / base;
}
const SP_NOTE = 'Savings plan for databases (Learn, Azure savings plan overview: applies to Azure SQL Database, SQL Managed Instance, Hyperscale, serverless, and Azure Database for PostgreSQL and MySQL): the Retail savings-plan rate replaces the pay-as-you-go compute rate; storage and backups stay pay-as-you-go. Where Retail publishes a discounted SQL license rate (software IP costs, per Learn) it is discounted too.';

const SQL_HW = {
  'standard-series': { label: 'standard-series (Gen5)', gp: 'Compute Gen5', bc: 'Compute Gen5', hs: 'SingleDB/Elastic Pool Hyperscale - Compute Gen5' },
  'premium-series': { label: 'premium-series', hs: 'Single/Elastic Pool Hyperscale - Premium Series Compute' },
  'premium-series-memory-optimized': { label: 'premium-series memory optimized', hs: 'Single/Elastic Pool Hyperscale - Premium Series Memory Optimized Compute' },
  'fsv2-series': { label: 'FSv2-series (compute optimized)', gp: 'Compute FSv2 Series' },
  'dc-series': { label: 'DC-series (confidential)', gp: 'Compute DC-Series', bc: 'Compute DC-Series', hs: 'Single/Elastic Pool Hyperscale - Compute DC-Series' },
  'm-series': { label: 'M-series (memory optimized)', bc: 'Compute M Series' }
};

async function priceSqlDb(c, ctx) {
  const tier = (c.tier || 'general-purpose').toLowerCase(), vcores = c.vcores, hours = c.hours ?? HOURS, gb = c.storageGB || 32;
  if (!vcores) throw new PricingError('sql-database needs vcores.');
  const hs = tier === 'hyperscale', bc = tier === 'business-critical';
  const hwKey = (c.hardware || 'standard-series').toLowerCase(), hw = SQL_HW[hwKey];
  const serverless = (c.compute || 'provisioned').toLowerCase() === 'serverless', commit = (c.commitment || 'payg').toLowerCase(), zr = !!c.zoneRedundant;
  if (!hw) throw new PricingError(`Unknown hardware "${hwKey}". Use ${Object.keys(SQL_HW).join(', ')}.`);
  if (!['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y, ri3y, sp1y or sp3y.`);
  const isSp = commit.startsWith('sp'), spTxt = commit === 'sp1y' ? '1-year' : '3-year';
  if (serverless && bc) throw new PricingError('Serverless compute is offered in General Purpose and Hyperscale only, not Business Critical.');
  if (serverless && hwKey !== 'standard-series') throw new PricingError('Serverless compute runs on standard-series hardware only.');
  if (serverless && commit !== 'payg' && !isSp) throw new PricingError('Reserved capacity applies to provisioned compute only, not serverless (a savings plan, sp1y or sp3y, does apply).');
  if (hs && zr) throw new PricingError('Hyperscale zone redundancy is configured with HA replicas, which bill as compute; set haReplicas instead of zoneRedundant.');
  if (hs && !hw.hs || !hs && !(bc ? hw.bc : hw.gp)) throw new PricingError(`Hardware "${hwKey}" is not priced for ${hs ? 'Hyperscale' : bc ? 'Business Critical' : 'General Purpose'} in the Retail Prices API.`);
  const tierName = hs ? 'Hyperscale' : bc ? 'Business Critical' : 'General Purpose';
  const tierTag = hs ? 'Hyperscale' : tierName;
  const lines = [], notes = [];
  const lic = async () => sqlLicenseRow(hs ? 'SQL Database SingleDB/Elastic Pool Hyperscale - SQL License' : `SQL Database Single/Elastic Pool ${tierName} - SQL License`, ctx);
  const perVcoreRow = rs => rs.find(r => r.skuName === 'vCore' && r.meterName === 'vCore') || rs.find(r => r.skuName === '1 vCore' && r.meterName === 'vCore');
  const ahb = !!c.ahb;
  const replicas = hs ? (c.haReplicas ?? 0) : 0, named = hs ? (c.namedReplicas ?? 0) : 0;
  if ((c.haReplicas || c.namedReplicas) && !hs) throw new PricingError('haReplicas and namedReplicas apply to Hyperscale only.');
  if (serverless) {
    const prod = hs ? 'SQL Database Hyperscale - Serverless - Compute Gen5' : 'SQL Database General Purpose - Serverless - Compute Gen5';
    const rs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${prod}' and priceType eq 'Consumption'`, ctx);
    const base = single(rs.filter(r => r.skuName === '1 vCore' && /^(1 )?vCore$/.test(r.meterName)), 'SQL serverless compute')[0];
    const minV = c.minVcores ?? 0.5, avg = Math.max(c.avgVcores ?? minV, minV);
    if (avg > vcores || minV > vcores) throw new PricingError('minVcores and avgVcores cannot exceed vcores (the serverless maximum).');
    const active = c.activeHoursPerMonth ?? hours;
    if (c.ahb && !hs) throw new PricingError('Azure Hybrid Benefit for General Purpose serverless has no separate Retail meter; leave ahb off (license included).');
    const bill = avg * active, bRate = base.retailPrice * (isSp ? spRatio(base, commit) : 1);
    lines.push(line('Database', 'SQL Database', `${tierName} serverless compute${hs ? '' : ' (license included)'}, ${avg} vCores billed on average over ${active.toLocaleString('en-US')} active hours (min ${minV}, max ${vcores})${isSp ? `, ${spTxt} savings plan` : ''}`, bill, 'vCore-hours', bRate, bRate * bill, meterInfo(base)));
    if (isSp) notes.push(SP_NOTE);
    if (zr && !hs) {
      const z = single(rs.filter(r => r.skuName === '1 vCore Zone Redundancy' && r.meterName === 'Zone Redundancy vCore'), 'SQL serverless zone redundancy')[0];
      const zr2 = z.retailPrice * (isSp ? spRatio(z, commit) : 1);
      lines.push(line('Database', 'SQL Database', `Zone redundancy add-on, ${avg} vCores x ${active.toLocaleString('en-US')} active hours${isSp ? `, ${spTxt} savings plan` : ''}`, bill, 'vCore-hours', zr2, zr2 * bill, meterInfo(z)));
    }
    if (replicas || named) {
      const rr = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database SingleDB Hyperscale - Serverless - Read Repl - Compute Gen5' and priceType eq 'Consumption'`, ctx);
      const rp = single(rr.filter(r => r.skuName === '1 vCore'), 'Hyperscale serverless replica')[0];
      const n = replicas + named, rb = avg * active * n;
      const rpRate = rp.retailPrice * (isSp ? spRatio(rp, commit) : 1);
      lines.push(line('Database', 'SQL Database', `Hyperscale serverless replicas, ${replicas} HA + ${named} named, ${avg} vCores billed on average each${isSp ? `, ${spTxt} savings plan` : ''}`, rb, 'vCore-hours', rpRate, rpRate * rb, meterInfo(rp)));
    }
    notes.push('Serverless bills per second for the vCores in use (never below the minimum while online) and only storage while auto-paused. avgVcores and activeHoursPerMonth are your estimates; memory-based billing can raise vCores above CPU use.');
  } else {
    const prod = hs ? `SQL Database ${hw.hs}` : `SQL Database Single/Elastic Pool ${tierName} - ${hw[bc ? 'bc' : 'gp']}`;
    const rs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${prod}' and priceType eq 'Consumption'`, ctx);
    const perV = perVcoreRow(rs);
    if (!perV) throw new PricingError(`No per-vCore price for ${prod} in ${ctx.region}.`);
    const unit = parseInt(perV.skuName) ? perV.retailPrice / parseInt(perV.skuName) : perV.retailPrice;
    const copies = 1 + replicas + named;
    const hwText = hwKey === 'standard-series' ? 'Gen5' : hw.label;
    const replText = hs ? (replicas || named ? `, primary + ${replicas} HA + ${named} named replica(s)` : ', primary only (no HA replica)') : '';
    if (commit === 'payg' || isSp) {
      const uRate = unit * (isSp ? spRatio(perV, commit) : 1);
      lines.push(line('Database', 'SQL Database', `${tierName} ${hwText} compute, ${vcores} vCores${replText}${isSp ? `, ${spTxt} savings plan` : ''}`, vcores * hours * copies, 'vCore-hours', uRate, uRate * vcores * hours * copies, meterInfo(perV)));
      if (isSp) notes.push(SP_NOTE);
    }
    else {
      const term = commit === 'ri1y' ? '1 Year' : '3 Years', months = commit === 'ri1y' ? 12 : 36;
      const rr = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${prod}' and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx);
      const r = rr.find(x => x.skuName === 'vCore' && x.meterName === 'vCore');
      if (!r) throw new PricingError(`${prod} has no ${term} reservation price in ${ctx.region}.`);
      lines.push(line('Database', 'SQL Database', `${tierName} ${hwText} compute, ${vcores} vCores${replText}, ${term.toLowerCase()} reserved capacity`, vcores * copies * months, 'vCore-months', r.retailPrice / months, r.retailPrice * vcores * copies / months, meterInfo(r), { unitLabel: 'per vCore-month' }));
      notes.push('A reservation discounts compute only; the SQL Server license (unless Azure Hybrid Benefit applies) and storage stay pay-as-you-go. It also applies to Hyperscale replicas.');
    }
    if (zr) {
      const z = rs.find(r => r.skuName === '1 vCore Zone Redundancy' && r.meterName === 'Zone Redundancy vCore');
      if (z) {
        if (commit === 'payg' || isSp) { const zRate = z.retailPrice * (isSp ? spRatio(z, commit) : 1); lines.push(line('Database', 'SQL Database', `Zone redundancy add-on, ${vcores} vCores${isSp ? `, ${spTxt} savings plan` : ''}`, vcores * hours, 'vCore-hours', zRate, zRate * vcores * hours, meterInfo(z))); }
        else {
          const term = commit === 'ri1y' ? '1 Year' : '3 Years', months = commit === 'ri1y' ? 12 : 36;
          const rr = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${prod}' and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx);
          const r = rr.find(x => x.skuName === 'vCore ZR Zone Redundancy');
          if (!r) throw new PricingError(`No ${term} reservation price for the zone-redundancy add-on in ${ctx.region}.`);
          lines.push(line('Database', 'SQL Database', `Zone redundancy add-on, ${vcores} vCores, ${term.toLowerCase()} reserved capacity`, vcores * months, 'vCore-months', r.retailPrice / months, r.retailPrice * vcores / months, meterInfo(r), { unitLabel: 'per vCore-month' }));
        }
      } else notes.push(bc ? 'Business Critical zone redundancy has no separate compute meter; the zone-redundant configuration is included in the vCore price.' : 'No separate zone-redundancy meter is published for this hardware in this region.');
    }
    if (!ahb && !hs) {
      const l = await lic();
      const copiesLic = copies;
      const lRate = l.retailPrice * (isSp ? spRatio(l, commit) : 1);
      lines.push(line('Database', 'SQL Database', `SQL Server license, ${vcores} vCores${copiesLic > 1 ? ` x ${copiesLic} replicas` : ''} (license included)${isSp ? `, ${spTxt} savings plan` : ''}`, vcores * hours * copiesLic, 'vCore-hours', lRate, lRate * vcores * hours * copiesLic, meterInfo(l)));
    }
    if (hs && (replicas || named)) notes.push('Hyperscale HA and named replicas each bill the same vCore compute as the primary.');
  }
  // Storage
  if (hs) {
    const srs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database Hyperscale - Storage' and priceType eq 'Consumption'`, ctx);
    const st = single(srs.filter(r => r.meterName === 'Hyperscale Data Stored'), 'Hyperscale storage');
    lines.push(line('Database', 'SQL Database', `Hyperscale data storage, ${gb.toLocaleString('en-US')} GB (billed on used size)`, gb, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb, meterInfo(st[0])));
  } else {
    const useZr = zr && !bc;
    const srs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database Single/Elastic Pool ${tierName} - Storage' and priceType eq 'Consumption'`, ctx);
    const meter = useZr ? 'General Purpose Zone Redundancy Data Stored' : `${tierName} Data Stored`;
    const st = single(srs.filter(r => r.meterName === meter), 'SQL storage');
    lines.push(line('Database', 'SQL Database', `Data storage, ${gb.toLocaleString('en-US')} GB${useZr ? ' (zone-redundant storage)' : ''}`, gb, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb, meterInfo(st[0])));
  }
  // Backups
  const redKey = { LRS: 'LRS', ZRS: 'ZRS', GRS: 'RA-GRS', GZRS: 'RA-GZRS' };
  const bred = (c.backupRedundancy || 'GRS').toUpperCase();
  if ((c.backupStorageGB || c.ltrStorageGB) && !redKey[bred]) throw new PricingError('backupRedundancy must be LRS, ZRS, GRS or GZRS.');
  if (c.backupStorageGB) {
    const free = gb;
    const billable = Math.max(0, c.backupStorageGB - free);
    if (hs && billable > 0) {
      const srs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database SingleDB Hyperscale - Storage' and priceType eq 'Consumption'`, ctx);
      const m = single(srs.filter(r => r.meterName === `Backup - ${redKey[bred]} Data Stored`), 'Hyperscale backup');
      lines.push(line('Database', 'SQL Database', `Hyperscale backup storage, ${c.backupStorageGB.toLocaleString('en-US')} GB (${bred}), ${billable.toLocaleString('en-US')} GB beyond the free ${gb.toLocaleString('en-US')} GB`, billable, 'GB / month', m[0].retailPrice, m[0].retailPrice * billable, meterInfo(m[0])));
    } else if (!hs && billable > 0) {
      const brs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq 'SQL Database Single/Elastic Pool PITR Backup Storage' and priceType eq 'Consumption'`, ctx);
      const m = single(brs.filter(r => r.meterName === `${redKey[bred]} Data Stored`), 'SQL PITR backup');
      lines.push(line('Database', 'SQL Database', `Point-in-time backup storage, ${c.backupStorageGB.toLocaleString('en-US')} GB (${bred}), ${billable.toLocaleString('en-US')} GB beyond the free ${gb.toLocaleString('en-US')} GB`, billable, 'GB / month', m[0].retailPrice, m[0].retailPrice * billable, meterInfo(m[0])));
    } else notes.push(`Backup storage of ${c.backupStorageGB.toLocaleString('en-US')} GB is within the free allowance (100% of the ${gb.toLocaleString('en-US')} GB database size).`);
  }
  if (c.ltrStorageGB) {
    const lrs = await rows(`serviceName eq 'SQL Database' and ${regionFilter(ctx)} and productName eq '${hs ? 'SQL Database SingleDB Hyperscale - LTR Backup Storage' : 'SQL Database - LTR Backup Storage'}' and priceType eq 'Consumption'`, ctx);
    const m = single(lrs.filter(r => r.meterName === `Backup ${redKey[bred]} Data Stored`), 'SQL LTR backup');
    lines.push(line('Database', 'SQL Database', `Long-term retention backup storage, ${c.ltrStorageGB.toLocaleString('en-US')} GB (${bred})`, c.ltrStorageGB, 'GB / month', m[0].retailPrice, m[0].retailPrice * c.ltrStorageGB, meterInfo(m[0])));
  }
  if (hs && ahb) notes.push('Azure Hybrid Benefit is not available for Hyperscale: Hyperscale has no SQL software license fee (Learn, Hyperscale service tier).');
  if (hs) notes.push('Hyperscale I/O operations are not charged (Learn); the Retail Hyperscale IO Rate meter and the calculator operations line are not modeled.');
  notes.push('Azure SQL compute is priced per vCore; the SQL Server license is a separate global meter unless Azure Hybrid Benefit applies.');
  if (!c.backupStorageGB) notes.push('Point-in-time backup storage up to 100% of database size is included; long-term retention is extra.');
  return { lines, notes, facts: { vcores, ahb: ahb && !hs, tier, compute: serverless ? 'serverless' : 'provisioned', zoneRedundant: zr, commitment: commit, hardware: hwKey } };
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
  const tier = (c.tier || 'general-purpose').toLowerCase();
  const burst = tier === 'burstable', bcrit = tier === 'business-critical';
  if (bcrit && engine === 'postgres') throw new PricingError('PostgreSQL Flexible Server has no Business Critical tier; use general-purpose or memory-optimized.');
  const tierName = burst ? 'Burstable' : bcrit ? 'Business Critical' : tier === 'memory-optimized' ? 'Memory Optimized' : 'General Purpose';
  const series = c.series || (bcrit ? 'Ev3' : tier === 'memory-optimized' ? (engine === 'postgres' ? 'Edsv5' : 'Eadsv5') : 'Ddsv5'), vcores = c.vcores, hours = c.hours ?? HOURS, gb = c.storageGB || 128, ha = !!c.ha;
  const commit = (c.commitment || 'payg').toLowerCase(), replicas = c.readReplicas || 0;
  if (!vcores) throw new PricingError(`${engine} needs vcores.`);
  if (!['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}". Use payg, ri1y, ri3y, sp1y or sp3y.`);
  const isSp = commit.startsWith('sp'), spTxt = commit === 'sp1y' ? '1-year' : '3-year';
  if (burst && commit !== 'payg') throw new PricingError('Burstable servers cannot be reserved or covered by a savings plan; use payg.');
  const stType = c.storageType || 'ssd';
  if (!['ssd', 'premium-ssd-v2', 'ultra-disk'].includes(stType)) throw new PricingError('storageType must be ssd, premium-ssd-v2 or ultra-disk.');
  if (stType === 'ultra-disk' && engine !== 'postgres') throw new PricingError('Ultra Disk storage is offered for PostgreSQL Flexible Server only.');
  if (burst && ha) throw new PricingError('High availability is not offered on the Burstable tier.');
  const mult = ha ? 2 : 1, copies = mult + replicas;
  const lines = [], notes = [];
  let perV, product, computeLabel;
  if (burst) {
    product = `${svc} Flexible Server Burstable BS Series Compute`;
    const size = (c.burstableSize || { 1: 'B1ms', 2: 'B2s', 4: 'B4ms', 8: 'B8ms', 12: 'B12ms', 16: 'B16ms', 20: 'B20ms' }[vcores] || '').toLowerCase();
    if (!size) throw new PricingError(`No Burstable size has ${vcores} vCores. Use 1, 2, 4, 8, 12, 16 or 20, or set burstableSize (B1ms, B2s, B2ms, B4ms, B8ms, B12ms, B16ms, B20ms).`);
    const rs = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
    const want = size === 'b1s' ? 'basic' : size;
    const hit = rs.filter(r => r.meterName.replace(/ vCore$/, '').toLowerCase() === want);
    if (!hit.length) throw new PricingError(`Burstable ${size.toUpperCase()} is not priced in ${ctx.region}.`);
    const row = single(hit, `${engine} burstable ${size}`)[0];
    perV = row; computeLabel = `Burstable ${size.replace(/^b/, 'B')} compute (whole server)`;
  } else {
    const conf = /^(DC|EC)[A-Za-z]*v6$/.test(series);
    product = `${svc} Flexible Server ${conf ? 'Confidential Compute' : tierName} ${series} Series Compute`;
    const rs = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`${product} is not priced in ${ctx.region}. Try series ${tier === 'memory-optimized' ? (engine === 'postgres' ? 'Edsv5, Eadsv5 or Edsv6' : 'Eadsv5, Edsv5 or Eadsv6') : bcrit ? 'Ev3' : 'Ddsv5, Dadsv5 or Ddsv6'}.`);
    // Some series publish a per-vCore row; others only publish "<n> vCore" rows that are whole-server prices.
    // Retail publishes the same meter as 'vCore'/'vCore', '1 vCore'/'1 vCore', or only per size ('N vCore' in the sku or meter name, whole-server price).
    perV = rs.find(r => r.skuName === 'vCore' && r.meterName === 'vCore') || rs.find(r => /^1 vCore$/.test(r.skuName) || r.meterName === '1 vCore');
    if (!perV) {
      const sizeOf = r => { const m = /^(\d+) vCore$/.exec(r.meterName) || /^(\d+) vCore$/.exec(r.skuName); return m ? parseInt(m[1]) : 0; };
      const sized = rs.filter(r => sizeOf(r) > 0 && /vCore$/.test(r.meterName));
      const ref = sized.find(r => sizeOf(r) === vcores);
      if (!ref) throw new PricingError(`${product} has no ${vcores}-vCore size in ${ctx.region}. Published sizes: ${[...new Set(sized.map(sizeOf))].sort((a, b) => a - b).join(', ') || 'none'}.`);
      perV = Object.assign({}, ref, { retailPrice: ref.retailPrice / sizeOf(ref), srcPrice: ref.retailPrice });
    }
    computeLabel = `${conf ? 'Confidential Compute' : tierName} ${series} compute, ${vcores} vCores`;
  }
  const units = burst ? 1 : vcores;
  const topology = (ha ? ', primary + zone-redundant standby' : '') + (replicas ? `, plus ${replicas} read replica(s)` : '');
  if (commit === 'payg' || isSp) {
    const cRate = perV.retailPrice * (isSp ? spRatio(perV, commit) : 1);
    lines.push(line('Database', svc, computeLabel + topology + (isSp ? `, ${spTxt} savings plan` : ''), units * hours * copies, burst ? 'server-hours' : 'vCore-hours', cRate, cRate * units * hours * copies, meterInfo(perV)));
    if (isSp) notes.push(SP_NOTE);
  }
  else {
    const term = commit === 'ri1y' ? '1 Year' : '3 Years', months = commit === 'ri1y' ? 12 : 36;
    const resProduct = engine === 'mysql' ? `${svc} Flexible Server ${bcrit ? 'Memory Optimized' : tierName} Series Compute` : product;
    const rr = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq '${resProduct}' and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx);
    const r = rr.find(x => x.meterName === 'vCore');
    if (!r) throw new PricingError(`${resProduct} has no ${term} reservation price in ${ctx.region}.`);
    lines.push(line('Database', svc, `${computeLabel}${topology}, ${term.toLowerCase()} reserved capacity`, vcores * copies * months, 'vCore-months', r.retailPrice / months, r.retailPrice * vcores * copies / months, meterInfo(r), { unitLabel: 'per vCore-month' }));
    notes.push(`Reserved capacity discounts compute only (including standby and replica vCores); storage and backups stay pay-as-you-go. ${engine === 'mysql' ? `MySQL reservations are priced per tier, not per series${bcrit ? ' (Business Critical uses the Memory Optimized reservation)' : ''}.` : ''}`.trim());
  }
  const stProduct = engine === 'postgres' ? 'Azure Database for PostgreSQL Flex Server Storage' : 'Azure Database for MySQL Flexible Server Storage';
  const srs = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq '${stProduct}' and priceType eq 'Consumption'`, ctx);
  const v2 = stType === 'premium-ssd-v2';
  if (stType === 'ultra-disk') {
    const um = n => single(srs.filter(r => r.meterName === n), `postgres ${n}`);
    const st = um('Ultra Disk Storage Data Stored'), uio = c.provisionedIops, utp = c.provisionedThroughputMBps;
    lines.push(line('Database', svc, `Ultra Disk storage, ${gb.toLocaleString('en-US')} GB${copies > 1 ? ` x ${copies} servers` : ''}`, gb * copies, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb * copies, meterInfo(st[0])));
    if (uio) { const m = um('Ultra Disk IOPS Provisioned IOPS'); lines.push(line('Database', svc, `Ultra Disk provisioned IOPS, ${uio.toLocaleString('en-US')}${copies > 1 ? ` x ${copies} servers` : ''}`, uio * copies, 'IOPS / month', m[0].retailPrice, m[0].retailPrice * uio * copies, meterInfo(m[0]))); }
    if (utp) { const m = um('Ultra Disk Throughput Prov Throughput (MBps)'); lines.push(line('Database', svc, `Ultra Disk provisioned throughput, ${utp.toLocaleString('en-US')} MB/s${copies > 1 ? ` x ${copies} servers` : ''}`, utp * copies, 'MBps / month', m[0].retailPrice, m[0].retailPrice * utp * copies, meterInfo(m[0]))); }
    notes.push('Ultra Disk storage bills capacity, IOPS and throughput separately; no included IOPS or throughput is published for it, so every provisioned unit is billed.');
  } else if (v2) {
    const pre = engine === 'postgres' ? 'Premium SSD v2' : 'SSD v2';
    const stm = engine === 'postgres' ? 'Premium SSD v2 Storage Data Stored' : 'SSD v2 Data Stored';
    const st = single(srs.filter(r => r.meterName === stm), `${engine} Premium SSD v2 storage`);
    lines.push(line('Database', svc, `Premium SSD v2 storage, ${gb.toLocaleString('en-US')} GB${copies > 1 ? ` x ${copies} servers` : ''}`, gb * copies, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb * copies, meterInfo(st[0])));
    const iops = Math.max(0, (c.provisionedIops ?? 3000) - 3000), mbps = Math.max(0, (c.provisionedThroughputMBps ?? 125) - 125);
    if (iops) { const m = single(srs.filter(r => r.meterName === (engine === 'postgres' ? 'Premium SSD v2 IOPS Provisioned IOPS' : 'SSD v2 IOPS Provisioned IOPS')), `${engine} SSD v2 IOPS`); lines.push(line('Database', svc, `Provisioned IOPS above the 3,000 included, ${iops.toLocaleString('en-US')}${copies > 1 ? ` x ${copies} servers` : ''}`, iops * copies, 'IOPS / month', m[0].retailPrice, m[0].retailPrice * iops * copies, meterInfo(m[0]))); }
    if (mbps) { const m = single(srs.filter(r => r.meterName === (engine === 'postgres' ? 'Premium SSDv2 Throughput Prov Throughput (MBps)' : 'SSD v2 Throughput Prov Throughput (MBps)')), `${engine} SSD v2 throughput`); lines.push(line('Database', svc, `Provisioned throughput above the 125 MB/s included, ${mbps.toLocaleString('en-US')} MB/s${copies > 1 ? ` x ${copies} servers` : ''}`, mbps * copies, 'MBps / month', m[0].retailPrice, m[0].retailPrice * mbps * copies, meterInfo(m[0]))); }
    void pre;
  } else {
    const zrs = engine === 'mysql' && !!c.zoneRedundantStorage;
    const stRows = srs.filter(r => r.meterName === (zrs ? 'Storage ZRS Data Stored' : 'Storage Data Stored'));
    if (!stRows.length) throw new PricingError(`The ${engine} Flexible Server storage meter is not published in the Retail Prices API for ${ctx.region} (not offered or not priced there).`);
    const st = single(stRows, `${engine} storage`);
    lines.push(line('Database', svc, `Storage, ${gb.toLocaleString('en-US')} GB${copies > 1 ? ` x ${copies} servers (primary${ha ? ', standby' : ''}${replicas ? `, ${replicas} replica(s)` : ''}, each with its own copy)` : ''}`, gb * copies, 'GB / month', st[0].retailPrice, st[0].retailPrice * gb * copies, meterInfo(st[0])));
    if (c.paidIoOps) {
      if (engine !== 'mysql') throw new PricingError('paidIoOps applies to MySQL Flexible Server only.');
      const m = single(srs.filter(r => r.meterName === (zrs ? 'Paid IO ZRS IO Rate Operations' : 'Paid IO LRS IO Rate Operations')), 'mysql paid IO');
      lines.push(line('Database', svc, `Paid IO operations beyond the free allowance, ${c.paidIoOps.toLocaleString('en-US')}/month${zrs ? ' (zone-redundant storage)' : ''}`, c.paidIoOps, 'operations', m[0].retailPrice, meterCost(m, c.paidIoOps).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` }));
    }
    if (c.additionalIops) {
      const m = single(srs.filter(r => r.meterName === (engine === 'postgres' ? 'IOPS Scaling Provisioned IOPS' : 'Additional IOPS')), `${engine} additional IOPS`);
      lines.push(line('Database', svc, `Additional provisioned IOPS, ${c.additionalIops.toLocaleString('en-US')}${copies > 1 ? ` x ${copies} servers` : ''}`, c.additionalIops * copies, 'IOPS / month', m[0].retailPrice, m[0].retailPrice * c.additionalIops * copies, meterInfo(m[0])));
    }
  }
  if (c.backupStorageGB) {
    const red = (c.backupRedundancy || 'LRS').toUpperCase();
    if (!['LRS', 'ZRS', 'GRS'].includes(red)) throw new PricingError('backupRedundancy must be LRS, ZRS or GRS.');
    const brs = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq '${svc} Flexible Server Backup Storage' and priceType eq 'Consumption'`, ctx);
    // Retail has LRS (and for MySQL ZRS) backup meters only; geo-redundant backup bills the LRS rate on two copies.
    let m = brs.filter(r => r.meterName === `Backup Storage ${red === 'GRS' ? 'LRS' : red} Data Stored`);
    if (!m.length && red === 'ZRS') m = brs.filter(r => r.meterName === 'Backup Storage LRS Data Stored');
    if (!m.length) throw new PricingError(`${engine} backup storage ${red} is not priced in ${ctx.region}.`);
    const copiesBk = red === 'GRS' ? 2 : 1;
    const billable = Math.max(0, c.backupStorageGB * copiesBk - gb);
    if (billable) lines.push(line('Database', svc, `Backup storage, ${c.backupStorageGB.toLocaleString('en-US')} GB (${red}${copiesBk > 1 ? ', two copies' : ''}), ${billable.toLocaleString('en-US')} GB beyond the free ${gb.toLocaleString('en-US')} GB`, billable, 'GB / month', m[0].retailPrice, m[0].retailPrice * billable, meterInfo(m[0])));
    else notes.push(`Backup storage of ${c.backupStorageGB.toLocaleString('en-US')} GB is within the free allowance (100% of provisioned storage).`);
  }
  if (c.acceleratedLogs) {
    if (engine !== 'mysql' || tier !== 'general-purpose') throw new PricingError('Accelerated logs apply to MySQL Flexible Server General Purpose servers only.');
    const m = single(srs.filter(r => r.meterName === 'Storage GP Accelerated Logs'), 'mysql accelerated logs');
    lines.push(line('Database', svc, `Accelerated logs${copies > 1 ? `, ${copies} servers` : ''}`, hours * copies, 'hours', m[0].retailPrice, m[0].retailPrice * hours * copies, meterInfo(m[0])));
    notes.push('Accelerated logs bill per server-hour while enabled (assumed on every server including standby and replicas).');
  }
  if (c.autonomousTuning) {
    if (engine !== 'postgres') throw new PricingError('Autonomous tuning applies to PostgreSQL Flexible Server only.');
    const trs = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq 'Azure Database for PostgreSQL Flexible Server Autonomous Database Tuning Service' and priceType eq 'Consumption'`, ctx);
    const m = single(trs.filter(r => r.meterName === 'Auto Tune vCore'), 'postgres autonomous tuning');
    lines.push(line('Database', svc, `Autonomous tuning, ${vcores} vCores`, vcores * hours, 'vCore-hours', m[0].retailPrice, m[0].retailPrice * vcores * hours, meterInfo(m[0])));
  }
  if (c.extendedSupport) {
    const ers = await rows(`serviceName eq '${svc}' and ${regionFilter(ctx)} and productName eq '${engine === 'postgres' ? 'Azure Database for Postgres Extended Support' : 'Azure Database for MySQL Extended Support'}' and priceType eq 'Consumption'`, ctx);
    const m = single(ers.filter(r => r.skuName === 'Extended Support'), `${engine} extended support`);
    const q = vcores * hours * (1 + replicas);
    lines.push(line('Database', svc, `Extended support surcharge for an out-of-support major version, ${vcores} vCores${replicas ? ` x ${1 + replicas} servers` : ''}`, q, 'vCore-hours', m[0].retailPrice, m[0].retailPrice * q, meterInfo(m[0])));
    notes.push('Extended support is charged per vCore-hour once the major version passes end of community support; check the date against your version.' + (ha ? ' Assumption: the surcharge is applied to the primary and read replicas only, not the HA standby (not confirmed in Learn).' : ''));
  }
  notes.push(ha ? 'High availability runs a standby server: compute and storage are billed twice.' : '');
  if (!c.backupStorageGB) notes.push('Backup storage up to 100% of provisioned storage is included.');
  if (engine === 'mysql') notes.push('The calculator also offers a reader endpoint (read-replica load-balancing) for MySQL; Retail publishes no separate meter for it, so it is not priced here.');
  if (/^(DC|EC)[A-Za-z]*v6$/.test(series) && !burst) notes.push('Confidential-compute series are priced from their own Retail compute meters.');
  if (burst) notes.push('Burstable servers suit dev/test and low-utilisation workloads; sustained CPU use above the baseline exhausts burst credits.');
  return { lines, notes: notes.filter(Boolean), facts: { ha, vcores, engine, tier, commitment: commit, readReplicas: replicas } };
}

async function priceCosmos(c, ctx) {
  const mode = (c.mode || 'autoscale').toLowerCase(), regions = c.regions || 1, gb = c.storageGB || 0, hours = c.hours ?? HOURS;
  const ppf = !!c.perPartitionFailover, multi = !!c.multiRegionWrites || ppf, free = !!c.freeTier, commit = (c.commitment || 'payg').toLowerCase(), backup = (c.backup || 'periodic').toLowerCase();
  if (!['payg', 'ri1y', 'ri3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}" for Cosmos DB. Use payg, ri1y or ri3y.`);
  if (!['periodic', 'continuous-7d', 'continuous-30d'].includes(backup)) throw new PricingError(`Unknown backup "${backup}". Use periodic, continuous-7d or continuous-30d.`);
  const azR = c.zoneRedundantRegions ?? (c.zoneRedundant ? regions : 0);
  if (azR < 0 || azR > regions) throw new PricingError('zoneRedundantRegions cannot exceed the number of regions.');
  if (multi && regions < 2) throw new PricingError('Multi-region writes and per-partition automatic failover need regions of 2 or more.');
  if (multi && mode === 'serverless') throw new PricingError('Serverless accounts cannot use multi-region writes.');
  if (mode === 'serverless' && regions > 1) throw new PricingError('Serverless accounts are single-region.');
  const util = (c.averageUtilizationPct ?? 100) / 100;
  if (util < 0.1 || util > 1) throw new PricingError('averageUtilizationPct must be between 10 and 100 (autoscale scales between 10% and 100% of the maximum).');
  if (mode === 'autoscale') {
    if (!c.maxRU) throw new PricingError('Autoscale needs the maximum RU/s (maxRU): ask how high the workload peaks. Autoscale bills at the highest RU/s reached each hour, up to this maximum.');
    if (c.maxRU < 1000 || c.maxRU % 1000) throw new PricingError('Autoscale maximum RU/s must be at least 1,000 and a multiple of 1,000.');
  } else if (mode === 'provisioned' && c.ru !== undefined && (c.ru < 400 || c.ru % 100)) throw new PricingError('Provisioned throughput must be at least 400 RU/s, in steps of 100.');
  if (free && mode === 'serverless') throw new PricingError('The free tier discount applies to provisioned throughput and autoscale accounts, not serverless.');
  if (commit !== 'payg' && mode === 'serverless') throw new PricingError('Reserved capacity applies to provisioned throughput and autoscale, not serverless.');
  const rs = await rows(`serviceName eq 'Azure Cosmos DB' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
  const lines = [], notes = [];
  const freeHours = hours * 10;
  if (mode === 'serverless') {
    const m = single(rs.filter(r => r.productName === 'Azure Cosmos DB serverless' && r.meterName === '1M RUs'), 'Cosmos serverless RUs');
    const ru0 = c.requestUnits || 0, ru = azR ? ru0 * 1.25 : ru0;
    lines.push(line('Database', 'Azure Cosmos DB', `Serverless request units, ${ru0.toLocaleString('en-US')}/month${azR ? ' x 1.25 for the availability zone' : ''}`, ru, 'RUs', m[0].retailPrice, meterCost(m, ru).cost, meterInfo(m[0]), { unitLabel: 'per 1M' }));
  } else {
    const auto = mode === 'autoscale', max = c.maxRU, ru = c.ru || 400;
    const mm = multi ? single(rs.filter(r => r.productName === 'Azure Cosmos DB' && r.meterName === '100 Multi-master RU/s' && !/Free/i.test(r.skuName)), 'Cosmos multi-region-write throughput') : null;
    const m = auto && !multi
      ? single(rs.filter(r => r.productName === 'Azure Cosmos DB autoscale' && / 100 RUs$/.test(r.meterName)), 'Cosmos autoscale')
      : mm || single(rs.filter(r => r.productName === 'Azure Cosmos DB' && r.meterName === '100 RU/s' && !/Free/i.test(r.skuName)), 'Cosmos provisioned');
    const mult = auto && multi ? 1.5 : 1;
    const rate = m[0].retailPrice * mult;
    const units = (auto ? max : ru) / 100 * (auto ? util : 1);
    const regEff = regions + (!auto && !multi ? 0.25 * azR : 0);
    const what = auto ? `Autoscale throughput, up to ${max.toLocaleString('en-US')} RU/s${util < 1 ? ` at ${Math.round(util * 100)}% average utilization` : ', billed at maximum'}` : `Provisioned throughput, ${ru.toLocaleString('en-US')} RU/s`;
    const label = `${what}${multi ? (ppf && !c.multiRegionWrites ? ', per-partition automatic failover (Business Critical rate)' : ', multi-region writes') : ''}${regions > 1 ? `, ${regions} regions` : ''}${regEff > regions ? `, ${azR} with availability zones (x1.25)` : ''}`;
    const freeTxt = free ? ', after the free tier 1,000 RU/s' : '';
    if (commit === 'payg') {
      const qty = Math.max(0, units * hours * regEff - (free ? freeHours : 0));
      lines.push(line('Database', 'Azure Cosmos DB', label + freeTxt, qty, '100 RU/s-hours', rate, rate * qty, meterInfo(m[0])));
    } else {
      const term = commit === 'ri1y' ? '1 Year' : '3 Years', months = commit === 'ri1y' ? 12 : 36;
      const rr = await rows(`serviceName eq 'Azure Cosmos DB' and armRegionName eq '${/^(usgov|usdod)/.test(ctx.region) ? 'US Gov' : 'Global'}' and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx);
      // Reserved units are 100 RU/s; autoscale reserves at 100 RU/s x 1.5.
      const norm = auto ? 1.5 : 1;
      let left = Math.ceil(Math.max(0, units * norm * regEff - (free ? 10 * norm : 0)) - 1e-9);
      const total = left;
      for (const [size, name] of [[300000, '30 Million'], [200000, '20 Million'], [100000, '10 Million'], [50000, '5 Million'], [30000, '3 Million'], [20000, '2 Million'], [10000, '1 Million'], [1, '100']]) {
        const k = Math.floor(left / size);
        if (!k) continue;
        const r = rr.find(x => x.skuName === `${name} ${multi ? 'Multi-master ' : ''}RU/s`);
        if (!r) throw new PricingError(`Cosmos DB ${term} reserved capacity is not priced in the Retail Prices API.`);
        left -= k * size;
        lines.push(line('Database', 'Azure Cosmos DB', `${label}${freeTxt}, ${term.toLowerCase()} reserved capacity, ${k} x ${name === '100' ? '100 RU/s units' : name + ' RU/s block' + (k > 1 ? 's' : '')} (${(k * size * 100).toLocaleString('en-US')} of ${(total * 100).toLocaleString('en-US')} reserved RU/s)`, k * months, 'block-months', r.retailPrice / months, r.retailPrice * k / months, meterInfo(r), { unitLabel: 'per block-month', termTotal: r.retailPrice }));
      }
      notes.push(`Reserved capacity is priced from the Retail reservation rows: the whole-term price of each block divided by ${months} months, using the largest volume blocks (30, 20, 10, 5, 3, 2, 1 million RU/s) first and 100 RU/s units for the remainder.${auto ? ' Autoscale reservations are consumed at 100 RU/s x 1.5, so the reserved size is 1.5 x the average autoscale maximum.' : ''}`);
    }
    if (auto) notes.push(`Autoscale bills each hour at the highest RU/s reached, between 10% and 100% of the maximum. ${util < 1 ? 'Shown at the stated average utilization.' : 'Shown at 100% (worst case).'} Autoscale includes availability zones at no extra charge.${multi ? ' Multi-region-write autoscale is the multi-region-write rate x 1.5.' : ''}`);
    else if (multi && azR) notes.push('Multi-region-write accounts bill the same with or without availability zones (no x1.25).');
    else if (azR) notes.push(`Availability zones multiply standard provisioned RU/s by 1.25 in each zone-redundant region of a single-write account (${azR} of ${regions} here).`);
  }
  if (free) notes.push('The free tier gives the first 1,000 RU/s and 25 GB of storage free per account; only one account per subscription can use it.');
  if (gb) {
    const stAll = rs.filter(r => r.productName === 'Azure Cosmos DB' && r.meterName === 'Data Stored' && !/Free/i.test(r.skuName));
    const stNoRum = stAll.filter(r => r.skuName !== 'RUm'); // US Gov shares one meterId with a stale RUm row
    const st = single(/^(usgov|usdod)/.test(ctx.region) && stNoRum.length ? stNoRum : stAll, 'Cosmos storage');
    const qty = Math.max(0, gb * regions - (free ? 25 : 0));
    lines.push(line('Database', 'Azure Cosmos DB', `Transactional storage, ${gb.toLocaleString('en-US')} GB${regions > 1 ? ` x ${regions} regions` : ''}${free ? ', after the free tier 25 GB' : ''}`, qty, 'GB / month', st[0].retailPrice, st[0].retailPrice * qty, meterInfo(st[0])));
  }
  if (c.analyticalStorageGB || c.analyticalWriteOps || c.analyticalReadOps) {
    const as = rs.filter(r => r.productName === 'Azure Cosmos DB Analytics Storage');
    if (c.analyticalStorageGB) { const m = single(as.filter(r => r.meterName === 'Standard Data Stored'), 'Cosmos analytical storage'); const q = c.analyticalStorageGB * regions; lines.push(line('Database', 'Azure Cosmos DB', `Analytical store, ${c.analyticalStorageGB.toLocaleString('en-US')} GB${regions > 1 ? ` x ${regions} regions` : ''}`, q, 'GB / month', m[0].retailPrice, m[0].retailPrice * q, meterInfo(m[0]))); }
    for (const [k, nme, label] of [['analyticalWriteOps', 'Standard Write Operations', 'Analytical store write operations'], ['analyticalReadOps', 'Standard Read Operations', 'Analytical store read operations']]) {
      if (!c[k]) continue;
      const m = single(as.filter(r => r.meterName === nme), label);
      lines.push(line('Database', 'Azure Cosmos DB', `${label}, ${c[k].toLocaleString('en-US')}/month`, c[k], 'operations', m[0].retailPrice, meterCost(m, c[k]).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` }));
    }
    notes.push('Analytical store (Synapse Link / Fabric mirroring) bills storage plus per-10K analytical read and write operations; analytical queries in Synapse or Fabric are billed there.');
  }
  if (backup === 'continuous-30d' && gb) {
    const m = single(rs.filter(r => r.meterName === 'Cont 30D Bckp Continuous Backup'), 'Cosmos continuous backup 30d');
    const q = gb * regions;
    lines.push(line('Database', 'Azure Cosmos DB', `Continuous backup (30 days), ${q.toLocaleString('en-US')} GB across ${regions} region(s)`, q, 'GB / month', m[0].retailPrice, m[0].retailPrice * q, meterInfo(m[0])));
  }
  if (backup !== 'periodic' && c.restoreGB) {
    const nm = backup === 'continuous-30d' ? 'Cont 30D Bckp Data Restore' : null;
    const m = single(rs.filter(r => r.meterName === (nm || 'Cont 30D Bckp Data Restore')), 'Cosmos restore');
    lines.push(line('Database', 'Azure Cosmos DB', `Point-in-time restore data, ${c.restoreGB.toLocaleString('en-US')} GB`, c.restoreGB, 'GB', m[0].retailPrice, m[0].retailPrice * c.restoreGB, meterInfo(m[0])));
  }
  if (backup === 'periodic' && c.backupStorageGB) {
    const red = (c.backupRedundancy || 'LRS').toUpperCase(), key = { LRS: 'LRS', ZRS: 'ZRS', GRS: 'RA-GRS' }[red];
    if (!key) throw new PricingError('Periodic backup redundancy must be LRS, ZRS or GRS.');
    const m = single(rs.filter(r => r.meterName === (red === 'GRS' ? 'Backup Data Stored' : `Periodic Backup - ${key} Data Stored`)), 'Cosmos periodic backup');
    lines.push(line('Database', 'Azure Cosmos DB', `Periodic backup storage beyond the 2 free copies, ${c.backupStorageGB.toLocaleString('en-US')} GB (${red})`, c.backupStorageGB, 'GB / month', m[0].retailPrice, m[0].retailPrice * c.backupStorageGB, meterInfo(m[0])));
  }
  if (c.semanticRerankerQueries) {
    const m = single(rs.filter(r => r.productName === 'Azure Cosmos DB' && r.meterName === 'Semantic Reranker queries'), 'Cosmos semantic reranker');
    lines.push(line('Database', 'Azure Cosmos DB', `Semantic reranker, ${c.semanticRerankerQueries.toLocaleString('en-US')} queries/month`, c.semanticRerankerQueries, 'queries', m[0].retailPrice, meterCost(m, c.semanticRerankerQueries).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` }));
  }
  if (c.gatewaySku) {
    const nodes = c.gatewayNodes || 1;
    const m = single(rs.filter(r => /^Azure Cosmos DB Dedicated Gateway/.test(r.productName) && r.meterName === c.gatewaySku), `Cosmos dedicated gateway ${c.gatewaySku}`);
    lines.push(line('Database', 'Azure Cosmos DB', `Dedicated gateway ${c.gatewaySku}, ${nodes} node(s)${regions > 1 ? ` x ${regions} regions` : ''}`, nodes * regions * hours, 'hours', m[0].retailPrice, m[0].retailPrice * nodes * regions * hours, meterInfo(m[0])));
    notes.push('A dedicated gateway is an integrated cache: node counts bill per region around the clock, whether or not the cache is hit.');
  }
  if (multi) notes.push('Multi-region writes bill every replicated region at the multi-region-write rate (about 2x a single-write region); not available with serverless.');
  if (backup === 'continuous-7d') notes.push('Continuous backup with 7-day retention is included at no charge; restores bill per GB.');
  return { lines, notes, facts: { mode, maxRU: c.maxRU, ru: c.ru, regions, multiRegionWrites: multi, freeTier: free, commitment: commit, backup, zoneRedundantRegions: azR } };
}

// ---------------------------------------------------------------- Storage accounts
// GZRS directory-write rate: no Retail meter matches the calculator in every region, so read the calculator feed for the actual region.
const calcStorageFeeds = {};
async function calcHnsIterativeWrite(red, ctx) {
  const cur = String(ctx.currency || 'USD').toUpperCase();
  const key = `general-purpose-v2-block-blob-structured-hot-${red.toLowerCase()}-iterative-write-operations`;
  try {
    calcStorageFeeds[cur] = calcStorageFeeds[cur] || fetch(`https://azure.microsoft.com/api/v3/pricing/storage/calculator/?culture=en-us&currency=${cur.toLowerCase()}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    const d = await calcStorageFeeds[cur];
    const offer = (d.offers || {})[key];
    const name = require('../../catalog/regions.json')[ctx.region];
    const reg = (d.regions || []).find(r => r.displayName === name);
    const prices = offer && (offer.prices || {});
    const rp = prices && prices.per10k; // only a per-10K price table is accepted; anything else could be a different unit
    const p = rp && reg && rp[reg.slug];
    if (!p || typeof p.value !== 'number') throw new Error(`no rate for ${ctx.region}`);
    return { key, rate: p.value, meter: { meterId: `calculator:${key}:${reg.slug}`, serviceName: 'Storage', productName: 'Azure Pricing Calculator price feed', skuName: red, meterName: key, unitOfMeasure: '10K', armRegionName: ctx.region, retailPrice: p.value } };
  } catch (e) {
    delete calcStorageFeeds[cur];
    throw new PricingError(`The GZRS hierarchical-namespace directory-write rate for ${ctx.region} could not be read from the Azure Pricing Calculator feed (${e.name === 'TimeoutError' ? 'request timed out' : e.message}); it is not estimated. Remove iterativeWriteOps or use another redundancy.`);
  }
}

async function priceBlob(c, ctx) {
  const tier = c.tier || 'Hot', red = (c.redundancy || 'LRS').toUpperCase(), gb = c.capacityGB || 0;
  const premium = tier === 'Premium', hns = (c.namespace || 'flat') === 'hierarchical', commit = c.commitment || 'payg';
  if (premium && !['LRS', 'ZRS'].includes(red)) throw new PricingError('Premium block blob is offered with LRS or ZRS only.');
  // Retail gives several meters the same meterId (Hot write and list/create); the shared dedupe would drop one of them.
  const brows = async f => { const seen = new Map(); for (const it of await query(f, ctx.currency)) { const k = [it.meterId, it.meterName, it.tierMinimumUnits, it.retailPrice, it.type].join('|'); if (!seen.has(k)) seen.set(k, it); } return [...seen.values()]; };
  const sku = premium ? `Premium ${red}` : `${tier} ${red}`;
  const product = premium ? (hns ? 'Premium Block Blob v2 Hierarchical Namespace' : 'Premium Block Blob') : hns ? 'General Block Blob v2 Hierarchical Namespace' : 'General Block Blob v2';
  const nsLabel = hns ? ' hierarchical namespace' : '';
  const rs = await brows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${product}' and skuName eq '${q(sku)}' and priceType eq 'Consumption'`, ctx);
  if (!rs.length) throw new PricingError(`Blob ${sku}${nsLabel} is not priced in ${ctx.region}.`);
  const find = re => rs.filter(r => re.test(r.meterName));
  const lines = [], notes = [];
  const cap = single(find(new RegExp(`^${premium ? 'Premium' : tier} ${red} Data Stored$`)), `${sku} capacity`);
  let payGb = gb;
  const label = `Blob${nsLabel} ${tier} ${red}`;
  if (commit !== 'payg') {
    if (premium) throw new PricingError('Blob reserved capacity applies to standard accounts (Learn); Premium block blob is pay-as-you-go.');
    const term = commit === 'ri1y' ? '1 Year' : commit === 'ri3y' ? '3 Years' : null;
    if (!term) throw new PricingError('Blob storage supports commitment payg, ri1y or ri3y (reserved capacity).');
    const TIB = 1024, PIB = 1024 * 1024;
    const n1 = Math.floor(gb / PIB), n100 = Math.floor((gb - n1 * PIB) / (100 * TIB));
    if (!n1 && !n100) throw new PricingError('Blob reserved capacity is sold in blocks of 100 TiB (102,400 GB) or 1 PiB; this capacity is smaller than one block. Use pay-as-you-go.');
    const rrs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Storage Reserved Capacity' and priceType eq 'Reservation'`, ctx);
    for (const [n, size, blockGb] of [[n1, '1 PB', PIB], [n100, '100 TB', 100 * TIB]]) {
      if (!n) continue;
      const rr = rrs.find(r => r.skuName === `${tier} - ${size} ${red}` && r.reservationTerm === term);
      if (!rr) throw new PricingError(`No ${term} reserved capacity price for ${tier} ${red} in blocks of ${size} in ${ctx.region}.`);
      const months = termMonths(term), monthly = rr.retailPrice / months;
      lines.push(line('Storage', 'Storage', `${label}, ${term} reserved capacity, ${n} x ${size} block${n > 1 ? 's' : ''} (${(n * blockGb).toLocaleString('en-US')} GB)`, n, 'block / month', monthly, monthly * n, meterInfo(rr), { termTotal: rr.retailPrice }));
      payGb -= n * blockGb;
      notes.push(`${term} reserved capacity ${size} ${tier} ${red}: ${rr.retailPrice} per block for the whole term, divided by ${months} months. Operations, retrieval and any capacity above the reserved blocks stay pay-as-you-go.`);
    }
  }
  if (payGb > 0 || commit === 'payg') {
    const cc = meterCost(cap, payGb, ctx.ledger);
    lines.push(line('Storage', 'Storage', `${label} capacity, ${payGb.toLocaleString('en-US')} GB${commit !== 'payg' ? ' beyond the reserved blocks' : ''}${cap.length > 1 ? ' (graduated)' : ''}`, payGb, 'GB / month', cap[0].retailPrice, cc.cost, meterInfo(cap[0])));
  }
  const ops = [['writeOps', /(^|\s)Write Operations$/, 'Write operations'], ['readOps', /(^|\s)Read Operations$/, 'Read operations'], ['otherOps', /(^|\s)(All )?Other Operations$/, 'Other operations'], ['listOps', /List and Create Container Operations$/, 'List and create container operations'], ['iterativeWriteOps', /(^|\s)Write Operations$/, 'Directory (iterative) write operations'], ['iterativeReadOps', /(^|\s)Other Operations$/, 'Directory (iterative) read operations'], ['indexTags', /Index Tags$/, 'Blob index tags'], ['priorityReadOps', /Priority Read Operations$/, 'Archive high-priority read operations']];
  const hotCache = {};
  const hotRows = async r => hotCache[r] || (hotCache[r] = await brows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${hns ? 'General Block Blob v2 Hierarchical Namespace' : 'General Block Blob v2'}' and skuName eq 'Hot ${r}' and priceType eq 'Consumption'`));
  let usedFallback = false;
  for (const [k, re, lab] of ops) {
    if (!c[k]) continue;
    if ((k.startsWith('iterative') && !hns) || (k === 'indexTags' && (hns || premium))) throw new PricingError(`${k} does not apply to this storage account type (${k === 'indexTags' ? 'flat-namespace Hot, Cool, Cold or Archive only' : 'hierarchical namespace only'}).`);
    if (k === 'listOps' && hns && !premium) throw new PricingError('List and create-container operations have no meter for a standard hierarchical-namespace account (the calculator has none either); remove listOps.');
    if (k === 'priorityReadOps' && tier !== 'Archive') throw new PricingError('High-priority rehydration reads apply to the Archive tier only.');
    const clean = list => list.filter(r => re.test(r.meterName) && (k === 'priorityReadOps' || !/Priority/.test(r.meterName)) && !(/^(writeOps|readOps)$/.test(k) && /Iterative/.test(r.meterName)));
    if (k === 'iterativeWriteOps' && /GZRS/.test(red)) {
      const cr = await calcHnsIterativeWrite(red, ctx);
      lines.push(line('Storage', 'Storage', `${lab}, ${c[k].toLocaleString('en-US')}/month`, c[k], 'operations', cr.rate, c[k] / 10000 * cr.rate, cr.meter, { unitLabel: 'per 10K' }));
      continue;
    }
    let pool = clean(rs);
    if (k === 'iterativeWriteOps') { // the calculator prices directory writes with one rate per redundancy for every tier
      pool = clean(await hotRows(red));
      if (!pool.length && /^RA-/.test(red)) pool = clean(await hotRows(red.replace(/^RA-/, '')));
    }
    if (!pool.length && !premium && ['writeOps', 'otherOps', 'listOps', 'iterativeWriteOps', 'iterativeReadOps'].includes(k)) {
      pool = clean(await hotRows(red));
      if (!pool.length && /^RA-/.test(red)) pool = clean(await hotRows(red.replace(/^RA-/, '')));
      if (pool.length) usedFallback = true;
    }
    const m = single(pool, `${sku} ${lab}`);
    const per = k === 'indexTags' ? 'tags' : 'operations';
    lines.push(line('Storage', 'Storage', `${lab}, ${c[k].toLocaleString('en-US')}${k === 'indexTags' ? ' tags' : '/month'}`, c[k], per, m[0].retailPrice, meterCost(m, c[k], ctx.ledger).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` }));
  }
  if (c.priorityRetrievalGB) {
    if (tier !== 'Archive') throw new PricingError('High-priority retrieval applies to the Archive tier only.');
    const m = single(find(/Priority Data Retrieval$/), `${sku} priority retrieval`);
    lines.push(line('Storage', 'Storage', `Archive high-priority retrieval, ${c.priorityRetrievalGB.toLocaleString('en-US')} GB/month`, c.priorityRetrievalGB, 'GB', m[0].retailPrice, m[0].retailPrice * c.priorityRetrievalGB, meterInfo(m[0])));
  }
  if (c.sftpHours) {
    const fr = await brows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Blob Features' and skuName eq 'SSH File Transfer Protocol ${red}' and priceType eq 'Consumption'`);
    const m = single(fr.filter(r => /Hour Enabled$/.test(r.meterName)), `${red} SFTP`);
    lines.push(line('Storage', 'Storage', `SFTP enabled, ${c.sftpHours.toLocaleString('en-US')} hours/month`, c.sftpHours, 'hours', m[0].retailPrice, m[0].retailPrice * c.sftpHours, meterInfo(m[0])));
    if (!hns) notes.push('SFTP requires a hierarchical namespace account; set namespace to hierarchical.');
    notes.push('SFTP bills for every hour it is enabled on the account, whether or not it is used.');
  }
  if (usedFallback) notes.push('Cool, Cold and Archive accounts bill other operations and list/create-container operations at the Hot rates of the same redundancy, as the Azure Pricing Calculator does.');
  if (c.retrievalGB) {
    if (premium) throw new PricingError('Premium block blob has no data retrieval charge.');
    const m = single(find(/Data Retrieval$/).filter(r => !/Priority/.test(r.meterName)), `${sku} retrieval`);
    lines.push(line('Storage', 'Storage', `Data retrieval, ${c.retrievalGB.toLocaleString('en-US')} GB/month`, c.retrievalGB, 'GB', m[0].retailPrice, m[0].retailPrice * c.retrievalGB, meterInfo(m[0])));
  }
  const early = { Cool: 30, Cold: 90, Archive: 180 }[tier];
  if (early) notes.push(`${tier} tier has a ${early}-day minimum storage period; deleting or moving data earlier incurs an early-deletion charge.`);
  if (hns) notes.push('Hierarchical namespace has its own capacity and per-operation rates. Directory (iterative) writes bill at the Hot write rate of the same redundancy for every tier (the calculator uses one rate per redundancy; for GZRS/RA-GZRS the Retail meters do not carry that rate, so the rate for your region is read from the Azure Pricing Calculator price feed at run time) and iterative reads at the tier other-operations rate per 10,000; the separate Azure Data Lake Storage Gen2 product is the data-lake-storage type.');
  if (premium) notes.push('Premium block blob stores data on SSDs for low latency and high transaction rates; it has no Cool, Cold or Archive tiers and no geo-redundancy.');
  return { lines, notes, facts: { tier, redundancy: red, capacityGB: gb, namespace: hns ? 'hierarchical' : 'flat', commitment: commit, hasOps: ops.some(([k]) => c[k]) } };
}

async function priceFiles(c, ctx) {
  const model = (c.model || 'provisioned-v2-hdd').toLowerCase(), red = (c.redundancy || 'LRS').toUpperCase(), gb = c.capacityGB || 0, snapGb = c.snapshotGB || 0;
  const commit = (c.commitment || 'payg').toLowerCase();
  const lines = [], notes = [], facts = { model, capacityGB: gb, redundancy: red, commitment: commit };
  if (!(gb > 0)) throw new PricingError('Azure Files needs capacityGB above 0: a provisioned share is billed from its provisioned size and a pay-as-you-go share from the data stored.');
  if (!['payg', 'ri1y', 'ri3y'].includes(commit)) throw new PricingError(`Unknown commitment "${commit}" for Azure Files. Use payg, ri1y or ri3y.`);
  // Reserved capacity is sold in 10 TiB and 100 TiB blocks; whatever does not fill a block stays pay-as-you-go.
  const reserve = async (product, prefix, meter, label, qty, payg) => {
    const term = commit === 'ri1y' ? '1 Year' : '3 Years', months = commit === 'ri1y' ? 12 : 36;
    const rr = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq '${product}' and priceType eq 'Reservation' and reservationTerm eq '${term}'`, ctx);
    let left = qty;
    for (const [tb, size] of [[100, 102400], [10, 10240]]) {
      const n = Math.floor(left / size); if (!n) continue;
      const r = rr.find(x => x.skuName === `${prefix} - ${tb} TB`);
      if (!r) throw new PricingError(`${product} ${prefix} ${tb} TB ${term} is not priced in ${ctx.region}.`);
      lines.push(line('Storage', 'Storage', `${label}, ${n} x ${tb} TiB reserved capacity (${term.toLowerCase()})`, n * months, 'block-months', r.retailPrice / months, r.retailPrice * n / months, meterInfo(r), { unitLabel: `per ${tb} TiB block-month` }));
      left -= n * size;
    }
    if (left > 0) payg(left, qty > left ? 'remainder not filling a reserved block, ' : '');
    if (left === qty) notes.push(`Reservations are sold in 10 TiB and 100 TiB blocks; ${qty.toLocaleString('en-US')} GiB is below one block so everything bills pay-as-you-go.`);
  };
  if (model === 'premium-v1') {
    if (!['LRS', 'ZRS'].includes(red)) throw new PricingError('Premium Azure Files (v1 provisioned) supports LRS and ZRS only.');
    if (gb < 100) throw new PricingError('A premium (v1) Azure Files share is provisioned from 100 GiB; use provisioned-v2-ssd for smaller shares (from 32 GiB).');
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Premium Files' and skuName eq 'Premium ${red}' and priceType eq 'Consumption'`, ctx);
    const st = single(rs.filter(r => r.meterName === `Premium ${red} Provisioned`), 'Premium Files provisioned');
    const pay = (q, pre) => lines.push(line('Storage', 'Storage', `Premium Azure Files ${red}, ${pre}${q.toLocaleString('en-US')} GiB provisioned`, q, 'GB / month', st[0].retailPrice, st[0].retailPrice * q, meterInfo(st[0])));
    if (commit === 'payg') pay(gb, ''); else await reserve('Premium Files Reserved Capacity', `Premium ${red}`, 'Provisioned', `Premium Azure Files ${red}`, gb, pay);
    if (snapGb) { const sn = single(rs.filter(r => r.meterName === `Premium ${red} Snapshots`), 'Premium Files snapshots'); lines.push(line('Storage', 'Storage', `Share snapshots, ${snapGb.toLocaleString('en-US')} GiB of changed data`, snapGb, 'GB / month', sn[0].retailPrice, sn[0].retailPrice * snapGb, meterInfo(sn[0]))); }
    for (const [k, mn, label, unit] of [['burstBandwidthGiB', 'Burst Bandwidth', 'Paid bandwidth bursting', 'GiB'], ['burstTransactionsMillions', 'Burst Transactions', 'Paid transaction bursting', 'million transactions']]) {
      if (!c[k]) continue;
      const m = single(rs.filter(r => r.meterName === `Premium ${red} ${mn}`), label);
      lines.push(line('Storage', 'Storage', `${label}, ${c[k].toLocaleString('en-US')} ${unit}/month`, c[k], unit, m[0].retailPrice, m[0].retailPrice * c[k], meterInfo(m[0])));
    }
    notes.push('Premium (v1) shares bill the provisioned size, which also sets the baseline IOPS and throughput; transactions are not billed. Provisioned v2 SSD lets you set storage, IOPS and throughput separately. Source: https://learn.microsoft.com/azure/storage/files/understanding-billing');
  } else if (model.startsWith('provisioned-v2')) {
    const media = model.endsWith('ssd') ? 'SSD' : 'HDD';
    if (commit !== 'payg') throw new PricingError('Reserved capacity does not apply to provisioned v2 shares; use payg, or premium-v1 / payg-hot / payg-cool with a reservation.');
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Azure Files Provisioned v2' and skuName eq '${media} ${red}' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Files provisioned v2 ${media} ${red} is not priced in ${ctx.region}.`);
    const ssd = media === 'SSD';
    if (gb > 262144) throw new PricingError('A provisioned v2 share can be at most 256 TiB (262,144 GiB) (Learn, Understand Azure Files billing: Maximum provisioned storage 256 TiB); split the data across several shares/accounts.');
    if (gb < 32) throw new PricingError('A provisioned v2 share is at least 32 GiB; the minimum IOPS and throughput are billed from that share size.');
    const lim = ssd ? { iopsMin: 3000, iopsMax: 102400, tpMin: 100, tpMax: 10340, io0: 3000, io1: 1, tp0: 100, tp1: 0.1 } : { iopsMin: 500, iopsMax: 50000, tpMin: 60, tpMax: 5120, io0: 1000, io1: 0.2, tp0: 60, tp1: 0.02 };
    const recIo = lim.io0 + Math.ceil(lim.io1 * gb), recTp = lim.tp0 + Math.ceil(lim.tp1 * gb);
    const capIo = Math.min(lim.iopsMax, 5 * recIo), capTp = Math.min(lim.tpMax, 5 * recTp);
    const rangeErr = (what, v, lo, hi, rec, unit) => { if (v < lo || v > hi) throw new PricingError(`Provisioned v2 ${media} ${what} for a ${gb.toLocaleString('en-US')} GiB share must be between ${lo.toLocaleString('en-US')} and ${hi.toLocaleString('en-US')} ${unit} (the cap is 5x the recommended ${rec.toLocaleString('en-US')} or the media maximum, whichever is lower); got ${v.toLocaleString('en-US')}.`); };
    if (c.iops != null) rangeErr('IOPS', c.iops, lim.iopsMin, capIo, recIo, 'IOPS');
    if (c.throughputMBps != null) rangeErr('throughput', c.throughputMBps, lim.tpMin, capTp, recTp, 'MiB/s');
    const iops = c.iops != null ? c.iops : Math.min(Math.max(recIo, lim.iopsMin), lim.iopsMax), mbps = c.throughputMBps != null ? c.throughputMBps : Math.min(Math.max(recTp, lim.tpMin), lim.tpMax);
    const g = n => rs.filter(r => r.meterName === `${media} ${red} ${n}`);
    const st = single(g('Provisioned Storage'), 'Files storage'), io = single(g('Provisioned IOPS'), 'Files IOPS'), tp = single(g('Provisioned Throughput MiBPS'), 'Files throughput');
    lines.push(line('Storage', 'Storage', `Azure Files provisioned v2 ${media} ${red}, ${gb.toLocaleString('en-US')} GiB provisioned`, gb * HOURS, 'GiB-hours', st[0].retailPrice, st[0].retailPrice * gb * HOURS, meterInfo(st[0])));
    const freeIo = ssd ? 3000 : 0, freeTp = ssd ? 100 : 0;
    const tagIo = c.iops != null ? 'provisioned' : 'recommended default', tagTp = c.throughputMBps != null ? 'provisioned' : 'recommended default';
    lines.push(line('Storage', 'Storage', `Provisioned IOPS, ${iops.toLocaleString('en-US')} (${tagIo}${ssd ? ', first 3,000 free' : ''})`, Math.max(0, iops - freeIo) * HOURS, 'IOPS-hours', io[0].retailPrice, io[0].retailPrice * Math.max(0, iops - freeIo) * HOURS, meterInfo(io[0])));
    lines.push(line('Storage', 'Storage', `Provisioned throughput, ${mbps.toLocaleString('en-US')} MiB/s (${tagTp}${ssd ? ', first 100 free' : ''})`, Math.max(0, mbps - freeTp) * HOURS, 'MiBps-hours', tp[0].retailPrice, tp[0].retailPrice * Math.max(0, mbps - freeTp) * HOURS, meterInfo(tp[0])));
    facts.iops = iops; facts.throughputMBps = mbps;
    if (c.softDeletedGB) { const sd = single(g('Soft-Deleted Usage'), 'Files soft-deleted usage'); lines.push(line('Storage', 'Storage', `Soft-deleted shares still in the retention period, ${c.softDeletedGB.toLocaleString('en-US')} GiB`, c.softDeletedGB * HOURS, 'GiB-hours', sd[0].retailPrice, sd[0].retailPrice * c.softDeletedGB * HOURS, meterInfo(sd[0]))); }
    if (snapGb) { const sn = single(g('Overflow Snapshot Usage'), 'Files snapshots'); lines.push(line('Storage', 'Storage', `Snapshot usage beyond provisioned size, ${snapGb.toLocaleString('en-US')} GiB`, snapGb * HOURS, 'GiB-hours', sn[0].retailPrice, sn[0].retailPrice * snapGb * HOURS, meterInfo(sn[0]))); }
    notes.push('Provisioned v2: you pay for provisioned storage, IOPS and throughput, not for transactions. IOPS and throughput use the Azure-recommended defaults for the provisioned size unless specified; each can be set from the media minimum up to 5x the recommended value. Source: https://learn.microsoft.com/azure/storage/files/understanding-billing');
  } else {
    const tierMap = { 'payg-hot': 'Hot', 'payg-cool': 'Cool', 'payg-transaction-optimized': 'Standard' };
    const t = tierMap[model];
    if (!t) throw new PricingError(`Unknown Azure Files model "${model}". Use provisioned-v2-hdd, provisioned-v2-ssd, premium-v1, payg-hot, payg-cool, payg-transaction-optimized.`);
    if (commit !== 'payg' && t === 'Standard') throw new PricingError('Reserved capacity is sold for the Hot and Cool tiers only, not transaction optimized.');
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Files v2' and skuName eq '${t} ${red}' and priceType eq 'Consumption'`, ctx);
    const st = single(rs.filter(r => r.meterName === (t === 'Standard' ? `${red} Data Stored` : `${t} ${red} Data Stored`)), 'Files data stored');
    const word = t === 'Standard' ? 'transaction optimized' : t.toLowerCase();
    const pay = (q, pre) => lines.push(line('Storage', 'Storage', `Azure Files pay-as-you-go ${word} ${red}, ${pre}${q.toLocaleString('en-US')} GB stored`, q, 'GB / month', st[0].retailPrice, st[0].retailPrice * q, meterInfo(st[0])));
    if (commit === 'payg') pay(gb, ''); else await reserve('Files Reserved Capacity', `${t} ${red}`, 'Data Stored', `Azure Files ${word} ${red}`, gb, pay);
    if (snapGb) lines.push(line('Storage', 'Storage', `Share snapshots, ${snapGb.toLocaleString('en-US')} GB of changed data (billed at the data-stored rate)`, snapGb, 'GB / month', st[0].retailPrice, st[0].retailPrice * snapGb, meterInfo(st[0])));
    for (const [k, re, label] of [['writeOps', /Write Operations$/, 'Write operations'], ['readOps', /Read Operations$/, 'Read operations'], ['listOps', /List Operations$/, 'List operations']]) {
      if (!c[k]) continue;
      const m = single(rs.filter(r => re.test(r.meterName)), label);
      lines.push(line('Storage', 'Storage', `${label}, ${c[k].toLocaleString('en-US')}/month`, c[k], 'operations', m[0].retailPrice, meterCost(m, c[k], ctx.ledger).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` }));
    }
    if (c.otherOps) { const m = single(rs.filter(r => /(Other|Protocol) Operations$/.test(r.meterName)), 'Other operations'); lines.push(line('Storage', 'Storage', `Other (protocol) operations, ${c.otherOps.toLocaleString('en-US')}/month`, c.otherOps, 'operations', m[0].retailPrice, meterCost(m, c.otherOps, ctx.ledger).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` })); }
    if (c.metadataGB) {
      if (t === 'Standard') throw new PricingError('Metadata at rest is billed on the hot and cool tiers only; remove metadataGB for transaction optimized shares.');
      const m = single(rs.filter(r => /Metadata$/.test(r.meterName)), 'Files metadata');
      lines.push(line('Storage', 'Storage', `Metadata at rest, ${c.metadataGB.toLocaleString('en-US')} GB (ACLs and file properties)`, c.metadataGB, 'GB / month', m[0].retailPrice, m[0].retailPrice * c.metadataGB, meterInfo(m[0])));
    }
    if (c.retrievalGB) {
      if (t !== 'Cool') throw new PricingError('Only the cool tier has a data retrieval charge; remove retrievalGB or use payg-cool.');
      const m = single(rs.filter(r => /Data Retrieval$/.test(r.meterName)), 'Files data retrieval');
      lines.push(line('Storage', 'Storage', `Cool data retrieval, ${c.retrievalGB.toLocaleString('en-US')} GB read or moved to a hotter tier`, c.retrievalGB, 'GB', m[0].retailPrice, m[0].retailPrice * c.retrievalGB, meterInfo(m[0])));
    }
    notes.push('Pay-as-you-go Azure Files also bills transactions; they can exceed the storage cost on busy shares. Delete operations are free. Hot and cool shares also bill metadata at rest.');
  }
  if (c.geoReplicationGB) {
    if (red !== 'GRS' && red !== 'GZRS') throw new PricingError('Geo-replication data transfer applies to GRS and GZRS shares only.');
    const gr = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and productName eq 'Storage - Bandwidth' and skuName eq 'Geo-Replication v2' and priceType eq 'Consumption'`, ctx);
    const m = single(gr.filter(r => /Data Transfer$/.test(r.meterName)), 'Geo-replication data transfer');
    lines.push(line('Storage', 'Storage', `Geo-replication data transfer to the secondary region, ${c.geoReplicationGB.toLocaleString('en-US')} GB written`, c.geoReplicationGB, 'GB', m[0].retailPrice, m[0].retailPrice * c.geoReplicationGB, meterInfo(m[0])));
  }
  if (red === 'GRS' || red === 'GZRS') notes.push(`${red} copies the share to the paired region; a geo-redundant share cannot be failed over by you except by Microsoft-managed or customer-initiated account failover.`);
  return { lines, notes, facts };
}

// ---------------------------------------------------------------- Monitoring / AI
async function priceLogAnalytics(c, ctx) {
  const perDay = c.ingestGBPerDay || 0, gbMonth = perDay * (730 / 24), retentionDays = c.retentionDays || 31;
  const tierGB = c.commitmentTier;
  if (retentionDays < 4 || retentionDays > 4383) throw new PricingError('retentionDays must be between 4 and 4,383 (12 years in total: up to 730 days of interactive retention, the rest as long-term retention).');
  for (const k of ['restoreGB', 'restoreDays', 'transformIncomingGBPerDay']) if (c[k] !== undefined && c[k] < 0) throw new PricingError(`${k} cannot be negative.`);
  if (c.transformDroppedPct !== undefined && (c.transformDroppedPct < 0 || c.transformDroppedPct > 100)) throw new PricingError('transformDroppedPct must be between 0 and 100.');
  const rs = await rows(`serviceName eq 'Log Analytics' and ${regionFilter(ctx)} and skuName eq 'Analytics Logs' and priceType eq 'Consumption'`, ctx);
  const ing = single(rs.filter(r => r.meterName === 'Analytics Logs Data Ingestion'), 'Log Analytics ingestion');
  const crs = await rows(`serviceName eq 'Azure Monitor' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
  const tiers = crs.filter(r => /GB Commitment Tier Capacity Reservation$/.test(r.meterName)).map(r => ({ gb: parseInt(r.meterName), perDay: r.retailPrice, row: r })).sort((a, b) => a.gb - b.gb);
  const lines = [];
  if (tierGB) {
    const t = tiers.find(x => x.gb === tierGB);
    if (!t) throw new PricingError(`No ${tierGB} GB/day commitment tier is priced in ${ctx.region}. Available: ${tiers.map(x => x.gb).join(', ')}.`);
    lines.push(line('Monitoring', 'Log Analytics', `Commitment tier ${tierGB} GB/day, billed daily whether used or not`, 730 / 24, 'days', t.perDay, t.perDay * (730 / 24), meterInfo(t.row)));
    const over = Math.max(0, perDay - tierGB) * (730 / 24);
    if (over) lines.push(line('Monitoring', 'Log Analytics', `Ingestion above the tier, ${Math.round(over).toLocaleString('en-US')} GB/month at the tier's effective per-GB rate`, over, 'GB', t.perDay / tierGB, over * t.perDay / tierGB, meterInfo(t.row)));
  } else {
    const mc = meterCost(ing, gbMonth, ctx.ledger);
    lines.push(line('Monitoring', 'Log Analytics', `Analytics Logs ingestion, ${perDay} GB/day (~${Math.round(gbMonth).toLocaleString('en-US')} GB/month, first 5 GB free)`, gbMonth, 'GB', ing.find(r => r.retailPrice > 0).retailPrice, mc.cost, meterInfo(ing[0])));
  }
  const interactive = Math.min(retentionDays, 730), longTerm = Math.max(0, retentionDays - 730);
  if (interactive > 31) {
    const ret = single(rs.filter(r => r.meterName === 'Analytics Logs Data Retention'), 'retention');
    const extraGb = gbMonth * ((interactive - 31) / (730 / 24));
    lines.push(line('Monitoring', 'Log Analytics', `Interactive retention beyond 31 days (${interactive} days${longTerm ? ', the 730-day maximum' : ''})`, extraGb, 'GB / month', ret[0].retailPrice, ret[0].retailPrice * extraGb, meterInfo(ret[0])));
  }
  let commitment = null;
  if (tiers.length) commitment = { smallest: tiers[0], payg100PerDay: 100 * ing.find(r => r.retailPrice > 0).retailPrice };
  const notes = ['730/24 = 30.42 days per month. Interactive retention of 31 days is included (90 days for Microsoft Sentinel-enabled workspaces).'];
  const mon = n => crs.filter(r => r.meterName === n);
  const add = (qtyPerMonth, meterName, label, unit, what) => {
    if (!qtyPerMonth) return;
    const m = single(mon(meterName), what);
    lines.push(line('Monitoring', 'Log Analytics', label, qtyPerMonth, unit, m[0].retailPrice, meterCost(m, qtyPerMonth, ctx.ledger).cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` }));
  };
  const gm = x => (x || 0) * (730 / 24);
  if (longTerm) {
    const arc = single(mon('Data Archive'), 'Data archive');
    const q = gbMonth * (longTerm / (730 / 24));
    lines.push(line('Monitoring', 'Log Analytics', `Long-term retention (Data Archive) for days 731 to ${retentionDays}, ${longTerm} days`, q, 'GB / month', arc[0].retailPrice, arc[0].retailPrice * q, meterInfo(arc[0])));
    notes.push(`Retention of ${retentionDays} days = 730 days of interactive retention (Analytics Logs retention rate) plus ${longTerm} days of long-term retention at the Data Archive rate. The maximum total is 12 years (4,383 days).`);
  }
  add(gm(c.basicLogsGBPerDay), 'Basic Logs Data Ingestion', `Basic Logs ingestion, ${c.basicLogsGBPerDay} GB/day (~${Math.round(gm(c.basicLogsGBPerDay)).toLocaleString('en-US')} GB/month)`, 'GB', 'Basic Logs ingestion');
  add(gm(c.auxiliaryLogsGBPerDay), 'Logs Processed GB', `Auxiliary Logs processing, ${c.auxiliaryLogsGBPerDay} GB/day (~${Math.round(gm(c.auxiliaryLogsGBPerDay)).toLocaleString('en-US')} GB/month)`, 'GB', 'Auxiliary Logs processing');
  add(gm(c.auxiliaryLogsGBPerDay), 'Auxiliary Logs Data Ingestion', `Auxiliary Logs ingestion, ${c.auxiliaryLogsGBPerDay} GB/day (~${Math.round(gm(c.auxiliaryLogsGBPerDay)).toLocaleString('en-US')} GB/month)`, 'GB', 'Auxiliary Logs ingestion');
  add(c.searchQueryScannedGB, 'Search Queries Scanned', `Basic/Auxiliary log queries, ${(c.searchQueryScannedGB || 0).toLocaleString('en-US')} GB scanned`, 'GB', 'Search queries');
  add(c.searchJobScannedGB, 'Search Jobs Scanned', `Search jobs, ${(c.searchJobScannedGB || 0).toLocaleString('en-US')} GB scanned`, 'GB', 'Search jobs');
  if (c.restoreGB) {
    const rGB = Math.max(c.restoreGB, 2048), rDays = Math.max(c.restoreDays ?? 1, 0.5);
    add(rGB * rDays, 'Data Restore', `Data restore, ${c.restoreGB.toLocaleString('en-US')} GB kept ${c.restoreDays ?? 1} day(s), billed at ${rGB.toLocaleString('en-US')} GB x ${rDays} day(s)${rGB > c.restoreGB || rDays > (c.restoreDays ?? 1) ? ' (minimum 2 TB and 12 hours)' : ''}`, 'GB-days', 'Data restore');
  }
  add(gm(c.replicatedGBPerDay), 'Data Replication Data Replicated', `Workspace replication, ${c.replicatedGBPerDay} GB/day (~${Math.round(gm(c.replicatedGBPerDay)).toLocaleString('en-US')} GB/month)`, 'GB', 'Workspace replication');
  if (c.transformIncomingGBPerDay) {
    const dropped = c.transformIncomingGBPerDay * (c.transformDroppedPct || 0) / 100, billed = Math.max(0, dropped - c.transformIncomingGBPerDay / 2);
    add(gm(billed), 'Platform Logs Data Processed', `Ingestion-time transformation processing, ${c.transformIncomingGBPerDay} GB/day in, ${c.transformDroppedPct || 0}% dropped = ${billed.toFixed(2)} GB/day above the free 50%`, 'GB', 'Transformation processing');
    notes.push('Ingestion-time transformations are free unless they drop more than 50% of the incoming data: the processing charge is dropped GB minus half the incoming GB. Transformations that add data are charged at the normal ingestion rate through the ingestion lines (give ingestGBPerDay after transformation).');
  }
  add(gm(c.exportGBPerDay), 'Log Analytics data export Data Exported', `Data export, ${c.exportGBPerDay} GB/day (~${Math.round(gm(c.exportGBPerDay)).toLocaleString('en-US')} GB/month)`, 'GB', 'Data export');
  add(c.archiveGB, 'Data Archive', `Long-term retention (archive), ${(c.archiveGB || 0).toLocaleString('en-US')} GB stored`, 'GB / month', 'Data archive');
  if (c.basicLogsGBPerDay || c.auxiliaryLogsGBPerDay) notes.push('Basic and Auxiliary logs are ingested at a low per-GB price with 30 days of interactive retention and limited, per-GB-scanned queries; use them for high-volume, rarely queried data.');
  if (c.auxiliaryLogsGBPerDay) notes.push('Auxiliary Logs bill ingestion plus a per-GB processing charge (Logs Processed GB); both are included. The billed size is the uncompressed size of the data.');
  if (c.searchJobScannedGB) notes.push('Search jobs also bill the results table at the standard Analytics Logs ingestion rate; add the result volume to ingestGBPerDay if it matters.');
  if (c.restoreGB) notes.push('Data restore bills per GB per day the restored data stays available; the minimum billed is 2 TB and 12 hours, pro-rated above that.');
  if (tierGB) notes.push('Commitment tiers bill the full tier every day and replace pay-as-you-go ingestion; the 5 GB free allowance does not stack with them.');
  return { lines, notes, facts: { perDay, commitment, commitmentTier: tierGB || null, retentionDays, basicLogsGBPerDay: c.basicLogsGBPerDay || 0, auxiliaryLogsGBPerDay: c.auxiliaryLogsGBPerDay || 0, restoreGB: c.restoreGB || 0 } };
}

// Meter names are inconsistent across Azure OpenAI products (Inp/inp/Input, glbl/Gl/global, Dz/DZone/Data Zone), so
// meters are compared by a normalised token signature rather than by string.
const AI_SYN = { glbl: 'gl', global: 'gl', dzone: 'dz', datazone: 'dz', regnl: 'rg', regional: 'rg', rgnl: 'rg', inpt: 'inp', input: 'inp', outp: 'opt', output: 'opt', out: 'opt', cchd: 'cd', cached: 'cd', bch: 'batch' };
function aiSig(name, drop = [], add = []) {
  const toks = name.toLowerCase().replace(/data zone/g, 'dz').replace(/[-_/]/g, ' ').split(/\s+/).filter(Boolean).map(t => AI_SYN[t] || t).filter(t => !['tokens', '1m', '1k', 'gpt', 'unit'].includes(t) && !drop.includes(t));
  return [...toks, ...add].sort().join(' ');
}

async function priceOpenAi(c, ctx) {
  const key = (c.model || '').toLowerCase();
  const m = aiModels[key];
  if (!m && /^gpt-6\.1/.test(key)) throw new PricingError('gpt-6.1 models are listed in the calculator, but the Retail Prices API publishes no meters for them yet, so they are not priced. Use gpt-6-sol, gpt-6-luna or gpt-6-astra, or a "meter" component once meters appear.');
  if (!m) throw new PricingError(`Unknown model "${c.model}". Known: ${Object.keys(aiModels).join(', ')}. For others use a "meter" component.`);
  const gov = /^(usgov|usdod)/.test(ctx.region);
  if (gov && (c.deployment || '').toLowerCase() === 'global') throw new PricingError('Azure Government has no Global deployment: use deployment datazone (Standard Data Zone, US Gov) or regional (Learn: models sold directly by Azure, Azure Government). Region eastus2 prices are not valid for Gov.');
  const dep = (c.deployment || (gov ? (m.media && !m.media.some(e => e.meters.dz) ? 'regional' : 'datazone') : 'global')).toLowerCase(), proc = (c.processing || 'standard').toLowerCase(), ft = !!c.fineTuned;
  if (!['global', 'datazone', 'regional'].includes(dep)) throw new PricingError('deployment must be global, datazone or regional.');
  if (!['standard', 'batch', 'priority'].includes(proc)) throw new PricingError('processing must be standard, batch or priority.');
  if ((c.trainingTokens || c.hostingHours) && !ft) throw new PricingError('trainingTokens and hostingHours apply to fineTuned models; set fineTuned true.');
  if (ft && !m.ft) throw new PricingError(`No fine-tuned pricing is modeled for ${key}. Fine-tunable models here: ${Object.entries(aiModels).filter(([, v]) => v.ft).map(([k]) => k).join(', ')}.`);
  if (ft && proc !== 'standard') throw new PricingError('Fine-tuned deployments bill at Standard processing only.');
  const dkey = { global: 'gl', datazone: 'dz', regional: 'rg' }[dep];
  const label = `${dep === 'global' ? 'Global' : dep === 'datazone' ? 'Data Zone' : 'Regional'} ${proc === 'standard' ? 'Standard' : proc === 'batch' ? 'Batch' : 'Priority'}${ft ? ' fine-tuned' : ''}`;
  const base = ft ? m.ft : m;
  const streams = [['inputTokens', base.input, 'Input tokens'], ['cachedInputTokens', base.cached, 'Cached input tokens'], ['outputTokens', base.output, 'Output tokens'], ['audioInputTokens', base.audioInput, 'Audio input tokens'], ['audioOutputTokens', base.audioOutput, 'Audio output tokens'], ['imageInputTokens', base.imageInput, 'Image input tokens'], ['imageOutputTokens', base.imageOutput, 'Image output tokens'], ['cachedAudioInputTokens', base.cachedAudioInput, 'Cached audio input tokens'], ['cachedImageInputTokens', base.cachedImageInput, 'Cached image input tokens'], ['cacheWriteTokens', base.cacheWrite, 'Cache write tokens'], ['longContextInputTokens', base.longInput, 'Long-context input tokens'], ['longContextCachedInputTokens', base.longCached, 'Long-context cached input tokens'], ['longContextCacheWriteTokens', base.longCacheWrite, 'Long-context cache write tokens'], ['longContextOutputTokens', base.longOutput, 'Long-context output tokens']];
  for (const [k, n, l] of streams) if (c[k] && !n) throw new PricingError(`${key} has no ${l.toLowerCase()} meter${ft ? ' for fine-tuned use' : ''}; remove ${k}.`);
  if (m.media) {
    if (ft || proc !== 'standard') throw new PricingError(`${key} bills per unit at Standard processing only.`);
    const mrs = await rows(`serviceName eq 'Foundry Models' and ${regionFilter(ctx)} and startswith(productName,'Azure OpenAI') and priceType eq 'Consumption'`, ctx);
    const mlines = [];
    for (const e of m.media) {
      const qty = c[e.field]; if (!qty) continue;
      let name = e.meters[dkey];
      if (name && typeof name === 'object') name = name[`${c.imageQuality || 'standard'}/${/1792/.test(c.imageSize || '') ? 'high' : 'standard'}`];
      if (!name) throw new PricingError(`${key} has no ${dep} ${e.label.toLowerCase()} meter in the Retail Prices API (published deployments: ${Object.keys(e.meters).map(x => ({ gl: 'global', dz: 'datazone', rg: 'regional' })[x]).join(', ')}).`);
      let r = mrs.filter(x => x.meterName === name);
      if (!r.length && dep === 'global') r = (await rows(`serviceName eq 'Foundry Models' and armRegionName eq 'eastus2' and startswith(productName,'Azure OpenAI') and priceType eq 'Consumption'`, ctx)).filter(x => x.meterName === name);
      r = single(r, `${key} ${e.label}`);
      mlines.push(line('AI', 'Foundry Models', `${key} ${dep === 'global' ? 'Global' : dep === 'datazone' ? 'Data Zone' : 'Regional'}, ${e.label.toLowerCase()}, ${qty.toLocaleString('en-US')}`, qty, e.unit, r[0].retailPrice, meterCost(r, qty).cost, meterInfo(r[0]), { unitLabel: `per ${r[0].unitOfMeasure}` }));
    }
    if (!mlines.length) throw new PricingError(`Give ${m.media.map(e => e.field).join(' or ')} for ${key}.`);
    return { lines: mlines, notes: [m.note, ...(gov ? ['Azure Government offers Data Zone (and Regional) deployments, not Global.'] : [])].filter(Boolean), facts: { model: key, legacy: false, deployment: dep, processing: proc, fineTuned: false } };
  }
  const std = dep === 'global' && proc === 'standard' && !ft;
  // Foundry Models meters are regional rows even for Global deployments; use the requested region, fall back to eastus2.
  const productFilter = std ? `productName eq '${q(m.product)}'` : `startswith(productName,'Azure OpenAI')`;
  let rs = await rows(`serviceName eq 'Foundry Models' and ${regionFilter(ctx)} and ${productFilter} and priceType eq 'Consumption'`, ctx);
  let priceRegion = ctx.region;
  const probe = base.input || base.audioInput || base.imageInput;
  if (std && !rs.some(r => r.meterName === probe)) { rs = await rows(`serviceName eq 'Foundry Models' and armRegionName eq 'eastus2' and ${productFilter} and priceType eq 'Consumption'`, ctx); priceRegion = 'eastus2'; }
  const pick = (name, what) => {
    if (std) return single(rs.filter(x => x.meterName === name), `${key} ${what}`);
    const sig = aiSig(name, ['gl'], [dkey, ...(proc === 'standard' ? [] : [proc === 'batch' ? 'batch' : 'pp'])]);
    const hit = rs.filter(x => aiSig(x.meterName) === sig);
    if (!hit.length) throw new PricingError(`${key} has no published ${label} ${what.toLowerCase()} meter in ${ctx.region}. Check the model's deployment types, or use a "meter" component.`);
    return single(hit, `${key} ${what}`);
  };
  const lines = [];
  for (const [k, n, l] of streams) {
    const qty = c[k] || 0; if (!qty) continue;
    const r = pick(n, l);
    lines.push(line('AI', 'Foundry Models', `${key} ${label}, ${l.toLowerCase()}, ${(qty / 1e6).toLocaleString('en-US')}M/month`, qty, 'tokens', r[0].retailPrice, meterCost(r, qty).cost, meterInfo(r[0]), { unitLabel: `per ${r[0].unitOfMeasure}` }));
  }
  if (ft && c.trainingTokens) {
    if (!base.training) throw new PricingError(`No fine-tuning training meter is published for ${key}.`);
    const r = pick(base.training, 'Training tokens');
    lines.push(line('AI', 'Foundry Models', `${key} fine-tuning training, ${(c.trainingTokens / 1e6).toLocaleString('en-US')}M tokens (tokens in the training file x epochs)`, c.trainingTokens, 'tokens', r[0].retailPrice, meterCost(r, c.trainingTokens).cost, meterInfo(r[0]), { unitLabel: `per ${r[0].unitOfMeasure}` }));
  }
  if (ft && c.hostingHours) {
    const r = pick(base.hosting, 'Hosting');
    lines.push(line('AI', 'Foundry Models', `${key} fine-tuned model hosting, ${c.hostingHours.toLocaleString('en-US')} hours`, c.hostingHours, 'hours', r[0].retailPrice, r[0].retailPrice * c.hostingHours, meterInfo(r[0])));
  }
  const notes = ['Token meters are priced per 1K or 1M tokens as published; quantities are divided accordingly.'];
  if (m.note) notes.push(m.note);
  if (priceRegion !== ctx.region) notes.push(`Global Standard model rates taken from ${priceRegion}; Global Standard pricing is not region-specific.`);
  if (gov) notes.push('Azure Government offers Data Zone (and Regional) deployments, not Global (Learn: models sold directly by Azure, Azure Government); prices use the US Gov meters.');
  if (dep === 'datazone') notes.push('Data Zone deployments keep processing inside the EU or US data zone and cost about 10% more than Global.');
  if (dep === 'regional') notes.push('Regional deployments keep processing in one Azure region and cost about 10% more than Global.');
  if (proc === 'batch') notes.push('Batch jobs complete within 24 hours at roughly half the Standard token price; they are asynchronous only.');
  if (proc === 'priority') notes.push('Priority processing bills a premium per token for lower, more predictable latency on pay-as-you-go deployments.');
  if (ft) notes.push('A fine-tuned model also bills hosting per hour while deployed, whether or not it receives traffic.');
  return { lines, notes, facts: { model: key, legacy: !!m.legacy, deployment: dep, processing: proc, fineTuned: ft } };
}

// ---------------------------------------------------------------- Generic escape hatch
async function priceMeter(c, ctx) {
  const ALLOWED = ['type', 'label', 'filter', 'quantity', 'hours', 'desc', 'group', 'unit'];
  for (const k of Object.keys(c)) if (!ALLOWED.includes(k)) throw new PricingError(`unknown field "${k}" on a meter component. Allowed: ${ALLOWED.slice(1).join(', ')}.`);
  const f = c.filter;
  if (!f || typeof f !== 'object' || !Object.keys(f).length) throw new PricingError('A meter component needs a filter with the exact serviceName, productName, skuName and meterName (find them with azp search).');
  if (typeof c.quantity !== 'number' || !Number.isFinite(c.quantity) || c.quantity < 0) throw new PricingError('quantity is required and must be a number of 0 or more (for an hourly meter it is the number of instances; for other meters the amount in the meter\'s own unit).');
  if (c.hours != null && (typeof c.hours !== 'number' || !Number.isFinite(c.hours) || c.hours < 0)) throw new PricingError('hours must be a number of 0 or more.');
  const parts = Object.entries(f).map(([k, v]) => `${k} eq '${q(v)}'`);
  if (!parts.some(p => p.startsWith('armRegionName'))) parts.push(regionFilter(ctx));
  parts.push(`priceType eq 'Consumption'`);
  const rs = await rows(parts.join(' and '), ctx);
  const m = single(rs, c.desc || JSON.stringify(f));
  const u = parseUnit(m[0].unitOfMeasure);
  const hourly = u.kind === 'hour';
  if (!hourly && c.hours != null) throw new PricingError(`hours does not apply to this meter: it is billed per ${m[0].unitOfMeasure}, not per hour. Remove hours and give quantity in that unit.`);
  if (hourly && c.hours == null) throw new PricingError(`This meter is billed per hour: give quantity as the number of instances and hours as the hours each runs in the month (730 = all month).`);
  const q2 = hourly ? c.quantity * c.hours : c.quantity;
  const cost = meterCost(m, q2, ctx.ledger).cost;
  const base = c.desc || `${m[0].productName} - ${m[0].meterName}`;
  return { lines: [line(c.group || 'Other', m[0].serviceName, hourly ? `${base}, ${c.quantity} x ${c.hours} hours` : base, q2, c.unit || m[0].unitOfMeasure, m[0].retailPrice, cost, meterInfo(m[0]), { unitLabel: `per ${m[0].unitOfMeasure}` })], notes: [], facts: { generic: true } };
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
for (const [type, s] of Object.entries(SERVICES)) {
  if (PRICERS[type]) throw new Error(`Service module "${type}" duplicates a built-in component type.`);
  PRICERS[type] = (c, ctx) => s.price(c, ctx);
}

module.exports = { PRICERS, PricingError, vmSpec, vmRates, snapTier, HOURS, ACA_FREE };
