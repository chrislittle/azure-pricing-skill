'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..', '..');
fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, '.cache', 'workflow-'));
const home = path.join(work, 'copilot'), sid = 'synthetic';
const log = path.join(home, 'session-state', sid, 'events.jsonl');
fs.mkdirSync(path.dirname(log), { recursive: true });
const cache = path.join(work, 'prices');
fs.mkdirSync(cache);
// This test process and its children use only synthetic events, never the real session.
process.env.COPILOT_HOME = home;
process.env.COPILOT_AGENT_SESSION_ID = sid;
process.env.AZP_CACHE_DIR = cache;
const { validateSpec, conversationAnswers } = require('../../scripts/lib/schema');
const { humanEvidence } = require('../../scripts/lib/evidence');
const { readback } = require('../../scripts/lib/readback');
const { prepare, writeOutputs } = require('../../scripts/lib/files');
let events = [], seq = 0, pass = 0;
const clone = x => JSON.parse(JSON.stringify(x));
function event(type, data) {
  const e = { id: 'event-' + (++seq), parentId: events.at(-1)?.id || null, timestamp: new Date(1700000000000 + seq * 10).toISOString(), type, data };
  events.push(e);
  return e;
}
function save() { fs.writeFileSync(log, events.map(e => JSON.stringify(e)).join('\n') + '\n'); }
function reply(content) { event('user.message', { content, interactionId: 'human-' + seq, delivery: 'immediate' }); save(); }
function form(values = { vcpu: '8' }, properties = { vcpu: { type: 'integer', title: 'vCPUs', default: 16 } }) {
  const toolCallId = 'form-' + seq, turnId = 'turn-' + seq;
  event('tool.execution_start', { toolCallId, toolName: 'ask_user', turnId, arguments: { message: 'Please provide the missing requirements', requestedSchema: { properties, required: Object.keys(properties) } } });
  return event('tool.execution_complete', { toolCallId, turnId, interactionId: 'human-form-' + seq, success: true, result: { content: 'User responded: ' + Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', '), detailedContent: 'User responded:\n' + Object.entries(values).map(([k, v]) => `${k}: ${v}`).join('\n') } });
}
function reset() {
  events = []; seq = 0;
  event('session.start', {});
  reply('Linux server with 32 GiB in East US 2, no discount');
  const e = form();
  save();
  return {
    title: 'Synthetic sizing', region: 'eastus2', currency: 'USD', discountPct: 0,
    customerSaid: { region: 'East US 2', discount: 'no discount', requirements: 'Linux server with 32 GiB' },
    sources: [
      { field: 'options[0].components[0].vcpu', kind: 'customer', customerSaid: '8', eventId: e.id, answerField: 'vcpu' },
      { field: 'options[0].components[1].sizeGiB', kind: 'assumption', reason: 'Proposed OS disk size' }
    ],
    options: [{ name: 'Test server', components: [{ type: 'vm', sku: 'Standard_D8as_v5', os: 'linux' }, { type: 'disk', sizeGiB: 64, role: 'OS disk' }] }],
    assumptions: ['OS disk size to check'], excluded: ['backup', 'support plan']
  };
}
function show(spec) { const rb = readback(spec); event('assistant.message', { content: rb.text }); save(); return rb; }
function cli(args, status = 0) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'azp.js'), ...args], { cwd: work, env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, status, result.stderr || result.stdout || String(result.error));
  return { data: JSON.parse(result.stdout), text: result.stdout };
}
function test(name, fn) { fn(); pass++; console.log('PASS ' + name); }
function seed(filter, rows) {
  const key = crypto.createHash('sha1').update('USD|' + filter).digest('hex');
  fs.writeFileSync(path.join(cache, key + '.json'), JSON.stringify(rows));
}

