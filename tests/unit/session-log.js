'use strict';
// The tamper check must accept real Copilot session logs (auto mode, compaction, internal events)
// and still reject hand-written or edited user messages.
// usage: node tests/unit/session-log.js
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const cache = path.resolve(__dirname, '..', '..', '.cache');
fs.mkdirSync(cache, { recursive: true });
const home = fs.mkdtempSync(path.join(cache, 'azp-log-'));
const sid = 'test-session';
fs.mkdirSync(path.join(home, 'session-state', sid), { recursive: true });
process.env.COPILOT_HOME = home;
process.env.COPILOT_AGENT_SESSION_ID = sid;
const { validateSpec, verificationStatus } = require('../../scripts/lib/schema');

const spec = { region: 'eastus2', discountPct: 16, customerSaid: { region: 'East US 2', discount: 'We get 16% off list', requirements: 'Red Hat server with 64 GB of RAM' }, options: [] };
const base = Date.parse('2026-11-09T12:00:00.000Z');
const ts = ms => new Date(base + ms).toISOString();
const userData = extra => Object.assign({ content: 'Red Hat server with 64 GB of RAM in East US 2, we get 16% off list', interactionId: 'i1', delivery: 'immediate', supportedNativeDocumentMimeTypes: [] }, extra);

function status(events) {
  fs.writeFileSync(path.join(home, 'session-state', sid, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  validateSpec(spec, { confirm: false });
  return verificationStatus();
}

const modern = () => [
  { id: 'a', parentId: null, timestamp: ts(2), type: 'session.start', data: {} },
  { id: 'b', parentId: 'a', timestamp: ts(0), type: 'session.model_change', data: {} },
  { id: 'c', parentId: 'b', timestamp: ts(10), type: 'session.usage_checkpoint', data: {} },
  { id: 'd', parentId: 'c', timestamp: ts(20), type: 'user.message', data: userData() },
  { id: 'e', parentId: 'gone', timestamp: ts(30), type: 'model.turn_started', data: {} }
];

assert.equal(status(modern()), 'verified', 'real Copilot shape must verify');

let ev = modern(); ev[3].data.delivery = 'steering'; delete ev[3].data.supportedNativeDocumentMimeTypes;
assert.equal(status(ev), 'verified', 'steering message typed mid-turn must verify');

ev = modern(); delete ev[3].data.delivery;
assert.equal(status(ev), 'tampered', 'user message without delivery fields');

ev = modern(); ev[3].parentId = 'nope';
assert.equal(status(ev), 'tampered', 'user message with unknown parent');

ev = modern(); ev[3].data.interactionId = '';
assert.equal(status(ev), 'tampered', 'user message without interactionId');

ev = modern(); ev[4].timestamp = ts(-60000);
assert.equal(status(ev), 'tampered', 'timestamp far out of order');

ev = modern(); ev[4].id = 'd';
assert.equal(status(ev), 'tampered', 'duplicate event id');

ev = modern(); ev[3].data.transformedContent = 'something the person never typed';
assert.equal(status(ev), 'tampered', 'content differs from transformedContent');

fs.rmSync(home, { recursive: true, force: true });
console.log('Session-log tamper check: accepts real Copilot logs, rejects forged ones.');
