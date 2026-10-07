'use strict';
// Azure IoT Operations: per node per hour, regionless (Global). Two tiers, Basic and Essentials.
// Azure Device Registry (assets and devices, per hour) is priced alongside because it is billed
// with IoT Operations deployments.
const { rows, single, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'iot-operations',
  label: 'Azure IoT Operations',
  family: 'iot',
  calculator: ['iot-operations'],
  keywords: ['iot operations', 'edge iot', 'arc kubernetes iot', 'mqtt broker', 'industrial', 'opc ua', 'factory', 'device registry'],
  fields: {
    nodes: { req: true, int: true, min: 1, ask: 'How many machines (Kubernetes nodes in your Azure Arc-enabled Kubernetes cluster) will actually run Azure IoT Operations? Count only the nodes that run it, not every node in the cluster. If unknown, suggest 3 and record it as an assumption.' },
    tier: { def: 'basic', enum: ['basic', 'essentials'], ask: 'Use basic, the per-node price shown on the Azure IoT Operations pricing page. Only choose essentials if the person says Microsoft told them they are on the Essentials offer (a lower per-node price that appears in the price list but not on the pricing page; confirm it with Microsoft). If unknown, use basic.' },
    hours: { def: 730, min: 0, max: 744, ask: 'How many hours a month will it run? All month = 730. Billing is hourly, so part-time use costs proportionally less.' },
    deviceRegistryAssets: { def: 0, int: true, min: 0, ask: 'Optional: how many assets (machines, sensors, equipment) will be registered in Azure Device Registry? If none, 0.' },
    deviceRegistryDevices: { def: 0, int: true, min: 0, ask: 'Optional: how many devices will be registered in Azure Device Registry? If none, 0.' }
  },
  examples: [
    { type: 'iot-operations', nodes: 3 },
    { type: 'iot-operations', nodes: 5, tier: 'basic', hours: 400, deviceRegistryAssets: 200, deviceRegistryDevices: 50 },
    { type: 'iot-operations', nodes: 2, tier: 'essentials' }
  ],
  readback: c => {
    const hours = c.hours ?? HOURS;
    const parts = [`${fmtN(n(c.nodes))} node(s) running IoT Operations ${hours !== HOURS ? `${fmtN(hours)} hours a month` : 'all month'}`];
    if (n(c.deviceRegistryAssets)) parts.push(`${fmtN(c.deviceRegistryAssets)} Device Registry assets`);
    if (n(c.deviceRegistryDevices)) parts.push(`${fmtN(c.deviceRegistryDevices)} Device Registry devices`);
    return `Azure IoT Operations ${c.tier || 'basic'} tier: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('iot-ops-infrastructure') ? [] : ['The Arc-enabled Kubernetes cluster and the hardware or VMs it runs on, plus the Azure services IoT Operations sends data to, are priced separately.'],
  price: async (c, ctx) => {
    const tier = (c.tier || 'basic').toLowerCase();
    if (!['essentials', 'basic'].includes(tier)) throw new PricingError(`IoT Operations tier "${c.tier}" is not valid; use essentials or basic.`);
    if (!(n(c.nodes) > 0)) throw new PricingError('Azure IoT Operations needs the number of nodes.');
    const hours = c.hours ?? HOURS;
    const rs = await rows(`serviceName eq 'Azure IoT Operations' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    const meter = single(rs.filter(r => r.meterName === (tier === 'basic' ? 'Basic Node' : 'Essentials Azure IoT Operations Node')), `IoT Operations ${tier} node`);
    const G = 'IoT', lines = [];
    lines.push(meterLine(G, 'Azure IoT Operations', `IoT Operations ${tier}: ${fmtN(n(c.nodes))} node(s) x ${fmtN(hours)} hours`, meter, n(c.nodes) * hours, ctx, { unit: 'node-hours' }));
    if (n(c.deviceRegistryAssets) || n(c.deviceRegistryDevices)) {
      const dr = await rows(`serviceName eq 'Azure Device Registry' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
      if (n(c.deviceRegistryAssets)) lines.push(meterLine(G, 'Azure Device Registry', `Device Registry assets, ${fmtN(c.deviceRegistryAssets)} x ${fmtN(hours)} hours`, single(dr.filter(r => r.meterName === 'Asset'), 'Device Registry asset'), n(c.deviceRegistryAssets) * hours, ctx, { unit: 'asset-hours' }));
      if (n(c.deviceRegistryDevices)) lines.push(meterLine(G, 'Azure Device Registry', `Device Registry devices, ${fmtN(c.deviceRegistryDevices)} x ${fmtN(hours)} hours`, single(dr.filter(r => r.meterName === 'Device Device'), 'Device Registry device'), n(c.deviceRegistryDevices) * hours, ctx, { unit: 'device-hours' }));
    }
    return {
      lines,
      notes: ['Billed per node per hour for the nodes that actually run IoT Operations workloads, not every node in the cluster; the price is the same in every region.', ...(tier === 'essentials' ? ['The Essentials per-node price is in the Azure price list but not on the Azure IoT Operations pricing page; confirm with Microsoft that your deployment is billed at it. Basic is the published price.'] : []), 'Microsoft treats the first 30 days of usage as a trial period with no billing; this estimate prices a full month.'],
      facts: { tier, nodes: n(c.nodes), hours, region: ctx.region }
    };
  }
};
