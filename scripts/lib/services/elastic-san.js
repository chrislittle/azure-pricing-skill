'use strict';
// Azure Elastic SAN (Premium LRS and ZRS). Billed per provisioned GiB-month in two kinds of capacity:
// base capacity (adds 5,000 IOPS and 200 MB/s per TiB) and additional capacity (storage only, cheaper).
// Meters: serviceName 'Storage', productName 'Azure Elastic SAN', regional.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const GIB_PER_TIB = 1024;
const IOPS_PER_BASE_TIB = 5000;
const MBPS_PER_BASE_TIB = 200;
// LRS regions with lower base-capacity limits (100 TiB base, 100 TiB additional) per the Elastic SAN scale targets page.
const LOW_BASE_REGIONS = ['eastasia', 'koreacentral', 'southafricanorth', 'francecentral', 'southeastasia', 'westus3', 'swedencentral', 'switzerlandnorth', 'canadaeast', 'japanwest', 'northcentralus', 'australiacentral', 'brazilsoutheast', 'koreasouth', 'uaecentral', 'switzerlandwest', 'germanynorth', 'francesouth', 'norwaywest', 'swedensouth'];

module.exports = {
  type: 'elastic-san',
  label: 'Azure Elastic SAN',
  family: 'storage-other',
  calculator: ['azure-elastic-san'],
  keywords: ['san', 'iscsi', 'block storage', 'elastic san', 'shared storage', 'azure vmware solution datastore', 'aks block storage'],
  fields: {
    redundancy: { def: 'lrs', enum: ['lrs', 'zrs'], ask: 'Must the storage keep working if one Azure datacenter (availability zone) in the region fails? Yes -> zrs; otherwise lrs (three copies in one datacenter). Not every region offers zrs.' },
    baseTiB: { req: true, int: true, min: 0, ask: 'How much performance do you need? Each TiB of "base" storage adds 5,000 IOPS and 200 MB/s to the whole SAN. Divide the IOPS you need by 5,000 (and the MB/s by 200), round up, and take the larger number. The SAN must have at least 1 TiB in total. If unknown, suggest 1 and record it as an assumption.' },
    additionalTiB: { def: 0, int: true, min: 0, ask: 'How many TiB of extra storage do you need beyond the base? Extra storage is cheaper per TiB but adds no speed. Total storage = base + extra. Use 0 if the base already covers your storage needs.' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'elastic-san', baseTiB: 1 },
    { type: 'elastic-san', redundancy: 'zrs', baseTiB: 10, additionalTiB: 40 }
  ],
  readback: c => {
    const base = n(c.baseTiB), add = n(c.additionalTiB);
    return `Azure Elastic SAN, ${(c.redundancy || 'lrs') === 'zrs' ? 'zone-redundant (ZRS)' : 'locally redundant (LRS)'}: ${fmtN(base)} TiB base storage (${fmtN(base * IOPS_PER_BASE_TIB)} IOPS, ${fmtN(base * MBPS_PER_BASE_TIB)} MB/s) plus ${fmtN(add)} TiB additional storage, ${fmtN(base + add)} TiB in total`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.includes('network')) ? [] : [
    'Private endpoints or service endpoints used to connect the SAN to virtual networks (billed separately)',
    'Network data transfer charges between regions or out of Azure'
  ],
  price: async (c, ctx) => {
    const red = (c.redundancy || 'lrs').toLowerCase();
    if (!['lrs', 'zrs'].includes(red)) throw new PricingError('redundancy must be lrs or zrs.');
    const base = n(c.baseTiB), add = n(c.additionalTiB);
    if (!Number.isInteger(base) || base < 0) throw new PricingError('baseTiB must be a whole number of TiB, 0 or more.');
    if (!Number.isInteger(add) || add < 0) throw new PricingError('additionalTiB must be a whole number of TiB, 0 or more.');
    if (base + add < 1) throw new PricingError('An Elastic SAN needs at least 1 TiB of capacity in total.');
    const lowRegion = LOW_BASE_REGIONS.includes(ctx.region);
    const maxBase = red === 'zrs' || lowRegion ? 100 : 400, maxAdd = red === 'zrs' ? 200 : lowRegion ? 100 : 600;
    if (base > maxBase) throw new PricingError(`Base capacity is limited to ${maxBase} TiB for ${red.toUpperCase()} in ${ctx.region} (larger sizes need a support request).`);
    if (add > maxAdd) throw new PricingError(`Additional capacity is limited to ${maxAdd} TiB for ${red.toUpperCase()} in ${ctx.region} (larger sizes need a support request).`);
    const RED = red.toUpperCase();
    const rs = await rows(`serviceName eq 'Storage' and productName eq 'Azure Elastic SAN' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Elastic SAN is not priced in ${ctx.region}.`);
    const sku = rs.filter(r => r.skuName === `Premium ${RED}`);
    if (!sku.length) throw new PricingError(`Azure Elastic SAN ${RED} is not offered in ${ctx.region}.`);
    const lines = [meterLine('Storage', 'Azure Elastic SAN', `Elastic SAN ${RED} base capacity, ${fmtN(base)} TiB (${fmtN(base * GIB_PER_TIB)} GiB)`, single(sku.filter(r => r.meterName === `Premium ${RED} Provisioned Base Unit`), `Elastic SAN ${RED} base capacity`), base * GIB_PER_TIB, ctx, { unit: 'GiB / month' })];
    if (add) lines.push(meterLine('Storage', 'Azure Elastic SAN', `Elastic SAN ${RED} additional capacity, ${fmtN(add)} TiB (${fmtN(add * GIB_PER_TIB)} GiB)`, single(sku.filter(r => r.meterName === `Premium ${RED} Provisioned Capacity Unit`), `Elastic SAN ${RED} additional capacity`), add * GIB_PER_TIB, ctx, { unit: 'GiB / month' }));
    return {
      lines,
      notes: [
        'Elastic SAN bills the capacity you provision, not the data you store. Each TiB of base capacity adds 5,000 IOPS and 200 MB/s to the SAN; additional capacity adds storage only and costs less per TiB.',
        `This SAN provides up to ${fmtN(base * IOPS_PER_BASE_TIB)} IOPS and ${fmtN(base * MBPS_PER_BASE_TIB)} MB/s, shared among all its volumes. Volume snapshots use capacity from the SAN.`
      ],
      facts: { redundancy: red, baseTiB: base, additionalTiB: add, totalTiB: base + add, iops: base * IOPS_PER_BASE_TIB, throughputMBps: base * MBPS_PER_BASE_TIB }
    };
  }
};
