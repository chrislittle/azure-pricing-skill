'use strict';
// Microsoft Defender for Cloud: every paid workload-protection plan in the Retail Prices API
// (serviceName 'Microsoft Defender for Cloud'). Meters are mixed: per resource-hour, per month,
// per 1M transactions, per GB, per 1K tokens, per 100 RU/s-hour and per subscription-hour.
// Some meters are Global, some regional (DNS, Key Vault, Resource Manager); Trial meters are never used.
// `hours` only scales plans that bill by runtime (servers, CSPM, containers, storage accounts, App Service,
// provisioned Cosmos DB, SQL and open-source databases outside Azure). Key Vault, Resource Manager, APIs,
// SQL on Azure, PostgreSQL and MySQL are billed for the full month.
const { rows, single, meterLine, line, meterInfo, PricingError, fmtN, HOURS, query } = require('../kit');

const n = v => Number(v || 0);
const SERVICE = 'Microsoft Defender for Cloud';
const G = 'Security';
const TX_FREE_PER_ACCOUNT = 73e6; // Defender for Storage per-account monthly transaction threshold
const SERVERLESS_RU_FACTOR = 0.00003125; // serverless RUs per month -> units of the "100 RU/s hour" meter
const API_PLANS = ['none', 'p1', 'p2', 'p3', 'p4', 'p5'];
// Included API calls per subscription per month (Azure Pricing Calculator plan list).
const API_ENTITLEMENT = { p1: 1e6, p2: 5e6, p3: 5e7, p4: 1e8, p5: 1e9 };
const MALWARE_CAP_GB = 10000; // default monthly malware-scanning limit per storage account
const PLAN_ALIASES = { p1: 'plan1', plan1: 'plan1', p2: 'plan2', plan2: 'plan2' };
const PREPURCHASE = ['5000', '10000', '25000', '50000', '75000', '100000', '150000', '200000', '275000', '350000'];
const COUNT = { def: 0, int: true, min: 0 };

