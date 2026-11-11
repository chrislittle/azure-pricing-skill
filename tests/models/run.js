'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify, parseArgs } = require('node:util');
const { resolveModels, scopeErrors, grade, toolPermission, engineArgumentError, caseSelection } = require('./checks');
const { confirmationScope } = require('../../scripts/lib/readback');
const roster = require('../../catalog/models.json').current;
const scenarios = require('./scenarios.json').scenarios;
const root = path.resolve(__dirname, '..', '..');
const execute = promisify(execFile);

function digest(directory) {
  const hash = crypto.createHash('sha256');
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else hash.update(path.relative(directory, file)).update(fs.readFileSync(file));
    }
  }
  walk(directory);
  return hash.digest('hex');
}

function readbackShown(text, readback) {
  const normalize = s => s.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
  return typeof readback === 'string' && normalize(text).includes(normalize(readback));
}

function sameConfirmationScope(spec, previous) {
  return !!previous && JSON.stringify(confirmationScope(spec)) === JSON.stringify(confirmationScope(previous));
}

function clarificationPrompt(scenario, correctionSent) {
  return (correctionSent ? scenario.correction : scenario.answers || scenario.opening) +
    " I do not know anything else. If more context is needed, propose the engine's documented defaults as assumptions in the readback; do not invent customer answers.";
}

