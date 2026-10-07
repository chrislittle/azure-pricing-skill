'use strict';
// Data transfer: inter-region (priced by the source region's continent), cross-availability-zone, and
// internet egress by routing preference (Microsoft global network vs the public internet).
// Meters: serviceName 'Bandwidth'.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);

// Source-continent group used by the inter-continent meters (by region code).
function continentGroup(region) {
  if (/^(eastus|westus|centralus|northcentralus|southcentralus|westcentralus|canada|usgov|usdod|mexico|northeurope|westeurope|uk|france|germany|norway|sweden|switzerland|poland|italy|spain|austria|belgium|denmark|finland|ireland)/.test(region)) return 'NAM or EU';
  if (/^(eastasia|southeastasia|japan|korea|centralindia|southindia|westindia|jioindia|indonesia|malaysia|taiwan)/.test(region)) return 'ASIA';
  if (/^(australia|newzealand)/.test(region)) return 'OCEANIA';
  if (/^(uae|qatar|israel|southafrica|saudi)/.test(region)) return 'MEA';
  if (/^(brazil|chile)/.test(region)) return 'LATAM';
  return null;
}

module.exports = {
  type: 'data-transfer',
  label: 'Data transfer (inter-region, cross-zone, routing preference)',
  family: 'networking',
  calculator: ['bandwidth'],
  keywords: ['data transfer', 'inter-region transfer', 'cross-region replication traffic', 'egress', 'cross-zone traffic', 'availability zone transfer', 'routing preference', 'peering traffic'],
  fields: {
    interRegionGB: { req: true, ask: 'About how many GB a month leave this region for another Azure region (replication, backups, cross-region calls)? Use 0 if none. The rate depends on the continent the data leaves from.' },
    destination: { def: 'same-continent', enum: ['same-continent', 'other-continent'], ask: 'Do the other Azure regions sit on the same continent as this one (same-continent, default) or on a different continent (other-continent, for example Europe to the US)? Different continents cost more per GB.' },
    crossZoneGB: { def: 0, ask: 'GB a month sent between availability zones in this region. Use 0 if unknown; Microsoft does not currently charge for it.' },
    internetEgressGB: { def: 0, ask: 'GB a month sent out to the internet (users, partners)? Use 0 if none. Data coming in is free.' },
    routing: { def: 'microsoft', enum: ['microsoft', 'internet'], ask: 'For internet egress: microsoft (traffic stays on Microsoft\'s network as long as possible, the default) or internet (handed to the public internet early, lower price, lower performance)? Default microsoft.' }
  },
  examples: [
    { type: 'data-transfer', interRegionGB: 5000 },
    { type: 'data-transfer', interRegionGB: 1000, crossZoneGB: 3000, internetEgressGB: 20000, routing: 'internet' },
    { type: 'data-transfer', interRegionGB: 1000, destination: 'other-continent' }
  ],
  readback: c => 'Data transfer from this region: ' + [
    n(c.interRegionGB) ? `${fmtN(n(c.interRegionGB))} GB to Azure regions on ${c.destination === 'other-continent' ? 'other continents' : 'the same continent'}` : '',
    n(c.crossZoneGB) ? `${fmtN(n(c.crossZoneGB))} GB between availability zones (not charged)` : '',
    n(c.internetEgressGB) ? `${fmtN(n(c.internetEgressGB))} GB to the internet (${c.routing === 'internet' ? 'internet routing' : 'Microsoft network routing'})` : ''
  ].filter(Boolean).join(', '),
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : [
    'China-bound and China-sourced data transfer and the China zone meters, which are not priced here.',
    'Inbound data (free), traffic between services in the same zone, and CDN, Front Door or ExpressRoute data charges.',
    'Internet egress is also available as the bandwidth component; do not add the same traffic in both places.'
  ]),
  price: async (c, ctx) => {
    const inter = n(c.interRegionGB), zone = n(c.crossZoneGB), egress = n(c.internetEgressGB);
    if (!inter && !egress) throw new PricingError(zone ? 'Nothing billable: Microsoft does not charge for data transfer between availability zones, and interRegionGB and internetEgressGB are 0.' : 'Nothing to price: interRegionGB and internetEgressGB are 0.');
    const G = 'Networking', S = 'Bandwidth', lines = [], notes = [];
    const base = `serviceName eq 'Bandwidth' and ${regionFilter(ctx)} and priceType eq 'Consumption'`;
    const mgn = (inter || (egress && c.routing !== 'internet')) ? await rows(`${base} and productName eq 'Rtn Preference: MGN'`, ctx) : [];
    const pick = (rs, re, what) => { const m = single(rs.filter(r => re.test(r.meterName)), what); if (!m.length) throw new PricingError(`${what} is not priced in ${ctx.region}.`); return m; };
    if (inter) {
      if (c.destination === 'other-continent') {
        if (/^(usgov|usdod)/.test(ctx.region)) throw new PricingError('Azure Government regions are all in the US, so other-continent transfer is not priced from them; use same-continent.');
        const grp = continentGroup(ctx.region);
        if (!grp) throw new PricingError(`The source continent of ${ctx.region} is not known to this component; price the inter-continent rate from the Bandwidth pricing page.`);
        const ic = await rows(`serviceName eq 'Bandwidth' and armRegionName eq 'Intercontinental' and priceType eq 'Consumption' and productName eq 'Bandwidth Inter-Region' and meterName eq 'Inter Continent Data Transfer Out - ${grp} To Any'`, ctx);
        const im = single(ic, 'Inter-continent data transfer');
        if (!im.length) throw new PricingError(`Inter-continent data transfer from ${ctx.region} is not priced.`);
        lines.push(meterLine(G, S, `Inter-continent data transfer out (${grp} to other continents): ${fmtN(inter)} GB`, im, inter, ctx, { unit: 'GB' }));
        notes.push('Data sent to a different continent is priced by the continent it leaves from, with the first 5 GB a month free.');
      } else {
        lines.push(meterLine(G, S, `Inter-region data transfer out (same continent): ${fmtN(inter)} GB`, pick(mgn, /^Standard Inter-Region Data Transfer$/, 'Inter-region data transfer'), inter, ctx, { unit: 'GB' }));
        notes.push('Transfer between regions on the same continent is priced by the continent of the source region.');
      }
    }
    if (zone) notes.push('Data transfer between availability zones in a region is not charged (Microsoft Learn), so no cost line is added for crossZoneGB.');
    if (egress) {
      if (c.routing === 'internet') {
        const rs = await rows(`${base} and productName eq 'Bandwidth - Routing Preference: Internet'`, ctx);
        lines.push(meterLine(G, S, `Internet egress, internet routing: ${fmtN(egress)} GB`, pick(rs, /^Standard Data Transfer Out$/, 'Internet-routed data transfer out'), egress, ctx, { unit: 'GB' }));
      } else {
        lines.push(meterLine(G, S, `Internet egress, Microsoft network routing: ${fmtN(egress)} GB`, pick(mgn, /^Standard Data Transfer Out$/, 'Data transfer out'), egress, ctx, { unit: 'GB' }));
      }
      notes.push('Internet egress is tiered with a free first 100 GB (shared with other bandwidth lines in the same estimate option); inbound data is free.');
    }
    return { lines, notes, facts: { interRegionGB: inter, crossZoneGB: zone, internetEgressGB: egress, routing: c.routing || 'microsoft' } };
  }
};
