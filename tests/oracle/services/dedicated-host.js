'use strict';

const { query, dedupe, round2 } = require('../api');

const HOURS_PER_MONTH = 730;
const TERM_MONTHS = { 'reservation-1y': 12, 'reservation-3y': 36 };
const TERM_LABEL = { 'reservation-1y': '1 Year', 'reservation-3y': '3 Years', 'savings-1y': '1 Year', 'savings-3y': '3 Years' };
const SERIES_PRODUCT = {
  dsv4: 'DSv4', dsv5: 'Dsv5', dsv6: 'Dsv6', dadsv5: 'Dadsv5', ddsv6: 'Ddsv6', fsv2: 'FSv2', fx: 'FX', fxmds: 'FX', msv2: 'MSv2', msv2medmem: 'MSv2'
};

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function seriesProduct(series) { return SERIES_PRODUCT[norm(series)] || series; }
function hostTypeMatch(row, hostType) {
  if (!hostType) return true;
  const wanted = norm(hostType);
  return norm(row.skuName) === wanted || norm(row.meterName) === wanted;
}
function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one dedicated-host row for ${what}, found ${hits.length}`);
  return hits[0];
}
async function hostRows(region, currency, series) {
  const prod = seriesProduct(series).replace(/'/g, "''");
  return dedupe(await query(`serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and contains(productName, '${prod}') and (contains(productName, 'DedicatedHost') or contains(productName, 'Dedicated Host'))`, currency));
}
async function windowsLicense(currency) {
  const rows = dedupe(await query(`serviceName eq 'Virtual Machines Licenses' and productName eq 'Windows Server' and skuName eq '1 vCPU VM'`, currency));
  return pickOne(rows, r => r.meterName === '1 vCPU VM License' && r.type === 'Consumption', 'Windows Server 1 vCPU license');
}
async function softwareLicense(currency, licence, vcpus) {
  const rows = dedupe(await query(`serviceName eq 'Virtual Machines Licenses'`, currency, { maxPages: 80 }));
  const sku = `${vcpus} vCPU VM`;
  const dashedSku = `${vcpus}-vCPU VM`;
  if (licence === 'sql-enterprise') return pickOne(rows, r => r.productName === 'SQL Server Enterprise' && r.skuName === sku && r.type === 'Consumption', 'SQL Server Enterprise licence');
  if (licence === 'rhel-sap') return pickOne(rows, r => r.productName === 'RHEL for SAP Business Applications' && r.skuName === sku && r.type === 'Consumption', 'RHEL SAP Business Applications licence');
  if (licence === 'sles-standard') return pickOne(rows, r => r.productName === 'SUSE Linux Enterprise Server Standard' && r.skuName === '3-4 vCPU VM' && r.type === 'Consumption', 'SLES Standard 3-4 vCPU support');
  if (licence === 'biztalk-standard') return pickOne(rows, r => r.productName === 'BizTalk Server Standard' && (r.skuName === sku || (vcpus <= 4 && r.skuName === '1-4 vCPU VM')) && r.type === 'Consumption', 'BizTalk Server Standard licence');
  if (licence === 'ubuntu-essential') return { retailPrice: 0.009, meterId: 'published-ubuntu-essential' };
  if (licence === 'ubuntu-standard') return { retailPrice: 0.029, meterId: 'published-ubuntu-standard' };
  if (licence === 'ubuntu-advanced') return { retailPrice: 0.057, meterId: 'published-ubuntu-advanced' };
  throw new Error(`softwareLicense oracle does not handle ${licence}`);
}
async function dedicatedHost({ region, currency, series, hostType, hosts, hours = HOURS_PER_MONTH, commitment = 'payg', windowsVcpus = 0 }) {
  const rows = await hostRows(region, currency, series);
  const lines = [];
  if (commitment === 'payg' || commitment.startsWith('savings-')) {
    const meter = pickOne(rows, r => r.type === 'Consumption' && hostTypeMatch(r, hostType) && r.retailPrice > 0, `${series} ${hostType || ''} consumption`);
    let price = meter.retailPrice;
    if (commitment.startsWith('savings-')) {
      const term = TERM_LABEL[commitment];
      const sp = (meter.savingsPlan || []).find(s => s.term === term);
      if (!sp) throw new Error(`missing ${term} savingsPlan price for ${meter.skuName}`);
      price = sp.retailPrice;
    }
    lines.push(line(`${commitment} host: ${hosts} hosts * ${hours} hours * ${price}`, hosts * hours * price, { meterId: meter.meterId, productName: meter.productName }));
  } else {
    const term = TERM_LABEL[commitment];
    const months = TERM_MONTHS[commitment];
    const meter = pickOne(rows, r => r.type === 'Reservation' && r.reservationTerm === term && hostTypeMatch(r, hostType), `${series} ${hostType || ''} ${term} reservation`);
    lines.push(line(`${term} reservation: ${hosts} hosts * whole-term ${meter.retailPrice} / ${months} months`, hosts * meter.retailPrice / months, { meterId: meter.meterId, reservationTerm: term, productName: meter.productName }));
  }
  if (windowsVcpus) {
    const win = await windowsLicense(currency);
    lines.push(line(`Windows Server license: ${windowsVcpus} vCPU * ${hours} hours * ${win.retailPrice}`, windowsVcpus * hours * win.retailPrice, { meterId: win.meterId }));
  }
  if (arguments[0].licence && arguments[0].licenceVcpus) {
    const lic = await softwareLicense(currency, arguments[0].licence, arguments[0].licenceVcpus);
    const vms = arguments[0].licenceVms || 1;
    lines.push(line(`${arguments[0].licence} licence: ${vms} VM(s) * ${hours} hours * ${lic.retailPrice}`, vms * hours * lic.retailPrice, { meterId: lic.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'dedicated-host',
  source: 'retail-api',
  cases: [
    {
      name: 'Dsv5 no-space DedicatedHost payg with Windows vCPUs', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1, windowsVcpus: 8 },
      // Retail API Dsv5 product is named "Dsv5 Series DedicatedHost" (no space); host is hourly plus Windows Server vCPU license.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1, windowsVcpus: 8 }),
    },
    {
      name: 'Dsv6 Type 1 payg', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1 },
      // Retail API Dsv6 dedicated-host meter is hourly; newer v6 series uses a generic Type 1 meter name.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1 }),
    },
    {
      name: 'Dadsv5 one year reservation', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dadsv5', hostType: 'Type1', hosts: 2, commitment: 'reservation-1y' },
      // Retail API reservation retailPrice is the whole 1-year term; monthly oracle divides by 12 months.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dadsv5', hostType: 'Dadsv5 Type1', hosts: 2, commitment: 'reservation-1y' }),
    },
    {
      name: 'Ddsv6 three year reservation', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Ddsv6', hostType: 'Type 1', hosts: 1, commitment: 'reservation-3y' },
      // Retail API Ddsv6 reservation retailPrice is the whole 3-year term; monthly oracle divides by 36 months.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Ddsv6', hostType: 'Type 1', hosts: 1, commitment: 'reservation-3y' }),
    },
    {
      name: 'Dsv5 one year savings plan', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1, commitment: 'savings-1y' },
      // Retail API embeds the 1 Year savingsPlan hourly price on the no-space Dsv5 DedicatedHost consumption meter.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1, commitment: 'savings-1y' }),
    },
    {
      name: 'Dsv5 three year savings plan', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1, commitment: 'savings-3y' },
      // Retail API embeds the 3 Year savingsPlan hourly price on the no-space Dsv5 DedicatedHost consumption meter.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1, commitment: 'savings-3y' }),
    },
    {
      name: 'FXmds Type1 payg', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'FX', hostType: 'FXmds Type1', hosts: 1 },
      // Retail API FX Series has separate spot/low-priority meters; this case picks the regular FXmds Type1 hourly meter exactly.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'FX', hostType: 'FXmds Type1', hosts: 1 }),
    },
    {
      name: 'Msv2 Type1 payg', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'MSv2', hostType: 'Type1', hosts: 1 },
      // Retail API MSv2 Series includes several M-family host types; this case targets the Msv2 Type1 hourly meter.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'MSv2', hostType: 'Msv2 Type1', hosts: 1 }),
    },
    {
      name: 'Dsv6 maximum monthly hours', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1, hours: 744 },
      // Dedicated Host PAYG is hourly; this covers the public maximum of 744 allocated hours in a long month.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1, hours: 744 }),
    },
    {
      name: 'Dsv6 with SQL Enterprise licences', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'sql-enterprise', licenceVcpus: 8, licenceVms: 2 },
      // SQL Server Enterprise licence row is per 8-vCPU VM-hour; multiply by VM count and host hours, separate from host compute.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'sql-enterprise', licenceVcpus: 8, licenceVms: 2 }),
    },
    {
      name: 'Dsv6 with RHEL SAP licences', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'rhel-sap', licenceVcpus: 4, licenceVms: 3 },
      // Red Hat Enterprise Linux for SAP with HA exposes a 4-vCPU VM hourly licence row; multiply by VM count and hours.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'rhel-sap', licenceVcpus: 4, licenceVms: 3 }),
    },
    {
      name: 'Dsv6 with SLES standard licences', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'sles-standard', licenceVcpus: 4, licenceVms: 2 },
      // SUSE Linux Enterprise Server Standard uses the 3-4 vCPU VM hourly support row for a 4-vCPU VM.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'sles-standard', licenceVcpus: 4, licenceVms: 2 }),
    },
    {
      name: 'Dsv6 with BizTalk Standard licences', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'biztalk-standard', licenceVcpus: 4, licenceVms: 1 },
      // BizTalk Server Standard exposes a 4-vCPU VM hourly licence row; multiply by VM count and hours.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'biztalk-standard', licenceVcpus: 4, licenceVms: 1 }),
    },
    {
      name: 'Dsv6 with Ubuntu Pro Essential', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'ubuntu-essential', licenceVcpus: 2, licenceVms: 3 },
      // Published Ubuntu Pro Essential support is a flat $0.009 per VM-hour; vCPU count selects the VM tier but does not multiply the support rate.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'ubuntu-essential', licenceVcpus: 2, licenceVms: 3 }),
    },
    {
      name: 'Dsv6 with Ubuntu Pro Standard', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'ubuntu-standard', licenceVcpus: 4, licenceVms: 2 },
      // Published Ubuntu Pro Standard support is a flat $0.029 per VM-hour; multiply only by VM count and hours.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'ubuntu-standard', licenceVcpus: 4, licenceVms: 2 }),
    },
    {
      name: 'Dsv6 with Ubuntu Pro Advanced', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'ubuntu-advanced', licenceVcpus: 8, licenceVms: 1 },
      // Published Ubuntu Pro Advanced support is a flat $0.057 per VM-hour; multiply only by VM count and hours.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'USD', series: 'Dsv6', hostType: 'Type 1', hosts: 1, licence: 'ubuntu-advanced', licenceVcpus: 8, licenceVms: 1 }),
    },
    {
      name: 'Fsv2 Type2 part-time hours', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'FSv2', hostType: 'Type2', hosts: 1, hours: 100 },
      // Fsv2 is now End of Life in the public questions and should be refused by the engine instead of priced.
      expectEngineError: /End of Life|older.*series|not priced/i,
    },
    {
      name: 'short-name Fs Type2 bypass refused', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Fs', hostType: 'Type2', hosts: 1 },
      // Short-name bypass for EOL FSv2/Fsv2 hosts should also be refused instead of mapping to the old Fsv2 Type2 price.
      expectEngineError: /End of Life|older.*series|not priced|No Dedicated Host priced/i,
    },
    {
      name: 'short-name D Type1 bypass refused', region: 'eastus2', currency: 'USD',
      component: { type: 'dedicated-host', series: 'D', hostType: 'Type1', hosts: 1 },
      // Short generic D-series input should not bypass supported-series validation and map to an arbitrary dedicated host family.
      expectEngineError: /End of Life|older.*series|not priced|No Dedicated Host priced|series/i,
    },
    {
      name: 'Dsv5 no-space DedicatedHost non-US region', region: 'westeurope', currency: 'USD',
      component: { type: 'dedicated-host', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1 },
      // Retail API West Europe Dsv5 no-space DedicatedHost hourly rate differs from East US 2.
      expected: async () => dedicatedHost({ region: 'westeurope', currency: 'USD', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1 }),
    },
    {
      name: 'Dsv5 EUR retail API', region: 'eastus2', currency: 'EUR',
      component: { type: 'dedicated-host', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1, hours: 100 },
      // Retail API EUR no-space Dsv5 DedicatedHost consumption row is hourly; calculator data is USD only.
      expected: async () => dedicatedHost({ region: 'eastus2', currency: 'EUR', series: 'Dsv5', hostType: 'Dsv5 Type1', hosts: 1, hours: 100 }),
    },
  ],
};
