'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'app-service';
const HOURS_PER_MONTH = 730;
const SIZES = ['i1v2','i1mv2','i2v2','i2mv2','i3v2','i3mv2','i4v2','i4mv2','i5v2','i5mv2','i6v2','i1v4','i1mv4','i2v4','i2mv4','i3v4','i3mv4','i4v4','i4mv4','i5v4','i5mv4','i6v4'];
const COMMIT = { payg: 'payg', ri1y: 'one-year', ri3y: 'three-year', sp1y: 'sv-one-year', sp3y: 'sv-three-year' };
const DEDICATED_VCPU = { i1v2: 2, i2v2: 4, i3v2: 8 };
function retailSku(size) { return size.replace(/^(i\d)(v\d)$/i, (_, a, b) => a.toUpperCase() + ' ' + b).replace(/^i/i, 'I'); }

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function offer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }
function gen(size) { return size.endsWith('v4') ? 'v4' : 'v2'; }
async function aseCalc({ region, os = 'windows', size = 'i1v2', instances = 1, deployment = 'standard', dedicatedHosts = 2, commitment = 'payg', hours = HOURS_PER_MONTH }) {
  const lines = [];
  const billHours = commitment === 'payg' ? hours : HOURS_PER_MONTH;
  const suffix = COMMIT[commitment];
  if (deployment === 'dedicated-host') {
    const appOffer = `${os}-isolated-v2-dedicated-host-${suffix}`;
    const hostOffer = `${os}-isolated-v2-dedicated-host-common-${suffix}`;
    const appRate = await offer(appOffer, region);
    const hostRate = await offer(hostOffer, region);
    const workerUnits = Math.max(instances, 0) * (DEDICATED_VCPU[size] || 1);
    lines.push(line(`dedicated host workers: ${Math.max(instances, 0)} instances * ${DEDICATED_VCPU[size] || 1} vCPU * ${billHours} hours * ${appRate}`, workerUnits * billHours * appRate, { sourceOffer: appOffer }));
    lines.push(line(`dedicated host common: ${dedicatedHosts} hosts * ${billHours} hours * ${hostRate}`, dedicatedHosts * billHours * hostRate, { sourceOffer: hostOffer }));
  } else {
    const billed = Math.max(instances, 1);
    const sourceOffer = `${os}-isolated-${gen(size)}-${size}-${suffix}`;
    const rate = await offer(sourceOffer, region);
    lines.push(line(`${size} ${os}: max(${instances}, 1) = ${billed} instances * ${billHours} hours * ${rate}`, billed * billHours * rate, { sourceOffer }));
  }
  return { monthlyList: totalOf(lines), lines };
}
async function aseRetail({ region, currency, os = 'windows', size = 'i1v2', instances = 1, hours = HOURS_PER_MONTH }) {
  const rows = dedupe(await query(`serviceName eq 'Azure App Service' and armRegionName eq '${region}' and skuName eq '${retailSku(size)}'`, currency));
  const product = os === 'linux' ? /Linux/ : /Isolated v\d Plan$/;
  const hits = rows.filter(r => product.test(r.productName) && r.type === 'Consumption');
  if (hits.length !== 1) throw new Error(`expected one ASE retail row for ${os} ${size}, found ${hits.length}`);
  const r = hits[0];
  const billed = Math.max(instances, 1);
  const lines = [line(`${size} ${os}: max(${instances}, 1) = ${billed} instances * ${hours} hours / ${unitSize(r.unitOfMeasure)} * ${r.retailPrice}`, billed * hours / unitSize(r.unitOfMeasure) * r.retailPrice, { meterId: r.meterId })];
  return { monthlyList: totalOf(lines), lines };
}

const sizeCases = SIZES.map(size => ({
  name: `size ${size} smoke`, region: 'eastus2', currency: 'USD',
  component: { type: 'app-service-environment', size, instances: 1, os: 'linux', deployment: 'standard', commitment: 'payg' },
  // Calculator App Service Isolated offer is an hourly per-worker price; one instance for 730 hours covers each size enum.
  expected: async () => aseCalc({ region: 'eastus2', os: 'linux', size, instances: 1 }),
}));

