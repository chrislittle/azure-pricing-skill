'use strict';
// Deterministic advisor. Conditions live here; every customer-facing word, level, threshold and
// the published Microsoft source live in catalog/rules.json. A condition with no cited rule in
// rules.json never fires: no citation, no advice.
const catalog = require('../../catalog/catalog.json');
const RULEBOOK = require('../../catalog/rules.json');
// Service rules live in catalog/rules/<type>.json ({ "rules": { id: rule } }), one file per service.
{
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', '..', 'catalog', 'rules');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    for (const [id, r] of Object.entries(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).rules || {})) {
      if (RULEBOOK.rules[id]) throw new Error(`catalog/rules/${f}: rule id "${id}" already exists`);
      RULEBOOK.rules[id] = r;
    }
  }
}

const FRAMEWORKS = new Set(['WAF', 'Advisor', 'MCSB', 'Learn', 'Pricing']);
const SOURCE_HOSTS = /^https:\/\/(learn\.microsoft\.com|azure\.microsoft\.com)\//;

function citationErrors(id, r) {
  const e = [];
  const c = r && r.citation;
  if (!c) return [`${id}: no citation`];
  if (!FRAMEWORKS.has(c.framework)) e.push(`${id}: framework must be one of ${[...FRAMEWORKS].join(', ')}`);
  if (!SOURCE_HOSTS.test(c.url || '')) e.push(`${id}: citation url must be a learn.microsoft.com or azure.microsoft.com page`);
  if (!c.source) e.push(`${id}: citation source title missing`);
  if (!c.quote || c.quote.trim().split(/\s+/).length < 6) e.push(`${id}: citation quote missing or too short`);
  for (const m of c.more || []) {
    if (!SOURCE_HOSTS.test(m.url || '') || !m.source || !m.quote || m.quote.trim().split(/\s+/).length < 6) e.push(`${id}: an additional citation is incomplete`);
  }
  if (!['warn', 'info'].includes(r.level)) e.push(`${id}: level must be warn or info`);
  if (!r.title || !r.body) e.push(`${id}: title and body required`);
  if (r.when) {
    const OPS = new Set(['in', 'notIn', '!=', '>', '>=', '<', '<=', 'exists', 'match', 'default']);
    const TYPES = new Set(Object.keys(require('./schema').SCHEMA));
    const CTX = new Set(Object.keys(require('./schema').CONTEXT));
    const chk = t => { if (t && typeof t === 'object' && !Array.isArray(t)) for (const k of Object.keys(t)) if (!OPS.has(k)) e.push(`${id}: unknown operator "${k}"`); };
    if (r.when.scope && !['option', 'estimate'].includes(r.when.scope)) e.push(`${id}: scope must be option or estimate`);
    for (const [k, t] of Object.entries(r.when.context || {})) { if (!CTX.has(k)) e.push(`${id}: unknown context field "${k}"`); chk(t); }
    const ms = [...(r.when.all || []), ...(r.when.none || []), ...((r.when.anyOption || {}).all || []), ...((r.when.noOption || {}).all || [])];
    for (const m of ms) {
      if (m.type && !TYPES.has(m.type)) e.push(`${id}: unknown component type "${m.type}"`);
      for (const [p, t] of Object.entries(m.where || {})) { if (!/^(spec|facts)\./.test(p)) e.push(`${id}: where path must start with spec. or facts. ("${p}")`); chk(t); }
    }
  }
  return e;
}

// Only rules with a complete citation are loaded.
const RULES = {};
const REJECTED = [];
for (const [id, r] of Object.entries(RULEBOOK.rules || {})) {
  const errs = citationErrors(id, r);
  if (errs.length) REJECTED.push(...errs); else RULES[id] = r;
}

const fmt = (n, cur) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2 }).format(n);
const num = n => Number(n).toLocaleString('en-US');
const comps = (opt, type) => opt.components.filter(c => c.spec.type === type);
const P = id => (RULES[id] && RULES[id].params) || {};

