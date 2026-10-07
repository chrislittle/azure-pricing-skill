'use strict';
// Azure Dedicated Host: a whole physical server billed per host-hour, by VM series and host type
// (hardware generation). Pay as you go, 1/3-year reservation or 1/3-year savings plan.
// Meters: serviceName 'Virtual Machines', productName '<Series> Series Dedicated Host' OR '<Series> Series DedicatedHost'
// (both spellings exist), regional. Series and host type come from armSkuName ("Dsv5_Type1" -> dsv5 + 1).
// The host rate covers all VMs placed on it; OS/SQL/other software licences are charged on top per VM.
// Lifecycle: Dedicated Host SKUs follow the VM lifecycle stages (Learn: dedicated-hosts/sku-lifecycle), so End of Life
// host series are refused like VM sizes. Msv2/Mdsv2 hosts stay priced: only the isolated M192i sizes are End of Life.
const { rows, single, regionFilter, meterLine, line, meterInfo, PricingError, fmtN, HOURS, termMonths } = require('../kit');
const { lifecycle, explain } = require('../lifecycle');

const n = v => Number(v || 0);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const COMMIT = {
  payg: null,
  'reservation-1y': { kind: 'reservation', term: '1 Year' },
  'reservation-3y': { kind: 'reservation', term: '3 Years' },
  'savings-1y': { kind: 'savings', term: '1 Year' },
  'savings-3y': { kind: 'savings', term: '3 Years' }
};

// A host series follows the VM lifecycle. Build representative VM sizes from the series key (dsv3 -> Standard_D2s_v3) and
// ask lifecycle(), so the End of Life list in catalog.vmLifecycle stays the only source. Returns the EOL VM size or null.
function eolSize(key) {
  const m = /^(dc|ec|nv|nd|nc|[a-z])([a-z]*)v(\d+)$/.exec(key);
  if (!m) return null;
  return [2, 8].map(sz => `Standard_${m[1].toUpperCase()}${sz}${m[2]}_v${m[3]}`).find(vm => !lifecycle(vm).modern) || null;
}

// Software licences the calculator offers, as Retail "Virtual Machines Licenses" products priced per VM-hour by vCPU count.
const LICENCES = {
  'sql-enterprise': ['SQL Server Enterprise', 'SQL Server Enterprise on Windows'],
  'sql-standard': ['SQL Server Standard', 'SQL Server Standard on Windows'],
  'sql-web': ['SQL Server Web', 'SQL Server Web on Windows'],
  'sql-linux-enterprise': ['SQL Server Linux Enterprise', 'SQL Server Enterprise on Linux'],
  'sql-linux-standard': ['SQL Server Linux Standard', 'SQL Server Standard on Linux'],
  'sql-linux-web': ['SQL Server Linux Web', 'SQL Server Web on Linux'],
  'sql-rhel-enterprise': ['SQL Server Enterprise Red Hat Enterprise Linux', 'SQL Server Enterprise on Red Hat Enterprise Linux'],
  'sql-rhel-standard': ['SQL Server Standard Red Hat Enterprise Linux', 'SQL Server Standard on Red Hat Enterprise Linux'],
  'sql-rhel-web': ['SQL Server Web Red Hat Enterprise Linux', 'SQL Server Web on Red Hat Enterprise Linux'],
  'sql-sles-enterprise': ['SQL Server Enterprise SLES', 'SQL Server Enterprise on SUSE Linux'],
  'sql-sles-standard': ['SQL Server Standard SLES', 'SQL Server Standard on SUSE Linux'],
  'sql-sles-web': ['SQL Server Web SLES', 'SQL Server Web on SUSE Linux'],
  'rhel-sap': ['RHEL for SAP Business Applications', 'Red Hat Enterprise Linux for SAP Business Applications'],
  'sles-standard': ['SUSE Linux Enterprise Server Standard', 'SUSE Linux Enterprise Server (24x7 support)'],
  'sles-sap': ['SUSE for SAP Linux Enterprise Server', 'SUSE Linux Enterprise Server for SAP Applications (24x7 support)'],
  'sles-hpc': ['SUSE Linux Enterprise Server for HPC Standard', 'SUSE Linux Enterprise Server for HPC (24x7 support)'],
  'biztalk-enterprise': ['BizTalk Server Enterprise', 'BizTalk Server Enterprise'],
  'biztalk-standard': ['BizTalk Server Standard', 'BizTalk Server Standard'],
  'ubuntu-essential': ['Ubuntu Advantage', 'Ubuntu Advantage Essential support', 'Essential VM'],
  'ubuntu-standard': ['Ubuntu Advantage', 'Ubuntu Advantage Standard support', 'Standard VM'],
  'ubuntu-advanced': ['Ubuntu Advantage', 'Ubuntu Advantage Advanced support', 'Advanced VM']
};

