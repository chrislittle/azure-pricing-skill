'use strict';
// Contract checks for every service module (scripts/lib/services/*.js):
// schema shape, readback, question plan, and that every example prices cleanly in two regions
// with lines that carry a real meter and add up.
// usage: node tests/unit/services-contract.js [type,type,...]
const { priceSpec } = require('../../scripts/lib/estimate');
const { readback } = require('../../scripts/lib/readback');
const { validateSpec } = require('../../scripts/lib/schema');
const SERVICES = require('../../scripts/lib/services');

const only = (process.argv[2] || '').split(',').filter(Boolean);
const REGIONS = ['eastus2', 'westeurope'];

(async () => {
  let pass = 0; const fails = [];
  for (const [t, s] of Object.entries(SERVICES)) {
    if (only.length && !only.includes(t)) continue;
    const bad = m => fails.push(`${t}: ${m}`);
    if (!Array.isArray(s.calculator) || !s.calculator.length) bad('calculator slug list is empty');
    if (!Array.isArray(s.keywords) || s.keywords.length < 2) bad('needs at least 2 keywords');
    for (const [k, f] of Object.entries(s.fields)) {
      if (f.enum && f.def != null && !f.enum.includes(f.def)) bad(`field ${k}: default not in enum`);
      if (!f.ask && !f.internal && f.def == null) bad(`field ${k}: no ask and no default`);
    }
    if (!s.examples.length) bad('no examples');
    for (const ex of s.examples) {
      if (ex.type !== t) { bad(`example type ${ex.type}`); continue; }
      const R = s.testRegions || REGIONS;
      const spec = { region: R[0], discountPct: 0, customerSaid: { region: require('../../catalog/regions.json')[R[0]], discount: 'none', requirements: 'example' }, options: [{ name: 'x', components: [ex] }] };
      const verrs = validateSpec(spec, { confirm: false }).filter(e => !/customerSaid|never|conversation/.test(e));
      if (verrs.length) { bad(`example fails spec validation: ${verrs.join('; ')}`); continue; }
      let rb;
      try { rb = readback(spec); } catch (e) { bad(`readback throws: ${e.message}`); continue; }
      const rl = rb.text.split('\n').find(l => l.startsWith('  - ')) || '';
      if (!rl || /undefined|NaN|\[object/.test(rb.text)) bad(`readback line is empty or broken: "${rl}"`);
      for (const [k, f] of Object.entries(s.fields)) if (f.req && typeof ex[k] === 'number' && ex[k] !== 0 && !rb.text.includes(Number(ex[k]).toLocaleString('en-US'))) bad(`readback does not show required quantity ${k}=${ex[k]}`);
      for (const region of R) {
        try {
          const est = await priceSpec(Object.assign({}, spec, { region }));
          const o = est.options[0];
          if (o.errors.length) { bad(`${region}: ${o.errors.join('; ')}`); continue; }
          if (!o.lines.length) { bad(`${region}: no lines`); continue; }
          for (const l of o.lines) {
            if (!l.meter || !l.meter.meterId) bad(`${region}: line "${l.desc}" has no meter`);
            if (!Number.isFinite(l.list) || l.list < 0) bad(`${region}: line "${l.desc}" list=${l.list}`);
            if (!l.group || !l.service || !l.desc) bad(`${region}: line missing group/service/desc`);
          }
          if (o.totalList <= 0 && !s.mayBeZero) bad(`${region}: total is 0`);
          pass++;
        } catch (e) { bad(`${region}: ${e.message}`); }
      }
    }
  }
  console.log(`services contract: ${pass} pass, ${fails.length} fail`);
  fails.forEach(f => console.log('FAIL ' + f));
  if (fails.length) process.exitCode = 1;
})();
