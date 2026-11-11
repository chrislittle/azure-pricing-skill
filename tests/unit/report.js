'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const { expandSpec } = require('../../scripts/lib/expand');
const { priceSpec } = require('../../scripts/lib/estimate');
const { render, money } = require('../../scripts/lib/render');
const { readback } = require('../../scripts/lib/readback');
const { advise } = require('../../scripts/lib/advisor');
const { validateSpec } = require('../../scripts/lib/schema');
const { checkMath, checkHtml } = require('../../scripts/lib/validate');

const VM = { type: 'vm', sku: 'Standard_D4as_v5', os: 'windows', count: 3, hours: 730 };
const base = {
  title: 'Internal app estimate', customer: 'Example customer', region: 'eastus2',
  currency: 'USD', discountPct: 16, discountExcludes: ['licenses'],
  customerSaid: { region: 'East US 2', discount: '16% except licenses', requirements: 'Three Windows servers, all month' },
  options: [{ name: 'Production', components: [VM] }]
};
let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('PASS ' + name); };
const ready = e => Object.assign(e, { verification: 'verified', engineIntact: true, fingerprint: 'test-fixture' });
function clean(html) { assert.deepEqual(checkHtml(html), []); return html; }
const sections = h => [...h.matchAll(/<section class="pane" id="([^"]+)"/g)].map(m => m[1]);

