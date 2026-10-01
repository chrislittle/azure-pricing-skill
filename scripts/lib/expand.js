'use strict';
// Spec expansion: built-in comparisons the engine generates itself, so a model cannot drop one.
// spec.compare = { commitments: true }  -> every option with pay-as-you-go VMs gets 1- and 3-year
// reservation and savings plan variants alongside it.
const TERMS = [['ri1y', '1-year reservation'], ['ri3y', '3-year reservation'], ['sp1y', '1-year savings plan'], ['sp3y', '3-year savings plan']];

function expandSpec(spec) {
  if (!spec || !spec.compare || !spec.compare.commitments || spec._expanded) return spec;
  const out = JSON.parse(JSON.stringify(spec));
  const opts = [];
  for (const o of out.options || []) {
    opts.push(Object.assign({}, o, { name: /pay-as-you-go/i.test(o.name) ? o.name : `${o.name} - pay-as-you-go` }));
    const vms = (o.components || []).filter(c => c.type === 'vm' && (c.commitment || 'payg') === 'payg' && (c.hours || 730) >= 730);
    if (!vms.length) continue;
    for (const [term, label] of TERMS) {
      opts.push(Object.assign({}, o, {
        name: `${o.name} - ${label}`,
        whenToChoose: `Same as "${o.name}" with the servers on a ${label}.`,
        components: o.components.map(c => (c.type === 'vm' && (c.commitment || 'payg') === 'payg' && (c.hours || 730) >= 730) ? Object.assign({}, c, { commitment: term }) : c)
      }));
    }
  }
  out.options = opts;
  out._expanded = true;
  return out;
}

module.exports = { expandSpec };
