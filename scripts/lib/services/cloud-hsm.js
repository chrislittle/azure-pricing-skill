'use strict';
// Azure Cloud HSM: single-tenant HSM clusters. Billed per cluster-hour (a cluster is three HSM nodes), regional.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'cloud-hsm',
  label: 'Azure Cloud HSM',
  family: 'security',
  calculator: ['azure-cloud-hsm'],
  keywords: ['hsm', 'hardware security module', 'cloud hsm', 'single tenant hsm', 'pkcs11', 'key custody', 'fips 140-3', 'dedicated hsm replacement'],
  fields: {
    clusters: { req: true, int: true, min: 1, ask: 'How many Cloud HSM clusters do you need? Each cluster already has three HSM nodes for high availability and is billed as one unit. Count one per region or environment you need (for example production, plus a separate one for a second region).' },
    hours: { def: 730, min: 0, max: 744, ask: 'It is billed from provisioning until deletion, so for always-on use leave this at 730 hours a month. If it will exist for only part of a month, how many hours?' }
  },
  context: ['production'],
  examples: [
    { type: 'cloud-hsm', clusters: 1 },
    { type: 'cloud-hsm', clusters: 2, hours: 365 }
  ],
  readback: c => `Azure Cloud HSM: ${fmtN(n(c.clusters))} cluster(s) of three HSM nodes each, ${n(c.hours ?? HOURS) === HOURS ? 'running all month' : fmtN(n(c.hours)) + ' hours a month'}`,
  notIncluded: (types, spec) => (spec && spec.excluded && spec.excluded.includes('network')) ? [] : ['Virtual network, private endpoint and the virtual machines used to configure the HSM (billed separately)', 'Azure Blob Storage account (and its private endpoint) for HSM backups'],
  price: async (c, ctx) => {
    const clusters = n(c.clusters);
    if (!Number.isInteger(clusters) || clusters < 1) throw new PricingError('Azure Cloud HSM needs a whole number of clusters, at least 1.');
    const hours = c.hours ?? HOURS;
    if (!Number.isFinite(Number(hours)) || hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const rs = await rows(`serviceName eq 'Azure Cloud HSM' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Cloud HSM is not priced in ${ctx.region}.`);
    const m = single(rs.filter(r => r.meterName === 'Standard_B1 vCore'), 'Azure Cloud HSM cluster (Standard_B1)');
    const lines = [meterLine('Security', 'Azure Cloud HSM', `Azure Cloud HSM cluster (3 HSM nodes), ${fmtN(clusters)} cluster(s) x ${fmtN(hours)} hours`, m, clusters * hours, ctx, { unit: 'hours' })];
    return {
      lines,
      notes: ['Billed per cluster-hour (each cluster is three HSM nodes), from provisioning until deletion; it cannot be paused, so use fewer than 730 hours only if the cluster will really be deleted for part of the month.'],
      facts: { clusters, hours, nodes: clusters * 3 }
    };
  }
};

