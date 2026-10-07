'use strict';

const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');

const HOURS_PER_MONTH = 730;
const SLUG = 'nutanix-on-azure';
const NODE_OFFER = { an36: 'nodes-for-nutanix-an36', an36p: 'nodes-for-nutanix-an36p', an64: 'nodes-for-nutanix-an64' };
const PRICE_KEY = { payg: 'perhour', 'reservation-1y': 'perhouroneyearreserved', 'reservation-3y': 'perhourthreeyearreserved' };
const TERM_MONTHS = { 'reservation-1y': 12, 'reservation-3y': 36 };
const SKU_BY_NODE = { an36: 'ANRN36', an36p: 'ANRN36P', an64: 'AN64' };
const METER_BY_NODE = { an36: 'AN36', an36p: 'AN36P', an64: 'AN64' };
let v3Cache;

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Nutanix row for ${what}, found ${hits.length}`);
  return hits[0];
}
async function calculatorV3Product() {
  if (v3Cache) return v3Cache;
  const res = await fetch(`https://azure.microsoft.com/api/v3/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`calculator v3 ${SLUG} HTTP ${res.status}`);
  v3Cache = await res.json();
  return v3Cache;
}
async function calculatorNutanix({ region, nodes, nodeType, hours = HOURS_PER_MONTH, commitment = 'payg' }) {
  const data = await calculatorV3Product();
  const calcRegion = calc.calcRegion(data, region);
  const offer = NODE_OFFER[nodeType];
  const key = PRICE_KEY[commitment];
  const priceObj = data.offers[offer] && data.offers[offer].prices[key] && data.offers[offer].prices[key][calcRegion];
  if (!priceObj) throw new Error(`calculator v3 has no ${offer}/${key} price for ${calcRegion}`);
  const price = priceObj.value;
  let monthly;
  let desc;
  if (commitment === 'payg') {
    monthly = nodes * hours * price;
    desc = `calculator v3 ${offer} ${key}: ${nodes} nodes * ${hours} hours * ${price}`;
  } else {
    monthly = nodes * price / TERM_MONTHS[commitment];
    desc = `calculator v3 ${offer} ${key}: ${nodes} nodes * whole-term ${price} / ${TERM_MONTHS[commitment]} months`;
  }
  const lines = [line(desc, monthly, { sourceOffer: offer, priceKey: key })];
  return { monthlyList: totalOf(lines), lines };
}
async function retailNutanix({ region, currency, nodes, nodeType, hours = HOURS_PER_MONTH }) {
  const rows = dedupe(await query(`productName eq 'Ready Nodes for Nutanix' and armRegionName eq '${region}'`, currency));
  const sku = SKU_BY_NODE[nodeType];
  const meterName = METER_BY_NODE[nodeType];
  const meter = pickOne(rows, r => r.skuName === sku && r.meterName === meterName && r.type === 'Consumption' && r.retailPrice > 0, `${meterName} consumption`);
  const lines = [line(`${meterName} payg: ${nodes} nodes * ${hours} hours * ${meter.retailPrice}`, nodes * hours * meter.retailPrice, { meterId: meter.meterId })];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'nutanix-nc2',
  source: 'both',
  cases: [
    {
      name: 'default AN36P pay-as-you-go', region: 'eastus2', currency: 'USD',
      component: { type: 'nutanix-nc2', nodes: 3 },
      // Current public questions default nodeType to an36p; calculator v3 nodes-for-nutanix-an36p perhour price applies.
      expected: async () => calculatorNutanix({ region: 'eastus2', nodeType: 'an36p', nodes: 3 }),
    },
    {
      name: 'AN36 pay-as-you-go minimum cluster', region: 'eastus', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an36', nodes: 3 },
      // Calculator v3 nodes-for-nutanix-an36 perhour price is hourly; eastus has AN36 PAYG pricing.
      expected: async () => calculatorNutanix({ region: 'eastus', nodeType: 'an36', nodes: 3 }),
    },
    {
      name: 'AN36P pay-as-you-go eastus2', region: 'eastus2', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an36p', nodes: 3 },
      // Calculator v3 nodes-for-nutanix-an36p perhour price is hourly; 730 hours for an all-month cluster.
      expected: async () => calculatorNutanix({ region: 'eastus2', nodeType: 'an36p', nodes: 3 }),
    },
    {
      name: 'AN64 pay-as-you-go', region: 'eastus', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an64', nodes: 4 },
      // Calculator v3 nodes-for-nutanix-an64 perhour price is hourly; four nodes cover the AN64 SKU enum.
      expected: async () => calculatorNutanix({ region: 'eastus', nodeType: 'an64', nodes: 4 }),
    },
    {
      name: 'AN36P one year reservation from calculator v3', region: 'eastus2', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an36p', nodes: 3, commitment: 'reservation-1y' },
      // Calculator v3 perhouroneyearreserved is the whole-term reserved node price; reservations ignore component hours and divide the whole-term price by 12 months.
      expected: async () => calculatorNutanix({ region: 'eastus2', nodeType: 'an36p', nodes: 3, commitment: 'reservation-1y' }),
    },
    {
      name: 'AN64 one year reservation from calculator v3', region: 'eastus', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an64', nodes: 3, commitment: 'reservation-1y' },
      // Calculator v3 perhouroneyearreserved is the AN64 whole-term reserved node price; monthly cost divides by the term months.
      expected: async () => calculatorNutanix({ region: 'eastus', nodeType: 'an64', nodes: 3, commitment: 'reservation-1y' }),
    },
    {
      name: 'AN64 three year reservation from calculator v3', region: 'eastus', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an64', nodes: 3, commitment: 'reservation-3y' },
      // Calculator v3 perhourthreeyearreserved is the AN64 whole-term reserved node price; monthly cost divides by the term months.
      expected: async () => calculatorNutanix({ region: 'eastus', nodeType: 'an64', nodes: 3, commitment: 'reservation-3y' }),
    },
    {
      name: 'AN36P zero hours pay-as-you-go', region: 'eastus2', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an36p', nodes: 3, hours: 0 },
      // Calculator v3 PAYG is hourly, so zero provisioned hours should produce zero node cost.
      expected: async () => calculatorNutanix({ region: 'eastus2', nodeType: 'an36p', nodes: 3, hours: 0 }),
    },
    {
      name: 'AN36P 28 node maximum', region: 'eastus2', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an36p', nodes: 28 },
      // Current public questions cap Nutanix clusters at 28 nodes; calculator v3 perhour price applies to each node.
      expected: async () => calculatorNutanix({ region: 'eastus2', nodeType: 'an36p', nodes: 28 }),
    },
    {
      name: 'AN36P part-time hours', region: 'eastus2', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an36p', nodes: 3, hours: 100 },
      // Calculator v3 PAYG meter is hourly; part-time case multiplies by component hours instead of 730.
      expected: async () => calculatorNutanix({ region: 'eastus2', nodeType: 'an36p', nodes: 3, hours: 100 }),
    },
    {
      name: 'AN36P west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'nutanix-nc2', nodeType: 'an36p', nodes: 3 },
      // Calculator v3 West Europe AN36P hourly rate differs from East US 2.
      expected: async () => calculatorNutanix({ region: 'westeurope', nodeType: 'an36p', nodes: 3 }),
    },
    {
      name: 'AN36P EUR retail API', region: 'eastus2', currency: 'EUR',
      component: { type: 'nutanix-nc2', nodeType: 'an36p', nodes: 3, hours: 100 },
      // Retail API EUR row for AN36P is hourly; calculator v3 data is USD only.
      expected: async () => retailNutanix({ region: 'eastus2', currency: 'EUR', nodeType: 'an36p', nodes: 3, hours: 100 }),
    },
  ],
};
