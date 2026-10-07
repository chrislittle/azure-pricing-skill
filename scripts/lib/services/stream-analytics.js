'use strict';
// Azure Stream Analytics: jobs (Standard, Standard V2), dedicated clusters (Dedicated, Dedicated V2) and
// jobs on IoT Edge. The Standard Data Processed (per GB) meter that exists in only a few regions
// (norwayeast, switzerlandnorth, switzerlandwest) is not on the calculator or pricing page and is not priced. Meters: serviceName 'Stream Analytics', regional. Streaming units are billed per hour;
// the V2 SKUs are graduated on monthly aggregated streaming-unit hours (0-730, 730-5,840, 5,840+).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const TIERS = {
  standard: { sku: 'Standard', meter: 'Standard Streaming Unit', label: 'Standard (per job)', cluster: false, v2: false },
  'standard-v2': { sku: 'Standard V2', meter: 'Standard V2 Streaming Unit/Job', label: 'Standard V2 (per job)', cluster: false, v2: true },
  dedicated: { sku: 'Dedicated', meter: 'Dedicated Streaming Unit', label: 'Dedicated (cluster)', cluster: true, v2: false },
  'dedicated-v2': { sku: 'Dedicated V2', meter: 'Dedicated V2 Streaming Unit/Job', label: 'Dedicated V2 (cluster)', cluster: true, v2: true }
};
const THIRD = 1 / 3;

// Accept 0.33/0.34 and 0.66/0.67 as the one-third and two-thirds streaming units V2 offers.
const snap = v => {
  const x = n(v);
  if (Math.abs(x - THIRD) < 0.01) return THIRD;
  if (Math.abs(x - 2 * THIRD) < 0.01) return 2 * THIRD;
  return x;
};
const fmtSu = v => (Math.abs(v - THIRD) < 1e-9 ? '1/3' : Math.abs(v - 2 * THIRD) < 1e-9 ? '2/3' : fmtN(v));