module.exports = {
  type: 'app-service-environment',
  source: 'both',
  cases: [
    {
      name: 'empty ASE bills one I1v2', region: 'eastus2', currency: 'USD',
      component: { type: 'app-service-environment', size: 'i1v2', instances: 0, os: 'windows', deployment: 'standard' },
      // Calculator windows-isolated-v2-i1v2-payg; an empty ASE v3 has a minimum charge of one I1v2 worker.
      expected: async () => aseCalc({ region: 'eastus2', os: 'windows', size: 'i1v2', instances: 0 }),
    },
    {
      name: 'i2v2 linux part-time payg', region: 'eastus2', currency: 'USD',
      component: { type: 'app-service-environment', size: 'i2v2', instances: 2, os: 'linux', deployment: 'standard', hours: 100 },
      // PAYG uses actual hours: 2 Linux I2v2 workers * 100 hours * calculator hourly offer.
      expected: async () => aseCalc({ region: 'eastus2', os: 'linux', size: 'i2v2', instances: 2, hours: 100 }),
    },
    {
      name: 'windows one year reservation', region: 'eastus2', currency: 'USD',
      component: { type: 'app-service-environment', size: 'i3v2', instances: 1, os: 'windows', deployment: 'standard', commitment: 'ri1y', hours: 10 },
      // Reservation offer is still billed for the full 730-hour month, not the entered PAYG hours.
      expected: async () => aseCalc({ region: 'eastus2', os: 'windows', size: 'i3v2', instances: 1, commitment: 'ri1y', hours: 10 }),
    },
    {
      name: 'linux three year reservation', region: 'eastus2', currency: 'USD',
      component: { type: 'app-service-environment', size: 'i4v2', instances: 1, os: 'linux', deployment: 'standard', commitment: 'ri3y' },
      // Calculator one-/three-year reservation offers are hourly effective rates over 730 hours/month.
      expected: async () => aseCalc({ region: 'eastus2', os: 'linux', size: 'i4v2', instances: 1, commitment: 'ri3y' }),
    },
    {
      name: 'windows one year savings plan', region: 'eastus2', currency: 'USD',
      component: { type: 'app-service-environment', size: 'i1v4', instances: 2, os: 'windows', deployment: 'standard', commitment: 'sp1y' },
      // Calculator sv-one-year offer gives the Azure savings-plan hourly rate for Isolated v4 workers.
      expected: async () => aseCalc({ region: 'eastus2', os: 'windows', size: 'i1v4', instances: 2, commitment: 'sp1y' }),
    },
    {
      name: 'linux three year savings plan west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'app-service-environment', size: 'i2mv4', instances: 1, os: 'linux', deployment: 'standard', commitment: 'sp3y' },
      // Non-US calculator region West Europe uses the sv-three-year Isolated v4 Linux offer.
      expected: async () => aseCalc({ region: 'westeurope', os: 'linux', size: 'i2mv4', instances: 1, commitment: 'sp3y' }),
    },
    {
      name: 'dedicated host two hosts', region: 'eastus2', currency: 'USD',
      component: { type: 'app-service-environment', size: 'i1v2', instances: 3, os: 'windows', deployment: 'dedicated-host', dedicatedHosts: 2 },
      // Dedicated Host adds per-worker dedicated-host offer plus the common host hourly charge per host.
      expected: async () => aseCalc({ region: 'eastus2', os: 'windows', size: 'i1v2', instances: 3, deployment: 'dedicated-host', dedicatedHosts: 2 }),
    },
    {
      name: 'i1v2 windows EUR retail', region: 'eastus2', currency: 'EUR',
      component: { type: 'app-service-environment', size: 'i1v2', instances: 1, os: 'windows', deployment: 'standard' },
      // EUR comes from Retail API because calculator data is USD-only.
      expected: async () => aseRetail({ region: 'eastus2', currency: 'EUR', os: 'windows', size: 'i1v2', instances: 1 }),
    },
    ...sizeCases,
  ],
};
