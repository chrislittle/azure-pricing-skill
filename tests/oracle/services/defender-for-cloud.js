'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS_PER_MONTH = 730;
const STORAGE_INCLUDED_TRANSACTIONS = 73_000_000;
const CONTAINER_INCLUDED_SCANS_PER_VCORE = 20;
const COSMOS_SERVERLESS_TO_100_RU_HOUR_UNITS = 0.00003125;
const API_ALLOWANCE = { p1: 1_000_000, p2: 5_000_000, p3: 50_000_000, p4: 100_000_000, p5: 1_000_000_000 };

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one Retail API row for ${what}, found ${hits.length}`);
  return hits[0];
}

async function defenderRows(productName, currency) {
  return dedupe(await query(`serviceName eq 'Microsoft Defender for Cloud' and productName eq '${productName}'`, currency));
}

function regionMatch(row, region) {
  return row.armRegionName === region || row.armRegionName === 'Global' || !row.armRegionName;
}

async function defenderMeter({ productName, skuName, meterName, region, currency = 'USD', type = 'Consumption' }) {
  const rows = (await defenderRows(productName, currency)).filter(r => regionMatch(r, region) && r.type === type);
  const exactRegion = rows.filter(r => r.armRegionName === region);
  const source = exactRegion.length ? exactRegion : rows;
  return pickOne(source, r => r.skuName === skuName && r.meterName === meterName, `${productName} / ${skuName} / ${meterName} in ${region}`);
}

async function apiMeters(apiPlan, region, currency) {
  const cap = await defenderMeter({ productName: 'Defender for APIs', skuName: `Per Sub Billing ${apiPlan.toUpperCase()}`, meterName: `Per Sub Billing ${apiPlan.toUpperCase()} Subscription`, region, currency });
  const overage = await defenderMeter({ productName: 'Defender for APIs', skuName: `Per Sub Billing Ovg ${apiPlan.toUpperCase()}`, meterName: `Per Sub Billing Ovg ${apiPlan.toUpperCase()} Event`, region, currency });
  return { cap, overage };
}

async function defenderForCloud({
  region = 'eastus2', currency = 'USD', hours = HOURS_PER_MONTH,
  servers = 0, serversPlan = 'plan2', serversWithEndpointLicense = 0,
  cspmResources = 0, containerVcores = 0, registryImageScans = 0,
  storageAccounts = 0, storageTransactions = 0, malwareScanGb = 0,
  sqlInstances = 0, sqlVcoresOutsideAzure = 0, postgresServers = 0, mysqlServers = 0, ossDbServersOutsideAzure = 0,
  cosmosProvisionedRus = 0, cosmosServerlessRus = 0, appServiceInstances = 0, keyVaults = 0, resourceManagerSubscriptions = 0,
  dnsQueries = 0, aiTokens = 0, apiPlan = 'none', apiSubscriptions = 1, apiCalls = 0, commitment = 'payg',
}) {
  let lines = [];
  const hourly = (qty, meter) => (qty * hours / unitSize(meter.unitOfMeasure)) * meter.retailPrice;
  const monthlyHourly = (qty, meter) => (qty * HOURS_PER_MONTH / unitSize(meter.unitOfMeasure)) * meter.retailPrice;

  if (servers) {
    if (serversPlan === 'plan1') {
      const m = await defenderMeter({ productName: 'Microsoft Defender for Servers', skuName: 'Standard P1', meterName: 'Standard P1 Node', region, currency });
      lines.push(line(`Defender for Servers P1: ${servers} nodes * ${hours} hours * ${m.retailPrice}`, hourly(servers, m), { meterId: m.meterId }));
    } else {
      const standard = Math.max(0, servers - serversWithEndpointLicense);
      if (standard) {
        const m = await defenderMeter({ productName: 'Microsoft Defender for Servers', skuName: 'Standard P2', meterName: 'Standard P2 Node', region, currency });
        lines.push(line(`Defender for Servers P2: ${standard} nodes * ${hours} hours * ${m.retailPrice}`, hourly(standard, m), { meterId: m.meterId }));
      }
      if (serversWithEndpointLicense) {
        const m = await defenderMeter({ productName: 'Microsoft Defender for Servers', skuName: 'Standard P2', meterName: 'Standard P2 Node - MDATP Benefit', region, currency });
        lines.push(line(`Defender for Servers P2 MDE benefit: ${serversWithEndpointLicense} nodes * ${hours} hours * ${m.retailPrice}`, hourly(serversWithEndpointLicense, m), { meterId: m.meterId }));
      }
    }
  }

  if (cspmResources) {
    const m = await defenderMeter({ productName: 'Microsoft Defender CSPM', skuName: 'Standard', meterName: 'Standard Node', region, currency });
    lines.push(line(`Defender CSPM: ${cspmResources} resources * ${hours} hours * ${m.retailPrice}`, hourly(cspmResources, m), { meterId: m.meterId }));
  }

  if (containerVcores) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Containers', skuName: 'Standard vCore', meterName: 'Standard vCore vCore Pack', region, currency });
    lines.push(line(`Defender for Containers: ${containerVcores} vCores * ${hours} hours * ${m.retailPrice}`, hourly(containerVcores, m), { meterId: m.meterId }));
  }
  const billableScans = Math.max(0, registryImageScans - (containerVcores * CONTAINER_INCLUDED_SCANS_PER_VCORE));
  if (billableScans) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Containers', skuName: 'Standard Images', meterName: 'Standard Images', region, currency });
    lines.push(line(`container image scan overage: (${registryImageScans} - ${containerVcores * CONTAINER_INCLUDED_SCANS_PER_VCORE}) * ${m.retailPrice}`, (billableScans / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }

  if (storageAccounts) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Storage', skuName: 'Standard', meterName: 'Standard Node', region, currency });
    lines.push(line(`Defender for Storage accounts: ${storageAccounts} accounts * ${hours} hours * ${m.retailPrice}`, hourly(storageAccounts, m), { meterId: m.meterId }));
  }
  const billableTransactions = Math.max(0, storageTransactions - (storageAccounts * STORAGE_INCLUDED_TRANSACTIONS));
  if (billableTransactions) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Storage', skuName: 'Standard', meterName: 'Standard Transactions', region, currency });
    lines.push(line(`storage transaction overage: ${billableTransactions} / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (billableTransactions / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (malwareScanGb) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Storage', skuName: 'Malware Scanning', meterName: 'Malware Scanning Data Ingested', region, currency });
    lines.push(line(`malware scanning: ${malwareScanGb} GB * ${m.retailPrice}`, (malwareScanGb / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }

  if (sqlInstances) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for SQL', skuName: 'Standard', meterName: 'Standard Node', region, currency });
    lines.push(line(`Defender for SQL Azure-connected servers: ${sqlInstances} servers * ${m.retailPrice}/month`, sqlInstances * m.retailPrice, { meterId: m.meterId }));
  }
  if (sqlVcoresOutsideAzure) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for SQL', skuName: 'Standard', meterName: 'Standard vCore', region, currency });
    lines.push(line(`Defender for SQL outside Azure: ${sqlVcoresOutsideAzure} vCores * ${hours} hours * ${m.retailPrice}`, hourly(sqlVcoresOutsideAzure, m), { meterId: m.meterId }));
  }
  if (postgresServers) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for PostgreSQL', skuName: 'Standard', meterName: 'Standard Node', region, currency });
    lines.push(line(`Defender for PostgreSQL: ${postgresServers} servers * ${m.retailPrice}/month`, postgresServers * m.retailPrice, { meterId: m.meterId }));
  }
  if (mysqlServers) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for MySQL', skuName: 'Standard', meterName: 'Standard Node', region, currency });
    lines.push(line(`Defender for MySQL: ${mysqlServers} servers * ${m.retailPrice}/month`, mysqlServers * m.retailPrice, { meterId: m.meterId }));
  }
  if (ossDbServersOutsideAzure) {
    const m = await defenderMeter({ productName: 'Defender for OSS DB NonAzure', skuName: 'Standard', meterName: 'Standard Node', region, currency });
    lines.push(line(`Defender for OSS DB outside Azure: ${ossDbServersOutsideAzure} servers * ${hours} hours * ${m.retailPrice}`, hourly(ossDbServersOutsideAzure, m), { meterId: m.meterId }));
  }

  if (cosmosProvisionedRus) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Azure Cosmos DB', skuName: 'Standard', meterName: 'Standard 100 RU/s', region, currency });
    lines.push(line(`Defender for Cosmos DB provisioned: ${cosmosProvisionedRus} RU/s / 100 * ${hours} hours * ${m.retailPrice}`, ((cosmosProvisionedRus / 100) * hours / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (cosmosServerlessRus) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Azure Cosmos DB', skuName: 'Standard', meterName: 'Standard 100 RU/s', region, currency });
    lines.push(line(`Defender for Cosmos DB serverless: ${cosmosServerlessRus} RUs * ${COSMOS_SERVERLESS_TO_100_RU_HOUR_UNITS} * ${m.retailPrice}`, cosmosServerlessRus * COSMOS_SERVERLESS_TO_100_RU_HOUR_UNITS * m.retailPrice, { meterId: m.meterId }));
  }

  if (appServiceInstances) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for App Service', skuName: 'Standard', meterName: 'Standard Node', region, currency });
    lines.push(line(`Defender for App Service: ${appServiceInstances} instances * ${hours} hours * ${m.retailPrice}`, hourly(appServiceInstances, m), { meterId: m.meterId }));
  }
  if (keyVaults) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Key Vault', skuName: 'Per node Std', meterName: 'Per node Std Node', region, currency });
    lines.push(line(`Defender for Key Vault: ${keyVaults} vaults for the month * ${HOURS_PER_MONTH} hours * ${m.retailPrice}`, monthlyHourly(keyVaults, m), { meterId: m.meterId }));
  }
  if (resourceManagerSubscriptions) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for Resource Manager', skuName: 'Per node Std', meterName: 'Per node Std Node', region, currency });
    lines.push(line(`Defender for Resource Manager: ${resourceManagerSubscriptions} subscriptions for the month * ${HOURS_PER_MONTH} hours * ${m.retailPrice}`, monthlyHourly(resourceManagerSubscriptions, m), { meterId: m.meterId }));
  }
  if (dnsQueries) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for DNS', skuName: 'Standard', meterName: 'Standard Queries', region, currency });
    lines.push(line(`Defender for DNS: ${dnsQueries} queries / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (dnsQueries / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (aiTokens) {
    const m = await defenderMeter({ productName: 'Microsoft Defender for AI Services', skuName: 'Standard', meterName: 'Standard Tokens', region, currency });
    lines.push(line(`Defender for AI Services: ${aiTokens} tokens / ${unitSize(m.unitOfMeasure)} * ${m.retailPrice}`, (aiTokens / unitSize(m.unitOfMeasure)) * m.retailPrice, { meterId: m.meterId }));
  }
  if (apiPlan !== 'none') {
    const { cap, overage } = await apiMeters(apiPlan, region, currency);
    lines.push(line(`Defender for APIs ${apiPlan}: ${apiSubscriptions} subscriptions for the month * ${HOURS_PER_MONTH} hours * ${cap.retailPrice}`, apiSubscriptions * monthlyHourly(1, cap), { meterId: cap.meterId }));
    const overageCalls = apiSubscriptions * Math.max(0, apiCalls - API_ALLOWANCE[apiPlan]);
    if (overageCalls) lines.push(line(`Defender for APIs ${apiPlan} overage: ${apiSubscriptions} subscriptions * max(0, ${apiCalls} - ${API_ALLOWANCE[apiPlan]}) calls * ${overage.retailPrice}`, overageCalls * overage.retailPrice, { meterId: overage.meterId }));
  }

  if (commitment !== 'payg') {
    const retailBeforeCommitment = totalOf(lines);
    const dcu = Number(commitment);
    const reserve = await defenderMeter({ productName: 'Microsoft Defender for Cloud Pre-Purchase Plan', skuName: `${dcu.toLocaleString('en-US')} DCUs`, meterName: `${dcu.toLocaleString('en-US')} DCUs Defender Commit Unit`, region, currency, type: 'Reservation' });
    const monthlyCommitmentList = reserve.retailPrice / 12;
    const reserveUsd = currency === 'USD' ? reserve : await defenderMeter({ productName: 'Microsoft Defender for Cloud Pre-Purchase Plan', skuName: `${dcu.toLocaleString('en-US')} DCUs`, meterName: `${dcu.toLocaleString('en-US')} DCUs Defender Commit Unit`, region, currency: 'USD', type: 'Reservation' });
    const currencyPerUsd = reserve.retailPrice / reserveUsd.retailPrice;
    const monthlyDcuValue = (dcu * currencyPerUsd) / 12;
    const overage = Math.max(0, retailBeforeCommitment - monthlyDcuValue);
    lines = [line(`Defender for Cloud pre-purchase plan: ${dcu.toLocaleString('en-US')} DCUs annual price ${reserve.retailPrice} / 12`, monthlyCommitmentList, { meterId: reserve.meterId })];
    if (overage) lines.push(line(`Defender for Cloud pay-as-you-go overage after ${monthlyDcuValue} monthly DCUs`, overage));
  }

  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'defender-for-cloud',
  source: 'retail-api',
  cases: [
    {
      name: 'servers plan1 full month', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 10, serversPlan: 'plan1' },
      // Retail API Standard P1 Node is a per-node-hour meter; oracle month is 730 hours.
      expected: async () => defenderForCloud({ servers: 10, serversPlan: 'plan1' }),
    },
    {
      name: 'servers plan2 with endpoint-license benefit and cspm part-time', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 10, serversPlan: 'plan2', serversWithEndpointLicense: 3, cspmResources: 20, hours: 100 },
      // Retail API P2 has separate Standard P2 Node and MDATP Benefit hourly meters; CSPM is Standard Node hourly.
      expected: async () => defenderForCloud({ servers: 10, serversPlan: 'plan2', serversWithEndpointLicense: 3, cspmResources: 20, hours: 100 }),
    },
    {
      name: 'containers at included image-scan boundary', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, containerVcores: 10, registryImageScans: 200 },
      // Pricing docs include 20 registry vulnerability assessments per charged vCore; 10 vCores include exactly 200 scans.
      expected: async () => defenderForCloud({ containerVcores: 10, registryImageScans: 200 }),
    },
    {
      name: 'containers above image-scan grant and storage above transaction grant', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, containerVcores: 10, registryImageScans: 205, storageAccounts: 2, storageTransactions: 150000000, malwareScanGb: 100 },
      // Retail API bills vCore-hours plus image scans after 20/vCore; Storage bills account-hours, transactions after 73M/account, and malware-scan GB.
      expected: async () => defenderForCloud({ containerVcores: 10, registryImageScans: 205, storageAccounts: 2, storageTransactions: 150000000, malwareScanGb: 100 }),
    },
    {
      name: 'database and platform protections in west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, sqlInstances: 2, sqlVcoresOutsideAzure: 4, postgresServers: 1, mysqlServers: 1, ossDbServersOutsideAzure: 2, cosmosProvisionedRus: 1000, cosmosServerlessRus: 1000000, appServiceInstances: 3, keyVaults: 5, resourceManagerSubscriptions: 2, dnsQueries: 2000000, aiTokens: 2500000 },
      // Retail API rows cover SQL connected-server monthly nodes, SQL vCore-hours, PostgreSQL/MySQL monthly nodes, OSS DB node-hours, Cosmos provisioned 100 RU/s-hours, App Service node-hours, full-month Key Vault/Resource Manager, DNS 1M queries, and AI 1K tokens; Cosmos serverless uses the pricing-page factor: RUs × 0.00003125 of the 100 RU/s-hour meter, so 215M RUs × 0.00003125 × $0.0012 = $8.06.
      expected: async () => defenderForCloud({ region: 'westeurope', sqlInstances: 2, sqlVcoresOutsideAzure: 4, postgresServers: 1, mysqlServers: 1, ossDbServersOutsideAzure: 2, cosmosProvisionedRus: 1000, cosmosServerlessRus: 1000000, appServiceInstances: 3, keyVaults: 5, resourceManagerSubscriptions: 2, dnsQueries: 2000000, aiTokens: 2500000 }),
    },
    {
      name: 'cosmos serverless pricing page example', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, cosmosServerlessRus: 215000000 },
      // Defender for Cloud pricing page example gives 215M serverless RUs = $8.06: RUs × 0.00003125 of the 100 RU/s-hour Retail API meter.
      expected: async () => defenderForCloud({ cosmosServerlessRus: 215000000 }),
    },
    {
      name: 'part-month hours do not prorate monthly-billed plans', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, keyVaults: 1, resourceManagerSubscriptions: 1, apiPlan: 'p1', apiSubscriptions: 1, apiCalls: 0, postgresServers: 1, mysqlServers: 1, hours: 100 },
      // PostgreSQL/MySQL are monthly node meters; Key Vault, Resource Manager and Defender for APIs are monthly Defender plan fees and should use a full 730-hour month even when other hourly plans use part-month hours.
      expected: async () => defenderForCloud({ keyVaults: 1, resourceManagerSubscriptions: 1, apiPlan: 'p1', apiSubscriptions: 1, apiCalls: 0, postgresServers: 1, mysqlServers: 1, hours: 100 }),
    },
    {
      name: 'pre-purchase plan eur', region: 'westeurope', currency: 'EUR',
      component: { type: 'defender-for-cloud', servers: 1, serversPlan: 'plan1', commitment: '5000' },
      // Learn says Defender for Cloud pre-purchase is a one-year DCU plan; Retail API Reservation price is annual, so the monthly oracle spreads the EUR 5,000-DCU price over 12 months and the small server charge draws down from the DCU pool; the DCU drawdown value is converted to the estimate currency with the Retail API reservation currency ratio.
      expected: async () => defenderForCloud({ region: 'westeurope', currency: 'EUR', servers: 1, serversPlan: 'plan1', commitment: '5000' }),
    },
    {
      name: 'eur api plan p2 beyond allowance per subscription', region: 'westeurope', currency: 'EUR',
      component: { type: 'defender-for-cloud', servers: 0, apiPlan: 'p2', apiSubscriptions: 2, apiCalls: 5010000 },
      // Defender for APIs allowance is per subscription; two subscriptions each get 5M included calls, so 10,000 overage calls per subscription are billed in EUR.
      expected: async () => defenderForCloud({ region: 'westeurope', currency: 'EUR', apiPlan: 'p2', apiSubscriptions: 2, apiCalls: 5010000 }),
    },
    {
      name: 'multiple api subscriptions allowance per subscription', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, apiPlan: 'p1', apiSubscriptions: 2, apiCalls: 1010000 },
      // apiCalls is per subscription: two Plan 1 subscriptions each include 1M calls, leaving 10,000 overage calls per subscription.
      expected: async () => defenderForCloud({ apiPlan: 'p1', apiSubscriptions: 2, apiCalls: 1010000 }),
    },
    {
      name: 'api plan p1 at included calls', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, apiPlan: 'p1', apiSubscriptions: 1, apiCalls: 1000000 },
      // Defender for APIs docs state Plan 1 includes one million monthly API calls; Retail API subscription meter is hourly and no overage is due at the boundary.
      expected: async () => defenderForCloud({ apiPlan: 'p1', apiSubscriptions: 1, apiCalls: 1000000 }),
    },
    {
      name: 'api plan p2 above included calls', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, apiPlan: 'p2', apiSubscriptions: 1, apiCalls: 5000001 },
      // Plan 2 entitlement is 5M monthly calls; Retail API adds one Per Sub Billing Ovg P2 Event above the allowance.
      expected: async () => defenderForCloud({ apiPlan: 'p2', apiSubscriptions: 1, apiCalls: 5000001 }),
    },
    {
      name: 'api plan p3 above included calls', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, apiPlan: 'p3', apiSubscriptions: 1, apiCalls: 50000001 },
      // Plan 3 entitlement is 50M monthly calls; overage is the count above 50M times the Retail API Ovg P3 Event meter.
      expected: async () => defenderForCloud({ apiPlan: 'p3', apiSubscriptions: 1, apiCalls: 50000001 }),
    },
    {
      name: 'api plan p4 above included calls', region: 'eastus2', currency: 'USD',
      component: { type: 'defender-for-cloud', servers: 0, apiPlan: 'p4', apiSubscriptions: 1, apiCalls: 100000001 },
      // Plan 4 entitlement is 100M monthly calls; overage is the count above 100M times the Retail API Ovg P4 Event meter.
      expected: async () => defenderForCloud({ apiPlan: 'p4', apiSubscriptions: 1, apiCalls: 100000001 }),
    },
    {
      name: 'api plan p5 eur overage', region: 'westeurope', currency: 'EUR',
      component: { type: 'defender-for-cloud', servers: 0, apiPlan: 'p5', apiSubscriptions: 1, apiCalls: 1000000001 },
      // EUR Retail API rows: Plan 5 subscription-hours plus one API call above the 1B monthly entitlement at the Ovg P5 Event meter.
      expected: async () => defenderForCloud({ region: 'westeurope', currency: 'EUR', apiPlan: 'p5', apiSubscriptions: 1, apiCalls: 1000000001 }),
    },
  ],
};
