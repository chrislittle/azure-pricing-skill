'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'logic-apps';
const HOURS_PER_MONTH = 730;
const DAYS_PER_MONTH = 730 / 24;
const WS = { ws1: [1, 3.5], ws2: [2, 7], ws3: [4, 14] };
const APP_SERVICE = {
  p0v3: 'p0v3-premium-plan', p1v3: 'p1-v3-premium-plan', p1mv3: 'p1mv3-premium-plan',
  p2v3: 'p2-v3-premium-plan', p2mv3: 'p2mv3-premium-plan', p3v3: 'p3-v3-premium-plan',
};

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
async function calcOffer(offer, region) { return (await calc.offerPrice(SLUG, offer, region)).value; }

async function graduatedCalc(offer, region, qty) {
  const data = await calc.product(SLUG);
  const calcRegion = calc.calcRegion(data, region);
  const table = data.graduatedOffers[offer][calcRegion];
  if (!table) throw new Error(`calculator has no ${offer} graduated prices for ${calcRegion}`);
  let previous = 0;
  let cost = 0;
  const bands = [];
  for (const band of table.prices) {
    const units = Math.max(0, Math.min(qty, band.limit) - previous);
    if (units) {
      cost += units * band.price.value;
      bands.push({ from: previous, to: band.limit === Number.MAX_VALUE ? null : band.limit, units, unitPrice: band.price.value });
    }
    previous = band.limit;
    if (qty <= band.limit) break;
  }
  return { cost, bands };
}

function tiered(rows, qty) {
  const bands = rows.slice().sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits);
  let cost = 0;
  for (let i = 0; i < bands.length; i++) {
    const start = bands[i].tierMinimumUnits;
    const end = i + 1 < bands.length ? bands[i + 1].tierMinimumUnits : Infinity;
    if (qty <= start) break;
    cost += (Math.min(qty, end) - start) * bands[i].retailPrice;
  }
  return cost;
}

