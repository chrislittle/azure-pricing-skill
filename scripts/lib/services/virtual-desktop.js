'use strict';
// Azure Virtual Desktop. Two parts, like the calculator:
//  1. Session hosts (the main cost): sized from users, workload density, concurrency, usage hours and scaling,
//     priced as vm + OS disk + optional profile storage (Azure Files) using the existing vm/disk/files pricers.
//     Windows 10/11 session hosts are billed at Linux compute rates (pricing page), so os 'linux' is used.
//  2. AVD-specific meters: per-user access rights (EXTERNAL users only) and, on Azure Local, the AVD service fee
//     plus the Azure Local host fee (Global meter).
// Meters: serviceName 'Windows Virtual Desktop' (regional) and 'Azure Stack HCI' (Global).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS, DAYS } = require('../kit');
const { lifecycle, explain } = require('../lifecycle');
const vmSizes = require('../../../catalog/vm-sizes.json');

const n = v => Number(v || 0);
// Users per vCPU, from the calculator's workload tooltip.
const DENSITY = { light: 6, medium: 4, heavy: 2, power: 1 };
const VM_COMMIT = ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'];
const OS_DISKS = ['premium-ssd', 'standard-ssd', 'standard-hdd'];

module.exports = {
  type: 'virtual-desktop',
  label: 'Azure Virtual Desktop',
  family: 'compute-other',
  calculator: ['virtual-desktop'],
  keywords: ['virtual desktop', 'avd', 'remote desktop', 'remoteapp', 'vdi', 'external users', 'desktop streaming', 'azure local', 'session hosts', 'windows 365 alternative'],
  fields: {
    sessionHostUsers: { def: 0, int: true, min: 0, ask: 'How many people in total will use the Azure-hosted session hosts, including any external users (customers or other outside parties) as well as staff? Their licences (Microsoft 365 E3/E5/F3/Business Premium or Windows Enterprise) cost nothing extra in Azure, but their session-host VMs do. Use 0 only if the session hosts are priced some other way.' },
    deployment: { def: 'pooled', enum: ['pooled', 'pooled-single', 'personal'], ask: 'Do users share multi-session VMs (pooled: many users per VM), share single-session VMs (pooled-single: one VM per signed-in user, switched off when they leave), or does each user have their own permanent VM (personal)? If unknown use pooled.' },
    workload: { def: 'medium', enum: Object.keys(DENSITY), ask: 'How heavy is the typical work, which sets users per vCPU on a shared (pooled) VM? light = 6 users per vCPU (data entry, a few apps), medium = 4, heavy = 2, power = 1 (developers, designers, analysts). If unknown use medium.' },
    hostSize: { def: 'Standard_D4s_v5', ask: 'Which VM size for each session host? Use a current general-purpose size such as Standard_D4s_v5 (4 vCPU) or Standard_D8s_v5. Older End of Life sizes are not priced; run vm-suggest to choose. If unknown use Standard_D4s_v5.' },
    hostOs: { def: 'windows-client', enum: ['windows-client', 'windows-server', 'windows-server-ahb'], ask: 'Which operating system on the session hosts? Windows 11 or Windows 10 (single or multi-session) -> windows-client, billed at Linux compute rates. Windows Server -> windows-server, which adds the Windows licence to the VM rate; Windows Server with your own licences (Azure Hybrid Benefit) -> windows-server-ahb. If unknown use windows-client.' },
    peakConcurrentUsers: { def: 0, int: true, min: 0, ask: 'At the busiest time, how many users are signed in at once? Use 0 to assume all named users.' },
    offPeakConcurrentUsers: { def: 0, int: true, min: 0, ask: 'Outside busy hours, how many users are still signed in (this many hosts stay on all month)? Use 0 if the hosts can all be switched off.' },
    usageHours: { def: 220, min: 0, max: 744, ask: 'How many hours a month are the busy-time hosts needed (about 220 for a working-day schedule; 730 = all month)? Only used with a scaling plan or for personal desktops.' },
    scaling: { def: 'scaling-plan', enum: ['scaling-plan', 'always-on'], ask: 'Will a scaling plan (autoscale) switch hosts off outside busy hours (scaling-plan), or must every host be on all month (always-on)? If unknown use scaling-plan.' },
    osVcpuReserve: { def: 0.75, min: 0, ask: 'How many vCPUs per VM does the operating system itself use (not available to users)? The calculator suggests 0.75 for quick estimates. If unknown use 0.75.' },
    osDiskType: { def: 'premium-ssd', enum: OS_DISKS, ask: 'Which OS disk type for each session host? premium-ssd (fastest, the usual choice), standard-ssd or standard-hdd. If unknown use premium-ssd.' },
    osDiskGiB: { def: 128, int: true, min: 1, ask: 'How large is each session host OS disk in GiB? 128 is the common size. If unknown use 128.' },
    profileStorageGiB: { def: 0, int: true, min: 0, ask: 'How many GiB of user profile storage (FSLogix profiles on Azure Files) in total? Use 0 if profiles are stored elsewhere or you will add storage separately. A common sizing is 5 to 30 GiB per user.' },
    hostCommitment: { def: 'payg', enum: VM_COMMIT, ask: 'Will the always-on session hosts run steadily for a year or more? No -> payg; yes -> ri1y or ri3y (reservation), sp1y or sp3y (savings plan). With a scaling plan it applies to the hosts that run all month; the extra busy-time hosts stay pay-as-you-go. If unknown use payg.' },
    desktopUsers: { def: 0, int: true, min: 0, ask: 'How many EXTERNAL users who connect in a month need a full remote desktop plus apps? (Their session hosts are priced from sessionHostUsers above, so include them there too.) External means customers or other people who are not your employees, students or contractors (for example people using an app you sell). Your own staff and contractors need a Microsoft 365 / Windows Enterprise licence instead: answer 0 for them. They are billed $/user/month, only for users who connect at least once that month.' },
    appUsers: { def: 0, int: true, min: 0, ask: 'How many EXTERNAL users who connect in a month only stream individual apps (RemoteApp), not a full desktop? External means people who are not your employees, students or contractors; answer 0 for your own staff.' },
    appToDesktopUpgradeUsers: { def: 0, int: true, min: 0 },
    hciVcpus: { def: 0, int: true, min: 0, ask: 'Only if session hosts run on-premises on Azure Local: how many vCPUs do all those session-host VMs have in total? Use 0 for session hosts running in Azure.' },
    hciPhysicalCores: { def: 0, int: true, min: 0, ask: 'Only for Azure Local: how many physical processor cores do the cluster servers have in total (the host service fee is per physical core)? Use 0 if the hosts are already counted elsewhere.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Azure Local only: hours a month the session-host VMs run (730 = all month). The per-user prices are monthly and ignore this.' }
  },
  context: ['production', 'steadyUsage'],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Session-host VMs and OS disks are priced here when you give the number of users (sessionHostUsers). If you set it to 0 they are not included: price them with the vm and disk types, and use os linux for Windows 10/11 hosts.',
    'Profile storage beyond what you enter in profileStorageGiB (Azure NetApp Files, extra file shares, backups).',
    'User access rights for staff already licensed with Microsoft 365 E3/E5/F3/Business Premium or Windows Enterprise/Education are included in those licences; they cost nothing in Azure. Control-plane features (host pools, workspaces, scaling plans) are not billed.',
    'Azure Virtual Desktop Hybrid: it has a service fee, but it is purchased through your Microsoft account team and has no public price, so it is not priced here.',
    'Networking, bandwidth, Entra ID, Intune and monitoring (Log Analytics) costs.'
  ]),
  examples: [
    { type: 'virtual-desktop', desktopUsers: 50 },
    { type: 'virtual-desktop', sessionHostUsers: 200, workload: 'medium', hostSize: 'Standard_D4s_v5', peakConcurrentUsers: 150, offPeakConcurrentUsers: 10, usageHours: 220, profileStorageGiB: 2000 },
    { type: 'virtual-desktop', sessionHostUsers: 40, deployment: 'personal', hostSize: 'Standard_D4s_v5', scaling: 'always-on', osDiskType: 'standard-ssd' },
    { type: 'virtual-desktop', desktopUsers: 100, appUsers: 200, appToDesktopUpgradeUsers: 25, hciVcpus: 64, hciPhysicalCores: 32, hours: 730 }
  ],
  readback: c => {
    const parts = [];
    const users = n(c.sessionHostUsers);
    if (users) {
      const dep = (c.deployment || 'pooled') === 'personal' ? 'a personal VM each' : (c.deployment || 'pooled') === 'pooled-single' ? 'shared single-session VMs (one per signed-in user)' : `shared multi-session desktops (${c.workload || 'medium'} workload)`;
      const peakN = n(c.peakConcurrentUsers) || users, hOs = c.hostOs || 'windows-client';
      parts.push(`${fmtN(users)} users on ${dep}, ${fmtN(peakN)} signed in at peak${n(c.offPeakConcurrentUsers) ? ` and ${fmtN(n(c.offPeakConcurrentUsers))} off-peak` : ''}, ${c.hostSize || 'Standard_D4s_v5'} session hosts running ${hOs === 'windows-server' ? 'Windows Server' : hOs === 'windows-server-ahb' ? 'Windows Server (Azure Hybrid Benefit)' : 'Windows 10/11'} (${fmtN(n(c.osVcpuReserve ?? 0.75))} vCPU kept for the operating system), ${(c.scaling || 'scaling-plan') === 'always-on' ? 'always on' : `scaling plan with about ${fmtN(c.usageHours ?? 220)} busy hours a month`}, ${c.hostCommitment && c.hostCommitment !== 'payg' ? c.hostCommitment : 'pay-as-you-go'}, ${fmtN(c.osDiskGiB ?? 128)} GiB ${c.osDiskType || 'premium-ssd'} OS disks${n(c.profileStorageGiB) ? `, ${fmtN(n(c.profileStorageGiB))} GiB profile storage` : ''}`);
    }
    if (n(c.desktopUsers)) parts.push(`${fmtN(n(c.desktopUsers))} external users who connect in a month with desktop and apps`);
    if (n(c.appUsers)) parts.push(`${fmtN(n(c.appUsers))} external app-only (RemoteApp) users who connect in a month`);
    if (n(c.appToDesktopUpgradeUsers)) parts.push(`${fmtN(n(c.appToDesktopUpgradeUsers))} app users upgraded to a full desktop`);
    if (n(c.hciVcpus)) parts.push(`${fmtN(n(c.hciVcpus))} session-host vCPUs on Azure Local for ${(c.hours ?? HOURS) === HOURS ? 'all month (730 hours)' : `${fmtN(c.hours)} hours a month`}`);
    if (n(c.hciPhysicalCores)) parts.push(`${fmtN(n(c.hciPhysicalCores))} Azure Local physical cores`);
    return `Azure Virtual Desktop: ${parts.join('; ')}`;
  },
  price: async (c, ctx) => {
    const { PRICERS } = require('../recipes');
    const d = n(c.desktopUsers), a = n(c.appUsers), u = n(c.appToDesktopUpgradeUsers), v = n(c.hciVcpus), pc = n(c.hciPhysicalCores), hours = c.hours ?? HOURS;
    const users = n(c.sessionHostUsers), prof = n(c.profileStorageGiB);
    for (const [k, x] of Object.entries({ sessionHostUsers: users, desktopUsers: d, appUsers: a, appToDesktopUpgradeUsers: u, hciVcpus: v, hciPhysicalCores: pc, peakConcurrentUsers: n(c.peakConcurrentUsers), offPeakConcurrentUsers: n(c.offPeakConcurrentUsers), profileStorageGiB: prof })) {
      if (!Number.isInteger(x) || x < 0) throw new PricingError(`${k} must be a whole number, 0 or more.`);
    }
    if (u > a) throw new PricingError('appToDesktopUpgradeUsers cannot exceed appUsers: the upgrade applies to users who already have the app-only right.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const G = 'Compute', S = 'Windows Virtual Desktop', lines = [], notes = [];
    const facts = { desktopUsers: d, appUsers: a, upgradeUsers: u, hciVcpus: v, hciPhysicalCores: pc, externalUsers: d + a, sessionHostUsers: users };

    if (users) {
      const deployment = c.deployment || 'pooled', workload = c.workload || 'medium', scaling = c.scaling || 'scaling-plan';
      const hostOs = c.hostOs || 'windows-client', size = c.hostSize || 'Standard_D4s_v5', usage = c.usageHours ?? 220;
      const commit = c.hostCommitment || 'payg', diskType = c.osDiskType || 'premium-ssd', diskGiB = c.osDiskGiB ?? 128;
      if (!(workload in DENSITY)) throw new PricingError(`workload must be one of: ${Object.keys(DENSITY).join(', ')}.`);
      if (!['pooled', 'pooled-single', 'personal'].includes(deployment)) throw new PricingError('deployment must be pooled, pooled-single or personal.');
      if (!['scaling-plan', 'always-on'].includes(scaling)) throw new PricingError('scaling must be scaling-plan or always-on.');
      if (!['windows-client', 'windows-server', 'windows-server-ahb'].includes(hostOs)) throw new PricingError('hostOs must be windows-client, windows-server or windows-server-ahb.');
      if (!VM_COMMIT.includes(commit)) throw new PricingError(`hostCommitment must be one of: ${VM_COMMIT.join(', ')}.`);
      if (!OS_DISKS.includes(diskType)) throw new PricingError(`osDiskType must be one of: ${OS_DISKS.join(', ')}.`);
      if (usage < 0 || usage > 744) throw new PricingError('usageHours must be between 0 and 744.');
      const spec = vmSizes[size];
      if (!spec) throw new PricingError(`Unknown VM size "${size}". Use a size such as Standard_D4s_v5; run vm-suggest to choose one.`);
      if (!lifecycle(size).modern) throw new PricingError(`${explain(size)} Choose a current size such as Standard_D4s_v5 or Standard_D8s_v5 for the session hosts.`);
      let peak = n(c.peakConcurrentUsers) || users, off = n(c.offPeakConcurrentUsers);
      if (peak > users) throw new PricingError('peakConcurrentUsers cannot exceed sessionHostUsers.');
      if (off > peak) throw new PricingError('offPeakConcurrentUsers cannot exceed peakConcurrentUsers.');
      const reserve = n(c.osVcpuReserve ?? 0.75), usable = Math.max(spec.v - reserve, 0);
      if (deployment === 'pooled' && usable <= 0) throw new PricingError(`${size} has ${spec.v} vCPUs, none left after the ${reserve} the operating system uses. Choose a larger size or lower osVcpuReserve.`);
      // Calculator formula: hosts = ceil(users / users per vCPU / usable vCPUs); no rounding of users per host.
      const need = k => deployment === 'pooled' ? Math.ceil(k / DENSITY[workload] / usable) : k;
      const perHost = deployment === 'pooled' ? Math.round(usable * DENSITY[workload] * 10) / 10 : 1;
      const peakHosts = deployment === 'personal' ? users : need(peak);
      const baseHosts = deployment === 'personal' ? 0 : Math.min(peakHosts, need(off));
      const sizeKey = size.replace('Standard_', '');
      const os = hostOs === 'windows-server' ? 'windows' : hostOs === 'windows-server-ahb' ? 'windows-ahb' : 'linux';
      const sub = r => { lines.push(...r.lines); notes.push(...r.notes); return r; };
      if (scaling === 'always-on') sub(await PRICERS.vm({ sku: size, count: peakHosts, hours: HOURS, os, commitment: commit }, ctx));
      else {
        if (baseHosts) sub(await PRICERS.vm({ sku: size, count: baseHosts, hours: HOURS, os, commitment: commit }, ctx));
        if (peakHosts > baseHosts) sub(await PRICERS.vm({ sku: size, count: peakHosts - baseHosts, hours: usage, os }, ctx));
      }
      sub(await PRICERS.disk({ diskType, sizeGiB: diskGiB, count: peakHosts, role: 'session host OS disk' }, ctx));
      if (prof) sub(await PRICERS.files({ model: 'premium-v1', capacityGB: prof, redundancy: 'LRS' }, ctx));
      Object.assign(facts, { hostOs, scaling, deployment, hostSize: size, hosts: peakHosts, alwaysOnHosts: scaling === 'always-on' ? peakHosts : baseHosts, usersPerHost: perHost, internalUsers: Math.max(users - d - a, 0) });
      notes.push(`Session hosts: ${fmtN(users)} users, ${fmtN(peak)} signed in at peak, ${deployment === 'personal' ? 'one VM per user' : deployment === 'pooled-single' ? 'one single-session VM per signed-in user' : `${fmtN(DENSITY[workload])} users per vCPU on ${sizeKey} (${spec.v} vCPUs minus ${reserve} for the operating system) = ${fmtN(Math.round(usable * DENSITY[workload] * 10) / 10)} users per host`} gives ${fmtN(peakHosts)} host(s) at peak${scaling === 'scaling-plan' && deployment !== 'personal' ? `, ${fmtN(baseHosts)} kept on all month and the rest on about ${fmtN(usage)} hours` : scaling === 'scaling-plan' ? `, each on about ${fmtN(usage)} hours` : ', all on all month'}. OS disk: ${fmtN(diskGiB)} GiB ${diskType} per host${commit !== 'payg' ? `; ${commit} commitment on the ${fmtN(scaling === 'always-on' ? peakHosts : baseHosts)} always-on host(s)` : ''}.`);
      if (commit !== 'payg' && scaling === 'scaling-plan' && !baseHosts) notes.push(`No hosts stay on all month (offPeakConcurrentUsers is 0), so the ${commit} commitment covers nothing here and all hosts are priced pay-as-you-go. Set offPeakConcurrentUsers or use always-on to price a commitment.`);
      if (os === 'linux') notes.push('Windows 10 and Windows 11 session hosts are billed at Linux compute rates (Azure Virtual Desktop pricing page); the user licence (Microsoft 365 E3/E5/F3/Business Premium or Windows Enterprise) is separate and not an Azure charge.');
      else notes.push(`Windows Server session hosts are billed with the Windows licence ${os === 'windows-ahb' ? 'covered by Azure Hybrid Benefit (you bring your own Windows Server licences)' : 'included in the VM rate'}; per-user access pricing is not available for them.`);
    }

    if (d || a || u || v) {
      const rs = await rows(`serviceName eq 'Windows Virtual Desktop' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
      if (!rs.length) throw new PricingError(`Azure Virtual Desktop user and service fees are not priced in ${ctx.region}. Try a nearby major region such as eastus2, westeurope or northeurope.`);
      const sku = (name, what) => single(rs.filter(r => r.skuName === name), what);
      if (d) lines.push(meterLine(G, S, `Azure Virtual Desktop access, desktop and apps: ${fmtN(d)} external users who connect in a month`, sku('Desktop & App Hosting', 'desktop and app hosting user'), d, ctx, { unit: 'users / month' }));
      if (a) lines.push(meterLine(G, S, `Azure Virtual Desktop access, apps only (RemoteApp): ${fmtN(a)} external users who connect in a month`, sku('App Hosting', 'app hosting user'), a, ctx, { unit: 'users / month' }));
      if (u) lines.push(meterLine(G, S, `Upgrade from apps to full desktop: ${fmtN(u)} users`, sku('App to Desktop Upgrade', 'app to desktop upgrade'), u, ctx, { unit: 'users / month' }));
      if (v) lines.push(meterLine(G, S, `Azure Virtual Desktop service fee on Azure Local: ${fmtN(v)} vCPUs x ${fmtN(hours)} hours`, sku('AVD for Azure Stack HCI', 'AVD for Azure Stack HCI service fee'), v * hours, ctx, { unit: 'vCPU-hours' }));
    }
    if (pc) {
      const hci = await rows(`serviceName eq 'Azure Stack HCI' and armRegionName eq 'Global' and priceType eq 'Consumption' and skuName eq 'Standard' and meterName eq 'Standard Monthly Service Fee'`, ctx);
      lines.push(meterLine(G, 'Azure Stack HCI', `Azure Local host service fee: ${fmtN(pc)} physical cores, all month`, single(hci, 'Azure Local host service fee'), pc * DAYS, ctx, { unit: 'core-days' }));
    }
    if (!lines.length) throw new PricingError('Nothing to price: set sessionHostUsers (session hosts), desktopUsers or appUsers (external users), hciVcpus or hciPhysicalCores above 0. Staff with Microsoft 365/Windows Enterprise licences have no AVD user charge in Azure, but their session hosts do cost money.');
    if (d || a || u) notes.push('Per-user access rights are billed monthly for each user who connects at least once in the month, and only for external users: they do not cover your own employees, students or contractors, who need a Microsoft 365 or Windows Enterprise licence instead. The tier (apps or desktop) is set automatically from what each user connects to.');
    if (v || pc) notes.push('On Azure Local the AVD service fee is per session-host vCPU-hour and the Azure Local host fee is per physical core, billed worldwide at one global rate whatever region you choose; user access rights are still needed. Azure Local was previously called Azure Stack HCI and has a free trial period that is not modeled.');
    return { lines, notes, facts };
  }
};
