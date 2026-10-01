'use strict';
// Verifies candidate advisor rules before they are merged into catalog/rules.json.
// usage: node tests/unit/verify-candidates.js research/curated-<group>.json
// Each rule needs: level, title, body, citation{framework,code,source,url,quote}, when, and
// test{ fires: <spec>, silent: <spec> } where each spec is a full engine spec (region, discountPct,
// context, options[].components). The rule must fire on "fires" and not on "silent".
const fs = require('fs');
const path = require('path');
const { citationErrors, whenHolds } = require('../../scripts/lib/advisor');
const { checkCitations } = require('../../scripts/lib/validate');
const { priceSpec } = require('../../scripts/lib/estimate');
const existing = require('../../catalog/rules.json').rules;

(async () => {
  const file = process.argv[2];
  const cand = JSON.parse(fs.readFileSync(file, 'utf8')).rules || {};
  const out = [];
  const cites = await checkCitations(Object.entries(cand).map(([id, r]) => ({ id, url: r.citation && r.citation.url, quote: r.citation && r.citation.quote })));
  for (const [id, r] of Object.entries(cand)) {
    const errs = [];
    if (existing[id]) errs.push('id already exists in rules.json');
    errs.push(...citationErrors(id, r));
    if (!r.when) errs.push('missing "when" (declarative condition)');
    const c = cites.results.find(x => x.id === id);
    if (!c || c.status !== 200) errs.push(`citation url status ${c && c.status}`);
    else if (!c.quoteFound) errs.push('quote not found verbatim on the page');
    if (r.when && !errs.some(e => /operator|context field|component type|where path|scope/.test(e))) {
      for (const [kind, want] of [['fires', true], ['silent', false]]) {
        const spec = r.test && r.test[kind];
        if (!spec) { errs.push(`missing test.${kind} spec`); continue; }
        try {
          const est = await priceSpec(Object.assign({ currency: 'USD', discountPct: 0 }, spec));
          const bad = est.options.flatMap(o => o.errors.map(e => `${o.name}: ${e}`));
          if (bad.length) { errs.push(`test.${kind} spec failed to price: ${bad.join('; ').slice(0, 200)}`); continue; }
          const got = r.when.scope === 'estimate' ? whenHolds(r.when, est, null) : est.options.some(o => whenHolds(r.when, est, o));
          if (got !== want) errs.push(`test.${kind}: rule ${got ? 'fired' : 'did not fire'}`);
        } catch (e) { errs.push(`test.${kind} error: ${e.message}`); }
      }
    }
    out.push({ id, ok: !errs.length, errs });
  }
  const pass = out.filter(x => x.ok).length;
  fs.writeFileSync(file.replace(/\.json$/, '.verify.json'), JSON.stringify({ pass, fail: out.length - pass, results: out }, null, 2));
  console.log(`${pass} pass, ${out.length - pass} fail`);
  for (const x of out.filter(x => !x.ok)) console.log(`FAIL ${x.id}: ${x.errs.join(' | ')}`);
})();