async function trial(client, defineTool, model, scenario, runDir, timeoutMs) {
  const directory = path.join(runDir, model.resolvedId, scenario.id);
  const skill = path.join(directory, 'skill'), work = path.join(directory, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(skill);
  for (const name of ['scripts', 'catalog', 'assets', 'SKILL.md', 'MANIFEST.json']) {
    fs.cpSync(path.join(root, name), path.join(skill, name), { recursive: true });
  }
  const before = digest(skill), allocations = new Map(), transcript = [];
  let session, lastReadback, approved = false, prematureBuild = false, correctionSent = false;
  let answersSent = false, clarificationSent = false, refusalSent = false, pressureSent = false;
  let built, finalSpec, finalText = '', timeout;
  const started = Date.now(), home = path.join(runDir, 'copilot');
  const result = { model: model.resolvedId, scenario: scenario.id, internalOnly: !!model.internalOnly, skillDigest: before, status: 'failed', errors: [] };
  function record(entry) {
    transcript.push(entry);
    fs.writeFileSync(path.join(directory, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
  }
  function rejectTool(tool, error) {
    record({ tool, error });
    return { resultType: 'failure', textResultForLlm: error, error };
  }
  try {
    const tools = [
      defineTool('azp', {
        description: 'Run the unmodified Azure pricing engine. Supply command-line arguments without node or the script path. Outputs are full engine JSON.',
        parameters: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] },
        handler: async ({ args }, invocation) => {
          const argumentError = engineArgumentError(args);
          if (argumentError) return rejectTool('azp', argumentError);
          const command = args[0];
          if (!['questions', 'answers', 'models', 'vm-suggest', 'search', 'prepare', 'preflight', 'readback', 'build'].includes(command)) return rejectTool('azp', 'Unsupported engine command.');
          if (command === 'build' && !approved) prematureBuild = true;
          if (command === 'prepare') {
            const dirIndex = args.indexOf('--dir');
            if (dirIndex >= 0) {
              if (args.lastIndexOf('--dir') !== dirIndex || path.resolve(work, args[dirIndex + 1] || '') !== work) return rejectTool('azp', 'The adapter allocates only in the trial workspace.');
            } else args = [...args, '--dir', work];
          }
          if (['preflight', 'readback', 'build'].includes(command)) {
            if (!allocations.has(path.resolve(work, args[1] || ''))) return rejectTool('azp', 'Use a spec returned by prepare.');
            args = [...args];
            args[1] = path.resolve(work, args[1]);
          }
          if (command === 'build') {
            const allocated = allocations.get(path.resolve(work, args[1]));
            const outIndex = args.indexOf('--out');
            if (outIndex < 0 || args.lastIndexOf('--out') !== outIndex || path.resolve(work, args[outIndex + 1] || '') !== allocated.report) return rejectTool('azp', 'Use the report path returned by prepare.');
            args = [...args, '--no-links'];
          }
          let stdout;
          try {
            ({ stdout } = await execute(process.execPath, [path.join(skill, 'scripts', 'azp.js'), ...args], {
              cwd: work, env: { ...process.env, COPILOT_HOME: home, COPILOT_AGENT_SESSION_ID: invocation.sessionId, AZP_CACHE_DIR: path.join(runDir, 'prices') },
              timeout: Math.max(1, Math.min(120000, timeoutMs - (Date.now() - started))), maxBuffer: 8 * 1024 * 1024
            }));
          } catch (error) {
            if (typeof error.code !== 'number' || !error.stdout) throw error;
            stdout = error.stdout;
          }
          const output = JSON.parse(stdout);
          record({ tool: 'azp', args, output });
          if (command === 'prepare') allocations.set(path.resolve(output.spec), output);
          if (command === 'readback' && output.ok) {
            lastReadback = { text: output.text, spec: JSON.parse(fs.readFileSync(args[1], 'utf8')) };
          }
          if (command === 'build' && output.file) {
            built = output;
            finalSpec = JSON.parse(fs.readFileSync(args[1], 'utf8'));
          }
          return output;
        }
      }),
      defineTool('write_spec', {
        description: 'Write the complete spec JSON into a file already allocated by azp prepare. Supply spec as a JSON-encoded string, not an object. The skill and session files are not writable.',
        parameters: { type: 'object', properties: { file: { type: 'string' }, spec: { type: 'string', description: 'The complete specification serialized as valid JSON, including options and their component objects.' } }, required: ['file', 'spec'] },
        handler: async ({ file, spec }) => {
          if (typeof file !== 'string' || typeof spec !== 'string') return rejectTool('write_spec', 'write_spec requires file as an allocated path and spec as a JSON-encoded string.');
          try { spec = JSON.parse(spec); }
          catch (error) { return rejectTool('write_spec', 'spec must be valid JSON: ' + error.message); }
          if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return rejectTool('write_spec', 'The decoded spec must be a JSON object.');
          file = path.resolve(work, file);
          if (!allocations.has(file)) return rejectTool('write_spec', 'Use a spec path returned by prepare.');
          const unchanged = sameConfirmationScope(spec, lastReadback?.spec);
          fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
          if (!unchanged) {
            approved = false;
            lastReadback = null;
          }
          record({ tool: 'write_spec', spec });
          return { ok: true, file };
        }
      })
    ];
    session = await client.createSession({
      model: model.resolvedId, workingDirectory: work, configDirectory: home, enableConfigDiscovery: false,
      availableTools: ['custom:azp', 'custom:write_spec'], tools,
      onPermissionRequest: toolPermission,
      systemMessage: {
        mode: 'append',
        content: `Follow this pricing skill:\n${fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8')}\n` +
          `The skill folder is ${skill}. This test environment provides azp and write_spec adapters instead of a terminal. ` +
          'Use azp with the same arguments as the documented engine commands, and write_spec to save a prepared spec. ' +
          'Ask questions and show readback text in normal assistant messages, then stop for the customer reply. ' +
          'The build adapter skips URL link checking only; all engine verification and pricing remain enabled.'
      }
    });
    result.sessionId = session.sessionId;
    async function converse() {
      let prompt = scenario.opening;
      for (let turn = 0; turn < 8; turn++) {
        record({ role: 'user', content: prompt });
        const reply = await session.sendAndWait({ prompt }, timeoutMs);
        finalText = reply?.data.content || '';
        record({ role: 'assistant', content: finalText });
        if (built) return;
        if (refusalSent) {
          if (prematureBuild) throw new Error('Attempted to build despite refused approval.');
          if (!finalText.trim()) throw new Error('No response acknowledging refused approval.');
          result.outcome = 'stopped-without-report';
          return;
        }
        if (readbackShown(finalText, lastReadback?.text)) {
          if (scenario.correction && !correctionSent) {
            correctionSent = true;
            prompt = scenario.correction;
          } else {
            const errors = scopeErrors(lastReadback.spec, scenario.expected);
            if (errors.length) throw new Error('Readback has incorrect scope: ' + errors.join('; '));
            if (scenario.refusal) {
              refusalSent = true;
              prompt = scenario.refusal;
            } else if (scenario.pressure && !pressureSent) {
              pressureSent = true;
              clarificationSent = false;
              prompt = scenario.pressure;
            } else {
              approved = true;
              prompt = 'yes';
            }
          }
        } else if (scenario.answers && !answersSent) {
          answersSent = true;
          prompt = scenario.answers;
        } else if (scenario.pressure && pressureSent && !clarificationSent) {
          clarificationSent = true;
          prompt = 'Please show me the complete readback again so I can decide whether to approve it.';
        } else if (!pressureSent && !clarificationSent) {
          clarificationSent = true;
          prompt = clarificationPrompt(scenario, correctionSent);
        } else {
          throw new Error('No complete engine readback was shown for approval.');
        }
      }
      throw new Error('Conversation exceeded eight customer turns.');
    }
    await Promise.race([
      converse(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Trial timed out.')), timeoutMs); })
    ]);
    if (result.outcome === 'stopped-without-report') {
      if (!refusalSent || built || prematureBuild) throw new Error('Refused approval did not prevent report creation.');
      return result;
    }
    if (!built) throw new Error('No report was produced.');
    const audit = JSON.parse(fs.readFileSync(built.audit, 'utf8')), html = fs.readFileSync(built.file, 'utf8');
    result.errors = grade({ spec: finalSpec, audit, html, build: built, expected: scenario.expected, requestedModel: model.resolvedId, approved, prematureBuild, finalText });
    if (scenario.correction && !correctionSent) result.errors.push('Required correction was not exercised.');
    if (scenario.answers && !answersSent) result.errors.push('Required missing-input interview was not exercised.');
    if (scenario.pressure && !pressureSent) result.errors.push('Approval pressure was not exercised.');
    result.fingerprint = audit.estimate.fingerprint;
    result.totals = built.options;
  } catch (error) {
    result.errors.push(error.message);
    result.failureKind = /timed out|timeout|ETIMEDOUT/i.test(error.message) ? 'timeout' : !session ? 'initialization' : 'conversation-or-tool';
  } finally {
    clearTimeout(timeout);
    if (session) {
      try { await session.abort(); } catch (error) { result.errors.push('Session abort failed: ' + error.message); }
      try { await session.disconnect(); } catch (error) { result.errors.push('Session disconnect failed: ' + error.message); }
    }
    if (digest(skill) !== before) result.errors.push('Runtime files changed during the trial.');
    result.durationMs = Date.now() - started;
    const log = path.join(home, 'session-state', result.sessionId || 'missing', 'events.jsonl');
    if (fs.existsSync(log)) {
      const observed = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
        .filter(e => e.type === 'assistant.message' && typeof e.data?.model === 'string').map(e => e.data.model);
      result.observedModels = [...new Set(observed)];
      if (!result.observedModels.includes(model.resolvedId) || result.observedModels.some(m => m !== model.resolvedId)) result.errors.push('Conversation log does not confirm the requested model.');
    } else result.errors.push('No persisted conversation log.');
    result.status = result.errors.length ? 'failed' : 'passed';
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

async function main() {
  const { values } = parseArgs({ options: {
    list: { type: 'boolean' }, all: { type: 'boolean' }, models: { type: 'string' },
    scenarios: { type: 'string' }, timeout: { type: 'string', default: '240' },
    jobs: { type: 'string', default: '1' }, resume: { type: 'string' }, 'list-cases': { type: 'boolean' },
    'cases-from': { type: 'string' }, 'try-unlisted': { type: 'boolean' }
  } });
  if (values['list-cases']) { console.log(scenarios.map(s => s.id).join('\n')); return; }
  if ((!values.list && !values.models && !values.all && !values['cases-from']) ||
      [values.models, values.all, values['cases-from']].filter(Boolean).length > 1 ||
      (values['cases-from'] && values.scenarios)) {
    throw new Error('Usage: npm run test:models -- --list | --list-cases | --models id,id | --all | --cases-from pairs.json [--scenarios id,id] [--timeout seconds] [--jobs 1..8] [--resume run-directory]. Selection modes are mutually exclusive. Trials consume AI credits.');
  }
  const seconds = Number(values.timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error('--timeout must be 1..1800 seconds per trial.');
  const jobs = Number(values.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('--jobs must be 1..8.');
  const selectedPairs = values['cases-from'] ? caseSelection(JSON.parse(fs.readFileSync(values['cases-from'], 'utf8')), scenarios.map(s => s.id)) : null;
  const requested = selectedPairs ? [...new Set(selectedPairs.map(p => p.model))] : values.models?.split(',');
  if (values['try-unlisted'] && (!requested || values.list)) throw new Error('--try-unlisted requires explicit --models or --cases-from selection, not --all or --list.');
  const selectedScenarios = values.scenarios?.split(',');
  if (selectedScenarios?.some(id => !scenarios.some(s => s.id === id))) throw new Error('Unknown scenario ID.');
  const runDir = values.resume ? path.resolve(values.resume) : path.join(root, '.cache', 'model-tests', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8));
  const signature = crypto.createHash('sha256');
  for (const file of [__filename, path.join(__dirname, 'checks.js'), path.join(__dirname, 'scenarios.json'), path.join(root, 'SKILL.md'), path.join(root, 'MANIFEST.json')]) signature.update(fs.readFileSync(file));
  const suiteHash = signature.digest('hex');
  const previous = values.resume ? JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8')) : null;
  if (previous && previous.suiteHash !== suiteHash) throw new Error('The runner, cases or skill changed; start a new run instead of mixing results.');
  const { CopilotClient, defineTool } = require('@github/copilot-sdk');
  fs.mkdirSync(runDir, { recursive: true });
  // Keep authentication in memory; never copy the user's config or credential files.
  const token = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const clientOptions = { mode: 'empty', baseDirectory: path.join(runDir, 'copilot'), gitHubToken: token, logLevel: 'error' };
  let client = new CopilotClient(clientOptions);
  const pkg = require('../../package.json');
  const report = previous || { version: pkg.version, sdkVersion: pkg.devDependencies['@github/copilot-sdk'], started: new Date().toISOString(), scope: require('./scenarios.json').scope, suiteHash, roster: [], results: [] };
  delete report.completed;
  try {
    await client.start();
    report.runtimeVersion = (await client.getStatus()).version;
    report.roster = resolveModels(roster, await client.listModels(), values['try-unlisted'] ? requested : []);
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    if (values.list) {
      console.log(JSON.stringify({ roster: report.roster, results: path.join(runDir, 'results.json') }, null, 2));
      return;
    }
    if (values['try-unlisted']) {
      // Discovery can cache a shorter catalog than direct session creation accepts.
      // Keep its policy checks, but use an unprimed runtime for explicit requests.
      await client.stop();
      client = new CopilotClient(clientOptions);
      await client.start();
    }
    if (requested?.some(id => !report.roster.some(m => m.id === id || m.resolvedId === id))) throw new Error('Unknown model ID; use --list to discover IDs.');
    const targets = report.roster.filter(m => values.all || requested.includes(m.id) || requested.includes(m.resolvedId));
    const tasks = [];
    for (const model of targets) {
      if (!model.available) {
        if (!report.results.some(r => r.model === (model.id || model.name) && r.status === 'unavailable')) report.results.push({ model: model.id || model.name, status: 'unavailable', internalOnly: !!model.internalOnly, errors: ['Not enabled or not exposed by the live SDK catalog. No model was substituted.'] });
        process.exitCode = 1;
      } else {
        for (const scenario of scenarios.filter(s => (!selectedScenarios || selectedScenarios.includes(s.id)) &&
          (!selectedPairs || selectedPairs.some(p => (p.model === model.resolvedId || p.model === model.id) && p.scenario === s.id)))) {
          if (!report.results.some(r => r.model === model.resolvedId && r.scenario === scenario.id)) tasks.push({ model, scenario });
        }
      }
    }
    report.plannedCases = [...new Map([
      ...(report.plannedCases || []),
      ...report.results.filter(r => r.scenario).map(r => ({ model: r.model, scenario: r.scenario })),
      ...tasks.map(t => ({ model: t.model.resolvedId, scenario: t.scenario.id }))
    ].map(p => [JSON.stringify([p.model, p.scenario]), p])).values()];
    report.plannedTrials = report.plannedCases.length;
    report.scheduledThisInvocation = tasks.length;
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Running ${tasks.length} conversation(s), ${jobs} at a time. Results: ${path.join(runDir, 'results.json')}`);
    async function worker() {
      while (tasks.length) {
        const { model, scenario } = tasks.shift();
        console.log(`Testing ${model.resolvedId}: ${scenario.id}`);
        const result = await trial(client, defineTool, model, scenario, runDir, seconds * 1000);
        report.results.push(result);
        console.log(`${result.status}: ${result.errors.join('; ') || scenario.id}`);
        if (result.status !== 'passed') process.exitCode = 1;
        fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
      }
    }
    await Promise.all(Array.from({ length: jobs }, () => worker()));
    if (report.results.some(r => r.status !== 'passed')) process.exitCode = 1;
  } finally {
    report.completed = new Date().toISOString();
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Results: ${path.join(runDir, 'results.json')}`);
    await client.stop();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { readbackShown, sameConfirmationScope, clarificationPrompt, trial };
