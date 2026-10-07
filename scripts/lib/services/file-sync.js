'use strict';
// Azure File Sync: per registered server per month. Azure Files storage and transactions are the separate files type.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'file-sync',
  label: 'Azure File Sync',
  family: 'storage',
  calculator: ['storage'],
  keywords: ['azure file sync', 'file server sync', 'hybrid file server', 'storage sync service', 'sync on-premises file server', 'cloud tiering', 'windows file server'],
  fields: {
    servers: { req: true, int: true, ask: 'How many Windows file servers (on-premises or VMs) will sync with Azure Files? Count each registered server.' },
    syncServices: { def: 1, int: true, ask: 'How many Storage Sync Services (the Azure resource that groups servers)? Use 1 if unknown. Each one has one server free.' }
  },
  examples: [
    { type: 'file-sync', servers: 4 },
    { type: 'file-sync', servers: 10, syncServices: 2 }
  ],
  readback: c => `Azure File Sync: ${fmtN(n(c.servers))} registered server(s) across ${fmtN(n(c.syncServices ?? 1))} Storage Sync Service(s)`,
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The Azure Files share capacity and its transactions (the files component).',
    'Sync operations, which are billed as Azure Files operations, and bandwidth charges.'
  ]),
  price: async (c, ctx) => {
    const servers = n(c.servers), svc = n(c.syncServices ?? 1);
    if (svc < 1) throw new PricingError('syncServices must be at least 1.');
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'File Sync'`, ctx);
    const m = single(rs.filter(r => r.meterName === 'Standard Server'), 'File Sync server');
    if (!m.length) throw new PricingError(`Azure File Sync is not priced in ${ctx.region}.`);
    const billed = Math.max(0, servers - svc);
    const lines = [meterLine('Storage', 'File Sync', `Azure File Sync: ${fmtN(servers)} server(s), first one per sync service free = ${fmtN(billed)} billed`, m, billed, ctx, { unit: 'servers' })];
    return { lines, notes: ['The first registered server in each Storage Sync Service is free; every additional server is billed per month.'], facts: { servers, syncServices: svc, billedServers: billed } };
  }
};
