'use strict';
// Every declarative rule must fire on its positive spec and stay silent on its negative spec.
// Tests live in rule-tests.json and rule-tests/<type>.json ({ "rules": { id: { test: { fires, silent } } } }).
// usage: node tests/unit/rule-tests.js
const fs = require('fs');
const path = require('path');
const { priceSpec } = require('../../scripts/lib/estimate');
const { advise, rulebook } = require('../../scripts/lib/advisor');
const T = Object.assign({}, require('./rule-tests.json').rules);
const dir = path.join(__dirname, 'rule-tests');
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) Object.assign(T, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rules);
(async () => {
  let pass = 0; const fails = [];
  const rb = rulebook();
  if (rb.rejected.length) rb.rejected.forEach(r => fails.push('REJECTED ' + r));
  // Every service rule (catalog/rules/*.json) must have a test.
  const sdir = path.join(__dirname, '..', '..', 'catalog', 'rules');
  if (fs.existsSync(sdir)) for (const f of fs.readdirSync(sdir).filter(f => f.endsWith('.json'))) for (const id of Object.keys(JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')).rules || {})) if (!T[id]) fails.push(`${id}: no fire/silent test (catalog/rules/${f})`);
  for (const [id, r] of Object.entries(T)) {
    const res = {};
    for (const k of ['fires', 'silent']) {
      const est = await priceSpec(Object.assign({ currency: 'USD', discountPct: 0 }, r.test[k]));
      const errs = est.options.flatMap(o => o.errors);
      if (errs.length) fails.push(`${id} (${k}): pricing error ${errs.join('; ')}`);
      res[k] = advise(est).some(a => a.id === id);
    }
    if (res.fires && !res.silent) pass++; else fails.push(`${id}: fires=${res.fires} silent=${res.silent}`);
  }
  console.log(`rule tests: ${pass} pass, ${fails.length} fail`);
  fails.forEach(f => console.log('FAIL ' + f));
  if (fails.length) process.exitCode = 1;
})();
