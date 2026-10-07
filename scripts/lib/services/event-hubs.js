'use strict';
// Azure Event Hubs: Basic / Standard (throughput units + ingress events + Capture), Premium (processing units),
// Dedicated (capacity units), extended retention beyond the included storage, and geo-replication data transfer.
// Meters: serviceName 'Event Hubs', regional. Hourly meters are matched on the '1 Hour' unit because a few regions also carry a '1/Day' row.
// Not priced: the Retail 'Standard Kafka Endpoint' meter. The Azure calculator has no offer for it and the pricing page lists Kafka as available on Standard without a price.
// Premium and Dedicated geo-replication bill the same units again in the secondary region (Learn: Geo-replication in Azure Event Hubs, Pricing).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const hrs = c => c.hours ?? HOURS;
const UNIT = { basic: 'throughput unit(s)', standard: 'throughput unit(s)', premium: 'processing unit(s)', dedicated: 'capacity unit(s)' };
const MAX = { basic: 40, standard: 40, premium: 16, dedicated: 20 };
const PREMIUM_PU = [1, 2, 4, 6, 8, 10, 12, 16];
const INCLUDED_GB = { premium: 1024, dedicated: 10 * 1024 }; // per PU / per CU, as stated in the calculator

module.exports = {
  type: 'event-hubs',
  label: 'Azure Event Hubs',
  family: 'messaging',
  calculator: ['event-hubs'],
  keywords: ['event hubs', 'event streaming', 'kafka', 'telemetry ingestion', 'streaming', 'event ingestion', 'event stream'],
  fields: {
    tier: { def: 'standard', enum: ['basic', 'standard', 'premium', 'dedicated'], ask: 'How big and how critical is the event stream? Small/dev workloads -> basic or standard (standard adds Capture, Kafka and more consumer groups). Production with isolation and predictable performance -> premium. Very large single-tenant clusters (gigabytes per second) -> dedicated. If unknown, suggest standard and record it as an assumption.' },
    units: { req: true, ask: 'How much capacity do you need? Basic/standard: throughput units (1 unit = 1 MB/s or 1,000 events/s in, 2 MB/s out; start with 1-2). Premium: processing units (1, 2, 4, 6, 8, 10, 12 or 16). Dedicated: capacity units (start with 1). With auto-inflate on, count the highest throughput units you allow it to grow to. If unknown, suggest 2 and record it as an assumption.' },
    ingressEvents: { def: 0, int: true, ask: 'Basic and standard only: how many events a month will be sent in (in total, not millions)? Every 64 KB of a message counts as one event, so a 96 KB message is two. Premium and dedicated include ingress in the unit price.' },
    capture: { def: false, ask: 'Standard only: do you want Event Hubs Capture to automatically save the stream into Blob Storage or Data Lake? Capture is billed per throughput unit per hour.' },
    retainedGb: { def: 0, ask: 'Premium/dedicated only: how many GB of events do you want to keep stored in total? Each processing unit includes 1 TB and each capacity unit includes 10 TB; only the amount above that is billed.' },
    geoReplicationGb: { def: 0, int: true, ask: 'Premium/dedicated only: how many GB a month are replicated to a second region with geo-replication?' },
    geoReplication: { def: false, ask: 'Premium/dedicated only: will a second region keep a copy with geo-replication? The secondary region runs the same number of units and is billed too.' },
    geoSecondaryRegion: { def: '', ask: 'Only with geo-replication: which Azure region is the secondary? If unknown, assume the same region and record it as an assumption.' },
    hours: { def: 730 }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'event-hubs', tier: 'standard', units: 2, ingressEvents: 500000000 },
    { type: 'event-hubs', tier: 'standard', units: 4, ingressEvents: 2000000000, capture: true },
    { type: 'event-hubs', tier: 'premium', units: 2, retainedGb: 5000, geoReplication: true, geoReplicationGb: 300 },
    { type: 'event-hubs', tier: 'dedicated', units: 1, retainedGb: 12000, geoReplication: true, geoReplicationGb: 100, hours: 730 },
    { type: 'event-hubs', tier: 'premium', units: 6, geoReplication: true, geoSecondaryRegion: 'northeurope' },
    { type: 'event-hubs', tier: 'basic', units: 1, ingressEvents: 100000000 }
  ],
  readback: c => {
    const tier = c.tier || 'standard';
    const parts = [`${fmtN(n(c.units))} ${UNIT[tier] || 'unit(s)'}, ${hrs(c) < HOURS ? `${fmtN(hrs(c))} hours a month` : 'running all month'}`];
    if ((tier === 'basic' || tier === 'standard')) parts.push(`${fmtN(n(c.ingressEvents))} events in a month`);
    if (c.capture) parts.push('Capture to storage switched on');
    if (n(c.retainedGb)) parts.push(`${fmtN(c.retainedGb)} GB of events retained`);
    if (c.geoReplication || n(c.geoReplicationGb)) parts.push(`geo-replicated to a second region${c.geoSecondaryRegion ? ` (${c.geoSecondaryRegion})` : ''} with the same units there, ${fmtN(n(c.geoReplicationGb))} GB a month copied`);
    return `Event Hubs ${tier}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : ['Storage for Capture output (Blob Storage or Data Lake), and data transfer out of Azure.', 'Basic and standard: stored events beyond 84 GB per throughput unit (billed at the locally redundant blob storage rate) and AMQP connections above the free allowance (billed at Service Bus connection rates).']),
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!MAX[tier]) throw new PricingError(`Unknown Event Hubs tier "${tier}". Use basic, standard, premium or dedicated.`);
    const units = n(c.units);
    if (units <= 0) throw new PricingError('Event Hubs needs at least 1 unit.');
    if (tier === 'premium' && !PREMIUM_PU.includes(units)) throw new PricingError(`Premium processing units can only be bought as ${PREMIUM_PU.join(', ')}; got ${units}.`);
    if (units > MAX[tier]) throw new PricingError(`Event Hubs ${tier} supports at most ${MAX[tier]} ${UNIT[tier]} in the calculator; got ${units}.`);
    if (c.capture && tier !== 'standard') throw new PricingError('Capture is billed separately on the standard tier only (premium and dedicated include it in the unit price).');
    const geo = !!(c.geoReplication || n(c.geoReplicationGb));
    if (tier !== 'premium' && tier !== 'dedicated' && (n(c.retainedGb) || geo)) throw new PricingError('Extended retention and geo-replication apply to the premium and dedicated tiers only.');
    const rs = await rows(`serviceName eq 'Event Hubs' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Event Hubs is not priced in ${ctx.region}.`);
    const pick = (meterName, what, from = rs) => single(from.filter(r => r.meterName === meterName && (!/Unit$|Capture$/.test(meterName) || r.unitOfMeasure === '1 Hour')), `Event Hubs ${what}`);
    const G = 'Analytics', S = 'Event Hubs', lines = [], notes = [];
    let hours = hrs(c);
    if (tier === 'dedicated' && hours < 4) { hours = 4; notes.push('Dedicated clusters are billed for a minimum of 4 hours.'); }
    const TIER = tier[0].toUpperCase() + tier.slice(1);
    if (tier === 'basic' || tier === 'standard') {
      lines.push(meterLine(G, S, `Event Hubs ${TIER}: ${fmtN(units)} throughput unit(s) x ${fmtN(hours)} hours`, pick(`${TIER} Throughput Unit`, `${tier} throughput unit`), units * hours, ctx, { unit: 'hours' }));
      lines.push(meterLine(G, S, `${TIER} ingress events, ${fmtN(n(c.ingressEvents))}/month`, pick(`${TIER} Ingress Events`, `${tier} ingress events`), n(c.ingressEvents), ctx));
      if (c.capture) lines.push(meterLine(G, S, `Capture: ${fmtN(units)} throughput unit(s) x ${fmtN(hours)} hours`, pick('Standard Capture', 'Capture'), units * hours, ctx, { unit: 'hours' }));
      notes.push('Throughput units are billed every hour they exist, even when no events flow, and units added by auto-inflate are billed too. Ingress is billed per million events (64 KB each).');
      if (tier === 'standard') notes.push('The Standard Kafka Endpoint meter listed in the Retail Prices API is not priced here; the Azure calculator does not include it.');
    } else if (tier === 'premium') {
      lines.push(meterLine(G, S, `Event Hubs Premium: ${fmtN(units)} processing unit(s) x ${fmtN(hours)} hours`, pick('Premium Processing Unit', 'premium processing unit'), units * hours, ctx, { unit: 'hours' }));
      notes.push('Premium processing units include throughput, ingress and Capture; 1 TB of retention per processing unit is included.');
    } else {
      lines.push(meterLine(G, S, `Event Hubs Dedicated: ${fmtN(units)} capacity unit(s) x ${fmtN(hours)} hours`, pick('Dedicated Capacity Unit', 'dedicated capacity unit'), units * hours, ctx, { unit: 'hours' }));
      notes.push('Dedicated capacity units include throughput, ingress and Capture; 10 TB of retention per capacity unit is included.');
      if (units > 10) notes.push('More than 10 capacity units needs a support request (Learn); the calculator allows up to 20.');
    }
    let overage = 0;
    if (n(c.retainedGb)) {
      const included = INCLUDED_GB[tier] * units;
      overage = Math.max(0, n(c.retainedGb) - included);
      if (overage > 0) lines.push(meterLine(G, S, `Extended retention: ${fmtN(overage)} GB above the ${fmtN(included)} GB included (${fmtN(c.retainedGb)} GB kept)`, pick(`${TIER} Extended Retention`, `${tier} extended retention`), overage, ctx));
      else notes.push(`${fmtN(c.retainedGb)} GB retained is within the ${fmtN(included)} GB included (1 TB = 1,024 GB assumed), so there is no retention charge.`);
    }
    if (geo) {
      const secRegion = (c.geoSecondaryRegion || ctx.region).toLowerCase();
      const srs = secRegion === ctx.region ? rs : await rows(`serviceName eq 'Event Hubs' and ${regionFilter({ region: secRegion })} and priceType eq 'Consumption'`, ctx);
      if (!srs.length) throw new PricingError(`Event Hubs is not priced in the secondary region ${secRegion}.`);
      const name = tier === 'premium' ? 'Premium Processing Unit' : 'Dedicated Capacity Unit';
      lines.push(meterLine(G, S, `Geo-replication secondary ${tier === 'premium' ? 'processing' : 'capacity'} unit(s) in ${secRegion}: ${fmtN(units)} x ${fmtN(hours)} hours`, pick(name, `${tier} secondary units in ${secRegion}`, srs), units * hours, ctx, { unit: 'hours' }));
      notes.push(tier === 'premium'
        ? 'Premium geo-replication runs the same number of processing units in the secondary region, billed in addition to the primary.'
        : 'Dedicated geo-replication needs a second dedicated cluster in another region, billed separately from the primary.');
      if (n(c.geoReplicationGb)) {
        const gm = rs.filter(r => /^Geo Replication Zone \d Data Transfer$/.test(r.meterName));
        if (!gm.length) throw new PricingError(`Geo-replication data transfer is not priced for the primary region ${ctx.region}.`);
        lines.push(meterLine(G, S, `Geo-replication data transfer, ${fmtN(c.geoReplicationGb)} GB/month`, single(gm, 'geo-replication data transfer'), n(c.geoReplicationGb), ctx));
      }
    }
    return { lines, notes, facts: { tier, units, ingressEvents: n(c.ingressEvents), geoReplication: geo, capture: !!c.capture, retainedGb: n(c.retainedGb), extendedRetentionOverageGb: overage, hours } };
  }
};