// Each condition: (est, opt) -> undefined | vars | [vars]. Per-estimate conditions take only est.
// vars fill {{name}} placeholders in the rule's title and body.
const CONDITIONS = {
  // ---- Networking and security
  'public-ip-on-vm': (est, opt) => {
    if (!comps(opt, 'vm').length || !comps(opt, 'public-ip').length) return;
    if (['load-balancer', 'app-gateway'].some(t => comps(opt, t).length) || est.context.frontDoor) return;
    return {};
  },
  'app-gateway-without-waf': (est, opt) => { if (comps(opt, 'app-gateway').some(c => c.spec.waf === false)) return {}; },
  // ---- AKS
  'aks-free-production': (est, opt) => {
    const a = comps(opt, 'aks')[0];
    if (a && a.facts.tier === 'free' && est.context.production) return {};
  },
  // ---- Licensing
  'rhel-license-regionless': (est, opt) => { if (comps(opt, 'vm').some(c => c.facts.os === 'rhel')) return {}; },
  'ahb-applied': (est, opt) => {
    const w = comps(opt, 'vm').filter(c => c.facts.os === 'windows-ahb'); if (!w.length) return;
    const saved = w.reduce((s, c) => s + ((c.facts.winRate || 0) - c.facts.baseRate) * c.facts.hours * c.facts.count, 0);
    return { saved: fmt(saved, est.currency) };
  },
  'ahb-opportunity': (est, opt) => {
    const w = comps(opt, 'vm').filter(c => c.facts.os === 'windows'); if (!w.length) return;
    const lic = w.reduce((s, c) => s + ((c.facts.winRate || 0) - c.facts.baseRate) * c.facts.hours * c.facts.count, 0);
    return { license: fmt(lic, est.currency) };
  },
  'sql-license-included': (est, opt) => { if ([...comps(opt, 'sql-database'), ...comps(opt, 'sql-mi')].some(c => !c.facts.ahb && c.facts.tier !== 'hyperscale' && c.facts.compute !== 'serverless')) return {}; },
  'sql-ahb-applied': (est, opt) => { if ([...comps(opt, 'sql-database'), ...comps(opt, 'sql-mi')].some(c => c.facts.ahb && c.facts.tier !== 'hyperscale')) return {}; },
  // ---- VM completeness, redundancy and lifecycle
  'vm-without-disk': (est, opt) => {
    if (!comps(opt, 'vm').length || comps(opt, 'disk').length) return;
    if (est.options.some(o => comps(o, 'aks').length)) return;
    if ((est.excluded || []).some(e => /disk|storage/i.test(String(e)))) return;
    return { _mustAct: true };
  },
  'single-vm-production': (est, opt) => {
    if (!est.context.production || est.context.zoneResilience === false || est.options.some(o => comps(o, 'aks').length)) return;
    const vms = comps(opt, 'vm');
    if (vms.length === 1 && (vms[0].spec.count || 1) < 2 && !comps(opt, 'load-balancer').length && !comps(opt, 'app-gateway').length) return {};
  },
  'vm-end-of-life': (est) => {
    const { lifecycle } = require('./lifecycle');
    return (est.replacedSizes || []).map(r => { const l = lifecycle(r.requested); if (l.modern) return null;
      return { sku: r.requested, series: l.series, stageText: l.stage === 'Retired' ? 'retired' : 'End of Life (retirement announced)',
        retire: l.retires2029 ? ' The Dv3, Dsv3, Ev3 and Esv3 series retire on November 15, 2029; after that date you can\'t create, resize into, run, or purchase these sizes.' : '' }; }).filter(Boolean);
  },
  // ---- Commitments and run time
  'commitment-part-time': (est) => {
    const v = est.options.flatMap(o => comps(o, 'vm')).find(c => c.facts.hours < 730 && (c.spec.commitment || 'payg') !== 'payg');
    if (v) return { hours: num(v.facts.hours), pct: Math.round(v.facts.hours / 730 * 100) };
  },
  'part-time-payg': (est) => {
    const vms = est.options.flatMap(o => comps(o, 'vm'));
    if (vms.some(c => (c.spec.commitment || 'payg') !== 'payg' && c.facts.hours < 730)) return;
    const v = vms.find(c => c.facts.hours < 730);
    if (v) return { hours: num(v.facts.hours), pct: Math.round(v.facts.hours / 730 * 100) };
  },
  'disks-bill-when-stopped': (est) => {
    if (est.options.some(o => comps(o, 'vm').some(c => c.facts.hours < 730) && comps(o, 'disk').length)) return {};
  },
  'ri-vs-sp-tradeoff': (est) => {
    const kinds = new Set(est.options.flatMap(o => comps(o, 'vm').map(c => (c.spec.commitment || 'payg').slice(0, 2))));
    if (kinds.has('ri') && kinds.has('sp')) return {};
  },
  'ri-covers-compute-only': (est) => { if (est.options.some(o => comps(o, 'vm').some(c => /^ri/.test(c.spec.commitment || '')))) return {}; },
  'consider-commitment': (est) => {
    if (!est.context.production || typeof est.context.steadyUsage === 'boolean') return;
    const vms = est.options.flatMap(o => comps(o, 'vm'));
    if (vms.length && vms.every(c => c.facts.hours >= 730 && (c.spec.commitment || 'payg') === 'payg')) return {};
  },
  // ---- Disks
  'disk-tier-rounding': (est, opt) => {
    const band = P('disk-tier-rounding').band || 1.2;
    for (const d of comps(opt, 'disk')) {
      const f = d.facts; if (!f.tierGiB || f.type === 'premium-v2') continue;
      const t = catalog.diskTiers[f.type].tiers; const i = t.findIndex(x => x[0] === f.tier);
      const prev = i > 0 ? t[i - 1] : null;
      if (prev && f.sizeGiB > prev[1] && f.sizeGiB <= prev[1] * band) return { size: num(f.sizeGiB), tier: f.tier, tierGiB: num(f.tierGiB), prevTier: prev[0], prevGiB: num(prev[1]) };
    }
  },
  'disk-perf-shortfall': (est, opt) => {
    for (const d of comps(opt, 'disk')) {
      const f = d.facts;
      if (f.requiredIops && f.iops && f.requiredIops > f.iops) return { tier: f.tier, need: num(f.requiredIops) + ' IOPS', have: num(f.iops) + ' IOPS', _mustAct: true };
      if (f.requiredMBps && f.mbps && f.requiredMBps > f.mbps) return { tier: f.tier, need: num(f.requiredMBps) + ' MB/s', have: num(f.mbps) + ' MB/s', _mustAct: true };
    }
  },
  'premium-v2-compare': (est, opt) => {
    if (est.options.some(o => comps(o, 'disk').some(d => d.facts.type === 'premium-v2'))) return;
    if (comps(opt, 'disk').some(d => d.facts.type === 'premium-ssd' && (d.facts.requiredIops || d.facts.requiredMBps))) return {};
  },
  'vm-disk-cap': (est, opt) => {
    const vm = comps(opt, 'vm')[0]; if (!vm || !vm.facts.spec) return;
    const need = comps(opt, 'disk').reduce((s, d) => s + (d.facts.requiredIops || 0), 0);
    if (need && vm.facts.spec.uncachedIops && need > vm.facts.spec.uncachedIops) return { sku: vm.facts.sku, cap: num(vm.facts.spec.uncachedIops), need: num(need), _mustAct: true };
  },
  'hdd-os-disk-retirement': (est, opt) => { if (comps(opt, 'disk').some(d => d.facts.type === 'standard-hdd' && /\bos\b/i.test(d.spec.role || ''))) return {}; },
  'disk-zrs-production': (est, opt) => {
    if (est.context.production && est.context.zoneResilience !== false && comps(opt, 'disk').some(d => ['standard-ssd', 'premium-ssd'].includes(d.facts.type) && (d.facts.redundancy || 'LRS') === 'LRS')) return {};
  },
  // ---- Storage
  'archive-rehydration': (est, opt) => { if (comps(opt, 'blob').some(c => c.facts.tier === 'Archive')) return {}; },
  'storage-redundancy-production': (est, opt) => {
    if (est.context.production && est.context.zoneResilience !== false && comps(opt, 'blob').some(c => (c.facts.redundancy || 'LRS') === 'LRS')) return {};
  },
  'files-billing-model': (est, opt) => { if (comps(opt, 'files').length) return {}; },
  // ---- Networking cost
  'tiered-egress': (est, opt) => {
    const bw = comps(opt, 'bandwidth')[0];
    if (bw && bw.facts.egressGB > (P('tiered-egress').minGB || 10240)) return { gb: num(bw.facts.egressGB) };
  },
  'egress-guess': (est, opt) => { const bw = comps(opt, 'bandwidth')[0]; if (bw && bw.facts.guess) return {}; },
  // ---- App platforms
  'free-grant': (est, opt) => { if (comps(opt, 'functions').some(f => (f.spec.plan || 'consumption') === 'consumption')) return {}; },
  'app-service-single-instance': (est, opt) => { if (est.context.production && comps(opt, 'app-service').some(a => (a.spec.count || 1) < 2)) return {}; },
  'container-apps-replicas': (est, opt) => {
    if (est.context.internetFacing && comps(opt, 'container-apps').some(c => (c.spec.replicas ?? 1) < 3)) return {};
  },
  // ---- Databases
  'ha-doubles-compute': (est, opt) => { if ([...comps(opt, 'postgres'), ...comps(opt, 'mysql')].some(x => x.facts.ha)) return {}; },
  'postgres-ha-production': (est, opt) => { if (est.context.production && comps(opt, 'postgres').some(x => !x.facts.ha)) return {}; },
  'mysql-ha-production': (est, opt) => { if (est.context.production && comps(opt, 'mysql').some(x => !x.facts.ha)) return {}; },
  'cosmos-autoscale-max': (est, opt) => { if (comps(opt, 'cosmos').some(x => x.facts.mode === 'autoscale')) return {}; },
  'cosmos-single-region-production': (est, opt) => { if (est.context.production && est.context.zoneResilience !== false && est.context.multiRegionUsers !== false && comps(opt, 'cosmos').some(x => (x.facts.regions || 1) < 2)) return {}; },
  // ---- Monitoring and AI
  'log-analytics-commitment-tier': (est, opt) => {
    const la = comps(opt, 'log-analytics')[0];
    if (la && la.facts.perDay >= (P('log-analytics-commitment-tier').minGBPerDay || 100)) return { perDay: num(la.facts.perDay) };
  },
  'log-analytics-long-retention': (est, opt) => {
    const la = comps(opt, 'log-analytics')[0]; const d = la && Number(la.spec.retentionDays || 31);
    if (la && d > (P('log-analytics-long-retention').minDays || 90)) return { days: num(d) };
  },
  'prompt-caching': (est, opt) => { if (comps(opt, 'openai').some(o => !(o.spec.cachedInputTokens > 0))) return {}; },
  'model-legacy': (est, opt) => { const o = comps(opt, 'openai').find(x => x.facts.legacy); if (o) return { model: o.facts.model }; },
  // ---- Estimate framing
  'options-not-like-for-like': (est) => {
    const FRONT = new Set(['public-ip', 'load-balancer', 'app-gateway']);
    const sig = o => [...new Set(o.components.map(c => c.spec.type).filter(t => !FRONT.has(t)))].sort().join(',');
    const ok = est.options.filter(o => !o.errors.length);
    for (const scope of new Set(ok.map(o => o.scenario ? o.scenario.id : 'legacy'))) {
      const peers = ok.filter(o => (o.scenario ? o.scenario.id : 'legacy') === scope);
      if (peers.length >= 2 && new Set(peers.map(sig)).size > 1) return {};
    }
  },
  'no-discount': (est) => { if (!est.discountPct) return {}; },
  'currency-native': (est) => { if (est.currency !== 'USD') return { currency: est.currency }; }
};
// Declarative conditions for rules in rules.json:
// "when": { "scope": "option"|"estimate", "context": { "production": true, ... },
//           "all": [ { "type": "vm", "where": { "spec.commitment": "payg", "facts.hours": { ">=": 730 } } } ],
//           "none": [ { "type": "load-balancer" } ] }
const getPath = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
function test(v, t) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return Array.isArray(t) ? t.includes(v) : v === t;
  return Object.entries(t).every(([op, x]) => {
    switch (op) {
      case 'in': return x.includes(v);
      case 'notIn': return !x.includes(v);
      case '!=': return v !== x;
      case '>': return Number(v) > x; case '>=': return Number(v) >= x;
      case '<': return Number(v) < x; case '<=': return Number(v) <= x;
      case 'exists': return (v != null) === x;
      case 'match': return new RegExp(x, 'i').test(String(v ?? ''));
      case 'default': return true;
      default: throw new Error('unknown operator ' + op);
    }
  });
}
function compMatches(c, m) {
  if (m.type && c.spec.type !== m.type) return false;
  return Object.entries(m.where || {}).every(([p, t]) => {
    let v = getPath(c, p);
    if (v == null && t && typeof t === 'object' && 'default' in t) v = t.default;
    return test(v, t);
  });
}
function whenHolds(w, est, opt) {
  for (const [k, t] of Object.entries(w.context || {})) if (!test(est.context[k], t)) return false;
  const pool = opt ? opt.components : est.options.flatMap(o => o.components);
  for (const m of w.all || []) { const n = pool.filter(c => compMatches(c, m)).length; if (n < (m.min || 1) || (m.max != null && n > m.max)) return false; }
  for (const m of w.none || []) if (pool.some(c => compMatches(c, m))) return false;
  if (w.anyOption && !est.options.some(o => (w.anyOption.all || []).every(m => o.components.some(c => compMatches(c, m))))) return false;
  if (w.noOption && est.options.some(o => (w.noOption.all || []).every(m => o.components.some(c => compMatches(c, m))))) return false;
  return true;
}
function declarative(rule) {
  const w = rule.when;
  return w.scope === 'estimate' ? (est) => (whenHolds(w, est, null) ? {} : undefined) : (est, opt) => (whenHolds(w, est, opt) ? {} : undefined);
}

