#!/usr/bin/env node
'use strict';
// azp - deterministic Azure pricing engine for the azure-pricing skill.
const fs = require('fs');
const path = require('path');
const { priceSpec, normalizeRegion } = require('./lib/estimate');
const { advise, rulebook } = require('./lib/advisor');
const { render, money } = require('./lib/render');
const { checkMath, checkHtml, checkLinks, checkCitations } = require('./lib/validate');
const { SCHEMA, CONTEXT, validateSpec, quoteGrounded, modelStatus, verificationStatus } = require('./lib/schema');
const { expandSpec } = require('./lib/expand');
const { lifecycle } = require('./lib/lifecycle');
const { prepare, writeOutputs } = require('./lib/files');

// Fingerprint of the engine code and catalogs, printed in every report so edits are visible.
function engineFingerprint() {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(js|json|html)$/.test(e.name)) h.update(e.name + '\0' + fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
  });
  walk(path.join(__dirname)); walk(path.join(__dirname, '..', 'catalog')); walk(path.join(__dirname, '..', 'assets'));
  return h.digest('hex').slice(0, 16);
}
const { vmRates, PricingError } = require('./lib/recipes');
const { query, dedupe, q } = require('./lib/api');
const vmSizes = require('../catalog/vm-sizes.json');
const catalog = require('../catalog/catalog.json');
const aiModels = require('../catalog/ai-models.json').models;

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = ['compact', 'no-links', 'local-disk', 'allow-no-premium'].includes(k) ? true : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; }
    else o._.push(a);
  }
  return o;
}

function processor(sku) {
  const m = sku.match(/^Standard_[A-Z]+\d+(?:-\d+)?([a-z]*)_/);
  const f = m ? m[1] : '';
  if (f.includes('p')) return 'Arm';
  if (f.includes('a')) return 'AMD';
  return 'Intel';
}

function highlights(o) {
  const vm = o.components.find(c => c.spec.type === 'vm');
  const out = [];
  if (vm && vm.facts.spec) {
    out.push({ text: `${vm.facts.spec.vcpu} vCPU, ${vm.facts.spec.memGiB} GiB memory${vm.facts.count > 1 ? ` (x${vm.facts.count})` : ''}` });
    out.push({ text: `${processor(vm.facts.sku)} processor` });
    if (vm.facts.hours < 730) out.push({ text: `${vm.facts.hours} hours per month` });
  }
  return out;
}

