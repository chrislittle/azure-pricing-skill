'use strict';
const fs = require('node:fs'), path = require('node:path');
const { parseArgs } = require('node:util');
const cases = require('./scenarios.json').scenarios;

function shareableError(error) {
  return error
    .replace(/\b[A-Z]:[\\/][^\r\n]*|(^|\s)\/[^\r\n]*/gim, '[local path omitted; inspect raw diagnostics]')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[session ID]');
}

function summarize(report, caseIds = cases.map(s => s.id)) {
  const rows = [], problems = [];
  if (report.plannedCases?.some(p => !report.roster.some(t => (t.resolvedId || t.id || t.name) === p.model))) problems.push('Unknown planned model.');
  for (const target of report.roster) {
    const id = target.resolvedId || target.id || target.name;
    const results = report.results.filter(r => r.model === id);
    const selectedCases = report.plannedCases ? report.plannedCases.filter(p => p.model === id).map(p => p.scenario) : caseIds;
    if (report.plannedCases && !selectedCases.length && !results.length) continue;
    const trials = results.filter(r => r.scenario);
    const known = trials.filter(r => selectedCases.includes(r.scenario) && caseIds.includes(r.scenario));
    const unique = new Set(known.map(r => r.scenario));
    if (known.length !== unique.size || known.length !== trials.length) problems.push(`${id}: duplicate or unknown cases.`);
    const passed = known.filter(r => r.status === 'passed');
    const failures = known.filter(r => r.status !== 'passed');
    if (new Set(selectedCases).size !== selectedCases.length || selectedCases.some(c => !caseIds.includes(c))) problems.push(`${id}: duplicate or unknown planned cases.`);
    const missing = target.available ? selectedCases.filter(c => !unique.has(c)) : [];
    rows.push({
      model: id, name: target.name, internalOnly: !!target.internalOnly, preview: !!target.preview,
      status: !target.available ? 'unavailable-to-runner' : missing.length ? 'incomplete' : failures.length ? 'needs-review' : 'passed-all-cases',
      passed: passed.length, failed: failures.length, selectedCases, missing,
      reportsProduced: known.filter(r => r.totals).length,
      reportsPassingAllChecks: passed.filter(r => r.totals).length,
      correctlyStoppedWithoutReport: passed.filter(r => r.outcome === 'stopped-without-report').length,
      passedCases: passed.map(r => r.scenario).sort(),
      failures: failures.map(r => ({ scenario: r.scenario, kind: r.failureKind || 'grading', errors: r.errors.map(shareableError) }))
    });
  }
  const available = rows.filter(r => r.status !== 'unavailable-to-runner');
  const expected = available.reduce((sum, r) => sum + r.selectedCases.length, 0);
  const completed = available.reduce((sum, r) => sum + r.passed + r.failed, 0);
  const complete = !!report.completed && expected > 0 && completed === expected && !problems.length;
  return {
    version: report.version, started: report.started, completed: report.completed || null,
    status: complete ? 'completed' : 'incomplete', scope: report.scope, suiteHash: report.suiteHash,
    sdkVersion: report.sdkVersion, runtimeVersion: report.runtimeVersion,
    runtimeFingerprints: [...new Set(report.results.map(r => r.fingerprint).filter(Boolean))],
    cases: caseIds, expectedConversations: expected, completedConversations: completed,
    passed: rows.reduce((sum, r) => sum + r.passed, 0), failed: rows.reduce((sum, r) => sum + r.failed, 0),
    unavailable: rows.filter(r => r.status === 'unavailable-to-runner').map(r => r.name),
    problems, models: rows,
    limitations: [
      'Bounded engine/spec adapters, not unrestricted shell or native-form certification.',
      'Approval pressure is exercised, but the adapters prevent direct editing of runtime or session files.',
      'Prices and arithmetic come from the engine; the conversation grader does not perform an independent pricing-oracle comparison.',
      'No full semantic assessment of narrative quality or advisory explanations; link checking is skipped.',
      'A failed or timed-out case needs investigation, not automatic model blocking. Unavailable means not exposed to this runner, not necessarily unavailable in the interactive picker.'
    ]
  };
}