const fill = (s, v) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => (v[k] != null ? String(v[k]) : ''));

function advise(est) {
  const out = [];
  const ids = [...new Set([...Object.keys(CONDITIONS), ...Object.keys(RULES)])];
  for (const id of ids) {
    const rule = RULES[id]; if (!rule) continue;
    const cond = CONDITIONS[id] || (rule.when ? declarative(rule) : null); if (!cond) continue;
    const runs = cond.length < 2 ? [[null, cond(est)]] : est.options.map(o => {
      const options = o.scenario ? est.options.filter(peer => peer.scenario && peer.scenario.id === o.scenario.id) : est.options;
      return [o, cond(Object.assign({}, est, { options, context: Object.assign({}, est.context, o.context) }), o)];
    });
    for (const [opt, res] of runs) {
      for (const v of [].concat(res || [])) {
        if (!v) continue;
        const title = fill(rule.title, v);
        if (out.some(y => y.id === id && y.title === title)) continue;
        const c = rule.citation;
        out.push({ id, level: rule.level, title, body: fill(rule.body, v), option: opt ? opt.name : null, mustAct: !!v._mustAct,
          source: { framework: c.framework, code: c.code || null, title: c.source, url: c.url, more: (c.more || []).filter((m, i, a) => a.findIndex(x => x.url === m.url) === i && m.url !== c.url).map(m => ({ title: m.source, url: m.url })) } });
      }
    }
  }
  return out;
}

// For review and tests: every rule with its citation, plus anything rejected or unwired.
function rulebook() {
  return {
    rules: Object.entries(RULES).flatMap(([id, r]) => [{ id, level: r.level, title: r.title, framework: r.citation.framework, code: r.citation.code || null, source: r.citation.source, url: r.citation.url, quote: r.citation.quote },
      ...(r.citation.more || []).map((m, i) => ({ id: `${id}#${i + 2}`, level: r.level, title: r.title, framework: r.citation.framework, code: null, source: m.source, url: m.url, quote: m.quote }))]),
    rejected: REJECTED,
    unwired: Object.keys(RULES).filter(id => !CONDITIONS[id] && !RULES[id].when),
    conditionsWithoutRule: Object.keys(CONDITIONS).filter(id => !RULES[id])
  };
}

module.exports = { advise, rulebook, citationErrors, whenHolds };
