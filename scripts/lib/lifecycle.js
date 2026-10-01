'use strict';
// VM size lifecycle. Only Current and Extended series are priced. Series on Microsoft's End of Life
// list, or already retired, are refused. Source pages are recorded in catalog.json (vmLifecycle).
const catalog = require('../../catalog/catalog.json');
const L = catalog.vmLifecycle;
const RULES = L.endOfLife.map(x => ({ series: x.series, stage: x.stage || 'End of Life', re: new RegExp(x.pattern) }));
const RETIRE_2029 = new RegExp(L.retire2029Pattern);

function lifecycle(sku) {
  const r = RULES.find(x => x.re.test(String(sku || '')));
  if (!r) return { modern: true };
  return { modern: false, series: r.series, stage: r.stage, retires2029: RETIRE_2029.test(sku) };
}

function explain(sku) {
  const l = lifecycle(sku);
  if (l.modern) return null;
  return `${sku} is in the ${l.series} series, which Microsoft lists as ${l.stage === 'Retired' ? 'retired' : 'End of Life (retirement announced)'}. This skill prices only Current and Extended sizes, which Microsoft describes as fully supported. ${l.stage === 'Retired' ? 'Retired sizes can no longer be created or run.' : 'End of Life series have restrictions when you deploy through new subscriptions, and you cannot get more quota for series with capacity growth restrictions.'}${l.retires2029 ? ' The Dv3, Dsv3, Ev3 and Esv3 series retire on November 15, 2029.' : ''} References: ${L.overview} and ${L.restrictions}`;
}

module.exports = { lifecycle, explain };
