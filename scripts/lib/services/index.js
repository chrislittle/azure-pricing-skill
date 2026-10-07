'use strict';
// Service registry. Every *.js file in this folder (except index.js) is one Tier 1 component type:
//
// module.exports = {
//   type: 'key-vault',                 // component type used in specs (kebab-case, unique)
//   label: 'Azure Key Vault',          // shown to the agent and in `questions`
//   family: 'security',                // grouping for `services`
//   calculator: ['key-vault'],         // Azure Pricing Calculator product slug(s) this covers
//   keywords: ['secrets', 'keys'],     // plain words people use; `services --find` matches them
//   fields: { tier: { def: 'standard', enum: [...], ask: '...' }, operations: { req: true, ask: '...' } },
//   context: ['production'],           // optional: workload context questions that apply
//   readback: (c, spec) => 'plain-language line with every quantity' (spec.region available),
//   notIncluded: (types, spec) => [],  // optional: things usually needed with this service
//   examples: [ { type: 'key-vault', ... } ],  // >= 1 realistic component; priced by the contract test
//   testRegions: ['eastus', 'westeurope'],   // optional: regions for the contract test (default eastus2, westeurope)
//   price: async (c, ctx) => ({ lines, notes, facts })   // use ../kit helpers
// };
const fs = require('fs');
const path = require('path');

const REQUIRED = ['type', 'label', 'family', 'calculator', 'keywords', 'fields', 'readback', 'examples', 'price'];
const SERVICES = {};
for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && f !== 'index.js').sort()) {
  const m = require(path.join(__dirname, f));
  const miss = REQUIRED.filter(k => m[k] == null);
  if (miss.length) throw new Error(`services/${f}: missing ${miss.join(', ')}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.type)) throw new Error(`services/${f}: type must be kebab-case`);
  if (SERVICES[m.type]) throw new Error(`services/${f}: duplicate type "${m.type}"`);
  for (const [k, fd] of Object.entries(m.fields)) if (fd.req && !fd.ask) throw new Error(`services/${f}: required field "${k}" needs an "ask"`);
  SERVICES[m.type] = m;
}
module.exports = SERVICES;
