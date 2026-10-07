'use strict';
const { query, dedupe, unitSize, round2 } = require('../api');
function pick(rows, pred, what) { const hits = rows.filter(pred); if (!hits.length) throw new Error(`Oracle: no meter for ${what}`); hits.sort((a,b)=>a.retailPrice-b.retailPrice||a.tierMinimumUnits-b.tierMinimumUnits); return hits[0]; }
function line(desc, row, qty, cost) { return { desc, meterId: row.meterId, meterName: row.meterName, productName: row.productName, skuName: row.skuName, unitOfMeasure: row.unitOfMeasure, unitPrice: row.retailPrice, qty, monthlyList: round2(cost) }; }
function total(lines) { return round2(lines.reduce((s,l)=>s+l.monthlyList,0)); }
function title(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function tier(rows, qty) { const t=rows.slice().sort((a,b)=>a.tierMinimumUnits-b.tierMinimumUnits); let cost=0,bands=[]; for(let i=0;i<t.length;i++){ const start=t[i].tierMinimumUnits,end=i+1<t.length?t[i+1].tierMinimumUnits:Infinity; if(qty<=start) break; const units=Math.min(qty,end)-start; cost += units*t[i].retailPrice/unitSize(t[i].unitOfMeasure); bands.push({ fromUnits:start, toUnits:end===Infinity?null:end, units, unitPrice:t[i].retailPrice }); } return { cost, bands, row:t.find(x=>x.retailPrice>0)||t[0] }; }
async function expected(region, c, currency='USD') {
  const isPremium = c.tier === 'premium';
  const product = isPremium ? 'Premium ADLS Gen2 Hierarchical Namespace' : 'Azure Data Lake Storage Gen2 Hierarchical Namespace';
  const sku = isPremium ? `Premium ${c.redundancy}` : `${title(c.tier)} ${c.redundancy}`;
  const rows = dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq '${product}' and skuName eq '${sku}'`, currency)).filter(x=>x.type==='Consumption');
  const lines=[];
  if ((c.dataGB ?? 0) > 0) { const ds=rows.filter(x=>/Data Stored$/.test(x.meterName)); const t=tier(ds,c.dataGB); const l=line(`${sku} ADLS Gen2 data ${c.dataGB} GB`, t.row, c.dataGB, t.cost); l.bands=t.bands; lines.push(l); }
  if ((c.metadataGB ?? 0) > 0) { const r=pick(rows,x=>/Index|MetaData Storage/.test(x.meterName),`${sku} metadata/index`); lines.push(line(`${sku} metadata/index ${c.metadataGB} GB`,r,c.metadataGB,c.metadataGB*r.retailPrice/unitSize(r.unitOfMeasure))); }
  const opSpecs = [ ['writeOps', /^((?!Iterative).)*Write Operations$/, 'write operations'], ['readOps', /Read Operations$/, 'read operations'], ['iterativeWriteOps', /Iterative Write Operations$/, 'iterative write operations'], ['iterativeReadOps', /Iterative Read Operations$/, 'iterative read operations'], ['otherOps', /Other Operations$/, 'other operations'] ];
  for (const [field,re,label] of opSpecs) if ((c[field] ?? 0) > 0) { const r=pick(rows,x=>re.test(x.meterName),`${sku} ${label}`); lines.push(line(`${sku} ${label} ${c[field]}`,r,c[field],c[field]*r.retailPrice/unitSize(r.unitOfMeasure))); }
  if ((c.queryScannedGB ?? 0) > 0) { const r=pick(rows,x=>/Data Scanned for Query Acceleration$/.test(x.meterName),`${sku} query acceleration scanned`); lines.push(line(`${sku} query acceleration scanned ${c.queryScannedGB} GB`,r,c.queryScannedGB,c.queryScannedGB*r.retailPrice/unitSize(r.unitOfMeasure))); }
  if ((c.queryReturnedGB ?? 0) > 0) { const r=pick(rows,x=>/Data Returned for Query Acceleration$/.test(x.meterName),`${sku} query acceleration returned`); lines.push(line(`${sku} query acceleration returned ${c.queryReturnedGB} GB`,r,c.queryReturnedGB,c.queryReturnedGB*r.retailPrice/unitSize(r.unitOfMeasure))); }
  if ((c.dataRetrievalGB ?? 0) > 0) { const r=pick(rows,x=>/Data Retrieval$/.test(x.meterName),`${sku} data retrieval`); lines.push(line(`${sku} data retrieval ${c.dataRetrievalGB} GB`,r,c.dataRetrievalGB,c.dataRetrievalGB*r.retailPrice/unitSize(r.unitOfMeasure))); }
  if ((c.geoReplicationGB ?? 0) > 0) { const gr=dedupe(await query(`serviceName eq 'Storage' and armRegionName eq '${region}' and productName eq 'Storage - Bandwidth' and skuName eq 'Geo-Replication v2'`, currency)).filter(x=>x.type==='Consumption'); const r=pick(gr,x=>x.meterName==='Geo-Replication v2 Data Transfer',`${sku} geo-replication`); lines.push(line(`${sku} geo-replication ${c.geoReplicationGB} GB`,r,c.geoReplicationGB,c.geoReplicationGB*r.retailPrice/unitSize(r.unitOfMeasure))); }
  return { monthlyList: total(lines), lines };
}
module.exports = { type: 'data-lake-storage', source: 'retail-api', cases: [
  { name: 'hot LRS graduated and HNS ops', region: 'eastus2', currency: 'USD', component: { type: 'data-lake-storage', dataGB: 60000, tier: 'hot', redundancy: 'LRS', metadataGB: 10, writeOps: 20000, readOps: 50000, iterativeWriteOps: 1000, iterativeReadOps: 10000, otherOps: 5000 },
    // Hot LRS data storage walks graduated Data Stored bands; HNS metadata/index and operation meters are added per their units.
    expected: () => expected('eastus2', { dataGB: 60000, tier: 'hot', redundancy: 'LRS', metadataGB: 10, writeOps: 20000, readOps: 50000, iterativeWriteOps: 1000, iterativeReadOps: 10000, otherOps: 5000 }) },
  { name: 'cool ZRS retrieval', region: 'eastus2', currency: 'USD', component: { type: 'data-lake-storage', dataGB: 1000, tier: 'cool', redundancy: 'ZRS', writeOps: 10000, readOps: 10000, dataRetrievalGB: 100 },
    // Cool ZRS includes Data Stored, Write/Read Operations and Data Retrieval per-GB meters.
    expected: () => expected('eastus2', { dataGB: 1000, tier: 'cool', redundancy: 'ZRS', writeOps: 10000, readOps: 10000, dataRetrievalGB: 100 }) },
  { name: 'cold GRS', region: 'eastus2', currency: 'USD', component: { type: 'data-lake-storage', dataGB: 2000, tier: 'cold', redundancy: 'GRS', writeOps: 10000, readOps: 10000, dataRetrievalGB: 50 },
    // Cold GRS uses the Cold GRS SKU's storage, operation and data retrieval meters.
    expected: () => expected('eastus2', { dataGB: 2000, tier: 'cold', redundancy: 'GRS', writeOps: 10000, readOps: 10000, dataRetrievalGB: 50 }) },
  { name: 'archive RA-GRS', region: 'eastus2', currency: 'USD', component: { type: 'data-lake-storage', dataGB: 5000, tier: 'archive', redundancy: 'RA-GRS', writeOps: 10000, readOps: 10000, dataRetrievalGB: 100 },
    // Archive RA-GRS bills low-cost storage plus higher archive read and retrieval meters.
    expected: () => expected('eastus2', { dataGB: 5000, tier: 'archive', redundancy: 'RA-GRS', writeOps: 10000, readOps: 10000, dataRetrievalGB: 100 }) },
  { name: 'hot GZRS non-US', region: 'westeurope', currency: 'USD', component: { type: 'data-lake-storage', dataGB: 1000, tier: 'hot', redundancy: 'GZRS', writeOps: 10000, readOps: 10000 },
    // Non-US case pins Hot GZRS ADLS Gen2 HNS storage and operation meters to westeurope.
    expected: () => expected('westeurope', { dataGB: 1000, tier: 'hot', redundancy: 'GZRS', writeOps: 10000, readOps: 10000 }) },
  { name: 'cool RA-GZRS EUR', region: 'westeurope', currency: 'EUR', component: { type: 'data-lake-storage', dataGB: 1000, tier: 'cool', redundancy: 'RA-GZRS', writeOps: 10000, readOps: 10000, dataRetrievalGB: 20 },
    // EUR case queries Cool RA-GZRS HNS meters with currencyCode EUR.
    expected: () => expected('westeurope', { dataGB: 1000, tier: 'cool', redundancy: 'RA-GZRS', writeOps: 10000, readOps: 10000, dataRetrievalGB: 20 }, 'EUR') },
  { name: 'premium LRS metadata and operations', region: 'eastus2', currency: 'USD', component: { type: 'data-lake-storage', dataGB: 1000, tier: 'premium', redundancy: 'LRS', metadataGB: 20, writeOps: 10000, readOps: 30000, iterativeWriteOps: 20000, iterativeReadOps: 10000, otherOps: 10000 },
    // Premium ADLS Gen2 HNS bills Data Stored, MetaData Storage and premium operation meters (iterative writes are per 100).
    expected: () => expected('eastus2', { dataGB: 1000, tier: 'premium', redundancy: 'LRS', metadataGB: 20, writeOps: 10000, readOps: 30000, iterativeWriteOps: 20000, iterativeReadOps: 10000, otherOps: 10000 }) },
  { name: 'cool GRS query acceleration and geo', region: 'eastus2', currency: 'USD', component: { type: 'data-lake-storage', dataGB: 8000, tier: 'cool', redundancy: 'GRS', writeOps: 1000000, dataRetrievalGB: 100, queryScannedGB: 500, queryReturnedGB: 50, geoReplicationGB: 400 },
    // Cool GRS covers query acceleration scanned/returned plus Geo-Replication v2 data transfer.
    expected: () => expected('eastus2', { dataGB: 8000, tier: 'cool', redundancy: 'GRS', writeOps: 1000000, dataRetrievalGB: 100, queryScannedGB: 500, queryReturnedGB: 50, geoReplicationGB: 400 }) },
] };
