'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'azp-cosmos-restore-'));
const previousCache = process.env.AZP_CACHE_DIR;
const previousFetch = global.fetch;
process.env.AZP_CACHE_DIR = cache;
const meter = (productName, meterName, retailPrice, unitOfMeasure, skuName = 'Standard') => ({
  productName, meterName, retailPrice, unitOfMeasure, skuName,
  meterId: productName + '/' + meterName, serviceName: 'Azure Cosmos DB',
  type: 'Consumption', tierMinimumUnits: 0, armRegionName: 'eastus2'
});
const items = [
  meter('Azure Cosmos DB', '100 RU/s', 0.008, '1 Hour', 'RUs'),
  meter('Azure Cosmos DB', 'Data Stored', 0.25, '1 GB/Month', 'RUs'),
  meter('Azure Cosmos DB - PITR', 'Cont 30D Bckp Continuous Backup', 0.2, '1 GB'),
  meter('Azure Cosmos DB - PITR', 'Cont 7D Bkup Continuous Backup', 0, '1 GB'),
  meter('Azure Cosmos DB - PITR', 'Cont 30D Bckp Data Restore', 0.15, '1 GB'),
  // An unrelated vaulted-backup meter must not satisfy a PITR restore.
  meter('Azure Cosmos DB Restore', 'Vaulted Bckp Data Restore', 99, '1 GB'),
  meter('Azure Cosmos DB Analytics Storage', 'Standard Data Stored', 0.02, '1 GB/Month'),
  meter('Azure Cosmos DB Analytics Storage', 'Standard Write Operations', 0.05, '10K'),
  meter('Azure Cosmos DB Analytics Storage', 'Standard Read Operations', 0.005, '10K')
];
global.fetch = async url => {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'prices.azure.com');
  const missing = parsed.searchParams.get('$filter').includes("'westeurope'");
  return { ok: true, status: 200, json: async () => ({
    Items: items.filter(r => !missing || r.meterName !== 'Cont 30D Bckp Data Restore'),
    NextPageLink: null
  }) };
};
const { priceSpec } = require('../../scripts/lib/estimate');
const oracle = require('../oracle/services/cosmos');
const base = { type: 'cosmos', mode: 'provisioned', ru: 400, regions: 2, hours: 1 };
const price = async (component, region = 'eastus2') =>
  (await priceSpec({ region, discountPct: 0, options: [{ components: [component] }] })).options[0];

(async () => {
  try {
    const scenario = oracle.cases.find(c => c.name === 'continuous backup restore and analytical store');
    const expected = await scenario.expected();
    const restore = expected.lines.find(l => /^Point-in-time restore/.test(l.desc));
    assert.equal(restore.monthlyList, 7.5);
    assert.equal(restore.quantity, 50);
    assert.equal(restore.unitOfMeasure, '1 GB');
    assert.equal(expected.monthlyList, 308.43);
    const combined = await price(scenario.component);
    assert.deepEqual(combined.errors, []);
    assert.equal(combined.totalList, expected.monthlyList);
    assert.equal(combined.lines.find(l => /^Continuous backup/.test(l.desc)).list, 80);
    assert.equal(combined.lines.filter(l => /^Analytical store/.test(l.desc)).length, 3);

    for (const backup of ['continuous-7d', 'continuous-30d']) {
      const option = await price({ ...base, backup, restoreGB: 50 });
      assert.deepEqual(option.errors, []);
      const line = option.lines.find(l => /^Point-in-time restore/.test(l.desc));
      assert.equal(line.list, 7.5);
      assert.equal(line.qty, 50);
      assert.equal(line.meter.productName, 'Azure Cosmos DB - PITR');
    }
    const noRestore = await price({ ...base, backup: 'continuous-30d', restoreGB: 0 });
    assert.deepEqual(noRestore.errors, []);
    assert(!noRestore.lines.some(l => /^Point-in-time restore/.test(l.desc)));
    const missing = await price({ ...base, backup: 'continuous-30d', restoreGB: 50 }, 'westeurope');
    assert(missing.errors.some(e => /Cosmos restore/.test(e)));
    assert.equal(missing.lines.length, 0, 'missing restore pricing must not silently produce a partial Cosmos charge');
    console.log('Cosmos restore: independent PITR meter/units, both retention tiers, backup/analytics, zero and missing-meter cases pass.');
  } finally {
    global.fetch = previousFetch;
    if (previousCache === undefined) delete process.env.AZP_CACHE_DIR;
    else process.env.AZP_CACHE_DIR = previousCache;
    fs.rmSync(cache, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