(async () => {
  await test('explicit lineage, every commitment, idempotency, duplicate names', () => {
    const s = { ...base, compare: { commitments: true }, options: [
      { name: 'Same label', components: [VM] },
      { name: 'Same label', components: [{ ...VM, hours: 200 }] },
      { name: 'Stopped', components: [{ ...VM, hours: 0 }] }
    ] };
    const original = JSON.stringify(s), e = expandSpec(s);
    assert.equal(JSON.stringify(s), original);
    assert.equal(e.options.length, 7);
    assert.equal(e.options[0].name, 'Same label');
    assert.deepEqual(e.options.slice(1, 5).map(o => o.components[0].commitment), ['ri1y', 'ri3y', 'sp1y', 'sp3y']);
    assert.ok(e.options.slice(0, 5).every(o => o.scenario.id === 'estimate-1'));
    assert.equal(e.options[5].scenario.id, 'estimate-2');
    assert.equal(e.options[6].scenario.id, 'estimate-3');
    assert.equal(expandSpec(e), e);
  });
  await test('one estimate, five columns, counts vs hours, totals and serialized audit', async () => {
    const e = ready(await priceSpec(base));
    assert.deepEqual(e.options[0].errors, []);
    assert.deepEqual(checkMath(e), []);
    const h = clean(render(e));
    assert.deepEqual(sections(h), ['p-summary', 'p-estimate-1', 'p-assumptions']);
    assert.ok(h.includes('<td class="c">3</td><td>VMs x 730 hrs</td>'));
    assert.ok(h.includes(money(e.options[0].totalYour, 'USD')));
    assert.ok(!h.includes('LOWEST COST'));
    assert.ok(!h.includes('colspan="7"'));
    assert.ok(!h.includes('Unit price</th>'));
    assert.ok(e.options[0].lines.every(l => l.unitPrice >= 0 && l.meter && l.componentIndex === 0));
    const snapshot = JSON.stringify(e);
    assert.equal(clean(render(JSON.parse(snapshot))), h);
    assert.equal(JSON.stringify(e), snapshot);
  });
  await test('pilot and production are separate, never globally ranked; all variants retain totals', async () => {
    const e = ready(await priceSpec({ ...base, compare: { commitments: true }, options: [
      { name: 'Pilot', components: [{ ...VM, count: 1, hours: 200 }] },
      base.options[0]
    ] }));
    assert.equal(e.options.length, 6);
    assert.ok(!e.options[0].lowest);
    assert.equal(e.options.filter(o => o.lowest).length, 1);
    assert.ok(e.options.find(o => o.lowest).scenario.id === 'estimate-2');
    const h = clean(render(e));
    assert.deepEqual(sections(h), ['p-summary', 'p-estimate-1', 'p-estimate-2', 'p-assumptions']);
    for (const o of e.options) {
      assert.deepEqual(o.errors, []);
      assert.ok(h.includes(money(o.totalYour, e.currency)));
      const standalone = await priceSpec({ ...base, options: [{ components: o.components.map(c => c.spec) }] });
      assert.equal(o.totalList, standalone.options[0].totalList);
      assert.equal(o.totalYour, standalone.options[0].totalYour);
    }
    assert.deepEqual(checkMath(e), []);
  });
  await test('no discount, non-USD and real usage meters keep their quantities and units', async () => {
    const e = ready(await priceSpec({ ...base, currency: 'EUR', discountPct: 0, options: [
      { name: 'Server', components: [{ ...VM, os: 'linux', hours: 0 }] },
      { name: 'Downloads', components: [{ type: 'bandwidth', egressGB: 20480 }] }
    ] }));
    assert.ok(e.options.every(o => o.errors.length === 0 && o.totalYour === o.totalList && !o.lowest));
    const h = clean(render(e));
    assert.ok(h.includes('No discount has been applied'));
    assert.ok(h.includes('<td class="c">20,480</td><td>GB</td>'));
    assert.ok(h.includes('VMs x 0 hrs'));
    assert.ok(h.includes(money(e.options[1].totalYour, 'EUR')));
    assert.deepEqual(checkMath(e), []);
    const meter = e.options[1].lines[0].meter;
    const generic = ready(await priceSpec({ ...base, currency: 'EUR', discountPct: 0, options: [
      { name: 'Usage meter', components: [{ type: 'meter', filter: { meterId: meter.meterId }, quantity: 20480, hours: 200 }] }
    ] }));
    assert.deepEqual(generic.options[0].errors, []);
    assert.equal(generic.options[0].totalList, e.options[1].totalList);
    assert.ok(clean(render(generic)).includes('<td class="c">20,480</td><td>1 GB</td>'));
    assert.ok(!render(generic).includes('instances x 200 hrs'));
  });
  await test('phases and genuine alternatives avoid false comparison warnings; broken variants still warn', async () => {
    const options = [
      { name: 'Pilot', phase: 'Pilot', context: { production: false }, components: [{ ...VM, count: 1 }] },
      { name: 'Production', phase: 'Production', components: [{ ...VM, count: 1 }, { type: 'disk', sizeGiB: 128 }] }
    ];
    const e = ready(await priceSpec({ ...base, context: { production: true }, options }));
    const a = advise(e);
    assert.ok(!a.some(a => a.id === 'options-not-like-for-like'));
    assert.equal(a.find(a => a.id === 'single-vm-production').option, 'Production');
    const alt = await priceSpec({ ...base, options: options.map(({ phase, context, ...o }) => o) });
    assert.ok(!advise(alt).some(a => a.id === 'options-not-like-for-like'));
    alt.options[1].scenario = alt.options[0].scenario;
    assert.ok(advise(alt).some(a => a.id === 'options-not-like-for-like'));
    const rb = readback({ ...base, options });
    assert.ok(rb.text.includes('For this scope: Development or test'));
    assert.notEqual(rb.code, readback({ ...base, options: options.map(o => ({ ...o, context: { production: true } })) }).code);
    const bad = validateSpec({ ...base, options: [{ ...options[0], phase: 3, context: { production: 'no', typo: true } }] });
    assert.ok(bad.some(s => s.includes('phase must be')));
    assert.ok(bad.some(s => s.includes('context.production must be')));
    assert.ok(bad.some(s => s.includes('unknown field "typo"')));
    const separate = { ...base, options: [
      { name: 'Standalone', phase: 'Production', components: [VM] },
      { name: 'Cluster', phase: 'Pilot', components: [{ type: 'aks', tier: 'free' }] }
    ] };
    const scopedAdvice = advise(await priceSpec(separate));
    assert.ok(scopedAdvice.some(a => a.id === 'vm-without-disk' && a.option === 'Standalone'));
    const omissions = readback(separate).text;
    assert.ok(omissions.includes('Standalone: Disks for the servers'));
    assert.ok(omissions.includes('Cluster: The node servers'));
  });
  await test('resource counts remain distinct from hours and usage across service types', async () => {
    const e = ready(await priceSpec({ ...base, options: [{ name: 'Web app', components: [{ type: 'app-service', plan: 'P1v3', count: 2, hours: 200 }] }] }));
    assert.deepEqual(e.options[0].errors, []);
    assert.ok(clean(render(e)).includes('<td class="c">2</td><td>instances x 200 hrs</td>'));
    const network = ready(await priceSpec({ ...base, options: [
      { name: 'IP addresses', components: [{ type: 'public-ip', count: 2, hours: 200 }] },
      { name: 'Generic meter', components: [{ type: 'meter', filter: { serviceName: 'Virtual Network', productName: 'Public IP Prefix', meterName: 'Standard Static IP Addresses' }, quantity: 2, hours: 200 }] }
    ] }));
    assert.ok(network.options.every(o => o.errors.length === 0));
    const html = clean(render(network));
    assert.ok(html.includes('<td class="c">2</td><td>IP addresses x 200 hrs</td>'));
    assert.ok(html.includes('<td class="c">2</td><td>instances x 200 hrs</td>'));
  });
  await test('license exclusions are derived from actual priced lines', async () => {
    const e = ready(await priceSpec({ ...base, options: [{ name: 'Licensed server', components: [{ ...VM, os: 'linux' }, { ...VM, os: 'rhel' }] }] }));
    assert.deepEqual(e.options[0].errors, []);
    assert.ok(e.options[0].lines.some(l => l.service === 'VM Licenses' && l.discountPct === 0));
    assert.ok(e.options[0].lines.filter(l => l.service === 'Virtual Machines').every(l => l.discountPct === 16), 'RHEL compute remains discountable even when its description mentions a separate license');
    const h = clean(render(e));
    assert.ok(h.includes('VM Licenses: 0% off list.'));
    assert.ok(h.includes('Virtual Machines: 16% off list.'));
  });
  await test('Windows license exclusions discount compute, not bundled Windows charges', async () => {
    const e = ready(await priceSpec({ ...base, compare: { commitments: true } }));
    assert.equal(e.options.length, 5);
    for (const o of e.options) {
      assert.deepEqual(o.errors, []);
      const compute = o.lines.find(l => l.isLicense === false);
      const license = o.lines.find(l => l.isLicense === true);
      assert.ok(compute && license, 'every Windows purchasing term separates compute and licensing');
      assert.equal(compute.discountPct, 16);
      assert.equal(compute.your, Math.round(compute.list * 0.84 * 100) / 100);
      assert.equal(license.discountPct, 0);
      assert.equal(license.your, license.list);
    }
    const payg = e.options[0], facts = payg.components[0].facts;
    assert.equal(payg.lines[0].list, Math.round(facts.baseRate * VM.count * VM.hours * 100) / 100);
    assert.equal(payg.lines[1].list, Math.round((facts.winRate - facts.baseRate) * VM.count * VM.hours * 100) / 100);
    const allDiscounted = await priceSpec({ ...base, discountExcludes: [] });
    assert.ok(allDiscounted.options[0].lines.every(l => l.discountPct === 16));
    const zeroHours = await priceSpec({ ...base, options: [{ components: [{ ...VM, hours: 0 }] }] });
    assert.equal(zeroHours.options[0].totalList, 0);
    assert.equal(zeroHours.options[0].totalYour, 0);
    assert.deepEqual(checkMath(e), []);
    clean(render(e));
  });
  await test('failed variants have no success-shaped totals and warnings remain outside tabs', async () => {
    const e = ready(await priceSpec({ ...base, options: [...base.options, { name: 'Unavailable', components: [{ type: 'not-a-service' }] }] }));
    e.verification = 'unverified'; e.engineIntact = false;
    e.model = { model: 'example-model', status: 'not-recommended', notice: 'This model is not recommended.' };
    e.excluded.push('Support');
    e.declined = [{ id: 'example', customerSaid: 'Keep this design' }];
    e.nextSteps.push('Confirm usage');
    const h = clean(render(e, [{ level: 'warn', title: 'Important warning', body: 'Check the design.', option: 'Production' }]));
    const notices = h.slice(h.indexOf('<div class="notices"'), h.indexOf('<section class="pane"'));
    for (const text of ['Not priced - incomplete estimate', 'Inputs not verified', 'Pricing engine modified', 'Prepared with a model that is not recommended', 'Important warning']) assert.ok(notices.includes(text));
    const row = h.match(/<tr><td><a href="#p-estimate-2">Unavailable<\/a>[\s\S]*?<\/tr>/)[0];
    assert.ok(row.includes('Not priced') && !row.includes('$0.00'));
    assert.ok(h.includes('Not included: Support.'));
    assert.ok(h.includes('Keep this design'));
    assert.ok(h.includes('Confirm usage'));
    e.options = [e.options[1]];
    assert.throws(() => render(e), /No option could be priced/);
  });
  await test('escaped labels, stable unique tab IDs and source-free synthetic content', async () => {
    const e = ready(await priceSpec({ ...base, title: '<script>bad()</script>', options: [
      { name: 'App "A" & <pilot>', components: [VM] },
      { name: 'App "A" & <pilot>', components: [VM] }
    ] }));
    const h = clean(render(e));
    assert.ok(h.includes('App &quot;A&quot; &amp; &lt;pilot&gt;'));
    assert.ok(h.includes('&lt;script&gt;bad()&lt;/script&gt;'));
    assert.ok(!h.includes('<script>bad()'));
    assert.equal(new Set(sections(h)).size, 4);
    assert.ok(!h.includes('Xylem'));
  });
  await test('readback uses customer scopes and purchasing terms; renaming requires reconfirmation', () => {
    const a = readback(base), b = readback({ ...base, options: [{ ...base.options[0], name: 'Pilot' }] });
    assert.ok(a.text.includes('Production - Pay-as-you-go'));
    assert.ok(!a.text.includes('Option 1:'));
    assert.notEqual(a.code, b.code);
    const expanded = readback({ ...base, compare: { commitments: true } });
    for (const term of ['1-year reservation', '3-year reservation', '1-year savings plan', '3-year savings plan']) assert.ok(expanded.text.includes(term));
  });
  if (process.env.AZP_REPORT_OUT) {
    const demo = ready(await priceSpec({ ...base, compare: { commitments: true }, options: [
      { name: 'Pilot', phase: 'Pilot', context: { production: false }, components: [{ ...VM, count: 1, hours: 200 }] },
      { name: 'Production', phase: 'Production', components: [VM, { type: 'disk', sizeGiB: 128, count: 3, label: 'Storage' }] }
    ] }));
    fs.writeFileSync(process.env.AZP_REPORT_OUT, clean(render(demo)));
  }
  console.log(`report tests: ${pass} pass, 0 fail`);
})().catch(e => { console.error(e); process.exitCode = 1; });