// Licence meter for a VM of `vcpus`: exact "N vCPU VM" size first, else the size band (1-2, 3-4, 5+).
function pickLicence(rs, vcpus) {
  const parsed = rs.map(r => {
    const m = /^(\d+)(?:-(\d+)|(\+))?[ -]vCPU VM$/.exec(r.skuName);
    return m ? { r, lo: +m[1], hi: m[3] ? Infinity : +(m[2] || m[1]) } : null;
  }).filter(Boolean);
  const exact = parsed.filter(p => p.lo === vcpus && p.hi === vcpus);
  const hit = exact.length ? exact : parsed.filter(p => p.lo <= vcpus && vcpus <= p.hi && p.hi > p.lo);
  return hit.map(p => p.r);
}

const seriesOf = r => {
  const k = norm(r.armSkuName), m = /^(.*?)type(\d+)$/.exec(k);
  return m ? { key: m[1], type: m[2] } : null;
};
const seriesName = r => String(r.armSkuName || '').replace(/[ _-]*Type\s*\d+$/i, '').trim();

module.exports = {
  type: 'dedicated-host',
  label: 'Azure Dedicated Host',
  family: 'compute-other',
  calculator: ['virtual-machines/dedicated-host'],
  keywords: ['dedicated host', 'physical server', 'single tenant', 'isolated hardware', 'bring your own licence', 'host server', 'compliance isolation'],
  fields: {
    series: { req: true, ask: 'Which VM family will run on the dedicated host? Name the series without "Series", for example Dsv5, Dsv6, Esv5, Easv5, Dasv6, Lsv3, FXmds or Msv2. Ask which VM sizes they plan to run and map them to the family (a Standard_D8s_v5 VM is Dsv5). Older End of Life series such as Dsv3, Esv3, Fsv2 and Lsv2 are not priced. If unknown, suggest Dsv5 and record it as an assumption.' },
    hosts: { req: true, int: true, min: 1, ask: 'How many physical dedicated hosts do they need? One host holds many VMs (for example a Dsv4 Type1 host has 80 vCPUs available for VMs). For production availability use at least 2 hosts. If unknown, suggest 1 and record it as an assumption.' },
    hostType: { def: '', ask: 'Which hardware generation of the host (Type1, Type2, Type3...)? Leave blank if unknown: the estimate will then list the types sold in the region and the person can pick one.' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours a month are the hosts allocated? A host bills every hour it exists, whether or not VMs run on it (730 = all month). Reservations ignore this.' },
    commitment: { def: 'payg', enum: Object.keys(COMMIT), ask: 'Will the hosts run steadily for a year or more? No -> payg; 1 year -> reservation-1y; 3 years -> reservation-3y (largest discount, tied to this host type). A flexible hourly spend commitment instead -> savings-1y or savings-3y. If unknown use payg.' },
    windowsVcpus: { def: 0, int: true, min: 0, ask: 'Only if the VMs on the hosts run Windows Server with a licence bought through Azure (no Azure Hybrid Benefit): how many vCPUs in total do those Windows VMs have? Use 0 if they bring their own licences.' },
    licence: { def: '', enum: ['', ...Object.keys(LICENCES)], ask: 'Only if one kind of VM on the hosts needs a software licence bought through Azure (no Azure Hybrid Benefit): which one? SQL Server Windows: sql-enterprise, sql-standard, sql-web; SQL Server on Linux: sql-linux-*, sql-rhel-*, sql-sles-* (enterprise, standard or web); also rhel-sap, sles-standard, sles-sap, sles-hpc, biztalk-enterprise, biztalk-standard; Ubuntu Advantage: ubuntu-essential, ubuntu-standard, ubuntu-advanced. Leave blank for none.' },
    licenceVcpus: { def: 0, int: true, min: 0, ask: 'If a licence was chosen: how many vCPUs does EACH of those VMs have (for example 8)?' },
    licenceVms: { def: 1, int: true, min: 1, ask: 'If a licence was chosen: how many VMs of that size run on the hosts? Use 1 if unknown.' }
  },
  context: ['production', 'steadyUsage'],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The virtual machines placed on the host: the host rate already covers their compute, but their disks and networking are charged separately (use the vm and disk types for the disks).',
    'Ubuntu Pro subscriptions and any licence not listed in the licence field: not priced here.',
    'Azure Hybrid Benefit and Dedicated Host licence rights: bringing eligible Windows Server/SQL Server licences removes the licence charge.'
  ]),
  examples: [
    { type: 'dedicated-host', series: 'Dsv4', hostType: 'Type1', hosts: 1 },
    { type: 'dedicated-host', series: 'Dsv5', hostType: 'Type1', hosts: 2, hours: 400, windowsVcpus: 32 },
    { type: 'dedicated-host', series: 'Dsv4', hostType: 'Type1', hosts: 3, commitment: 'reservation-1y' },
    { type: 'dedicated-host', series: 'Dsv4', hostType: 'Type1', hosts: 1, commitment: 'reservation-3y' },
    { type: 'dedicated-host', series: 'Dsv4', hostType: 'Type1', hosts: 2, commitment: 'savings-1y', windowsVcpus: 16 },
    { type: 'dedicated-host', series: 'Ddsv5', hostType: 'Type1', hosts: 1, licence: 'sql-enterprise', licenceVcpus: 8, licenceVms: 2 },
    { type: 'dedicated-host', series: 'FXmds', hostType: 'Type1', hosts: 1 }
  ],
  readback: c => {
    const ct = COMMIT[c.commitment || 'payg'];
    const hrs = c.hours ?? HOURS;
    const hoursText = hrs === HOURS ? 'allocated all month (730 hours)' : `${fmtN(hrs)} hours a month`;
    const when = ct && ct.kind === 'reservation' ? `${ct.term.toLowerCase()} reservation` : `${ct ? `${ct.term.toLowerCase()} savings plan` : 'pay as you go'}, ${hoursText}`;
    const lic = [];
    if (n(c.windowsVcpus)) lic.push(`Windows Server licence for ${fmtN(n(c.windowsVcpus))} vCPUs`);
    if (c.licence && LICENCES[c.licence]) lic.push(`${LICENCES[c.licence][1]} licence for ${fmtN(c.licenceVms ?? 1)} VM(s) of ${fmtN(n(c.licenceVcpus))} vCPUs`);
    const licText = lic.length ? `, plus ${lic.join(' and ')}, billed for ${hoursText.replace('allocated all month', 'all month')}` : '';
    return `Dedicated Host: ${fmtN(n(c.hosts))} ${c.series || ''} series host(s)${c.hostType ? `, ${c.hostType}` : ''}, ${when}${licText}`;
  },
  price: async (c, ctx) => {
    const hosts = n(c.hosts), hours = c.hours ?? HOURS, winV = n(c.windowsVcpus);
    if (!Number.isInteger(hosts) || hosts < 1) throw new PricingError('hosts must be a whole number of at least 1.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (!Number.isInteger(winV) || winV < 0) throw new PricingError('windowsVcpus must be a whole number, 0 or more.');
    const commitment = c.commitment || 'payg';
    if (!(commitment in COMMIT)) throw new PricingError(`Unknown commitment "${commitment}". Use ${Object.keys(COMMIT).join(', ')}.`);
    const ct = COMMIT[commitment];
    const lic = c.licence ? LICENCES[c.licence] : null;
    if (c.licence && !lic) throw new PricingError(`Unknown licence "${c.licence}". Use one of: ${Object.keys(LICENCES).join(', ')}.`);
    const licV = n(c.licenceVcpus), licVms = c.licenceVms ?? 1;
    if (lic && !lic[2] && (!Number.isInteger(licV) || licV < 1)) throw new PricingError('licenceVcpus must be a whole number of at least 1 when a licence is chosen.');
    if (!Number.isInteger(licVms) || licVms < 1) throw new PricingError('licenceVms must be a whole number of at least 1.');
    const want = norm(c.series).replace(/series$/, '');
    if (!want) throw new PricingError('series is required (for example Dsv5).');
    const all = (await rows(`serviceName eq 'Virtual Machines' and ${regionFilter(ctx)} and (contains(productName, 'Dedicated Host') or contains(productName, 'DedicatedHost'))`, ctx))
      .filter(r => (r.type === 'Consumption' || r.type === 'Reservation') && !/spot|low priority/i.test(r.meterName + ' ' + r.skuName) && seriesOf(r));
    if (!all.length) throw new PricingError(`Azure Dedicated Host is not offered in ${ctx.region}. Try a major region such as eastus2, westeurope or japaneast.`);
    // End of Life check on the typed name and again on the series it resolves to (a short name such as Fs resolves to Fsv2).
    const gate = k => {
      const vm = eolSize(k);
      if (!vm) return;
      const l = lifecycle(vm), cur = [...new Set(all.map(seriesName))].filter(s => !eolSize(norm(s))).sort();
      const near = cur.filter(s => s[0].toLowerCase() === k[0]);
      throw new PricingError(`Dedicated Host ${c.series} hosts run the ${l.series} VM series, so they follow the VM lifecycle. ${explain(vm)} Price a Current host series instead${cur.length ? `, for example ${(near.length ? near : cur).slice(0, 4).join(', ')}` : ''}.`);
    };
    gate(want);
    let inSeries = all.filter(r => seriesOf(r).key === want);
    if (!inSeries.length) {
      // A family name such as FX matches a single longer series key (fxmds).
      const keys = [...new Set(all.map(r => seriesOf(r).key).filter(k => k.startsWith(want)))];
      if (keys.length === 1) inSeries = all.filter(r => seriesOf(r).key === keys[0]);
    }
    if (inSeries.length) gate(seriesOf(inSeries[0]).key);
    if (!inSeries.length) {
      const names = [...new Set(all.map(seriesName))].filter(s => !eolSize(norm(s))).sort();
      throw new PricingError(`No Dedicated Host priced for series "${c.series}" in ${ctx.region}. Series available here: ${names.join(', ')}.`);
    }
    const payg = inSeries.filter(r => r.type === 'Consumption');
    const types = [...new Set(payg.map(r => seriesOf(r).type))].sort();
    const typeNames = () => types.map(t => `${c.series} Type${t}`).join(', ');
    const key = seriesOf(inSeries[0]).key;
    const wantType = norm(c.hostType).replace(new RegExp('^' + key), '').replace(/^type/, '');
    let type = wantType;
    if (!wantType) {
      if (types.length !== 1) throw new PricingError(`${c.series} has several host types in ${ctx.region}: ${typeNames()}. Ask which hardware generation (hostType) the customer wants.`);
      type = types[0];
    } else if (!types.includes(wantType)) {
      throw new PricingError(`No ${c.series} host of type "${c.hostType}" in ${ctx.region}. Types available: ${typeNames()}.`);
    }
    const host = payg.filter(r => seriesOf(r).type === type);
    if (host.length !== 1) throw new PricingError(`Ambiguous Dedicated Host price for ${c.series} Type${type} in ${ctx.region}.`);
    const base = host[0];
    const G = 'Compute', S = 'Virtual Machines', lines = [], notes = [];
    const name = seriesName(base);
    const label = `${name} Type${type} dedicated host`;
    const facts = { series: name, hostType: `Type${type}`, hosts, hours, commitment, paygHourly: base.retailPrice, windowsVcpus: winV, licence: c.licence || '', licenceCharged: winV > 0 || /^sql-/.test(c.licence || '') };
    if (!ct) {
      lines.push(meterLine(G, S, `${label}: ${fmtN(hosts)} host(s) x ${fmtN(hours)} hours`, host, hosts * hours, ctx, { unit: 'host-hours' }));
    } else if (ct.kind === 'reservation') {
      const rr = inSeries.find(r => r.type === 'Reservation' && seriesOf(r).type === type && r.reservationTerm === ct.term);
      if (!rr) throw new PricingError(`No ${ct.term} reservation for ${name} Type${type} in ${ctx.region}.`);
      const months = termMonths(ct.term), monthly = rr.retailPrice / months;
      lines.push(line(G, S, `${label}: ${fmtN(hosts)} host(s), ${ct.term.toLowerCase()} reservation`, hosts, 'host / month', monthly, monthly * hosts, meterInfo(rr), { termTotal: rr.retailPrice }));
      notes.push(`${ct.term} reservation: ${fmtN(rr.retailPrice)} is the whole-term price per host, divided by ${months} months. It is billed whether or not the host is used and covers the host only, not licences.`);
      facts.reservedMonthly = monthly * hosts;
    } else {
      const sp = (base.savingsPlan || []).find(s => s.term === ct.term);
      if (!sp) throw new PricingError(`No ${ct.term} savings plan price for ${name} Type${type} in ${ctx.region}.`);
      const sRows = [Object.assign({}, base, { retailPrice: sp.retailPrice })];
      lines.push(meterLine(G, S, `${label}: ${fmtN(hosts)} host(s) x ${fmtN(hours)} hours, ${ct.term.toLowerCase()} savings plan`, sRows, hosts * hours, ctx, { unit: 'host-hours' }));
      notes.push(`Savings plan: the ${ct.term.toLowerCase()} savings plan hourly rate for the host. It assumes a steady hourly spend commitment that this usage fills.`);
    }
    if (winV > 0) {
      // Windows Server licence is billed per vCPU (the N-vCPU meters are N x the same rate); take the rate from the 4 vCPU meter.
      const wl = await rows(`serviceName eq 'Virtual Machines Licenses' and productName eq 'Windows Server' and skuName eq '4 vCPU VM' and priceType eq 'Consumption'`, ctx);
      if (!wl.length) throw new PricingError('No Windows Server licence meter found.');
      const per = wl.map(r => Object.assign({}, r, { retailPrice: r.retailPrice / 4, unitOfMeasure: '1 Hour' }));
      lines.push(meterLine('Compute', 'Virtual Machines Licenses', `Windows Server licence for VMs on the host: ${fmtN(winV)} vCPUs x ${fmtN(hours)} hours`, per, winV * hours, ctx, { unit: 'vCPU-hours' }));
      notes.push('Windows Server licence is charged per vCPU of each Windows VM placed on the host, for the hours the VM runs; not covered by a reservation or savings plan. Skip it if Azure Hybrid Benefit applies.');
    }
    if (lic) {
      const lr = (await rows(`serviceName eq 'Virtual Machines Licenses' and priceType eq 'Consumption' and productName eq '${lic[0]}'`, ctx))
        .filter(r => !r.armRegionName || r.armRegionName === 'Global');
      const hit = lic[2] ? lr.filter(r => r.skuName === lic[2] && /^1 Hour$/i.test(r.unitOfMeasure)) : pickLicence(lr, licV);
      if (!hit.length) {
        const sizes = [...new Set(lr.map(r => r.skuName))].join(', ');
        throw new PricingError(`No ${lic[1]} licence price for a ${licV}-vCPU VM. Sizes priced: ${sizes || 'none'}.`);
      }
      lines.push(meterLine('Compute', 'Virtual Machines Licenses', `${lic[1]} licence: ${fmtN(licVms)} VM(s)${lic[2] ? '' : ` of ${fmtN(licV)} vCPUs`} x ${fmtN(hours)} hours`, single(hit, `${lic[1]} licence`), licVms * hours, ctx, { unit: 'VM-hours' }));
      notes.push(`${lic[1]} licence is charged per VM-hour${lic[2] ? '' : " by the VM's vCPU count"}, on top of the host; a reservation or savings plan does not cover it. Skip it if Azure Hybrid Benefit or your own licence applies.${lic[2] ? ' Ubuntu Advantage Standard and Advanced also carry a monthly minimum support fee that is not modeled.' : ''}`);
    }
    notes.unshift('A dedicated host is billed in full for every hour it is allocated, even when no VMs run on it. VMs placed on it add no compute charge.');
    return { lines, notes, facts };
  }
};
