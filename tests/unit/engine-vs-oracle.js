'use strict';
// Engine vs independent oracle: canonical scenario configs + every VM/disk/commitment variant.
const path = require('path');
const fs = require('fs');
const { priceSpec } = require('../../scripts/lib/estimate');
const O = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'oracle', 'oracle-results.json'), 'utf8')).scenarios;
const SC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scenarios', 'scenarios.json'), 'utf8')).scenarios;

const R = { centralus: 'centralus', eastus2: 'eastus2', germanywestcentral: 'germanywestcentral' };
const disk = (tier, size, count = 1, red = 'LRS') => ({ type: 'disk', diskType: tier.startsWith('P') ? 'premium-ssd' : tier.startsWith('E') ? 'standard-ssd' : 'standard-hdd', sizeGiB: size, count, redundancy: red });
// Canonical configs expressed in engine components (independent of the oracle's code).
const CANON = {
  's01-small-web-linux': ['centralus', [{ type: 'vm', sku: 'Standard_D2as_v5' }, disk('E10', 128)]],
  's02-rhel-8x64': ['eastus2', [{ type: 'vm', sku: 'Standard_E8as_v6', os: 'rhel' }, disk('P40', 2048), disk('P6', 64)]],
  's03-windows-ahb': ['eastus2', [{ type: 'vm', sku: 'Standard_D4as_v5', os: 'windows-ahb' }, disk('E15', 256)]],
  's04-web-vm-public-ip': ['centralus', [{ type: 'vm', sku: 'Standard_B2s' }, disk('E6', 64), { type: 'public-ip' }, { type: 'bandwidth', egressGB: 200 }]],
  's05-aks-prod': ['centralus', [{ type: 'aks', tier: 'standard' }, { type: 'vm', sku: 'Standard_D4as_v5', count: 3 }, disk('P10', 128, 3)]],
  's06-appservice-sql': ['eastus2', [{ type: 'app-service', plan: 'P1v3', os: 'windows', count: 2 }, { type: 'sql-database', vcores: 4, storageGB: 250 }]],
  's07-functions': ['eastus2', [{ type: 'functions', executions: 5000000, gbSeconds: 500000 }]],
  's08-blob-archive': ['centralus', [{ type: 'blob', tier: 'Archive', capacityGB: 51200, writeOps: 100000 }]],
  's09-openai-chatbot': ['eastus2', [{ type: 'openai', model: 'gpt-5-nano', inputTokens: 200000000, outputTokens: 40000000 }]],
  's10-cosmos': ['centralus', [{ type: 'cosmos', mode: 'autoscale', maxRU: 4000, storageGB: 100 }]],
  's11-postgres-ha': ['eastus2', [{ type: 'postgres', vcores: 4, ha: true, storageGB: 512 }]],
  's12-three-tier': ['eastus2', [{ type: 'vm', sku: 'Standard_D4as_v5', os: 'windows-ahb', count: 2 }, disk('E10', 128, 2), { type: 'load-balancer', rules: 5, processedGB: 1024 }, { type: 'sql-mi', vcores: 8, storageGB: 512 }, { type: 'log-analytics', ingestGBPerDay: 10 }]],
  's13-reservations': ['centralus', [{ type: 'vm', sku: 'Standard_D8as_v5', count: 10 }]],
  's14-dev-business-hours': ['centralus', [{ type: 'vm', sku: 'Standard_D4as_v5', count: 8, hours: 220 }, disk('E10', 128, 8)]],
  's15-disk-cliff': ['eastus2', [{ type: 'disk', diskType: 'premium-v2', sizeGiB: 1126, iops: 5000, throughputMBps: 200 }]],
  's16-egress-heavy': ['centralus', [{ type: 'blob', tier: 'Hot', capacityGB: 2048, readOps: 4000000 }, { type: 'bandwidth', egressGB: 20480 }]],
  's17-eur-germany': ['germanywestcentral', [{ type: 'vm', sku: 'Standard_D4as_v5', count: 2 }, disk('E15', 256, 2)]],
  's18-container-apps': ['centralus', [{ type: 'container-apps', apps: 2, vcpu: 0.5, memGiB: 1, replicas: 1, requests: 3000000 }]],
  's19-legacy-v3': ['centralus', [{ type: 'vm', sku: 'Standard_D4s_v5' }, disk('E10', 128)]],
  's20-azure-files': ['eastus2', [{ type: 'files', model: 'provisioned-v2-hdd', capacityGB: 5120 }]]
};

async function total(region, currency, pct, comps) {
  const e = await priceSpec({ region, currency, discountPct: pct, options: [{ name: 'x', components: comps }] });
  const o = e.options[0];
  return { list: o.totalList, your: o.totalYour, errors: o.errors, lines: o.lines };
}

(async () => {
  const rows = []; let pass = 0, fail = 0;
  const check = (name, got, want, tol = 0.011) => {
    const ok = Math.abs(got - want) <= tol;
    ok ? pass++ : fail++;
    rows.push({ name, got, want, diff: Math.round((got - want) * 100) / 100, ok });
  };
  for (const sc of SC) {
    const o = O[sc.id]; const [region, comps] = CANON[sc.id];
    const cur = o.currency || 'USD', pct = (o.discountPct || 0) <= 1 ? (o.discountPct || 0) * 100 : o.discountPct;
    const t = await total(region, cur, pct, comps);
    if (t.errors.length) { rows.push({ name: sc.id, error: t.errors.join('; ') }); fail++; continue; }
    check(`${sc.id} canonical list`, t.list, o.canonical.monthlyList);
    check(`${sc.id} canonical your`, t.your, o.canonical.monthlyDiscounted);
    // VM variants
    const vms = (o.variants && o.variants.vm) || {};
    for (const [sku, v] of Object.entries(vms)) {
      if (v.error || v.totalMonthlyList == null) continue;
      const os = v.os || 'linux';
      const vt = await total(region, cur, pct, [{ type: 'vm', sku, os: os === 'windows-ahb' ? 'windows-ahb' : os, count: v.count || 1, hours: v.hours || 730 }]);
      if (vt.errors.length) { rows.push({ name: `${sc.id} vm ${sku}`, error: vt.errors.join('; ') }); fail++; continue; }
      check(`${sc.id} vm ${sku}`, vt.list, v.totalMonthlyList, 0.011 * (v.count || 1) + 0.011);
    }
    // Commitments
    const cm = o.variants && o.variants.commitmentBySku;
    if (cm) for (const [sku, terms] of Object.entries(cm)) for (const [term, v] of Object.entries(terms)) {
      const cnt = sc.id === 's13-reservations' ? 10 : 8, hours = sc.id === 's14-dev-business-hours' ? 220 : 730;
      const vt = await total(region, cur, pct, [{ type: 'vm', sku, count: cnt, hours, commitment: term }]);
      if (vt.errors.length) { rows.push({ name: `${sc.id} ${sku} ${term}`, error: vt.errors.join('; ') }); fail++; continue; }
      const want = v.fleetMonthlyList ?? v.totalMonthlyList;
      if (want != null) check(`${sc.id} ${sku} ${term}`, vt.list, want, 0.11);
    }
  }
  const out = path.join(__dirname, 'engine-vs-oracle.json');
  fs.writeFileSync(out, JSON.stringify({ pass, fail, rows }, null, 2));
  for (const r of rows.filter(r => !r.ok)) console.log('MISMATCH', JSON.stringify(r));
  console.log(`engine vs oracle: ${pass} pass, ${fail} fail`);
})();
