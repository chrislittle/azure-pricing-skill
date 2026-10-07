'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice||String(a.meterName).localeCompare(String(b.meterName))); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
async function expected(region, c, currency = 'USD') {
  const accountKey = c.encryption === 'account-key';
  const sku = `${accountKey ? 'Account Encrypted' : 'Standard'} ${c.redundancy}`;
  const rows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Tables' and skuName eq '${sku}'`, currency)).filter(x => x.type === 'Consumption');
  const lines = [];
  const data = pick(rows, x => /Data Stored$/.test(x.meterName), `${sku} data`);
  lines.push(line(`${sku} table data ${c.dataGB} GB`, data, c.dataGB, c.dataGB * data.retailPrice / unitSize(data.unitOfMeasure)));
  if (accountKey) {
    for (const [field, re, label] of [
      ['writeOps', /Write Operations$/, 'write operations'],
      ['batchWriteOps', /Batch Write Operations$/, 'batch write operations'],
      ['readOps', /Read Operations$/, 'read operations'],
      ['listOps', /List Operations$/, 'list operations'],
      ['scanOps', /Scan Operations$/, 'scan operations'],
    ]) if ((c[field] ?? 0) > 0) {
      const row = pick(rows, x => re.test(x.meterName), `${sku} ${label}`);
      lines.push(line(`${sku} ${label} ${c[field]}`, row, c[field], c[field] * row.retailPrice / unitSize(row.unitOfMeasure)));
    }
  } else {
    const txCount = (c.transactions ?? 0) + (c.writeOps ?? 0) + (c.batchWriteOps ?? 0) + (c.readOps ?? 0) + (c.listOps ?? 0) + (c.scanOps ?? 0);
    if (txCount > 0) {
      const tx = pick(rows, x => /Operations$/.test(x.meterName) && !/Additional/.test(x.meterName), `${sku} transactions`);
      lines.push(line(`${sku} table transactions ${txCount}`, tx, txCount, txCount * tx.retailPrice / unitSize(tx.unitOfMeasure)));
    }
  }
  return { monthlyList: total(lines), lines };
}
module.exports = { type:'table-storage', source:'retail-api', cases:[
  { name:'service-key LRS large ops', region:'eastus2', currency:'USD', component:{ type:'table-storage', dataGB:1000, encryption:'service', redundancy:'LRS', writeOps:100000000, readOps:500000000 },
    // Default service-key Tables use Standard LRS capacity plus one transaction price for all reads/writes/deletes: 600M / 10K units.
    expected:()=>expected('eastus2',{dataGB:1000,encryption:'service',redundancy:'LRS',writeOps:100000000,readOps:500000000}) },
  { name:'service-key transactions field', region:'eastus2', currency:'USD', component:{ type:'table-storage', dataGB:100, encryption:'service', redundancy:'ZRS', transactions:1000000 },
    // The current public spec has a transactions field for default encryption; all operation types share the Standard transaction meter.
    expected:()=>expected('eastus2',{dataGB:100,encryption:'service',redundancy:'ZRS',transactions:1000000}) },
  { name:'service-key GRS EUR', region:'westeurope', currency:'EUR', component:{ type:'table-storage', dataGB:1000, encryption:'service', redundancy:'GRS', transactions:10000000 },
    // EUR case: Standard GRS capacity and Standard table transaction meter queried with currencyCode EUR.
    expected:()=>expected('westeurope',{dataGB:1000,encryption:'service',redundancy:'GRS',transactions:10000000},'EUR') },
  { name:'service-key RA-GZRS generic transaction fallback', region:'eastus2', currency:'USD', component:{ type:'table-storage', dataGB:100, encryption:'service', redundancy:'RA-GZRS', writeOps:1000000 },
    // Standard RA-GZRS has no write-specific row; default encryption still bills writes at the generic Standard transaction price.
    expected:()=>expected('eastus2',{dataGB:100,encryption:'service',redundancy:'RA-GZRS',writeOps:1000000}) },
  { name:'account-key RA-GRS per-operation classes', region:'eastus2', currency:'USD', component:{ type:'table-storage', dataGB:100, encryption:'account-key', redundancy:'RA-GRS', writeOps:1000000, batchWriteOps:1000000, readOps:1000000, listOps:1000000, scanOps:1000000 },
    // Account-key Tables use Account Encrypted capacity and distinct per-operation-class meters; deletes are free in that model.
    expected:()=>expected('eastus2',{dataGB:100,encryption:'account-key',redundancy:'RA-GRS',writeOps:1000000,batchWriteOps:1000000,readOps:1000000,listOps:1000000,scanOps:1000000}) },
  { name:'account-key GZRS non-US', region:'westeurope', currency:'USD', component:{ type:'table-storage', dataGB:100, encryption:'account-key', redundancy:'GZRS', writeOps:1000000, readOps:1000000 },
    // Non-US account-key case pins Account Encrypted GZRS capacity and operation meters to westeurope.
    expected:()=>expected('westeurope',{dataGB:100,encryption:'account-key',redundancy:'GZRS',writeOps:1000000,readOps:1000000}) },
] };