function compareFollowup(baseline, report, corrections = [], diagnostics = {}) {
  const key = r => JSON.stringify([r.model, r.scenario]);
  const corrected = new Set(corrections.map(c => {
    const original = baseline.results.find(r => key(r) === key(c));
    if (!original || original.errors.length !== 1 || original.errors[0] !== c.recordedError) throw new Error('Review correction does not match the baseline.');
    return key(c);
  }));
  const cohort = baseline.results.filter(r => r.scenario && r.status === 'failed' && !corrected.has(key(r)));
  const results = report.results.filter(r => r.scenario), byPair = new Map(results.map(r => [key(r), r]));
  const problems = results.length !== byPair.size ? ['Duplicate follow-up cases.'] : [];
  if (new Set(cohort.map(key)).size !== cohort.length) problems.push('Duplicate baseline cases.');
  const rows = cohort.map(before => {
    const after = byPair.get(key(before)), observed = diagnostics[key(before)] || {};
    const errors = after?.errors || [];
    const engineErrors = observed.errors || [];
    let reason = !after ? 'missing' : after.status === 'passed' ? 'resolved' : 'workflow-incomplete';
    if (after?.status === 'failed') {
      if (after.failureKind === 'timeout') reason = 'timeout';
      else if (errors.some(e => /does not relay engine total/.test(e))) reason = 'incomplete-final-summary';
      else if (errors.some(e => /did not follow explicit approval/.test(e))) reason = 'attempted-unapproved-build';
      else if (errors.some(e => /Readback has incorrect scope/.test(e))) reason = 'scope-mismatch';
      else if (observed.toolError) reason = 'tool-input';
      else if (engineErrors.some(e => /readback|approve|approval|confirmation/i.test(e))) reason = 'confirmation-protocol';
      else if (engineErrors.some(e => /sources\[|customer answer|boolean sources/.test(e))) reason = 'answer-provenance';
      else if (engineErrors.length) reason = 'spec-validation';
    }
    return {
      model: before.model, scenario: before.scenario, status: after?.status || 'missing', reason,
      baselineErrors: before.errors.map(shareableError), errors: errors.map(shareableError),
      lastEngineErrors: engineErrors.map(shareableError), lastToolError: observed.toolError ? shareableError(observed.toolError) : null,
      durationMs: after?.durationMs
    };
  });
  const passed = rows.filter(r => r.status === 'passed').length;
  const failed = rows.filter(r => r.status === 'failed').length;
  const missing = rows.filter(r => r.status === 'missing').length;
  const skillDigests = [...new Set(results.map(r => r.skillDigest).filter(Boolean))];
  if (skillDigests.length > 1) problems.push('Mixed follow-up runtime copies.');
  const selected = new Set(cohort.map(key));
  return {
    status: report.completed && cohort.length && passed + failed === cohort.length && !missing && !problems.length ? 'completed' : 'incomplete',
    expectedConversations: cohort.length, completedConversations: passed + failed, passed, failed, missing,
    baselineSuiteHash: baseline.suiteHash, followupSuiteHash: report.suiteHash, completed: report.completed || null,
    runtimeFingerprints: [...new Set(results.map(r => r.fingerprint).filter(Boolean))], skillDigests,
    models: [...new Set(rows.map(r => r.model))].map(model => ({
      model, retested: rows.filter(r => r.model === model && r.status !== 'missing').length,
      passed: rows.filter(r => r.model === model && r.status === 'passed').length,
      flagged: rows.filter(r => r.model === model && r.status === 'failed').length,
      missing: rows.filter(r => r.model === model && r.status === 'missing').length
    })),
    remainingCategories: Object.fromEntries([...new Set(rows.filter(r => r.status === 'failed').map(r => r.reason))].map(reason => [reason, rows.filter(r => r.status === 'failed' && r.reason === reason).length])),
    additionalControls: results.filter(r => !selected.has(key(r))).map(r => ({ model: r.model, scenario: r.scenario, status: r.status })),
    problems, cases: rows,
    limitations: [
      'Targeted rerun of previously flagged pairs, not a new complete model matrix. Do not combine old passes with these results into a new full-suite score.',
      'Original results are unchanged. Only the explicitly reviewed checker correction is excluded from the target cohort.',
      'Diagnostic categories summarize observed failures, not general model safety or pricing-quality verdicts. Timeouts may include retries after validation errors.',
      'Bounded adapters and the same four-minute/eight-customer-turn limits; no unrestricted-shell or native-form certification.'
    ]
  };
}

function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' }, review: { type: 'string' } } });
  if (!values.input || !values.out) throw new Error('Usage: node tests/models/summarize.js --input run-directory --out summary.json [--baseline old-run-directory --review review.json]');
  if (values.review && !values.baseline) throw new Error('--review requires --baseline.');
  const input = path.resolve(values.input);
  const report = JSON.parse(fs.readFileSync(path.join(input, 'results.json'), 'utf8'));
  let summary;
  if (values.baseline) {
    const baselinePath = path.resolve(values.baseline);
    const raw = fs.readFileSync(path.join(baselinePath, 'results.json'), 'utf8');
    const review = values.review ? JSON.parse(fs.readFileSync(values.review, 'utf8')) : null;
    if (review && review.run !== path.basename(baselinePath)) throw new Error('Review belongs to a different baseline run.');
    const diagnostics = {};
    for (const result of report.results.filter(r => r.scenario && r.status === 'failed')) {
      const transcript = JSON.parse(fs.readFileSync(path.join(input, result.model, result.scenario, 'transcript.json'), 'utf8'));
      const lastSuccess = transcript.findLastIndex(e => e.tool === 'azp' && e.args?.[0] === 'build' && e.output?.file);
      const failure = transcript.slice(lastSuccess + 1).findLast(e => e.tool === 'azp' && e.output?.ok === false);
      const toolError = transcript.slice(lastSuccess + 1).findLast(e => e.tool);
      diagnostics[JSON.stringify([result.model, result.scenario])] = { errors: failure?.output.errors || [], toolError: toolError?.error };
    }
    summary = compareFollowup(JSON.parse(raw), report, review?.corrections, diagnostics);
    summary.baselineRun = path.basename(baselinePath);
    summary.followupRun = path.basename(input);
    summary.baselineSha256 = require('crypto').createHash('sha256').update(raw).digest('hex');
  } else summary = summarize(report);
  fs.writeFileSync(values.out, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(`${summary.completedConversations}/${summary.expectedConversations} conversations: ${summary.passed} passed, ${summary.failed} failed${summary.unavailable ? `; ${summary.unavailable.length} unavailable` : ''}.`);
  if (summary.status !== 'completed') process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { summarize, compareFollowup };
