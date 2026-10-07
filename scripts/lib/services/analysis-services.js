'use strict';
// Azure Analysis Services: Developer, Basic (B1, B2) and Standard (S0-S9, S8 v2, S9 v2) servers, plus
// query replicas (scale-out) on Standard tiers. Meters: serviceName 'Azure Analysis Services', regional,
// one hourly meter per size; scale-out replicas have their own meter at the same rate as the primary.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
// meter = Retail API meterName. qpu and memory are the calculator's published sizes.
const TIERS = {
  developer: { meter: 'Developer', label: 'Developer', gb: 3, qpu: 10, scaleOut: false },
  b1: { meter: 'B1', label: 'Basic B1', gb: 10, qpu: 40, scaleOut: false },
  b2: { meter: 'B2', label: 'Basic B2', gb: 16, qpu: 80, scaleOut: false },
  s0: { meter: 'S0', label: 'Standard S0', gb: 10, qpu: 40, scaleOut: true },
  s1: { meter: 'S1', label: 'Standard S1', gb: 25, qpu: 100, scaleOut: true },
  s2: { meter: 'S2', label: 'Standard S2', gb: 50, qpu: 200, scaleOut: true },
  s4: { meter: 'S4', label: 'Standard S4', gb: 100, qpu: 400, scaleOut: true },
  s8: { meter: 'S8', label: 'Standard S8', gb: 200, qpu: 320, scaleOut: true },
  's8-v2': { meter: 'S8 v2', label: 'Standard S8 v2', gb: 200, qpu: 640, scaleOut: true },
  s9: { meter: 'S9', label: 'Standard S9', gb: 400, qpu: 640, scaleOut: true },
  's9-v2': { meter: 'S9 v2', label: 'Standard S9 v2', gb: 400, qpu: 1280, scaleOut: true }
};

const ALIAS = { s8v2: 's8-v2', s9v2: 's9-v2', d1: 'developer' };
const tierKey = v => { const k = String(v || 's1').toLowerCase().trim().replace(/[\s_]+/g, '-'); return ALIAS[k] || ALIAS[k.replace(/-/g, '')] || k; };