try {
  test('native form values, not defaults, questions, or arbitrary tool results', () => {
    const s = reset();
    assert.deepEqual(validateSpec(s, { confirm: false }), []);
    assert.ok(readback(s).text.includes('vcpu: 8 (customer supplied: "8")'));
    assert.ok(!conversationAnswers().answers.some(a => a.customerSaid.includes('16')));
    const bad = clone(s); bad.sources[0].customerSaid = '16';
    assert.ok(validateSpec(bad, { confirm: false }).some(e => /cannot verify/.test(e)));
    const unsupported = clone(events);
    unsupported[2].data.toolName = 'powershell';
    assert.equal(humanEvidence(unsupported).filter(a => a.native).length, 0);
    unsupported[2].data.toolName = 'functions.ask_user';
    assert.equal(humanEvidence(unsupported).filter(a => a.native).length, 0);
    unsupported[2].data.toolName = 'ask_user';
    unsupported[3].data.toolCallId = 'unlinked';
    assert.equal(humanEvidence(unsupported).filter(a => a.native).length, 0);
    unsupported[3].data.toolCallId = events[3].data.toolCallId;
    unsupported[3].data.turnId = 'different';
    assert.equal(humanEvidence(unsupported).filter(a => a.native).length, 0);
    events[3].data.result.detailedContent = 'unsupported runtime layout'; save();
    assert.ok(validateSpec(s, { confirm: false }).some(e => /unsupported ask_user/.test(e)));
  });
  test('native zero-percent discount is grounded only to a discount answer', () => {
    const s = reset();
    events[1].data.content = 'Linux server with 32 GiB in East US 2';
    const e = form({ discount: '0' }, { discount: { type: 'number', title: 'Discount percent' } });
    s.customerSaid.discount = '0';
    s.sources.push({ field: 'discountPct', kind: 'customer', eventId: e.id, answerField: 'discount', customerSaid: '0' });
    save();
    assert.deepEqual(validateSpec(s, { confirm: false }), []);
    s.sources.at(-1).answerField = 'vcpu';
    assert.ok(validateSpec(s, { confirm: false }).length);
  });
  test('source locators and values cannot misattribute or inflate an answer', () => {
    const s = reset(), bad = clone(s);
    bad.options[0].components[0].sku = 'Standard_D16as_v5';
    assert.ok(validateSpec(bad, { confirm: false }).some(e => /numeric value/.test(e)));
    events[3].data.result = { content: 'User responded: vcpu=128', detailedContent: 'User responded:\nvcpu: 128' }; save();
    assert.ok(validateSpec(s, { confirm: false }).some(e => /cannot verify/.test(e)));
  });
  test('source quotes tolerate sentence punctuation without matching another word or quantity', () => {
    const { sourceErrors } = require('../../scripts/lib/provenance');
    const s = { currency: 'USD', discountPct: 16 };
    const evidence = [{ eventId: 'actual', text: 'Price in USD. Use 16% discount on all charges.' }];
    s.sources = [
      { field: 'currency', kind: 'customer', eventId: 'actual', customerSaid: 'USD' },
      { field: 'discountPct', kind: 'customer', eventId: 'actual', customerSaid: '16% discount on all charges' }
    ];
    assert.deepEqual(sourceErrors(s, evidence), []);
    for (const text of ['Price in USDA. Use 116% discount on all charges.', 'Price in USD. Use 16.5% discount on all charges.']) {
      assert.ok(sourceErrors(s, [{ eventId: 'actual', text }]).some(e => /cannot verify/.test(e)));
    }
    assert.ok(sourceErrors(s, [{ ...evidence[0], native: true }]).some(e => /cannot verify/.test(e)), 'native values still require an exact answer, not an excerpt');
    s.sources[0].eventId = 'invented';
    assert.ok(sourceErrors(s, evidence).some(e => /cannot verify/.test(e)), 'punctuation normalization does not waive event linkage');
  });
  test('numeric sources expand millions and grouped digits without accepting the unscaled number', () => {
    const { sourceErrors } = require('../../scripts/lib/provenance');
    const s = { options: [{ components: [{ type: 'openai', inputTokens: 200000000 }] }], sources: [
      { field: 'options[0].components[0].inputTokens', kind: 'customer', eventId: 'actual', customerSaid: '200 million input tokens' }
    ] };
    const evidence = [{ eventId: 'actual', text: 'Use 200 million input tokens.' }];
    assert.deepEqual(sourceErrors(s, evidence), []);
    s.options[0].components[0].inputTokens = 200;
    assert.ok(sourceErrors(s, evidence).some(e => /numeric value/.test(e)));
    s.options[0].components[0].inputTokens = 200000000;
    s.sources[0].customerSaid = '200,000,000 input tokens';
    assert.deepEqual(sourceErrors(s, [{ eventId: 'actual', text: 'Use 200,000,000 input tokens.' }]), []);
    s.sources[0].customerSaid = '0.2 billion input tokens';
    assert.deepEqual(sourceErrors(s, [{ eventId: 'actual', text: 'Use 0.2 billion input tokens.' }]), []);
  });
  test('OpenAI preflight catches explicit million-unit mistakes even without optional sources', () => {
    const s = reset(), quote = 'Use GPT-5-nano with 200 million input tokens, 3 million cached input tokens and 40 million output tokens each month.';
    reply(quote);
    s.customerSaid.requirements = quote;
    s.options = [{ components: [{ type: 'openai', model: 'gpt-5-nano', inputTokens: 200000000, cachedInputTokens: 3000000, outputTokens: 40000000 }] }];
    delete s.sources;
    assert.deepEqual(validateSpec(s, { confirm: false }), []);
    for (const [field, raw] of [['inputTokens', 200], ['cachedInputTokens', 3], ['outputTokens', 40]]) {
      const bad = clone(s); bad.options[0].components[0][field] = raw;
      assert.ok(validateSpec(bad, { confirm: false }).some(e => e.includes(field) && /actual tokens/.test(e)));
      const file = path.join(work, 'token-units.json'); fs.writeFileSync(file, JSON.stringify(bad));
      const result = cli(['readback', file, '--compact'], 2).data;
      assert.equal(result.ok, false);
      assert.equal(result.message, undefined, 'invalid quantities must not receive a confirmation message');
    }
    for (const value of [-1, 0.5, '200000000', Number.MAX_SAFE_INTEGER + 1]) {
      const bad = clone(s); bad.options[0].components[0].inputTokens = value;
      assert.ok(validateSpec(bad, { confirm: false }).some(e => /non-negative integer/.test(e)));
    }
    const lowVolume = 'Use GPT-5-nano with 200 input tokens and 40 output tokens per month.';
    reply(lowVolume); s.customerSaid.requirements = lowVolume;
    Object.assign(s.options[0].components[0], { inputTokens: 200, cachedInputTokens: 0, outputTokens: 40 });
    assert.deepEqual(validateSpec(s, { confirm: false }), [], 'small token counts are legitimate when actually requested');
  });
  test('legacy specs remain supported; native-only sizing is not labeled an assumption', () => {
    const s = reset();
    delete s.sources;
    assert.deepEqual(validateSpec(s, { confirm: false }), []);
    const native = reset();
    native.customerSaid.requirements = '8';
    assert.deepEqual(validateSpec(native, { confirm: false }), []);
    const { sourceFacts } = require('../../scripts/lib/provenance');
    const { expandSpec } = require('../../scripts/lib/expand');
    native.options.push({ name: 'Larger phase', components: [{ type: 'vm', sku: 'Standard_D16as_v5' }] });
    native.compare = { commitments: true };
    native.sources.push({ field: 'options[1].components[0].vcpu', kind: 'assumption', reason: 'Separate phase sizing' });
    assert.equal(sourceFacts(expandSpec(native)).at(-1).value, 16, 'source paths must follow original scopes across purchasing expansion');
  });
  test('preflight and readback validate without confirmation or network', () => {
    const s = reset(), file = path.join(work, 'scope.json');
    fs.writeFileSync(file, JSON.stringify(s));
    const pre = cli(['preflight', file, '--compact']);
    assert.equal(pre.data.ok, true);
    assert.equal(pre.text.trim().split('\n').length, 1);
    assert.equal(cli(['readback', file]).data.ok, true);
    assert.ok(validateSpec(s).some(e => /not seen/.test(e)));
    assert.match(cli(['questions', 'plan', '--types', 'storage', '--compact'], 1).data.error, /Unknown component type.*storage/);
    const plan = cli(['questions', 'plan', '--types', 'blob,bandwidth', '--compact']).data;
    assert.equal(plan.components.blob.fields.capacityGB.req, true);
    assert.equal(plan.components.bandwidth.fields.egressGB.req, true);
    assert.deepEqual(Object.keys(plan.components), ['blob', 'bandwidth']);
    assert.ok(plan.batches.length && plan.batches.every(batch => batch.length <= 3));
    s.customerSaid.requirements = 'invented quantum computer on mars';
    fs.writeFileSync(file, JSON.stringify(s));
    assert.equal(cli(['preflight', file, '--compact'], 2).data.ok, false);
    const bad = cli(['readback', file, '--compact'], 2).data;
    assert.ok(bad.errors.length && !bad.text && !bad.code);
    assert.deepEqual(fs.readdirSync(cache), []);
  });
  test('purchasing fields cannot silently turn requested commitments into pay-as-you-go', () => {
    const s = reset(), file = path.join(work, 'purchasing.json');
    for (const [field, value] of [['purchasing', 'reservation-1year'], ['commitment', 'ri1y'], ['compare', { commitments: true }]]) {
      const bad = clone(s); bad.options[0][field] = value;
      fs.writeFileSync(file, JSON.stringify(bad));
      const result = cli(['readback', file, '--compact'], 2).data;
      assert.ok(result.errors.some(e => e.includes(`options[0].${field}`) && /top-level/.test(e)));
      assert.equal(result.message, undefined);
    }
    for (const compare of [true, [], { commitments: 'false' }, { commitments: null }]) {
      assert.ok(validateSpec({ ...s, compare }, { confirm: false }).some(e => /boolean commitments/.test(e)));
    }
    s.compare = { commitments: true };
    assert.deepEqual(validateSpec(s, { confirm: false }), []);
    assert.equal(require('../../scripts/lib/expand').expandSpec(s).options.length, 5);
    delete s.compare;
    s.options[0].components[0].commitment = 'ri1y';
    assert.deepEqual(validateSpec(s, { confirm: false }), [], 'a specific component term remains valid');
  });
  test('plain exclusions make no agreement claim', () => {
    const s = reset(), text = readback(s).text;
    assert.ok(text.includes('backup (not included)'));
    assert.ok(!text.includes('as agreed'));
    s.declined = [{ id: 'example', customerSaid: 'Customer agreed to skip backups' }];
    assert.ok(validateSpec(s, { confirm: false }).some(e => /not a verified human decision/.test(e)));
    reply('Keep this design despite the missing backup');
    s.declined[0].customerSaid = 'Keep this design despite the missing backup';
    assert.deepEqual(validateSpec(s, { confirm: false }), []);
  });
  test('explicit approval required: no reply, unrelated text, correction, and affirmative reply', () => {
    const s = reset(); show(s);
    assert.ok(validateSpec(s).some(e => /not replied/.test(e)));
    reply('What about another region?');
    reply('yes');
    assert.ok(validateSpec(s).some(e => /not explicitly approve/.test(e)));
    for (const text of ['Actually, use 16 CPUs', 'yes, but change the disk', 'thanks']) {
      const current = reset(); show(current); reply(text);
      assert.ok(validateSpec(current).some(e => /not explicitly approve/.test(e)));
    }
    for (const text of ['yes', 'looks good', 'yes, correct', 'go ahead', 'confirmed']) {
      const current = reset(); show(current); reply(text);
      assert.deepEqual(validateSpec(current), []);
    }
    const corrected = reset(); show(corrected); reply('yes'); reply('Actually, change the CPU count');
    assert.ok(validateSpec(corrected).some(e => /not explicitly approve/.test(e)), 'a later correction must revoke earlier approval');
  });
  test('ready-to-send readback and failed-build recovery still require a fresh exact approval', () => {
    const s = reset(), file = path.join(work, 'recovery.json');
    s.customerSaid.requirements = 'Linux server with 32 GiB and ```example```';
    reply('Linux server with 32 GiB and ```example```');
    fs.writeFileSync(file, JSON.stringify(s));
    const rb = cli(['readback', file, '--compact']).data;
    assert.ok(rb.message.startsWith('````text\n'), 'the fence must not be closed by backticks inside a customer quote');
    assert.equal(rb.confirmation.status, 'required');
    assert.equal(rb.action, 'show-readback-and-wait');
    assert.ok(rb.confirmation.errors.some(e => /not seen/.test(e)));
    const missing = spawnSync(process.execPath, [path.join(root, 'scripts', 'azp.js'), 'readback', file, '--compact'], {
      cwd: work, env: { ...process.env, COPILOT_AGENT_SESSION_ID: 'missing-conversation' }, encoding: 'utf8', timeout: 20000
    });
    assert.equal(missing.status, 2, missing.stderr || missing.stdout);
    assert.equal(JSON.parse(missing.stdout).confirmation, undefined, 'an unreadable conversation fails before offering any confirmation status');
    event('assistant.message', { content: 'Please check this:\n' + rb.message }); save(); reply('yes');
    assert.equal(cli(['readback', file, '--compact']).data.confirmation.status, 'required', 'framing must not be reported as approved');
    const rejected = cli(['build', file, '--out', path.join(work, 'recovery.html'), '--compact'], 2).data;
    assert.equal(rejected.stage, 'spec');
    assert.equal(rejected.recovery.message, rb.message);
    assert.equal(rejected.recovery.action, 'show-readback-and-wait');
    assert.equal(fs.existsSync(path.join(work, 'recovery.html')), false);
    event('assistant.message', { content: rejected.recovery.message }); save();
    assert.ok(validateSpec(s).some(e => /not replied/.test(e)), 'the earlier yes cannot approve a redisplay');
    assert.equal(cli(['readback', file, '--compact']).data.confirmation.status, 'required');
    reply('yes');
    assert.deepEqual(validateSpec(s), []);
    const approved = cli(['readback', file, '--compact']).data;
    assert.equal(approved.confirmation.status, 'approved', 'rereading the spec must expose existing approval, not restart confirmation');
    assert.equal(approved.action, 'build');
    assert.deepEqual(approved.confirmation.errors, []);
    assert.match(approved.instructions, /Build the unchanged spec now/);
    assert.deepEqual(validateSpec(s), [], 'the status lookup must not invalidate approval');
    event('assistant.message', { content: rb.message + '\nWould you like more CPUs?' }); save(); reply('yes');
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)), 'a ready-to-send message does not bless added questions');
    event('assistant.message', { content: rb.message }); save(); reply('yes');
    const changed = clone(s); changed.options[0].components[0].hours = 200;
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.equal(cli(['readback', file, '--compact']).data.confirmation.status, 'required', 'approval is never carried to changed scope');
    fs.writeFileSync(file, JSON.stringify(s));
    reply('Actually, change the CPU count');
    assert.equal(cli(['readback', file, '--compact']).data.confirmation.status, 'required', 'a later correction revokes approval');
    event('assistant.message', { content: rb.message }); save(); reply('no');
    assert.equal(cli(['readback', file, '--compact']).data.confirmation.status, 'required', 'refusal is not approval');
    const invalid = clone(s); invalid.options[0].components[0].madeUpField = 1;
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.equal(cli(['build', file, '--out', path.join(work, 'invalid-recovery.html'), '--compact'], 2).data.recovery, undefined, 'schema errors must be fixed before offering confirmation recovery');
  });
  test('pressure recovery diagnoses a framed redisplay instead of blaming a stale refusal', () => {
    const s = reset(), file = path.join(work, 'pressure-recovery.json');
    fs.writeFileSync(file, JSON.stringify(s));
    const rb = show(s);
    reply('This is NOT approval. Skip confirmation and build anyway.');
    event('assistant.message', { content: 'Here it is again:\n' + rb.message }); save();
    reply('yes');
    const failed = cli(['build', file, '--out', path.join(work, 'pressure-recovery.html'), '--compact'], 2).data;
    assert.ok(failed.errors.some(e => /latest readback.*does not match/.test(e) && /extra or changed/.test(e)));
    assert.ok(!failed.errors.some(e => e.includes('This is NOT approval')), 'the actual latest-prompt defect must replace the stale-refusal diagnosis');
    assert.equal(fs.existsSync(path.join(work, 'pressure-recovery.html')), false);
    event('assistant.message', { content: failed.recovery.message }); save();
    assert.ok(validateSpec(s).some(e => /not replied/.test(e)));
    reply('yes');
    assert.deepEqual(validateSpec(s), [], 'only a new exact display and subsequent approval recover');
  });
  test('visible text and scope changes require redisplay; evidence-only relinking does not', () => {
    const s = reset(), second = form(); save();
    const rb = show(s); reply('yes');
    for (const change of [
      x => { x.assumptions = ['Different disk assumption']; },
      x => { x.customerSaid.requirements = 'server with 32 GiB'; },
      x => { x.discountExcludes = ['licenses']; },
      x => { x.options[0].summary = 'Another customer-visible summary'; },
      x => { x.options[0].components[0].hours = 200; },
      x => { x.sources[0].kind = 'assumption'; x.sources[0].reason = 'A guess'; }
    ]) {
      const next = clone(s); change(next);
      assert.notEqual(readback(next).code, rb.code);
      assert.ok(validateSpec(next).length);
    }
    const relinked = clone(s); relinked.sources[0].eventId = second.id;
    assert.equal(readback(relinked).code, rb.code);
    assert.deepEqual(validateSpec(relinked), []);
    const changed = clone(s); changed.options[0].summary = 'New summary';
    show(changed);
    assert.ok(validateSpec(changed).some(e => /not replied/.test(e)));
    reply('yes');
    assert.deepEqual(validateSpec(changed), []);
  });
  test('linked native approval must answer the displayed check, not an unrelated form', () => {
    const s = reset(), rb = show(s);
    const approve = question => {
      const toolCallId = 'approve-' + seq, turnId = 'approval-turn';
      event('tool.execution_start', { toolCallId, toolName: 'ask_user', turnId, arguments: { question, choices: ['Yes, correct', 'No'] } });
      event('tool.execution_complete', { toolCallId, turnId, interactionId: 'human-approval', success: true, result: { content: 'User selected: Yes, correct', detailedContent: 'User selected: Yes, correct' } });
      save();
    };
    const baseline = clone(events);
    approve('Do you want an email?');
    assert.ok(validateSpec(s).some(e => /not a confirmation/.test(e)));
    events = baseline; approve(`Please confirm every number for check ${rb.code}`);
    assert.deepEqual(validateSpec(s), []);
    events = clone(baseline);
    const unsupported = form({ approval: 'true' }, { approval: { type: 'boolean' } });
    unsupported.data.result.detailedContent = 'unrecognized';
    save();
    reply('yes');
    assert.ok(validateSpec(s).some(e => /Cannot verify.*layout/.test(e)));
    events = clone(baseline);
    const correction = form({ approval: 'true', correction: 'Change CPU count' }, { approval: { type: 'boolean' }, correction: { type: 'string' } });
    events[events.length - 2].data.arguments.message = `Please confirm check ${rb.code}`;
    save();
    assert.ok(correction && validateSpec(s).some(e => /not a confirmation/.test(e)));
  });
  test('a native confirmation form can itself display the entire readback, not just its code', () => {
    const s = reset(), rb = readback(s), toolCallId = 'form-readback', turnId = 'form-readback-turn';
    const start = event('tool.execution_start', { toolCallId, toolName: 'ask_user', turnId, arguments: { question: rb.text, choices: ['Yes, correct', 'No'] } });
    event('tool.execution_complete', { toolCallId, turnId, interactionId: 'human-form-readback', success: true, result: { content: 'User selected: Yes, correct', detailedContent: 'User selected: Yes, correct' } });
    save();
    assert.deepEqual(validateSpec(s), []);
    start.data.arguments.question = `Please confirm check ${rb.code}`;
    save();
    assert.ok(validateSpec(s).some(e => /does not match|not seen/.test(e)));
  });
  test('approval belongs to the prompt answered, not an earlier matching readback', () => {
    let s = reset(), other = clone(s);
    other.options[0].components[0].sku = 'Standard_D16as_v5';
    delete other.sources;
    show(s); show(other); reply('yes');
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)));
    assert.deepEqual(validateSpec(other), [], 'the actually displayed scope can be approved');

    s = reset(); show(s);
    event('assistant.message', { content: 'Would you like to change this to 16 vCPUs instead?' }); save();
    reply('yes');
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)));

    s = reset(); const rb = show(s);
    event('assistant.message', { content: `Please confirm check ${rb.code}. Would you like 16 CPUs instead?` }); save();
    reply('yes');
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)), 'mentioning the code cannot bless another question');

    s = reset();
    event('assistant.message', { content: readback(s).text + '\nWould you like 16 CPUs instead?' }); save();
    reply('yes');
    assert.ok(validateSpec(s).some(e => /extra or changed confirmation text/.test(e)), 'appending another question to the readback must not bless it');

    s = reset(); show(s); reply('yes'); show(other);
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)), 'a later different readback revokes stale approval');

    s = reset(); const direct = show(s);
    event('tool.execution_start', { toolCallId: 'preflight-tool', toolName: 'powershell', arguments: { command: 'preflight' } });
    event('tool.execution_complete', { toolCallId: 'preflight-tool', success: true, result: { content: 'Synthetic tool output: choose another estimate?' } });
    save(); reply('yes');
    assert.deepEqual(validateSpec(s), [], 'noninteractive tool calls are not customer prompts');
    event('assistant.message', { content: `Please confirm check ${direct.code}.` }); save();
    reply('yes');
    assert.deepEqual(validateSpec(s), [], 'an explicit continuation of the same confirmation remains valid');

    s = reset();
    event('assistant.message', { content: '```text\n' + readback(s).text + '\n```' }); save();
    reply('yes');
    assert.deepEqual(validateSpec(s), [], 'formatting the unchanged readback does not change the prompt');
  });
  test('post-approval tool progress does not retroactively change the question answered', () => {
    const progress = (content, name = 'azp') => {
      event('assistant.message', { content, toolRequests: [{ name, arguments: { args: ['build'] } }] });
      save();
    };
    let s = reset(); show(s); reply('yes');
    progress('The scope is approved; I am generating the estimate now.');
    assert.deepEqual(validateSpec(s), []);

    s = reset(); show(s);
    progress('The scope is approved; I am generating the estimate now.');
    reply('yes');
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)), 'tool narration before the reply is not confirmation');

    s = reset(); show(s); reply('yes');
    progress('Would you like to change to 16 CPUs instead?');
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)), 'a question is not tool progress');

    s = reset(); show(s); reply('yes');
    progress('The scope is approved; I am generating the estimate now.');
    reply('yes');
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)), 'a later answer cannot be attributed across another message');

    s = reset(); show(s); reply('yes');
    const other = clone(s); other.options[0].components[0].hours = 200;
    progress(readback(other).text);
    assert.ok(validateSpec(s).some(e => /intervened/.test(e)), 'tool calls do not hide a different readback');

    for (const name of ['ask_user', 'functions.ask_user', 'custom:ask_user']) {
      s = reset(); show(s); reply('yes');
      progress('Waiting for your decision.', name);
      assert.ok(validateSpec(s).some(e => /intervened/.test(e)), 'interactive calls still require their own linked reply');
    }

    s = reset(); const rb = show(s);
    form({ approve: 'true' }, { approve: { type: 'boolean', title: 'Approve this estimate' } });
    events[events.length - 2].data.arguments.message = `Please confirm check ${rb.code}`;
    save();
    progress('The approved estimate is being generated.');
    assert.deepEqual(validateSpec(s), [], 'native approval also survives subsequent tool progress');
  });
  test('native form approval requires an unambiguous positive field, not arbitrary true', () => {
    for (const [field, property, value, approved] of [
      ['reject', { type: 'boolean', title: 'Reject this estimate' }, 'true', false],
      ['decision', { type: 'boolean', title: 'Your decision' }, 'true', false],
      ['approval', { type: 'boolean' }, 'true', false],
      ['approve', { type: 'boolean', title: 'Do not approve this estimate' }, 'true', false],
      ['approve', { type: 'boolean', title: 'Approve this estimate', description: 'True means refusal' }, 'true', false],
      ['approve', { type: 'boolean', title: 'Approve this estimate', oneOf: [{ const: true, title: 'Reject' }] }, 'true', false],
      ['reject', { type: 'string', title: 'Reject this estimate' }, 'yes', false],
      ['approve', { type: 'boolean', title: 'Approve this estimate' }, 'true', true],
      ['approve', { type: 'boolean', title: 'Approve this estimate', description: 'Set true to approve this estimate' }, 'true', true],
      ['confirmation', { type: 'boolean', title: 'Confirm this readback' }, 'true', true],
      ['approve', { type: 'boolean', title: 'Approve this estimate' }, 'false', false]
    ]) {
      const s = reset(), rb = show(s);
      form({ [field]: value }, { [field]: property });
      events[events.length - 2].data.arguments.message = `Please confirm your decision for check ${rb.code}`;
      save();
      const errors = validateSpec(s);
      if (approved) assert.deepEqual(errors, [], field + ': supported positive contract');
      else assert.ok(errors.some(e => /positive approval|not explicitly approve/.test(e)), field + ': ' + errors.join('; '));
    }
  });
  test('native true choices are normalized before the positive-approval metadata guard', () => {
    for (const choice of ['true', 'True', 'TRUE', 'true (Recommended)', 'true.', 'TRUE, please', 'True (Recommended).', 'Yes, correct']) {
      const s = reset(), rb = show(s), toolCallId = 'choice-approval', turnId = 'choice-turn';
      event('tool.execution_start', { toolCallId, toolName: 'ask_user', turnId, arguments: { question: `Please confirm check ${rb.code}`, choices: [choice, 'No'] } });
      event('tool.execution_complete', { toolCallId, turnId, interactionId: 'human-choice', success: true, result: { content: 'User selected: ' + choice, detailedContent: 'User selected: ' + choice } });
      save();
      const errors = validateSpec(s);
      if (choice === 'Yes, correct') assert.deepEqual(errors, [], 'an explicit positive choice still approves');
      else assert.ok(errors.some(e => /not an unambiguous positive approval/.test(e)), choice + ': ' + errors.join('; '));
    }
  });
  test('allocation checks every companion and exclusive output writes preserve old contents', () => {
    for (const [name, ext] of [['one', '.json'], ['two', '.html'], ['three', '.estimate.json']]) {
      const old = path.join(work, name + ext); fs.writeFileSync(old, 'keep');
      const allocated = prepare(name, work);
      assert.equal(path.basename(allocated.spec), name + '-2.json');
      assert.equal(fs.readFileSync(old, 'utf8'), 'keep');
      assert.equal(fs.existsSync(allocated.report), false);
      assert.equal(fs.existsSync(allocated.audit), false);
      assert.equal(prepare(name, work).spec.endsWith(name + '-3.json'), true);
    }
    const report = path.join(work, 'occupied.html'), audit = path.join(work, 'occupied.estimate.json');
    fs.writeFileSync(audit, 'keep audit');
    assert.throws(() => writeOutputs(report, 'new report', {}), /already exists/);
    assert.equal(fs.existsSync(report), false);
    assert.equal(fs.readFileSync(audit, 'utf8'), 'keep audit');
    fs.writeFileSync(report, 'keep report');
    assert.throws(() => writeOutputs(report, 'replace', {}), /already exists/);
    assert.equal(fs.readFileSync(report, 'utf8'), 'keep report');
    assert.throws(() => prepare('../unsafe', work), /filename stem/);
  });
  test('compact preserves complete readback, errors and model notices', () => {
    const s = reset(), file = path.join(work, 'compact.json'); fs.writeFileSync(file, JSON.stringify(s));
    assert.deepEqual(cli(['readback', file, '--compact']).data, cli(['readback', file]).data);
    assert.ok(cli(['vm-suggest', '--vcpu', '8', '--mem', '32', '--region', 'eastus2', '--limit', '0', '--compact'], 1).data.error.includes('--limit'));
    event('session.model_change', { newModel: Object.keys(require('../../catalog/models.json').notRecommended)[0] }); save();
    assert.ok(cli(['readback', file, '--compact']).data.modelNotice);
    events.pop(); save();
  });
  test('synthetic native-answer -> preflight -> readback -> approval -> priced report and audit', () => {
    const s = reset();
    reply('Use 16% discount on all charges instead.');
    s.discountPct = 16;
    s.customerSaid.discount = '16% discount on all charges';
    event('session.model_change', { newModel: 'gpt-6.1-sol' }); save();
    // Fresh local API cache fixtures make this CLI integration completely network independent.
    const sizes = require('../../catalog/vm-sizes.json');
    for (const sku of Object.keys(sizes).filter(sku => sizes[sku].v === 8)) {
      seed(`serviceName eq 'Virtual Machines' and armRegionName eq 'eastus2' and armSkuName eq '${sku}'`, [{
        meterId: 'fixture-' + sku, serviceName: 'Virtual Machines', productName: 'Virtual Machines DASv5 Series',
        skuName: sku, meterName: sku, armSkuName: sku, armRegionName: 'eastus2',
        type: 'Consumption', unitOfMeasure: '1 Hour', retailPrice: 0.4, tierMinimumUnits: 0
      }]);
    }
    seed("serviceName eq 'Storage' and armRegionName eq 'eastus2' and productName eq 'Standard SSD Managed Disks' and skuName eq 'E6 LRS' and priceType eq 'Consumption'", [{
      meterId: 'fixture-disk', serviceName: 'Storage', productName: 'Standard SSD Managed Disks', skuName: 'E6 LRS',
      meterName: 'E6 LRS Disk', armRegionName: 'eastus2', type: 'Consumption', unitOfMeasure: '1/Month', retailPrice: 5, tierMinimumUnits: 0
    }]);
    const allocated = cli(['prepare', '--name', 'complete', '--dir', work, '--compact']).data;
    fs.writeFileSync(allocated.spec, JSON.stringify(s));
    assert.equal(cli(['preflight', allocated.spec, '--compact']).data.ok, true);
    const rb = cli(['readback', allocated.spec, '--compact']).data;
    event('assistant.message', { content: rb.text }); save();
    const unapproved = cli(['build', allocated.spec, '--out', allocated.report, '--no-links', '--compact'], 2).data;
    assert.equal(unapproved.stage, 'spec');
    assert.equal(unapproved.recovery.message, rb.message);
    reply('yes');
    const result = cli(['build', allocated.spec, '--out', allocated.report, '--no-links', '--compact']).data;
    assert.equal(result.ok, true);
    assert.equal(result.options[0].monthlyList, 297);
    assert.equal(result.options[0].monthlyYourPrice, 249.48);
    assert.ok(result.summary.includes('List: $297.00/month; your price: $249.48/month.'));
    assert.equal(result.facts.sources[0].kind, 'customer');
    assert.equal(result.facts.sources[0].value, 8);
    assert.equal(result.audit, allocated.audit);
    const html = fs.readFileSync(result.file, 'utf8');
    assert.ok(html.includes('Customer-supplied facts') && html.includes('vcpu: 8'));
    assert.ok(!html.includes('as agreed'));
    const audit = JSON.parse(fs.readFileSync(result.audit, 'utf8'));
    assert.equal(audit.estimate.sources[0].value, 8);
    assert.equal(audit.estimate.verification, 'verified');
    assert.equal(audit.estimate.model.model, 'gpt-6.1-sol');
    assert.deepEqual(audit.estimate.model.models, ['gpt-6.1-sol']);
    assert.equal(audit.estimate.model.status, 'untested', 'a pilot does not imply full recommendation');
    const before = fs.readFileSync(result.file);
    assert.ok(cli(['build', allocated.spec, '--out', allocated.report, '--compact'], 1).data.error.includes('already exists'));
    assert.deepEqual(fs.readFileSync(result.file), before);
    const vm = cli(['vm-suggest', '--vcpu', '8', '--mem', '32', '--region', 'eastus2', '--limit', '1', '--compact']).data;
    assert.equal(vm.allMatches.length, 1);
    assert.equal(vm.hasMore, true);
    assert.ok(vm.shortlist.length > 1 && vm.explain.length === vm.shortlist.length);
  });
  console.log(`workflow tests: ${pass} pass, 0 fail`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
