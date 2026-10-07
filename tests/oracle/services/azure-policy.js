'use strict';

const { query, dedupe, round2 } = require('../api');

const HOURS_PER_MONTH = 730;

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

function priceScope(region) {
  return String(region || '').toLowerCase().startsWith('usgov') ? 'US Gov' : 'Global';
}

async function azurePolicy({ region = 'eastus2', guestConfigServers = 0, exemptServers = 0, kubernetesVcpus = 0, kubernetesClusters = 1, premiumP1Resources = 0, premiumP2Resources = 0, hours = HOURS_PER_MONTH, currency = 'USD' }) {
  const rows = dedupe(await query(`serviceName eq 'Azure Policy' and armRegionName eq '${priceScope(region)}'`, currency));
  const lines = [];

  if (guestConfigServers) {
    const row = pickOne(rows, r => r.skuName === 'Server' && r.meterName === 'Guest Configuration Policy/Server', 'guest configuration server');
    const chargedServers = Math.max(0, guestConfigServers - exemptServers);
    lines.push(line(`Guest configuration Arc servers: ${chargedServers} charged of ${guestConfigServers} total * ${hours}/${HOURS_PER_MONTH} month * ${row.retailPrice}`, chargedServers * (hours / HOURS_PER_MONTH) * row.retailPrice, { meterId: row.meterId }));
    if (exemptServers) lines.push(line(`Guest configuration exempt servers: ${exemptServers} free`, 0));
  }
  if (kubernetesVcpus) {
    const row = pickOne(rows, r => r.skuName === 'K8s' && r.meterName === 'Kubernetes Policy/vCPU/Month' && r.tierMinimumUnits === 6, 'paid Kubernetes vCPU-month');
    const freeVcpus = Math.max(0, kubernetesClusters) * 6;
    const chargedVcpus = Math.max(0, kubernetesVcpus - freeVcpus);
    lines.push(line(`Arc Kubernetes policy: ${chargedVcpus} charged vCPU-months of ${kubernetesVcpus} total (${freeVcpus} free across ${kubernetesClusters} cluster(s)) * ${row.retailPrice}`, chargedVcpus * row.retailPrice, { meterId: row.meterId }));
  }
  if (premiumP1Resources) {
    const row = pickOne(rows, r => r.skuName === 'Premium P1 Tier' && r.meterName === 'Premium P1 Tier Resource', 'Premium P1 resource');
    lines.push(line(`Premium P1 resources: ${premiumP1Resources} * ${row.retailPrice}`, premiumP1Resources * row.retailPrice, { meterId: row.meterId }));
  }
  if (premiumP2Resources) {
    const row = pickOne(rows, r => r.skuName === 'Premium P2 Tier' && r.meterName === 'Premium P2 Tier Resource', 'Premium P2 resource');
    lines.push(line(`Premium P2 resources: ${premiumP2Resources} * ${row.retailPrice}`, premiumP2Resources * row.retailPrice, { meterId: row.meterId }));
  }

  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'azure-policy',
  source: 'retail-api',
  cases: [
    {
      name: 'guest configuration full-month Arc servers',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-policy', guestConfigServers: 3 },
      // Retail API Global Guest Configuration Policy/Server is per server-month; full month uses 730/730.
      expected: async () => azurePolicy({ region: 'eastus2', guestConfigServers: 3 }),
    },
    {
      name: 'guest configuration part-time hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-policy', guestConfigServers: 2, hours: 365 },
      // Public component exposes hours; prorate the Global server-month meter by 365/730.
      expected: async () => azurePolicy({ region: 'eastus2', guestConfigServers: 2, hours: 365 }),
    },
    {
      name: 'exempt guest configuration servers are free',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-policy', guestConfigServers: 5, exemptServers: 2 },
      // Retail API server-month meter applies only to non-exempt Arc servers; exempt machine-configuration cases are free.
      expected: async () => azurePolicy({ region: 'eastus2', guestConfigServers: 5, exemptServers: 2 }),
    },
    {
      name: 'kubernetes vCPU at free boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-policy', guestConfigServers: 0, kubernetesVcpus: 6, kubernetesClusters: 1 },
      // Retail API paid Kubernetes Policy/vCPU/Month starts after 6 free vCPUs per Arc-enabled Kubernetes cluster.
      expected: async () => azurePolicy({ region: 'eastus2', kubernetesVcpus: 6, kubernetesClusters: 1 }),
    },
    {
      name: 'four Kubernetes clusters at per-cluster free boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-policy', guestConfigServers: 0, kubernetesVcpus: 24, kubernetesClusters: 4 },
      // Four clusters get 4 * 6 free vCPUs, so 24 total vCPUs have no paid Kubernetes vCPU-months.
      expected: async () => azurePolicy({ region: 'eastus2', kubernetesVcpus: 24, kubernetesClusters: 4 }),
    },
    {
      name: 'kubernetes vCPU just above free boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-policy', guestConfigServers: 0, kubernetesVcpus: 7, kubernetesClusters: 1 },
      // One cluster gets 6 free vCPUs, then one vCPU-month at the paid K8s row.
      expected: async () => azurePolicy({ region: 'eastus2', kubernetesVcpus: 7, kubernetesClusters: 1 }),
    },
    {
      name: 'premium P1 and P2 resources',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'azure-policy', guestConfigServers: 0, premiumP1Resources: 10, premiumP2Resources: 10 },
      // Retail API Premium P1 Tier Resource and Premium P2 Tier Resource are flat resource-month meters.
      expected: async () => azurePolicy({ region: 'eastus2', premiumP1Resources: 10, premiumP2Resources: 10 }),
    },
    {
      name: 'US Gov guest config, Kubernetes and premium resources',
      region: 'usgovvirginia',
      currency: 'USD',
      component: { type: 'azure-policy', guestConfigServers: 2, exemptServers: 1, kubernetesVcpus: 8, kubernetesClusters: 1, premiumP1Resources: 2, premiumP2Resources: 3 },
      // Retail API has separate Azure Policy US Gov rows: server, paid Kubernetes vCPU after 6 free per cluster, and P1/P2 resource-months.
      expected: async () => azurePolicy({ region: 'usgovvirginia', guestConfigServers: 2, exemptServers: 1, kubernetesVcpus: 8, kubernetesClusters: 1, premiumP1Resources: 2, premiumP2Resources: 3 }),
    },
    {
      name: 'EUR all charged dimensions',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'azure-policy', guestConfigServers: 2, exemptServers: 1, kubernetesVcpus: 15, kubernetesClusters: 2, premiumP1Resources: 2, premiumP2Resources: 3 },
      // EUR Retail API Global rows: one charged server-month, three paid Kubernetes vCPU-months after 2 * 6 free, and P1/P2 resource-months.
      expected: async () => azurePolicy({ region: 'westeurope', guestConfigServers: 2, exemptServers: 1, kubernetesVcpus: 15, kubernetesClusters: 2, premiumP1Resources: 2, premiumP2Resources: 3, currency: 'EUR' }),
    },
  ],
};
