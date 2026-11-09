'use strict';
// Component schema: the single source of truth for what each component needs,
// what to ask a customer, and sensible defaults. Used by `azp questions` and spec validation.
const S = {
  vm: { label: 'Virtual machine', fields: {
    sku: { req: true, ask: 'Do not ask for a SKU. Ask vCPU, memory, workload type; then run `azp vm-suggest`.' },
    os: { def: 'linux', enum: ['linux', 'windows', 'windows-ahb', 'rhel', 'rhel-byos', 'sles'], ask: 'Which operating system? If Windows: do you own Windows Server licenses with Software Assurance? If Red Hat: do you already have Red Hat subscriptions?' },
    count: { def: 1, ask: 'How many identical servers?' },
    hours: { def: 730, ask: 'Does it run all the time, or only part of the day? (730 hours = always on)' },
    commitment: { def: 'payg', enum: ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y'], ask: 'Pay-as-you-go, or compare 1- and 3-year reservations and savings plans? Only worth it if it runs most of the month.' } } },
  disk: { label: 'Managed disk', fields: {
    diskType: { def: 'standard-ssd', enum: ['standard-hdd', 'standard-ssd', 'premium-ssd', 'premium-v2'], ask: 'Do not ask for a disk type. Ask how much space and whether it needs to be fast (database, heavy I/O) or just hold data. Map: plain -> standard-ssd; fast -> premium-ssd; fast and large or precise IOPS -> premium-v2.' },
    sizeGiB: { req: true, ask: 'How much disk space (GB)?' },
    iops: { ask: 'Only if performance matters: required IOPS / throughput, if known.' },
    throughputMBps: {},
    redundancy: { def: 'LRS', enum: ['LRS', 'ZRS'], ask: 'Must the disk survive a datacenter (zone) failure? If yes ZRS (costs ~50% more).' },
    count: { def: 1 }, role: { ask: 'Label it: OS disk or data disk.' } } },
  'public-ip': { label: 'Public IP', fields: { count: { def: 1 }, hours: { def: 730 } } },
  bandwidth: { label: 'Internet egress', fields: { egressGB: { req: true, ask: 'Roughly how much data goes out to the internet each month? If unknown, use 100 GB and set guess:true.' }, guess: { def: false } } },
  'load-balancer': { label: 'Standard Load Balancer', fields: { rules: { def: 5 }, processedGB: { def: 0, ask: 'Approximate GB per month through the load balancer.' }, hours: { def: 730 } } },
  'app-gateway': { label: 'Application Gateway v2', fields: { waf: { def: true, ask: 'Public web app? WAF (web application firewall) is recommended.' }, capacityUnits: { def: 1, ask: 'Average capacity units; 1-2 for small sites.' }, hours: { def: 730 } } },
  aks: { label: 'AKS cluster management', fields: { tier: { def: 'free', enum: ['free', 'standard', 'premium'], ask: 'Is this production that needs an uptime SLA? Production -> standard. Nodes are separate "vm" + "disk" components.' }, hours: { def: 730 } } },
  'app-service': { label: 'App Service plan', fields: { plan: { req: true, ask: 'Ask CPU/memory per instance, then map: 1/4 P0v3, 2/8 P1v3, 4/16 P2v3, 8/32 P3v3, 2/16 P1mv3.' }, os: { def: 'linux', enum: ['linux', 'windows'] }, count: { def: 1, ask: 'How many instances (2+ for redundancy)?' }, hours: { def: 730 } } },
  functions: { label: 'Azure Functions', fields: { plan: { def: 'consumption', enum: ['consumption', 'flex'] }, executions: { req: true, ask: 'Calls per month?' }, gbSeconds: { ask: 'Or give durationMs and memoryMB per call and the engine computes GB-seconds.' }, durationMs: {}, memoryMB: {} } },
  'container-apps': { label: 'Container Apps (consumption)', fields: { apps: { def: 1 }, vcpu: { def: 0.5 }, memGiB: { def: 1 }, replicas: { def: 1, ask: 'Minimum replicas always running?' }, hours: { def: 730 }, activeFraction: { def: 1, ask: 'Fraction of time replicas are actively processing (1 = worst case).' }, requests: { def: 0 } } },
  'sql-database': { label: 'Azure SQL Database (vCore)', fields: { tier: { def: 'general-purpose', enum: ['general-purpose', 'business-critical'] }, vcores: { req: true }, storageGB: { def: 32 }, ahb: { def: false, ask: 'Do you own SQL Server licenses with Software Assurance?' }, hours: { def: 730 } } },
  'sql-mi': { label: 'Azure SQL Managed Instance', fields: { tier: { def: 'general-purpose', enum: ['general-purpose', 'business-critical'] }, vcores: { req: true, enum: [4, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 128] }, storageGB: { def: 32 }, ahb: { def: false }, hours: { def: 730 } } },
  postgres: { label: 'PostgreSQL Flexible Server', fields: { tier: { def: 'general-purpose', enum: ['general-purpose', 'memory-optimized'] }, series: { def: 'Ddsv5' }, vcores: { req: true }, storageGB: { def: 128 }, ha: { def: false, ask: 'Need high availability (standby in another zone)?' }, hours: { def: 730 } } },
  mysql: { label: 'MySQL Flexible Server', fields: { tier: { def: 'general-purpose' }, series: { def: 'Ddsv5' }, vcores: { req: true }, storageGB: { def: 128 }, ha: { def: false }, hours: { def: 730 } } },
  cosmos: { label: 'Azure Cosmos DB (NoSQL)', fields: { mode: { def: 'autoscale', enum: ['provisioned', 'autoscale', 'serverless'] }, ru: { ask: 'provisioned RU/s' }, maxRU: { ask: 'autoscale maximum RU/s' }, requestUnits: { ask: 'serverless RUs per month' }, storageGB: { def: 0 }, regions: { def: 1 }, hours: { def: 730 } } },
  blob: { label: 'Blob storage', fields: { tier: { def: 'Hot', enum: ['Hot', 'Cool', 'Cold', 'Archive'], ask: 'How often is the data read? Daily -> Hot; monthly -> Cool; a few times a year -> Cold; almost never -> Archive.' }, redundancy: { def: 'LRS', enum: ['LRS', 'ZRS', 'GRS', 'RA-GRS'] }, capacityGB: { req: true, ask: 'How much data is stored in total (GB or TB)? This is separate from how much is downloaded each month.' }, writeOps: { def: 0 }, readOps: { def: 0 }, otherOps: { def: 0 }, retrievalGB: { def: 0 } } },
  files: { label: 'Azure Files', fields: { model: { def: 'provisioned-v2-hdd', enum: ['provisioned-v2-hdd', 'provisioned-v2-ssd', 'payg-hot', 'payg-cool', 'payg-transaction-optimized'], ask: 'Office documents / user shares -> provisioned-v2-hdd; latency-sensitive apps -> provisioned-v2-ssd.' }, capacityGB: { req: true, ask: 'How much data is in the file shares in total (GB or TB)?' }, redundancy: { def: 'LRS', enum: ['LRS', 'ZRS'] }, iops: {}, throughputMBps: {}, writeOps: {}, readOps: {}, listOps: {} } },
  'log-analytics': { label: 'Log Analytics', fields: { ingestGBPerDay: { req: true, ask: 'Roughly how many GB of logs per day?' }, retentionDays: { def: 31 } } },
  openai: { label: 'Azure OpenAI (Foundry Models, Global Standard)', fields: { model: { req: true, ask: 'Use `azp models` to list; recommend a current small model unless quality needs a larger one.' }, inputTokens: { req: true }, cachedInputTokens: { def: 0 }, outputTokens: { req: true } } },
  meter: { label: 'Any other meter (escape hatch)', fields: { filter: { req: true, ask: 'Exact {serviceName, productName, skuName, meterName}; find with `azp search`.' }, quantity: { req: true }, hours: {}, desc: {}, group: {} } }
};

// When running inside GitHub Copilot CLI, verify customerSaid quotes against what the user
// actually typed in this session. Stops models from inventing the person's answers.
function sessionLog() {
  const sid = process.env.COPILOT_AGENT_SESSION_ID;
  if (!sid) return null;
  const home = process.env.COPILOT_HOME || require('path').join(require('os').homedir(), '.copilot');
  const f = require('path').join(home, 'session-state', sid, 'events.jsonl');
  try { return require('fs').readFileSync(f, 'utf8'); } catch (_) { return null; }
}

const norm = s => String(s || '').toLowerCase().replace(/\u00d7/g, 'x').replace(/[\u2018\u2019\u201C\u201D]/g, '').replace(/[^a-z0-9.%]+/g, ' ').replace(/\s+/g, ' ').trim();
const { humanEvidence, parseEvents } = require('./evidence');
const { sourceErrors } = require('./provenance');

// The person must have seen the exact readback for this spec and replied to it.
function confirmationErrors(spec) {
  const txt = sessionLog(); if (txt == null) return [];
  const { readback } = require('./readback');
  const rb = readback(spec);
  const events = parseEvents(txt);
  const raw = rb.text.split('\n').slice(1, -1).map(l => l.replace(/^\s*-\s*/, '').trim());
  const lines = raw.map(norm);
  const code = norm(rb.code);
  const how = `Run \`azp readback <spec>\`, paste its "text" to the person unchanged (formatting such as bold is fine), and ask them to confirm. Build only after they reply. If they correct anything, update the spec and show the new readback.`;
  const promptContent = e => {
    const d = e.data || {};
    return e.type === 'assistant.message' && !d.parentToolCallId ? d.content :
      e.type === 'tool.execution_start' && d.toolName === 'ask_user' ? (d.arguments || {}).question || (d.arguments || {}).message : null;
  };
  const sameConfirmationPrompt = content => {
    if (typeof content !== 'string') return false;
    const c = norm(content.replace(/```(?:text|markdown)?\s*\n/g, '').replace(/```/g, '').replace(/[.!?]+\s*$/, ''));
    if ((content.match(/\bAZP-[A-F0-9]{6,12}\b/gi) || []).some(check => norm(check) !== code)) return false;
    if (c === norm(rb.text)) return true;
    return new RegExp(`^(please )?(confirm|approve)( (every number|this estimate|the estimate|this readback|the readback|your decision))?( for)? (check )?${code}$`).test(c) ||
      new RegExp(`^is (check )?${code} (correct|right)$`).test(c);
  };
  let best = null, shown = -1;
  events.forEach((e, i) => {
    const content = promptContent(e);
    if (typeof content !== 'string') return;
    const c = norm(content);
    if (!c.includes(code)) return;
    const miss = raw.filter((l, j) => !c.includes(lines[j]));
    if (!miss.length && sameConfirmationPrompt(content)) shown = i; else if (!best || miss.length < best.length) best = miss;
  });
  if (shown < 0) {
    if (best) return [`The readback shown for check ${rb.code} does not match the engine's text. ${best.length ? `These lines are missing or changed: ${best.slice(0, 4).map(l => `"${l}"`).join('; ')}` : 'It contains extra or changed confirmation text'}. ${how}`];
    return [`The person has not seen the readback for this spec (check ${rb.code}). ${how}`];
  }
  const replies = humanEvidence(events, { includeUnsupported: true }).filter(e => e.index > shown);
  if (!replies.length) return [`The person has not replied to the readback (check ${rb.code}) yet. Wait for their answer before building.`];
  for (const reply of replies) {
    if (reply.unsupported) return [`Cannot verify this native ask_user response layout for check ${rb.code}. Show the readback again and ask for explicit approval in a normal message; do not infer confirmation from tool output.`];
    if (reply.native && (reply.startIndex < shown || reply.responseFields !== 1 || !sameConfirmationPrompt(reply.question))) return [`The native form reply was not a confirmation of check ${rb.code}. Show the readback and ask for explicit approval.`];
    const approval = reply.text.trim().replace(/[.!]+$/, '').trim().replace(/\s*\(Recommended\)$/i, '').replace(/[.!]+$/, '').trim().toLowerCase().replace(/,? (please|thanks|thank you)$/, '').trim();
    if (reply.native && !reply.positiveApproval && (reply.answerField || approval === 'true')) return [`The native form field is not an unambiguous positive approval of check ${rb.code}. Use a single approval field titled "Approve this estimate" or an explicit positive choice; rejection, ambiguous fields and bare true are not approval.`];
    if (!/^(yes|yes,? (that'?s |it'?s |all |everything is )?(correct|right)|yes,? (please )?(go ahead|proceed|build it)|correct|confirmed|confirm|approved|approve|looks (good|correct|right)|all (correct|good)|go ahead|proceed|build it|true)(,? (please|thanks|thank you))?$/i.test(approval)) return [`The person did not explicitly approve the readback (check ${rb.code}): "${reply.text.slice(0, 160)}". If this is a correction, update the spec; otherwise ask for explicit confirmation. Show the readback again before obtaining new approval.`];
  }
  const intervening = events.slice(shown + 1).find(e => {
    const content = promptContent(e);
    return typeof content === 'string' && content.trim() && !sameConfirmationPrompt(content);
  });
  if (intervening) return [`A different readback or another customer-facing prompt intervened after check ${rb.code}. A generic reply cannot approve that earlier readback. ${how}`];
  return [];
}

// The model actually answering in this Copilot session (each response records it; "auto" resolves
// to a concrete model), and how it performed in testing.
function modelStatus() {
  const txt = sessionLog();
  let model = null;
  const all = new Set();
  if (txt) {
    for (const l of txt.split(/\r?\n/)) {
      if (!/"(assistant\.message|session\.model_change|session\.start)"/.test(l)) continue;
      try {
        const e = JSON.parse(l); const d = e.data || {};
        const m = e.type === 'assistant.message' ? d.model : e.type === 'session.model_change' ? d.newModel : d.selectedModel;
        if (m && m !== 'auto') { all.add(m); if (e.type === 'assistant.message' && !d.parentToolCallId) model = model || m; }
      } catch (_) { }
    }
  }
  const M = require('../../catalog/models.json');
  // Any not-recommended model anywhere in the session counts: a later message cannot clear it.
  const bad = [...all].find(m => M.notRecommended[m]);
  if (bad) model = bad;
  else if (all.size) model = [...all].find(m => !M.recommended[m]) || [...all][0];
  const rec = Object.keys(M.recommended);
  const list = rec.join(', ');
  if (!model) return { model: null, status: 'unknown', notice: null, recommended: rec };
  if (M.recommended[model]) return { model, status: 'recommended', notice: null, recommended: rec };
  if (M.acceptable[model]) return { model, status: 'acceptable', notice: null, recommended: rec };
  if (M.notRecommended[model]) return { model, status: 'not-recommended', notice: `This estimate is being prepared with ${model}, which is NOT recommended for this skill. ${M.notRecommended[model]} Please switch to one of: ${list} (in GitHub Copilot, use /model), then start again.`, recommended: rec };
  return { model, status: 'untested', notice: null, recommended: rec };
}

function userMessages() {
  const txt = sessionLog();
  if (txt == null) return null;
  const msgs = [];
  let tampered = false;
  // Copilot writes every event with a unique id, a timestamp and a parentId pointing to an earlier
  // event. A real message from the person always starts a turn (its parent is the system message),
  // carries Copilot's delivery fields, and arrives in time order. Hand-written lines fail these.
  const lines = txt.split(/\r?\n/).filter(Boolean);
  // Newer Copilot builds (auto mode, compaction, resume) write internal events whose parent is not in
  // the file, hang a person's message off any earlier event, and stamp events a few ms out of order.
  // Only the person's messages need an intact chain; other events need just a unique id and a timestamp.
  const seen = new Map();
  let lastTs = '';
  const SKEW_MS = 2000;
  const flag = reason => { if (!tampered) userMessages.reason = reason; tampered = true; };
  userMessages.reason = null;
  lines.forEach((line, i) => {
    let e;
    try { e = JSON.parse(line); } catch (_) { if (i < lines.length - 1) flag(`line ${i + 1} is not valid JSON`); return; }
    if (!e.id || !e.timestamp || seen.has(e.id)) flag(`event ${i + 1} (${e.type}) has a missing or duplicate id or timestamp`);
    if (e.type === 'user.message' && !seen.has(e.parentId)) flag(`user message at event ${i + 1} points to an unknown parent event`);
    if (e.timestamp < lastTs) { if (!(Date.parse(lastTs) - Date.parse(e.timestamp) <= SKEW_MS)) flag(`event ${i + 1} (${e.type}) is out of time order`); } else lastTs = e.timestamp;
    if (e.type === 'user.message') {
      const d = e.data || {};
      if (!d.interactionId) flag(`user message at event ${i + 1} has no interactionId`);
      if (!d.source && !('delivery' in d)) flag(`user message at event ${i + 1} lacks Copilot delivery fields`);
    }
    if (e.id) seen.set(e.id, e.type);
  });
  for (const line of lines) {
    if (!line.includes('"user.message"')) continue;
    try {
      const j = JSON.parse(line); const d = j.data || {}; const c = d.content;
      if (typeof c !== 'string' || c.startsWith('<skill-context') || d.source) continue;
      // Copilot records what the person typed twice. If they disagree, the log was edited.
      if (typeof d.transformedContent === 'string' && !d.transformedContent.replace(/\s+/g, ' ').includes(c.trim().replace(/\s+/g, ' '))) flag('a user message differs from its transformedContent');
      msgs.push(typeof d.transformedContent === 'string' ? d.transformedContent.replace(/<current_datetime>[\s\S]*?<\/current_datetime>|<system_reminder>[\s\S]*?<\/system_reminder>/g, '') : c);
    } catch (_) { }
  }
  for (const answer of humanEvidence(parseEvents(txt))) if (answer.native) msgs.push(answer.text);
  if (tampered) return '\u0000TAMPERED';
  return msgs.join('\n').toLowerCase();
}

// True if a quote is traceable to what the person typed (or if not running inside Copilot).
// A quote that is literally what the person typed is always theirs, even if it says "default".
function quoteVerbatim(q) {
  const user = userMessages();
  if (user == null || user === '\u0000TAMPERED') return false;
  const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
  const qq = n(q);
  return qq.split(' ').length >= 3 && n(user).includes(qq);
}

function quoteGrounded(q) {
  const user = userMessages();
  if (user == null) return !(process.env.COPILOT_AGENT_SESSION_ID || underCopilot());
  if (user === '\u0000TAMPERED') return false;
  const toks = (String(q || '').toLowerCase().match(/[a-z]{4,}|\d+/g) || []).filter(t => !['that', 'with', 'have', 'from', 'this', 'what', 'they', 'your', 'about'].includes(t));
  return toks.length >= 2 && toks.filter(t => user.includes(t)).length / toks.length >= 0.6;
}

// True if this process runs under GitHub Copilot CLI, judged from the process tree rather than
// environment variables (which a model can delete).
function underCopilot() {
  if (underCopilot.v !== undefined) return underCopilot.v;
  let v = false;
  try {
    const { execSync, execFileSync } = require('child_process');
    const procs = new Map();
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      for (const l of out.split(/\r?\n/)) { const [p, pp, n] = l.split('|'); if (p) procs.set(Number(p), { pp: Number(pp), n: n || '' }); }
    } else {
      const out = execSync('ps -A -o pid=,ppid=,comm=', { encoding: 'utf8', timeout: 15000 });
      for (const l of out.split(/\n/)) { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); if (m) procs.set(Number(m[1]), { pp: Number(m[2]), n: m[3] }); }
    }
    let pid = process.ppid;
    for (let i = 0; i < 12 && pid && procs.has(pid); i++) { const p = procs.get(pid); if (/copilot/i.test(p.n)) { v = true; break; } pid = p.pp; }
  } catch (_) { }
  return (underCopilot.v = v);
}

function groundingErrors(spec) {
  const inCopilot = !!process.env.COPILOT_AGENT_SESSION_ID || underCopilot();
  const user = userMessages();
  if (user == null) {
    groundingErrors.status = 'unverified';
    // Inside Copilot the session log must be readable; a missing log means the check was bypassed.
    return inCopilot ? ['Cannot read this conversation to verify the person\'s answers. Do not change environment variables or files; run the build normally.'] : [];
  }
  groundingErrors.status = 'verified';
  if (user === '\u0000TAMPERED') { groundingErrors.status = 'tampered'; return [`The conversation log does not match what the person typed (${userMessages.reason || 'unknown check'}). Estimates can only be built from the person's real answers.`]; }
  const errs = [];
  const sources = sourceErrors(spec, humanEvidence(parseEvents(sessionLog())));
  errs.push(...sources);
  const sourced = field => !sources.length && (spec.sources || []).some(s => s.kind === 'customer' && s.field === field);
  const said = spec.customerSaid || {};
  for (const k of ['region', 'discount', 'requirements']) {
    const toks = (String(said[k] || '').toLowerCase().match(/[a-z]{4,}|\d+/g) || []).filter(t => !['that', 'with', 'have', 'from', 'this', 'what', 'they', 'your', 'about'].includes(t));
    if (!toks.length) continue;
    const hit = toks.filter(t => user.includes(t)).length / toks.length;
    if (hit < 0.6) errs.push(`"customerSaid.${k}" ("${said[k]}") does not match anything the person typed in this conversation. Do not invent their answers: ask them.`);
  }
  const pct = Number(spec.discountPct || 0);
  if (pct > 0 && !sourced('discountPct') && !new RegExp(`\\b${String(pct).replace('.', '\\.')}\\s*(%|percent|pct)|\\b${String(pct).replace('.', '\\.')}\\b[^.\\n]{0,25}\\b(off|discount)`).test(user)) errs.push(`discountPct ${pct} was never stated by the person as a percentage discount. Ask them for their discount.`);
  if (pct === 0 && !sourced('discountPct') && !/\b(no|none|don't|dont|do not|without|zero|0%|not have|n't have)\b[^.\n]{0,40}\bdiscounts?\b|\bdiscounts?\b[^.\n]{0,30}\b(none|no|zero|0%)\b|\blist price\b/.test(user)) errs.push('discountPct is 0 but the person never said they have no discount. Ask them.');
  // Region: the region itself, or a location the person named, must appear in what they typed.
  const REG = require('../../catalog/regions.json');
  const code = String(spec.region || '').toLowerCase().replace(/\s+/g, '');
  const name = (Object.entries(REG).find(([c, n]) => c === code || n.toLowerCase().replace(/\s+/g, '') === code) || [code, code])[1].toLowerCase();
  const regionStated = user.includes(name) || user.includes(code) || user.replace(/\s+/g, '').includes(name.replace(/\s+/g, ''));
  const deferred = /\b(recommend|suggest|you pick|don't know|dont know|not sure|whatever)\b/.test(user) && /\brecommend|suggest/i.test(String(said.region || ''));
  const placeWords = (String(said.region || '').match(/\b[A-Z][a-z]{3,}\b/g) || []).filter(w => user.includes(w.toLowerCase()));
  if (!regionStated && !deferred && !placeWords.length) errs.push(`The person never named ${name} or a location that maps to it. Ask which region (or where their users are).`);
  // The quoted region must not name a different region than the one priced.
  const saidR = String(said.region || '').toLowerCase();
  const named = Object.values(REG).map(n => n.toLowerCase()).filter(n => new RegExp(`(^|[^a-z])${n.replace(/\s+/g, '\\s*')}([^a-z]|$)`).test(saidR)).sort((a, b) => b.length - a.length)[0];
  if (named && named !== name) errs.push(`The person said "${said.region}" but the spec prices ${name}. Use the region they asked for.`);
  return errs;
}

function validateSpec(spec, opts = {}) {
  const errs = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['The spec must be an object.'];
  if (spec.options != null && !Array.isArray(spec.options)) return ['options must be an array.'];
  if (Array.isArray(spec.options) && spec.options.some(o => !o || typeof o !== 'object' || !Array.isArray(o.components))) return ['Each option must be an object with a components array.'];
  if ((spec.options || []).some(o => o.components.some(c => !c || typeof c !== 'object'))) return ['Each component must be an object.'];
  for (const key of ['assumptions', 'excluded', 'nextSteps', 'discountExcludes']) if (spec[key] != null && (!Array.isArray(spec[key]) || spec[key].some(v => typeof v !== 'string'))) errs.push(`${key} must be an array of strings.`);
  for (const key of ['replacedSizes', 'discountExcludes']) if (spec[key] != null && !Array.isArray(spec[key])) return [`${key} must be an array.`];
  if (spec.declined != null && !Array.isArray(spec.declined)) return ['declined must be an array.'];
  errs.push(...groundingErrors(spec));
  if (groundingErrors.status !== 'verified') errs.push(...sourceErrors(spec, null));
  for (const [i, d] of (spec.declined || []).entries()) {
    if (!d || typeof d.id !== 'string' || !d.id.trim() || typeof d.customerSaid !== 'string' || !d.customerSaid.trim()) errs.push(`declined[${i}] needs an advisory id and the person's exact customerSaid decision.`);
    else if (groundingErrors.status === 'verified' && (!quoteGrounded(d.customerSaid) || !humanEvidence(parseEvents(sessionLog())).some(e => norm(e.text).includes(norm(d.customerSaid))))) errs.push(`declined[${i}].customerSaid is not a verified human decision. Ask the person; an excluded item is not evidence of agreement.`);
  }
  if (!spec.region) errs.push('Missing "region".');
  if (spec.discountPct == null) errs.push('Missing "discountPct" (use 0 if the customer has no discount).');
  else if (typeof spec.discountPct !== 'number' || !Number.isFinite(spec.discountPct) || spec.discountPct < 0 || spec.discountPct >= 100) errs.push('"discountPct" must be a number from 0 to 99.99 (for example 16 for 16 percent, 0 for none).');
  const said = spec.customerSaid || {};
  const fake = /assum|not (been )?(specified|provided|stated|given|mentioned)|unspecified|default|\bn\/a\b|\bunknown\b|\btbd\b|placeholder/i;
  for (const k of ['region', 'discount', 'requirements']) if (said[k] && fake.test(String(said[k])) && !quoteVerbatim(said[k])) errs.push(`"customerSaid.${k}" is an assumption, not the person's words ("${said[k]}"). STOP and ask them.`);
  if (!said.region || String(said.region).trim().length < 3) errs.push('Missing "customerSaid.region": quote the person\'s own words about the region. If they have not told you, STOP and ask them; do not assume a region.');
  const hasSource = quote => Array.isArray(spec.sources) && spec.sources.some(s => s && s.kind === 'customer' && s.customerSaid === quote);
  if (!said.discount || (String(said.discount).trim().length < 2 && !hasSource(said.discount))) errs.push('Missing "customerSaid.discount": quote the person\'s own words about their discount (for example "16% off list" or "no discount"). If they have not told you, STOP and ask them; do not assume.');
  if (!said.requirements || (String(said.requirements).trim().length < 3 && !hasSource(said.requirements))) errs.push('Missing "customerSaid.requirements": quote what the person told you about size and usage (CPU/memory, capacity, volumes, hours). If they have not told you, STOP and ask them.');
  if (!Array.isArray(spec.options) || !spec.options.length) errs.push('Missing "options" array.');
  const contexts = [['context', spec.context], ...(spec.options || []).map((o, i) => [`options[${i}].context`, o.context])];
  for (const [prefix, context] of contexts) {
    if (context == null) continue;
    if (typeof context !== 'object' || Array.isArray(context)) { errs.push(`${prefix} must be an object.`); continue; }
    for (const [k, v] of Object.entries(context)) {
      if (!CONTEXT[k]) errs.push(`${prefix}: unknown field "${k}". Known: ${Object.keys(CONTEXT).filter(x => !CONTEXT[x].internal).join(', ')}.`);
      else if (typeof v !== 'boolean') errs.push(`${prefix}.${k} must be true or false.`);
    }
  }
  (spec.options || []).forEach((o, i) => {
    if (o.phase != null && (typeof o.phase !== 'string' || !o.phase.trim())) errs.push(`options[${i}].phase must be a non-empty phase label.`);
  });
  (spec.options || []).forEach((o, i) => (o.components || []).forEach((c, j) => {
    if (c.type === 'vm' && c.sku) {
      const { lifecycle, explain } = require('./lifecycle');
      if (!lifecycle(c.sku).modern) errs.push(`options[${i}].components[${j}]: ${explain(c.sku)} Do not price it. Run \`azp vm-suggest\` with the same vCPU and memory, price that size instead, add {"requested": "${c.sku}", "priced": "<new size>"} to spec.replacedSizes, and explain this to the person with the references.`);
    }
  }));
  for (const r of spec.replacedSizes || []) {
    const { lifecycle } = require('./lifecycle');
    if (!r || !r.requested || !r.priced) errs.push('replacedSizes entries need "requested" and "priced".');
    else if (lifecycle(r.requested).modern) errs.push(`replacedSizes: ${r.requested} is a Current or Extended size; it does not need replacing.`);
    else if (!lifecycle(r.priced).modern) errs.push(`replacedSizes: ${r.priced} is also End of Life; choose a Current or Extended size from vm-suggest.`);
  }
  (spec.options || []).forEach((o, i) => (o.components || []).forEach((c, j) => {
    const s = S[c.type];
    if (!s) { errs.push(`options[${i}].components[${j}]: unknown type "${c.type}".`); return; }
    for (const [k, f] of Object.entries(s.fields)) {
      if (f.req && c[k] == null && !(k === 'gbSeconds')) errs.push(`options[${i}].components[${j}] (${c.type}): missing "${k}".`);
      if (f.enum && c[k] != null && !f.enum.includes(c[k])) errs.push(`options[${i}].components[${j}] (${c.type}): "${k}" must be one of ${f.enum.join(', ')}.`);
    }
    for (const k of Object.keys(c)) if (!['type', 'label'].includes(k) && !s.fields[k]) errs.push(`options[${i}].components[${j}] (${c.type}): unknown field "${k}".`);
  }));
  if (!errs.length && groundingErrors.status === 'verified' && opts.confirm !== false) errs.push(...confirmationErrors(spec));
  return errs;
}

// Workload context. Ask a context question only when one of its services is in the estimate,
// in plain words, with the default offered. Answers go in spec.context and appear in the readback.
const CONTEXT = {
  production: { ask: 'Is this for production (real users or business processes), or for development and testing?', type: 'boolean', when: 'always' },
  internetFacing: { ask: 'Will people reach it from the internet, or only from inside your network?', type: 'boolean', when: 'any web, app, VM or container service' },
  interruptible: { ask: 'If Azure needed the capacity back, could this work be stopped and restarted later without harm (for example batch jobs or test machines)?', type: 'boolean', def: false, services: ['vm', 'aks'] },
  steadyUsage: { ask: 'Will you keep running roughly this much for a year or longer?', type: 'boolean', services: ['vm', 'aks', 'app-service', 'sql-database', 'sql-mi', 'postgres', 'mysql', 'cosmos', 'blob', 'files', 'log-analytics'] },
  idlePeriods: { ask: 'Is it idle for long stretches, such as nights or weekends?', type: 'boolean', def: false, services: ['sql-database', 'postgres', 'mysql', 'cosmos', 'vm'] },
  zoneResilience: { ask: 'Must it keep running if one Azure datacenter in the region goes down?', type: 'boolean', services: ['vm', 'disk', 'aks', 'app-service', 'container-apps', 'sql-database', 'sql-mi', 'postgres', 'mysql', 'cosmos', 'blob', 'files', 'load-balancer', 'app-gateway'] },
  privateOnly: { ask: 'Should it be reachable only from your private network, with no public access?', type: 'boolean', def: false, services: ['vm', 'app-service', 'functions', 'container-apps', 'sql-database', 'sql-mi', 'postgres', 'mysql', 'cosmos', 'blob', 'files'] },
  multiRegionUsers: { ask: 'Are your users spread across several countries or continents?', type: 'boolean', def: false, services: ['app-service', 'app-gateway', 'load-balancer', 'container-apps', 'cosmos', 'vm'] },
  frontDoor: { ask: 'internal: set true when the design already includes Azure Front Door', type: 'boolean', internal: true }
};

function conversationAnswers() {
  const text = sessionLog(), user = userMessages();
  if (text == null || user === '\u0000TAMPERED') return { ok: false, stage: 'evidence', errors: [text == null ? 'Cannot read this conversation.' : `Conversation integrity check failed: ${userMessages.reason}`] };
  return { ok: true, answers: humanEvidence(parseEvents(text)).map(({ eventId, answerField, text }) => ({ eventId, ...(answerField ? { answerField } : {}), customerSaid: text })), instructions: 'Only these human values are evidence. Unsupported native layouts are omitted; if an expected answer is absent, ask in a normal message rather than inventing evidence.' };
}

module.exports = { SCHEMA: S, CONTEXT, validateSpec, quoteGrounded, modelStatus, conversationAnswers, verificationStatus: () => groundingErrors.status || 'unverified' };
