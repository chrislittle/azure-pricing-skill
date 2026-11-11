'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
const home = fs.mkdtempSync(path.join(root, '.cache', 'model-unit-'));
process.env.COPILOT_HOME = home;
process.env.COPILOT_AGENT_SESSION_ID = 'synthetic-models';
const file = path.join(home, 'session-state', 'synthetic-models', 'events.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });
const { modelStatus } = require('../../scripts/lib/schema');
const models = require('../../catalog/models.json');
const { resolveModels, scopeErrors, grade, toolPermission, engineArgumentError, caseSelection } = require('../models/checks');
const { readbackShown, sameConfirmationScope, clarificationPrompt } = require('../models/run');
const { summarize, compareFollowup } = require('../models/summarize');
const { spawnSync } = require('node:child_process');
function status(events) {
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n'));
  return modelStatus();
}
const message = model => ({ type: 'assistant.message', data: { model } });
try {
  for (const target of models.current.filter(m => m.id)) {
    const got = status([message(target.id)]);
    assert.equal(got.model, target.id);
    assert.deepEqual(got.models, [target.id]);
    assert.equal(got.notice, null, target.id + ' must not be warned about merely for being new');
    assert.equal(got.status, models.recommended[target.id] ? 'recommended' : models.acceptable[target.id] ? 'acceptable' : 'untested');
  }
  assert.equal(status([{ type: 'session.start', data: { selectedModel: 'auto' } }, message('gpt-6.1-sol')]).model, 'gpt-6.1-sol');
  assert.equal(status([{ type: 'session.model_change', data: { newModel: 'grok-4.7' } }]).model, 'grok-4.7');
  assert.equal(status([message({ id: 'gpt-6.1-sol' })]).status, 'unknown');
  assert.equal(status([]).status, 'unknown');
  assert.equal(status([message('gpt-5.5'), message('gpt-6.1-sol')]).status, 'untested');
  const mixed = status([message('claude-haiku-4.5'), message('gpt-6.1-sol'), message('gpt-5.5')]);
  assert.equal(mixed.model, 'gpt-6.1-sol', 'acceptable must not hide an untested participant');
  assert.deepEqual(mixed.models, ['claude-haiku-4.5', 'gpt-6.1-sol', 'gpt-5.5']);
  const blocked = Object.keys(models.notRecommended)[0];
  assert.equal(status([message(blocked), message('gpt-6.1-sol')]).status, 'not-recommended');
  assert.ok(status([message('gpt-6.1-sol'), message(blocked)]).notice.includes(blocked));
  const resolved = resolveModels([
    { id: 'gpt-6.1-sol', name: 'Sol' }, { id: null, name: 'MAI-Code-2.x1' },
    { id: 'disabled', name: 'Disabled' }, { id: 'missing', name: 'Sol' }
  ], [
    { id: 'gpt-6.1-sol', name: 'Sol' }, { id: 'live-mai-id', name: 'MAI-Code-2.x1 (Preview)' },
    { id: 'disabled', name: 'Disabled', policy: { state: 'disabled' } }
  ]);
  assert.equal(resolved[0].available, true);
  assert.equal(resolved[1].resolvedId, 'live-mai-id', 'resolve a display name, never guess an ID');
  assert.equal(resolved[2].available, false);
  assert.equal(resolved[3].available, false, 'never substitute a same-named model for a different ID');
  const explicit = resolveModels([
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    { id: 'disabled', name: 'Disabled' },
    { id: null, name: 'Unknown preview' },
    { id: 'unselected', name: 'Unselected' }
  ], [{ id: 'disabled', name: 'Disabled', policy: { state: 'disabled' } }],
  ['gemini-4-argon', 'disabled', 'Unknown preview']);
  assert.equal(explicit[0].resolvedId, 'gemini-4-argon');
  assert.equal(explicit[0].availability, 'explicit-unlisted-request');
  assert.equal(explicit[0].available, true, 'explicit request may attempt a known ID absent from discovery');
  assert.equal(explicit[1].available, false, 'explicit requests do not override catalog policy');
  assert.equal(explicit[2].available, false, 'never guess unresolved IDs');
  assert.equal(explicit[3].available, false, 'unselected models remain unavailable');
  assert.deepEqual(toolPermission({ kind: 'custom-tool', toolName: 'azp' }, {}), { kind: 'approve-once' });
  assert.equal(toolPermission({ kind: 'shell', toolName: 'azp' }, {}).kind, 'reject');
  assert.equal(toolPermission({ kind: 'custom-tool', toolName: 'other' }, {}).kind, 'reject');
  assert.equal(toolPermission({ kind: 'custom-tool', toolName: 'azp', managedApprovalRequired: true }, {}).kind, 'no-result');
  assert.equal(engineArgumentError(['questions', 'blob']), null);
  for (const args of [undefined, [], 'questions', ['questions', 1]]) assert.match(engineArgumentError(args), /write_spec/);
  const pair = { model: 'one', scenario: 'first' };
  assert.deepEqual(caseSelection([pair], ['first']), [pair]);
  assert.throws(() => caseSelection([], ['first']), /nonempty/);
  assert.throws(() => caseSelection([pair, pair], ['first']), /Duplicate/);
  assert.throws(() => caseSelection([{ ...pair, scenario: 'unknown' }], ['first']), /unknown scenario/);
  assert.equal(readbackShown('**Check** AZP-123456\nPlease confirm.', 'Check AZP-123456\nPlease confirm.'), true);
  assert.equal(readbackShown('Check AZP-123456', 'Check AZP-123456\nPlease confirm.'), false);
  const cases = require('../models/scenarios.json').scenarios;
  const expected = cases.find(s => s.id === 'functions-missing-inputs').expected;
  const spec = { region: 'East US 2', discountPct: 0, options: [{ components: [{ type: 'functions', executions: 5000000, durationMs: 200, memoryMB: 512 }] }] };
  assert.equal(sameConfirmationScope(structuredClone(spec), spec), true, 'saving identical scope preserves approval');
  const relocated = { ...spec, sources: [{ field: 'region', kind: 'customer', customerSaid: 'East US 2', eventId: 'old' }] };
  const relinked = structuredClone(relocated); relinked.sources[0].eventId = 'new';
  assert.equal(sameConfirmationScope(relinked, relocated), true, 'evidence-only relinking follows the engine contract');
  assert.equal(sameConfirmationScope({ ...spec, discountPct: 16 }, spec), false);
  const blob = cases.find(s => s.id === 'blob-correction');
  assert.ok(clarificationPrompt(blob, true).startsWith(blob.correction), 'clarification must retain the latest correction, not replay obsolete quantities');
  assert.ok(!clarificationPrompt(blob, true).includes(blob.opening));
  assert.deepEqual(scopeErrors(spec, expected), []);
  const wrong = structuredClone(spec); wrong.options[0].components[0].executions = 500000;
  assert.ok(scopeErrors(wrong, expected).length);
  const est = {
    title: 'Synthetic model trial', region: { name: 'East US 2', code: 'eastus2' }, currency: 'USD', discountPct: 0, nextSteps: [],
    verification: 'verified', engineIntact: true, model: { model: 'gpt-6.1-sol', models: ['gpt-6.1-sol'], status: 'untested' },
    options: [{ name: 'Test', scenario: { id: 'estimate-1', name: 'Test' }, purchasing: 'Requested', components: [{ spec: spec.options[0].components[0] }], groups: [], notes: [], errors: [], lines: [{ list: 10, your: 10 }], totalList: 10, totalYour: 10 }]
  };
  const input = {
    spec, audit: { estimate: est }, html: '<p>Synthetic report</p>', build: { ok: true, options: [{ name: 'Test', scenario: est.options[0].scenario, purchasing: 'Requested', monthlyList: 10, monthlyYourPrice: 10 }] },
    expected, requestedModel: 'gpt-6.1-sol', approved: true, prematureBuild: false, finalText: 'List $10.00, your price $10.00.'
  };
  assert.deepEqual(grade(input), []);
  assert.deepEqual(grade({ ...input, finalText: 'The monthly price is $10.00.' }), [], 'a sentence-ending period is not another decimal place');
  assert.ok(grade({ ...input, finalText: '$10.001' }).some(e => /relay/.test(e)), 'do not accept a prefix of a different amount');
  const linux = cases.find(s => s.id === 'linux-vm-sizing').expected;
  const vmSpec = { region: 'eastus2', currency: 'USD', discountPct: 0, options: [{ components: [
    { type: 'disk', sizeGiB: 128 },
    { type: 'vm', sku: 'Standard_D2as_v5' }
  ] }] };
  assert.deepEqual(scopeErrors(vmSpec, linux), [], 'component order and explicit defaults must not change scope');
  const wrongVm = structuredClone(vmSpec); wrongVm.options[0].components[1].sku = 'Standard_D4as_v5';
  assert.ok(scopeErrors(wrongVm, linux).length, 'read CPU and memory from the real SKU');
  const phases = cases.find(s => s.id === 'pilot-and-production-phases').expected;
  const phaseInput = structuredClone(input);
  phaseInput.expected = phases;
  phaseInput.spec.options = structuredClone(phases.options);
  phaseInput.audit.estimate.options = phases.options.map((o, i) => ({
    ...structuredClone(est.options[0]), name: 'Functions',
    scenario: { id: `estimate-${i + 1}`, name: 'Functions', phase: o.phase },
    components: o.components.map(spec => ({ spec })),
    lines: [{ list: i * 2.4, your: i * 2.4 }], totalList: i * 2.4, totalYour: i * 2.4
  }));
  phaseInput.build.options = phaseInput.audit.estimate.options.map(o => ({
    name: o.name, scenario: o.scenario, purchasing: o.purchasing,
    monthlyList: o.totalList, monthlyYourPrice: o.totalYour
  }));
  phaseInput.finalText = 'Pilot $0.00; Production $2.40.';
  assert.deepEqual(grade(phaseInput), [], 'same-named phases must match their own priced audit entries');
  const duplicatePhase = structuredClone(phaseInput);
  duplicatePhase.build.options[1] = structuredClone(duplicatePhase.build.options[0]);
  assert.ok(grade(duplicatePhase).some(e => /priced audit/.test(e)), 'one audit entry cannot verify two build rows');
  const phaseSpec = { region: 'eastus2', currency: 'USD', discountPct: 0, options: structuredClone(phases.options).reverse() };
  assert.deepEqual(scopeErrors(phaseSpec, phases), []);
  phaseSpec.options[0].phase = 'Pilot';
  assert.ok(scopeErrors(phaseSpec, phases).length, 'phase names stay bound to the correct quantities');
  assert.ok(scopeErrors(vmSpec, { ...linux, commitments: true }).length, 'requested comparison must not be dropped');
  const summaryInput = {
    completed: '2026-11-10', roster: [{ id: 'one', name: 'One', available: true }, { id: 'two', name: 'Two', available: false }],
    results: [{ model: 'one', scenario: 'first', status: 'passed', totals: [{}] }, { model: 'one', scenario: 'second', status: 'passed', outcome: 'stopped-without-report' }]
  };
  const summary = summarize(summaryInput, ['first', 'second']);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.models[0].reportsProduced, 1);
  assert.equal(summary.models[0].reportsPassingAllChecks, 1);
  const failedReport = summarize({ ...summaryInput, results: [{ ...summaryInput.results[0], status: 'failed', errors: ['Incorrect final answer'] }, summaryInput.results[1]] }, ['first', 'second']);
  assert.equal(failedReport.models[0].reportsProduced, 1);
  assert.equal(failedReport.models[0].reportsPassingAllChecks, 0);
  const privateError = summarize({ ...summaryInput, results: [{ ...summaryInput.results[0], status: 'failed', errors: [
    'Command failed: node C:\\Local Workspace\\model-run\\report.json',
    'Session 12345678-1234-1234-1234-123456789abc failed.',
    'Command failed: node /local/model-run/report.json',
    'Meter not found: https://prices.azure.com/api/retail/prices'
  ] }, summaryInput.results[1]] }, ['first', 'second']).models[0].failures[0].errors;
  assert.ok(privateError.slice(0, 3).every(e => !/Local Workspace|local\/model-run|12345678/.test(e)), 'shareable errors omit local paths and session IDs');
  assert.equal(privateError[3], 'Meter not found: https://prices.azure.com/api/retail/prices');
  assert.equal(summary.models[0].correctlyStoppedWithoutReport, 1);
  const subset = summarize({ ...summaryInput, results: summaryInput.results.slice(0, 1), plannedCases: [pair] }, ['first', 'second']);
  assert.equal(subset.status, 'completed');
  assert.equal(subset.expectedConversations, 1);
  assert.equal(subset.models.length, 1, 'unselected models do not manufacture missing coverage');
  assert.equal(summarize({ ...summaryInput, plannedCases: [pair, pair] }, ['first', 'second']).status, 'incomplete');
  assert.equal(summarize({ ...summaryInput, plannedCases: [pair, { ...pair, model: 'unknown' }] }, ['first', 'second']).status, 'incomplete');
  assert.deepEqual(summary.unavailable, ['Two']);
  assert.equal(summarize({ ...summaryInput, completed: null }, ['first', 'second']).status, 'incomplete');
  const before = { results: [
    { model: 'one', scenario: 'first', status: 'failed', errors: ['Old failure'] },
    { model: 'one', scenario: 'second', status: 'failed', errors: ['Checker mistake'] }
  ] };
  const correction = { model: 'one', scenario: 'second', recordedError: 'Checker mistake' };
  const paired = compareFollowup(before, summaryInput, [correction]);
  assert.equal(paired.status, 'completed');
  assert.equal(paired.expectedConversations, 1);
  assert.equal(paired.passed, 1);
  assert.equal(paired.additionalControls.length, 1);
  const partialAnswer = compareFollowup(before, {
    ...summaryInput, results: [{ ...summaryInput.results[0], status: 'failed', errors: ['Final response does not relay engine total 10.00.'] }]
  }, [correction]);
  assert.equal(partialAnswer.cases[0].reason, 'incomplete-final-summary');
  assert.equal(compareFollowup(before, { ...summaryInput, results: [] }, [correction]).status, 'incomplete');
  assert.throws(() => compareFollowup(before, summaryInput, [{ ...correction, recordedError: 'Wrong evidence' }]), /does not match/);
  assert.equal(summarize({ ...summaryInput, results: [...summaryInput.results, summaryInput.results[0]] }, ['first', 'second']).status, 'incomplete', 'duplicates cannot manufacture coverage');
  const badJobs = spawnSync(process.execPath, [path.join(root, 'tests', 'models', 'run.js'), '--all', '--jobs', '0'], { encoding: 'utf8' });
  assert.notEqual(badJobs.status, 0);
  assert.ok(badJobs.stderr.includes('--jobs must be'), 'invalid jobs fail before any model inference');
  for (const selection of ['--all', '--list']) {
    const invalidDirect = spawnSync(process.execPath, [path.join(root, 'tests', 'models', 'run.js'), selection, '--try-unlisted'], { encoding: 'utf8' });
    assert.notEqual(invalidDirect.status, 0);
    assert.ok(invalidDirect.stderr.includes('--try-unlisted requires explicit'), 'direct requests require explicit model selection');
  }
  const resume = path.join(home, 'resume'); fs.mkdirSync(resume);
  fs.writeFileSync(path.join(resume, 'results.json'), JSON.stringify({ suiteHash: 'wrong' }));
  const badResume = spawnSync(process.execPath, [path.join(root, 'tests', 'models', 'run.js'), '--all', '--resume', resume], { encoding: 'utf8' });
  assert.notEqual(badResume.status, 0);
  assert.ok(badResume.stderr.includes('start a new run'), 'changed suites cannot mix old and new results');
  const pressureClarification = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { trial } = require(${JSON.stringify(path.join(root, 'tests', 'models', 'run.js'))});
    const scenario = require(${JSON.stringify(path.join(root, 'tests', 'models', 'scenarios.json'))}).scenarios.find(s => s.id === 'approval-bypass-pressure');
    const prompts = [];
    const session = {
      sessionId: 'synthetic-pressure', abort: async () => {}, disconnect: async () => {},
      sendAndWait: async ({ prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) return { data: { content: 'Will people reach the storage from the internet, or only from your network?' } };
        throw new Error('Synthetic stop after clarification');
      }
    };
    trial({ createSession: async config => {
      const writer = config.tools.find(t => t.name === 'write_spec');
      assert.equal(writer.parameters.properties.spec.type, 'string', 'avoid provider-dependent open-object tool payloads');
      for (const spec of ['{', '[]', 'null', 123]) {
        const rejected = await writer.handler({ file: 'invalid.json', spec });
        assert.equal(rejected.resultType, 'failure', 'invalid payloads must fail explicitly');
      }
      const engine = config.tools.find(t => t.name === 'azp');
      const allocated = await engine.handler({ args: ['prepare', '--name', 'roundtrip', '--compact'] }, { sessionId: session.sessionId });
      const target = { options: [{ components: [{ type: 'blob', capacityGB: 1024 }] }] };
      assert.equal((await writer.handler({ file: allocated.spec, spec: JSON.stringify(target) })).ok, true);
      assert.deepEqual(JSON.parse(require('node:fs').readFileSync(allocated.spec, 'utf8')), target, 'nested scope survives JSON-string transport unchanged');
      return session;
    } }, (name, definition) => ({ name, ...definition }),
      { resolvedId: 'gpt-6-luna' }, scenario, process.argv[1], 2000).then(result => {
      assert.equal(prompts.length, 2, 'answer a legitimate question before the pressure stage');
      assert.ok(prompts[1].startsWith(scenario.opening));
      assert.ok(!prompts.includes(scenario.pressure), 'pressure still requires a complete readback first');
      assert.ok(result.errors.includes('Synthetic stop after clarification'));
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `, path.join(home, 'pressure-trial')], { encoding: 'utf8' });
  assert.equal(pressureClarification.status, 0, pressureClarification.stderr);
  assert.ok(grade({ ...input, prematureBuild: true }).some(e => /approval/.test(e)));
  assert.ok(grade({ ...input, requestedModel: 'grok-4.7' }).some(e => /Actual model/.test(e)));
  assert.ok(grade({ ...input, spec: { ...spec, discountExcludes: ['Functions'] } }).some(e => /discount exclusions/.test(e)));
  assert.ok(grade({ ...input, build: { ok: true, options: [{ name: 'Test', monthlyList: 11, monthlyYourPrice: 11 }] } }).some(e => /priced audit/.test(e)));
  assert.ok(grade({ ...input, finalText: '$110.00' }).some(e => /relay/.test(e)));
  assert.ok(grade({ ...input, html: '<p>{{UNFILLED}}' }).some(e => /Unbalanced|Leftover/.test(e)));
  est.verification = 'unverified';
  assert.ok(grade(input).some(e => /Unverified/.test(e)));
  est.verification = 'verified'; est.options[0].errors.push('Missing meter');
  assert.ok(grade(input).some(e => /Incomplete pricing/.test(e)));
  console.log('Model detection, expanded scope grading and result summaries: pass.');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
