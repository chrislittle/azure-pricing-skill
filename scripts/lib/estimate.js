'use strict';
// Spec -> priced estimate. Deterministic math: round each line, then sum.
const { PRICERS, PricingError } = require('./recipes');
const { round2 } = require('./units');
const REGIONS = require('../../catalog/regions.json');

const LICENSE_SERVICES = new Set(['VM Licenses']);

function normalizeRegion(r) {
  if (!r) throw new PricingError('spec.region is required (for example "eastus2" or "East US 2").');
  const key = String(r).toLowerCase().replace(/\s+/g, '');
  const hit = Object.entries(REGIONS).find(([code, name]) => code === key || name.toLowerCase().replace(/\s+/g, '') === key);
  if (!hit) throw new PricingError(`Unknown region "${r}". Use a region code like eastus2 or centralus.`);
  return { code: hit[0], name: hit[1] };
}

function discountFor(line, spec) {
  const pct = Number(spec.discountPct || 0);
  if (!pct) return 0;
  const excl = (spec.discountExcludes || []).map(s => s.toLowerCase());
  if (excl.includes('licenses') && (LICENSE_SERVICES.has(line.service) || /license/i.test(line.desc))) return 0;
  return pct / 100;
}

async function priceSpec(spec) {
  spec = require('./expand').expandSpec(spec);
  const region = normalizeRegion(spec.region);
  const currency = (spec.currency || 'USD').toUpperCase();
  const ctx = { region: region.code, currency };
  if (!Array.isArray(spec.options) || !spec.options.length) throw new PricingError('spec.options must contain at least one option.');
  const options = [];
  for (const [i, opt] of spec.options.entries()) {
    const octx = Object.assign({}, ctx, { ledger: {} });
    const out = { name: opt.name || `Option ${i + 1}`, scenario: opt.scenario, purchasing: opt.purchasing, context: opt.context || {}, label: opt.label || '', summary: opt.summary || '', whenToChoose: opt.whenToChoose || '', special: !!opt.special, lines: [], notes: [], components: [], errors: [] };
    for (const comp of opt.components || []) {
      const fn = PRICERS[comp.type];
      if (!fn) { out.errors.push(`Unknown component type "${comp.type}". Known: ${Object.keys(PRICERS).join(', ')}.`); continue; }
      try {
        const r = await fn(comp, octx);
        for (const l of r.lines) {
          l.list = round2(l.list);
          const d = discountFor(l, spec);
          l.discountPct = d * 100;
          l.your = round2(l.list * (1 - d));
          l.componentIndex = out.components.length;
          if (comp.label) l.group = comp.label;
        }
        out.lines.push(...r.lines);
        out.notes.push(...r.notes);
        out.components.push({ spec: comp, facts: r.facts, lines: r.lines });
      } catch (e) {
        if (e instanceof PricingError) out.errors.push(`${comp.type}: ${e.message}` + (e.candidates.length ? ` Candidates: ${JSON.stringify(e.candidates)}` : ''));
        else throw e;
      }
    }
    // Group subtotals, then total = sum of rounded lines.
    const groups = [];
    for (const l of out.lines) {
      let g = groups.find(x => x.name === l.group);
      if (!g) { g = { name: l.group, lines: [], list: 0, your: 0 }; groups.push(g); }
      g.lines.push(l);
    }
    for (const g of groups) { g.list = round2(g.lines.reduce((s, l) => s + l.list, 0)); g.your = round2(g.lines.reduce((s, l) => s + l.your, 0)); }
    out.groups = groups;
    out.totalList = round2(out.lines.reduce((s, l) => s + l.list, 0));
    out.totalYour = round2(out.lines.reduce((s, l) => s + l.your, 0));
    out.notes = [...new Set(out.notes)];
    options.push(out);
  }
  // Different options may be deployment phases, not comparable architectures.
  // Only rank purchasing variants of the same original estimate.
  for (const id of new Set(options.map(o => o.scenario.id))) {
    const priced = options.filter(o => o.scenario.id === id && !o.errors.length);
    if (priced.length > 1) priced.reduce((a, b) => b.totalYour < a.totalYour ? b : a).lowest = true;
  }
  return {
    title: spec.title || 'Azure pricing estimate', customer: spec.customer || '', region, currency,
    customerSaid: spec.customerSaid || {},
    discountPct: Number(spec.discountPct || 0), discountExcludes: spec.discountExcludes || [],
    capturedAt: new Date().toISOString(), context: spec.context || {}, replacedSizes: spec.replacedSizes || [],
    assumptions: spec.assumptions || [], nextSteps: spec.nextSteps || [], excluded: spec.excluded || [],
    options
  };
}

module.exports = { priceSpec, normalizeRegion };
