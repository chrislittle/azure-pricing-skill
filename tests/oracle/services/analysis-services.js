'use strict';

const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'analysis-services';
const HOURS = 730;
const OFFER = { developer: 'developer', b1: 'b1', b2: 'b2', s0: 's0', s1: 's1', s2: 's2', s4: 's4', s8: 's8', 's8-v2': 's8v2', s9: 's9', 's9-v2': 's9v2' };
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function offer(name, region) { return (await calc.offerPrice(SLUG, name, region)).value; }
async function rows(region, currency) { return dedupe(await query(`serviceName eq 'Azure Analysis Services' and armRegionName eq '${region}'`, currency)); }
async function aas({ region, currency = 'USD', tier, instances = 1, hours = HOURS, queryReplicas = 0, replicaHours = HOURS }) {
  const lines = [];
  const calcName = OFFER[tier];
  if (currency === 'USD' && !['s8', 's9'].includes(tier)) {
    const p = await offer(calcName, region);
    lines.push(line(`${tier} servers: ${instances} * ${hours} hours * ${p}`, instances * hours * p, { sourceOffer: calcName }));
    if (queryReplicas) {
      const so = `scaleout-${calcName}`; const sp = await offer(so, region);
      lines.push(line(`${tier} query replicas: ${queryReplicas} * ${replicaHours} hours * ${sp}`, queryReplicas * replicaHours * sp, { sourceOffer: so }));
    }
  } else {
    const rs = await rows(region, currency);
    const sku = tier.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase()).replace('V2', 'v2');
    const m = rs.find(r => r.skuName.toLowerCase() === sku.toLowerCase() && !/Scale-Out/i.test(r.skuName));
    if (!m) throw new Error(`no ${currency} retail row for ${tier}`);
    lines.push(line(`${currency} ${sku} servers: ${instances} * ${hours} * ${m.retailPrice}`, instances * hours * m.retailPrice, { meterId: m.meterId }));
    if (queryReplicas) {
      const sm = rs.find(r => r.skuName.toLowerCase() === `${sku} Scale-Out`.toLowerCase());
      lines.push(line(`${currency} ${sku} scale-out replicas: ${queryReplicas} * ${replicaHours} * ${sm.retailPrice}`, queryReplicas * replicaHours * sm.retailPrice, { meterId: sm.meterId }));
    }
  }
  return { monthlyList: totalOf(lines), lines };
}
function c(tier, extra = {}) {
  return { name: `${tier} tier`, region: extra.region || 'eastus2', currency: extra.currency || 'USD', component: { type: 'analysis-services', tier, instances: extra.instances || 1, hours: extra.hours || HOURS, queryReplicas: extra.queryReplicas || 0, replicaHours: extra.replicaHours || HOURS },
    // Calculator/Retail hourly server rate times instances and runtime; Standard scale-out replicas use matching scale-out offer/meter.
    expected: async () => aas({ region: extra.region || 'eastus2', currency: extra.currency || 'USD', tier, instances: extra.instances || 1, hours: extra.hours || HOURS, queryReplicas: extra.queryReplicas || 0, replicaHours: extra.replicaHours || HOURS }) };
}
module.exports = { type: 'analysis-services', source: 'both', cases: [
  c('developer', { hours: 100 }), c('b1'), c('b2'), c('s0'), c('s1'), c('s2'), c('s4'), c('s8'), c('s8-v2'), c('s9'), c('s9-v2'),
  { name: 's1 query replicas part time', region: 'eastus2', currency: 'USD', component: { type: 'analysis-services', tier: 's1', instances: 1, hours: 730, queryReplicas: 2, replicaHours: 100 },
    // Calculator S1 server offer plus scaleout-s1 for each replica-hour.
    expected: async () => aas({ region: 'eastus2', tier: 's1', queryReplicas: 2, replicaHours: 100 }) },
  c('s2', { region: 'westeurope', instances: 2, hours: 220 }),
  { name: 'EUR retail west europe s1 replica', region: 'westeurope', currency: 'EUR', component: { type: 'analysis-services', tier: 's1', instances: 1, hours: 200, queryReplicas: 1, replicaHours: 50 },
    // Retail API EUR S1 and S1 Scale-Out meters are both per hour.
    expected: async () => aas({ region: 'westeurope', currency: 'EUR', tier: 's1', hours: 200, queryReplicas: 1, replicaHours: 50 }) },
] };
