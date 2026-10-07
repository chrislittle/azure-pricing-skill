'use strict';
// Azure Spot Virtual Machines. Same sizes as the vm type, billed at the Spot rate for unused capacity.
// Meters: serviceName 'Virtual Machines', skuName '<armSkuName> Spot' (Linux product, plus a "... Windows"
// product for Windows Server; confidential and GPU families use their own product names, so no name prefix is required). Retired Low Priority meters and Dev/Test rates are left out on purpose.
const { rows, regionFilter, line, meterInfo, PricingError, fmtN, HOURS, q } = require('../kit');
const vmSizes = require('../../../catalog/vm-sizes.json');
const { lifecycle, explain } = require('../lifecycle');

const OS_LABEL = { linux: 'Linux', rhel: 'Linux (Red Hat Enterprise Linux license billed separately)', 'rhel-byos': 'Linux (Red Hat, own subscription)', sles: 'Linux (SUSE license billed separately)', windows: 'Windows Server, license included', 'windows-ahb': 'Windows Server, Azure Hybrid Benefit (own licenses)' };
const SQL = { web: 'SQL Server Web', standard: 'SQL Server Standard', enterprise: 'SQL Server Enterprise' };
const isWinProduct = r => /(Windows( VM)?| Win)$/i.test(r.productName);

// Per-vCPU license meters (same approach as the vm type in recipes.js, which does not export them).
async function licenseRow(kind, vcpu, ctx, edition) {
  if (kind === 'rhel') {
    const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq 'Red Hat Enterprise Linux' and priceType eq 'Consumption'`, ctx);
    const lic = rs.filter(r => r.armRegionName === '' && /VM License$/.test(r.meterName) && !/BYOS|Free/.test(r.meterName));
    const row = lic.find(r => r.meterName.replace('-', ' ') === `${vcpu} vCPU VM License`);
    if (row) return { rate: row.retailPrice, row, desc: `Red Hat Enterprise Linux license, ${fmtN(vcpu)} vCPU tier` };
    const one = lic.find(r => r.meterName === '1 vCPU VM License');
    if (!one) throw new PricingError('Red Hat Enterprise Linux license meter not found.');
    return { rate: one.retailPrice * vcpu, row: one, desc: `Red Hat Enterprise Linux license, ${fmtN(vcpu)} vCPU (${fmtN(vcpu)} x per-vCPU rate)` };
  }
  if (kind === 'sles') {
    const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq 'SUSE Linux Enterprise Server Standard' and priceType eq 'Consumption'`, ctx);
    const band = vcpu <= 2 ? '1-2 vCPU VM' : vcpu <= 4 ? '3-4 vCPU VM' : '5+ vCPU VM';
    const row = rs.find(r => r.skuName === band && /Support$/.test(r.meterName) && /hour/i.test(r.unitOfMeasure));
    if (!row) throw new PricingError(`SUSE license meter not found for ${band}.`);
    return { rate: row.retailPrice, row, desc: `SUSE Linux Enterprise Server Standard, ${band}` };
  }
  const name = SQL[edition];
  if (kind === 'sql-sles') {
    // SQL Server on SLES is billed through one combined meter that already includes the SLES license.
    const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq '${name} SLES' and priceType eq 'Consumption'`, ctx);
    const row = rs.filter(r => r.armRegionName === '').find(r => { const m = /^(\d+)(?:-(\d+))? vCPU VM License$/.exec(r.meterName); return m && vcpu >= +m[1] && vcpu <= +(m[2] || m[1]); });
    if (!row) throw new PricingError(`${name} on SLES license meter not found for ${fmtN(vcpu)} vCPU.`);
    return { rate: row.retailPrice, row, desc: `${name} on SUSE Linux Enterprise Server license (SLES included), ${fmtN(vcpu)} vCPU` };
  }
  const rs = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq '${name}' and priceType eq 'Consumption'`, ctx);
  const lic = rs.filter(r => r.armRegionName === '' && /vCPU VM License$|vCore License$/.test(r.meterName));
  const row = lic.find(r => r.meterName === `${vcpu} vCPU VM License`) || (vcpu <= 4 && lic.find(r => r.meterName === '1-4 vCPU VM License'));
  if (row) return { rate: row.retailPrice, row, desc: `${name} license, ${fmtN(vcpu)} vCPU${/1-4/.test(row.meterName) ? ' (priced as the 1-4 vCPU tier)' : ''}` };
  const one = lic.find(r => r.meterName === '1 vCPU VM License' || r.meterName === '1 vCore License');
  if (!one) throw new PricingError(`${name} license meter not found.`);
  return { rate: one.retailPrice * vcpu, row: one, desc: `${name} license, ${fmtN(vcpu)} vCPU (${fmtN(vcpu)} x per-vCPU rate)` };
}

