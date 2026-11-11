'use strict';
const { checkMath, checkHtml } = require('../../scripts/lib/validate');
const { SCHEMA } = require('../../scripts/lib/schema');
const { normalizeRegion } = require('../../scripts/lib/estimate');
const vmSizes = require('../../catalog/vm-sizes.json');

function resolveModels(targets, available, explicitIds = []) {
  const normalize = s => s.replace(/\s*\((?:Research Preview|Preview|Internal only)\)/gi, '').trim().toLowerCase();
  return targets.map(target => {
    const matches = available.filter(m => target.id ? m.id === target.id : normalize(m.name) === normalize(target.name));
    const live = matches.length === 1 ? matches[0] : null;
    if (!matches.length && target.id && explicitIds.includes(target.id)) {
      return { ...target, resolvedId: target.id, available: true, availability: 'explicit-unlisted-request' };
    }
    return { ...target, resolvedId: live?.id || null, available: !!live && (!live.policy || live.policy.state === 'enabled') };
  });
}

function toolPermission(request, invocation) {
  if (request.managedApprovalRequired || invocation.managedSettingsEnabled) return { kind: 'no-result' };
  return request.kind === 'custom-tool' && ['azp', 'write_spec'].includes(request.toolName) ?
    { kind: 'approve-once' } : { kind: 'reject', feedback: 'Only the two bounded test adapters are permitted.' };
}

function engineArgumentError(args) {
  if (!Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string')) {
    return 'azp requires {"args":["command", "..."]}. To write a spec, call write_spec with file as an allocated path and spec as a JSON-encoded string, not azp.';
  }
  return null;
}

function caseSelection(value, caseIds) {
  if (!Array.isArray(value) || !value.length) throw new Error('--cases-from requires a nonempty array of {model, scenario} pairs.');
  const seen = new Set();
  return value.map(pair => {
    if (!pair || typeof pair.model !== 'string' || !pair.model.trim() || !caseIds.includes(pair.scenario)) throw new Error('Invalid model or unknown scenario in --cases-from.');
    const key = JSON.stringify([pair.model, pair.scenario]);
    if (seen.has(key)) throw new Error('Duplicate model/scenario pair in --cases-from.');
    seen.add(key);
    return { model: pair.model, scenario: pair.scenario };
  });
}

function componentValue(component, key) {
  if (component?.type === 'vm' && ['vcpu', 'memGiB', 'arch'].includes(key)) {
    return vmSizes[component.sku]?.[{ vcpu: 'v', memGiB: 'm', arch: 'a' }[key]];
  }
  const value = component?.[key] ?? SCHEMA[component?.type]?.fields[key]?.def;
  if (key === 'gbSeconds' && value == null && component?.type === 'functions') {
    return component.executions * component.durationMs / 1000 * component.memoryMB / 1024;
  }
  return value;
}

function optionMatches(actual, expected) {
  if (expected.phase && String(actual.phase || '').toLowerCase() !== expected.phase.toLowerCase()) return false;
  const remaining = [...(actual.components || [])];
  for (const component of expected.components) {
    const matches = remaining.map((c, i) => Object.entries(component).every(([key, value]) => key === 'count' || componentValue(c, key) === value) ? i : -1).filter(i => i >= 0);
    if (!matches.length) return false;
    if (component.count != null) {
      if (matches.reduce((sum, i) => sum + componentValue(remaining[i], 'count'), 0) !== component.count) return false;
      for (const i of matches.reverse()) remaining.splice(i, 1);
    } else remaining.splice(matches[0], 1);
  }
  return remaining.length === 0;
}