module.exports = {
  type: 'defender-for-cloud',
  label: 'Microsoft Defender for Cloud (workload protection plans)',
  family: 'security',
  calculator: ['defender-for-cloud'],
  keywords: ['defender', 'defender for cloud', 'cloud security', 'server protection', 'cspm', 'threat protection', 'security posture', 'malware scanning', 'container security'],
  fields: {
    servers: { req: true, int: true, min: 0, ask: 'How many servers (virtual machines in Azure, Arc-enabled, AWS or GCP) should Defender for Cloud protect? Enter 0 if none.' },
    serversPlan: { def: 'plan2', enum: ['plan1', 'plan2'], ask: 'For servers: plan1 covers Defender for Endpoint integration and basic vulnerability assessment; plan2 adds the full set of server protections (for example file integrity monitoring, adaptive controls, agentless scanning and a daily Log Analytics data allowance). If unknown, suggest plan2 and record it as an assumption.' },
    serversWithEndpointLicense: Object.assign({}, COUNT, { ask: 'Plan2 only: how many of those servers already have a Microsoft Defender for Endpoint server license (for example via Microsoft 365 E5 or Defender for Endpoint for Servers)? They get a lower plan2 rate.' }),
    cspmResources: Object.assign({}, COUNT, { ask: 'Do they want the paid Defender CSPM (advanced security posture management, attack paths)? How many billable resources will it cover: servers, storage accounts and databases count one each; 8 functions or web apps count as 1, and 2 running serverless containers count as 1. Basic posture management is free.' }),
    containerVcores: Object.assign({}, COUNT, { ask: 'Kubernetes / container security: how many vCores do the Kubernetes worker nodes have in total (AKS, Arc, EKS, GKE)?' }),
    registryImageScans: Object.assign({}, COUNT, { ask: 'Container registry image scans a month (each new or changed image counts). 20 scans per protected vCore are included, only the rest is charged. Most customers can leave this at 0.' }),
    storageAccounts: Object.assign({}, COUNT, { ask: 'How many Azure storage accounts (Blob, Files, Data Lake Gen2) should be protected?' }),
    storageTransactions: { def: 0, int: true, min: 0, ask: 'Total storage transactions a month across those accounts (reads, writes, lists). Each account includes 73 million a month; more is charged. If unknown, suggest 0 and record it as an assumption.' },
    malwareScanGb: { def: 0, min: 0, ask: 'Only if they want on-upload malware scanning of blobs: how many GB of data are uploaded and scanned a month?' },
    sqlInstances: Object.assign({}, COUNT, { ask: 'How many SQL servers should be protected (Azure SQL logical servers, SQL managed instances, Synapse dedicated pools, SQL Server on Azure VMs or Arc-enabled)?' }),
    sqlVcoresOutsideAzure: Object.assign({}, COUNT, { ask: 'SQL Server running outside Azure and not Arc-enabled: how many vCores in total?' }),
    postgresServers: Object.assign({}, COUNT, { ask: 'How many Azure Database for PostgreSQL servers should be protected?' }),
    mysqlServers: Object.assign({}, COUNT, { ask: 'How many Azure Database for MySQL servers should be protected?' }),
    ossDbServersOutsideAzure: Object.assign({}, COUNT, { ask: 'Open-source relational database servers (PostgreSQL, MySQL) outside Azure to protect?' }),
    cosmosProvisionedRus: Object.assign({}, COUNT, { ask: 'Azure Cosmos DB: total provisioned throughput in request units per second (RU/s) across the accounts to protect.' }),
    cosmosServerlessRus: Object.assign({}, COUNT, { ask: 'Azure Cosmos DB serverless accounts: request units consumed a month (the portal shows this). They are converted to billable throughput units with a published factor.' }),
    appServiceInstances: Object.assign({}, COUNT, { ask: 'Azure App Service: how many plan instances (nodes) run apps that should be protected?' }),
    keyVaults: Object.assign({}, COUNT, { ask: 'How many Azure Key Vaults should be protected?' }),
    resourceManagerSubscriptions: Object.assign({}, COUNT, { ask: 'How many Azure subscriptions should get Resource Manager protection (detects suspicious management operations)?' }),
    dnsQueries: Object.assign({}, COUNT, { ask: 'Defender for DNS applies only to subscriptions that already had it before August 2023; for newer subscriptions DNS alerts are part of Defender for Servers plan 2. Ask only if they already use it: how many DNS queries a month?' }),
    aiTokens: Object.assign({}, COUNT, { ask: 'Protection for Azure AI services: how many AI tokens (prompt plus response) a month are processed by the protected AI resources?' }),
    apiPlan: { def: 'none', enum: API_PLANS, ask: 'API security for Azure API Management: roughly how many API calls a month does ONE subscription receive? <=1M -> p1, <=5M -> p2, <=50M -> p3, <=100M -> p4, more -> p5. Answer none if they do not need it.' },
    apiSubscriptions: { def: 1, int: true, min: 1, ask: 'How many Azure subscriptions have the API security plan enabled? Each has its own plan fee and call allowance.' },
    apiCalls: Object.assign({}, COUNT, { ask: 'API calls a month PER SUBSCRIPTION (used to check whether the chosen API plan allowance is exceeded for each subscription).' }),
    commitment: { def: 'payg', enum: ['payg'].concat(PREPURCHASE), ask: 'Will they buy a 12-month Defender for Cloud pre-purchase plan (commit units) for a discount? payg (default) or the number of commit units: 5000, 10000, 25000, 50000, 75000, 100000, 150000, 200000, 275000, 350000.' },
    hours: { def: 730, int: true, min: 1, max: 744, ask: 'Hours a month the protected resources run (730 is always on). It applies only to plans billed by runtime: servers, CSPM, containers, storage accounts, App Service, provisioned Cosmos DB, and SQL or open-source databases outside Azure. Key Vault, Resource Manager, APIs, SQL on Azure, PostgreSQL and MySQL are always billed for the full month.' }
  },
  examples: [
    { type: 'defender-for-cloud', servers: 20, serversPlan: 'plan2' },
    {
      type: 'defender-for-cloud', servers: 50, serversPlan: 'plan2', serversWithEndpointLicense: 10, cspmResources: 300, containerVcores: 64, registryImageScans: 2000,
      storageAccounts: 10, storageTransactions: 900000000, malwareScanGb: 500, sqlInstances: 4, sqlVcoresOutsideAzure: 16, postgresServers: 2, mysqlServers: 1,
      ossDbServersOutsideAzure: 1, cosmosProvisionedRus: 4000, cosmosServerlessRus: 215000000, appServiceInstances: 6, keyVaults: 5, resourceManagerSubscriptions: 3,
      dnsQueries: 20000000, aiTokens: 50000000, apiPlan: 'p2', apiSubscriptions: 2, apiCalls: 7000000, commitment: '25000'
    }
  ],
  readback: c => {
    const parts = [];
    const h = c.hours ?? HOURS;
    const plan = PLAN_ALIASES[String(c.serversPlan || 'plan2').toLowerCase().replace(/\s+/g, '')];
    if (n(c.servers)) parts.push(`${fmtN(c.servers)} server(s) on ${plan === 'plan1' ? 'plan 1' : plan === 'plan2' ? 'plan 2' : `plan "${c.serversPlan}"`}${n(c.serversWithEndpointLicense) ? `, ${fmtN(c.serversWithEndpointLicense)} of them with a Defender for Endpoint license` : ''}`);
    if (n(c.cspmResources)) parts.push(`Defender CSPM on ${fmtN(c.cspmResources)} billable resources`);
    if (n(c.containerVcores)) parts.push(`containers: ${fmtN(c.containerVcores)} worker-node vCores${n(c.registryImageScans) ? `, ${fmtN(c.registryImageScans)} registry image scans a month` : ''}`);
    if (n(c.storageAccounts)) parts.push(`${fmtN(c.storageAccounts)} storage account(s)${n(c.storageTransactions) ? `, ${fmtN(c.storageTransactions)} transactions a month` : ''}`);
    if (n(c.malwareScanGb)) parts.push(`${fmtN(c.malwareScanGb)} GB scanned for malware a month`);
    if (n(c.sqlInstances)) parts.push(`${fmtN(c.sqlInstances)} SQL server(s) on Azure (full month)`);
    if (n(c.sqlVcoresOutsideAzure)) parts.push(`${fmtN(c.sqlVcoresOutsideAzure)} vCores of SQL Server outside Azure`);
    if (n(c.postgresServers)) parts.push(`${fmtN(c.postgresServers)} PostgreSQL server(s) (full month)`);
    if (n(c.mysqlServers)) parts.push(`${fmtN(c.mysqlServers)} MySQL server(s) (full month)`);
    if (n(c.ossDbServersOutsideAzure)) parts.push(`${fmtN(c.ossDbServersOutsideAzure)} open-source database server(s) outside Azure`);
    if (n(c.cosmosProvisionedRus)) parts.push(`Cosmos DB ${fmtN(c.cosmosProvisionedRus)} provisioned RU/s`);
    if (n(c.cosmosServerlessRus)) parts.push(`Cosmos DB serverless ${fmtN(c.cosmosServerlessRus)} RUs a month`);
    if (n(c.appServiceInstances)) parts.push(`${fmtN(c.appServiceInstances)} App Service instance(s)`);
    if (n(c.keyVaults)) parts.push(`${fmtN(c.keyVaults)} Key Vault(s) (full month)`);
    if (n(c.resourceManagerSubscriptions)) parts.push(`Resource Manager protection on ${fmtN(c.resourceManagerSubscriptions)} subscription(s) (full month)`);
    if (n(c.dnsQueries)) parts.push(`${fmtN(c.dnsQueries)} DNS queries a month`);
    if (n(c.aiTokens)) parts.push(`${fmtN(c.aiTokens)} AI tokens a month`);
    if (c.apiPlan && c.apiPlan !== 'none') parts.push(`API security plan ${String(c.apiPlan).slice(1)} on ${fmtN(c.apiSubscriptions ?? 1)} subscription(s), ${fmtN(n(c.apiCalls))} API calls a month per subscription`);
    if (c.commitment && c.commitment !== 'payg') parts.push(`12-month pre-purchase of ${fmtN(Number(c.commitment))} commit units`);
    parts.push(h < HOURS ? `hourly plans running ${fmtN(h)} hours a month` : 'running all month');
    return `Defender for Cloud: ${parts.join('; ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Servers plan 2 includes only 500 MB per server per day of Log Analytics data; extra ingestion and retention are billed by Azure Monitor.',
    'Defender Experts (managed detection and response, quoted through Microsoft sales) and the 30-day free trials are not included.',
    'Defender for MariaDB is not priced: it is a retired plan.'
  ]),
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS;
    const apiPlan = String(c.apiPlan || 'none').toLowerCase();
    if (!API_PLANS.includes(apiPlan)) throw new PricingError(`apiPlan must be one of ${API_PLANS.join(', ')}.`);
    const plan = PLAN_ALIASES[String(c.serversPlan || 'plan2').toLowerCase().replace(/\s+/g, '')];
    if (!plan) throw new PricingError(`serversPlan "${c.serversPlan}" is not valid: use plan1 or plan2.`);
    const intFields = ['servers', 'serversWithEndpointLicense', 'cspmResources', 'containerVcores', 'registryImageScans', 'storageAccounts', 'storageTransactions', 'sqlInstances', 'sqlVcoresOutsideAzure', 'postgresServers', 'mysqlServers', 'ossDbServersOutsideAzure', 'cosmosProvisionedRus', 'cosmosServerlessRus', 'appServiceInstances', 'keyVaults', 'resourceManagerSubscriptions', 'dnsQueries', 'aiTokens', 'apiCalls'];
    for (const k of intFields) if (c[k] != null && (!Number.isInteger(c[k]) || c[k] < 0)) throw new PricingError(`${k} must be a whole number of 0 or more.`);
    if (!Number.isInteger(hours) || hours < 1 || hours > 744) throw new PricingError('hours must be a whole number between 1 and 744.');
    if (n(c.malwareScanGb) < 0) throw new PricingError('malwareScanGb cannot be negative.');
    if (n(c.serversWithEndpointLicense) > n(c.servers)) throw new PricingError('serversWithEndpointLicense cannot exceed servers.');
    if (n(c.serversWithEndpointLicense) && plan !== 'plan2') throw new PricingError('The Defender for Endpoint license rate only applies to servers plan 2.');
    const commitment = String(c.commitment || 'payg').toLowerCase();
    if (commitment !== 'payg' && !PREPURCHASE.includes(commitment)) throw new PricingError(`commitment must be payg or one of ${PREPURCHASE.join(', ')}.`);

    const rs = await rows(`serviceName eq '${SERVICE}' and (armRegionName eq '${ctx.region}' or armRegionName eq 'Global') and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Defender for Cloud is not priced in ${ctx.region}.`);
    const m = (product, meter, what) => single(rs.filter(r => r.productName === product && r.meterName === meter), `${what} in ${ctx.region}`);
    const P = {
      servers: 'Microsoft Defender for Servers', cspm: 'Microsoft Defender CSPM', containers: 'Microsoft Defender for Containers', storage: 'Microsoft Defender for Storage',
      sql: 'Microsoft Defender for SQL', pg: 'Microsoft Defender for PostgreSQL', my: 'Microsoft Defender for MySQL', oss: 'Defender for OSS DB NonAzure',
      cosmos: 'Microsoft Defender for Azure Cosmos DB', app: 'Microsoft Defender for App Service', kv: 'Microsoft Defender for Key Vault',
      arm: 'Microsoft Defender for Resource Manager', dns: 'Microsoft Defender for DNS', ai: 'Microsoft Defender for AI Services', apis: 'Defender for APIs'
    };
    const lines = [], notes = [];
    const hr = (what, count) => `${fmtN(count)} ${what}${hours < HOURS ? ` x ${fmtN(hours)} hours` : ' for the month'}`;
    const month = (what, count) => `${fmtN(count)} ${what} for the full month`;

    if (n(c.servers)) {
      const licensed = n(c.serversWithEndpointLicense), plain = n(c.servers) - licensed;
      if (plan === 'plan1') lines.push(meterLine(G, SERVICE, `Defender for Servers plan 1, ${hr('server(s)', n(c.servers))}`, m(P.servers, 'Standard P1 Node', 'Defender for Servers plan 1'), n(c.servers) * hours, ctx, { unit: 'server-hours' }));
      else {
        if (plain) lines.push(meterLine(G, SERVICE, `Defender for Servers plan 2, ${hr('server(s)', plain)}`, m(P.servers, 'Standard P2 Node', 'Defender for Servers plan 2'), plain * hours, ctx, { unit: 'server-hours' }));
        if (licensed) lines.push(meterLine(G, SERVICE, `Defender for Servers plan 2 with a Defender for Endpoint license, ${hr('server(s)', licensed)}`, m(P.servers, 'Standard P2 Node - MDATP Benefit', 'Defender for Servers plan 2 (Defender for Endpoint benefit)'), licensed * hours, ctx, { unit: 'server-hours' }));
      }
      notes.push('Defender for Servers is billed per server per hour while the server runs, so stopped or deallocated servers are not charged.');
    }
    if (n(c.cspmResources)) lines.push(meterLine(G, SERVICE, `Defender CSPM, ${hr('billable resource(s)', n(c.cspmResources))}`, m(P.cspm, 'Standard Node', 'Defender CSPM'), n(c.cspmResources) * hours, ctx, { unit: 'resource-hours' }));
    if (n(c.containerVcores)) lines.push(meterLine(G, SERVICE, `Defender for Containers, ${hr('worker-node vCore(s)', n(c.containerVcores))}`, m(P.containers, 'Standard vCore vCore Pack', 'Defender for Containers'), n(c.containerVcores) * hours, ctx, { unit: 'vCore-hours' }));
    if (n(c.registryImageScans)) {
      const chargedVcores = n(c.containerVcores) * hours / HOURS;
      const free = 20 * chargedVcores, extra = Math.max(0, n(c.registryImageScans) - free);
      if (extra > 0) lines.push(meterLine(G, SERVICE, `Container registry image scans above the included 20 per charged vCore, ${fmtN(Math.round(extra * 100) / 100)} scan(s) a month`, m(P.containers, 'Standard Images', 'Defender for Containers extra image scans'), extra, ctx, { unit: 'image scans' }));
      else notes.push(`The ${fmtN(n(c.registryImageScans))} registry image scans fit inside the ${fmtN(Math.round(free))} included with the protected vCores, so there is no extra scan charge.`);
    }
    let malwareOverCap = 0;
    if (n(c.storageAccounts)) {
      lines.push(meterLine(G, SERVICE, `Defender for Storage, ${hr('storage account(s)', n(c.storageAccounts))}`, m(P.storage, 'Standard Node', 'Defender for Storage'), n(c.storageAccounts) * hours, ctx, { unit: 'account-hours' }));
      const over = Math.max(0, n(c.storageTransactions) - TX_FREE_PER_ACCOUNT * n(c.storageAccounts));
      if (over > 0) lines.push(meterLine(G, SERVICE, `Storage transactions above 73 million per account, ${fmtN(over)} a month`, m(P.storage, 'Standard Transactions', 'Defender for Storage transactions'), over, ctx, { unit: 'transactions' }));
      notes.push('Defender for Storage includes 73 million transactions a month per storage account; the estimate spreads your total evenly across the accounts.');
    } else if (n(c.storageTransactions)) throw new PricingError('storageTransactions needs storageAccounts above 0.');
    if (n(c.malwareScanGb)) {
      if (!n(c.storageAccounts)) throw new PricingError('Malware scanning is an add-on to Defender for Storage: set storageAccounts above 0.');
      lines.push(meterLine(G, SERVICE, `Defender for Storage malware scanning, ${fmtN(n(c.malwareScanGb))} GB scanned a month`, m(P.storage, 'Malware Scanning Data Ingested', 'Defender for Storage malware scanning'), n(c.malwareScanGb), ctx, { unit: 'GB' }));
      if (n(c.malwareScanGb) > MALWARE_CAP_GB * n(c.storageAccounts)) {
        malwareOverCap = 1;
        notes.push(`By default malware scanning stops after ${fmtN(MALWARE_CAP_GB)} GB of uploaded blobs per storage account a month (the limit can be changed), so scanning more than ${fmtN(MALWARE_CAP_GB * n(c.storageAccounts))} GB across ${fmtN(n(c.storageAccounts))} account(s) needs a higher cap; the estimate prices all ${fmtN(n(c.malwareScanGb))} GB.`);
      }
    }
    // Monthly-billed database plans use the full-month meters; `hours` does not apply.
    if (n(c.sqlInstances)) lines.push(meterLine(G, SERVICE, `Defender for SQL on Azure, ${month('SQL server(s)', n(c.sqlInstances))}`, m(P.sql, 'Standard Node', 'Defender for SQL on Azure'), n(c.sqlInstances), ctx, { unit: 'server-months' }));
    if (n(c.sqlVcoresOutsideAzure)) lines.push(meterLine(G, SERVICE, `Defender for SQL outside Azure (not Arc-enabled), ${hr('vCore(s)', n(c.sqlVcoresOutsideAzure))}`, m(P.sql, 'Standard vCore', 'Defender for SQL outside Azure'), n(c.sqlVcoresOutsideAzure) * hours, ctx, { unit: 'vCore-hours' }));
    if (n(c.postgresServers)) lines.push(meterLine(G, SERVICE, `Defender for PostgreSQL, ${month('server(s)', n(c.postgresServers))}`, m(P.pg, 'Standard Node', 'Defender for PostgreSQL'), n(c.postgresServers), ctx, { unit: 'server-months' }));
    if (n(c.mysqlServers)) lines.push(meterLine(G, SERVICE, `Defender for MySQL, ${month('server(s)', n(c.mysqlServers))}`, m(P.my, 'Standard Node', 'Defender for MySQL'), n(c.mysqlServers), ctx, { unit: 'server-months' }));
    if (n(c.ossDbServersOutsideAzure)) lines.push(meterLine(G, SERVICE, `Defender for open-source databases outside Azure, ${hr('server(s)', n(c.ossDbServersOutsideAzure))}`, m(P.oss, 'Standard Node', 'Defender for open-source databases outside Azure'), n(c.ossDbServersOutsideAzure) * hours, ctx, { unit: 'server-hours' }));
    if (n(c.cosmosProvisionedRus)) lines.push(meterLine(G, SERVICE, `Defender for Cosmos DB, ${fmtN(n(c.cosmosProvisionedRus))} provisioned RU/s${hours < HOURS ? `, ${fmtN(hours)} hours` : ''}`,
      m(P.cosmos, 'Standard 100 RU/s', 'Defender for Cosmos DB'), (n(c.cosmosProvisionedRus) / 100) * hours, ctx, { unit: '100 RU/s-hours' }));
    if (n(c.cosmosServerlessRus)) {
      const units = n(c.cosmosServerlessRus) * SERVERLESS_RU_FACTOR;
      lines.push(meterLine(G, SERVICE, `Defender for Cosmos DB serverless, ${fmtN(n(c.cosmosServerlessRus))} RUs a month x 0.00003125 = ${fmtN(Math.round(units * 100) / 100)} billable units`,
        m(P.cosmos, 'Standard 100 RU/s', 'Defender for Cosmos DB serverless'), units, ctx, { unit: 'billable units' }));
      notes.push('Serverless Cosmos DB request units are multiplied by 0.00003125 and priced at the per-100-RU/s rate, as in the published pricing example.');
    }
    if (n(c.appServiceInstances)) lines.push(meterLine(G, SERVICE, `Defender for App Service, ${hr('instance(s)', n(c.appServiceInstances))}`, m(P.app, 'Standard Node', 'Defender for App Service'), n(c.appServiceInstances) * hours, ctx, { unit: 'instance-hours' }));
    if (n(c.keyVaults)) lines.push(meterLine(G, SERVICE, `Defender for Key Vault, ${month('vault(s)', n(c.keyVaults))}`, m(P.kv, 'Per node Std Node', 'Defender for Key Vault'), n(c.keyVaults) * HOURS, ctx, { unit: 'vault-hours' }));
    if (n(c.resourceManagerSubscriptions)) lines.push(meterLine(G, SERVICE, `Defender for Resource Manager, ${month('subscription(s)', n(c.resourceManagerSubscriptions))}`, m(P.arm, 'Per node Std Node', 'Defender for Resource Manager'), n(c.resourceManagerSubscriptions) * HOURS, ctx, { unit: 'subscription-hours' }));
    if (n(c.dnsQueries)) lines.push(meterLine(G, SERVICE, `Defender for DNS, ${fmtN(n(c.dnsQueries))} queries a month`, m(P.dns, 'Standard Queries', 'Defender for DNS'), n(c.dnsQueries), ctx, { unit: 'queries' }));
    if (n(c.aiTokens)) lines.push(meterLine(G, SERVICE, `Defender for AI services, ${fmtN(n(c.aiTokens))} tokens a month`, m(P.ai, 'Standard Tokens', 'Defender for AI services'), n(c.aiTokens), ctx, { unit: 'tokens' }));

    let apiEntitlement = 0;
    if (apiPlan !== 'none') {
      const N = apiPlan.toUpperCase(), subs = n(c.apiSubscriptions ?? 1);
      if (!Number.isInteger(subs) || subs < 1) throw new PricingError('apiSubscriptions must be a whole number of 1 or more when an API plan is chosen.');
      const fee = m(P.apis, `Per Sub Billing ${N} Subscription`, `Defender for APIs plan ${N[1]}`);
      lines.push(meterLine(G, SERVICE, `Defender for APIs plan ${N[1]}, ${month('subscription(s)', subs)}`, fee, subs * HOURS, ctx, { unit: 'subscription-hours' }));
      apiEntitlement = API_ENTITLEMENT[apiPlan];
      const over = Math.max(0, n(c.apiCalls) - apiEntitlement);
      if (over > 0) {
        const ovg = m(P.apis, `Per Sub Billing Ovg ${N} Event`, `Defender for APIs plan ${N[1]} overage`);
        lines.push(meterLine(G, SERVICE, `Defender for APIs plan ${N[1]} overage, ${fmtN(over)} calls above the ${fmtN(apiEntitlement)} included, in each of ${fmtN(subs)} subscription(s)`, ovg, over * subs, ctx, { unit: 'API calls' }));
      }
      notes.push(`Defender for APIs charges a flat monthly fee per subscription that includes ${fmtN(apiEntitlement)} API calls; calls above that are billed per call. The call count you give is per subscription.`);
    }

    if (!lines.length) throw new PricingError('Nothing to price: set at least one Defender plan quantity (for example servers).');

    let prepurchase = null;
    if (commitment !== 'payg') {
      const sku = `${Number(commitment).toLocaleString('en-US')} DCUs`;
      const filter = `serviceName eq '${SERVICE}' and armRegionName eq 'Global' and priceType eq 'Reservation' and skuName eq '${sku}'`;
      const row = single(await rows(filter, ctx), `Defender for Cloud pre-purchase plan ${sku}`)[0];
      // Commit units are worth their US dollar face value; convert to the estimate currency with the reservation's own rate.
      let rate = 1;
      if (String(ctx.currency || 'USD').toUpperCase() !== 'USD') {
        const usd = single((await query(filter, 'USD')).filter(r => r.skuName === sku), `Defender for Cloud pre-purchase plan ${sku} (USD)`)[0];
        rate = usd && usd.retailPrice > 0 ? row.retailPrice / usd.retailPrice : 1;
      }
      const covered = Number(commitment) / 12 * rate;
      const usage = lines.reduce((s, l) => s + l.list, 0);
      const remaining = usage > 0 ? Math.max(0, usage - covered) / usage : 1;
      for (const l of lines) { l.list *= remaining; l.desc += ' (after pre-purchase drawdown)'; }
      lines.push(line(G, SERVICE, `Defender for Cloud pre-purchase plan, ${sku}, 12-month price spread over 12 months`, 1, 'month (1/12 of 12-month price)', row.retailPrice / 12, row.retailPrice / 12, meterInfo(row)));
      notes.push(`Pre-purchased commit units are used up at pay-as-you-go prices: the estimate assumes ${fmtN(Math.round(Number(commitment) / 12))} commit units (their face value in US dollars) are used each month, and only usage above that is billed on top of the 12-month purchase price.`);
      prepurchase = { usage };
    }
    notes.push('The 30-day free trial of each plan is not included.');
    return {
      lines, notes,
      facts: {
        servers: n(c.servers), serversPlan: plan, apiPlan, apiCalls: n(c.apiCalls), apiEntitlement, apiSubscriptions: n(c.apiSubscriptions ?? 1),
        storageAccounts: n(c.storageAccounts), malwareScanGb: n(c.malwareScanGb), malwareOverCap, dnsQueries: n(c.dnsQueries),
        dnsWithPlan2: n(c.dnsQueries) > 0 && n(c.servers) > 0 && plan === 'plan2' ? 1 : 0,
        containerVcores: n(c.containerVcores), cspmResources: n(c.cspmResources), commitment, hours,
        monthlyPayg: prepurchase ? prepurchase.usage : undefined
      }
    };
  }
};
