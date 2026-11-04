'use strict';
// Priced estimate -> self-contained, progressively enhanced HTML.
const fs = require('fs');
const path = require('path');
const { parseUnit } = require('./units');
const TEMPLATE = fs.readFileSync(path.join(__dirname, '../../assets/template.html'), 'utf8');
const STYLE = TEMPLATE.match(/<style>[\s\S]*?<\/style>/)[0];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function money(n, cur) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function qtyFmt(n) {
  return Number(n).toLocaleString('en-US', { maximumSignificantDigits: 15 });
}
function longDate(d) { return new Date(d).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }); }
function linkify(s) {
  return esc(s).replace(/(https:\/\/learn\.microsoft\.com\/[^\s)&<]+)/g, '<a href="$1">$1</a>');
}

function displayQuantity(o, line) {
  const comp = (o.components || [])[line.componentIndex] || (o.components || []).find(c => c.lines.includes(line));
  if (comp) {
    const type = comp.spec.type;
    const count = comp.facts && comp.facts.count;
    if (['vm', 'public-ip', 'app-service'].includes(type) && ['hours', 'instance-hours'].includes(line.unit) && count > 0) {
      const resource = type === 'vm' ? (line.service === 'VM Licenses' ? 'VM licenses' : 'VMs') : type === 'public-ip' ? 'IP addresses' : 'instances';
      return { qty: count, unit: `${resource} x ${qtyFmt(line.qty / count)} hrs` };
    }
    if (type === 'meter' && comp.spec.hours > 0 && comp.spec.quantity > 0 && parseUnit(line.meter ? line.meter.unitOfMeasure : line.unit).kind === 'hour') {
      return { qty: comp.spec.quantity, unit: `instances x ${qtyFmt(comp.spec.hours)} hrs` };
    }
  }
  // Usage meters retain their actual quantities, never inferred resource counts.
  return { qty: line.qty, unit: line.unit };
}

function table(headers, rows, caption) {
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(caption || 'Monthly cost comparison')}"><table${caption ? ' class="itemization"' : ''}>${caption ? `<caption>${esc(caption)}</caption>` : ''}<thead><tr>${headers.map((h, i) => `<th scope="col"${i >= headers.length - 2 ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('\n')}</tbody></table></div>`;
}

function itemization(o, est) {
  const rows = [];
  for (const g of o.groups) {
    rows.push(`<tr class="grp"><th colspan="5" scope="rowgroup">${esc(g.name)}</th></tr>`);
    for (const l of g.lines) {
      const d = displayQuantity(o, l);
      rows.push(`<tr><td><strong>${esc(l.service)}</strong><br>${esc(l.desc)}</td><td class="c">${qtyFmt(d.qty)}</td><td>${esc(d.unit)}</td><td class="n">${money(l.list, est.currency)}</td><td class="n">${money(l.your, est.currency)}</td></tr>`);
    }
    if (o.groups.length > 1) rows.push(`<tr class="sub"><td colspan="3">${esc(g.name)} subtotal</td><td class="n">${money(g.list, est.currency)}</td><td class="n">${money(g.your, est.currency)}</td></tr>`);
  }
  rows.push(`<tr class="tot"><td colspan="3">Monthly total</td><td class="n">${money(o.totalList, est.currency)}</td><td class="n">${money(o.totalYour, est.currency)}</td></tr>`);
  return table(['Service / description', 'Qty', 'Unit', 'List / month', 'Your price / month'], rows, o.purchasing || o.name);
}

function advisory(a) {
  // Advisory bodies are trusted engine-authored markup, not customer input.
  const src = a.source;
  const cite = src ? `<span class="src">Source: <a href="${esc(src.url)}">${esc([src.framework, src.code, src.title].filter(Boolean).join(' - '))}</a>${(src.more || []).map(m => `; <a href="${esc(m.url)}">${esc(m.title)}</a>`).join('')}</span>` : '';
  return `<div class="box${a.level === 'warn' ? ' warn' : ''}"><b>${esc(a.title)}${a.option ? ` - ${esc(a.option)}` : ''}</b>${String(a.body ?? '')}${cite}</div>`;
}

// No customer-controlled text is embedded in this script.
const NAVIGATION = `<script>
(function () {
  var tabs = Array.from(document.querySelectorAll('.tab'));
  var panes = Array.from(document.querySelectorAll('.pane'));
  var nav = document.querySelector('.tabs');
  nav.setAttribute('role', 'tablist');
  tabs.forEach(function (tab) {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'p-' + tab.dataset.tab);
    tab.addEventListener('click', function (event) {
      event.preventDefault();
      show(tab.dataset.tab, true);
    });
    tab.addEventListener('keydown', function (event) {
      var index = tabs.indexOf(tab), next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next != null) {
        event.preventDefault();
        tabs[next].focus();
        show(tabs[next].dataset.tab, true);
      }
    });
  });
  panes.forEach(function (pane) { pane.setAttribute('role', 'tabpanel'); });
  function show(id, update) {
    if (!tabs.some(function (tab) { return tab.dataset.tab === id; })) id = 'summary';
    tabs.forEach(function (tab) {
      var on = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    panes.forEach(function (pane) { pane.classList.toggle('on', pane.id === 'p-' + id); });
    document.getElementById('view').scrollTop = 0;
    if (update && location.hash !== '#p-' + id) history.pushState(null, '', '#p-' + id);
  }
  function fromHash() { show(location.hash.slice(1).replace(/^p-/, '')); }
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('popstate', fromHash);
  fromHash();
  document.documentElement.classList.add('js');
})();
</script>`;

