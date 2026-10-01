'use strict';
/**
 * Prices every scenario's canonical component list from scenarios.json, plus the
 * acceptable VM SKU / disk tier variants, and writes oracle-results.json.
 *
 * Run: node tests\oracle\run-oracle.js
 */

const fs = require('fs');
const path = require('path');
const O = require('./oracle');

const SCENARIOS = path.resolve(__dirname, '..', 'scenarios', 'scenarios.json');
const OUT = path.resolve(__dirname, 'oracle-results.json');

/** 'none'/'no discount' -> 0; '16% off list on everything' -> 0.16 */
function parseDiscount(s) {
  if (!s) return 0;
  const t = String(s).toLowerCase();
  if (/\bno\b|\bnone\b|don't have any|do not have any/.test(t) && !/\d+\s*%/.test(t)) return 0;
  const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) / 100 : 0;
}

/** Discount is applied per line: round2(line * (1-d)); total = sum of rounded lines. */
function discountTotal(lines, d) {
  return O.round2(lines.reduce((s, l) => s + O.round2(l.monthlyList * (1 - d)), 0));
}

/** Split a canonical disk tier string like 'E10 Standard SSD LRS' into {tier, redundancy}. */
function parseDiskTier(str) {
  const m = String(str).match(/^([PES]\d+)\b/);
  if (!m) return null;
  const red = /ZRS/i.test(str) ? 'ZRS' : 'LRS';
  return { tier: m[1], redundancy: red };
}

async function priceComponent(c, sc) {
  const region = sc.facts.region;
  const currency = sc.facts.currency || 'USD';
  switch (c.service) {
    case 'vm': {
      // If the scenario lists the RHEL license as its own canonical component, do not let
      // priceVm add it again.
      const separateLicense = sc.canonical.components.some(x => x.service === 'rhel-license');
      return O.priceVm({ region, sku: c.sku, os: c.os, count: c.count, hours: c.hours, currency, includeRhelLicense: !separateLicense });
    }
    case 'rhel-license':
      return O.priceRhelLicense({ vcpu: c.vcpu, hours: c.hours, count: c.count || 1, currency });
    case 'managed-disk': {
      if (/Premium SSD v2/i.test(c.tier)) {
        return O.pricePremiumV2({ region, sizeGiB: c.sizeGiB, iops: c.iops, throughputMBps: c.throughputMBps, redundancy: /ZRS/i.test(c.tier) ? 'ZRS' : 'LRS', currency });
      }
      const p = parseDiskTier(c.tier);
      if (!p) throw new Error(`Cannot parse disk tier: ${c.tier}`);
      return O.priceManagedDisk({ region, tier: p.tier, redundancy: p.redundancy, count: c.count, sizeGiB: c.sizeGiB, currency });
    }
    case 'public-ip':
      return O.pricePublicIp({ region, count: c.count, hours: c.hours, currency });
    case 'bandwidth':
      return O.priceBandwidth({ region, egressGB: c.egressGB, currency });
    case 'aks-control-plane':
      return O.priceAksStandardTier({ region, hours: c.hours, currency });
    case 'app-service':
      return O.priceAppService({ region, plan: 'P1v3', os: /linux/i.test(c.plan) ? 'linux' : 'windows', count: c.count, hours: c.hours, currency });
    case 'sql-database':
      return O.priceSqlDatabaseGP({ region, vcores: c.vcores, storageGB: c.storageGB, hours: c.hours, licenseIncluded: c.licenseIncluded !== false && c.ahb !== true, currency });
    case 'sql-mi':
      return O.priceSqlMiGP({ region, vcores: c.vcores, storageGB: c.storageGB, hours: c.hours, licenseIncluded: c.licenseIncluded !== false && c.ahb !== true, currency });
    case 'functions-consumption':
      return O.priceFunctionsConsumption({ region, executions: c.executions, gbSeconds: c.gbSeconds, currency });
    case 'blob':
      return O.priceBlob({ region, tier: c.tier, redundancy: c.redundancy, capacityGB: c.capacityGB || 0, writeOps: c.writeOps || 0, readOps: c.readOps || 0, currency });
    case 'openai-tokens':
      // Canonical asks for the "cheapest current GPT mini model, Global Standard".
      // We price every model in scenario.accept.models and select the cheapest.
      return priceCheapestOpenAi({ region, models: (sc.accept && sc.accept.models) || ['gpt-5-nano'], inputTokens: c.inputTokens, outputTokens: c.outputTokens, currency });
    case 'cosmos-autoscale':
      return O.priceCosmosAutoscale({ region, maxRU: c.maxRU, hours: c.hours, storageGB: c.storageGB, currency });
    case 'postgres-flex':
      return O.pricePostgresFlex({ region, sku: 'D4ds_v5', vcores: c.vcores, ha: !!c.ha, storageGB: c.storageGB, hours: c.hours, currency });
    case 'log-analytics':
      return O.priceLogAnalytics({ region, ingestGBPerDay: c.ingestGBPerDay, currency });
    case 'container-apps-consumption':
      return O.priceContainerAppsConsumption({ region, apps: c.apps, vcpu: c.vcpu, memGiB: c.memGiB, replicas: c.replicas, hours: c.hours, requests: c.requests, currency });
    case 'load-balancer':
      return O.priceLoadBalancer({ rules: c.rules, processedGB: c.processedGB, hours: c.hours, currency });
    case 'azure-files':
      return O.priceAzureFiles({ region, tier: 'ProvisionedV2HDD', redundancy: c.redundancy, capacityGB: c.capacityGB, currency });
    default:
      throw new Error(`Unknown canonical service: ${c.service}`);
  }
}

