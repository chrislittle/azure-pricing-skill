'use strict';
// AKS Edge Essentials: lightweight Kubernetes for edge devices, licensed per device per month through an
// Azure subscription (cluster connected with Azure Arc). Meter: serviceName 'AKS Edge Essentials', Global, 1/Month.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'aks-edge-essentials',
  label: 'Azure Kubernetes Service Edge Essentials',
  family: 'compute-other',
  calculator: ['aks-ee'],
  keywords: ['aks edge', 'aks edge essentials', 'edge essentials', 'edge device kubernetes', 'k8s on windows iot', 'aks-ee'],
  fields: {
    devices: { req: true, int: true, min: 1, ask: 'How many devices (physical or virtual machines with AKS Edge Essentials installed, counting every machine in a multi-machine cluster) will be licensed? A machine counts once even if it runs both a Linux and a Windows node. Each device is billed per month. If unknown, suggest 1 and record it as an assumption.' }
  },
  context: [],
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The edge hardware, its Windows licence and on-premises power/network: AKS Edge Essentials runs on devices you own.',
    'Services you add to the connected cluster, for example Defender for Containers or Azure Monitor / Log Analytics, which are billed under their own meters. Azure Arc-enabled Kubernetes and GitOps are included in the device price.',
    'Volume licensing: Enterprise Agreement customers can buy an annual licence through the Volume Licensing Service Center instead; it is not billed through Azure and is not priced here.'
  ]),
  examples: [
    { type: 'aks-edge-essentials', devices: 1 },
    { type: 'aks-edge-essentials', devices: 250 }
  ],
  readback: c => `AKS Edge Essentials: ${fmtN(n(c.devices))} device(s) licensed through an Azure subscription, billed per device per month`,
  price: async (c, ctx) => {
    const d = n(c.devices);
    if (!(d > 0) || !Number.isInteger(d)) throw new PricingError('devices must be a whole number greater than 0.');
    const rs = await rows(`serviceName eq 'AKS Edge Essentials' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError('No AKS Edge Essentials price found.');
    const lines = [meterLine('Compute', 'AKS Edge Essentials', `AKS Edge Essentials licence: ${fmtN(d)} device(s) per month`, single(rs, 'AKS Edge Essentials device'), d, ctx, { unit: 'devices / month' })];
    const notes = ['AKS Edge Essentials is priced per device per month through an Azure subscription, with clusters connected to Azure Arc. The same price applies in every commercial Azure region.'];
    if (/^(usgov|usdod|usnat|ussec|china)/i.test(ctx.region)) notes.push('AKS Edge Essentials is not offered in Azure Government or China regions in the Azure calculator; this is the commercial list price and may not apply there.');
    return { lines, notes, facts: { devices: d } };
  }
};