function scopeErrors(spec, expected) {
  const errors = [];
  for (const key of ['region', 'currency', 'discountPct']) {
    const got = key === 'region' ? normalizeRegion(spec.region).code : key === 'currency' ? (spec.currency || 'USD').toUpperCase() : spec[key];
    if (got !== expected[key]) errors.push(`${key}: expected ${expected[key]}, got ${got}`);
  }
  const exclusions = (spec.discountExcludes || []).map(s => s.toLowerCase()).sort();
  if (JSON.stringify(exclusions) !== JSON.stringify((expected.discountExcludes || []).map(s => s.toLowerCase()).sort())) errors.push('Unexpected discount exclusions.');
  if (!!spec.compare?.commitments !== !!expected.commitments) errors.push('Unexpected or missing purchasing comparison.');
  const options = expected.options || [{ components: expected.components }];
  if (!Array.isArray(spec.options) || spec.options.length !== options.length) return errors.concat(`Expected ${options.length} customer scope(s).`);
  const remaining = [...spec.options];
  for (const option of options) {
    const index = remaining.findIndex(actual => optionMatches(actual, option));
    if (index < 0) errors.push(`No matching scope for ${JSON.stringify(option)}.`);
    else remaining.splice(index, 1);
  }
  return errors;
}

function grade({ spec, audit, html, build, expected, requestedModel, approved, prematureBuild, finalText }) {
  const errors = scopeErrors(spec, expected);
  const est = audit.estimate;
  if (!approved || prematureBuild) errors.push('Build did not follow explicit approval of the final readback.');
  if (!build.ok || build.validation?.math?.length || build.validation?.html?.length) errors.push('Engine build failed validation.');
  if (!est || est.verification !== 'verified' || est.engineIntact !== true) errors.push('Unverified answers or modified engine.');
  if (est?.model?.model !== requestedModel || !Array.isArray(est?.model?.models) || !est.model.models.includes(requestedModel) || est.model.models.some(m => m !== requestedModel)) errors.push('Actual model differs from requested model.');
  if (!est?.options?.length || est.options.some(o => o.errors.length)) errors.push('Incomplete pricing.');
  const pricedCount = (expected.options?.length || 1) * (expected.commitments ? 5 : 1);
  if (est?.options?.length !== pricedCount || build.options?.length !== pricedCount) errors.push(`Expected ${pricedCount} priced estimate(s).`);
  if (expected.commitments && est?.options) {
    const terms = est.options.map(o => [...new Set(o.components.filter(c => c.spec.type === 'vm').map(c => c.spec.commitment || 'payg'))].join(',')).sort();
    if (JSON.stringify(terms) !== JSON.stringify(['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'].sort())) errors.push('Purchasing variants are missing, duplicated or mixed.');
  }
  if (!build.options?.length || build.options.some(o => !Number.isFinite(o.monthlyList) || !Number.isFinite(o.monthlyYourPrice))) errors.push('Missing or invalid build totals.');
  if (est?.options) errors.push(...checkMath(est));
  if (est?.options?.every(o => Array.isArray(o.components))) {
    const baseline = est.options.filter(o => !expected.commitments || o.components.some(c => c.spec.type === 'vm' && (c.spec.commitment || 'payg') === 'payg'));
    errors.push(...scopeErrors({
      region: est.region.code, currency: est.currency, discountPct: est.discountPct, discountExcludes: est.discountExcludes,
      compare: spec.compare, options: baseline.map(o => ({ phase: o.scenario?.phase, components: o.components.map(c => c.spec) }))
    }, expected).map(e => 'Priced audit: ' + e));
  }
  errors.push(...checkHtml(html));
  const remainingPriced = [...(est?.options || [])];
  for (const option of build.options || []) {
    const index = remainingPriced.findIndex(o => o.name === option.name &&
      o.scenario?.id === option.scenario?.id && o.scenario?.phase === option.scenario?.phase &&
      o.purchasing === option.purchasing);
    const priced = index < 0 ? null : remainingPriced.splice(index, 1)[0];
    if (!priced || priced.totalList !== option.monthlyList || priced.totalYour !== option.monthlyYourPrice) errors.push('Build totals differ from the priced audit.');
    for (const total of [option.monthlyList, option.monthlyYourPrice]) {
      const plain = String(total), fixed = Number(total).toFixed(2);
      if (![plain, fixed].some(n => new RegExp(`(^|[^\\d.])${n.replace('.', '\\.')}(?!\\d|\\.\\d)`).test(finalText.replace(/,/g, '')))) errors.push(`Final response does not relay engine total ${fixed}.`);
    }
  }
  return errors;
}

module.exports = { resolveModels, scopeErrors, grade, toolPermission, engineArgumentError, caseSelection };
