'use strict';
// Azure Container Storage. Version 1.x bills an orchestration service fee per GiB-month on the part of a storage pool
// above 5 TiB (regionless 'Global' meter); version 2.x has no service fee. The backing storage (managed disks,
// Elastic SAN, local NVMe) is billed separately as its own service.
// Meters: serviceName 'Storage', productName 'Azure Container Storage', armRegionName 'Global'.
const { rows, single, line, meterInfo, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const FREE_TIB = 5;
const GIB_PER_TIB = 1024;

module.exports = {
  type: 'container-storage',
  label: 'Azure Container Storage',
  family: 'storage-other',
  calculator: ['container-storage'],
  keywords: ['container storage', 'kubernetes storage', 'aks persistent volumes', 'aks volumes', 'storage pool', 'stateful containers'],
  fields: {
    version: { def: 'v2', enum: ['v1', 'v2'], ask: 'Which release of Azure Container Storage will you use? Version 2.x is the current release and has no service fee (v2); version 1.x charges a service fee on storage pools larger than 5 TiB (v1). If unknown, use v2 and record it as an assumption.' },
    poolCount: { def: 1, int: true, min: 1, ask: 'Version 1 only: how many separate storage pools will you create? The 5 TiB with no fee applies to each pool on its own. If unknown, use 1.' },
    poolTiB: { req: true, min: 0, ask: 'How big will each storage pool be, in TiB (1 TiB = 1,024 GiB)? A pool is the group of storage that Azure Container Storage manages for your Kubernetes cluster. If unknown, suggest 5 and record it as an assumption.' }
  },
  context: [],
  examples: [
    { type: 'container-storage', version: 'v1', poolTiB: 9 },
    { type: 'container-storage', version: 'v1', poolCount: 3, poolTiB: 8 }
  ],
  readback: c => { const v1 = (c.version || 'v2') === 'v1', k = n(c.poolCount ?? 1) || 1; return `Azure Container Storage ${v1 ? 'version 1' : 'version 2'}: ${fmtN(k)} storage pool(s) of ${fmtN(n(c.poolTiB))} TiB each${v1 ? ` (service fee on the ${fmtN(Math.max(0, n(c.poolTiB) - FREE_TIB))} TiB above the first ${FREE_TIB} TiB of each pool)` : ' (no service fee)'}`; },
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.includes('storage')) ? [] : [
    'The backing storage for the pool: Azure managed disks or Azure Elastic SAN (add them as their own components); local NVMe disks are part of the AKS node virtual machine price',
    'The AKS cluster and its virtual machines'
  ],
  price: async (c, ctx) => {
    const ver = c.version || 'v2';
    if (!['v1', 'v2'].includes(ver)) throw new PricingError('version must be v1 or v2.');
    const tib = n(c.poolTiB), pools = n(c.poolCount ?? 1) || 1;
    if (!Number.isFinite(tib) || tib < 0) throw new PricingError('poolTiB must be 0 or more.');
    if (!Number.isInteger(pools) || pools < 1) throw new PricingError('poolCount must be a whole number, at least 1.');
    const rs = await rows(`serviceName eq 'Storage' and productName eq 'Azure Container Storage' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    const m = single(rs.filter(r => r.meterName === 'Provisioned Capacity Unit'), 'Azure Container Storage orchestration fee');
    const perPoolTiB = ver === 'v1' ? Math.max(0, tib - FREE_TIB) : 0;
    const billable = perPoolTiB * pools * GIB_PER_TIB;
    const desc = ver === 'v2' ? `Azure Container Storage version 2 service fee: none, ${fmtN(pools)} pool(s) of ${fmtN(tib)} TiB`
      : `Azure Container Storage service fee: ${fmtN(perPoolTiB)} TiB above the first ${FREE_TIB} TiB, in each of ${fmtN(pools)} pool(s) of ${fmtN(tib)} TiB (${fmtN(billable)} GiB billed)`;
    const lines = [billable > 0 ? meterLine('Storage', 'Storage', desc, m, billable, ctx, { unit: 'GiB / month' })
      : line('Storage', 'Storage', desc, 0, 'GiB / month', m[0].retailPrice, 0, meterInfo(m[0]))];
    const notes = ver === 'v1'
      ? [`The service fee applies only to capacity above ${FREE_TIB} TiB in each storage pool; a pool of ${FREE_TIB} TiB or less has no service fee. It is not charged while the deployment is not active (for example when the AKS cluster is stopped). The price is global, not per region, but version 1 is offered only in a listed set of regions, so check availability for ${ctx.region}.`]
      : ['Version 2 adds no service or orchestration fee; you pay only for the underlying storage.'];
    notes.push('The backing storage (managed disks or Elastic SAN) is billed separately and is not in this line.');
    return { lines, notes, facts: { version: ver, poolTiB: tib, poolCount: pools, billableTiB: billable / GIB_PER_TIB } };
  }
};