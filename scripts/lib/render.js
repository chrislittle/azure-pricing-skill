'use strict';
// Priced estimate -> HTML in the standard pricing-estimate template.
const fs = require('fs');
const path = require('path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../assets/template.html'), 'utf8');
const STYLE = TEMPLATE.match(/<style>[\s\S]*?<\/style>/)[0];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Advisory bodies are authored in advisor.js (trusted) and may contain <strong>/<a>.
const trusted = s => String(s ?? '');

function money(n, cur) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function rate(n, cur) {
  const sym = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).formatToParts(0).find(p => p.type === 'currency').value;
  let s = Number(n).toFixed(6);
  if (Number(n) !== 0 && Number(s) === 0) s = Number(n).toPrecision(4);
  return sym + s;
}
function qtyFmt(n) {
  if (n >= 1e6 && Number.isInteger(n)) return (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 3 }) + 'M';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function longDate(d) { return new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }); }

function card(o, est, i, lowestTotal) {
  const cur = est.currency, disc = est.discountPct > 0;
  const cls = o.lowest ? 'card win' : o.special ? 'card muted' : 'card';
  const badge = o.lowest ? '<div class="badge">LOWEST COST</div>' : o.special ? '<div class="badge gray">SPECIAL CASE</div>' : '';
  const specs = (o.highlights || []).map(h => `<li${h.no ? ' class="no"' : ''}>${esc(h.text)}</li>`);
  if (!o.lowest && lowestTotal != null && o.totalYour > lowestTotal) specs.push(`<li class="no">${money(o.totalYour - lowestTotal, cur)} more each month than the lowest-cost option</li>`);
  if (o.lowest && est.options.length > 1) {
    const next = est.options.filter(x => x !== o && !x.errors.length).map(x => x.totalYour).sort((a, b) => a - b)[0];
    if (next != null) specs.push(`<li>Saves ${money((next - o.totalYour) * 12, cur)} each year against the next option</li>`);
  }
  return `  <div class="${cls}">
    ${badge}
    <div class="cap">
      <div class="opt">Option ${i + 1}</div>
      <div class="sku">${esc(o.name)}</div>
      <div class="proc">${esc(o.label)}</div>
    </div>
    <div class="body">
      <div class="price">${money(disc ? o.totalYour : o.totalList, cur)}<small>per month${disc ? ', your price' : ', list price'}</small></div>
      ${disc ? `<div class="strike">List ${money(o.totalList, cur)}</div>` : ''}
      ${specs.length ? `<ul class="spec">\n        ${specs.join('\n        ')}\n      </ul>` : ''}
    </div>
  </div>`;
}

function itemization(o, est, i) {
  const cur = est.currency;
  const tag = o.lowest ? '<span class="tag">LOWEST COST</span>' : o.special ? '<span class="tag gray">SPECIAL CASE</span>' : '';
  const rows = [];
  for (const g of o.groups) {
    rows.push(`    <tr class="grp"><td colspan="7">${esc(g.name)}</td></tr>`);
    for (const l of g.lines) {
      const unit = l.unitLabel ? `${esc(l.unit)} (${esc(l.unitLabel)})` : esc(l.unit);
      rows.push(`    <tr><td>${esc(l.service)}</td><td>${esc(l.desc)}</td><td class="c">${qtyFmt(l.qty)}</td><td>${unit}</td><td class="n">${rate(l.unitPrice, cur)}</td><td class="n">${money(l.list, cur)}</td><td class="n">${money(l.your, cur)}</td></tr>`);
    }
    if (o.groups.length > 1) rows.push(`    <tr class="sub"><td colspan="5">${esc(g.name)} subtotal</td><td class="n">${money(g.list, cur)}</td><td class="n">${money(g.your, cur)}</td></tr>`);
  }
  rows.push(`    <tr class="tot"><td colspan="5">Monthly total</td><td class="n">${money(o.totalList, cur)}</td><td class="n">${money(o.totalYour, cur)}</td></tr>`);
  return `<h2>Option ${i + 1} - ${esc(o.name)}${tag}</h2>

<table>
  <thead>
    <tr>
      <th style="width:15%">Service</th><th style="width:29%">Description</th><th class="c" style="width:7%">Qty</th>
      <th style="width:11%">Unit</th><th class="n" style="width:12%">Unit price</th><th class="n" style="width:12%">List</th><th class="n">Your price</th>
    </tr>
  </thead>
  <tbody>
${rows.join('\n')}
  </tbody>
</table>
${o.notes.length ? `<ul class="tight" style="font-size:12px;color:#605E5C">${o.notes.map(n => `<li>${linkify(n)}</li>`).join('')}</ul>` : ''}`;
}

function linkify(s) {
  return esc(s).replace(/(https:\/\/learn\.microsoft\.com\/[^\s)&<]+)/g, '<a href="$1">$1</a>');
}

