'use strict';
const { query, dedupe, round2 } = require('../api');
const calc = require('../calculator');
const SLUG = 'azure-arc', HOURS = 730;
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function total(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
async function data() { const r = await fetch(`https://azure.microsoft.com/api/v3/pricing/${SLUG}/calculator/?culture=en-us`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`calculator ${SLUG} HTTP ${r.status}`); return r.json(); }
function price(d, offer, unit, region) { const p = d.offers[offer].prices[unit]; return (p[calc.calcRegion(d, region)] || p.global).value; }
function graduated(d, offer, unit, region, qty) { const bands = d.offers[offer].graduatedPrices[unit][calc.calcRegion(d, region)] || d.offers[offer].graduatedPrices[unit].global; let prev = 0, cost = 0; for (const b of bands.prices) { const end = b.limit; const units = Math.max(0, Math.min(qty, end) - prev); cost += units * b.price.value; if (qty <= end) break; prev = end; } return cost; }
async function arc(cfg) {
  const d = await data(); const lines = []; const count = cfg.count || 1, cores = cfg.cores, hours = cfg.hours == null ? HOURS : cfg.hours;
  if (cfg.workload === 'kubernetes-gitops') {
    const p = graduated(d, 'kubernetes-vcpus', 'permonth', cfg.region, count * cores);
    lines.push(line(`Arc Kubernetes: ${count * cores} total vCPU/month; first 6 vCPU free`, p, { sourceOffer: 'kubernetes-vcpus' }));
  } else if (cfg.workload === 'essential-machine-management') {
    if (cfg.freeEntitlement) {
      lines.push(line('Essential Machine Management free entitlement: WS SA, Windows Server PAYG, ESU, or Defender for Servers P2', 0, { sourceOffer: 'azure-arc-essential-machine-management' }));
    } else {
      const p = price(d, 'azure-arc-essential-machine-management', 'perhour', cfg.region);
      lines.push(line(`Essential Machine Management: ${count} server(s) * ${hours} h * ${p}`, count * hours * p, { sourceOffer: 'azure-arc-essential-machine-management' }));
    }
  } else if (cfg.workload === 'windows-server-payg') {
    const p = price(d, 'azure-arc-payg-windows-server', 'perhour', cfg.region);
    lines.push(line(`Windows Server PAYG: ${count} * ${cores} cores * ${hours} h * ${p}`, count * cores * hours * p, { sourceOffer: 'azure-arc-payg-windows-server' }));
  } else if (cfg.workload === 'sql-server') {
    const offer = cfg.edition === 'enterprise' || cfg.licenseScope === 'physical-host' ? 'azure-arc-enterprise-edition' : 'azure-arc-standard-edition';
    const p = price(d, offer, 'perhour', cfg.region);
    const billableCores = Math.max(4, cores);
    lines.push(line(`Arc SQL Server ${cfg.edition || 'standard'}: ${count} * max(4, ${cores}) cores * ${hours} h * ${p}`, count * billableCores * hours * p, { sourceOffer: offer }));
  } else if (cfg.workload === 'sql-managed-instance') {
    const tier = cfg.tier || 'general-purpose'; const licensing = cfg.licensing || 'license-included'; const commitment = cfg.commitment || 'payg';
    const offer = tier === 'business-critical' ? 'azure-arc-business-critical-ahb' : 'azure-arc-vcore';
    const unit = commitment === '1yr' ? 'perhouroneyearreserved' : commitment === '3yr' ? 'perhourthreeyearreserved' : 'perhour';
    const billHours = commitment === 'payg' ? hours : HOURS;
    const p = price(d, offer, unit, cfg.region);
    lines.push(line(`Arc SQL MI ${tier} service ${commitment}: ${count} * ${cores} vCore * ${billHours} h * ${p}`, count * cores * billHours * p, { sourceOffer: offer, unit }));
    if ((cfg.drReplicaVcores || 0) && tier === 'general-purpose') { lines.push(line(`GP DR replica: ${cfg.drReplicaVcores} vCore * ${billHours} h * ${p}`, cfg.drReplicaVcores * billHours * p, { sourceOffer: offer })); }
    if (licensing === 'license-included') {
      const licenseOffer = tier === 'business-critical' ? 'azure-arc-business-critical' : 'azure-arc-standard-edition';
      const lp = price(d, licenseOffer, 'perhour', cfg.region);
      lines.push(line(`SQL Server license included: ${count} * ${cores} vCore * ${billHours} h * ${lp}`, count * cores * billHours * lp, { sourceOffer: licenseOffer }));
    }
  }
  return { monthlyList: total(lines), lines };
}
async function retailEurK8s(cfg) {
  const rows = dedupe(await query(`serviceName eq 'Azure Arc'`, 'EUR'));
  if (cfg.workload === 'essential-machine-management') {
    if (cfg.freeEntitlement) return { monthlyList: 0, lines: [line('EUR Essential Machine Management free entitlement', 0)] };
    const row = rows.find(r => r.productName === 'Azure Arc' && r.skuName === 'Essential Machine Management' && r.meterName === 'Essential Machine Management Server' && r.armRegionName === 'Global');
    if (!row) return arc(cfg);
    const cost = (cfg.count || 1) * (cfg.hours == null ? HOURS : cfg.hours) * row.retailPrice;
    return { monthlyList: round2(cost), lines: [line(`EUR EMM: ${cfg.count || 1} server(s) * ${cfg.hours == null ? HOURS : cfg.hours} h * ${row.retailPrice}`, cost, { meterId: row.meterId })] };
  }
  const row = rows.find(r => r.productName === 'Azure Arc' && r.skuName === 'Kubernetes' && r.meterName === 'Kubernetes Configuration Management/vCPU' && r.armRegionName === 'Global' && r.retailPrice > 0); if (!row) return arc(cfg); const paid = Math.max(0, (cfg.count || 1) * cfg.cores - 6); return { monthlyList: round2(paid * row.retailPrice), lines: [line(`EUR Arc Kubernetes: ${paid} paid vCPU after 6 free * ${row.retailPrice}`, paid * row.retailPrice, { meterId: row.meterId })] };
}
function c(name, cfg) { const { region, currency, ...component } = cfg; return { name, region: region || 'eastus2', currency: currency || 'USD', component: { type: 'azure-arc', ...component }, expected: () => currency === 'EUR' ? retailEurK8s(cfg) : arc(cfg) }; }
module.exports = { type: 'azure-arc', source: 'both', cases: [
  // v3 calculator graduated kubernetes-vcpus: first 6 vCPUs across the priced total are free, then per vCPU-month.
  c('Kubernetes exactly 6 free vCPUs', { region: 'eastus2', workload: 'kubernetes-gitops', count: 1, cores: 6 }),
  // Same graduated offer, one vCPU above the grant.
  c('Kubernetes one vCPU over free grant', { region: 'eastus2', workload: 'kubernetes-gitops', count: 1, cores: 7 }),
  // US Gov has a higher Arc containers vCore-hour price than commercial regions.
  c('Kubernetes US Gov paid vCPUs', { region: 'usgovarizona', workload: 'kubernetes-gitops', count: 2, cores: 8 }),
  // SQL Server Standard Arc PAYG is per core-hour.
  c('SQL Server Standard partial month', { region: 'eastus2', workload: 'sql-server', edition: 'standard', count: 2, cores: 4, hours: 365 }),
  // SQL Server PAYG has a 4-core minimum per machine; 2 cores bills as 4.
  c('SQL Server Enterprise 4-core minimum', { region: 'eastus2', workload: 'sql-server', edition: 'enterprise', count: 1, cores: 2 }),
  // SQL Server Enterprise physical host uses the Enterprise per-core-hour meter.
  c('SQL Server Enterprise physical host', { region: 'westeurope', workload: 'sql-server', edition: 'enterprise', licenseScope: 'physical-host', count: 1, cores: 16 }),
  // Windows Server PAYG through Arc bills per core-hour while running.
  c('Windows Server PAYG', { region: 'eastus2', workload: 'windows-server-payg', count: 3, cores: 8, hours: 100 }),
  // SQL MI general-purpose license-included uses the vCore service price plus optional DR replica vCores.
  c('SQL MI general purpose with DR replica', { region: 'eastus2', workload: 'sql-managed-instance', tier: 'general-purpose', licensing: 'license-included', count: 1, cores: 8, drReplicaVcores: 4 }),
  // SQL MI PAYG honors a partial-month hours input for both service and included SQL license lines.
  c('SQL MI general purpose partial month', { region: 'eastus2', workload: 'sql-managed-instance', tier: 'general-purpose', licensing: 'license-included', count: 1, cores: 4, hours: 365 }),
  // Business Critical license-included is Arc service/AHB rate plus the SQL Server license rate.
  c('SQL MI business critical license included partial month', { region: 'eastus2', workload: 'sql-managed-instance', tier: 'business-critical', licensing: 'license-included', count: 1, cores: 8, hours: 300 }),
  // SQL MI Business Critical with AHB and 3-year reservation uses the reserved AHB unit.
  c('SQL MI business critical AHB 3yr', { region: 'westeurope', workload: 'sql-managed-instance', tier: 'business-critical', licensing: 'hybrid-benefit', commitment: '3yr', count: 1, cores: 8 }),
  // Essential Machine Management is per Arc-connected server-hour unless a listed entitlement makes it free.
  c('Essential Machine Management paid', { region: 'eastus2', workload: 'essential-machine-management', count: 20, cores: 1 }),
  // Essential Machine Management is free with Windows Server SA, Windows Server PAYG, ESU, or Defender for Servers P2.
  c('Essential Machine Management free entitlement', { region: 'eastus2', workload: 'essential-machine-management', count: 20, cores: 1, freeEntitlement: true }),
  // Azure Government EMM retail/calculator rate is 0.
  c('Essential Machine Management US Gov zero meter', { region: 'usgovvirginia', workload: 'essential-machine-management', count: 5, cores: 1, hours: 100 }),
  // EUR case uses same calculator math because Retail API does not currently expose this v3 Arc K8s meter.
  c('EUR West Europe Kubernetes over grant', { region: 'westeurope', currency: 'EUR', workload: 'kubernetes-gitops', count: 1, cores: 8 }),
  // Retail API EUR EMM uses the Global Essential Machine Management Server hourly meter.
  c('EUR Essential Machine Management paid', { region: 'westeurope', currency: 'EUR', workload: 'essential-machine-management', count: 10, cores: 1, hours: 300 })
] };
