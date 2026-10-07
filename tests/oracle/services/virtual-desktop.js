'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'virtual-desktop';
const HOURS_PER_MONTH = 730;
const DAYS_PER_MONTH = 730 / 24;
const DENSITY = { light: 6, medium: 4, heavy: 2, power: 1 };
const SIZE = {
  Standard_D4s_v5: { meter: 'D4s v5', vcpus: 4, ram: 16 },
  Standard_D8s_v5: { meter: 'D8s v5', vcpus: 8, ram: 32 },
};

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calculatorOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }
function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one AVD row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function calculatorAvd({ region, desktopUsers = 0, appUsers = 0, appToDesktopUpgradeUsers = 0, hciVcpus = 0, hciPhysicalCores = 0, hours = HOURS_PER_MONTH }) {
  const lines = [];
  if (desktopUsers) {
    const price = await calculatorOffer('remote-app-streaming-desktop', region);
    lines.push(line(`desktop users: ${desktopUsers} users * ${price}/month`, desktopUsers * price, { sourceOffer: 'remote-app-streaming-desktop' }));
  }
  if (appUsers) {
    const price = await calculatorOffer('remote-app-streaming-apps', region);
    lines.push(line(`app users: ${appUsers} users * ${price}/month`, appUsers * price, { sourceOffer: 'remote-app-streaming-apps' }));
  }
  if (appToDesktopUpgradeUsers) {
    const desktop = await calculatorOffer('remote-app-streaming-desktop', region);
    const apps = await calculatorOffer('remote-app-streaming-apps', region);
    lines.push(line(`app-to-desktop upgrades: ${appToDesktopUpgradeUsers} users * (${desktop} - ${apps})`, appToDesktopUpgradeUsers * (desktop - apps), { sourceOffer: 'remote-app-streaming-desktop minus remote-app-streaming-apps' }));
  }
  if (hciVcpus) {
    const price = await calculatorOffer('azure-virtual-desktop-stack-hci', region);
    lines.push(line(`Azure Local AVD service: ${hciVcpus} vCPU * ${hours} hours * ${price}`, hciVcpus * hours * price, { sourceOffer: 'azure-virtual-desktop-stack-hci' }));
  }
  if (hciPhysicalCores) {
    const price = await calculatorOffer('azure-stack-hci-standard', region);
    lines.push(line(`Azure Stack HCI host service: ${hciPhysicalCores} physical cores * ${DAYS_PER_MONTH} days * ${price}`, hciPhysicalCores * DAYS_PER_MONTH * price, { sourceOffer: 'azure-stack-hci-standard' }));
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailAvd({ region, currency, desktopUsers = 0, appUsers = 0, appToDesktopUpgradeUsers = 0, hciVcpus = 0, hours = HOURS_PER_MONTH }) {
  const rows = dedupe(await query(`serviceName eq 'Windows Virtual Desktop' and productName eq 'Azure Virtual Desktop' and armRegionName eq '${region}'`, currency));
  const lines = [];
  if (desktopUsers) {
    const row = pickOne(rows, r => r.skuName === 'Desktop & App Hosting' && r.meterName === 'Desktop & App Hosting User', 'desktop users');
    lines.push(line(`Retail desktop users: ${desktopUsers} users / ${unitSize(row.unitOfMeasure)} * ${row.retailPrice}`, desktopUsers / unitSize(row.unitOfMeasure) * row.retailPrice, { meterId: row.meterId }));
  }
  if (appUsers) {
    const row = pickOne(rows, r => r.skuName === 'App Hosting' && r.meterName === 'App Hosting User', 'app users');
    lines.push(line(`Retail app users: ${appUsers} users / ${unitSize(row.unitOfMeasure)} * ${row.retailPrice}`, appUsers / unitSize(row.unitOfMeasure) * row.retailPrice, { meterId: row.meterId }));
  }
  if (appToDesktopUpgradeUsers) {
    const row = pickOne(rows, r => r.skuName === 'App to Desktop Upgrade' && r.meterName === 'App to Desktop Upgrade User', 'upgrade users');
    lines.push(line(`Retail app-to-desktop upgrades: ${appToDesktopUpgradeUsers} users / ${unitSize(row.unitOfMeasure)} * ${row.retailPrice}`, appToDesktopUpgradeUsers / unitSize(row.unitOfMeasure) * row.retailPrice, { meterId: row.meterId }));
  }
  if (hciVcpus) {
    const row = pickOne(rows, r => r.skuName === 'AVD for Azure Stack HCI' && r.meterName === 'AVD for Azure Stack HCI Service Fee/vCPU', 'AVD for Azure Stack HCI vCPU');
    lines.push(line(`Retail Azure Local AVD service: ${hciVcpus} vCPU * ${hours} hours * ${row.retailPrice}`, hciVcpus * hours * row.retailPrice, { meterId: row.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

async function vmRows(region, currency, size) {
  const meter = SIZE[size].meter;
  return dedupe(await query(`serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and contains(meterName, '${meter}')`, currency));
}
async function windowsServerVcpuHour(currency) {
  const rows = dedupe(await query(`serviceName eq 'Virtual Machines Licenses' and productName eq 'Windows Server' and skuName eq '1 vCPU VM'`, currency));
  return pickOne(rows, r => r.meterName === '1 vCPU VM License' && r.type === 'Consumption', 'Windows Server 1 vCPU licence').retailPrice;
}
async function vmMonthly({ region, currency, size, hostOs = 'windows-client', hours, commitment }) {
  const rows = await vmRows(region, currency, size);
  const info = SIZE[size];
  const winRate = hostOs === 'windows-server' ? await windowsServerVcpuHour(currency) : 0;
  if (commitment === 'ri1y' || commitment === 'ri3y') {
    const term = commitment === 'ri1y' ? '1 Year' : '3 Years';
    const months = commitment === 'ri1y' ? 12 : 36;
    const r = pickOne(rows, x => x.productName === 'Virtual Machines Dsv5 Series' && x.meterName === info.meter && x.type === 'Reservation' && x.reservationTerm === term, `${info.meter} ${term} reservation`);
    return { compute: r.retailPrice / months, windows: winRate ? info.vcpus * hours * winRate : 0, windowsRate: winRate, desc: `${info.meter}, ${info.vcpus} vCPU, ${term} reservation` };
  }
  let price;
  if (commitment === 'sp1y' || commitment === 'sp3y') {
    const term = commitment === 'sp1y' ? '1 Year' : '3 Years';
    const r = pickOne(rows, x => x.productName === 'Virtual Machines Dsv5 Series' && x.meterName === info.meter && x.type === 'Consumption', `${info.meter} savings`);
    price = (r.savingsPlan || []).find(s => s.term === term).retailPrice;
  } else {
    const product = hostOs === 'windows-server' ? 'Virtual Machines Dsv5 Series Windows' : 'Virtual Machines Dsv5 Series';
    const r = pickOne(rows, x => x.productName === product && x.meterName === info.meter && x.type === 'Consumption', `${info.meter} ${hostOs}`);
    price = hostOs === 'windows-server' ? pickOne(rows, x => x.productName === 'Virtual Machines Dsv5 Series' && x.meterName === info.meter && x.type === 'Consumption', `${info.meter} linux`).retailPrice : r.retailPrice;
  }
  return { compute: price * hours, windows: winRate ? info.vcpus * hours * winRate : 0, windowsRate: winRate, desc: `${info.meter}, ${info.vcpus} vCPU, Linux-rate compute` };
}
async function diskMonthly(region, currency, osDiskType = 'premium-ssd', osDiskGiB = 128) {
  if (osDiskType !== 'premium-ssd' || osDiskGiB > 128) throw new Error('oracle only covers P10 Premium SSD OS disks');
  const rows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Premium SSD Managed Disks'`, currency));
  return pickOne(rows, r => r.skuName === 'P10 LRS' && r.meterName === 'P10 LRS Disk' && r.type === 'Consumption', 'P10 LRS disk').retailPrice;
}
async function filesMonthly(region, currency) {
  const rows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Premium Files'`, currency));
  return pickOne(rows, r => r.skuName === 'Premium LRS' && r.meterName === 'Premium LRS Provisioned' && r.type === 'Consumption', 'Premium Files LRS provisioned').retailPrice;
}
function requiredHosts(users, workload, hostSize, osVcpuReserve) {
  if (!users) return 0;
  return Math.ceil(users / DENSITY[workload] / (SIZE[hostSize].vcpus - osVcpuReserve));
}
function hostPlan({ sessionHostUsers = 0, deployment = 'pooled', workload = 'medium', hostSize = 'Standard_D4s_v5', peakConcurrentUsers = 0, offPeakConcurrentUsers = 0, scaling = 'scaling-plan', osVcpuReserve = 0.75 }) {
  const users = peakConcurrentUsers || sessionHostUsers;
  if (deployment === 'personal') return { peakHosts: users, offHosts: 0, extraPeakHosts: users };
  const peakHosts = requiredHosts(users, workload, hostSize, osVcpuReserve);
  const offHosts = scaling === 'always-on' ? peakHosts : requiredHosts(offPeakConcurrentUsers, workload, hostSize, osVcpuReserve);
  return { peakHosts, offHosts, extraPeakHosts: Math.max(0, peakHosts - offHosts) };
}
async function sessionHostsAvd(opts) {
  const { region, currency = 'USD', sessionHostUsers = 0, hostSize = 'Standard_D4s_v5', hostOs = 'windows-client', usageHours = 220, scaling = 'scaling-plan', osDiskType = 'premium-ssd', osDiskGiB = 128, profileStorageGiB = 0, hostCommitment = 'payg' } = opts;
  const plan = hostPlan(opts);
  const lines = [];
  const disk = await diskMonthly(region, currency, osDiskType, osDiskGiB);
  if (plan.offHosts) {
    const vm = await vmMonthly({ region, currency, size: hostSize, hostOs, hours: HOURS_PER_MONTH, commitment: hostCommitment });
    lines.push(line(`${vm.desc}: ${plan.offHosts} always-on hosts * ${HOURS_PER_MONTH} hours`, plan.offHosts * vm.compute, { meter: SIZE[hostSize].meter }));
    if (vm.windows) lines.push(line(`Windows Server license: ${plan.offHosts} hosts * ${SIZE[hostSize].vcpus} vCPU * ${HOURS_PER_MONTH} hours * ${vm.windowsRate}`, plan.offHosts * vm.windows));
  }
  if (plan.extraPeakHosts) {
    const peakCommitment = scaling === 'always-on' ? hostCommitment : 'payg';
    const vm = await vmMonthly({ region, currency, size: hostSize, hostOs, hours: scaling === 'always-on' ? HOURS_PER_MONTH : usageHours, commitment: peakCommitment });
    lines.push(line(`${vm.desc}: ${plan.extraPeakHosts} peak hosts * ${scaling === 'always-on' ? HOURS_PER_MONTH : usageHours} hours`, plan.extraPeakHosts * vm.compute, { meter: SIZE[hostSize].meter }));
    if (vm.windows) lines.push(line(`Windows Server license: ${plan.extraPeakHosts} hosts * ${SIZE[hostSize].vcpus} vCPU * ${scaling === 'always-on' ? HOURS_PER_MONTH : usageHours} hours * ${vm.windowsRate}`, plan.extraPeakHosts * vm.windows));
  }
  if (plan.peakHosts) lines.push(line(`P10 OS disks: ${plan.peakHosts} hosts * ${disk}`, plan.peakHosts * disk, { source: 'P10 LRS Disk' }));
  if (profileStorageGiB) {
    const files = await filesMonthly(region, currency);
    lines.push(line(`Premium Files profiles: ${profileStorageGiB} GiB * ${files}`, profileStorageGiB * files, { source: 'Premium LRS Provisioned' }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'virtual-desktop', source: 'both', cases: [
    { name: 'external desktop users', region: 'eastus2', currency: 'USD', component: { type: 'virtual-desktop', desktopUsers: 25 }, expected: async () => calculatorAvd({ region: 'eastus2', desktopUsers: 25 }) },
    { name: 'external app users', region: 'eastus2', currency: 'USD', component: { type: 'virtual-desktop', desktopUsers: 0, appUsers: 40 }, expected: async () => calculatorAvd({ region: 'eastus2', appUsers: 40 }) },
    { name: 'app users with desktop upgrades', region: 'eastus2', currency: 'USD', component: { type: 'virtual-desktop', desktopUsers: 0, appUsers: 30, appToDesktopUpgradeUsers: 10 }, expected: async () => calculatorAvd({ region: 'eastus2', appUsers: 30, appToDesktopUpgradeUsers: 10 }) },
    { name: 'Azure Local vCPU part-time', region: 'eastus2', currency: 'USD', component: { type: 'virtual-desktop', desktopUsers: 0, hciVcpus: 64, hours: 100 }, expected: async () => calculatorAvd({ region: 'eastus2', hciVcpus: 64, hours: 100 }) },
    { name: 'Azure Stack HCI physical cores', region: 'eastus2', currency: 'USD', component: { type: 'virtual-desktop', desktopUsers: 0, hciPhysicalCores: 32 }, expected: async () => calculatorAvd({ region: 'eastus2', hciPhysicalCores: 32 }) },
    { name: 'EUR retail API users and HCI vCPU', region: 'eastus2', currency: 'EUR', component: { type: 'virtual-desktop', desktopUsers: 5, appUsers: 10, appToDesktopUpgradeUsers: 2, hciVcpus: 4, hours: 100 }, expected: async () => retailAvd({ region: 'eastus2', currency: 'EUR', desktopUsers: 5, appUsers: 10, appToDesktopUpgradeUsers: 2, hciVcpus: 4, hours: 100 }) },
    {
      name: 'calculator default heavy 500 users', region: 'eastus2', currency: 'USD',
      component: { type: 'virtual-desktop', sessionHostUsers: 500, workload: 'heavy', hostSize: 'Standard_D4s_v5', peakConcurrentUsers: 450, offPeakConcurrentUsers: 25, usageHours: 220, scaling: 'scaling-plan' },
      // Published calculator formula: hosts = ceil(users / users-per-vCPU / (vCPUs - OS reserve)). Heavy: ceil(450/2/(4-0.75)) = 70 peak, ceil(25/2/3.25) = 4 off-peak; compute + 70 P10 disks = $4,602.88.
      expected: async () => sessionHostsAvd({ region: 'eastus2', sessionHostUsers: 500, workload: 'heavy', hostSize: 'Standard_D4s_v5', peakConcurrentUsers: 450, offPeakConcurrentUsers: 25, usageHours: 220, scaling: 'scaling-plan' }),
    },
    {
      name: 'pooled medium scaling plan with profiles', region: 'eastus2', currency: 'USD',
      component: { type: 'virtual-desktop', sessionHostUsers: 40, workload: 'medium', hostSize: 'Standard_D4s_v5', usageHours: 220, scaling: 'scaling-plan', profileStorageGiB: 400 },
      // Published calculator formula: ceil(40 / 4 users-per-vCPU / (4 - 0.75 OS vCPU)) = 4 peak hosts for 220 hours, 4 P10 disks, and 400 GiB Premium Files.
      expected: async () => sessionHostsAvd({ region: 'eastus2', sessionHostUsers: 40, workload: 'medium', hostSize: 'Standard_D4s_v5', usageHours: 220, scaling: 'scaling-plan', profileStorageGiB: 400 }),
    },
    {
      name: 'pooled medium off-peak host kept on', region: 'eastus2', currency: 'USD',
      component: { type: 'virtual-desktop', sessionHostUsers: 40, workload: 'medium', hostSize: 'Standard_D4s_v5', peakConcurrentUsers: 20, offPeakConcurrentUsers: 5, usageHours: 220, scaling: 'scaling-plan' },
      // Formula gives ceil(20/4/3.25)=2 peak hosts and ceil(5/4/3.25)=1 off-peak host; OS disks cover both peak hosts.
      expected: async () => sessionHostsAvd({ region: 'eastus2', sessionHostUsers: 40, workload: 'medium', hostSize: 'Standard_D4s_v5', peakConcurrentUsers: 20, offPeakConcurrentUsers: 5, usageHours: 220, scaling: 'scaling-plan' }),
    },
    {
      name: '39 light users always-on Windows client at Linux rates', region: 'eastus2', currency: 'USD',
      component: { type: 'virtual-desktop', sessionHostUsers: 39, workload: 'light', hostSize: 'Standard_D4s_v5', scaling: 'always-on', hostOs: 'windows-client' },
      // Windows 10/11 session hosts use Linux compute rates; formula gives ceil(39/6/(4-0.75)) = 2 all-month hosts and two P10 disks.
      expected: async () => sessionHostsAvd({ region: 'eastus2', sessionHostUsers: 39, workload: 'light', hostSize: 'Standard_D4s_v5', scaling: 'always-on', hostOs: 'windows-client' }),
    },
    {
      name: 'personal desktops part-time', region: 'eastus2', currency: 'USD',
      component: { type: 'virtual-desktop', sessionHostUsers: 8, deployment: 'personal', hostSize: 'Standard_D4s_v5', usageHours: 100, scaling: 'scaling-plan' },
      // Personal deployment allocates one VM per user; 8 users need 8 hosts for 100 hours and 8 P10 OS disks.
      expected: async () => sessionHostsAvd({ region: 'eastus2', sessionHostUsers: 8, deployment: 'personal', hostSize: 'Standard_D4s_v5', usageHours: 100, scaling: 'scaling-plan' }),
    },
    {
      name: 'heavy D8s Windows Server one-year RI', region: 'eastus2', currency: 'USD',
      component: { type: 'virtual-desktop', sessionHostUsers: 16, workload: 'heavy', hostSize: 'Standard_D8s_v5', hostOs: 'windows-server', scaling: 'always-on', hostCommitment: 'ri1y' },
      // Formula gives ceil(16/2/(8-0.75)) = 2 D8s_v5 reserved hosts; Windows Server licence rate is read from the price list and remains hourly outside the reservation.
      expected: async () => sessionHostsAvd({ region: 'eastus2', sessionHostUsers: 16, workload: 'heavy', hostSize: 'Standard_D8s_v5', hostOs: 'windows-server', scaling: 'always-on', hostCommitment: 'ri1y' }),
    },
    {
      name: 'west europe EUR pooled session hosts', region: 'westeurope', currency: 'EUR',
      component: { type: 'virtual-desktop', sessionHostUsers: 30, workload: 'medium', hostSize: 'Standard_D4s_v5', peakConcurrentUsers: 18, offPeakConcurrentUsers: 3, usageHours: 100, scaling: 'scaling-plan', profileStorageGiB: 120 },
      // EUR Retail API case: formula gives ceil(18/4/3.25)=2 peak hosts and ceil(3/4/3.25)=1 off-peak host; includes P10 disks and Premium Files in West Europe.
      expected: async () => sessionHostsAvd({ region: 'westeurope', currency: 'EUR', sessionHostUsers: 30, workload: 'medium', hostSize: 'Standard_D4s_v5', peakConcurrentUsers: 18, offPeakConcurrentUsers: 3, usageHours: 100, scaling: 'scaling-plan', profileStorageGiB: 120 }),
    },
  ]
};
