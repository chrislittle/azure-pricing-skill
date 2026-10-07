'use strict';

const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'power-bi-embedded';
const HOURS = 730;
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function offer(size, region) { return (await calc.offerPrice(SLUG, size, region)).value; }
async function rows(region, currency) { return dedupe(await query(`serviceName eq 'Power BI Embedded' and armRegionName eq '${region}'`, currency)); }
async function pbi({ region, currency = 'USD', size, nodes = 1, hours = HOURS }) {
  let price, extra;
  if (currency === 'USD') { price = await offer(size, region); extra = { sourceOffer: size }; }
  else {
    const rs = await rows(region, currency);
    const m = rs.find(r => r.skuName.toLowerCase() === size && r.meterName === `${size.toUpperCase()} Node`);
    if (!m) throw new Error(`no ${currency} retail row for ${size}`);
    price = m.retailPrice; extra = { meterId: m.meterId };
  }
  const lines = [line(`${currency} ${size.toUpperCase()} nodes: ${nodes} * ${hours} hours * ${price}`, nodes * hours * price, extra)];
  return { monthlyList: totalOf(lines), lines };
}
function c(size, extra = {}) {
  return { name: `${size} capacity`, region: extra.region || 'eastus2', currency: extra.currency || 'USD', component: { type: 'power-bi-embedded', size, viewers: extra.viewers || 'customers', nodes: extra.nodes || 1, hours: extra.hours || HOURS },
    // Calculator/Retail hourly node rate times node count and running hours.
    expected: async () => pbi({ region: extra.region || 'eastus2', currency: extra.currency || 'USD', size, nodes: extra.nodes || 1, hours: extra.hours || HOURS }) };
}
module.exports = { type: 'power-bi-embedded', source: 'both', cases: [
  c('a1'), c('a2', { hours: 220 }), c('a3'), c('a4'), c('a5'), c('a6'),
  { name: 'a7 germany north regional capacity', region: 'germanynorth', currency: 'USD', component: { type: 'power-bi-embedded', size: 'a7', viewers: 'customers', nodes: 1, hours: 100 },
    // Calculator exposes A7 only in selected regions; Germany North has an A7 hourly calculator offer.
    expected: async () => pbi({ region: 'germanynorth', size: 'a7', hours: 100 }) },
  { name: 'a8 germany north regional capacity', region: 'germanynorth', currency: 'USD', component: { type: 'power-bi-embedded', size: 'a8', viewers: 'customers', nodes: 1, hours: 10 },
    // Calculator exposes A8 only in selected regions; Germany North has an A8 hourly calculator offer.
    expected: async () => pbi({ region: 'germanynorth', size: 'a8', hours: 10 }) },
  c('a1', { region: 'westeurope', nodes: 2, hours: 200 }),
  { name: 'EUR retail west europe a2', region: 'westeurope', currency: 'EUR', component: { type: 'power-bi-embedded', size: 'a2', viewers: 'customers', nodes: 2, hours: 200 },
    // Retail API EUR A2 Node meter is per node-hour.
    expected: async () => pbi({ region: 'westeurope', currency: 'EUR', size: 'a2', nodes: 2, hours: 200 }) },
] };
