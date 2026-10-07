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

// Field names that always hold a quantity, also when the schema gives no type.
const NUMERIC_NAME = /(GB|Gb|GiB|TB|MB|MBps|Mbps|Ms|Millions|Tokens|Ops|Seconds|Minutes|PerDay|PerMonth|PerSecond|PerOrchestration|Units|Queries|Executions|Iops|Hours)$|^(iops|vcores|vcpus|avgVcores|hours|instances|nodes|quantity|users|units|operations|signatures|codespaces|largerRunners|executions|requestUnits|durationMs|gbSeconds|jobMinutes)$/;

// Quantities must be real, non-negative numbers; hours fit in a month; whole-number fields are whole.
// Field options in a schema: { int: true, min, max }.
function numericErrors(comp) {
  const { SCHEMA } = require('./schema');
  const fields = (SCHEMA[comp.type] || {}).fields || {};
  const errs = [];
  if (require('./services')[comp.type]) {
    for (const [k, f] of Object.entries(fields)) if (f.req && comp[k] == null) errs.push(`"${k}" is required.`);
    for (const k of Object.keys(comp)) if (!['type', 'label'].includes(k) && !fields[k]) errs.push(`unknown field "${k}".`);
  } else if (SCHEMA[comp.type] && comp.type !== 'meter') {
    for (const [k, f] of Object.entries(fields)) if (f.req && comp[k] == null) errs.push(`"${k}" is required.`);
    // Built-in types: refuse fields the schema does not know, so a typo is never silently ignored.
    for (const k of Object.keys(comp)) if (!['type', 'label', 'desc', 'group'].includes(k) && !fields[k]) errs.push(`unknown field "${k}".`);
  }
  for (const [k, v] of Object.entries(comp)) {
    const fd = fields[k];
    if (fd && typeof fd.def === 'boolean' && v != null && typeof v !== 'boolean') errs.push(`"${k}" must be true or false.`);
    const numericField = fd && !fd.enum && (typeof fd.def === 'number' || fd.int || fd.min != null || fd.max != null);
    if (numericField && v != null && typeof v !== 'number') errs.push(`"${k}" must be a number, not ${JSON.stringify(v)}.`);
    else if (fd && !fd.enum && typeof v === 'string' && /^\s*-?[\d.,]+\s*$/.test(v)) errs.push(`"${k}" must be a number, not ${JSON.stringify(v)}.`);
    else if (fd && !fd.enum && (typeof v === 'string' || typeof v === 'boolean') && NUMERIC_NAME.test(k)) errs.push(`"${k}" must be a number, not ${JSON.stringify(v)}.`);
  }
  for (const [k, v] of Object.entries(comp)) {
    if (typeof v !== 'number') continue;
    const f = fields[k] || {};
    if (!Number.isFinite(v) || v < 0) errs.push(`"${k}" must be a number of 0 or more.`);
    else if (k === 'hours' && v > 744) errs.push(`"${k}" must be at most 744 (the longest month).`);
    else if ((f.int || (f.int !== false && /^count$|Count$|^(instances|nodes|hosts|clusters|accounts|units|devices|users|namespaces|replicas|partitions|pools|gateways|servers|vms|apps)$/.test(k))) && !Number.isInteger(v)) errs.push(`"${k}" must be a whole number.`);
    else if (f.min != null && v < f.min) errs.push(`"${k}" must be at least ${f.min}.`);
    else if (f.max != null && v > f.max) errs.push(`"${k}" must be at most ${f.max}.`);
  }
  return errs;
}

async function priceSpec(spec) {
  const region = normalizeRegion(spec.region);
  const currency = (spec.currency || 'USD').toUpperCase();
  const ctx = { region: region.code, currency };
  if (!Array.isArray(spec.options) || !spec.options.length) throw new PricingError('spec.options must contain at least one option.');
  const options = [];
  for (const [i, opt] of spec.options.entries()) {
    const octx = Object.assign({}, ctx, { ledger: {} });
    const out = { name: opt.name || `Option ${i + 1}`, label: opt.label || '', summary: opt.summary || '', whenToChoose: opt.whenToChoose || '', special: !!opt.special, lines: [], notes: [], components: [], errors: [] };
    for (const comp of opt.components || []) {
      const gone = require('./excluded').excludedMessage(comp.type);
      if (gone) { out.errors.push(`${comp.type}: ${gone}`); continue; }
      const fn = PRICERS[comp.type];
      if (!fn) { out.errors.push(`Unknown component type "${comp.type}". Known: ${Object.keys(PRICERS).join(', ')}.`); continue; }
      const bad = numericErrors(comp);
      if (bad.length) { out.errors.push(`${comp.type}: ${bad.join(' ')}`); continue; }
      try {
        const r = await fn(comp, octx);
        const badLine = r.lines.find(l => !Number.isFinite(Number(l.list)));
        if (badLine) throw new PricingError(`a line could not be priced ("${badLine.desc || badLine.meter || 'line'}" is not a number). Check that every quantity field is a number.`);
        for (const l of r.lines) {
          l.list = round2(l.list);
          const d = discountFor(l, spec);
          l.discountPct = d * 100;
          l.your = round2(l.list * (1 - d));
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
  const priced = options.filter(o => !o.errors.length);
  const lowest = priced.length ? priced.reduce((a, b) => (b.totalYour < a.totalYour ? b : a)) : null;
  if (lowest && priced.length > 1) lowest.lowest = true;
  return {
    title: spec.title || 'Azure pricing estimate', customer: spec.customer || '', region, currency,
    customerSaid: spec.customerSaid || {},
    discountPct: Number(spec.discountPct || 0), discountExcludes: spec.discountExcludes || [],
    capturedAt: new Date().toISOString(), context: spec.context || {}, replacedSizes: spec.replacedSizes || [],
    assumptions: spec.assumptions || [], nextSteps: spec.nextSteps || [], excluded: spec.excluded || [],
    options
  };
}

module.exports = { priceSpec, normalizeRegion, numericErrors };
