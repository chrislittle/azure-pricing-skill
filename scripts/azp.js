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
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; }
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
  const out = { region, workload, requirement: { vcpu, memGiB: mem }, shortlist: pick, allMatches: res.slice(0, 15),
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
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  // Models that failed testing cannot produce an estimate with this skill.
  const mst = modelStatus();
  if (mst.status === 'not-recommended') return { ok: false, stage: 'model', errors: [mst.notice.replace('This estimate is being prepared with', 'This conversation is using') + ' No estimate can be built with this model.'], relay: 'Tell the person exactly this, and stop. Do not try to work around it.' };
  const serr = validateSpec(spec);
  if (serr.length) return { ok: false, stage: 'spec', errors: serr };
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
  const out = a.out || specPath.replace(/\.json$/i, '') + '.html';
  const mathErr = checkMath(est), htmlErr = checkHtml(html);
  const links = a['no-links'] ? { urls: [], errs: [] } : await checkLinks(html);
  fs.writeFileSync(out, html);
  fs.writeFileSync(out.replace(/\.html$/i, '') + '.estimate.json', JSON.stringify({ estimate: est, advisories: adv }, null, 2));
  const ok = !mathErr.length && !htmlErr.length && !links.errs.length && !priceErrors.length;
  return {
    ok, file: path.resolve(out), currency: est.currency, discountPct: est.discountPct,
    options: est.options.map(o => ({ name: o.name, monthlyList: o.totalList, monthlyYourPrice: o.totalYour, lowest: !!o.lowest, errors: o.errors })),
    advisories: adv.map(x => ({ id: x.id, level: x.level, title: x.title, option: x.option, source: x.source ? [x.source.framework, x.source.code].filter(Boolean).join(' ') + ': ' + x.source.url : null })),
    validation: { math: mathErr, html: htmlErr, links: links.errs, linksChecked: links.urls.length },
    relay: 'Tell the customer the totals (list and your price), every advisory with level "warn" in plain words, then where the file is.',
    ...(adv.some(x => x.id === 'vm-end-of-life') ? { explainToPerson: adv.filter(x => x.id === 'vm-end-of-life').map(x => ({ say: x.body.replace(/<[^>]+>/g, ''), links: [x.source.url, ...(x.source.more || []).map(m => m.url)] })), explainInstruction: 'Explain why the requested size was replaced, in plain words based on "say", and include these Microsoft links in your reply.' } : {})
  };
}

async function main() {
  // Refuse to run with code injected at startup (preloaded scripts can rewrite the engine in memory).
  const inj = [...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/)].filter(a => /^(-r|--require|--import|--loader|--experimental-loader|--inspect|--eval|-e|-p|--print)/.test(a));
  if (inj.length) { process.stdout.write(JSON.stringify({ ok: false, stage: 'integrity', errors: ['The pricing engine was started with injected code (' + inj.join(' ') + '). Run it normally: node azp.js <command>.'] }, null, 2) + '\n'); process.exitCode = 2; return; }
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  let out;
  switch (cmd) {
    case 'questions': {
      const t = a._[1];
      if (t === 'plan') {
        // Ordered question plan in batches of at most three, one batch per message.
        const types = String(a.types || '').split(',').filter(Boolean);
        const qs = [];
        for (const ty of types) for (const [k, f] of Object.entries((SCHEMA[ty] || {}).fields || {})) if (f.req || (f.ask && /how many|how much|does it|is this|do you|must|need|which|what/i.test(f.ask))) qs.push({ about: `${ty}.${k}`, ask: f.ask || `What is the ${k} for the ${(SCHEMA[ty] || {}).label || ty}?`, default: f.def ?? null });
        for (const [k, v] of Object.entries(CONTEXT)) if (!v.internal && (!v.services || v.services.some(s => types.includes(s)))) qs.push({ about: `context.${k}`, ask: v.ask, default: v.def ?? null });
        const seen = new Set(); const uniq = qs.filter(q => !seen.has(q.about) && seen.add(q.about));
        const batches = []; for (let i = 0; i < uniq.length; i += 3) batches.push(uniq.slice(i, i + 3));
        out = { rule: 'Ask ONE batch per message, at most three questions, in plain words, offering the default. Skip any question the person already answered. Never ask for SKU names; translate their answers.', batches };
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
    case 'validate-spec': out = validateSpec(JSON.parse(fs.readFileSync(a._[1], 'utf8'))); break;
    case 'price': { const spec = expandSpec(JSON.parse(fs.readFileSync(a._[1], 'utf8'))); const e = await priceSpec(spec); out = { options: e.options.map(o => ({ name: o.name, list: o.totalList, your: o.totalYour, errors: o.errors, lines: o.lines.map(l => [l.desc, l.list, l.your]) })), advisories: advise(e).map(x => x.id) }; break; }
    case 'build': out = await cmdBuild(a); break;
    case 'readback': { const r = require('./lib/readback').readback(JSON.parse(fs.readFileSync(a._[1], 'utf8'))); out = { code: r.code, text: r.text, instructions: 'Show the person this text exactly as written, including the check code, and wait for their reply before running build.' }; break; }
    case 'rules': out = rulebook(); break;
    case 'check-citations': { const rb = rulebook(); const c = await checkCitations(rb.rules); out = { ok: !c.failed.length && !rb.rejected.length && !rb.unwired.length, rules: rb.rules.length, rejected: rb.rejected, unwired: rb.unwired, failed: c.failed, checked: c.checked }; break; }
    default:
      out = { usage: [
        'azp questions [type]            what to ask for each component type, with defaults',
        'azp vm-suggest --vcpu N --mem GiB --region R [--workload auto|general|memory|compute|burstable] [--os linux|windows] [--arch any|x64|arm] [--local-disk]',
        'azp models                      AI models with verified meters',
        'azp search --region R --service S [--product P] [--sku K] [--meter M]   find meters for the "meter" component',
        'azp validate-spec spec.json',
        'azp readback spec.json          plain-language check of every quantity; show it to the person and get their reply before build',
        'azp build spec.json --out estimate.html   price + advise + render + validate',
        'azp rules                       every advisory rule with its Microsoft source',
        'azp check-citations             verify each rule cites a live Microsoft page containing its quote' ] };
  }
  // Tell the person up front if the model running this session is not one the skill was proven on.
  const ms = modelStatus();
  if (ms.notice && out && typeof out === 'object' && !Array.isArray(out)) out = Object.assign({ modelNotice: ms.notice, relayModelNotice: 'Tell the person this notice in plain words before continuing (once per conversation).' }, out);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (out && out.ok === false) process.exitCode = 2;
}

main().catch(e => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, candidates: e.candidates || undefined }, null, 2) + '\n');
  process.exitCode = 1;
});
