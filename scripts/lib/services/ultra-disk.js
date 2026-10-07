'use strict';
// Azure Ultra Disk: provisioned capacity, IOPS and throughput billed per hour, plus the optional
// per-vCPU reservation charge when Ultra Disk capability is enabled on a VM with no ultra disk attached.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'ultra-disk',
  label: 'Azure Ultra Disk',
  family: 'storage',
  calculator: ['managed-disks'],
  keywords: ['ultra disk', 'ultra ssd', 'high iops disk', 'sub-millisecond disk', 'sql server log disk', 'provisioned iops', 'provisioned throughput'],
  fields: {
    sizeGB: { req: true, min: 4, max: 65536, ask: 'How big should each disk be, in GiB (4 to 65,536)? Ultra Disks are billed on the size you provision, not what is used.' },
    iops: { req: true, min: 100, max: 400000, ask: 'How many IOPS (disk operations per second) does the workload need? Minimum 100; the cap is 1,000 IOPS per GiB of size and 400,000 per disk. If unknown, suggest 5,000 and record it as an assumption.' },
    throughputMBps: { req: true, min: 1, max: 10000, ask: 'What disk throughput in MB/s does it need? Minimum 1; at most 0.25 MB/s per provisioned IOPS and 10,000 per disk. If unknown, suggest 200 and record it as an assumption.' },
    count: { def: 1, int: true, ask: 'How many Ultra Disks with these settings? Use 1 if unknown.' },
    vcpuReservation: { def: 0, int: true, ask: 'Only if the VM has Ultra Disk capability turned on but NO ultra disk attached: how many vCPUs does that VM have? Otherwise 0.' },
    hours: { def: 730, ask: 'Hours a month the disks are provisioned (730 = all month).' }
  },
  examples: [
    { type: 'ultra-disk', sizeGB: 1024, iops: 20000, throughputMBps: 500 },
    { type: 'ultra-disk', sizeGB: 4096, iops: 80000, throughputMBps: 2000, count: 2, vcpuReservation: 16, hours: 600 }
  ],
  readback: c => {
    const hrs = n(c.hours ?? HOURS) === HOURS ? 'all month' : `${fmtN(c.hours)} hours a month`;
    return `Ultra Disk: ${fmtN(n(c.count ?? 1))} disk(s) of ${fmtN(n(c.sizeGB))} GiB, ${fmtN(n(c.iops))} IOPS and ${fmtN(n(c.throughputMBps))} MB/s each, ${hrs}` + (n(c.vcpuReservation) ? `; vCPU reservation for ${fmtN(n(c.vcpuReservation))} vCPUs` : '');
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'The virtual machine the disk attaches to, snapshots, and backup.'
  ]),
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const size = n(c.sizeGB), iops = n(c.iops), mbps = n(c.throughputMBps), cnt = n(c.count ?? 1), vcpu = n(c.vcpuReservation);
    if (iops > size * 1000) throw new PricingError(`An Ultra Disk of ${fmtN(size)} GiB supports at most ${fmtN(size * 1000)} IOPS (1,000 per GiB); raise the size or lower the IOPS.`);
    if (mbps > iops * 0.25) throw new PricingError(`Throughput can be at most 0.25 MB/s per provisioned IOPS (${fmtN(iops * 0.25)} MB/s for ${fmtN(iops)} IOPS).`);
    const rs = await rows(`serviceName eq 'Storage' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Ultra Disks' and skuName eq 'Ultra LRS'`, ctx);
    const m = (re, what) => single(rs.filter(r => re.test(r.meterName)), `Ultra Disk ${what}`);
    const G = 'Storage', S = 'Ultra Disks', lines = [];
    if (cnt) {
      lines.push(meterLine(G, S, `Ultra Disk capacity: ${fmtN(cnt)} x ${fmtN(size)} GiB x ${fmtN(hours)} hours`, m(/Provisioned Capacity/i, 'capacity'), cnt * size * hours, ctx, { unit: 'GiB-hours' }));
      lines.push(meterLine(G, S, `Ultra Disk IOPS: ${fmtN(cnt)} x ${fmtN(iops)} IOPS x ${fmtN(hours)} hours`, m(/Provisioned IOPS/i, 'IOPS'), cnt * iops * hours, ctx, { unit: 'IOPS-hours' }));
      lines.push(meterLine(G, S, `Ultra Disk throughput: ${fmtN(cnt)} x ${fmtN(mbps)} MB/s x ${fmtN(hours)} hours`, m(/Provisioned Throughput/i, 'throughput'), cnt * mbps * hours, ctx, { unit: 'MBps-hours' }));
    }
    if (vcpu) lines.push(meterLine(G, S, `Ultra Disk vCPU reservation: ${fmtN(vcpu)} vCPUs x ${fmtN(hours)} hours`, m(/vCPU/i, 'vCPU reservation'), vcpu * hours, ctx, { unit: 'vCPU-hours' }));
    return { lines, notes: ['Ultra Disks are billed hourly on provisioned size, IOPS and throughput; there is no free baseline.', 'Ultra Disks are locally redundant only and cannot be used as an OS disk.'], facts: { sizeGB: size, iops, throughputMBps: mbps, count: cnt, vcpuReservation: vcpu } };
  }
};
