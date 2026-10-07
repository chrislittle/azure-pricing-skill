'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'container-instances';
const HOURS_PER_MONTH = 730;
const SECONDS_PER_HOUR = 3600;

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function billableVcpu(vcpu) { return Math.ceil(vcpu); }
function billableMemory(memoryGb) { return Math.ceil(memoryGb * 10 - 1e-12) / 10; }
async function calculatorOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }
async function retailRows(region, currency) { return dedupe(await query(`serviceName eq 'Container Instances' and armRegionName eq '${region}'`, currency)); }
function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Container Instances row for ${what}, found ${hits.length}`);
  return hits[0];
}
function savingsPrice(row, term) {
  const hit = (row.savingsPlan || []).find(s => s.term === term);
  if (!hit) throw new Error(`missing ${term} savings price for ${row.meterName}`);
  return hit.retailPrice;
}

async function calculatorAci({ region, vcpu, memoryGb, containerGroups = 1, hours = HOURS_PER_MONTH, os = 'linux', variant = 'standard' }) {
  const seconds = hours * SECONDS_PER_HOUR;
  const billedVcpu = billableVcpu(vcpu);
  const billedMemory = billableMemory(memoryGb);
  const lines = [];
  if (variant === 'standard') {
    const core = await calculatorOffer('core-duration', region);
    const mem = await calculatorOffer('memory-duration', region);
    lines.push(line(`standard vCPU: ${containerGroups} groups * ${billedVcpu} rounded vCPU * ${seconds} seconds * ${core}`, containerGroups * billedVcpu * seconds * core, { sourceOffer: 'core-duration' }));
    lines.push(line(`standard memory: ${containerGroups} groups * ${billedMemory} rounded GB * ${seconds} seconds * ${mem}`, containerGroups * billedMemory * seconds * mem, { sourceOffer: 'memory-duration' }));
    if (os === 'windows') {
      const win = await calculatorOffer('software-duration', region);
      lines.push(line(`Windows software: ${containerGroups} groups * ${billedVcpu} rounded vCPU * ${seconds} seconds * ${win}`, containerGroups * billedVcpu * seconds * win, { sourceOffer: 'software-duration' }));
    }
  } else if (variant === 'confidential') {
    const core = await calculatorOffer('confidential-container-core-duration', region);
    const mem = await calculatorOffer('confidential-container-memory-duration', region);
    lines.push(line(`confidential vCPU: ${containerGroups} groups * ${billedVcpu} rounded vCPU * ${seconds} seconds * ${core}`, containerGroups * billedVcpu * seconds * core, { sourceOffer: 'confidential-container-core-duration' }));
    lines.push(line(`confidential memory: ${containerGroups} groups * ${billedMemory} rounded GB * ${seconds} seconds * ${mem}`, containerGroups * billedMemory * seconds * mem, { sourceOffer: 'confidential-container-memory-duration' }));
  } else {
    throw new Error(`calculatorAci does not handle ${variant}`);
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailAci({ region, currency, vcpu, memoryGb, containerGroups = 1, hours = HOURS_PER_MONTH, os = 'linux', variant = 'standard', commitment = 'payg' }) {
  const rows = await retailRows(region, currency);
  const billedVcpu = billableVcpu(vcpu);
  const billedMemory = billableMemory(memoryGb);
  const lines = [];
  const isSavings = commitment === 'savings-1y' || commitment === 'savings-3y';
  const term = commitment === 'savings-1y' ? '1 Year' : commitment === 'savings-3y' ? '3 Years' : null;
  if (variant === 'standard' || variant === 'spot') {
    const sku = variant === 'spot' ? 'Standard Spot' : 'Standard';
    const coreRow = pickOne(rows, r => r.productName === 'Container Instances' && r.skuName === sku && r.meterName.includes('vCPU Duration') && r.type === 'Consumption', `${sku} vCPU`);
    const memRow = pickOne(rows, r => r.productName === 'Container Instances' && r.skuName === sku && r.meterName.includes('Memory Duration') && r.type === 'Consumption', `${sku} memory`);
    const corePrice = isSavings ? savingsPrice(coreRow, term) : coreRow.retailPrice;
    const memPrice = isSavings ? savingsPrice(memRow, term) : memRow.retailPrice;
    lines.push(line(`${commitment} ${sku} vCPU: ${containerGroups} groups * ${billedVcpu} rounded vCPU * ${hours} hours / ${unitSize(coreRow.unitOfMeasure)} * ${corePrice}`, containerGroups * billedVcpu * hours / unitSize(coreRow.unitOfMeasure) * corePrice, { meterId: coreRow.meterId }));
    lines.push(line(`${commitment} ${sku} memory: ${containerGroups} groups * ${billedMemory} rounded GB * ${hours} hours / ${unitSize(memRow.unitOfMeasure)} * ${memPrice}`, containerGroups * billedMemory * hours / unitSize(memRow.unitOfMeasure) * memPrice, { meterId: memRow.meterId }));
    if (os === 'windows') {
      const winRow = pickOne(rows, r => r.productName === 'Container Instances' && r.skuName === 'Standard' && r.meterName === 'Standard Windows Software Duration' && r.type === 'Consumption', 'Windows software');
      const winPrice = isSavings ? savingsPrice(winRow, term) : winRow.retailPrice;
      lines.push(line(`${commitment} Windows software: ${containerGroups} groups * ${billedVcpu} rounded vCPU * ${hours * SECONDS_PER_HOUR} seconds / ${unitSize(winRow.unitOfMeasure)} * ${winPrice}`, containerGroups * billedVcpu * hours * SECONDS_PER_HOUR / unitSize(winRow.unitOfMeasure) * winPrice, { meterId: winRow.meterId }));
    }
  } else if (variant === 'confidential') {
    const coreRow = pickOne(rows, r => r.skuName === 'Confidential containers ACI' && r.meterName.includes('vCPU Duration') && r.type === 'Consumption', 'confidential vCPU');
    const memRow = pickOne(rows, r => r.skuName === 'Confidential containers ACI' && r.meterName.includes('Memory Duration') && r.type === 'Consumption', 'confidential memory');
    const corePrice = isSavings ? savingsPrice(coreRow, term) : coreRow.retailPrice;
    const memPrice = isSavings ? savingsPrice(memRow, term) : memRow.retailPrice;
    lines.push(line(`${commitment} confidential vCPU: ${containerGroups} groups * ${billedVcpu} rounded vCPU * ${hours} hours * ${corePrice}`, containerGroups * billedVcpu * hours * corePrice, { meterId: coreRow.meterId }));
    lines.push(line(`${commitment} confidential memory: ${containerGroups} groups * ${billedMemory} rounded GB * ${hours} hours * ${memPrice}`, containerGroups * billedMemory * hours * memPrice, { meterId: memRow.meterId }));
  } else {
    throw new Error(`retailAci does not handle ${variant}`);
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'container-instances',
  source: 'both',
  cases: [
    {
      name: 'pricing page example 2 rounded resources', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'standard', os: 'linux', vcpu: 1.3, memoryGb: 2.15, containerGroups: 50, hours: 62.5 },
      // Pricing page Example 2 rules: round 1.3 vCPU up to 2 and 2.15 GB up to 2.2 GB; East US 2 calculator rates give $283.72.
      expected: async () => calculatorAci({ region: 'eastus2', variant: 'standard', os: 'linux', vcpu: 1.3, memoryGb: 2.15, containerGroups: 50, hours: 62.5 }),
    },
    {
      name: 'standard Linux all month', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'standard', os: 'linux', vcpu: 2, memoryGb: 4, containerGroups: 2 },
      // Calculator offers core-duration and memory-duration are per rounded vCPU-second and GB-second; 730 hours = 2,628,000 seconds.
      expected: async () => calculatorAci({ region: 'eastus2', variant: 'standard', os: 'linux', vcpu: 2, memoryGb: 4, containerGroups: 2 }),
    },
    {
      name: 'standard Windows part-time', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'standard', os: 'windows', vcpu: 1, memoryGb: 2, containerGroups: 1, hours: 100 },
      // Calculator adds software-duration per rounded vCPU-second to standard core and memory seconds for Windows containers.
      expected: async () => calculatorAci({ region: 'eastus2', variant: 'standard', os: 'windows', vcpu: 1, memoryGb: 2, hours: 100 }),
    },
    {
      name: 'spot Linux uses discounted retail meters', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'spot', os: 'linux', vcpu: 4, memoryGb: 8, containerGroups: 1, hours: 50 },
      // Retail API Standard Spot meters are hourly for rounded vCPU and GB; calculator has no spot offer in its older snapshot.
      expected: async () => retailAci({ region: 'eastus2', currency: 'USD', variant: 'spot', os: 'linux', vcpu: 4, memoryGb: 8, hours: 50 }),
    },
    {
      name: 'spot Windows allowed', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'spot', os: 'windows', vcpu: 1.2, memoryGb: 2.05, containerGroups: 2, hours: 25 },
      // Retail API Standard Spot vCPU/memory meters combine with the Standard Windows software meter; ACI still rounds vCPU and memory before billing.
      expected: async () => retailAci({ region: 'eastus2', currency: 'USD', variant: 'spot', os: 'windows', vcpu: 1.2, memoryGb: 2.05, containerGroups: 2, hours: 25 }),
    },
    {
      name: 'retired GPU variant refused', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'gpu-v100', vcpu: 8, memoryGb: 64, gpus: 1, hours: 10 },
      expectEngineError: /gpu|variant|retired|invalid/i,
    },
    {
      name: 'confidential 1 year savings plan', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'confidential', commitment: 'savings-1y', vcpu: 2, memoryGb: 8, containerGroups: 1 },
      // Retail API embeds 1 Year savingsPlan prices on confidential ACI vCPU and memory meters; multiply by 730 hours.
      expected: async () => retailAci({ region: 'eastus2', currency: 'USD', variant: 'confidential', commitment: 'savings-1y', vcpu: 2, memoryGb: 8 }),
    },
    {
      name: 'standard Windows 1 year savings plan', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'standard', os: 'windows', commitment: 'savings-1y', vcpu: 1.2, memoryGb: 2.05, containerGroups: 1 },
      // Retail API embeds 1 Year savingsPlan prices for standard vCPU, memory and Windows software meters; resources are rounded before billing.
      expected: async () => retailAci({ region: 'eastus2', currency: 'USD', variant: 'standard', os: 'windows', commitment: 'savings-1y', vcpu: 1.2, memoryGb: 2.05 }),
    },
    {
      name: 'standard 3 year savings plan', region: 'eastus2', currency: 'USD',
      component: { type: 'container-instances', variant: 'standard', commitment: 'savings-3y', vcpu: 2, memoryGb: 3, containerGroups: 1 },
      // Retail API embeds 3 Year savingsPlan prices on standard ACI vCPU and memory meters; multiply by 730 hours.
      expected: async () => retailAci({ region: 'eastus2', currency: 'USD', variant: 'standard', commitment: 'savings-3y', vcpu: 2, memoryGb: 3 }),
    },
    {
      name: 'standard EUR retail API', region: 'eastus2', currency: 'EUR',
      component: { type: 'container-instances', variant: 'standard', os: 'linux', vcpu: 1, memoryGb: 1.5, containerGroups: 1, hours: 100 },
      // Retail API EUR standard meters are hourly vCPU and GB prices; calculator data is USD only.
      expected: async () => retailAci({ region: 'eastus2', currency: 'EUR', variant: 'standard', os: 'linux', vcpu: 1, memoryGb: 1.5, hours: 100 }),
    },
    {
      name: 'west europe EUR rounded standard', region: 'westeurope', currency: 'EUR',
      component: { type: 'container-instances', variant: 'standard', os: 'linux', vcpu: 1.3, memoryGb: 2.15, containerGroups: 3, hours: 10 },
      // Retail API EUR West Europe meters verify non-US currency pricing and pricing-page rounding outside East US 2.
      expected: async () => retailAci({ region: 'westeurope', currency: 'EUR', variant: 'standard', os: 'linux', vcpu: 1.3, memoryGb: 2.15, containerGroups: 3, hours: 10 }),
    },
  ],
};