async function calculatorLogicApps({ region, plan, actionsPerDay = 0, standardConnectorCallsPerDay = 0, enterpriseConnectorCallsPerDay = 0, dataRetentionGb = 0, agentInputTokens = 0, agentOutputTokens = 0, hostingPlan = 'ws1', instances = 1, os = 'windows', hybridVcpus = 0, iseTier = 'developer', iseScaleUnits = 0, basicIntegrationAccounts = 0, standardIntegrationAccounts = 0, premiumIntegrationAccounts = 0, hours = HOURS_PER_MONTH }) {
  const lines = [];
  if (plan === 'consumption') {
    const monthlyActions = actionsPerDay * DAYS_PER_MONTH;
    const actions = await graduatedCalc('actions', region, monthlyActions);
    lines.push(line(`Consumption built-in actions: graduated ${monthlyActions} monthly actions (first 4,000 free)`, actions.cost, { sourceOffer: 'actions', bands: actions.bands }));
    if (standardConnectorCallsPerDay) {
      const p = await calcOffer('standard-connector', region);
      lines.push(line(`Consumption standard connector calls: ${standardConnectorCallsPerDay} * ${DAYS_PER_MONTH} days * ${p}`, standardConnectorCallsPerDay * DAYS_PER_MONTH * p, { sourceOffer: 'standard-connector' }));
    }
    if (enterpriseConnectorCallsPerDay) {
      const p = await calcOffer('enterprise-connector', region);
      lines.push(line(`Consumption enterprise connector calls: ${enterpriseConnectorCallsPerDay} * ${DAYS_PER_MONTH} days * ${p}`, enterpriseConnectorCallsPerDay * DAYS_PER_MONTH * p, { sourceOffer: 'enterprise-connector' }));
    }
    if (dataRetentionGb) {
      const p = await calcOffer('data-retention', region);
      lines.push(line(`Consumption data retention: ${dataRetentionGb} GB-month * ${p}`, dataRetentionGb * p, { sourceOffer: 'data-retention' }));
    }
    if (agentInputTokens) {
      const p = await calcOffer('agentic-capabilities-input', region);
      lines.push(line(`Agent input tokens: ${agentInputTokens} / 1M * ${p}`, (agentInputTokens / 1e6) * p, { sourceOffer: 'agentic-capabilities-input' }));
    }
    if (agentOutputTokens) {
      const p = await calcOffer('agentic-capabilities-output', region);
      lines.push(line(`Agent output tokens: ${agentOutputTokens} / 1M * ${p}`, (agentOutputTokens / 1e6) * p, { sourceOffer: 'agentic-capabilities-output' }));
    }
  }
  if (plan === 'standard') {
    if (WS[hostingPlan]) {
      const [vcpus, gib] = WS[hostingPlan];
      const vcpu = await calcOffer('standard-vcpu', region);
      const memory = await calcOffer('standard-memory', region);
      lines.push(line(`Standard ${hostingPlan} vCPU duration: ${instances} * ${vcpus} vCPU * ${hours} hours * ${vcpu}`, instances * vcpus * hours * vcpu, { sourceOffer: 'standard-vcpu' }));
      lines.push(line(`Standard ${hostingPlan} memory duration: ${instances} * ${gib} GiB * ${hours} hours * ${memory}`, instances * gib * hours * memory, { sourceOffer: 'standard-memory' }));
    } else {
      const offer = `${APP_SERVICE[hostingPlan]}-${os}`;
      const p = await calcOffer(offer, region);
      lines.push(line(`Standard App Service ${hostingPlan} ${os}: ${instances} * ${hours} hours * ${p}`, instances * hours * p, { sourceOffer: offer }));
    }
    if (standardConnectorCallsPerDay) {
      const p = await calcOffer('standard-connector', region);
      lines.push(line(`Standard standard-connector calls: ${standardConnectorCallsPerDay} * ${DAYS_PER_MONTH} days * ${p}`, standardConnectorCallsPerDay * DAYS_PER_MONTH * p, { sourceOffer: 'standard-connector' }));
    }
    if (enterpriseConnectorCallsPerDay) {
      const p = await calcOffer('enterprise-connector', region);
      lines.push(line(`Standard enterprise-connector calls: ${enterpriseConnectorCallsPerDay} * ${DAYS_PER_MONTH} days * ${p}`, enterpriseConnectorCallsPerDay * DAYS_PER_MONTH * p, { sourceOffer: 'enterprise-connector' }));
    }
  }
  if (plan === 'hybrid') {
    const p = await calcOffer('hybrid-vcpu', region);
    lines.push(line(`Hybrid vCPU duration: ${hybridVcpus} vCPU * ${hours} hours * ${p}`, hybridVcpus * hours * p, { sourceOffer: 'hybrid-vcpu' }));
    if (standardConnectorCallsPerDay) {
      const q = await calcOffer('standard-connector', region);
      lines.push(line(`Hybrid standard connector calls: ${standardConnectorCallsPerDay} * ${DAYS_PER_MONTH} * ${q}`, standardConnectorCallsPerDay * DAYS_PER_MONTH * q, { sourceOffer: 'standard-connector' }));
    }
    if (enterpriseConnectorCallsPerDay) {
      const q = await calcOffer('enterprise-connector', region);
      lines.push(line(`Hybrid enterprise connector calls: ${enterpriseConnectorCallsPerDay} * ${DAYS_PER_MONTH} * ${q}`, enterpriseConnectorCallsPerDay * DAYS_PER_MONTH * q, { sourceOffer: 'enterprise-connector' }));
    }
  }
  if (plan === 'ise') {
    const offer = iseTier === 'developer' ? 'base-units-integration-developer' : 'base-units-integration-premium';
    const p = await calcOffer(offer, region);
    lines.push(line(`ISE ${iseTier} base unit: ${hours} hours * ${p}`, hours * p, { sourceOffer: offer }));
    if (iseTier === 'premium' && iseScaleUnits) {
      const scale = await calcOffer('scale-units-integration-premium', region);
      lines.push(line(`ISE premium scale units: ${iseScaleUnits} * ${hours} hours * ${scale}`, iseScaleUnits * hours * scale, { sourceOffer: 'scale-units-integration-premium' }));
    }
  }
  if (basicIntegrationAccounts) {
    const p = await calcOffer('basic-integration', region);
    lines.push(line(`Basic integration accounts: ${basicIntegrationAccounts} * ${hours} hours * ${p}`, basicIntegrationAccounts * hours * p, { sourceOffer: 'basic-integration' }));
  }
  if (standardIntegrationAccounts) {
    const p = await calcOffer('standard-integration', region);
    lines.push(line(`Standard integration accounts: ${standardIntegrationAccounts} * ${hours} hours * ${p}`, standardIntegrationAccounts * hours * p, { sourceOffer: 'standard-integration' }));
  }
  if (premiumIntegrationAccounts) {
    const p = await calcOffer('premium-integration', region);
    lines.push(line(`Premium integration accounts: ${premiumIntegrationAccounts} * ${hours} hours * ${p}`, premiumIntegrationAccounts * hours * p, { sourceOffer: 'premium-integration' }));
  }
  return { monthlyList: totalOf(lines), lines };
}

