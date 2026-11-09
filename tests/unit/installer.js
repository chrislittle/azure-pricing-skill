'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'azp-installer-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
const globalDir = path.join(home, '.copilot', 'skills');
const canonical = path.join(globalDir, 'azure-pricing');
const legacy = path.join(globalDir, 'azure-pricing-skill');
const local = path.join(project, '.github', 'skills', 'azure-pricing');
const stub = path.join(temp, 'fetch.js');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(stub, 'global.fetch = async () => ({ status: 200 });');

function run(args, expected = 0) {
  const result = spawnSync(process.execPath, ['--require', stub, path.join(root, 'scripts', 'cli.js'), ...args], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8'
  });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result.stdout;
}

function seed(dest) {
  fs.mkdirSync(path.join(dest, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: 'azure-pricing-skill', version: '1.2.0' }));
  fs.writeFileSync(path.join(dest, '.install-meta.json'), JSON.stringify({ version: '1.2.0' }));
  fs.writeFileSync(path.join(dest, 'scripts', 'lib', 'schema.js'), 'old engine');
}

function updated(dest) {
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'package.json'))).version, require('../../package.json').version);
  for (const file of ['SKILL.md', path.join('scripts', 'lib', 'schema.js'), 'MANIFEST.json']) {
    assert.deepEqual(fs.readFileSync(path.join(dest, file)), fs.readFileSync(path.join(root, file)), `${file} at ${dest}`);
  }
}

try {
  assert.ok(run(['update'], 1).includes('No existing install found'));
  seed(legacy);
  const output = run(['update']);
  assert.ok(output.includes(legacy), 'update must name the active legacy install');
  updated(legacy);
  assert.equal(fs.existsSync(canonical), false, 'updating must not create a duplicate global install');
  assert.ok(run(['status']).includes(legacy), 'status must find the legacy install');

  seed(canonical);
  seed(legacy);
  seed(local);
  run(['update', '--global']);
  updated(canonical);
  updated(legacy);
  assert.equal(fs.readFileSync(path.join(local, 'scripts', 'lib', 'schema.js'), 'utf8'), 'old engine');

  run(['update']);
  updated(local);
  const explicit = path.join(temp, 'custom');
  seed(explicit);
  run(['update', '--dir', explicit]);
  updated(explicit);
  console.log('Installer tests: legacy and canonical globals updated, scope respected, payload verified.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
