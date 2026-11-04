'use strict';
// Spec expansion: built-in comparisons the engine generates itself, so a model cannot drop one.
// spec.compare = { commitments: true }  -> every option with pay-as-you-go VMs gets 1- and 3-year
// reservation and savings plan variants alongside it.
const TERMS = [['ri1y', '1-year reservation'], ['ri3y', '3-year reservation'], ['sp1y', '1-year savings plan'], ['sp3y', '3-year savings plan']];
const BILLING = Object.fromEntries([['payg', 'Pay-as-you-go'], ...TERMS]);

function purchasing(components) {
  const terms = [...new Set((components || []).map(c => c.commitment || 'payg'))];
  if (!terms.length) return BILLING.payg;
  return terms.map(t => BILLING[t] || String(t)).join(' + ');
}

function expandSpec(spec) {
  if (!spec || spec._expanded) return spec;
  const out = JSON.parse(JSON.stringify(spec));
  const opts = [];
  for (const [i, original] of (out.options || []).entries()) {
    const name = original.name || original.phase || (out.options.length === 1 ? 'Estimate' : `Estimate ${i + 1}`);
    const o = Object.assign({}, original, { name, scenario: { id: `estimate-${i + 1}`, name, phase: original.phase || '' }, purchasing: purchasing(original.components) });
    const compare = out.compare && out.compare.commitments;
    opts.push(o);
    const vms = compare ? (o.components || []).filter(c => c.type === 'vm' && (c.commitment || 'payg') === 'payg' && (c.hours ?? 730) >= 730) : [];
    if (!vms.length) continue;
    for (const [term, label] of TERMS) {
      opts.push(Object.assign({}, o, {
        name: `${o.name} - ${label}`,
        purchasing: `${label} (eligible VMs)`,
        whenToChoose: `Same as "${o.name}" with the servers on a ${label}.`,
        components: o.components.map(c => vms.includes(c) ? Object.assign({}, c, { commitment: term }) : c)
      }));
    }
  }
  out.options = opts;
  out._expanded = true;
  return out;
}

module.exports = { expandSpec };
