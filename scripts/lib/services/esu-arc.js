'use strict';
// Extended Security Updates (ESU) for Windows Server 2012/2016 and SQL Server 2014/2016 (Azure Arc, or Azure VMs).
// Meters are regionless (Global, or 'US Gov' for Azure Government), billed per core per hour. Back-billing meters are one-off
// catch-up charges for enrolling after end of support and are not priced here.
const { rows, single, line, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const WS_VERSIONS = ['2012', '2016'];
const SQL_VERSIONS = ['2014', '2016'];
// Learn: Windows Server has an 8-core minimum per VM (virtual cores) and 16-core minimum per server (physical cores);
// SQL Server has a 4-core minimum per machine, and 16 cores (at the Enterprise rate) for a physical-core licence with
// unlimited virtualization.
const MIN_CORES = { 'windows-virtual': 8, 'windows-physical': 16, sql: 4, 'sql-physical-unlimited': 16 };
const NO_ESU_SQL = ['developer', 'express', 'web'];
const round2 = v => Math.round(v * 100) / 100;

module.exports = {
  type: 'esu-arc',
  label: 'Extended Security Updates (ESU) enabled by Azure Arc',
  family: 'security',
  calculator: ['extended-security-updates'],
  keywords: ['esu', 'extended security updates', 'end of support', 'windows server 2012', 'windows server 2016', 'sql server 2014', 'sql server 2016', 'azure arc'],
  fields: {
    product: { def: 'windows-server', enum: ['windows-server', 'sql-server'], ask: 'Which out-of-support product needs security updates: Windows Server -> windows-server, or SQL Server -> sql-server?' },
    version: { req: true, enum: ['2012', '2014', '2016'], ask: 'Which version is it? Windows Server 2012 or 2012 R2 -> 2012; Windows Server 2016 -> 2016. SQL Server 2014 -> 2014; SQL Server 2016 -> 2016. (Windows has no 2014 and SQL Server 2012 updates have ended.)' },
    hostedOn: { def: 'arc', enum: ['arc', 'azure-vm'], ask: 'Where does it run? On a server outside Azure (on premises, or another cloud) that you connect with Azure Arc -> arc. On an Azure virtual machine -> azure-vm (updates are free for Windows Server 2012 and SQL Server 2014 there). If unknown, suggest arc and record it as an assumption.' },
    edition: { def: 'standard', enum: ['standard', 'datacenter', 'enterprise', 'developer', 'express', 'web'], ask: 'Which edition? Windows Server Standard -> standard, Datacenter -> datacenter. SQL Server Standard -> standard, Enterprise -> enterprise; Developer, Express and Web editions have no ESU charge. If unknown, suggest standard and record it as an assumption.' },
    licensing: { def: 'virtual', enum: ['virtual', 'physical', 'physical-unlimited'], ask: 'Do you pay for the cores assigned to each virtual machine (virtual), or for all cores of the physical host (physical)? A physical host also covers the VMs on it (Windows: up to 2 on Standard, all on Datacenter). SQL Server only: physical-unlimited covers unlimited VMs on the host at the Enterprise rate with a 16-core minimum. If unknown, suggest virtual.' },
    machines: { def: 1, int: true, min: 1, ask: 'How many servers or virtual machines need updates? If unknown, suggest 1.' },
    coresPerMachine: { req: true, int: true, min: 1, ask: 'How many CPU cores does each server or virtual machine have (virtual cores for a VM, physical cores for a physical host)? Minimums are applied automatically. If unknown, suggest 8 and record it as an assumption.' },
    hours: { def: 730, min: 0, max: 744 }
  },
  context: ['production'],
  examples: [
    { type: 'esu-arc', product: 'windows-server', version: '2012', coresPerMachine: 4 },
    { type: 'esu-arc', product: 'sql-server', version: '2016', edition: 'enterprise', machines: 3, coresPerMachine: 16 },
    { type: 'esu-arc', product: 'windows-server', version: '2016', edition: 'datacenter', licensing: 'physical', machines: 2, coresPerMachine: 24, hours: 365 },
    { type: 'esu-arc', product: 'windows-server', version: '2016', hostedOn: 'azure-vm', machines: 2, coresPerMachine: 4 }
  ],
  readback: c => {
    const win = (c.product || 'windows-server') === 'windows-server';
    const ed = c.edition || 'standard';
    const lic = c.licensing || 'virtual';
    const where = c.hostedOn === 'azure-vm' ? 'on Azure virtual machines' : 'on servers connected with Azure Arc';
    const what = win ? `Windows Server ${c.version} ${ed} (${lic === 'physical' ? 'physical' : 'virtual'} cores)` : `SQL Server ${c.version} ${ed} (${lic === 'virtual' ? 'virtual cores' : lic === 'physical' ? 'physical cores' : 'physical cores with unlimited virtualization, billed at the Enterprise rate with a 16-core minimum'})`;
    return `Extended security updates for ${what} ${where}: ${fmtN(n(c.machines) || 1)} machine(s) x ${fmtN(n(c.coresPerMachine))} cores each, ${n(c.hours ?? HOURS) === HOURS ? 'running all month' : fmtN(n(c.hours ?? HOURS)) + ' hours a month'}`;
  },
  notIncluded: () => ['One-off back-billing charge if you enrol after the end-of-support date (billed as a separate line) and the Arc-connected servers themselves'],
  price: async (c, ctx) => {
    const product = c.product || 'windows-server';
    const version = String(c.version || '');
    const edition = (c.edition || 'standard').toLowerCase();
    const hostedOn = c.hostedOn || 'arc';
    const mode = c.licensing || 'virtual';
    const machines = c.machines == null ? 1 : n(c.machines);
    const cores = n(c.coresPerMachine);
    const hours = c.hours ?? HOURS;
    if (!Number.isInteger(machines) || machines < 1 || !Number.isInteger(cores) || cores < 1) throw new PricingError('ESU needs a whole number of machines and cores per machine, each at least 1.');
    if (!Number.isFinite(Number(hours)) || hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const win = product === 'windows-server';
    if (!win && product !== 'sql-server') throw new PricingError(`product must be "windows-server" or "sql-server", got "${product}".`);
    if (!['arc', 'azure-vm'].includes(hostedOn)) throw new PricingError('hostedOn must be "arc" or "azure-vm".');
    if (!['virtual', 'physical', 'physical-unlimited'].includes(mode)) throw new PricingError('licensing must be "virtual", "physical" or "physical-unlimited".');
    if (win && version === '2014') throw new PricingError('Windows Server has no 2014 version; use 2012 or 2016.');
    if (!win && version === '2012') throw new PricingError('Extended security updates for SQL Server 2012 ended in July 2025; use 2014 or 2016.');
    if (!(win ? WS_VERSIONS : SQL_VERSIONS).includes(version)) throw new PricingError(`${win ? 'Windows Server' : 'SQL Server'} ESU is priced for versions ${(win ? WS_VERSIONS : SQL_VERSIONS).join(', ')}; got "${version}".`);
    if (win && !['standard', 'datacenter'].includes(edition)) throw new PricingError('Windows Server edition must be "standard" or "datacenter".');
    if (!win && hostedOn === 'azure-vm' && mode !== 'virtual') throw new PricingError('Azure virtual machines are licensed by virtual cores; use licensing "virtual".');
    if (win && mode === 'physical-unlimited') throw new PricingError('"physical-unlimited" applies to SQL Server only.');
    if (!win && !['standard', 'enterprise', ...NO_ESU_SQL].includes(edition)) throw new PricingError('SQL Server edition must be standard, enterprise, developer, express or web.');
    const G = 'Security';
    const prodName = win ? 'Windows Server' : 'SQL Server';
    const gov = /^usgov|^usdod/.test(ctx.region);
    const REGIONLESS = `armRegionName eq '${gov ? 'US Gov' : 'Global'}'`;
    const where = hostedOn === 'azure-vm' ? 'Azure VM' : 'Azure Arc';
    const money = v => `${fmtN(round2(v))} ${ctx.currency || 'USD'}`;
    const free = why => ({
      lines: [line(G, win ? 'Azure Arc' : 'Azure Arc Enabled Databases', `${prodName} ${version} ESU on ${where === 'Azure VM' ? 'Azure virtual machines' : 'servers'}: ${fmtN(machines)} machine(s) x ${fmtN(cores)} cores, no charge`, 0, 'core-hours', 0, 0, { meterId: null, meterName: 'no charge' })],
      notes: [why],
      facts: { product, version, edition, hostedOn, licensing: mode, machines, cores, billableCores: 0, totalCores: machines * cores, hours, free: true }
    });
    const datesNote = win ? (version === '2012' ? 'Windows Server 2012 and 2012 R2 extended security updates end on October 13, 2026.' : 'Windows Server 2016 ESU billing begins January 13, 2027 (enrolment opens in the Azure portal from August 3, 2026).') : null;
    if (!win && NO_ESU_SQL.includes(edition)) return free(`SQL Server ${edition} edition has no extended security update charge.`);
    if (hostedOn === 'azure-vm') {
      if (win && version === '2012') return free('Windows Server 2012 and 2012 R2 extended security updates are free for servers hosted in Azure. ' + datesNote);
      if (!win && version === '2014') return free('Extended security updates for SQL Server 2014 on Azure virtual machines are free of charge.');
    }
    let meterRows, svc, minKey, rate, stdAlt;
    if (win) {
      const code = ed => `WS${version} ${ed === 'datacenter' ? 'DC' : 'Std'} 1C ESU`;
      if (hostedOn === 'azure-vm') {
        // Windows Server 2016 on Azure VMs: one meter per VM size in vCPUs, no core minimum.
        if (mode === 'physical') throw new PricingError('Azure virtual machines are licensed by virtual cores; use licensing "virtual".');
        const rs = await rows(`productName eq 'Windows Server Azure ESU' and priceType eq 'Consumption' and armRegionName eq 'Global'`, ctx);
        // Published per-size meters all equal the 1 vCPU meter x vCPUs, so price any size from the 1 vCPU meter.
        const one = single(rs.filter(r => r.meterName === 'WS 2016 1 vCPU ESU'), 'Windows Server 2016 ESU per vCPU on Azure VMs');
        const lines = [meterLine(G, 'Virtual Machines Licenses', `Windows Server 2016 ESU on Azure virtual machines: ${fmtN(machines)} VM(s) of ${fmtN(cores)} vCPUs x ${fmtN(hours)} hours`, one, machines * cores * hours, ctx, { unit: 'vCPU-hours' })];
        return { lines, notes: [datesNote, 'Charged per virtual CPU with no minimum core count. The Azure pricing page says: "Customers will pay the same list price regardless of where workloads are deployed, including Azure, on-premises, or other public clouds". Learn pages about ESU on Azure VMs say the updates are free, but they do not cover Windows Server 2016.'], facts: { product, version, edition, hostedOn, licensing: mode, machines, cores, billableCores: cores, totalCores: machines * cores, hours } };
      }
      const rs = await rows(`productName eq 'Azure Arc Extended Security Updates' and priceType eq 'Consumption' and ${REGIONLESS}`, ctx);
      meterRows = single(rs.filter(r => r.meterName === code(edition)), `Windows Server ${version} ${edition} ESU per core (${code(edition)})`);
      if (edition === 'datacenter' && mode === 'virtual') stdAlt = single(rs.filter(r => r.meterName === code('standard')), `Windows Server ${version} standard ESU per core`);
      svc = 'Azure Arc'; minKey = 'windows-' + mode; rate = edition;
    } else {
      const unl = mode === 'physical-unlimited';
      const ed = (unl || edition === 'enterprise') ? 'Ent' : 'Std';
      const code = hostedOn === 'azure-vm' ? `${ed} edition - Azure ESU 2016` : `${ed} edition - ESU ${version}`;
      const rs = await rows(`productName eq 'Azure Arc-enabled SQL Server - Arc-enabled servers' and priceType eq 'Consumption' and ${REGIONLESS}`, ctx);
      meterRows = single(rs.filter(r => r.meterName === code), `SQL Server ${version} ${edition} ESU per core (${code})`);
      svc = 'Azure Arc Enabled Databases'; minKey = unl ? 'sql-physical-unlimited' : 'sql'; rate = unl ? 'enterprise' : edition;
    }
    const min = MIN_CORES[minKey];
    const billable = Math.max(cores, min);
    const total = machines * billable;
    const lines = [meterLine(G, svc, `${prodName} ${version} ESU (${rate} rate): ${fmtN(machines)} machine(s) x ${fmtN(billable)} billable cores x ${fmtN(hours)} hours`, meterRows, total * hours, ctx, { unit: 'core-hours' })];
    const unitWord = minKey === 'windows-physical' || minKey === 'sql-physical-unlimited' ? 'physical server' : minKey === 'windows-virtual' ? 'virtual machine' : 'machine';
    const notes = [`Billed per core per hour with a minimum of ${min} cores per ${unitWord}${billable > cores ? `; ${fmtN(cores)} cores are rounded up to ${fmtN(billable)}` : ''}.`,
      'Enrolling after the end-of-support date adds a one-off back-billing charge for the elapsed time, not included here.'];
    if (datesNote) notes.push(datesNote);
    if (win && mode === 'virtual' && edition === 'datacenter') notes.push(`Microsoft recommends selecting the Standard edition for virtual-core licences; Standard would cost ${money(stdAlt[0].retailPrice * total * hours)} a month here instead of ${money(meterRows[0].retailPrice * total * hours)}.`);
    if (!win) notes.push('Virtual cores of a machine that qualifies as a free HA or disaster-recovery passive replica are not billable; reduce the core count if that applies.');
    return { lines, notes, facts: { product, version, edition, hostedOn, licensing: mode, machines, cores, billableCores: billable, totalCores: total, hours } };
  }
};