async function priceCheapestOpenAi({ region, models, inputTokens, outputTokens, currency }) {
  const priced = {};
  for (const m of models) {
    if (!O.OPENAI_MODELS[m]) continue;
    priced[m] = await O.priceOpenAiTokens({ region, model: m, inputTokens, outputTokens, currency });
  }
  const names = Object.keys(priced);
  names.sort((a, b) => priced[a].monthlyList - priced[b].monthlyList);
  const best = priced[names[0]];
  return {
    lines: best.lines,
    monthlyList: best.monthlyList,
    notes: [
      `Cheapest Global Standard model of ${names.join(', ')} is ${names[0]} at ${best.monthlyList}/month.`,
      ...best.notes,
      ...names.map(n => `  ${n}: ${priced[n].monthlyList}/month list`),
    ],
    alternatives: Object.fromEntries(names.map(n => [n, { monthlyList: priced[n].monthlyList, lines: priced[n].lines }])),
  };
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(SCENARIOS, 'utf8'));
  const out = { capturedAt: new Date().toISOString(), apiVersion: '2023-01-01-preview', hoursPerMonth: O.HOURS_PER_MONTH, scenarios: {} };

  for (const sc of doc.scenarios) {
    const currency = sc.facts.currency || 'USD';
    const region = sc.facts.region;
    const discountPct = parseDiscount(sc.facts.discount);
    const lines = [];
    const notes = [];
    process.stdout.write(`${sc.id} ... `);

    for (const c of sc.canonical.components) {
      const res = await priceComponent(c, sc);
      lines.push(...res.lines);
      notes.push(...res.notes);
      if (res.alternatives) notes.push('(openai model alternatives captured under variants.openai)');
    }

    const entry = {
      title: sc.title,
      region,
      currency,
      discountPct,
      canonical: {
        lines,
        monthlyList: O.round2(lines.reduce((s, l) => s + l.monthlyList, 0)),
        monthlyDiscounted: discountTotal(lines, discountPct),
      },
      variants: {},
      notes,
    };

    // --- VM SKU variants: per-instance and scenario-scale monthly, so the grader can
    // re-price whatever SKU the tool actually picked.
    const vmComp = sc.canonical.components.find(c => c.service === 'vm');
    if (vmComp && sc.accept && sc.accept.vm_skus) {
      entry.variants.vm = {};
      for (const sku of sc.accept.vm_skus) {
        try {
          const one = await O.priceVm({ region, sku, os: vmComp.os, count: 1, hours: vmComp.hours, currency });
          const all = await O.priceVm({ region, sku, os: vmComp.os, count: vmComp.count, hours: vmComp.hours, currency });
          entry.variants.vm[sku] = {
            os: vmComp.os,
            hours: vmComp.hours,
            count: vmComp.count,
            includesRhelLicense: vmComp.os === 'rhel',
            perInstanceMonthlyList: one.monthlyList,
            perInstanceMonthlyDiscounted: discountTotal(one.lines, discountPct),
            totalMonthlyList: all.monthlyList,
            totalMonthlyDiscounted: discountTotal(all.lines, discountPct),
            lines: all.lines,
          };
        } catch (e) {
          entry.variants.vm[sku] = { error: String(e.message) };
        }
      }
    }

    // --- Disk tier variants.
    const diskComp = sc.canonical.components.find(c => c.service === 'managed-disk');
    if (sc.accept && sc.accept.disk_tiers) {
      entry.variants.disk = {};
      for (const t of sc.accept.disk_tiers) {
        try {
          if (/^Premium ?V2$/i.test(t)) {
            const sizeGiB = diskComp.sizeGiB || 128;
            const res = await O.pricePremiumV2({
              region, sizeGiB,
              iops: diskComp.iops || 3000,
              throughputMBps: diskComp.throughputMBps || 125,
              currency,
            });
            entry.variants.disk[t] = { perDiskMonthlyList: res.monthlyList, monthlyList: res.monthlyList, monthlyDiscounted: discountTotal(res.lines, discountPct), lines: res.lines };
          } else if (/^Ephemeral$/i.test(t)) {
            entry.variants.disk[t] = { perDiskMonthlyList: 0, monthlyList: 0, monthlyDiscounted: 0, lines: [], note: 'Ephemeral OS disks have no managed-disk charge (they use the VM cache/temp storage that is already in the VM price).' };
          } else {
            const count = diskComp ? (diskComp.count || 1) : 1;
            const red = diskComp && /ZRS/i.test(diskComp.tier || '') ? 'ZRS' : 'LRS';
            const one = await O.priceManagedDisk({ region, tier: t, redundancy: red, count: 1, currency });
            const all = await O.priceManagedDisk({ region, tier: t, redundancy: red, count, currency });
            entry.variants.disk[t] = {
              perDiskMonthlyList: one.monthlyList,
              count,
              monthlyList: all.monthlyList,
              monthlyDiscounted: discountTotal(all.lines, discountPct),
              lines: all.lines,
            };
          }
        } catch (e) {
          entry.variants.disk[t] = { error: String(e.message) };
        }
      }
    }

    // --- s13: PAYG vs reservations vs savings plans, per instance and x10.
    if (sc.id.startsWith('s13')) {
      const c = vmComp;
      entry.variants.commitment = {};
      for (const mode of ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y']) {
        const one = await O.priceVm({ region, sku: c.sku, os: c.os, count: 1, hours: c.hours, currency, mode });
        const all = await O.priceVm({ region, sku: c.sku, os: c.os, count: c.count, hours: c.hours, currency, mode });
        entry.variants.commitment[mode] = {
          sku: c.sku,
          perInstanceMonthlyList: one.monthlyList,
          perInstanceMonthlyDiscounted: discountTotal(one.lines, discountPct),
          fleetMonthlyList: all.monthlyList,
          fleetMonthlyDiscounted: discountTotal(all.lines, discountPct),
          lines: all.lines,
        };
      }
      // Same comparison for every acceptable SKU, so the grader can re-price any choice.
      entry.variants.commitmentBySku = {};
      for (const sku of (sc.accept.vm_skus || [])) {
        entry.variants.commitmentBySku[sku] = {};
        for (const mode of ['payg', 'ri1y', 'ri3y', 'sp1y', 'sp3y']) {
          try {
            const one = await O.priceVm({ region, sku, os: c.os, count: 1, hours: c.hours, currency, mode });
            const all = await O.priceVm({ region, sku, os: c.os, count: c.count, hours: c.hours, currency, mode });
            entry.variants.commitmentBySku[sku][mode] = {
              perInstanceMonthlyList: one.monthlyList,
              perInstanceMonthlyDiscounted: discountTotal(one.lines, discountPct),
              fleetMonthlyList: all.monthlyList,
              fleetMonthlyDiscounted: discountTotal(all.lines, discountPct),
            };
          } catch (e) {
            entry.variants.commitmentBySku[sku][mode] = { error: String(e.message) };
          }
        }
      }
    }

    // --- SQL license-included vs Azure Hybrid Benefit, for any scenario with a SQL PaaS
    //     component. Azure SQL splits vCore pricing into a regional base-compute meter and a
    //     GLOBAL "- SQL License" meter; AHB removes the license meter. Both are recorded so the
    //     grader can re-price whichever the tool assumed.
    for (const c of sc.canonical.components) {
      if (c.service !== 'sql-database' && c.service !== 'sql-mi') continue;
      const fn = c.service === 'sql-database' ? O.priceSqlDatabaseGP : O.priceSqlMiGP;
      entry.variants.sqlLicensing = entry.variants.sqlLicensing || {};
      for (const [k, li] of [['licenseIncluded', true], ['azureHybridBenefit', false]]) {
        try {
          const res = await fn({ region, vcores: c.vcores, storageGB: c.storageGB, hours: c.hours, licenseIncluded: li, currency });
          entry.variants.sqlLicensing[k] = {
            monthlyList: res.monthlyList,
            monthlyDiscounted: discountTotal(res.lines, discountPct),
            lines: res.lines,
          };
        } catch (e) {
          entry.variants.sqlLicensing[k] = { error: String(e.message) };
        }
      }
      entry.variants.sqlLicensing.canonicalChoice = 'licenseIncluded';
      entry.variants.sqlLicensing.why = 'The scenario facts state the customer has no SQL Server licenses, so license-included pricing applies (base compute + the global "General Purpose - SQL License" meter at $0.099966 per vCore-hour).';
    }

    // --- s09: every acceptable OpenAI model, priced individually.
    if (sc.id.startsWith('s09')) {
      const c = sc.canonical.components[0];
      entry.variants.openai = {};
      for (const m of (sc.accept.models || [])) {
        try {
          const res = await O.priceOpenAiTokens({ region, model: m, inputTokens: c.inputTokens, outputTokens: c.outputTokens, currency });
          entry.variants.openai[m] = { monthlyList: res.monthlyList, monthlyDiscounted: discountTotal(res.lines, discountPct), lines: res.lines };
        } catch (e) {
          entry.variants.openai[m] = { error: String(e.message) };
        }
      }
    }

    // --- s14: savings plan trap. Show what a 1y/3y SP would cost if bought for this
    // fleet - the commitment is billed EVERY hour, not just the 220 running hours.
    if (sc.id.startsWith('s14')) {
      const c = vmComp;
      entry.variants.commitment = {};
      const payg = await O.priceVm({ region, sku: c.sku, os: c.os, count: c.count, hours: c.hours, currency, mode: 'payg' });
      entry.variants.commitment.payg = { hours: c.hours, fleetMonthlyList: payg.monthlyList, fleetMonthlyDiscounted: discountTotal(payg.lines, discountPct), lines: payg.lines };
      for (const mode of ['sp1y', 'sp3y']) {
        const sp = await O.priceVm({ region, sku: c.sku, os: c.os, count: c.count, hours: O.HOURS_PER_MONTH, currency, mode });
        entry.variants.commitment[mode] = {
          hours: O.HOURS_PER_MONTH,
          note: 'Savings plan commitment is billed for all 730 hours/month whether the VMs run or not.',
          fleetMonthlyList: sp.monthlyList,
          fleetMonthlyDiscounted: discountTotal(sp.lines, discountPct),
          lines: sp.lines,
        };
      }
      for (const mode of ['ri1y', 'ri3y']) {
        const ri = await O.priceVm({ region, sku: c.sku, os: c.os, count: c.count, hours: c.hours, currency, mode });
        entry.variants.commitment[mode] = {
          note: 'Reservation is billed for the whole term regardless of VM uptime.',
          fleetMonthlyList: ri.monthlyList,
          fleetMonthlyDiscounted: discountTotal(ri.lines, discountPct),
          lines: ri.lines,
        };
      }
    }

    // --- s20: also price the pay-as-you-go Azure Files alternatives.
    if (sc.id.startsWith('s20')) {
      const c = sc.canonical.components[0];
      entry.variants.files = {};
      for (const [key, tier] of [['ProvisionedV2HDD', 'ProvisionedV2HDD'], ['Hot', 'Hot'], ['TransactionOptimized', 'TransactionOptimized'], ['Cool', 'Cool']]) {
        try {
          const res = await O.priceAzureFiles({ region, tier, redundancy: c.redundancy, capacityGB: c.capacityGB, currency });
          entry.variants.files[key] = { monthlyList: res.monthlyList, monthlyDiscounted: discountTotal(res.lines, discountPct), lines: res.lines, notes: res.notes };
        } catch (e) {
          entry.variants.files[key] = { error: String(e.message) };
        }
      }
    }

    // --- s12: Log Analytics commitment comparison is already in the notes; also record
    // the raw PAYG-vs-commitment numbers explicitly.
    if (sc.id.startsWith('s12')) {
      const la = sc.canonical.components.find(x => x.service === 'log-analytics');
      const res = await O.priceLogAnalytics({ region, ingestGBPerDay: la.ingestGBPerDay, currency });
      entry.variants.logAnalytics = { monthlyList: res.monthlyList, monthlyDiscounted: discountTotal(res.lines, discountPct), notes: res.notes };
    }

    // --- s18: also record the idle-rate variant.
    if (sc.id.startsWith('s18')) {
      const c = sc.canonical.components[0];
      const idle = await O.priceContainerAppsConsumption({ region, apps: c.apps, vcpu: c.vcpu, memGiB: c.memGiB, replicas: c.replicas, hours: c.hours, requests: c.requests, idle: true, currency });
      entry.variants.containerApps = { idleRate: { monthlyList: idle.monthlyList, monthlyDiscounted: discountTotal(idle.lines, discountPct), lines: idle.lines } };
    }

    out.scenarios[sc.id] = entry;
    console.log(`list ${entry.canonical.monthlyList} ${currency}, discounted(${(discountPct * 100).toFixed(0)}%) ${entry.canonical.monthlyDiscounted}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT}`);

  console.log('\n| Scenario | Currency | Disc | Monthly list | Monthly discounted |');
  console.log('|---|---|---|---|---|');
  for (const [id, e] of Object.entries(out.scenarios)) {
    console.log(`| ${id} | ${e.currency} | ${(e.discountPct * 100).toFixed(0)}% | ${e.canonical.monthlyList.toFixed(2)} | ${e.canonical.monthlyDiscounted.toFixed(2)} |`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