module.exports = {
  type: 'analysis-services',
  label: 'Azure Analysis Services',
  family: 'analytics',
  calculator: ['analysis-services'],
  keywords: ['analysis services', 'tabular model', 'semantic model', 'olap', 'cube', 'bi model', 'ssas', 'query replicas'],
  fields: {
    tier: { req: true, def: 's1', enum: Object.keys(TIERS), ask: 'How big is the data model held in memory, and how many people query it at once? Learning or testing (up to 3 GB) -> developer; small production model up to 10 GB -> b1 (up to 16 GB -> b2, both without query replicas); production with replicas and partitions: up to 10 GB -> s0, 25 GB -> s1, 50 GB -> s2, 100 GB -> s4, 200 GB -> s8-v2, 400 GB -> s9-v2 (s8 and s9 are deprecated, so use s8-v2 and s9-v2 instead). If unknown, suggest s1 and record it as an assumption.' },
    instances: { int: true, min: 0, def: 1, ask: 'How many separate Analysis Services servers of that size? Most people need 1.' },
    hours: { min: 0, max: 744, def: HOURS, ask: 'How many hours a month does each server run (730 = all month)? Compute billing stops while a server is paused, so pausing it outside business hours saves money; for example 10 hours x 22 working days = 220.' },
    queryReplicas: { def: 0, int: true, min: 0, max: 7, ask: 'Standard tiers only: how many extra read-only copies (query replicas) will you add so more people can query at the same time? Each replica costs the same per hour as the main server. 0 if none.' },
    replicaHours: { min: 0, max: 744, def: HOURS, ask: 'Only if you use query replicas: how many hours a month does each replica run (730 = all month)? Replicas can be added only at busy times to save money.' }
  },
  context: ['production', 'idlePeriods'],
  examples: [
    { type: 'analysis-services', tier: 'b1' },
    { type: 'analysis-services', tier: 's2', instances: 2, hours: 220, queryReplicas: 3, replicaHours: 160 },
    { type: 'analysis-services', tier: 's9-v2', queryReplicas: 1 },
    { type: 'analysis-services', tier: 'developer', hours: 100 }
  ],
  readback: c => {
    const key = tierKey(c.tier);
    const t = TIERS[key];
    const hrs = n(c.hours ?? HOURS);
    const hoursText = h => (h === HOURS ? 'running all month' : `${fmtN(h)} hours a month`);
    let s = `Analysis Services ${t ? t.label : key}${t ? ` (${fmtN(t.gb)} GB memory, ${fmtN(t.qpu)} query processing units)` : ''}: ${fmtN(n(c.instances ?? 1))} server(s), ${hoursText(hrs)}`;
    if (n(c.queryReplicas)) s += `; ${fmtN(c.queryReplicas)} query replica(s) per server, ${hoursText(n(c.replicaHours ?? HOURS))}`;
    return s;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('analysis-source-data') ? [] : ['The data sources the model loads from (SQL, Data Lake, Synapse and so on) and any storage for backups are priced separately.'],
  price: async (c, ctx) => {
    const key = tierKey(c.tier);
    const t = TIERS[key];
    if (!t) throw new PricingError(`Unknown tier "${c.tier}". Use ${Object.keys(TIERS).join(', ')}.`);
    const instances = n(c.instances ?? 1), hours = n(c.hours ?? HOURS);
    const replicas = n(c.queryReplicas), rHours = n(c.replicaHours ?? HOURS);
    if (instances < 0 || replicas < 0) throw new PricingError('instances and queryReplicas cannot be negative.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (replicas > 0 && (rHours < 0 || rHours > 744)) throw new PricingError('replicaHours must be between 0 and 744 (the longest month).');
    if (replicas > 0 && rHours > hours) throw new PricingError(`replicaHours (${fmtN(rHours)}) cannot be more than the server's hours (${fmtN(hours)}); a replica runs only while its server runs.`);
    if (!Number.isInteger(instances) || !Number.isInteger(replicas)) throw new PricingError('instances and queryReplicas must be whole numbers.');
    if (replicas > 7) throw new PricingError('queryReplicas can be at most 7 (up to 8 instances including the primary server).');
    if (replicas > 0 && !t.scaleOut) throw new PricingError(`${t.label} does not support query replicas (scale-out); use a Standard tier (s0 or larger).`);
    const rs = await rows(`serviceName eq 'Azure Analysis Services' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    const S = 'Azure Analysis Services', G = 'Analytics', lines = [];
    const m = (name, what) => {
      const hit = rs.filter(r => r.meterName === name);
      if (!hit.length) throw new PricingError(`Analysis Services ${what} is not priced in ${ctx.region}; it is not offered in every region.`);
      return single(hit, `Analysis Services ${what}`);
    };
    lines.push(meterLine(G, S, `Analysis Services ${t.label} (${fmtN(t.gb)} GB, ${fmtN(t.qpu)} QPU), ${fmtN(instances)} server(s) x ${fmtN(hours)} hours`, m(t.meter, t.label), instances * hours, ctx, { unit: 'server hours' }));
    if (replicas) lines.push(meterLine(G, S, `${t.label} query replicas (scale-out), ${fmtN(instances)} server(s) x ${fmtN(replicas)} replica(s) x ${fmtN(rHours)} hours`, m(`${t.meter} Scale-Out`, `${t.label} scale-out`), instances * replicas * rHours, ctx, { unit: 'replica hours' }));
    const notes = ['Analysis Services is billed per hour for each server while it is running; pausing a server stops the compute charge.'];
    if (key === 's8' || key === 's9') notes.push(`${t.label} is deprecated; Microsoft recommends the v2 size (${key}-v2), which has twice the query processing units.`);
    if (replicas) notes.push('Each query replica is billed at the same hourly rate as the primary server of that size.');
    return { lines, notes, facts: { tier: key, instances, hours, queryReplicas: replicas, replicaHours: rHours, memoryGB: t.gb, qpu: t.qpu } };
  }
};
