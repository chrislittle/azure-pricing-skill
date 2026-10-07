'use strict';
// Azure Service Bus: Basic, Standard (base charge + operations + brokered connections), Premium (messaging units),
// plus Hybrid Connections, WCF Relay and Premium geo-replication data transfer.
// Meters: serviceName 'Service Bus', regional.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const hrs = c => c.hours ?? HOURS;
const MU_VALUES = [1, 2, 4, 8, 16];
// Zone 1 = North America and Europe, Zone 3 = South America, Zone 2 = everything else (pricing page); used only where a region exposes several zone meters
const geoZone = region => /^(brazil|chile|argentina|colombia)/.test(region) ? 3 : (/^(us|usgov|canada|mexico)|(east|west|central|north|south)(central)?us\d?$|europe|^uk|france|german|switzerland|norway|sweden|italy|spain|poland|austria|belgium|denmark|finland|greece|ireland/.test(region) ? 1 : 2);

module.exports = {
  type: 'service-bus',
  label: 'Azure Service Bus',
  family: 'messaging',
  calculator: ['service-bus'],
  keywords: ['service bus', 'message queue', 'queue', 'topic', 'messaging', 'publish subscribe', 'relay', 'hybrid connections'],
  fields: {
    tier: { def: 'standard', enum: ['basic', 'standard', 'premium'], ask: 'Do you only need simple queues (basic), or also topics/subscriptions and transactions (standard)? Do you need dedicated, predictable capacity, large messages or zone resilience (premium)? If unknown, suggest standard and record it as an assumption.' },
    operations: { req: true, int: true, min: 0, ask: 'Roughly how many operations a month? A send, a receive and a complete are each one operation, so one message that is sent and received is about 3. A topic with three subscriptions needs 1 send + 3 receives + 3 completes = 7. Messages over 64 KB count once per 64 KB. If you only know messages a month, multiply by those steps. Basic and standard only; for premium use 0. If unknown, suggest 10,000,000 and record it as an assumption.' },
    messagingUnits: { def: 1, int: true, ask: 'Premium only: how many messaging units (dedicated capacity blocks; 1, 2, 4, 8 or 16)? For a partitioned namespace give the total across all partitions. Start with 1 for a small workload, 2 or 4 for production with heavy traffic.' },
    brokeredConnections: { def: 0, int: true, min: 0, ask: 'Standard only: at its peak, how many apps or clients hold an open connection to Service Bus at the same time? The first 1,000 are free.' },
    hybridListeners: { def: 0, int: true, min: 0, ask: 'Only if they use Hybrid Connections to reach on-premises systems: how many listeners (the on-premises side of each connection)?' },
    hybridDataGb: { def: 0, ask: 'Only for Hybrid Connections: how many GB flow through them each month in total? Each listener includes 5 GB free.' },
    relayHours: { def: 0, ask: 'Only for WCF Relay: how many relay hours a month in total (one relay open for a month is about 730 hours)?' },
    relayMessages: { def: 0, int: true, min: 0, ask: 'Only for WCF Relay: how many relay messages a month?' },
    geoReplicationGb: { def: 0, int: true, min: 0, ask: 'Premium only: how many GB a month are copied to the secondary region with geo-replication?' },
    geoReplicas: { int: true, min: 0, ask: 'Premium only: how many secondary regions get a copy with geo-replication? Each secondary runs the same number of messaging units as the primary and is billed for them. If geo-replication is used and you do not know, assume 1.' },
    hours: { def: 730 }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'service-bus', tier: 'standard', operations: 30000000 },
    { type: 'service-bus', tier: 'standard', operations: 150000000, brokeredConnections: 5000, hybridListeners: 2, hybridDataGb: 20, relayHours: 1460, relayMessages: 500000 },
    { type: 'service-bus', tier: 'premium', operations: 0, messagingUnits: 2, geoReplicas: 1, geoReplicationGb: 500 },
    { type: 'service-bus', tier: 'basic', operations: 20000000 }
  ],
  readback: c => {
    const tier = c.tier || 'standard';
    const parts = [];
    if (tier === 'premium') {
      parts.push(`${fmtN(c.messagingUnits ?? 1)} messaging unit(s), ${hrs(c) < HOURS ? `${fmtN(hrs(c))} hours a month` : 'running all month'}`);
      if (n(c.geoReplicationGb) || n(c.geoReplicas)) parts.push(`geo-replicated to ${fmtN(c.geoReplicas ?? 1)} secondary region(s) with the same messaging units in each, ${fmtN(n(c.geoReplicationGb))} GB a month copied`);
    } else {
      parts.push(`${fmtN(n(c.operations))} messaging operations a month`);
      if (tier === 'standard') {
        parts.push(`base charge for ${hrs(c) < HOURS ? `${fmtN(hrs(c))} hours` : 'the whole month'}`);
        if (n(c.brokeredConnections)) parts.push(`${fmtN(c.brokeredConnections)} brokered connections at peak`);
      }
    }
    if (n(c.hybridListeners)) parts.push(`${fmtN(c.hybridListeners)} Hybrid Connections listener(s) for ${hrs(c) < HOURS ? `${fmtN(hrs(c))} hours` : 'the whole month'}`);
    if (n(c.hybridDataGb)) parts.push(`${fmtN(c.hybridDataGb)} GB Hybrid Connections data`);
    if (n(c.relayHours)) parts.push(`${fmtN(c.relayHours)} WCF Relay hours`);
    if (n(c.relayMessages)) parts.push(`${fmtN(c.relayMessages)} WCF Relay messages`);
    return `Service Bus ${tier}: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : ['Data transfer out of Azure (bandwidth) is billed separately from Service Bus.']),
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    const hours = hrs(c);
    const rs = await rows(`serviceName eq 'Service Bus' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Service Bus is not priced in ${ctx.region}.`);
    const pick = (meterName, what, uom) => single(rs.filter(r => r.meterName === meterName && (!uom || r.unitOfMeasure === uom)), `Service Bus ${what}`);
    const G = 'Integration', S = 'Service Bus', lines = [], notes = [], facts = { tier };
    // Retail bands: a zero-price first band is a free grant; US Gov rows instead drop the grant from the bands (first band priced from 0), so it is subtracted here
    const grant = (meter, size, qty, what) => {
      const z = meter.find(r => Number(r.retailPrice) === 0 && Number(r.tierMinimumUnits) === 0);
      const next = z && meter.filter(r => Number(r.tierMinimumUnits) > 0).sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits)[0];
      if (next) return { qty, label: ` (graduated, first ${fmtN(next.tierMinimumUnits * size)} free)` };
      const offset = what === 'ops' ? 13000000 : 1000;
      return { qty: Math.max(0, qty - offset), label: ` (graduated, ${fmtN(offset)} included free, then billed)` };
    };
    if (tier !== 'standard' && n(c.brokeredConnections)) throw new PricingError('Brokered connections are only charged on the standard tier (not basic or premium).');
    if (tier !== 'premium' && (n(c.geoReplicationGb) || n(c.geoReplicas))) throw new PricingError('Geo-replication applies to the premium tier only.');
    if (tier === 'basic') {
      lines.push(meterLine(G, S, `Service Bus Basic: ${fmtN(n(c.operations))} messaging operations/month`, pick('Basic Messaging Operations', 'Basic operations'), n(c.operations), ctx));
      notes.push('Basic bills per million operations (send, receive, complete and similar calls); there is no base charge.');
    } else if (tier === 'standard') {
      lines.push(meterLine(G, S, `Service Bus Standard: base charge, ${fmtN(hours)} hours`, pick('Standard Base Unit', 'Standard base unit', '1/Hour'), hours, ctx, { unit: 'hours' }));
      const ops = pick('Standard Messaging Operations', 'Standard operations');
      const og = grant(ops, 1000000, n(c.operations), 'ops');
      lines.push(meterLine(G, S, `Standard: ${fmtN(n(c.operations))} messaging operations/month${og.label}`, ops, og.qty, ctx));
      if (n(c.brokeredConnections)) {
        const bc = pick('Standard Brokered Connection', 'brokered connections');
        const bg = grant(bc, 1, n(c.brokeredConnections), 'conn');
        lines.push(meterLine(G, S, `Standard: ${fmtN(c.brokeredConnections)} brokered connections at peak${bg.label}`, bc, bg.qty, ctx, { unit: 'connections / month' }));
      }
      notes.push('Standard has a flat base charge per hour plus graduated per-million operation prices; the monthly free allowance of operations and connections is taken from the Retail price bands.');
    } else if (tier === 'premium') {
      const mu = c.messagingUnits ?? 1;
      if (!MU_VALUES.includes(mu)) throw new PricingError(`Premium messaging units can only be bought as ${MU_VALUES.join(', ')}; got ${mu}.`);
      const gb = n(c.geoReplicationGb);
      const secondaries = c.geoReplicas ?? (gb > 0 ? 1 : 0);
      if (gb > 0 && secondaries < 1) throw new PricingError('geoReplicationGb needs at least 1 secondary region (geoReplicas).');
      const replicas = 1 + secondaries;
      lines.push(meterLine(G, S, `Service Bus Premium: ${fmtN(mu)} messaging unit(s) x ${fmtN(hours)} hours`, pick('Premium Messaging Unit', 'Premium messaging unit'), mu * hours, ctx, { unit: 'hours' }));
      if (secondaries) {
        lines.push(meterLine(G, S, `Geo-replication: ${fmtN(secondaries)} secondary region(s) x ${fmtN(mu)} messaging unit(s) x ${fmtN(hours)} hours`, pick('Premium Messaging Unit', 'Premium messaging unit'), secondaries * mu * hours, ctx, { unit: 'hours' }));
        notes.push('Geo-replication bills the primary messaging units again for every secondary region (replicas x messaging units x hours); the secondary hours are priced at the primary region rate.');
      }
      if (gb) {
        const zones = rs.filter(r => /^Geo Replication Zone \d Data Transfer$/.test(r.meterName));
        if (!zones.length) throw new PricingError(`Geo-replication data transfer is not priced for the primary region ${ctx.region}.`);
        const zoneNames = [...new Set(zones.map(r => r.meterName))];
        const pickZone = zoneNames.length > 1 ? `Geo Replication Zone ${geoZone(ctx.region)} Data Transfer` : zoneNames[0];
        lines.push(meterLine(G, S, `Premium geo-replication data transfer, ${fmtN(gb)} GB/month`, single(zones.filter(r => r.meterName === pickZone), 'geo-replication data transfer'), gb, ctx));
      }
      if (n(c.operations)) notes.push('Premium has no per-operation charge; the operations count is not billed.');
      facts.messagingUnits = mu; facts.geoReplicas = secondaries; facts.replicas = replicas;
      notes.push('Premium is billed per messaging unit per hour; there is no separate charge for operations or connections.');
    } else throw new PricingError(`Unknown Service Bus tier "${tier}". Use basic, standard or premium.`);
    if (n(c.hybridListeners)) lines.push(meterLine(G, S, `Hybrid Connections: ${fmtN(c.hybridListeners)} listener(s) x ${fmtN(hours)} hours`, pick('Hybrid Connections Listener Unit', 'Hybrid Connections listener'), n(c.hybridListeners) * hours, ctx, { unit: 'hours' }));
    if (n(c.hybridDataGb)) {
      const lis = Math.max(1, n(c.hybridListeners));
      lines.push(meterLine(G, S, `Hybrid Connections data transfer, ${fmtN(c.hybridDataGb)} GB/month (first 5 GB free per listener)`, pick('Hybrid Connections Data Transfer', 'Hybrid Connections data'), Math.max(0, n(c.hybridDataGb) - 5 * (lis - 1)), ctx));
    }
    if (n(c.relayHours)) lines.push(meterLine(G, S, `WCF Relay: ${fmtN(c.relayHours)} relay hours/month`, pick('WCF Relay', 'WCF Relay hours'), n(c.relayHours), ctx, { unit: 'hours' }));
    if (n(c.relayMessages)) lines.push(meterLine(G, S, `WCF Relay messages: ${fmtN(c.relayMessages)}/month`, pick('WCF Relay Message', 'WCF Relay messages'), n(c.relayMessages), ctx));
    Object.assign(facts, { operations: n(c.operations), brokeredConnections: n(c.brokeredConnections), hybridListeners: n(c.hybridListeners), relayHours: n(c.relayHours) });
    return { lines, notes, facts };
  }
};
