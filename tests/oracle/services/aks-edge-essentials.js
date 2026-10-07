'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

function totalOf(lines) { return round2(lines.reduce((s, l) => s + l.monthlyList, 0)); }
function line(desc, monthlyList, extra = {}) { return { desc, monthlyList: round2(monthlyList), ...extra }; }
function pickOne(rows, pred, what) {
  const hits = rows.filter(pred);
  if (hits.length !== 1) throw new Error(`expected one AKS Edge Essentials row for ${what}, found ${hits.length}`);
  return hits[0];
}
async function aksEdge({ currency, devices }) {
  const rows = dedupe(await query(`serviceName eq 'AKS Edge Essentials' and productName eq 'AKS Edge Essentials'`, currency));
  const row = pickOne(rows, r => r.skuName === 'Azure Kubernetes Service Edge Essentials' && r.meterName === 'Azure Kubernetes Service Edge Essentials Devices', 'device license');
  const lines = [line(`AKS Edge Essentials devices: ${devices} devices / ${unitSize(row.unitOfMeasure)} * ${row.retailPrice}`, devices / unitSize(row.unitOfMeasure) * row.retailPrice, { meterId: row.meterId })];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'aks-edge-essentials',
  source: 'retail-api',
  cases: [
    {
      name: 'single device', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-edge-essentials', devices: 1 },
      // Retail API global meter is per device-month; one device is one unit.
      expected: async () => aksEdge({ currency: 'USD', devices: 1 }),
    },
    {
      name: 'small edge cluster', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-edge-essentials', devices: 3 },
      // Retail API global device meter bills every licensed physical or virtual device monthly.
      expected: async () => aksEdge({ currency: 'USD', devices: 3 }),
    },
    {
      name: 'fleet deployment', region: 'westeurope', currency: 'USD',
      component: { type: 'aks-edge-essentials', devices: 50 },
      // AKS Edge Essentials is a Global retail meter, so region does not change the per-device monthly USD price.
      expected: async () => aksEdge({ currency: 'USD', devices: 50 }),
    },
    {
      name: 'two-device branch office', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-edge-essentials', devices: 2 },
      // Retail API global device meter bills each licensed device monthly; two devices is two device-months.
      expected: async () => aksEdge({ currency: 'USD', devices: 2 }),
    },
    {
      name: 'EUR retail API devices', region: 'eastus2', currency: 'EUR',
      component: { type: 'aks-edge-essentials', devices: 10 },
      // Retail API EUR exposes the same Global device meter converted to EUR; calculator has no AKS Edge endpoint.
      expected: async () => aksEdge({ currency: 'EUR', devices: 10 }),
    },
    {
      name: 'fractional devices refused', region: 'eastus2', currency: 'USD',
      component: { type: 'aks-edge-essentials', devices: 1.5 },
      expectEngineError: /whole number|integer|devices/i,
    },
  ],
};
