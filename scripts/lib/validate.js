'use strict';
// Validation of a rendered estimate: arithmetic, HTML balance, spelling, tokens, links.
function checkMath(est) {
  const errs = [];
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  for (const o of est.options) {
    if (o.errors.length) continue;
    const sl = r2(o.lines.reduce((s, l) => s + l.list, 0)), sy = r2(o.lines.reduce((s, l) => s + l.your, 0));
    if (sl !== o.totalList) errs.push(`${o.name}: list lines sum ${sl} != total ${o.totalList}`);
    if (sy !== o.totalYour) errs.push(`${o.name}: your-price lines sum ${sy} != total ${o.totalYour}`);
    for (const l of o.lines) {
      if (l.list !== r2(l.list) || l.your !== r2(l.your)) errs.push(`${o.name}: unrounded line ${l.desc}`);
      const expect = r2(l.list * (1 - (l.discountPct || 0) / 100));
      if (Math.abs(expect - l.your) > 0.005) errs.push(`${o.name}: discount wrong on ${l.desc}`);
      if (!(l.list >= 0)) errs.push(`${o.name}: negative or NaN line ${l.desc}`);
    }
    for (const g of o.groups) {
      if (r2(g.lines.reduce((s, l) => s + l.list, 0)) !== g.list) errs.push(`${o.name}: subtotal ${g.name} mismatch`);
    }
  }
  return errs;
}

function checkHtml(html) {
  const errs = [];
  for (const t of ['table', 'tbody', 'thead', 'div', 'ul', 'ol', 'tr', 'h2', 'p', 'td', 'th']) {
    const o = (html.match(new RegExp(`<${t}[ >]`, 'g')) || []).length, c = (html.match(new RegExp(`</${t}>`, 'g')) || []).length;
    if (o !== c) errs.push(`Unbalanced <${t}>: ${o} open, ${c} close`);
  }
  const brit = html.match(/itemis|licence|organis|behaviour|catalogue|\bgrey\b|analys(e|ing)|optimis|centre\b|colour/gi);
  if (brit) errs.push('British spelling: ' + [...new Set(brit)].join(', '));
  if (/\{\{[A-Z_]+\}\}/.test(html)) errs.push('Leftover template tokens');
  if (/NaN|undefined|\[object Object\]/.test(html)) errs.push('NaN/undefined in output');
  return errs;
}

async function checkLinks(html) {
  const urls = [...new Set([...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]))];
  const errs = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'HEAD', redirect: 'follow' });
      if (r.status !== 200) {
        const g = await fetch(u, { method: 'GET', redirect: 'follow' });
        if (g.status !== 200) errs.push(`${g.status} ${u}`);
      }
    } catch (e) { errs.push(`ERR ${u} ${e.message}`); }
  }
  return { urls, errs };
}

// Normalize page text and quotes so a verbatim sentence can be found by substring match.
function normText(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;|&#34;/g, '"').replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// Every rule must cite a live Microsoft page that contains its quote verbatim.
async function checkCitations(rules) {
  const pages = new Map();
  const results = [];
  for (const r of rules) {
    let page = pages.get(r.url);
    if (!page) {
      try {
        const res = await fetch(r.url, { redirect: 'follow', headers: { 'User-Agent': 'azure-pricing-skill citation check' } });
        page = { status: res.status, text: res.status === 200 ? normText(await res.text()) : '' };
      } catch (e) { page = { status: 'ERR ' + e.message, text: '' }; }
      pages.set(r.url, page);
    }
    const found = page.status === 200 && page.text.includes(normText(r.quote));
    results.push({ id: r.id, url: r.url, status: page.status, quoteFound: found });
  }
  return { checked: results.length, failed: results.filter(x => x.status !== 200 || !x.quoteFound), results };
}

module.exports = { checkMath, checkHtml, checkLinks, checkCitations, normText };