async function retailLogicApps({ region, currency = 'EUR', plan = 'consumption', actionsPerDay = 0, standardConnectorCallsPerDay = 0, enterpriseConnectorCallsPerDay = 0, dataRetentionGb = 0, agentInputTokens = 0, agentOutputTokens = 0, hostingPlan = 'ws1', instances = 1, hybridVcpus = 0, hours = HOURS_PER_MONTH }) {
  const rows = dedupe(await query(`serviceName eq 'Logic Apps' and armRegionName eq '${region}'`, currency));
  const lines = [];
  if (plan === 'consumption') {
    const actions = rows.filter(r => r.productName === 'Logic Apps' && r.skuName === 'Consumption' && r.meterName === 'Consumption Built-in Actions');
    const monthlyActions = actionsPerDay * DAYS_PER_MONTH;
    lines.push(line(`EUR Consumption built-in actions: graduated ${monthlyActions} monthly actions (first 4,000 free)`, tiered(actions, monthlyActions), { meterId: actions[0].meterId }));
  }
  if (plan === 'standard') {
    const [vcpus, gib] = WS[hostingPlan];
    const vcpu = rows.find(r => r.meterName === 'Standard vCPU Duration');
    const memory = rows.find(r => r.meterName === 'Standard Memory Duration');
    lines.push(line(`EUR Standard ${hostingPlan} vCPU duration: ${instances} * ${vcpus} * ${hours} * ${vcpu.retailPrice}`, instances * vcpus * hours * vcpu.retailPrice, { meterId: vcpu.meterId }));
    lines.push(line(`EUR Standard ${hostingPlan} memory duration: ${instances} * ${gib} * ${hours} * ${memory.retailPrice}`, instances * gib * hours * memory.retailPrice, { meterId: memory.meterId }));
  }
  if (plan === 'hybrid') {
    const hybrid = rows.find(r => r.meterName === 'Hybrid vCPU Duration');
    lines.push(line(`EUR Hybrid vCPU duration: ${hybridVcpus} * ${hours} * ${hybrid.retailPrice}`, hybridVcpus * hours * hybrid.retailPrice, { meterId: hybrid.meterId }));
  }
  if (standardConnectorCallsPerDay) {
    const m = rows.find(r => r.meterName === 'Consumption Standard Connector Actions');
    lines.push(line(`EUR standard connector calls: ${standardConnectorCallsPerDay} * ${DAYS_PER_MONTH} * ${m.retailPrice}`, standardConnectorCallsPerDay * DAYS_PER_MONTH * m.retailPrice, { meterId: m.meterId }));
  }
  if (enterpriseConnectorCallsPerDay) {
    const m = rows.find(r => r.meterName === 'Consumption Enterprise Connector Actions');
    lines.push(line(`EUR enterprise connector calls: ${enterpriseConnectorCallsPerDay} * ${DAYS_PER_MONTH} * ${m.retailPrice}`, enterpriseConnectorCallsPerDay * DAYS_PER_MONTH * m.retailPrice, { meterId: m.meterId }));
  }
  if (dataRetentionGb) {
    const m = rows.find(r => r.meterName === 'Consumption Data Retention');
    lines.push(line(`EUR data retention: ${dataRetentionGb} * ${m.retailPrice}`, dataRetentionGb * m.retailPrice, { meterId: m.meterId }));
  }
  if (agentInputTokens) {
    const m = rows.find(r => r.meterName === 'Consumption Agent Loop Input Token');
    lines.push(line(`EUR agent input tokens: ${agentInputTokens} / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (agentInputTokens / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (agentOutputTokens) {
    const m = rows.find(r => r.meterName === 'Consumption Agent Loop Output Token');
    lines.push(line(`EUR agent output tokens: ${agentOutputTokens} / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (agentOutputTokens / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'logic-apps',
  source: 'both',
  cases: [
    {
      name: 'consumption at 4000 free built-in actions',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'consumption', actionsPerDay: 4000 / DAYS_PER_MONTH },
      // Calculator graduated actions offer has first 4,000 monthly built-in actions free.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'consumption', actionsPerDay: 4000 / DAYS_PER_MONTH }),
    },
    {
      name: 'consumption above free grant with connectors tokens and retention',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'consumption', actionsPerDay: 5000 / DAYS_PER_MONTH, standardConnectorCallsPerDay: 100, enterpriseConnectorCallsPerDay: 10, dataRetentionGb: 5, agentInputTokens: 2000000, agentOutputTokens: 1000000 },
      // Calculator actions charges only 1,000 actions above the 4,000 grant; connector, retention, and agent token offers have no free grant in the calculator data.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'consumption', actionsPerDay: 5000 / DAYS_PER_MONTH, standardConnectorCallsPerDay: 100, enterpriseConnectorCallsPerDay: 10, dataRetentionGb: 5, agentInputTokens: 2000000, agentOutputTokens: 1000000 }),
    },
    {
      name: 'standard ws1 workflow service plan',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'ws1', instances: 1, hours: 730 },
      // Calculator Standard WS1 uses 1 vCPU and 3.5 GiB memory duration offers for 730 hours.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'standard', hostingPlan: 'ws1', instances: 1, hours: 730 }),
    },
    {
      name: 'standard ws2 with connector namespace calls',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'ws2', instances: 2, standardConnectorCallsPerDay: 100, enterpriseConnectorCallsPerDay: 10, hours: 365 },
      // Calculator Standard WS2 uses 2 vCPU/7 GiB per instance plus connector namespace standard and enterprise call meters.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'standard', hostingPlan: 'ws2', instances: 2, standardConnectorCallsPerDay: 100, enterpriseConnectorCallsPerDay: 10, hours: 365 }),
    },
    {
      name: 'standard p0v3 windows app service plan',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'p0v3', os: 'windows', instances: 1, hours: 730 },
      // Calculator p0v3-premium-plan-windows offer bills App Service v3 hosting per instance-hour.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'standard', hostingPlan: 'p0v3', os: 'windows', instances: 1, hours: 730 }),
    },
    {
      name: 'standard p1v3 linux app service plan',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'p1v3', os: 'linux', instances: 1, hours: 730 },
      // Calculator p1-v3-premium-plan-linux offer bills Linux App Service v3 hosting per instance-hour.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'standard', hostingPlan: 'p1v3', os: 'linux', instances: 1, hours: 730 }),
    },
    {
      name: 'standard p1mv3 windows app service plan',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'p1mv3', os: 'windows', instances: 1, hours: 730 },
      // Calculator p1mv3-premium-plan-windows offer covers the memory-optimized App Service v3 SKU.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'standard', hostingPlan: 'p1mv3', os: 'windows', instances: 1, hours: 730 }),
    },
    {
      name: 'standard p2v3 linux app service plan',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'p2v3', os: 'linux', instances: 1, hours: 730 },
      // Calculator p2-v3-premium-plan-linux offer bills the P2v3 Linux hosting SKU.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'standard', hostingPlan: 'p2v3', os: 'linux', instances: 1, hours: 730 }),
    },
    {
      name: 'standard p2mv3 windows app service plan',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'p2mv3', os: 'windows', instances: 1, hours: 730 },
      // Calculator p2mv3-premium-plan-windows offer bills the P2mv3 memory-optimized hosting SKU.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'standard', hostingPlan: 'p2mv3', os: 'windows', instances: 1, hours: 730 }),
    },
    {
      name: 'standard p3v3 linux app service plan',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'p3v3', os: 'linux', instances: 1, hours: 730 },
      // Calculator p3-v3-premium-plan-linux offer bills the P3v3 Linux hosting SKU.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'standard', hostingPlan: 'p3v3', os: 'linux', instances: 1, hours: 730 }),
    },
    {
      name: 'hybrid kubernetes vcpu hours',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'hybrid', hybridVcpus: 4, hours: 365 },
      // Calculator hybrid-vcpu offer bills the assigned Kubernetes vCPUs per hour.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'hybrid', hybridVcpus: 4, hours: 365 }),
    },
    {
      name: 'ise developer base unit',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'ise', iseTier: 'developer', hours: 730 },
      // Calculator Integration Service Environment developer tier charges one base unit per hour.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'ise', iseTier: 'developer', hours: 730 }),
    },
    {
      name: 'ise premium base and scale units',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'ise', iseTier: 'premium', iseScaleUnits: 2, hours: 730 },
      // Calculator ISE Premium charges one premium base unit plus each extra premium scale unit per hour.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'ise', iseTier: 'premium', iseScaleUnits: 2, hours: 730 }),
    },
    {
      name: 'integration accounts all tiers',
      region: 'eastus2', currency: 'USD',
      component: { type: 'logic-apps', plan: 'consumption', actionsPerDay: 0, basicIntegrationAccounts: 1, standardIntegrationAccounts: 1, premiumIntegrationAccounts: 1 },
      // Calculator Basic, Standard, and Premium integration-account offers are hourly integration-account prices multiplied by the 730-hour month.
      expected: async () => calculatorLogicApps({ region: 'eastus2', plan: 'consumption', actionsPerDay: 0, basicIntegrationAccounts: 1, standardIntegrationAccounts: 1, premiumIntegrationAccounts: 1 }),
    },
    {
      name: 'non-US west europe standard ws3 regional prices',
      region: 'westeurope', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'ws3', instances: 1, hours: 730 },
      // Calculator West Europe Standard WS3 uses regional vCPU and memory duration offers that differ from East US 2.
      expected: async () => calculatorLogicApps({ region: 'westeurope', plan: 'standard', hostingPlan: 'ws3', instances: 1, hours: 730 }),
    },
    {
      name: 'non-US west europe standard ws2 connectors use consumption connector rate',
      region: 'westeurope', currency: 'USD',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'ws2', instances: 2, standardConnectorCallsPerDay: 1000, enterpriseConnectorCallsPerDay: 100, hours: 730 },
      // Calculator standard-connector and enterprise-connector offers (Consumption connector rates) apply to Standard plan connector calls.
      expected: async () => calculatorLogicApps({ region: 'westeurope', plan: 'standard', hostingPlan: 'ws2', instances: 2, standardConnectorCallsPerDay: 1000, enterpriseConnectorCallsPerDay: 100, hours: 730 }),
    },
    {
      name: 'non-US west europe hybrid with connectors',
      region: 'westeurope', currency: 'USD',
      component: { type: 'logic-apps', plan: 'hybrid', hybridVcpus: 4, standardConnectorCallsPerDay: 1000, enterpriseConnectorCallsPerDay: 100, hours: 730 },
      // Hybrid vCPU duration plus Consumption standard connector rate.
      expected: async () => calculatorLogicApps({ region: 'westeurope', plan: 'hybrid', hybridVcpus: 4, standardConnectorCallsPerDay: 1000, enterpriseConnectorCallsPerDay: 100, hours: 730 }),
    },
    {
      name: 'non-US west europe integration accounts for 100 hours',
      region: 'westeurope', currency: 'USD',
      component: { type: 'logic-apps', plan: 'consumption', actionsPerDay: 0, standardIntegrationAccounts: 1, premiumIntegrationAccounts: 1, hours: 100 },
      // Calculator integration-account offers are hourly prices, so a 100-hour month is 100 * hourly price.
      expected: async () => calculatorLogicApps({ region: 'westeurope', plan: 'consumption', actionsPerDay: 0, standardIntegrationAccounts: 1, premiumIntegrationAccounts: 1, hours: 100 }),
    },
    {
      name: 'non-US west europe ise premium with scale units',
      region: 'westeurope', currency: 'USD',
      component: { type: 'logic-apps', plan: 'ise', iseTier: 'premium', iseScaleUnits: 1, hours: 730 },
      // Calculator ISE premium base plus scale unit hourly offers in West Europe.
      expected: async () => calculatorLogicApps({ region: 'westeurope', plan: 'ise', iseTier: 'premium', iseScaleUnits: 1, hours: 730 }),
    },
    {
      name: 'EUR retail API standard ws2 connectors use consumption rates',
      region: 'westeurope', currency: 'EUR',
      component: { type: 'logic-apps', plan: 'standard', hostingPlan: 'ws2', instances: 1, standardConnectorCallsPerDay: 1000, enterpriseConnectorCallsPerDay: 100, hours: 730 },
      // Retail API EUR Standard hosting uses Standard vCPU/Memory meters, while managed connectors use the Consumption Standard/Enterprise Connector Actions meters, not Connector Namespace meters.
      expected: async () => retailLogicApps({ region: 'westeurope', currency: 'EUR', plan: 'standard', hostingPlan: 'ws2', instances: 1, standardConnectorCallsPerDay: 1000, enterpriseConnectorCallsPerDay: 100, hours: 730 }),
    },
    {
      name: 'EUR retail API hybrid connectors use consumption rates',
      region: 'westeurope', currency: 'EUR',
      component: { type: 'logic-apps', plan: 'hybrid', hybridVcpus: 4, standardConnectorCallsPerDay: 1000, enterpriseConnectorCallsPerDay: 100, hours: 730 },
      // Retail API EUR Hybrid bills Hybrid vCPU Duration plus the Consumption managed connector action meters for Standard/Enterprise connectors.
      expected: async () => retailLogicApps({ region: 'westeurope', currency: 'EUR', plan: 'hybrid', hybridVcpus: 4, standardConnectorCallsPerDay: 1000, enterpriseConnectorCallsPerDay: 100, hours: 730 }),
    },
    {
      name: 'EUR retail API consumption above free grant',
      region: 'westeurope', currency: 'EUR',
      component: { type: 'logic-apps', plan: 'consumption', actionsPerDay: 5000 / DAYS_PER_MONTH, standardConnectorCallsPerDay: 100, enterpriseConnectorCallsPerDay: 10, dataRetentionGb: 5, agentInputTokens: 2000000, agentOutputTokens: 1000000 },
      // Retail API EUR Consumption rows include a tierMinimumUnits=4,000 free Built-in Actions grant plus connector, retention, and agent token meters.
      expected: async () => retailLogicApps({ region: 'westeurope', currency: 'EUR', actionsPerDay: 5000 / DAYS_PER_MONTH, standardConnectorCallsPerDay: 100, enterpriseConnectorCallsPerDay: 10, dataRetentionGb: 5, agentInputTokens: 2000000, agentOutputTokens: 1000000 }),
    },
  ],
};


