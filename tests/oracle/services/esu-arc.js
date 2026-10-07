'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

const HOURS_PER_MONTH = 730;
const ESU_CALCULATOR_URL = 'https://azure.microsoft.com/api/v3/pricing/extended-security-updates/calculator/';

const CALC_REGION = {
  eastus2: 'us-east-2',
  westeurope: 'europe-west',
  usgovvirginia: 'usgov-virginia',
};

let esuCalculatorCache;

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

async function esuCalculator() {
  if (!esuCalculatorCache) {
    const res = await fetch(ESU_CALCULATOR_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`ESU calculator HTTP ${res.status}`);
    esuCalculatorCache = await res.json();
  }
  return esuCalculatorCache;
}

async function calcHourly(offer, region) {
  const data = await esuCalculator();
  const calcRegion = CALC_REGION[region];
  if (!calcRegion) throw new Error(`no calculator region mapping for ${region}`);
  const price = data.offers?.[offer]?.prices?.perhour?.[calcRegion]?.value;
  if (typeof price !== 'number') throw new Error(`ESU calculator has no ${offer} price for ${calcRegion}`);
  return price;
}

function windowsBillableCores({ licensing = 'virtual', machines = 1, coresPerMachine }) {
  const minimum = licensing === 'physical' ? 16 : 8;
  return machines * Math.max(minimum, coresPerMachine);
}

function sqlBillableCores({ licensing = 'virtual', machines = 1, coresPerMachine }) {
  const minimum = licensing === 'physical-unlimited' ? 16 : 4;
  return machines * Math.max(minimum, coresPerMachine);
}

async function freeEsu({ desc }) {
  const lines = [line(desc, 0)];
  return { monthlyList: 0, lines };
}

