'use strict';
// Release tool, NOT shipped with the skill: records the engine fingerprint in MANIFEST.json.
// usage: node tests/tools/seal.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SKILL = path.resolve(__dirname, '..', '..');
const h = crypto.createHash('sha256');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (/\.(js|json|html)$/.test(e.name)) h.update(e.name + '\0' + fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
});
walk(path.join(SKILL, 'scripts')); walk(path.join(SKILL, 'catalog')); walk(path.join(SKILL, 'assets'));
const fp = h.digest('hex').slice(0, 16);
fs.writeFileSync(path.join(SKILL, 'MANIFEST.json'), JSON.stringify({ fingerprint: fp, sealed: new Date().toISOString() }, null, 2) + '\n');
console.log(JSON.stringify({ sealed: fp }));