function render(est, advisories = []) {
  const cur = est.currency, disc = est.discountPct > 0;
  const priced = est.options.filter(o => !o.errors.length);
  if (!priced.length) throw new Error('No option could be priced: ' + est.options.map(o => o.errors.join('; ')).join(' | '));
  const scenarios = [];
  for (const [i, o] of est.options.entries()) {
    const id = o.scenario ? o.scenario.id : `legacy-${i}`;
    let s = scenarios.find(s => s.id === id);
    if (!s) { s = { id, name: o.scenario ? o.scenario.name : o.name, tab: `estimate-${scenarios.length + 1}`, options: [] }; scenarios.push(s); }
    s.options.push(o);
  }
  const date = longDate(est.capturedAt);
  const failed = est.options.filter(o => o.errors.length);
  const notices = [];
  if (est.verification !== 'verified') notices.push('<div class="box warn"><b>Inputs not verified</b>The region, discount and requirements could not be checked against what the customer said. Confirm them before relying on these figures.</div>');
  if (!est.engineIntact) notices.push('<div class="box warn"><b>Pricing engine modified</b>The pricing engine does not match the released version. Figures may not be reliable. Re-run with an unmodified copy of the skill.</div>');
  if (est.model && est.model.notice && est.model.status !== 'acceptable') notices.push(`<div class="box warn"><b>${est.model.status === 'not-recommended' ? 'Prepared with a model that is not recommended' : 'Prepared with an untested model'}</b>${esc(est.model.notice)}</div>`);
  if (failed.length) notices.push(`<div class="box warn"><b>Not priced - incomplete estimate</b>${failed.map(o => `${esc(o.name)}: ${esc(o.errors.join('; '))}`).join('<br>')}<br>Partial costs are not shown as complete totals.</div>`);
  notices.push(...advisories.filter(a => a.level === 'warn').map(advisory));

  const purchasingOptions = [...new Set(est.options.map(o => o.purchasing || o.name))];
  const summaryRows = scenarios.map(s => `<tr><td><a href="#p-${s.tab}">${esc(s.name)}</a></td>${purchasingOptions.map(label => {
    const o = s.options.find(o => (o.purchasing || o.name) === label);
    if (!o) return '<td>Not compared</td>';
    if (o.errors.length) return '<td>Not priced</td>';
    return `<td class="n"><strong>${money(o.totalYour, cur)}</strong>${disc ? `<br><span class="muted">List ${money(o.totalList, cur)}</span>` : ''}</td>`;
  }).join('')}</tr>`);
  const disclaimer = `<p class="note"><strong>This is a pricing estimate, not a quote.</strong> Monthly costs use published Azure rates retrieved on ${esc(date)} in ${esc(cur)}. ${disc ? `Your price applies a ${esc(est.discountPct)} percent discount to eligible lines.` : 'No discount has been applied; your price equals list.'} Actual billing varies with usage, availability and rate changes.</p>`;
  const summary = `<h2>Summary</h2>${disclaimer}<p>${disc ? 'Your price per month, with list price underneath.' : 'Monthly list prices; no discount applied.'}</p>${table(['Estimate / phase', ...purchasingOptions], summaryRows)}<p class="muted">Each row is a separate estimate, not an amount to add together. Deployment phases are separate scopes, not ranked alternatives. Purchasing comparisons within a phase keep the same resources; commitments change only eligible VM compute. All costs are monthly, including amortized commitments. "Not compared" means that purchasing variant was not generated for that scope.</p>`;
  const panes = [{ id: 'summary', label: 'Summary', body: summary }];
  for (const s of scenarios) {
    const bodies = s.options.map(o => {
      if (o.errors.length) return `<h3>${esc(o.purchasing || o.name)}</h3><div class="box warn"><b>Not priced</b>${o.errors.map(esc).join('<br>')}</div>`;
      const highlights = (o.highlights || []).map(h => `<li>${esc(h.text)}</li>`).join('');
      const drivers = o.groups.map(g => `<tr><td>${esc(g.name)}</td><td class="n">${money(g.list, cur)}</td><td class="n">${money(g.your, cur)}</td></tr>`);
      return `<h3>${esc(o.purchasing || o.name)}${o.special ? ' - special case' : ''}</h3>
${o.scenario && o.scenario.phase ? `<p class="muted">Deployment phase: ${esc(o.scenario.phase)}</p>` : ''}
<div class="price">${money(o.totalYour, cur)} <small>per month${disc ? `; list ${money(o.totalList, cur)}` : '; list price'}</small></div>
${o.label ? `<p>${esc(o.label)}</p>` : ''}${o.summary || o.whenToChoose ? `<p>${esc(o.summary || o.whenToChoose)}</p>` : ''}${highlights ? `<ul class="tight">${highlights}</ul>` : ''}
${itemization(o, est)}
<h3>What drives the cost</h3>${table(['Component', 'List / month', 'Your price / month'], drivers)}
${o.notes.length ? `<ul class="tight muted">${o.notes.map(n => `<li>${linkify(n)}</li>`).join('')}</ul>` : ''}`;
    });
    panes.push({ id: s.tab, label: s.name, body: `<h2>${esc(s.name)}</h2>${bodies.join('\n')}` });
  }

  const hours = [...new Set(priced.flatMap(o => o.components.filter(c => c.facts && c.facts.hours != null).map(c => c.facts.hours)))];
  const said = est.customerSaid || {};
  const assumptions = [
    ...[['Region', said.region], ['Discount', said.discount], ['Requirements', said.requirements]].filter(([, v]) => v).map(([k, v]) => `${k}, in your words: "${v}".`),
    hours.length ? `Compute runtime per month: ${hours.join(', ')} hours as specified. Storage bills for the full month; commitments can bill continuously even when runtime is shorter.` : 'Monthly quantities as stated in each line.',
    `Rates retrieved live from the Azure Retail Prices API on ${date} in ${cur}. Each line is rounded to cents; totals sum the rounded lines. Exact meter quantities, rate units and unit prices are retained in the companion .estimate.json audit file.`,
    ...(est.assumptions || []),
    ...((est.excluded || []).length ? [`Excluded: ${est.excluded.join(', ')}.`] : []),
    ...(est.declined || []).map(d => `You chose to keep this as priced despite our advice (${d.id}): "${d.customerSaid}".`)
  ];
  const discounts = [...new Set(priced.flatMap(o => o.lines.map(l => `${l.service}: ${l.discountPct || 0}% off list.`)))];
  const assumptionBody = `<h2>Assumptions &amp; guidance</h2><h3>Discount rules applied</h3><p>${disc ? `Requested discount: ${esc(est.discountPct)} percent.${est.discountExcludes.length ? ` Exclusions: ${esc(est.discountExcludes.join(', '))}.` : ''}` : 'No discount requested.'}</p><ul class="tight">${discounts.map(d => `<li>${esc(d)}</li>`).join('')}</ul>
<h3>Scope and assumptions</h3><ul class="tight">${assumptions.map(a => `<li>${linkify(a)}</li>`).join('')}</ul>
${est.nextSteps.length ? `<h3>Next steps</h3><ol class="next">${est.nextSteps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
${advisories.length ? `<h3>Microsoft-sourced guidance</h3>${advisories.map(advisory).join('\n')}` : ''}`;
  panes.push({ id: 'assumptions', label: 'Assumptions', body: assumptionBody });
  const footer = `<footer class="foot"><p>Generated by a deterministic pricing engine. Region <code>${esc(est.region.code)}</code>, currency ${esc(cur)}, rates retrieved ${esc(date)}. Meter selection, unit conversions, tiers, discounts and totals are computed, not written by hand.</p>
<p>Customer answers: <strong>${est.verification === 'verified' ? 'verified against the conversation' : 'NOT VERIFIED'}</strong> &middot; Engine <code>${esc(est.fingerprint || '')}</code> ${est.engineIntact ? '(sealed)' : '<strong>MODIFIED</strong>'}${est.model && est.model.model ? ` &middot; AI model <code>${esc(est.model.model)}</code> (${esc(est.model.status)})` : ''}</p></footer>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Azure Pricing Estimate - ${esc(est.title)} - ${esc(est.region.name)}</title>
${STYLE}</head><body>
<header class="top"><h1>${esc(est.title)}</h1><div class="meta">${est.customer ? `<div>Prepared for <span>${esc(est.customer)}</span></div>` : ''}<div>Region <span>${esc(est.region.name)}</span></div><div>Currency <span>${esc(cur)}</span></div><div>Prepared <span>${esc(date)}</span></div></div>
<nav class="tabs" aria-label="Estimate sections">${panes.map(p => `<a class="tab" id="tab-${p.id}" href="#p-${p.id}" data-tab="${p.id}">${esc(p.label)}</a>`).join('')}</nav></header>
<main id="view"><div class="notices" aria-label="Important notices">${notices.join('\n')}</div>
${panes.map(p => `<section class="pane" id="p-${p.id}" aria-labelledby="tab-${p.id}" tabindex="0">${p.body}</section>`).join('\n')}
${footer}</main>${NAVIGATION}</body></html>
`;
}

module.exports = { render, money };
