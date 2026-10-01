#!/usr/bin/env node
'use strict';
/*
 * azure-pricing-skill CLI: install / update / status / uninstall the skill.
 *
 *   npx github:chrislittle/azure-pricing-skill init                 Install into ./.github/skills/azure-pricing (project)
 *   npx github:chrislittle/azure-pricing-skill init --global        Install into ~/.copilot/skills/azure-pricing
 *   npx github:chrislittle/azure-pricing-skill init --dir <path>    Install into an explicit path
 *   npx github:chrislittle/azure-pricing-skill update               Re-install latest over an existing install
 *   npx github:chrislittle/azure-pricing-skill status               Show install locations + versions
 *   npx github:chrislittle/azure-pricing-skill uninstall            Remove an install (--global / --dir as needed)
 *   npx github:chrislittle/azure-pricing-skill doctor               Check prerequisites (Node, Azure price list reachable)
 *   npx github:chrislittle/azure-pricing-skill --version            Print version
 *
 * Flags:
 *   --force             Overwrite an existing install
 *
 * Node 18+. No runtime dependencies.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PKG_ROOT = path.resolve(__dirname, '..');
const NAME = 'azure-pricing';
const PAYLOAD = ['SKILL.md', 'README.md', 'LICENSE', 'package.json', 'icon.svg', 'MANIFEST.json', 'scripts', 'catalog', 'assets'];
const MIN_NODE = 18;
const PRICES = "https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Bandwidth'&$top=1";

function version() {
  try { return require(path.join(PKG_ROOT, 'package.json')).version; } catch (_) { return 'unknown'; }
}
function projectDest(base) { return path.join(base || process.cwd(), '.github', 'skills', NAME); }
function globalDest() { return path.join(os.homedir(), '.copilot', 'skills', NAME); }

function parse(argv) {
  const o = { cmd: 'help', global: false, dir: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['init', 'update', 'status', 'uninstall', 'doctor', 'help'].includes(a)) o.cmd = a;
    else if (a === '--version' || a === '-v') o.cmd = 'version';
    else if (a === '--help' || a === '-h') o.cmd = 'help';
    else if (a === '--global') o.global = true;
    else if (a === '--project') o.global = false;
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--force') o.force = true;
  }
  return o;
}

// ---- prerequisites --------------------------------------------------------
function nodeMajor() { return parseInt(process.versions.node.split('.')[0], 10); }

async function pricesReachable() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(PRICES, { signal: ctl.signal });
    clearTimeout(t);
    return r.status === 200;
  } catch (_) { return false; }
}

async function checkPrereqs() {
  return { nodeOk: nodeMajor() >= MIN_NODE, nodeVersion: process.versions.node, prices: await pricesReachable() };
}
function printPrereqs(p) {
  console.log('\nPrerequisites:');
  console.log(`  ${p.nodeOk ? 'OK ' : 'X  '} Node.js ${p.nodeVersion} ${p.nodeOk ? '(>=' + MIN_NODE + ')' : '(need >= ' + MIN_NODE + ')'}`);
  console.log(`  ${p.prices ? 'OK ' : 'X  '} Azure Retail Prices API (prices.azure.com) ${p.prices ? 'reachable' : 'NOT reachable: estimates need internet access to prices.azure.com'}`);
}

// ---- copy -----------------------------------------------------------------
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src)) {
      if (e === 'node_modules' || e === '.cache') continue;
      copyRecursive(path.join(src, e), path.join(dest, e));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function copyPayload(dest) {
  for (const item of PAYLOAD) {
    const src = path.join(PKG_ROOT, item);
    if (fs.existsSync(src)) copyRecursive(src, path.join(dest, item));
  }
}

function writeMeta(dest) {
  fs.writeFileSync(path.join(dest, '.install-meta.json'),
    JSON.stringify({ version: version(), installedAt: new Date().toISOString() }, null, 2));
}
function readMeta(dest) {
  try { return JSON.parse(fs.readFileSync(path.join(dest, '.install-meta.json'), 'utf8')); }
  catch (_) { return null; }
}

// ---- commands -------------------------------------------------------------
async function doInit(o) {
  const dest = o.dir ? path.resolve(o.dir) : (o.global ? globalDest() : projectDest());

  if (!o.dir && !o.global && !fs.existsSync(path.join(process.cwd(), '.git'))) {
    console.log('Note: no .git found in the current directory.');
    console.log('      Project install targets the CURRENT folder. cd into your repo first');
    console.log('      (or use --global to install for every folder).\n');
  }

  const prereq = await checkPrereqs();
  printPrereqs(prereq);
  if (!prereq.nodeOk) {
    console.error(`\nX  Node ${MIN_NODE}+ is required. Install it from https://nodejs.org/ and re-run.`);
    process.exitCode = 1;
    return;
  }

  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0 && !o.force) {
    console.error(`\nDestination already exists: ${dest}`);
    console.error('Re-run with --force to overwrite, or use `update`.');
    process.exitCode = 1;
    return;
  }

  copyPayload(dest);
  writeMeta(dest);

  console.log(`\nOK  Installed azure-pricing v${version()} -> ${dest}`);
  console.log('    Your agent can now discover the skill. Just ask it something like:');
  console.log('    "How much would a Linux server with 4 CPUs and 16 GB cost in Azure?"');
  console.log('    Recommended models: GPT-5.5, Claude Sonnet 5, Grok 4.5, GPT-5.4-mini (use /model).');
}

function doUpdate(o) {
  const targets = [];
  if (o.dir) targets.push(path.resolve(o.dir));
  else {
    if (fs.existsSync(projectDest())) targets.push(projectDest());
    if (fs.existsSync(globalDest())) targets.push(globalDest());
  }
  if (targets.length === 0) {
    console.log('No existing install found (project or global). Run `init` first.');
    return;
  }
  for (const dest of targets) {
    const prev = readMeta(dest);
    copyPayload(dest);
    writeMeta(dest);
    console.log(`OK  Updated ${dest} (${prev ? prev.version : '?'} -> ${version()})`);
  }
}

async function doStatus() {
  console.log(`azure-pricing v${version()}`);
  let found = false;
  for (const [label, dest] of [['project', projectDest()], ['global', globalDest()]]) {
    if (fs.existsSync(dest)) {
      found = true;
      const meta = readMeta(dest);
      console.log(`  [${label}] ${dest}`);
      console.log(`           version ${meta ? meta.version : '?'}, installed ${meta ? meta.installedAt : '?'}`);
    }
  }
  if (!found) console.log('  (no installs found: run `init`)');
  printPrereqs(await checkPrereqs());
}

function doUninstall(o) {
  const dest = o.dir ? path.resolve(o.dir) : (o.global ? globalDest() : projectDest());
  if (!fs.existsSync(dest)) { console.log(`Nothing to remove at ${dest}`); return; }
  fs.rmSync(dest, { recursive: true, force: true });
  console.log(`OK  Removed ${dest}`);
}

async function doDoctor() {
  console.log(`azure-pricing v${version()}: environment check`);
  const p = await checkPrereqs();
  printPrereqs(p);
  console.log('\nThe skill needs only Node ' + MIN_NODE + '+ and internet access to prices.azure.com.');
  console.log('No Azure sign-in, subscription or API key is required.');
  if (p.nodeOk && p.prices) console.log('\nOK  Ready.');
}

function help() {
  console.log(`azure-pricing v${version()}

Usage:
  npx github:chrislittle/azure-pricing-skill init [--global|--dir <path>] [--force]
  npx github:chrislittle/azure-pricing-skill update
  npx github:chrislittle/azure-pricing-skill status
  npx github:chrislittle/azure-pricing-skill uninstall [--global|--dir <path>]
  npx github:chrislittle/azure-pricing-skill doctor
  npx github:chrislittle/azure-pricing-skill --version

Install targets:
  (default) project  ->  ./.github/skills/azure-pricing   (cd into your repo first)
  --global           ->  ~/.copilot/skills/azure-pricing
  --dir <path>       ->  an explicit path

After install, just ask your agent: "How much would this cost in Azure?"`);
}

async function main() {
  const o = parse(process.argv.slice(2));
  switch (o.cmd) {
    case 'init': await doInit(o); break;
    case 'update': doUpdate(o); break;
    case 'status': await doStatus(); break;
    case 'uninstall': doUninstall(o); break;
    case 'doctor': await doDoctor(); break;
    case 'version': console.log(version()); break;
    default: help();
  }
}

main();