function render(est, advisories) {
  const cur = est.currency, disc = est.discountPct > 0;
  const opts = est.options.filter(o => !o.errors.length);
  if (!opts.length) throw new Error('No option could be priced: ' + est.options.map(o => o.errors.join('; ')).join(' | '));
  const lowestTotal = Math.min(...opts.map(o => o.totalYour));
  const primary = opts.find(o => o.lowest) || opts[0];
  const date = longDate(est.capturedAt);
  const periodNote = opts.some(o => o.components.some(c => c.facts && c.facts.hours && c.facts.hours !== 730)) ? 'Monthly' : 'Monthly, 730 hours';

  const parts = [];
  parts.push(`<header class="doc-header">
  <h1>Pricing Estimate - ${esc(est.title)}</h1>
  <div class="meta">
    ${est.customer ? `<div>Prepared for <span>${esc(est.customer)}</span></div>` : ''}
    <div>Region <span>${esc(est.region.name)}</span></div>
    <div>Currency <span>${esc(cur)}</span></div>
    <div>Billing <span>${opts.some(o => o.components.some(c => (c.spec.commitment || 'payg') !== 'payg')) ? 'Pay-as-you-go and commitments' : 'Pay-as-you-go'}</span></div>
    <div>Period <span>${periodNote}</span></div>
    <div>Prepared <span>${date}</span></div>
  </div>
</header>`);
  parts.push(`<p class="note"><strong>This document is a pricing estimate, not a quote.</strong> Figures use published Azure rates on the date above and the assumptions listed below. ${disc ? `<strong>Your price</strong> applies your ${est.discountPct} percent discount to ${est.discountExcludes.length ? 'eligible' : 'every'} line.` : 'No discount has been applied; all figures are list prices.'} Actual billing varies with usage, region availability and rate changes.</p>`);

  parts.push(`<div class="cards">\n${opts.slice(0, 4).map((o, i) => card(o, est, est.options.indexOf(o), lowestTotal)).join('\n')}\n</div>`);

  if (opts.length > 1) {
    const rows = opts.slice().sort((a, b) => a.totalYour - b.totalYour).map(o => {
      const i = est.options.indexOf(o);
      return `    <tr${o.lowest ? ' class="win"' : o.special ? ' class="muted"' : ''}><td><strong>Option ${i + 1}</strong><br>${esc(o.name)}</td><td class="n">${money(disc ? o.totalYour : o.totalList, cur)}</td><td>${o.lowest ? '<strong>Lowest cost.</strong> ' : ''}${esc(o.whenToChoose || o.summary)}</td></tr>`;
    });
    parts.push(`<h2>How to choose</h2>

<table>
  <thead><tr><th style="width:30%">Option</th><th class="n" style="width:16%">${disc ? 'Your price' : 'List price'}</th><th>When to choose it</th></tr></thead>
  <tbody>
${rows.join('\n')}
  </tbody>
</table>`);
  }

  const warns = advisories.filter(a => a.level === 'warn');
  const infos = advisories.filter(a => a.level !== 'warn');
  const cite = a => a.source ? `\n  <span class="src" style="display:block;margin-top:6px;font-size:11.5px;color:#605E5C">Source: <a href="${esc(a.source.url)}">${esc([a.source.framework === 'Learn' || a.source.framework === 'Pricing' ? 'Microsoft Learn' : a.source.framework === 'WAF' ? 'Azure Well-Architected Framework' : a.source.framework === 'MCSB' ? 'Microsoft cloud security benchmark' : 'Azure Advisor', a.source.code].filter(Boolean).join(' ') + ': ' + a.source.title)}</a>${(a.source.more || []).map(m => `; <a href="${esc(m.url)}">${esc(m.title)}</a>`).join('')}</span>` : '';
  for (const a of warns) parts.push(`<div class="box warn">\n  <b>${esc(a.title)}</b>\n  ${trusted(a.body)}${cite(a)}\n</div>`);

  // What drives the cost (primary option)
  const tot = disc ? primary.totalYour : primary.totalList;
  const drivers = primary.groups.slice().sort((a, b) => (disc ? b.your - a.your : b.list - a.list)).map(g => {
    const v = disc ? g.your : g.list;
    return `    <tr><td>${esc(g.name)}</td><td class="n">${money(v, cur)}</td><td class="c">${tot ? Math.round(v / tot * 100) : 0}%</td><td>${esc(g.lines.map(l => l.desc).slice(0, 2).join('; '))}</td></tr>`;
  });
  parts.push(`<h2>What drives the cost${opts.length > 1 ? ` (Option ${est.options.indexOf(primary) + 1})` : ''}</h2>

<table>
  <thead><tr><th style="width:24%">Component</th><th class="n" style="width:16%">${disc ? 'Your price' : 'List price'}</th><th class="c" style="width:10%">Share</th><th>Includes</th></tr></thead>
  <tbody>
${drivers.join('\n')}
  </tbody>
</table>`);

  for (const a of infos) parts.push(`<div class="box">\n  <b>${esc(a.title)}</b>\n  ${trusted(a.body)}${cite(a)}\n</div>`);

  const hoursSet = [...new Set(opts.flatMap(o => o.components.filter(c => c.facts && c.facts.hours).map(c => c.facts.hours)))];
  const said = est.customerSaid || {};
  const saidParts = [['Region', said.region], ['Discount', said.discount], ['Requirements', said.requirements]].filter(([, v]) => v);
  const assumptions = [
    ...(saidParts.length ? [`Based on what you told us: ${saidParts.map(([k, v]) => `${k.toLowerCase()} "${v}"`).join('; ')}.`] : []),
    hoursSet.length ? (hoursSet.length === 1 && hoursSet[0] === 730 ? '730 hours per month, running continuously.' : `Compute hours per month as stated in each line (${hoursSet.join(', ')}). Storage bills for the full month.`) : 'Monthly quantities as stated in each line.',
    disc ? `Your price applies a ${est.discountPct} percent discount ${est.discountExcludes.length ? `to every line except ${est.discountExcludes.join(', ')}` : 'to every line'}.` : 'List prices. No discount applied.',
    `Rates retrieved live from the Azure Retail Prices API on ${date} in ${cur}. Unit prices are shown at full precision; each line is rounded to cents and the totals are the sum of the rounded lines.`,
    ...est.assumptions,
    ...(est.declined || []).map(d => `You chose to keep this as priced despite our advice (${d.id}): "${d.customerSaid}".`)
  ];
  if (est.excluded.length) assumptions.push(`<strong>Excluded:</strong> ${est.excluded.map(esc).join(', ')}.`);
  parts.push(`<h2>Assumptions</h2>\n\n<ul class="tight">\n${assumptions.map(a => `  <li>${a.startsWith('<strong>') ? a : esc(a)}</li>`).join('\n')}\n</ul>`);
  if (est.nextSteps.length) parts.push(`<h2>Next steps</h2>\n\n<ol class="next">\n${est.nextSteps.map(s => `  <li>${esc(s)}</li>`).join('\n')}\n</ol>`);

  parts.push(`<div class="pagebreak"></div>

<h2 style="margin-top:14px">Full itemization</h2>
<p style="font-size:13px;margin:6px 0 4px">Every line below is a separate Azure meter. <strong>List</strong> is the published rate. <strong>Your price</strong> ${disc ? `applies the ${est.discountPct} percent discount` : 'equals list; no discount applied'}.</p>`);
  opts.forEach(o => parts.push(itemization(o, est, est.options.indexOf(o))));
  const failed = est.options.filter(o => o.errors.length);
  if (failed.length) parts.push(`<div class="box warn"><b>Not priced</b>${failed.map(o => esc(o.name + ': ' + o.errors.join('; '))).join('<br>')}</div>`);

  parts.push(`<div class="foot">
  <p>Unit prices retrieved from the Azure Retail Prices API on ${date}. Region <code>${esc(est.region.code)}</code>, currency ${esc(cur)}. This estimate was generated by a deterministic pricing engine: meters, unit conversions, tiers, discounts and totals are computed, not written by hand.</p>
  <p>Customer answers: <strong>${est.verification === 'verified' ? 'verified against the conversation' : 'NOT VERIFIED'}</strong> &middot; Engine <code>${esc(est.fingerprint || '')}</code> ${est.engineIntact ? '(sealed)' : '<strong>MODIFIED</strong>'}${est.model && est.model.model ? ` &middot; AI model <code>${esc(est.model.model)}</code> (${esc({ recommended: 'recommended', acceptable: 'tested, less consistent', 'not-recommended': 'NOT RECOMMENDED', untested: 'not tested' }[est.model.status] || est.model.status)})` : ''}</p>
</div>`);
  if (est.model && est.model.notice && est.model.status !== 'acceptable') parts.splice(1, 0, `<div class="box warn"><b>${est.model.status === 'not-recommended' ? 'Prepared with a model that is not recommended' : 'Prepared with an untested model'}</b>${esc(est.model.notice)}</div>`);
  if (!est.engineIntact) parts.splice(1, 0, `<div class="box warn"><b>Pricing engine modified</b>The pricing engine that produced this estimate does not match the released version. Figures may not be reliable. Re-run with an unmodified copy of the skill.</div>`);
  if (est.verification !== 'verified') parts.splice(1, 0, `<div class="box warn"><b>Inputs not verified</b>The region, discount and requirements in this estimate could not be checked against what the customer said. Confirm them before relying on these figures.</div>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Azure Pricing Estimate - ${esc(est.title)} - ${esc(est.region.name)}</title>
${STYLE}
</head>
<body>
<main>

${parts.join('\n\n')}

</main>
</body>
</html>
`;
}

module.exports = { render, money };
