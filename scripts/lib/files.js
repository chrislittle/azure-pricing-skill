'use strict';
const fs = require('fs'), path = require('path');

function pathsFor(spec) {
  const base = spec.replace(/\.json$/i, '');
  return { spec: path.resolve(spec), report: path.resolve(base + '.html'), audit: path.resolve(base + '.estimate.json') };
}

function prepare(name, dir = '.') {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('prepare needs --name <filename stem> (letters, numbers, dots, underscores or hyphens; no path).');
  if (!fs.statSync(dir).isDirectory()) throw new Error('--dir must be an existing directory.');
  for (let i = 0; i < 10000; i++) {
    const paths = pathsFor(path.join(dir, `${name}${i ? '-' + (i + 1) : ''}.json`));
    if (Object.values(paths).some(p => fs.existsSync(p))) continue;
    try { fs.writeFileSync(paths.spec, '{}\n', { flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    return { ok: true, ...paths, instructions: 'Paths are allocated; no estimate is built. Write the spec into this spec file, run preflight and readback, send readback.message alone, and wait for explicit human approval before build. Use exactly these report and audit paths; build refuses to overwrite either output.' };
  }
  throw new Error('Could not allocate unused estimate paths.');
}

function writeOutputs(report, html, audit) {
  if (!/\.html$/i.test(report)) throw new Error('--out must end in .html.');
  const auditPath = report.replace(/\.html$/i, '') + '.estimate.json';
  // Acquire both files exclusively before writing either; never truncate an old estimate.
  const owned = [], handles = [];
  try {
    for (const file of [report, auditPath]) {
      handles.push(fs.openSync(file, 'wx'));
      owned.push(file);
    }
    fs.writeFileSync(handles[0], html);
    fs.writeFileSync(handles[1], JSON.stringify(audit, null, 2));
  } catch (e) {
    for (const handle of handles) fs.closeSync(handle);
    for (const file of owned) fs.unlinkSync(file);
    if (e.code === 'EEXIST') throw new Error('Output already exists; run prepare to allocate new spec/report paths and never reuse an old estimate.');
    throw e;
  }
  for (const handle of handles) fs.closeSync(handle);
  return path.resolve(auditPath);
}

module.exports = { prepare, writeOutputs, pathsFor };