module.exports = {
  type: 'stream-analytics',
  label: 'Azure Stream Analytics',
  family: 'analytics',
  calculator: ['stream-analytics'],
  keywords: ['stream analytics', 'streaming', 'real-time analytics', 'event processing', 'streaming query', 'iot edge analytics', 'telemetry processing'],
  fields: {
    tier: { def: 'standard-v2', enum: Object.keys(TIERS), ask: 'How do you want to run it? One or a few jobs that each get their own capacity -> standard-v2 (recommended; can start as small as one third of a streaming unit). Older per-job model -> standard. A big, isolated, private cluster shared by many jobs -> dedicated-v2 (older: dedicated). If unknown, suggest standard-v2 and record it as an assumption.' },
    streamingUnits: { req: true, ask: 'How much processing power does each job need, in streaming units (a streaming unit is a blend of compute and memory)? A simple query on a small stream: 1 (standard-v2 also allows 1/3 or 2/3). If unknown, suggest 1 for a small job and record it as an assumption. For a dedicated cluster this is the total for the whole cluster (12 to 66 for dedicated-v2, in steps of 12; at least 36 for dedicated). Use 0 if they only need Stream Analytics on IoT Edge devices.' },
    jobs: { int: true, min: 0, def: 1, ask: 'How many separate streaming jobs will run (each with the streaming units above)? Standard and standard-v2 only; a dedicated cluster is billed for its total streaming units.' },
    hours: { min: 0, max: 744, def: HOURS, ask: 'How many hours a month does each job run, or for a dedicated cluster how many hours is the cluster provisioned (730 = all month)? Billing is per hour, based on the largest streaming-unit count selected in that hour. A job stops billing when it is stopped; a cluster is billed hourly for as long as it exists.' },
    edgeDevices: { int: true, min: 0, def: 0, ask: 'Only if they run Stream Analytics on IoT Edge devices: how many devices (an edge gateway counts as one device, however many sensors it serves)? Otherwise 0.' },
    edgeJobsPerDevice: { int: true, min: 1, def: 1, ask: 'Only for IoT Edge: how many Stream Analytics jobs are deployed on each device? Each job on each device is billed per month.' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'stream-analytics', tier: 'standard-v2', streamingUnits: 1 },
    { type: 'stream-analytics', tier: 'standard-v2', streamingUnits: 2, jobs: 4, hours: 500, edgeDevices: 20, edgeJobsPerDevice: 2 },
    { type: 'stream-analytics', tier: 'dedicated-v2', streamingUnits: 12 },
    { type: 'stream-analytics', tier: 'dedicated', streamingUnits: 36 },
    { type: 'stream-analytics', tier: 'standard', streamingUnits: 6, jobs: 2 },
    { type: 'stream-analytics', streamingUnits: 0, edgeDevices: 10 }
  ],
  readback: c => {
    const t = TIERS[(c.tier || 'standard-v2').toLowerCase()] || TIERS['standard-v2'];
    const hrs = n(c.hours ?? HOURS);
    const hoursText = hrs === HOURS ? 'running all month' : `${fmtN(hrs)} hours a month`;
    const parts = [];
    const su = snap(c.streamingUnits);
    if (su > 0) {
      parts.push(t.cluster
        ? `${t.label}: ${fmtSu(su)} streaming units in the cluster, ${hoursText}`
        : `${t.label}: ${fmtN(n(c.jobs ?? 1))} job(s) of ${fmtSu(su)} streaming unit(s) each, ${hoursText}`);
    }
    if (n(c.edgeDevices)) parts.push(`IoT Edge: ${fmtN(c.edgeDevices)} device(s) with ${fmtN(n(c.edgeJobsPerDevice ?? 1))} job(s) each`);
    return `Stream Analytics ${parts.join('; ') || 'nothing selected'}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('streaming-io') ? [] : ['The event sources and outputs (Event Hubs, IoT Hub, Storage, SQL, Power BI and so on) are priced separately; for Stream Analytics on IoT Edge, the IoT Hub that deploys the job is too.'],
  price: async (c, ctx) => {
    const tierKey = (c.tier || 'standard-v2').toLowerCase();
    const t = TIERS[tierKey];
    if (!t) throw new PricingError(`Unknown tier "${c.tier}". Use ${Object.keys(TIERS).join(', ')}.`);
    const su = snap(c.streamingUnits), jobs = n(c.jobs ?? 1), hours = n(c.hours ?? HOURS);
    const devices = n(c.edgeDevices), edgeJobs = n(c.edgeJobsPerDevice ?? 1);
    if (su < 0 || jobs < 0 || devices < 0 || edgeJobs < 0) throw new PricingError('Quantities cannot be negative.');
    if (!Number.isInteger(jobs) || !Number.isInteger(devices) || !Number.isInteger(edgeJobs)) throw new PricingError('jobs, edgeDevices and edgeJobsPerDevice must be whole numbers.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (su === 0 && devices === 0) throw new PricingError('Give streamingUnits, edgeDevices or both.');
    if (su > 0) {
      if (!t.v2 && su !== Math.floor(su)) throw new PricingError(`Fractions of a streaming unit are only available on the V2 tiers; ${tierKey} needs whole streaming units.`);
      if (t.v2 && !t.cluster && su < 1 && su !== THIRD && su !== 2 * THIRD) throw new PricingError('standard-v2 streaming units can be 1/3, 2/3, or a whole number.');
      if (t.v2 && su > 1 && su !== Math.floor(su)) throw new PricingError('standard-v2 streaming units above 1 must be whole numbers.');
      if (tierKey === 'standard' && !(su === 1 || su === 3 || su % 6 === 0)) throw new PricingError('standard streaming units come in steps of 1, 3, 6, 12, 18, 24 ... (1, 3, or a multiple of 6).');
      if (tierKey === 'dedicated-v2' && (su < 12 || su > 66)) throw new PricingError('A dedicated-v2 cluster supports 12 to 66 streaming units, scaled in increments of 12.');
      if (tierKey === 'dedicated' && (su < 36 || su % 6 !== 0)) throw new PricingError('A dedicated cluster needs at least 36 streaming units, in steps of 6.');
      if (t.cluster && jobs > 1) throw new PricingError('A dedicated cluster is billed on its total streaming units; leave jobs at 1 and enter the cluster total in streamingUnits.');
    }
    const rs = await rows(`serviceName eq 'Stream Analytics' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Stream Analytics is not priced in ${ctx.region}.`);
    const G = 'Analytics', S = 'Stream Analytics', lines = [], notes = [];
    if (su > 0) {
      const hit = rs.filter(r => r.skuName === t.sku && r.meterName === t.meter);
      if (!hit.length) throw new PricingError(`Stream Analytics ${t.sku} is not priced in ${ctx.region}.${t.v2 ? ' The V2 tiers are not offered in every region; use the standard tier or a nearby region.' : ''}`);
      const m = single(hit, `Stream Analytics ${t.sku} streaming unit`);
      const suHours = su * (t.cluster ? 1 : jobs) * hours;
      const what = t.cluster
        ? `${t.sku} cluster, ${fmtSu(su)} streaming units x ${fmtN(hours)} hours`
        : `${t.sku} jobs, ${fmtN(jobs)} job(s) x ${fmtSu(su)} streaming unit(s) x ${fmtN(hours)} hours`;
      lines.push(meterLine(G, S, `${what}${m.length > 1 ? ' (graduated)' : ''}`, m, suHours, ctx, { unit: 'streaming-unit hours' }));
      if (t.v2) notes.push('V2 streaming-unit hours are priced in bands on the month\'s total hours on this meter (Standard V2 and Dedicated V2 are tiered separately): the first 730 hours cost the most, hours above 5,840 the least.');
      notes.push(t.cluster ? 'Streaming units are billed per hour, on the highest number selected in that hour; a cluster is billed hourly for as long as it exists, even when its jobs are stopped.' : 'Streaming units are billed per hour, on the highest number selected in that hour, and billing stops when a job is stopped.');
      if (t.cluster) notes.push(tierKey === 'dedicated-v2' ? 'A dedicated V2 cluster is at least 12 streaming units; one streaming unit V2 is one full node.' : 'A dedicated cluster is at least 36 streaming units (6 per node).');
    }
    if (devices) {
      const e = single(rs.filter(r => r.productName === 'Stream Analytics on Edge' && r.meterName === 'S1 Device'), 'Stream Analytics on IoT Edge device');
      lines.push(meterLine(G, S, `Stream Analytics on IoT Edge, ${fmtN(devices)} device(s) x ${fmtN(edgeJobs)} job(s) each, per month`, e, devices * edgeJobs, ctx, { unit: 'job-device / month' }));
      notes.push('IoT Edge is billed per job deployed on each device per month, from deployment, whether the job is running, failed or stopped. Sensors behind one gateway count as a single device.');
    }
    return { lines, notes, facts: { tier: tierKey, streamingUnits: su, jobs: t.cluster ? 1 : jobs, hours, streamingUnitHours: su * (t.cluster ? 1 : jobs) * hours, edgeDevices: devices } };
  }
};
