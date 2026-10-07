'use strict';
// Azure Database Migration Service (classic, portal-created service). Premium tier is billed per vCore-hour
// while the service is running (4, 8 or 16 vCores in the Retail Prices API; the calculator shows 4). A new
// Premium 4-vCore service is free for its first 183 days. The Standard tier is free. Legacy Basic and
// General Purpose compute meters with non-zero prices are not sold any more and are not priced.
// Classic DMS was retired for SQL Server scenarios on 15 March 2026, so SQL Server sources are refused here.
// Meters: serviceName 'Azure Database Migration Service', regional. The calculator also offers 1- and 3-year
// savings plans, which the Retail Prices API returns as savingsPlan rates on the Premium compute meters.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const PREMIUM_SIZES = [4, 8, 16];
const COMMIT = { payg: null, 'savings-1y': '1 Year', 'savings-3y': '3 Years' };
const RETIRED = 'Microsoft Learn: "After August 1, 2023, you can\'t create new Database Migration Service (classic) resources for SQL Server scenarios from Azure portal. The service is retired from March 15, 2026 for all customers."';

module.exports = {
  type: 'database-migration',
  label: 'Azure Database Migration Service (classic)',
  family: 'management',
  calculator: ['database-migration'],
  keywords: ['database migration', 'dms', 'migrate database', 'online migration', 'offline migration', 'migration service', 'mysql migration', 'postgresql migration', 'mongodb migration'],
  fields: {
    engine: { def: 'other', enum: ['other', 'mysql', 'postgresql', 'mongodb', 'sql-server'], ask: 'Which database engine are they migrating from? MySQL -> mysql; PostgreSQL -> postgresql; MongoDB -> mongodb; SQL Server (including Azure SQL targets) -> sql-server; anything else -> other. Always ask: the classic service can no longer be used for SQL Server migrations. If unknown, do not guess; ask.' },
    tier: { def: 'premium', enum: ['standard', 'premium'], ask: 'Do they need online migrations (the source database stays live during the move, minimal downtime)? Yes -> premium (billed per vCore-hour). A one-off offline migration where downtime is fine -> standard (free). If unknown, use premium and record it as an assumption.' },
    vcores: { req: true, ask: 'How many vCores should the migration service have? Premium: 4, 8 or 16 (bigger moves data faster; 4 is the size the calculator shows and the only one with the free first six months). Standard (free): 1, 2 or 4. If unknown, suggest 4 and record it as an assumption.' },
    instances: { def: 1, int: true, min: 1, max: 10, ask: 'How many migration service instances will run at the same time? A subscription can have 10 by default. If unknown, use 1.' },
    hours: { def: 730, min: 0, max: 744, ask: 'For how many hours a month will each instance be running? Premium is billed per hour while the service is running; a stopped service is not billed, and the service stops itself after 24 hours with no activity. A two-week migration is about 336 hours; all month is 730.' },
    newService: { def: true, ask: 'Premium 4-vCore only: is this a brand-new migration service, created for this migration and deleted within 6 months of creation? The first 183 days of each new 4-vCore Premium service are free. Yes -> true; an older service or a bigger size -> false. If unknown, use true and record it as an assumption.' },
    commitment: { def: 'payg', enum: Object.keys(COMMIT), ask: 'Do they plan a 1- or 3-year compute savings plan for a lower hourly rate? Almost never for a short migration. No -> payg; 1 year -> savings-1y; 3 years -> savings-3y. If unknown, use payg.' }
  },
  examples: [
    { type: 'database-migration', engine: 'postgresql', vcores: 4, hours: 336, newService: false },
    { type: 'database-migration', engine: 'mysql', tier: 'premium', vcores: 16, instances: 2, hours: 730, commitment: 'savings-1y' },
    { type: 'database-migration', engine: 'mongodb', tier: 'standard', vcores: 2, hours: 200 },
    { type: 'database-migration', engine: 'mysql', vcores: 4, hours: 336 }
  ],
  readback: c => {
    const h = c.hours ?? HOURS, i = c.instances == null ? 1 : n(c.instances), tier = c.tier || 'premium';
    const free = tier === 'standard' ? ' (free tier)' : (n(c.vcores) === 4 && c.newService !== false && (c.commitment || 'payg') === 'payg' ? ' (new service: first 183 days free)' : '');
    return `Database Migration Service ${tier}${free}: ${fmtN(i)} instance(s) of ${fmtN(n(c.vcores))} vCores running ${fmtN(h)} hours each${h === HOURS ? ' (all month)' : ''}${c.commitment && c.commitment !== 'payg' ? `, ${c.commitment === 'savings-1y' ? '1-year' : '3-year'} savings plan rate` : ''}`;
  },
  notIncluded: (types, spec) => (spec.excluded || []).includes('dms-extras') ? [] : [
    'The target database and any network link (ExpressRoute, VPN) used for the move.'
  ],
  mayBeZero: true,
  price: async (c, ctx) => {
    const tier = (c.tier || 'premium').toLowerCase(), engine = (c.engine || 'other').toLowerCase();
    const vcores = n(c.vcores), instances = c.instances == null ? 1 : n(c.instances), hours = c.hours ?? HOURS, commit = c.commitment || 'payg';
    if (engine === 'sql-server') throw new PricingError(`Database Migration Service (classic) can no longer be used for SQL Server migrations. ${RETIRED} Use the current Azure Database Migration Service (https://learn.microsoft.com/azure/dms/dms-overview), which this recipe does not price.`);
    if (tier !== 'premium' && tier !== 'standard') throw new PricingError('tier must be "standard" or "premium".');
    if (!vcores) throw new PricingError('How many vCores should the migration service have? Premium: 4, 8 or 16; Standard (free): 1, 2 or 4.');
    if (!Number.isInteger(instances) || instances < 1) throw new PricingError('instances must be a whole number of at least 1.');
    if (instances > 10) throw new PricingError('A subscription can have 10 Database Migration Service (classic) instances by default; ask Microsoft support to raise the limit and use at most 10 here.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (!(commit in COMMIT)) throw new PricingError(`Unknown commitment "${commit}". Use payg, savings-1y or savings-3y.`);
    const G = 'Management', S = 'Azure Database Migration Service';
    const rs = await rows(`serviceName eq 'Azure Database Migration Service' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Database Migration Service is not priced in ${ctx.region}.`);
    const prem = v => single(rs.filter(r => r.productName === 'Azure Database Migration Service Premium Compute' && r.meterName === `${v} vCore`), `DMS Premium ${v} vCore compute`);
    const zero = mr => mr.map(r => Object.assign({}, r, { retailPrice: 0 }));
    if (tier === 'standard') {
      if (![1, 2, 4].includes(vcores)) throw new PricingError('The free Standard tier has 1, 2 or 4 vCores.');
      if (commit !== 'payg') throw new PricingError('Savings plans apply to the Premium tier only.');
      let free = rs.filter(r => r.productName === 'Azure Database Migration Service Basic Compute' && r.meterName === '1 vCore vCore - Free');
      if (!free.length) free = zero(prem(4));
      return {
        lines: [meterLine(G, S, `Standard tier (free, offline migrations): ${fmtN(instances)} instance(s) of ${fmtN(vcores)} vCores, ${fmtN(hours)} hours each`, single(free, 'DMS Standard (free) compute'), instances * hours, ctx, { unit: 'hours' })],
        notes: ['The Standard tier supports offline migrations and is free to use.'],
        facts: { tier, engine, vcores, instances, hours, commitment: commit, freePeriod: false }
      };
    }
    if (!PREMIUM_SIZES.includes(vcores)) throw new PricingError(`Premium tier vCores must be one of ${PREMIUM_SIZES.join(', ')}.`);
    let mr = prem(vcores), label = '';
    const freePeriod = vcores === 4 && c.newService !== false && commit === 'payg';
    if (freePeriod) {
      mr = zero(mr);
      label = ', new service: first 183 days free';
    } else if (COMMIT[commit]) {
      const term = COMMIT[commit];
      mr = mr.map(r => {
        const sp = (r.savingsPlan || []).find(s => s.term === term);
        if (!sp) throw new PricingError(`No ${term} savings plan rate for DMS Premium ${vcores} vCore in ${ctx.region}.`);
        return Object.assign({}, r, { retailPrice: sp.retailPrice });
      });
      label = `, ${term} savings plan rate`;
    }
    const notes = ['Premium is billed per vCore-hour while the service is running. A stopped service is not billed, and the service stops itself after 24 hours with no activity; stop or delete it when the migration is finished.',
      'A Database Migration Service (classic) resource can be used for up to 1 year from its creation, and a subscription can have 10 of them by default.'];
    if (freePeriod) notes.push('Microsoft: a new Premium 4-vCore service is free for 6 months (183 days) from its creation date, then charged at the normal hourly rate; this estimate assumes the whole period is inside the free window. Set newService to false for an older service.');
    else if (vcores !== 4) notes.push('The free first six months apply to the 4-vCore Premium size only.');
    if (COMMIT[commit]) notes.push('A savings plan is an hourly spend commitment for the whole term, billed every hour whether or not the service runs; this line shows the discounted rate only for the hours entered.');
    return {
      lines: [meterLine(G, S, `Premium tier: ${fmtN(instances)} instance(s) of ${fmtN(vcores)} vCores, ${fmtN(hours)} hours each${label}`, mr, instances * hours, ctx, { unit: 'hours' })],
      notes,
      facts: { tier, engine, vcores, instances, hours, commitment: commit, freePeriod, newService: c.newService !== false, commitmentUnderused: commit !== 'payg' && hours < HOURS }
    };
  }
};