'use strict';
// Azure Network Watcher: flow logs (virtual network and legacy NSG), Traffic Analytics, Connection Monitor,
// Network Performance Monitor (Performance Monitor and Service Connectivity Monitor) and Network Diagnostic Tools.
// Meters: serviceName 'Network Watcher', regional, standard SKU. Several meters have a free monthly grant as a 0-priced first band.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'network-watcher',
  label: 'Azure Network Watcher',
  family: 'network-security',
  calculator: ['network-watcher'],
  keywords: ['network watcher', 'flow logs', 'traffic analytics', 'connection monitor', 'network monitoring', 'packet capture', 'network diagnostics', 'nsg flow logs'],
  fields: {
    vnetFlowLogsGB: { req: true, ask: 'Will they record network traffic logs ("virtual network flow logs") to see who talks to whom? Roughly how many GB of these logs a month? In most regions the first 5 GB a month are free. Use 0 if they do not need them. If unknown, suggest 50 GB and record it as an assumption.' },
    nsgFlowLogsGB: { def: 0, ask: 'Only if they already use the older network security group (NSG) flow logs: how many GB a month? (This feature is retiring; new setups should use virtual network flow logs, so usually 0.)' },
    trafficAnalyticsGB: { def: 0, ask: 'Only if they want Traffic Analytics (dashboards and insight on top of the flow logs): how many GB of flow logs does it process a month? Usually the same as the flow log volume. Use 0 if not needed.' },
    trafficAnalyticsInterval: { def: '60min', enum: ['60min', '10min'], ask: 'Only for Traffic Analytics: is hourly refresh fine, or do they need near-real-time (every 10 minutes, costs more)? Hourly -> 60min; every 10 minutes -> 10min.' },
    connectionMonitorTests: { int: true, min: 0, def: 0, ask: 'Only if they want to test connectivity between endpoints on a schedule (Connection Monitor): how many tests in total? One test is one source-to-destination check configuration; in most regions the first 10 a month are free.' },
    performanceMonitorMetrics: { int: true, min: 0, def: 0, internal: true },
    serviceConnectivityConnections: { int: true, min: 0, def: 0, internal: true },
    diagnosticChecks: { int: true, min: 0, def: 0, ask: 'How many times a month will people run the on-demand troubleshooting tools (IP flow verify, next hop, packet capture, connection troubleshoot and similar)? In most regions the first 1,000 a month are free. If unknown, suggest 0 and record it as an assumption.' }
  },
  context: ['production'],
  examples: [
    { type: 'network-watcher', vnetFlowLogsGB: 100 },
    { type: 'network-watcher', vnetFlowLogsGB: 500, nsgFlowLogsGB: 50, trafficAnalyticsGB: 550, trafficAnalyticsInterval: '10min', connectionMonitorTests: 40, diagnosticChecks: 2500 },
    { type: 'network-watcher', vnetFlowLogsGB: 0, connectionMonitorTests: 30 }
  ],
  readback: c => {
    const parts = [];
    if (n(c.vnetFlowLogsGB) || !['nsgFlowLogsGB', 'trafficAnalyticsGB', 'connectionMonitorTests', 'diagnosticChecks'].some(k => n(c[k]))) parts.push(`${fmtN(n(c.vnetFlowLogsGB))} GB of virtual network flow logs a month`);
    if (n(c.nsgFlowLogsGB)) parts.push(`${fmtN(c.nsgFlowLogsGB)} GB of legacy NSG flow logs a month`);
    if (n(c.trafficAnalyticsGB)) parts.push(`Traffic Analytics processing ${fmtN(c.trafficAnalyticsGB)} GB a month, ${c.trafficAnalyticsInterval === '10min' ? 'every 10 minutes (accelerated)' : 'hourly (standard)'}`);
    if (n(c.connectionMonitorTests)) parts.push(`${fmtN(c.connectionMonitorTests)} Connection Monitor tests`);
    if (n(c.diagnosticChecks)) parts.push(`${fmtN(c.diagnosticChecks)} diagnostic tool checks a month`);
    return `Network Watcher: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Storage for flow logs (storage account) and Log Analytics ingestion and retention for flow logs, Connection Monitor results or Network Analytics (DNS and Application Gateway analytics) are billed separately; Traffic Analytics processing already includes its own workspace cost.'
  ],
  price: async (c, ctx) => {
    const interval = (c.trafficAnalyticsInterval || '60min').toLowerCase();
    if (interval !== '60min' && interval !== '10min') throw new PricingError('trafficAnalyticsInterval must be "60min" or "10min".');
    const qty = ['vnetFlowLogsGB', 'nsgFlowLogsGB', 'trafficAnalyticsGB', 'connectionMonitorTests', 'diagnosticChecks'];
    for (const k of qty) if (n(c[k]) < 0) throw new PricingError(`${k} cannot be negative.`);
    if (n(c.performanceMonitorMetrics) || n(c.serviceConnectivityConnections)) throw new PricingError('Network Performance Monitor (Performance Monitor and Service Connectivity Monitor) cannot be priced: Microsoft states "Network performance monitor is deprecated and no longer available." (https://learn.microsoft.com/azure/network-watcher/migrate-to-connection-monitor-from-network-performance-monitor). Use Connection Monitor tests instead.');
    const rs = await rows(`serviceName eq 'Network Watcher' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Network Watcher is not priced in ${ctx.region}.`);
    const m = (name, what) => {
      const hit = rs.filter(r => r.meterName === name);
      if (!hit.length) throw new PricingError(`Network Watcher ${what} is not priced in ${ctx.region}.`);
      return single(hit, `Network Watcher ${what}`);
    };
    const G = 'Networking', S = 'Network Watcher', lines = [];
    // The free grant is the 0-priced first band; some regions (for example US Government) have none.
    const freeOf = r => { const b = r.slice().sort((x, y) => x.tierMinimumUnits - y.tierMinimumUnits); return b.length > 1 && b[0].tierMinimumUnits === 0 && b[0].retailPrice === 0 ? b[1].tierMinimumUnits : 0; };
    const free = (r, unit) => (freeOf(r) ? ' (first ' + fmtN(freeOf(r)) + unit + ' free)' : '');
    const grad = r => (r.length > 1 ? ' (graduated)' : '');
    const only = !qty.slice(1).some(k => n(c[k]));
    const grants = [];
    const note = (r, what) => { if (freeOf(r)) grants.push(fmtN(freeOf(r)) + ' ' + what); };
    if (n(c.vnetFlowLogsGB) || only) { const r = m('Standard VNet Flow Logs Collected', 'virtual network flow logs'); note(r, 'GB of virtual network flow logs'); lines.push(meterLine(G, S, `Virtual network flow logs collected, ${fmtN(n(c.vnetFlowLogsGB))} GB/month${free(r, ' GB')}`, r, n(c.vnetFlowLogsGB), ctx, { unit: 'GB' })); }
    if (n(c.nsgFlowLogsGB)) { const r = m('Standard Network Logs Collected', 'NSG flow logs'); note(r, 'GB of NSG flow logs'); lines.push(meterLine(G, S, `NSG flow logs collected, ${fmtN(c.nsgFlowLogsGB)} GB/month${free(r, ' GB')}`, r, n(c.nsgFlowLogsGB), ctx, { unit: 'GB' })); }
    if (n(c.trafficAnalyticsGB)) lines.push(meterLine(G, S, `Traffic Analytics processing, ${interval === '10min' ? 'every 10 minutes' : 'every 60 minutes'}, ${fmtN(c.trafficAnalyticsGB)} GB/month`, m(interval === '10min' ? 'Standard Traffic Analytics Processing at 10-Minute Interval' : 'Standard Traffic Analytics Processing', 'Traffic Analytics'), n(c.trafficAnalyticsGB), ctx, { unit: 'GB' }));
    if (n(c.connectionMonitorTests)) { const r = m('Standard Connection Monitor Test', 'Connection Monitor tests'); note(r, 'Connection Monitor tests'); lines.push(meterLine(G, S, `Connection Monitor tests, ${fmtN(c.connectionMonitorTests)}/month${free(r, '')}${grad(r)}`, r, n(c.connectionMonitorTests), ctx, { unit: 'tests' })); }
    if (n(c.diagnosticChecks)) { const r = m('Standard Diagnostic Tool API', 'diagnostic tools'); note(r, 'diagnostic checks'); lines.push(meterLine(G, S, `Network diagnostic tool checks, ${fmtN(c.diagnosticChecks)}/month${free(r, '')}`, r, n(c.diagnosticChecks), ctx, { unit: 'checks' })); }
    const notes = [];
    if (grants.length) notes.push('Free monthly grants in this region (' + grants.join(', ') + ') are deducted before billing. The flow-log grant is per subscription, so this estimate assumes one subscription.');
    else if (lines.length) notes.push('This region has no free monthly grant for the items above; everything is billed from the first unit.');
    if (n(c.trafficAnalyticsGB)) notes.push('Traffic Analytics has no free tier, and its price already absorbs the Log Analytics workspace cost for the analytics.');
    if (n(c.nsgFlowLogsGB)) notes.push('NSG flow logs are retiring (September 30, 2027) and no new ones can be created; virtual network flow logs replace them.');
    if (n(c.vnetFlowLogsGB) || n(c.nsgFlowLogsGB)) notes.push('Flow logs are stored in a storage account; if no retention policy is set, the logs are maintained forever.');
    if (n(c.connectionMonitorTests) || n(c.diagnosticChecks)) notes.push('On a virtual machine scale set, each instance counts as a separate test or check.');
    return { lines, notes, facts: { vnetFlowLogsGB: n(c.vnetFlowLogsGB), nsgFlowLogsGB: n(c.nsgFlowLogsGB), trafficAnalyticsGB: n(c.trafficAnalyticsGB), trafficAnalyticsInterval: interval, connectionMonitorTests: n(c.connectionMonitorTests), diagnosticChecks: n(c.diagnosticChecks), flowLogsGB: n(c.vnetFlowLogsGB) + n(c.nsgFlowLogsGB) } };
  }
};