module.exports = {
  type: 'spot-vm',
  label: 'Azure Spot Virtual Machines',
  family: 'compute-other',
  calculator: ['virtual-machines'],
  keywords: ['spot', 'spot vm', 'interruptible', 'batch', 'cheap compute', 'evictable', 'low priority', 'discounted vm'],
  fields: {
    sku: { req: true, ask: 'Do not ask for a SKU. Ask vCPU, memory and workload type, then run `azp vm-suggest` and use the size it suggests (same size names as the vm type). Only Current and Extended sizes are priced.' },
    os: { def: 'linux', enum: ['linux', 'windows', 'windows-ahb', 'rhel', 'rhel-byos', 'sles'], ask: 'Which operating system? Linux (default). Windows Server with the license included in the price -> windows; Windows Server you already own licenses with Software Assurance for -> windows-ahb. Red Hat Enterprise Linux bought through Azure -> rhel; Red Hat with their own subscription -> rhel-byos; SUSE Linux Enterprise Server -> sles.' },
    sqlLicense: { def: 'none', enum: ['none', 'web', 'standard', 'enterprise'], ask: 'Is SQL Server installed on it? Which edition (web, standard, enterprise), and do you already own licenses (then none)? Default none.' },
    count: { def: 1, int: true, min: 1, ask: 'How many Spot VMs of this size run at the same time? If unknown, suggest 1 and record it as an assumption.' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours a month does each VM run? 730 = all month; a nightly batch of 6 hours a day is about 180. Spot VMs only cost money while they run.' }
  },
  context: ['production'],
  examples: [
    { type: 'spot-vm', sku: 'Standard_D4as_v5', count: 1 },
    { type: 'spot-vm', sku: 'Standard_D8s_v5', os: 'windows', count: 4, hours: 200 },
    { type: 'spot-vm', sku: 'Standard_E4as_v5', os: 'windows-ahb', count: 2, hours: 730 },
    { type: 'spot-vm', sku: 'Standard_D4s_v5', os: 'rhel', count: 2, hours: 300, sqlLicense: 'standard' }
  ],
  readback: c => {
    const s = vmSizes[c.sku];
    const hours = c.hours ?? HOURS;
    const size = String(c.sku || '').replace('Standard_', '');
    return `${fmtN(c.count ?? 1)} Spot VM(s) of size ${size}${s ? ` (${fmtN(s.v)} vCPU, ${fmtN(s.m)} GiB memory)` : ''}, ${OS_LABEL[c.os || 'linux'] || c.os}${c.sqlLicense && c.sqlLicense !== 'none' ? `, with ${SQL[c.sqlLicense] || c.sqlLicense} license` : ''}, running ${hours === HOURS ? 'all month' : `${fmtN(hours)} hours a month`}; Azure may stop them at any time when it needs the capacity back`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).some(x => /disk|storage/i.test(x)) ? [] : ['Managed disks attached to the VM (add disk components); disks keep billing while a Spot VM is stopped (deallocated)', 'Data sent out to the internet', 'Not priced by this skill: Ubuntu Pro, Red Hat HA/SAP and SUSE SAP editions, and Dev/Test rates'],
  price: async (c, ctx) => {
    const sku = c.sku;
    if (!sku) throw new PricingError('spot-vm needs "sku" (for example Standard_D4as_v5). Use `azp vm-suggest` to choose one.');
    const lc = lifecycle(sku);
    if (!lc.modern) throw new PricingError(`${explain(sku)} Run \`azp vm-suggest\` with the same vCPU and memory and price a Current size instead.`);
    if (/_Promo$/i.test(sku)) throw new PricingError('Azure Spot does not support Promo sizes (Learn: "Promo versions of any size (like Dv2, NV, NC, H promo sizes)" are not supported). Price the non-promo size instead.');
    const os = c.os || 'linux';
    if (!OS_LABEL[os]) throw new PricingError(`Unknown os "${os}". Use ${Object.keys(OS_LABEL).join(', ')}.`);
    const count = c.count ?? 1, hours = c.hours ?? HOURS;
    if (!Number.isInteger(count) || count < 1) throw new PricingError('count must be a whole number of at least 1.');
    const sqlEd = c.sqlLicense || 'none';
    if (sqlEd !== 'none' && !SQL[sqlEd]) throw new PricingError('sqlLicense must be none, web, standard or enterprise.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const rs = (await rows(`serviceName eq 'Virtual Machines' and ${regionFilter(ctx)} and armSkuName eq '${q(sku)}' and priceType eq 'Consumption'`, ctx))
      .filter(r => !/Cloud ?Services|Dedicated Host/i.test(r.productName));
    const isWin = isWinProduct;
    const spotRows = rs.filter(r => / Spot$/.test(r.skuName));
    const payg = rs.filter(r => !/Spot|Low Priority/i.test(r.skuName));
    const pick = (list, windows) => {
      const m = list.filter(r => isWin(r) === windows);
      if (m.length > 1) throw new PricingError(`${sku} has ${m.length} ${windows ? 'Windows' : 'Linux'} price rows in ${ctx.region} (${m.map(r => r.productName).join(', ')}); cannot choose one safely.`);
      return m[0];
    };
    if (!spotRows.length) throw new PricingError(`${sku} has no Spot price in ${ctx.region}. Spot is not offered for every size or region; try another size from \`azp vm-suggest\` or another region.`);
    const useWin = os === 'windows';
    const spot = pick(spotRows, useWin);
    if (!spot) throw new PricingError(`No Windows Spot price for ${sku} in ${ctx.region}.`);
    let base = null;
    try { base = pick(payg, useWin); } catch (e) { base = null; }
    const s = vmSizes[sku];
    const label = `${sku.replace('Standard_', '')}${s ? `, ${fmtN(s.v)} vCPU${(require('../recipes').vmSpec(sku) || {}).licensedVcpu < s.v ? ` (${fmtN(require('../recipes').vmSpec(sku).licensedVcpu)} active)` : ''}, ${fmtN(s.m)} GiB` : ''}`;
    const rate = spot.retailPrice;
    const lines = [line('Compute', 'Virtual Machines', `${label}, ${OS_LABEL[os]}, Spot rate`, hours * count, 'hours', rate, rate * hours * count, meterInfo(spot), { per: count > 1 ? `${fmtN(count)} VMs x ${fmtN(hours)} hours` : null })];
    // Per-vCPU licenses bill on active vCPUs for constrained-core sizes; the vm type's vmSpec owns that rule (lazy require: recipes loads services).
    const lv = (require('../recipes').vmSpec(sku) || {}).licensedVcpu || (s && s.v);
    const licNeeds = os === 'rhel' || os === 'sles' || sqlEd !== 'none';
    if (licNeeds && !s) throw new PricingError(`Unknown vCPU count for ${sku}; cannot price the license.`);
    if (os === 'rhel' || (os === 'sles' && sqlEd === 'none')) {
      const lic = await licenseRow(os, lv, ctx);
      lines.push(line('Compute', 'VM Licenses', lic.desc, hours * count, 'hours', lic.rate, lic.rate * hours * count, meterInfo(lic.row)));
    }
    if (sqlEd !== 'none') {
      const lic = await licenseRow(os === 'sles' ? 'sql-sles' : 'sql', lv, ctx, sqlEd);
      lines.push(line('Compute', 'VM Licenses', lic.desc, hours * count, 'hours', lic.rate, lic.rate * hours * count, meterInfo(lic.row)));
    }
    const notes = [
      'Spot VMs use spare Azure capacity at a discount. Azure can evict (stop) a Spot VM at any time with about 30 seconds of notice when it needs the capacity back or, if you set a maximum price, when the Spot price rises above it.',
      'The Spot price changes with demand in each region and size. This estimate uses the Spot price published today. With the default maximum price of -1 you pay the current Spot price, never more than the pay-as-you-go price.',
      'When a Spot VM is evicted you choose to deallocate it (no compute charge, but disks keep billing) or delete it. Design the workload to checkpoint its work and restart.',
      'Spot VMs have no SLA, and reservations and savings plans do not apply to them.'
    ];
    if (os === 'rhel' || os === 'sles' || sqlEd !== 'none') notes.push('Licenses are charged per vCPU-hour at the normal rate on top of the Spot VM price; the Spot discount applies only to the compute.');
    if (s && lv < s.v) notes.push(`${sku} is a constrained-core size: per-vCPU licenses are billed on its ${lv} active vCPUs, not the ${s.v} it exposes memory and storage for.`);
    if (os === 'windows-ahb') notes.push('Azure Hybrid Benefit: you pay the Linux Spot rate and bring your own Windows Server licenses with Software Assurance.');
    const paygBase = base;
    const facts = { sku, os, count, hours, sqlLicense: sqlEd, spotRate: rate, paygRate: paygBase ? paygBase.retailPrice : null };
    if (paygBase && paygBase.retailPrice > 0) {
      facts.discountPct = Math.round((1 - rate / paygBase.retailPrice) * 100);
      notes.push(`Pay-as-you-go for the same VM today is ${paygBase.retailPrice}/hour, so the Spot rate is about ${facts.discountPct}% lower.`);
    }
    return { lines, notes, facts };
  }
};
