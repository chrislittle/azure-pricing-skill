'use strict';
// Azure Managed Grafana. Standard: compute units per workspace-hour (X1 = 2, X2 = 4) + optional zone redundancy units (X1 = 1, X2 = 2) + per active user/month.
// Essential (deprecated): per active user only.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
// Compute units per workspace and zone-redundancy units per workspace (pricing page: X1 = 2 / 1, X2 = 4 / 2)
const SIZE = { x1: { su: 2, zru: 1 }, x2: { su: 4, zru: 2 } };

module.exports = {
  type: 'managed-grafana',
  label: 'Azure Managed Grafana',
  family: 'management',
  calculator: ['managed-grafana'],
  keywords: ['grafana', 'dashboards', 'monitoring dashboards', 'prometheus dashboards', 'metrics visualization', 'visualization'],
  fields: {
    tier: { def: 'standard', enum: ['standard', 'essential'], ask: 'Which Grafana plan? Standard is the default and the only plan that new workspaces can use (it has an SLA and zone redundancy). Essential is deprecated and only for existing workspaces: use essential only if they say they already run it.' },
    users: { req: true, ask: 'How many different people (plus any service accounts or API keys) will use Grafana in a month, counted once even if they use several workspaces under the same subscription? Each active user is billed monthly. If unknown, suggest 5 and record it as an assumption.' },
    size: { def: 'x1', enum: ['x1', 'x2'], ask: 'Standard only: the default size (x1) suits most teams; choose x2 only if they need roughly twice the capacity (more memory and up to 1,000 alert rules instead of 500). On x2 only the hourly workspace and zone-redundancy charges double; the per-user charge does not change.' },
    instances: { def: 1, ask: 'How many separate Grafana workspaces (instances) do they need? Most teams need 1.' },
    zoneRedundancy: { def: false, ask: 'Standard only: should Grafana survive the loss of a whole datacenter (zone redundancy, an extra hourly charge)? Yes for production that must stay up; the choice can only be made when the workspace is created.' },
    hours: { def: 730, ask: 'Hours a month each workspace exists (730 = all month).' }
  },
  context: ['production'],
  examples: [
    { type: 'managed-grafana', users: 3 },
    { type: 'managed-grafana', tier: 'standard', size: 'x2', users: 25, instances: 2, zoneRedundancy: true, hours: 730 },
    { type: 'managed-grafana', tier: 'essential', users: 4 }
  ],
  readback: c => {
    const tier = (c.tier || 'standard').toLowerCase();
    const inst = c.instances ?? 1;
    const hrs = c.hours ?? HOURS;
    const base = `Managed Grafana ${tier}: ${fmtN(n(c.users))} active users`;
    if (tier === 'essential') return base;
    const sz = SIZE[(c.size || 'x1').toLowerCase()] || SIZE.x1;
    return `${base}, ${fmtN(inst)} ${(c.size || 'x1').toUpperCase()} workspace(s) of ${sz.su} compute units each running ${hrs === HOURS ? 'all month' : fmtN(hrs) + ' hours a month'}, ${c.zoneRedundancy ? `zone redundant (${sz.zru} extra unit(s) each)` : 'not zone redundant'}`;
  },
  price: async (c, ctx) => {
    const tier = (c.tier || 'standard').toLowerCase();
    if (!['standard', 'essential'].includes(tier)) throw new PricingError('tier must be "standard" or "essential".');
    const size = (c.size || 'x1').toLowerCase();
    if (!SIZE[size]) throw new PricingError('size must be "x1" or "x2".');
    if (tier === 'essential' && size === 'x2') throw new PricingError('The x2 size is only available on the Standard plan.');
    const sku = tier === 'essential' ? 'Essential' : 'Standard';
    const users = n(c.users), inst = n(c.instances ?? 1), hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (users < 0 || inst < 0) throw new PricingError('users and instances must not be negative.');
    if (tier === 'essential' && c.zoneRedundancy) throw new PricingError('Zone redundancy is only available on the Standard plan.');
    const rs = (await rows(`serviceName eq 'Azure Grafana Service' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx)).filter(r => r.productName === 'Azure Managed Grafana');
    if (!rs.length) throw new PricingError(`Azure Managed Grafana is not priced in ${ctx.region}.`);
    const lines = [];
    const G = 'Management', S = 'Azure Grafana Service';
    const { su, zru } = SIZE[size];
    if (tier === 'standard' && inst) {
      lines.push(meterLine(G, S, `Managed Grafana Standard ${size.toUpperCase()}: ${fmtN(inst)} workspace(s) x ${su} compute units x ${fmtN(hours)} hours`, single(rs.filter(r => r.meterName === 'Standard Node'), 'Grafana Standard compute unit hours'), inst * su * hours, ctx, { unit: 'compute unit-hours' }));
      if (c.zoneRedundancy) lines.push(meterLine(G, S, `Zone redundancy: ${fmtN(inst)} workspace(s) x ${zru} unit(s) x ${fmtN(hours)} hours`, single(rs.filter(r => r.meterName === 'Standard Zone Redundancy'), 'Grafana zone redundancy unit hours'), inst * zru * hours, ctx, { unit: 'zone redundancy unit-hours' }));
    }
    const um = rs.filter(r => r.meterName === `${sku} User`);
    if (!um.length) throw new PricingError(`Grafana ${sku} is not offered in ${ctx.region}${tier === 'essential' ? ' (and new Essential workspaces cannot be created); price Standard instead' : ''}.`);
    lines.push(meterLine(G, S, `Managed Grafana ${sku} active users, ${fmtN(users)}/month`, single(um, `Grafana ${sku} users`), users, ctx, { unit: 'users / month' }));
    const notes = ['Managed Grafana bills each active user (a unique person, service account or API key) once a month per subscription, however many workspaces they use. Standard also bills compute every hour the workspace exists: X1 is 2 compute units and X2 is 4; zone redundancy adds 1 unit (X1) or 2 (X2).',
      'There is no charge for the first 30 days of a new Grafana instance (one instance per Azure subscription); this steady-state monthly estimate does not subtract it.',
      'The optional Grafana Enterprise plugins are sold by Grafana Labs through Azure Marketplace and are not included.'];
    if (tier === 'essential') notes.push('The Essential plan is deprecated: new workspaces cannot be created on it.');
    return { lines, notes, facts: { tier, size, users, instances: inst, zoneRedundancy: !!c.zoneRedundancy } };
  }
};