async function windowsServerEsu({ version, edition = 'standard', hostedOn = 'arc', licensing = 'virtual', machines = 1, coresPerMachine, hours = HOURS_PER_MONTH, region = 'eastus2', currency = 'USD' }) {
  if (hostedOn === 'azure-vm' && version === '2012') {
    return freeEsu({ desc: `Windows Server ${version} ESU on Azure virtual machines: no charge` });
  }

  if (hostedOn === 'azure-vm' && version === '2016') {
    const rows = dedupe(await query(`serviceName eq 'Virtual Machines Licenses' and productName eq 'Windows Server Azure ESU' and armRegionName eq 'Global'`, currency));
    const row = pickOne(rows, r => r.meterName === `WS 2016 ${coresPerMachine} vCPU ESU` && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption', `Windows Server 2016 Azure VM ${coresPerMachine} vCPU ESU`);
    const cost = (machines * hours / unitSize(row.unitOfMeasure)) * row.retailPrice;
    const lines = [
      line(`Windows Server 2016 Azure VM ESU: ${machines} VM(s) * ${hours} hours * ${row.retailPrice} (${coresPerMachine} vCPU meter)`, cost, { meterId: row.meterId }),
    ];
    return { monthlyList: totalOf(lines), lines };
  }

  const cores = windowsBillableCores({ licensing, machines, coresPerMachine });

  if (version === '2016' && currency === 'USD') {
    const offerEdition = edition === 'datacenter' ? 'datacenter' : 'standard';
    const offer = `extended-security-windows-2016-${offerEdition}-2`;
    const price = await calcHourly(offer, region);
    const cost = cores * hours * price;
    const lines = [
      line(`Calculator ${offer}: ${machines} machine(s) * minimum-adjusted ${cores / machines} core(s) * ${hours} hours * ${price}`, cost, { sourceOffer: offer }),
    ];
    return { monthlyList: totalOf(lines), lines };
  }

  const rows = dedupe(await query(`serviceName eq 'Azure Arc' and productName eq 'Azure Arc Extended Security Updates' and armRegionName eq 'Global'`, currency));
  const editionToken = edition === 'datacenter' ? 'DC' : 'Std';
  const row = pickOne(rows, r => r.meterName === `WS${version} ${editionToken} 1C ESU` && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption', `Windows Server ${version} ${edition} ESU`);
  const cost = (cores * hours / unitSize(row.unitOfMeasure)) * row.retailPrice;
  const lines = [
    line(`Windows Server ${version} ${edition} ESU: ${machines} machine(s) * minimum-adjusted ${cores / machines} core(s) * ${hours} hours * ${row.retailPrice}`, cost, { meterId: row.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

async function sqlServerEsu({ version, edition = 'standard', hostedOn = 'arc', licensing = 'virtual', machines = 1, coresPerMachine, hours = HOURS_PER_MONTH, region = 'eastus2', currency = 'USD' }) {
  if (['developer', 'express', 'web'].includes(edition)) {
    return freeEsu({ desc: `SQL Server ${version} ${edition} edition ESU: no charge` });
  }

  if (hostedOn === 'azure-vm' && version === '2014') {
    return freeEsu({ desc: `SQL Server ${version} ESU on Azure virtual machines: no charge` });
  }

  const effectiveEdition = licensing === 'physical-unlimited' ? 'enterprise' : edition;
  const editionToken = effectiveEdition === 'enterprise' ? 'Ent' : 'Std';
  const editionSlug = effectiveEdition === 'enterprise' ? 'enterprise' : 'standard';
  const cores = sqlBillableCores({ licensing, machines, coresPerMachine });

  if (currency === 'USD') {
    const offer = hostedOn === 'azure-vm' && version === '2016'
      ? `azure-vm-esu-sql-${version}-${editionSlug}`
      : `extended-security-sql-${version}-${editionSlug}`;
    const price = await calcHourly(offer, region);
    const cost = cores * hours * price;
    const lines = [
      line(`Calculator ${offer}: ${machines} machine(s) * minimum-adjusted ${cores / machines} core(s) * ${hours} hours * ${price}`, cost, { sourceOffer: offer }),
    ];
    return { monthlyList: totalOf(lines), lines };
  }

  const rows = dedupe(await query(`serviceName eq 'Azure Arc Enabled Databases' and productName eq 'Azure Arc-enabled SQL Server - Arc-enabled servers' and armRegionName eq 'Global'`, currency));
  const azure = version === '2016' && hostedOn === 'azure-vm' ? 'Azure ' : '';
  const row = pickOne(rows, r => r.meterName === `${editionToken} edition - ${azure}ESU ${version}` && r.unitOfMeasure === '1 Hour' && r.type === 'Consumption', `SQL Server ${version} ${effectiveEdition} ESU`);
  const cost = (cores * hours / unitSize(row.unitOfMeasure)) * row.retailPrice;
  const lines = [
    line(`SQL Server ${version} ${effectiveEdition} ESU: ${machines} machine(s) * minimum-adjusted ${cores / machines} core(s) * ${hours} hours * ${row.retailPrice}`, cost, { meterId: row.meterId }),
  ];
  return { monthlyList: totalOf(lines), lines };
}

function esu(opts) {
  return opts.product === 'windows-server' ? windowsServerEsu(opts) : sqlServerEsu(opts);
}

module.exports = {
  type: 'esu-arc',
  source: 'both',
  cases: [
    {
      name: 'windows server 2012 standard virtual minimum cores',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2012', edition: 'standard', licensing: 'virtual', machines: 1, coresPerMachine: 4 },
      // Retail API WS2012 Std 1C ESU hourly meter; Lifecycle FAQ says vCore licensing has an 8-core minimum per VM.
      expected: async () => esu({ product: 'windows-server', version: '2012', edition: 'standard', licensing: 'virtual', machines: 1, coresPerMachine: 4 }),
    },
    {
      name: 'windows server 2012 datacenter physical minimum cores',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2012', edition: 'datacenter', licensing: 'physical', machines: 1, coresPerMachine: 12 },
      // Retail API WS2012 DC 1C ESU hourly meter; Lifecycle FAQ says pCore licensing has a 16-core minimum per server.
      expected: async () => esu({ product: 'windows-server', version: '2012', edition: 'datacenter', licensing: 'physical', machines: 1, coresPerMachine: 12 }),
    },
    {
      name: 'windows server 2016 standard actual virtual cores',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2016', edition: 'standard', licensing: 'virtual', machines: 2, coresPerMachine: 12 },
      // ESU calculator offer extended-security-windows-2016-standard-2 is hourly per core; bill two 12-core VMs because each exceeds the 8-core VM minimum.
      expected: async () => esu({ product: 'windows-server', version: '2016', edition: 'standard', licensing: 'virtual', machines: 2, coresPerMachine: 12, region: 'westeurope' }),
    },
    {
      name: 'windows server 2016 datacenter virtual 16 cores',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2016', hostedOn: 'arc', edition: 'datacenter', licensing: 'virtual', machines: 1, coresPerMachine: 16 },
      // ESU calculator extended-security-windows-2016-datacenter-2: 16 cores * 730 hours * $0.041067 = $479.66.
      expected: async () => esu({ product: 'windows-server', version: '2016', hostedOn: 'arc', edition: 'datacenter', licensing: 'virtual', machines: 1, coresPerMachine: 16, region: 'eastus2' }),
    },
    {
      name: 'windows server 2016 standard physical 16-core boundary',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2016', hostedOn: 'arc', edition: 'standard', licensing: 'physical', machines: 1, coresPerMachine: 16 },
      // ESU calculator extended-security-windows-2016-standard-2; physical-core licensing boundary is exactly the 16-core server minimum.
      expected: async () => esu({ product: 'windows-server', version: '2016', hostedOn: 'arc', edition: 'standard', licensing: 'physical', machines: 1, coresPerMachine: 16, region: 'eastus2' }),
    },
    {
      name: 'windows server 2012 azure vm free',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2012', hostedOn: 'azure-vm', edition: 'standard', licensing: 'virtual', machines: 1, coresPerMachine: 8 },
      // Learn says Extended Security Updates are free for eligible Azure VMs; Windows Server 2012 Azure VM ESU has no charge.
      expected: async () => esu({ product: 'windows-server', version: '2012', hostedOn: 'azure-vm', edition: 'standard', licensing: 'virtual', machines: 1, coresPerMachine: 8 }),
    },
    {
      name: 'windows server 2016 azure vm standard meter',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2016', hostedOn: 'azure-vm', edition: 'standard', licensing: 'virtual', machines: 1, coresPerMachine: 16 },
      // Retail API Windows Server Azure ESU has an exact WS 2016 16 vCPU ESU hourly meter; Azure VM ESU bills actual vCPUs with no 8-core minimum.
      expected: async () => esu({ product: 'windows-server', version: '2016', hostedOn: 'azure-vm', edition: 'standard', licensing: 'virtual', machines: 1, coresPerMachine: 16, region: 'eastus2' }),
    },
    {
      name: 'windows server 2016 azure vm four vcpus',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2016', hostedOn: 'azure-vm', edition: 'standard', licensing: 'virtual', machines: 1, coresPerMachine: 4 },
      // Retail API WS 2016 4 vCPU ESU meter is billed directly for actual VM vCPUs: 730 hours * the 4-vCPU hourly meter.
      expected: async () => esu({ product: 'windows-server', version: '2016', hostedOn: 'azure-vm', edition: 'standard', licensing: 'virtual', machines: 1, coresPerMachine: 4, region: 'eastus2' }),
    },
    {
      name: 'windows server 2016 datacenter US Gov',
      region: 'usgovvirginia',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'windows-server', version: '2016', hostedOn: 'arc', edition: 'datacenter', licensing: 'virtual', machines: 1, coresPerMachine: 16 },
      // ESU calculator usgov-virginia has the same Windows Server 2016 Datacenter per-core price: 16 * 730 * $0.041067.
      expected: async () => esu({ product: 'windows-server', version: '2016', hostedOn: 'arc', edition: 'datacenter', licensing: 'virtual', machines: 1, coresPerMachine: 16, region: 'usgovvirginia' }),
    },
    {
      name: 'sql server 2014 standard minimum cores',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'sql-server', version: '2014', edition: 'standard', hostedOn: 'arc', machines: 1, coresPerMachine: 2 },
      // ESU calculator extended-security-sql-2014-standard hourly meter; SQL Learn billing rules say ESU usage has a four-core minimum per OSE.
      expected: async () => esu({ product: 'sql-server', version: '2014', edition: 'standard', hostedOn: 'arc', machines: 1, coresPerMachine: 2, region: 'eastus2' }),
    },
    {
      name: 'sql server 2014 enterprise actual cores',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'sql-server', version: '2014', edition: 'enterprise', hostedOn: 'arc', machines: 1, coresPerMachine: 8 },
      // ESU calculator extended-security-sql-2014-enterprise hourly meter multiplied by the actual eight cores because it exceeds the SQL four-core minimum.
      expected: async () => esu({ product: 'sql-server', version: '2014', edition: 'enterprise', hostedOn: 'arc', machines: 1, coresPerMachine: 8, region: 'eastus2' }),
    },
    {
      name: 'sql server 2014 azure vm free',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'sql-server', version: '2014', edition: 'standard', hostedOn: 'azure-vm', licensing: 'virtual', machines: 1, coresPerMachine: 4 },
      // SQL Server 2014 ESU on Azure VMs is represented as no charge for the Azure-VM hosted path.
      expected: async () => esu({ product: 'sql-server', version: '2014', edition: 'standard', hostedOn: 'azure-vm', licensing: 'virtual', machines: 1, coresPerMachine: 4 }),
    },
    {
      name: 'sql server 2016 developer edition no charge',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'sql-server', version: '2016', edition: 'developer', hostedOn: 'arc', licensing: 'virtual', machines: 1, coresPerMachine: 8 },
      // SQL Learn ESU metering tables list Developer, Express, and Web editions as None; Developer edition therefore has no ESU charge.
      expected: async () => esu({ product: 'sql-server', version: '2016', edition: 'developer', hostedOn: 'arc', licensing: 'virtual', machines: 1, coresPerMachine: 8 }),
    },
    {
      name: 'sql server 2016 standard on azure vm',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'sql-server', version: '2016', edition: 'standard', hostedOn: 'azure-vm', machines: 1, coresPerMachine: 8 },
      // ESU calculator azure-vm-esu-sql-2016-standard hourly meter: 8 cores * 730 hours * $0.19.
      expected: async () => esu({ product: 'sql-server', version: '2016', edition: 'standard', hostedOn: 'azure-vm', machines: 1, coresPerMachine: 8, region: 'eastus2' }),
    },
    {
      name: 'sql server 2016 enterprise part-time hours',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'sql-server', version: '2016', edition: 'enterprise', hostedOn: 'arc', machines: 1, coresPerMachine: 16, hours: 100 },
      // ESU calculator extended-security-sql-2016-enterprise hourly meter multiplied by 16 cores and the component's part-time 100 hours.
      expected: async () => esu({ product: 'sql-server', version: '2016', edition: 'enterprise', hostedOn: 'arc', machines: 1, coresPerMachine: 16, hours: 100, region: 'eastus2' }),
    },
    {
      name: 'sql server 2016 physical unlimited enterprise minimum',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'esu-arc', product: 'sql-server', version: '2016', edition: 'standard', hostedOn: 'arc', licensing: 'physical-unlimited', machines: 1, coresPerMachine: 12 },
      // SQL physical-unlimited uses Enterprise ESU at a 16-core minimum: 16 * 730 * $0.74 from extended-security-sql-2016-enterprise.
      expected: async () => esu({ product: 'sql-server', version: '2016', edition: 'standard', hostedOn: 'arc', licensing: 'physical-unlimited', machines: 1, coresPerMachine: 12, region: 'eastus2' }),
    },
    {
      name: 'sql server 2016 standard EUR',
      region: 'westeurope',
      currency: 'EUR',
      component: { type: 'esu-arc', product: 'sql-server', version: '2016', edition: 'standard', hostedOn: 'arc', machines: 1, coresPerMachine: 4 },
      // EUR Retail API Std edition - ESU 2016 hourly meter; SQL Learn billing rules apply the four-core minimum per OSE.
      expected: async () => esu({ product: 'sql-server', version: '2016', edition: 'standard', hostedOn: 'arc', machines: 1, coresPerMachine: 4, currency: 'EUR' }),
    },
  ],
};