async function cmdVmSuggest(a) {
  const limit = a.limit == null ? 15 : Number(a.limit);
  if (a.limit === true || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new PricingError('--limit must be an integer from 1 to 50.');
  const region = normalizeRegion(a.region).code;
  const vcpu = Number(a.vcpu), mem = Number(a.mem || a.memory);
  if (!vcpu || !mem) throw new PricingError('vm-suggest needs --vcpu and --mem (GiB).');
  const ratio = mem / vcpu;
  let workload = a.workload || 'auto';
  if (workload === 'auto') workload = ratio <= 2.5 ? 'compute' : ratio <= 4.5 ? 'general' : 'memory';
  const fam = { general: /^Standard_D\d+[a-z]*_v[5-7]$/, memory: /^Standard_E\d+[a-z]*_v[5-7]$/, compute: /^Standard_(F\d+[a-z]*_v[6-7]|D\d+l[a-z]*_v[5-7])$/, burstable: /^Standard_B\d+[a-z]*_v2$/ }[workload];
  if (!fam) throw new PricingError('--workload must be general, memory, compute, burstable or auto.');
  const wantLocalDisk = a['local-disk'] === true || a['local-disk'] === 'true';
  const arch = a.arch || 'any';
  const cands = Object.entries(vmSizes).filter(([n, s]) => {
    if (!fam.test(n) || /-/.test(n) || !lifecycle(n).modern) return false;
    const suffix = (n.match(/^Standard_[A-Z]+\d+([a-z]*)_/) || [])[1] || '';
    if (/[cb]/.test(suffix)) return false; // confidential, block-storage-optimized
    if (!wantLocalDisk && suffix.includes('d')) return false;
    if (arch === 'x64' && s.a === 'arm') return false;
    if (arch === 'arm' && s.a !== 'arm') return false;
    if (a.os && a.os !== 'linux' && s.a === 'arm') return false; // Windows/RHEL on Arm: not assumed
    if (!s.p && a['allow-no-premium'] !== true) return false; // default: sizes that support Premium SSD
    return s.v === vcpu && s.m >= mem && s.m <= Math.max(mem * 2, mem + 8);
  });
  const ctx = { region, currency: (a.currency || 'USD').toUpperCase() };
  const res = [];
  for (const [n, s] of cands) {
    const r = await vmRates(n, ctx).catch(() => null);
    if (!r || !r.base) continue;
    const os = a.os || 'linux';
    const rate = os === 'windows' && r.win ? r.win.retailPrice : r.base.retailPrice;
    res.push({ sku: n, vcpu: s.v, memGiB: s.m, processor: processor(n), hourly: rate, monthly730: Math.round(rate * 730 * 100) / 100, premiumDisk: !!s.p, maxDiskIops: s.io });
  }
  res.sort((x, y) => x.hourly - y.hourly);
  const pick = [];
  for (const p of ['AMD', 'Intel', 'Arm']) { const c = res.find(r => r.processor === p); if (c) pick.push(c); }
  const out = { region, workload, requirement: { vcpu, memGiB: mem }, shortlist: pick, totalMatches: res.length, limit, hasMore: res.length > limit, allMatches: res.slice(0, limit),
    explain: pick.map(p => `${p.sku} (${p.processor}, ${p.vcpu} vCPU / ${p.memGiB} GiB): ${money(p.monthly730, ctx.currency)} list per month at 730 hours.` + (p.processor === 'Arm' ? ' Only if the software runs on Arm64 (most Linux open source does; many commercial apps do not).' : p.processor === 'Intel' ? ' Choose if software is certified only on Intel.' : ' Usually the lowest-cost x86 option.')) };
  if (!pick.length) out.hint = 'No exact match. Try --workload auto/general/memory, a different vCPU count, or --local-disk.';
  return out;
}

async function cmdSearch(a) {
  const parts = [];
  if (a.region) parts.push(`armRegionName eq '${q(normalizeRegion(a.region).code)}'`);
  if (a.service) parts.push(`serviceName eq '${q(a.service)}'`);
  if (a.product) parts.push(`contains(productName, '${q(a.product)}')`);
  if (a.sku) parts.push(`contains(skuName, '${q(a.sku)}')`);
  if (a.meter) parts.push(`contains(meterName, '${q(a.meter)}')`);
  parts.push(`priceType eq 'Consumption'`);
  if (parts.length < 3) throw new PricingError('search needs at least two of --service, --product, --sku, --meter (plus --region).');
  const rs = dedupe(await query(parts.join(' and '), (a.currency || 'USD').toUpperCase()));
  return rs.slice(0, Number(a.limit || 40)).map(r => ({ serviceName: r.serviceName, productName: r.productName, skuName: r.skuName, meterName: r.meterName, unitOfMeasure: r.unitOfMeasure, retailPrice: r.retailPrice, tierMinimumUnits: r.tierMinimumUnits, armRegionName: r.armRegionName }));
}

async function cmdBuild(a) {
  const specPath = a._[1];
  if (!specPath) throw new PricingError('usage: azp build <spec.json> [--out estimate.html] [--no-links]');
  const out = a.out || specPath.replace(/\.json$/i, '') + '.html';
  if (!/\.html$/i.test(out)) throw new PricingError('--out must end in .html.');
  if ([out, out.replace(/\.html$/i, '') + '.estimate.json'].some(file => fs.existsSync(file))) throw new PricingError('Output already exists; run prepare to allocate new spec/report paths.');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  // Models that failed testing cannot produce an estimate with this skill.
  const mst = modelStatus();
  if (mst.status === 'not-recommended') return { ok: false, stage: 'model', errors: [mst.notice.replace('This estimate is being prepared with', 'This conversation is using') + ' No estimate can be built with this model.'], relay: 'Tell the person exactly this, and stop. Do not try to work around it.' };
  const serr = validateSpec(spec);
  if (serr.length) {
    const recovery = !validateSpec(spec, { confirm: false }).length ? {
      action: 'show-readback-and-wait',
      ...require('./lib/readback').readback(spec),
      instructions: 'No report was created. If the person refused, stop. Otherwise send recovery.message as your entire reply, unchanged, then wait for a new explicit approval. Do not retry build using an earlier yes, even if the check code is unchanged.'
    } : null;
    return { ok: false, stage: 'spec', errors: serr, ...(recovery ? { recovery } : {}) };
  }
  const est = await priceSpec(expandSpec(spec));
  est.verification = verificationStatus();
  est.model = modelStatus();
  est.fingerprint = engineFingerprint();
  try { est.engineIntact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'MANIFEST.json'), 'utf8')).fingerprint === est.fingerprint; } catch (_) { est.engineIntact = false; }
  est.options.forEach((o, i) => { o.highlights = ((expandSpec(spec).options[i] || {}).highlights || []).map(t => typeof t === 'string' ? { text: t } : t).concat(highlights(o)); });
  const adv = advise(est);
  // Must-act warnings: fix the design, or record the person's decision in their own words.
  const declined = Array.isArray(spec.declined) ? spec.declined : [];
  const open = adv.filter(x => x.mustAct && !declined.some(d => d && d.id === x.id && quoteGrounded(d.customerSaid)));
  if (open.length) return { ok: false, stage: 'advice', errors: open.map(x => `${x.option ? x.option + ': ' : ''}${x.title}. ${x.body.replace(/<[^>]+>/g, '')} Fix the spec (and show a new readback), or explain this to the person and, only if they choose to keep it as is, add {"id": "${x.id}", "customerSaid": "<their words>"} to spec.declined.`) };
  est.declined = declined.filter(d => d && quoteGrounded(d.customerSaid));
  const priceErrors = est.options.flatMap(o => o.errors.map(e => `${o.name}: ${e}`));
  if (priceErrors.length && est.options.every(o => o.errors.length)) return { ok: false, stage: 'price', errors: priceErrors };
  const html = render(est, adv);
  const mathErr = checkMath(est), htmlErr = checkHtml(html);
  const links = a['no-links'] ? { urls: [], errs: [] } : await checkLinks(html);
  const audit = writeOutputs(out, html, { estimate: est, advisories: adv });
  const ok = !mathErr.length && !htmlErr.length && !links.errs.length && !priceErrors.length;
  return {
    ok, file: path.resolve(out), audit, currency: est.currency, discountPct: est.discountPct,
    facts: { customerSaid: est.customerSaid, sources: est.sources, assumptions: est.assumptions, notIncluded: require('./lib/readback').notIncluded(expandSpec(spec)), nextSteps: est.nextSteps },
    options: est.options.map(o => ({ name: o.name, scenario: o.scenario, purchasing: o.purchasing, monthlyList: o.totalList, monthlyYourPrice: o.totalYour, lowest: !!o.lowest, errors: o.errors })),
    summary: est.options.map(o => o.errors.length ? `${o.name}: pricing incomplete: ${o.errors.join('; ')}` :
      `${o.name} (${o.purchasing}) - List: ${money(o.totalList, est.currency)}/month; your price: ${money(o.totalYour, est.currency)}/month.`).join('\n'),
    advisories: adv.map(x => ({ id: x.id, level: x.level, title: x.title, body: x.body.replace(/<[^>]+>/g, ''), option: x.option, source: x.source ? [x.source.framework, x.source.code].filter(Boolean).join(' ') + ': ' + x.source.url : null })),
    validation: { math: mathErr, html: htmlErr, links: links.errs, linksChecked: links.urls.length },
    relay: 'Start your final reply by copying summary unchanged: it contains BOTH monthly list and customer totals for every purchasing choice. Then relay every advisory with level "warn" in plain words and its source, key assumptions, and the report and audit paths. Only facts.assumptions and assumption-kind facts.sources are assumptions; known quantities, discounts and exclusions are facts, not guesses. Do not omit the list price just because a discount applies.',
    ...(adv.some(x => x.id === 'vm-end-of-life') ? { explainToPerson: adv.filter(x => x.id === 'vm-end-of-life').map(x => ({ say: x.body.replace(/<[^>]+>/g, ''), links: [x.source.url, ...(x.source.more || []).map(m => m.url)] })), explainInstruction: 'Explain why the requested size was replaced, in plain words based on "say", and include these Microsoft links in your reply.' } : {})
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  // Refuse to run with code injected at startup (preloaded scripts can rewrite the engine in memory).
  const inj = [...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/)].filter(a => /^(-r|--require|--import|--loader|--experimental-loader|--inspect|--eval|-e|-p|--print)/.test(a));
  if (inj.length) { process.stdout.write(JSON.stringify({ ok: false, stage: 'integrity', errors: ['The pricing engine was started with injected code (' + inj.join(' ') + '). Run it normally: node azp.js <command>.'] }, null, a.compact ? undefined : 2) + '\n'); process.exitCode = 2; return; }
  const cmd = a._[0];
  let out;
  switch (cmd) {
    case 'questions': {
      const t = a._[1];
      if (t === 'plan') {
        // Ordered question plan in batches of at most three, one batch per message.
        const types = String(a.types || '').split(',').filter(Boolean);
        const unknown = types.filter(ty => !SCHEMA[ty]);
        if (unknown.length) throw new PricingError(`Unknown component type(s): ${unknown.join(', ')}. Use exact types from \`azp questions\`: ${Object.keys(SCHEMA).join(', ')}.`);
        const qs = [];
        for (const ty of types) for (const [k, f] of Object.entries((SCHEMA[ty] || {}).fields || {})) if (f.req || (f.ask && /how many|how much|does it|is this|do you|must|need|which|what/i.test(f.ask))) qs.push({ about: `${ty}.${k}`, ask: f.ask || `What is the ${k} for the ${(SCHEMA[ty] || {}).label || ty}?`, default: f.def ?? null });
        for (const [k, v] of Object.entries(CONTEXT)) if (!v.internal && (!v.services || v.services.some(s => types.includes(s)))) qs.push({ about: `context.${k}`, ask: v.ask, default: v.def ?? null });
        const seen = new Set(); const uniq = qs.filter(q => !seen.has(q.about) && seen.add(q.about));
        const batches = []; for (let i = 0; i < uniq.length; i += 3) batches.push(uniq.slice(i, i + 3));
        out = { rule: 'This response includes the complete component schemas and question plan for the selected types; do not repeat questions/type/context lookups. If the person already supplied the required quantities, region and discount, write the spec next. Otherwise ask ONE missing batch per message, at most three questions. Leave unknown optional context unset. Use defaults as assumptions only with permission. Never ask for SKU names; translate their answers.', components: Object.fromEntries(types.map(ty => [ty, SCHEMA[ty]])), batches };
        break;
      }
      if (t === 'context') {
        const types = new Set((a.types ? String(a.types).split(',') : []));
        out = Object.fromEntries(Object.entries(CONTEXT).filter(([, v]) => !v.internal && (!types.size || !v.services || v.services.some(s => types.has(s)))).map(([k, v]) => [k, { ask: v.ask, default: v.def ?? null }]));
        break;
      }
      out = t ? (SCHEMA[t] || { error: `Unknown type. Known: ${Object.keys(SCHEMA).join(', ')}, context` }) : Object.assign(Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, v.label])), { context: 'Workload questions: run `questions context --types vm,disk,...` with the types in this estimate' });
      break;
    }
    case 'vm-suggest': out = await cmdVmSuggest(a); break;
    case 'fingerprint': out = { fingerprint: engineFingerprint() }; break;
    case 'models': out = Object.entries(aiModels).map(([k, v]) => ({ model: k, class: v.class, legacy: !!v.legacy })); break;
    case 'regions': out = require('../catalog/regions.json'); break;
    case 'search': out = await cmdSearch(a); break;
    case 'prepare': out = prepare(a.name, a.dir || '.'); break;
    case 'answers': {
      const { conversationAnswers } = require('./lib/schema');
      out = conversationAnswers();
      break;
    }
    case 'preflight': {
      const spec = JSON.parse(fs.readFileSync(a._[1], 'utf8'));
      const errors = validateSpec(spec, { confirm: false });
      out = { ok: !errors.length, stage: 'spec', errors, verification: verificationStatus(), instructions: 'No pricing was fetched and confirmation was not required. If ok, run readback and show its text before asking for confirmation.' };
      break;
    }
    case 'validate-spec': out = validateSpec(JSON.parse(fs.readFileSync(a._[1], 'utf8'))); break;
    case 'price': { const spec = expandSpec(JSON.parse(fs.readFileSync(a._[1], 'utf8'))); const e = await priceSpec(spec); out = { options: e.options.map(o => ({ name: o.name, list: o.totalList, your: o.totalYour, errors: o.errors, lines: o.lines.map(l => [l.desc, l.list, l.your]) })), advisories: advise(e).map(x => x.id) }; break; }
    case 'build': out = await cmdBuild(a); break;
    case 'readback': {
      const spec = JSON.parse(fs.readFileSync(a._[1], 'utf8'));
      const errors = validateSpec(spec, { confirm: false });
      if (errors.length) { out = { ok: false, stage: 'spec', errors }; break; }
      const r = require('./lib/readback').readback(spec);
      const confirmationErrors = validateSpec(spec);
      const status = verificationStatus() === 'verified' ? (confirmationErrors.length ? 'required' : 'approved') : 'unverified';
      out = { ok: true, action: status === 'approved' ? 'build' : 'show-readback-and-wait', ...r, confirmation: { status, errors: confirmationErrors }, facts: { sources: require('./lib/provenance').sourceFacts(spec), assumptions: spec.assumptions || [], notIncluded: require('./lib/readback').notIncluded(expandSpec(spec)) }, instructions: status === 'approved' ?
        'The conversation already contains this exact readback and a subsequent explicit approval. Build the unchanged spec now using the allocated report path. Do not redisplay message or ask again. Build rechecks approval and all other safeguards.' :
        'Your next action is an assistant reply, NOT another tool call: send message as your entire reply, copied unchanged, then end your turn. No introduction, footer or extra question. Do NOT call build, preflight or readback until the person replies. Tool output and a check code are NOT displayed confirmation or human approval. After a new explicit approval, build directly.' };
      break;
    }
    case 'rules': out = rulebook(); break;
    case 'check-citations': { const rb = rulebook(); const c = await checkCitations(rb.rules); out = { ok: !c.failed.length && !rb.rejected.length && !rb.unwired.length, rules: rb.rules.length, rejected: rb.rejected, unwired: rb.unwired, failed: c.failed, checked: c.checked }; break; }
    default:
      out = { usage: [
        'azp questions [type]            what to ask for each component type, with defaults',
        'azp vm-suggest --vcpu N --mem GiB --region R [--workload auto|general|memory|compute|burstable] [--os linux|windows] [--arch any|x64|arm] [--local-disk]',
        'azp models                      AI models with verified meters',
        'azp search --region R --service S [--product P] [--sku K] [--meter M]   find meters for the "meter" component',
        'azp validate-spec spec.json',
        'azp prepare --name YYYY-MM-DD-workload-pricing-estimate-region [--dir existing-directory]   allocate unused spec/report paths',
        'azp preflight spec.json         validate scope and grounded answers without pricing or confirmation',
        'azp answers                    verified human event locators and exact values for field-level sources (no questions or defaults)',
        'azp readback spec.json          plain-language check of every quantity; show it to the person and get their reply before build',
        'azp build spec.json --out estimate.html   price + advise + render + validate',
        'azp rules                       every advisory rule with its Microsoft source',
        'azp check-citations             verify each rule cites a live Microsoft page containing its quote',
        'All commands accept --compact (one-line JSON, no fields omitted). vm-suggest accepts --limit 1..50 (allMatches only; shortlist, warnings and errors remain complete).' ] };
  }
  // Tell the person up front if the model running this session is not one the skill was proven on.
  const ms = modelStatus();
  if (ms.notice && out && typeof out === 'object' && !Array.isArray(out)) out = Object.assign({ modelNotice: ms.notice, relayModelNotice: 'Tell the person this notice in plain words before continuing (once per conversation).' }, out);
  process.stdout.write(JSON.stringify(out, null, a.compact ? undefined : 2) + '\n');
  if (out && out.ok === false) process.exitCode = 2;
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, candidates: e.candidates || undefined }, null, process.argv.includes('--compact') ? undefined : 2) + '\n');
  process.exitCode = 1;
});
