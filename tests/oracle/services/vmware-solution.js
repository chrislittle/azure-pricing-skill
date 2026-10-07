'use strict';

const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'azure-vmware';
const HOURS_PER_MONTH = 730;
const SKU_BY_HOST = { av36: 'AV36 VCF BYOL', av36p: 'AV36P VCF BYOL', av48: 'AV48 VCF BYOL', av52: 'AV52 VCF BYOL', av64: 'AV64 VCF BYOL' };

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calculatorOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }
function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Azure VMware row for ${what}, found ${hits.length}`);
  return hits[0];
}
async function calculatorAvs({ region, nodes, hostType, hours = HOURS_PER_MONTH, commitment = 'payg' }) {
  const offer = commitment === 'payg' ? `${hostType}-payg` : `${hostType}-${commitment === 'reservation-1y' ? 'one-year' : 'three-year'}`;
  const price = await calculatorOffer(offer, region);
  const lines = [line(`calculator ${offer}: ${nodes} nodes * ${hours} hours * ${price}`, nodes * hours * price, { sourceOffer: offer })];
  return { monthlyList: totalOf(lines), lines };
}
async function retailAvsPayg({ region, currency, nodes, hostType, hours = HOURS_PER_MONTH }) {
  const rows = dedupe(await query(`contains(productName, 'Azure VMware') and armRegionName eq '${region}'`, currency));
  const sku = SKU_BY_HOST[hostType];
  const meter = pickOne(rows, r => r.skuName === sku && r.type === 'Consumption' && r.retailPrice > 0, `${sku} consumption`);
  const lines = [line(`${sku} payg: ${nodes} nodes * ${hours} hours * ${meter.retailPrice}`, nodes * hours * meter.retailPrice, { meterId: meter.meterId })];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'vmware-solution',
  source: 'both',
  cases: [
    {
      name: 'default AV36P pay-as-you-go', region: 'eastus2', currency: 'USD',
      component: { type: 'vmware-solution', nodes: 3 },
      // Current public questions default hostType to av36p; calculator av36p-payg is the hourly node price.
      expected: async () => calculatorAvs({ region: 'eastus2', hostType: 'av36p', nodes: 3 }),
    },
    {
      name: 'AV36 pay-as-you-go minimum cluster', region: 'eastus2', currency: 'USD',
      component: { type: 'vmware-solution', hostType: 'av36', nodes: 3 },
      // Calculator av36-payg is an hourly node price; Azure VMware Solution minimum cluster is 3 nodes.
      expected: async () => calculatorAvs({ region: 'eastus2', hostType: 'av36', nodes: 3 }),
    },
    {
      name: 'AV36P one year reservation from calculator', region: 'eastus2', currency: 'USD',
      component: { type: 'vmware-solution', hostType: 'av36p', nodes: 3, commitment: 'reservation-1y' },
      // Calculator av36p-one-year is the reserved hourly node price; monthly cost uses 730 hours per reserved node.
      expected: async () => calculatorAvs({ region: 'eastus2', hostType: 'av36p', nodes: 3, commitment: 'reservation-1y' }),
    },
    {
      name: 'AV48 three year reservation from calculator', region: 'eastus2', currency: 'USD',
      component: { type: 'vmware-solution', hostType: 'av48', nodes: 4, commitment: 'reservation-3y' },
      // Calculator av48-three-year is the reserved hourly node price; monthly cost uses 730 hours per reserved node.
      expected: async () => calculatorAvs({ region: 'eastus2', hostType: 'av48', nodes: 4, commitment: 'reservation-3y' }),
    },
    {
      name: 'AV52 part-time pay-as-you-go', region: 'eastus2', currency: 'USD',
      component: { type: 'vmware-solution', hostType: 'av52', nodes: 3, hours: 100 },
      // Calculator av52-payg is hourly; this case verifies component hours are used for PAYG.
      expected: async () => calculatorAvs({ region: 'eastus2', hostType: 'av52', nodes: 3, hours: 100 }),
    },
    {
      name: 'AV52 one year reservation from calculator', region: 'eastus2', currency: 'USD',
      component: { type: 'vmware-solution', hostType: 'av52', nodes: 3, commitment: 'reservation-1y' },
      // Calculator av52-one-year is the reserved hourly node price; av52 does not expose a 3-year offer in calculator data.
      expected: async () => calculatorAvs({ region: 'eastus2', hostType: 'av52', nodes: 3, commitment: 'reservation-1y' }),
    },
    {
      name: 'AV64 one year reservation from calculator', region: 'eastus2', currency: 'USD',
      component: { type: 'vmware-solution', hostType: 'av64', nodes: 3, commitment: 'reservation-1y' },
      // Calculator av64-one-year is the reserved hourly node price; monthly cost uses 730 hours per reserved node.
      expected: async () => calculatorAvs({ region: 'eastus2', hostType: 'av64', nodes: 3, commitment: 'reservation-1y' }),
    },
    {
      name: 'AV64 three year reservation from calculator', region: 'eastus2', currency: 'USD',
      component: { type: 'vmware-solution', hostType: 'av64', nodes: 3, commitment: 'reservation-3y' },
      // Calculator av64-three-year is the reserved hourly node price; monthly cost uses 730 hours per reserved node.
      expected: async () => calculatorAvs({ region: 'eastus2', hostType: 'av64', nodes: 3, commitment: 'reservation-3y' }),
    },
    {
      name: 'AV36P chile central pay-as-you-go', region: 'chilecentral', currency: 'USD',
      component: { type: 'vmware-solution', hostType: 'av36p', nodes: 3 },
      // Calculator Chile Central exposes AV36P pay-as-you-go pricing and differs from East US 2.
      expected: async () => calculatorAvs({ region: 'chilecentral', hostType: 'av36p', nodes: 3 }),
    },
    {
      name: 'AV36P EUR retail API pay-as-you-go', region: 'eastus2', currency: 'EUR',
      component: { type: 'vmware-solution', hostType: 'av36p', nodes: 3, hours: 100 },
      // Retail API EUR row for AV36P VCF BYOL node is hourly; calculator data is USD only.
      expected: async () => retailAvsPayg({ region: 'eastus2', currency: 'EUR', hostType: 'av36p', nodes: 3, hours: 100 }),
    },
  ],
};
