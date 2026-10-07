'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');

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

function kbBlocks(kb) {
  return Math.ceil(kb || 0);
}

async function retailDigitalTwins({ region, currency, operations = 0, responseKb = 1, messages = 0, messageKb = 1, queries = 0, queryUnitsPerQuery = 2.45, queryResponseKb = 1, queryUnits = 0 }) {
  const rows = dedupe(await query(`serviceName eq 'Digital Twins' and productName eq 'Digital Twins' and armRegionName eq '${region}'`, currency));
  const ops = pickOne(rows, r => r.skuName === 'Standard' && r.meterName === 'Standard Operations' && r.type === 'Consumption', 'standard operations');
  const msg = pickOne(rows, r => r.skuName === 'Standard' && r.meterName === 'Standard Message' && r.type === 'Consumption', 'standard messages');
  const qry = pickOne(rows, r => r.skuName === 'Standard' && r.meterName === 'Standard Query Units' && r.type === 'Consumption', 'standard query units');
  const billedOperations = operations * kbBlocks(responseKb) + queries * kbBlocks(queryResponseKb);
  const billedMessages = messages * kbBlocks(messageKb);
  const billedQueryUnits = queryUnits + queries * queryUnitsPerQuery;
  const lines = [];
  if (billedOperations) lines.push(line(`operations: ${billedOperations} 1KB blocks / ${unitSize(ops.unitOfMeasure)} * ${ops.retailPrice}`, (billedOperations / unitSize(ops.unitOfMeasure)) * ops.retailPrice, { meterId: ops.meterId }));
  if (billedMessages) lines.push(line(`messages: ${billedMessages} 1KB blocks / ${unitSize(msg.unitOfMeasure)} * ${msg.retailPrice}`, (billedMessages / unitSize(msg.unitOfMeasure)) * msg.retailPrice, { meterId: msg.meterId }));
  if (billedQueryUnits) lines.push(line(`query units: ${billedQueryUnits} / ${unitSize(qry.unitOfMeasure)} * ${qry.retailPrice}`, (billedQueryUnits / unitSize(qry.unitOfMeasure)) * qry.retailPrice, { meterId: qry.meterId }));
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'digital-twins',
  source: 'retail-api',
  cases: [
    {
      name: 'operations only',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 1000000, messages: 0, queryUnits: 0 },
      // Retail API Standard Operations meter is per 1K operations.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', operations: 1000000 }),
    },
    {
      name: 'messages only',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 0, messages: 2000000, queryUnits: 0 },
      // Retail API Standard Message meter is per 1K routed messages.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', messages: 2000000 }),
    },
    {
      name: 'query units only',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 0, messages: 0, queryUnits: 100000 },
      // Retail API Standard Query Units meter is per 1K query units.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', queryUnits: 100000 }),
    },
    {
      name: 'all dimensions east us 2',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 1500000, messages: 250000, queryUnits: 500000 },
      // Retail API meters bill operations, messages and query units independently, each per 1K.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', operations: 1500000, messages: 250000, queryUnits: 500000 }),
    },
    {
      name: 'unit boundary around 1k operations',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 1001, messages: 999, queryUnits: 1000 },
      // Retail API unit is 1K; fractional 1K quantities are billed proportionally for 1,001 operations and 999 messages.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', operations: 1001, messages: 999, queryUnits: 1000 }),
    },
    {
      name: 'west europe regional price',
      region: 'westeurope',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 1000000, messages: 1000000, queryUnits: 1000000 },
      // Retail API West Europe meters are higher than East US 2: operations 0.00325, messages 0.0013 and query units 0.00065 per 1K.
      expected: async () => retailDigitalTwins({ region: 'westeurope', currency: 'USD', operations: 1000000, messages: 1000000, queryUnits: 1000000 }),
    },
    {
      name: 'eur all dimensions',
      region: 'eastus2',
      currency: 'EUR',
      component: { type: 'digital-twins', operations: 1000000, messages: 1000000, queryUnits: 1000000 },
      // Retail API EUR meters for East US 2 are per 1K for all three Digital Twins dimensions.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'EUR', operations: 1000000, messages: 1000000, queryUnits: 1000000 }),
    },
    {
      name: 'operation responses round 1.5 KB to two blocks',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 1000000, responseKb: 1.5, messages: 0, queries: 0, queryUnits: 0 },
      // Pricing spec says each started 1 KB of reply counts as one operation: 1,000,000 calls * ceil(1.5 KB) = 2,000,000 operation blocks.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', operations: 1000000, responseKb: 1.5 }),
    },
    {
      name: 'operation responses round 2.3 KB to three blocks',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 1000000, responseKb: 2.3, messages: 0, queries: 0, queryUnits: 0 },
      // Pricing spec says each started 1 KB of reply counts as one operation: 1,000,000 calls * ceil(2.3 KB) = 3,000,000 operation blocks.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', operations: 1000000, responseKb: 2.3 }),
    },
    {
      name: 'event messages over 1 KB round to message blocks',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 0, messages: 1000000, messageKb: 2.3, queries: 0, queryUnits: 0 },
      // Retail API Standard Message meter is per 1K message blocks; 2.3 KB payloads count as ceil(2.3)=3 messages each.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', messages: 1000000, messageKb: 2.3 }),
    },
    {
      name: 'queries count operations plus calculated query units',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 0, messages: 0, queries: 1000000, queryResponseKb: 2.3, queryUnitsPerQuery: 2.45, queryUnits: 0 },
      // Query calls bill both operation blocks for the reply and query units: 1,000,000 * ceil(2.3 KB) operations plus 1,000,000 * 2.45 query units.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', queries: 1000000, queryResponseKb: 2.3, queryUnitsPerQuery: 2.45 }),
    },
    {
      name: 'queries add explicit query units',
      region: 'eastus2',
      currency: 'USD',
      component: { type: 'digital-twins', operations: 100000, responseKb: 1.5, queries: 100000, queryResponseKb: 1.5, queryUnitsPerQuery: 2.45, queryUnits: 100000, messages: 100000, messageKb: 1.5 },
      // Operations, query replies and event messages all round up by 1 KB blocks; query units are queries*2.45 plus the explicit 100,000 units.
      expected: async () => retailDigitalTwins({ region: 'eastus2', currency: 'USD', operations: 100000, responseKb: 1.5, queries: 100000, queryResponseKb: 1.5, queryUnitsPerQuery: 2.45, queryUnits: 100000, messages: 100000, messageKb: 1.5 }),
    },
  ],
};
