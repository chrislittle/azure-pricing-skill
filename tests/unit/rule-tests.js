'use strict';
// Every declarative rule must fire on its positive spec and stay silent on its negative spec.
// usage: node tests/unit/rule-tests.js
const { priceSpec } = require('../../scripts/lib/estimate');
const { advise } = require('../../scripts/lib/advisor');
const T = require('./rule-tests.json').rules;
(async () => {
  let pass = 0; const fails = [];
  for (const [id, r] of Object.entries(T)) {
    const res = {};
    for (const k of ['fires', 'silent']) {
      const est = await priceSpec(Object.assign({ currency: 'USD', discountPct: 0 }, r.test[k]));
      res[k] = advise(est).some(a => a.id === id);
    }
    if (res.fires && !res.silent) pass++; else fails.push(`${id}: fires=${res.fires} silent=${res.silent}`);
  }
  console.log(`rule tests: ${pass} pass, ${fails.length} fail`);
  fails.forEach(f => console.log('FAIL ' + f));
})();
