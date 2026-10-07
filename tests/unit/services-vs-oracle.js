'use strict';
// Engine vs independent per-service oracles (tests/oracle/services/<type>.js).
// Each oracle file:
//   module.exports = { type: '<component type>', source: 'calculator' | 'retail-api' | 'both',
//     cases: [ { name, region, currency?, component: { type, ...engine fields },
//                expected: async () => ({ monthlyList, lines: [ { desc, monthlyList } ] }) } ] };
// Oracles are written separately from the engine and must not require anything under scripts/.
// usage: node tests/unit/services-vs-oracle.js [type,type,...]
const fs = require('fs');
const path = require('path');
const { priceSpec } = require('../../scripts/lib/estimate');
const SERVICES = require('../../scripts/lib/services');

const only = (process.argv[2] || '').split(',').filter(Boolean);
const dir = path.join(__dirname, '..', 'oracle', 'services');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('_')).sort() : [];

(async () => {
  let pass = 0; const fails = []; const covered = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/require\([^)]*scripts[\\/]/.test(src)) { fails.push(`${f}: oracle must not require engine code`); continue; }
    const O = require(path.join(dir, f));
    if (only.length && !only.includes(O.type)) continue;
    covered.add(O.type);
    for (const c of O.cases || []) {
      const name = `${O.type} | ${c.name}`;
      // Region and currency belong to the spec, not the component. Some oracle helpers spread
      // them into the component too; drop them only when they match the case-level values.
      if (c.component) {
        const comp = { ...c.component };
        if (comp.region != null && comp.region === c.region) delete comp.region;
        if (comp.currency != null && comp.currency === (c.currency || 'USD')) delete comp.currency;
        c.component = comp;
      }
      try {
        if (c.expectEngineError) {
          const est = await priceSpec({ region: c.region, currency: c.currency || 'USD', discountPct: 0, options: [{ name: 'x', components: [c.component] }] });
          const o = est.options[0];
          const errors = o.errors.join('; ');
          const re = c.expectEngineError instanceof RegExp ? c.expectEngineError : new RegExp(String(c.expectEngineError), 'i');
          if (o.errors.length && re.test(errors)) pass++;
          else fails.push(`${name}: expected engine error ${re}, got ${o.errors.length ? errors : `priced ${o.totalList}`}`);
          continue;
        }
        const [want, est] = await Promise.all([c.expected(), priceSpec({ region: c.region, currency: c.currency || 'USD', discountPct: 0, options: [{ name: 'x', components: [c.component] }] })]);
        const o = est.options[0];
        if (o.errors.length) { fails.push(`${name}: engine error ${o.errors.join('; ')}`); continue; }
        const nLines = Math.max(o.lines.length, (want.lines || []).length, 1);
        const tol = 0.011 + 0.005 * nLines;
        const diff = Math.round((o.totalList - want.monthlyList) * 100) / 100;
        if (Math.abs(o.totalList - want.monthlyList) <= tol) pass++;
        else fails.push(`${name}: engine ${o.totalList} vs oracle ${want.monthlyList} (diff ${diff})\n    engine: ${o.lines.map(l => `${l.desc}=${l.list}`).join(' | ')}\n    oracle: ${(want.lines || []).map(l => `${l.desc}=${l.monthlyList}`).join(' | ')}`);
      } catch (e) { fails.push(`${name}: ${e.message}`); }
    }
  }
  const missing = Object.keys(SERVICES).filter(t => !covered.has(t) && (!only.length || only.includes(t)));
  missing.forEach(t => fails.push(`${t}: no oracle (tests/oracle/services/${t}.js)`));
  console.log(`services vs oracle: ${pass} pass, ${fails.length} fail`);
  fails.forEach(f => console.log('FAIL ' + f));
  if (fails.length) process.exitCode = 1;
})();
