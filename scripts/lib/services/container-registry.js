'use strict';
// Azure Container Registry (Basic, Standard, Premium): a daily registry unit that includes some storage,
// extra storage per GB, Premium geo-replicas and connected registries, and ACR Tasks build compute.
// Meters: serviceName 'Container Registry', regional. Registry units and replicas are billed per day,
// storage per GB-month, Tasks per vCPU-second with a 6,000 second (100 minute) monthly free band.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, DAYS } = require('../kit');

const n = v => Number(v || 0);
const INCLUDED_GB = { basic: 10, standard: 100, premium: 500 };
const TIERS = ['basic', 'standard', 'premium'];
const cap = s => s[0].toUpperCase() + s.slice(1);

module.exports = {
  type: 'container-registry',
  label: 'Azure Container Registry',
  family: 'containers',
  calculator: ['container-registry'],
  keywords: ['container registry', 'acr', 'docker images', 'image storage', 'geo-replication', 'container build', 'helm charts'],
  fields: {
    tier: { def: 'standard', enum: TIERS, ask: 'Which size of registry do they need? Learning or small dev/test -> basic (10 GB included); most production -> standard (100 GB included); large scale, private endpoints, geo-replication or customer-managed keys -> premium (500 GB included). If unknown, suggest standard and record it as an assumption.' },
    registries: { def: 1, int: true, min: 1, ask: 'How many separate registries? (Most teams need 1; add more for separate environments or business units.)' },
    days: { def: DAYS, min: 0, max: 31, ask: 'How many days a month does each registry exist? (30.4 = all month; a registry billed for part of the month only pays for those days.)' },
    storageGb: { req: true, min: 0, max: 102400, ask: 'Roughly how many GB of container images and artifacts will each registry hold in total? The included amount (Basic 10, Standard 100, Premium 500 GB) is free and only the excess is charged. If unknown, suggest 50 GB and record it as an assumption.' },
    geoReplicas: { def: 0, int: true, min: 0, ask: 'Premium only: in how many additional Azure regions should the registry be replicated so that deployments pull images close to where they run? (Most people need 0.)' },
    replicaRegions: { def: [], ask: 'Premium only, optional: which Azure regions are the replicas in (for example ["westeurope","japaneast"])? Replicas not listed here are priced at the registry\'s own region rates.' },
    connectedRegistries: { def: 0, int: true, min: 0, ask: 'Premium only: how many connected registries in total, across all registries (on-premises or edge copies that sync with this registry)? (Most people need 0.)' },
    buildVcpuMinutes: { def: 0, min: 0, ask: 'Only if they build or test container images with ACR Tasks: how many vCPU-minutes a month? (Build minutes x CPUs; the first 100 minutes a month are free.) Most small teams use under 100.' }
  },
  context: ['production', 'zoneResilience', 'privateOnly', 'multiRegionUsers'],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'Data transfer out of Azure regions (internet egress, and cross-region transfer when geo-replicas sync) is billed separately under bandwidth',
    'Private endpoints (Premium) and the networking to reach them',
    'Dedicated ACR Tasks agent pools (Premium) are billed per vCPU-second of allocation; there is no public meter, so they are not estimated'
  ]),
  examples: [
    { type: 'container-registry', tier: 'standard', storageGb: 150 },
    { type: 'container-registry', tier: 'premium', registries: 2, days: 30, storageGb: 800, geoReplicas: 2, replicaRegions: ['westeurope'], connectedRegistries: 1, buildVcpuMinutes: 500 },
    { type: 'container-registry', tier: 'basic', storageGb: 5 }
  ],
  readback: c => {
    const tier = (c.tier || 'standard').toLowerCase();
    const regs = n(c.registries ?? 1), days = c.days ?? DAYS;
    const parts = [`${fmtN(regs)} ${cap(tier)} registr${regs === 1 ? 'y' : 'ies'} for ${days === DAYS ? 'the whole month' : `${fmtN(days)} days`}`,
      `${fmtN(n(c.storageGb))} GB of images stored per registry (${INCLUDED_GB[tier] || 0} GB included)`];
    const reps = n(c.geoReplicas), listed = (c.replicaRegions || []).length;
    if (reps || listed) parts.push(`${fmtN(Math.max(reps, listed))} geo-replica(s)${listed ? ` (${c.replicaRegions.join(', ')}${reps > listed ? `, ${fmtN(reps - listed)} in unspecified region(s) priced at home-region rates` : ''})` : ' in unspecified regions (priced at home-region rates)'}`);
    if (n(c.connectedRegistries)) parts.push(`${fmtN(c.connectedRegistries)} connected registr${n(c.connectedRegistries) === 1 ? 'y' : 'ies'}`);
    if (n(c.buildVcpuMinutes)) parts.push(`${fmtN(c.buildVcpuMinutes)} vCPU-minutes of container builds a month (first 100 free)`);
    return `Container Registry: ${parts.join(', ')}`;
  },
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!TIERS.includes(tier)) throw new PricingError(`tier must be one of ${TIERS.join(', ')}.`);
    const regs = c.registries ?? 1, days = c.days ?? DAYS;
    if (regs < 1) throw new PricingError('registries must be at least 1.');
    if (days < 0 || days > 31) throw new PricingError('days must be between 0 and 31.');
    const replicas = Math.max(n(c.geoReplicas), (c.replicaRegions || []).length);
    if (tier !== 'premium' && (replicas || n(c.connectedRegistries))) throw new PricingError('Geo-replication and connected registries need tier "premium".');
    const sku = cap(tier);
    if (n(c.storageGb) > 40960 && tier !== 'premium') throw new PricingError('A Basic or Standard registry holds at most 40 TiB (40,960 GB); use Premium or several registries.');
    const filt = rg => `serviceName eq 'Container Registry' and armRegionName eq '${rg}' and priceType eq 'Consumption'`;
    const rs = await rows(filt(ctx.region), ctx);
    if (!rs.length) throw new PricingError(`Container Registry is not priced in ${ctx.region}.`);
    if (!rs.some(r => r.meterName === `${sku} Registry Unit`)) {
      const have = TIERS.filter(t => rs.some(r => r.meterName === `${cap(t)} Registry Unit`)).join(', ');
      throw new PricingError(`${sku} is not offered in ${ctx.region}; tiers sold there: ${have || 'none'}.`);
    }
    const by = (rr, name, what) => single(rr.filter(r => r.meterName === name), `Container Registry ${what}`);
    const G = 'Containers', S = 'Container Registry', lines = [];
    lines.push(meterLine(G, S, `${sku} registry unit (includes ${INCLUDED_GB[tier]} GB storage), ${fmtN(regs)} registr${regs === 1 ? 'y' : 'ies'} x ${fmtN(days)} days`, by(rs, `${sku} Registry Unit`, `${sku} registry unit`), regs * days, ctx, { unit: 'registry-days' }));
    const extraGb = Math.max(0, n(c.storageGb) - INCLUDED_GB[tier]);
    if (extraGb) lines.push(meterLine(G, S, `Extra storage beyond the ${INCLUDED_GB[tier]} GB included, ${fmtN(extraGb)} GB x ${fmtN(regs)} registr${regs === 1 ? 'y' : 'ies'}`, by(rs, 'Data Stored', 'extra storage'), extraGb * regs, ctx, { unit: 'GB / month' }));
    if (replicas) {
      const { normalizeRegion } = require('../estimate');
      const listed = (c.replicaRegions || []).map(x => normalizeRegion(x).code);
      const groups = {};
      for (let i = 0; i < replicas; i++) { const rg = listed[i] || ctx.region; groups[rg] = (groups[rg] || 0) + 1; }
      for (const [rg, cnt] of Object.entries(groups)) {
        const rr = rg === ctx.region ? rs : await rows(filt(rg), { ...ctx, region: rg });
        if (!rr.length) throw new PricingError(`Container Registry is not priced in replica region ${rg}.`);
        lines.push(meterLine(G, S, `Geo-replication: ${fmtN(cnt)} replica(s) in ${rg} x ${fmtN(regs)} registr${regs === 1 ? 'y' : 'ies'} x ${fmtN(days)} days`, by(rr, 'Premium Registry Replication Unit', 'Premium replication unit'), cnt * regs * days, ctx, { unit: 'replica-days' }));
        if (extraGb) lines.push(meterLine(G, S, `Extra storage in the ${rg} replica(s), ${fmtN(extraGb)} GB x ${fmtN(cnt * regs)} replica(s)`, by(rr, 'Premium GB Registry Replication Data Stored', 'replica storage'), extraGb * cnt * regs, ctx, { unit: 'GB / month' }));
      }
    }
    if (n(c.connectedRegistries)) lines.push(meterLine(G, S, `Connected registries, ${fmtN(c.connectedRegistries)} x ${fmtN(days)} days`, by(rs, 'Premium Connected registry', 'connected registry'), n(c.connectedRegistries) * days, ctx, { unit: 'registry-days' }));
    if (n(c.buildVcpuMinutes)) {
      const task = single(rs.filter(r => r.meterName === 'Task vCPU Duration'), 'ACR Tasks vCPU duration');
      lines.push(meterLine(G, S, `ACR Tasks build compute, ${fmtN(c.buildVcpuMinutes)} vCPU-minutes (first 100 free)`, task, n(c.buildVcpuMinutes) * 60, ctx, { unit: 'vCPU seconds' }));
    }
    const notes = [`The ${sku} registry unit is billed per day and already includes ${INCLUDED_GB[tier]} GB of storage; only storage above that is charged per GB.`];
    if (replicas) notes.push('Each geo-replica is billed a full Premium registry rate per day, and storage is billed per replica; this estimate assumes each replica holds the same images and has the same included storage.');
    if (n(c.buildVcpuMinutes)) notes.push('ACR Tasks gives 6,000 vCPU-seconds (100 minutes) a month free; beyond that it is billed per vCPU-second.');
    return { lines, notes, facts: { tier, registries: regs, storageGb: n(c.storageGb), includedGb: INCLUDED_GB[tier], geoReplicas: replicas, connectedRegistries: n(c.connectedRegistries), buildVcpuMinutes: n(c.buildVcpuMinutes) } };
  }
};
