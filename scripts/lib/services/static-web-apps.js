'use strict';
// Azure Static Web Apps (Free and Standard plans). Meters: serviceName 'Azure App Service', productName 'Static Web Apps', regional.
// Standard is billed per app per month; outbound bandwidth has a free first band (100 GB a month per subscription) and a paid overage rate;
// the optional enterprise-grade edge (Azure Front Door add-on) is billed per app per hour. The Free plan has no meter ($0).
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);

module.exports = {
  type: 'static-web-apps',
  label: 'Azure Static Web Apps',
  family: 'web-other',
  calculator: ['app-service\\static'],
  keywords: ['static web app', 'static site', 'jamstack', 'single page app', 'react', 'angular', 'website hosting', 'frontend'],
  mayBeZero: true,
  fields: {
    plan: { def: 'standard', enum: ['free', 'standard'], ask: 'Is this a personal or hobby project with no uptime guarantee needed -> free; a production site, or one that needs private endpoints, custom authentication or a support plan -> standard. If unknown, suggest standard and record it as an assumption.' },
    apps: { req: true, int: true, min: 1, ask: 'How many separate static web apps (each one is its own site, for example one per environment or per product)? If unknown, use 1 and record it as an assumption.' },
    bandwidthGB: { def: 0, min: 0, ask: 'About how many GB a month will visitors download from all the apps together? The first 100 GB a month per Azure subscription is free. If unknown, use 0 and record it as an assumption.' },
    enterpriseEdgeApps: { def: 0, int: true, min: 0, ask: 'Only if they want faster loading worldwide and extra protection through Azure Front Door built into the app ("enterprise-grade edge"): for how many of the apps? Standard plan only. Most people need 0.' },
    hours: { def: 730, min: 0, max: 744, ask: 'Enterprise-grade edge only: hours a month it is switched on (730 = all month).' }
  },
  context: ['production', 'internetFacing'],
  examples: [
    { type: 'static-web-apps', plan: 'standard', apps: 1 },
    { type: 'static-web-apps', plan: 'standard', apps: 3, bandwidthGB: 250, enterpriseEdgeApps: 1, hours: 730 },
    { type: 'static-web-apps', plan: 'free', apps: 1, bandwidthGB: 20 }
  ],
  readback: c => `Static Web Apps ${c.plan || 'standard'} plan: ${fmtN(n(c.apps))} app(s), ${fmtN(n(c.bandwidthGB))} GB downloaded a month${n(c.enterpriseEdgeApps) ? `, enterprise-grade edge (Azure Front Door) on ${fmtN(c.enterpriseEdgeApps)} app(s) for ${(c.hours ?? HOURS) === HOURS ? 'the whole month' : `${fmtN(c.hours)} hours a month`}` : ''}`,
  notIncluded: () => ['Back-end APIs outside the built-in managed Functions, and any databases or storage the site calls'],
  price: async (c, ctx) => {
    const plan = (c.plan || 'standard').toLowerCase();
    if (!['free', 'standard'].includes(plan)) throw new PricingError(`Unknown plan "${c.plan}". Use free or standard.`);
    const apps = n(c.apps), gb = n(c.bandwidthGB), edge = n(c.enterpriseEdgeApps), hours = c.hours ?? HOURS;
    if (!Number.isInteger(apps) || apps < 1) throw new PricingError('apps must be a whole number of 1 or more.');
    if (!Number.isInteger(edge) || edge < 0 || edge > apps) throw new PricingError('enterpriseEdgeApps must be a whole number from 0 up to the number of apps.');
    if (gb < 0) throw new PricingError('bandwidthGB cannot be negative.');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    if (plan === 'free' && edge) throw new PricingError('Enterprise-grade edge (Azure Front Door) needs the standard plan.');
    const rs = await rows(`serviceName eq 'Azure App Service' and productName eq 'Static Web Apps' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) {
      const all = await rows("serviceName eq 'Azure App Service' and productName eq 'Static Web Apps' and priceType eq 'Consumption'", ctx);
      const regs = [...new Set(all.map(r => r.armRegionName).filter(Boolean))].sort();
      throw new PricingError(`Static Web Apps is not priced in ${ctx.region}.${regs.length ? ` Retail prices are published for: ${regs.join(", ")}. You can price it in one of those regions and choose that region for the app; Microsoft says the static content is "served from points geographically distributed around the world" (https://learn.microsoft.com/azure/static-web-apps/overview).` : ""}`);
    }
    const G = 'Web', S = 'Azure App Service', lines = [];
    const led = ctx.ledger || (ctx.ledger = {});
    if (plan === 'free') {
      led['swa-free-apps'] = (led['swa-free-apps'] || 0) + apps;
      led['swa-free-gb'] = (led['swa-free-gb'] || 0) + gb;
      if (led['swa-free-apps'] > 10) throw new PricingError('The free plan allows at most 10 apps per Azure subscription; use the standard plan.');
      if (led['swa-free-gb'] > 100) throw new PricingError('The free plan includes 100 GB of bandwidth a month per subscription and cannot go over it; use the standard plan.');
      lines.push(Object.assign(meterLine(G, S, `Static Web Apps Free plan: ${fmtN(apps)} app(s) (no charge)`, single(rs.filter(r => r.meterName === 'Standard App'), 'Standard app'), 0, ctx, { unit: 'apps / month' }), { unitPrice: 0 }));
    } else {
      led['swa-std-apps'] = (led['swa-std-apps'] || 0) + apps;
      lines.push(meterLine(G, S, `Static Web Apps Standard plan: ${fmtN(apps)} app(s)`, single(rs.filter(r => r.meterName === 'Standard App'), 'Standard app'), apps, ctx, { unit: 'apps / month' }));
      const bw = single(rs.filter(r => r.meterName === 'Standard Bandwidth Usage'), 'bandwidth');
      lines.push(meterLine(G, S, `Bandwidth: ${fmtN(gb)} GB a month (first 100 GB a month per subscription free, then charged per GB)`, bw, gb, ctx, { unit: 'GB' }));
    }
    if (edge) lines.push(meterLine(G, S, `Enterprise-grade edge (Azure Front Door add-on): ${fmtN(edge)} app(s) x ${fmtN(hours)} hours`, single(rs.filter(r => r.meterName === 'Standard Azure Front Door Add-on'), 'Front Door add-on'), edge * hours, ctx, { unit: 'app-hours' }));
    const notes = plan === 'free'
      ? ['Free plan: no charge for hosting, SSL certificates and custom domains; 100 GB of bandwidth a month, no SLA, and it is meant for personal projects.']
      : ['Standard plan: each app is billed per month. The first 100 GB of bandwidth a month is free for the whole Azure subscription (shared by all apps); beyond that bandwidth is billed per GB.'];
    if (edge) notes.push('Enterprise-grade edge adds an hourly charge per app.');
    if (plan === 'standard' && led['swa-std-apps'] > 100) notes.push('A subscription includes up to 100 Standard apps; for more, contact Azure Support.');
    return { lines, notes, facts: { plan, apps, bandwidthGB: gb, enterpriseEdgeApps: edge, hours } };
  }
};
