'use strict';

const { query, dedupe, round2 } = require('../api');

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function total(lines) {
  return round2(lines.reduce((sum, l) => sum + l.monthlyList, 0));
}

function billableRunVuh({ virtualUsers = 0, runMinutes = 0, engines = 1 }) {
  const actual = (virtualUsers * runMinutes) / 60;
  const minimum = (10 * engines * Math.max(runMinutes, 10)) / 60;
  return Math.max(actual, minimum);
}

function graduatedCost(qty, tiers) {
  let cost = 0;
  for (let i = 0; i < tiers.length; i++) {
    const start = tiers[i].tierMinimumUnits || 0;
    const end = i + 1 < tiers.length ? tiers[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    cost += (Math.min(qty, end) - start) * tiers[i].retailPrice;
  }
  return cost;
}

async function appTesting(cfg) {
  const region = cfg.region || 'eastus2';
  const currency = cfg.currency || 'USD';
  const rows = dedupe(await query(`serviceName eq 'Azure App Testing' and armRegionName eq '${region}'`, currency));
  const lines = [];

  const loadTiers = rows
    .filter(r => r.skuName === 'JMeter' && r.meterName === 'JMeter Virtual User Additional Usage')
    .sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  const resource = rows.find(r => r.skuName === 'JMeter' && r.meterName === 'JMeter Load Testing Resource');
  const linux = rows.find(r => r.meterName === 'Playwright Linux Test Minutes');
  const windows = rows.find(r => r.meterName === 'Playwright Windows Test Minutes');

  const runVuh = (cfg.testRuns || 0) * billableRunVuh(cfg);
  const loadVuh = (cfg.virtualUserHours || 0) + runVuh;
  if (loadVuh) {
    if (!loadTiers.length) throw new Error(`missing Azure Load Testing VUH tiers for ${region} ${currency}`);
    lines.push(line(
      `Azure Load Testing VUH: ${round2(loadVuh)} billable VUH, graduated 0-10000 then 10000+`,
      graduatedCost(loadVuh, loadTiers),
      { meterId: loadTiers[0].meterId }
    ));
  }

  if (cfg.loadTestingResources) {
    if (!resource) throw new Error(`missing Load Testing Resource meter for ${region} ${currency}`);
    lines.push(line(
      `Azure Load Testing resources: ${cfg.loadTestingResources} * ${resource.retailPrice}`,
      cfg.loadTestingResources * resource.retailPrice,
      { meterId: resource.meterId }
    ));
  }

  let trial = Math.min(100, cfg.playwrightTrialMinutes || 0);
  const linuxBillable = Math.max(0, (cfg.playwrightLinuxMinutes || 0) - trial);
  trial = Math.max(0, trial - (cfg.playwrightLinuxMinutes || 0));
  const windowsBillable = Math.max(0, (cfg.playwrightWindowsMinutes || 0) - trial);

  if (linuxBillable) {
    if (!linux) throw new Error(`missing Playwright Linux meter for ${region} ${currency}`);
    lines.push(line(`Playwright Linux test minutes after trial: ${linuxBillable}`, linuxBillable * linux.retailPrice, { meterId: linux.meterId }));
  }
  if (windowsBillable) {
    if (!windows) throw new Error(`missing Playwright Windows meter for ${region} ${currency}`);
    lines.push(line(`Playwright Windows test minutes after trial: ${windowsBillable}`, windowsBillable * windows.retailPrice, { meterId: windows.meterId }));
  }

  return { monthlyList: total(lines), lines };
}

function c(name, cfg, note) {
  return {
    name,
    region: cfg.region || 'eastus2',
    currency: cfg.currency || 'USD',
    component: { type: 'app-testing', virtualUserHours: 0, ...cfg },
    sourceNote: note,
    // Arithmetic is independent of the engine: Azure App Testing pricing page FAQ/table plus Retail meters.
    expected: () => appTesting(cfg)
  };
}

module.exports = {
  type: 'app-testing',
  source: 'both',
  cases: [
    c('pricing page VUH FAQ example: 1000 users for 30 minutes', { virtualUserHours: 500 }, '1,000 users * 30 minutes / 60 = 500 VUH at the first-tier VUH rate.'),
    c('pricing page minimum example: 5 users 1 engine for 3 hours', { testRuns: 1, virtualUsers: 5, runMinutes: 180, engines: 1 }, 'Actual 15 VUH; minimum 10 users * 180 minutes / 60 * 1 engine = 30 VUH.'),
    c('pricing page minimum example: 5 users 1 engine for 5 minutes', { testRuns: 1, virtualUsers: 5, runMinutes: 5, engines: 1 }, 'Actual 0.42 VUH; minimum 10 users * 10 minutes / 60 * 1 engine = 1.67 VUH.'),
    c('pricing page exceeds minimum example: 500 users per engine for 5 minutes on 2 engines', { testRuns: 1, virtualUsers: 1000, runMinutes: 5, engines: 2 }, 'Actual 1,000 users * 5 minutes / 60 = 83.33 VUH; minimum is 3.33 VUH.'),
    c('short run at least ten users per engine', { testRuns: 1, virtualUsers: 100, runMinutes: 5, engines: 1 }, 'Actual 100 users * 5 minutes / 60 = 8.33 VUH, which exceeds the 1.67 VUH minimum; first-tier cost is $1.25.'),
    c('hundred short runs large load', { testRuns: 100, virtualUsers: 1000, runMinutes: 2, engines: 4 }, 'Each run bills max(33.33 actual VUH, 6.67 minimum VUH); 100 runs = 3333.33 VUH = $500.'),
    c('run exactly at the minimum', { testRuns: 1, virtualUsers: 10, runMinutes: 10, engines: 1 }, 'Actual and minimum are both 10 users * 10 minutes / 60 = 1.67 VUH.'),
    c('ten thousand VUH boundary', { virtualUserHours: 10000 }, 'Exactly 10,000 VUH stays entirely in the first graduated tier.'),
    c('above ten thousand VUH graduated tier', { virtualUserHours: 10001 }, '10,000 VUH at the first rate plus 1 VUH at the lower 10,000+ rate.'),
    c('commercial resource monthly fee plus usage', { virtualUserHours: 20, loadTestingResources: 2 }, 'Retail API exposes a monthly Load Testing Resource meter: 2 resources * commercial meter plus VUH.'),
    c('US Gov resource monthly fee differs', { region: 'usgovvirginia', virtualUserHours: 20, loadTestingResources: 1 }, 'US Gov Virginia uses the same VUH tiers and a higher Load Testing Resource meter than commercial regions.'),
    c('Playwright Linux Windows with full trial', { region: 'westeurope', playwrightLinuxMinutes: 80, playwrightWindowsMinutes: 40, playwrightTrialMinutes: 100 }, 'Pricing page gives first 100 Playwright test minutes free; trial is applied to Linux first, then Windows.'),
    c('EUR West Europe load and Playwright', { region: 'westeurope', currency: 'EUR', virtualUserHours: 100, playwrightLinuxMinutes: 200, playwrightWindowsMinutes: 50, playwrightTrialMinutes: 100, loadTestingResources: 1 }, 'EUR case uses Retail API EUR meters directly: VUH, resource fee, Linux minutes after trial, and Windows minutes.')
  ]
};


