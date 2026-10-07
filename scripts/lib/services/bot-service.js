'use strict';
// Azure AI Bot Service. Calculator slug: bot-services.
// Meters: serviceName 'Azure Bot Service', regionless ('Global') for commercial regions and 'US Gov' for usgov* regions (S1 is 25% higher there). Standard channels are free and unlimited;
// premium channels (Direct Line, Web Chat) are free up to 10,000 messages a month on the Free tier and billed
// per 1,000 messages on S1. The Health Bot service (serviceName 'Microsoft Azure Health Bot') is a different product.
const { rows, single, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const FREE_PREMIUM = 10000;
// Regions where the calculator (bot-services, offers.free) does not offer the Free tier; usgov* is handled separately.
const NO_FREE = new Set(['austriaeast', 'belgiumcentral', 'brazilsoutheast', 'chilecentral', 'denmarkeast', 'eastus3', 'finlandcentral', 'germanynorth', 'germanywestcentral', 'southcentralindia', 'indonesiacentral', 'israelcentral', 'italynorth', 'malaysiawest', 'mexicocentral', 'newzealandnorth', 'norwayeast', 'norwaywest', 'polandcentral', 'qatarcentral', 'saudiarabiaeast', 'southafricanorth', 'southafricawest', 'spaincentral', 'swedencentral', 'swedensouth', 'switzerlandnorth', 'switzerlandwest', 'uaecentral', 'uaenorth', 'westus3']);

module.exports = {
  type: 'bot-service',
  label: 'Azure AI Bot Service',
  family: 'ai-services',
  calculator: ['bot-services'],
  keywords: ['bot', 'chatbot', 'bot framework', 'direct line', 'web chat', 'teams bot', 'conversational'],
  fields: {
    tier: { def: 's1', enum: ['free', 's1'], ask: 'Is this a small test or trial with at most 10,000 premium-channel messages a month (free), or a real bot with no cap (s1)? If unknown, suggest s1 and record it as an assumption.' },
    premiumMessages: { req: true, int: true, min: 0, ask: 'How many messages a month will users send through your own website or app (Direct Line or Web Chat, the "premium" channels)? Count both user and bot messages. Teams, Slack, Facebook and similar channels are free and unlimited, so use 0 if the bot only lives there.' }
  },
  examples: [
    { type: 'bot-service', tier: 's1', premiumMessages: 250000 },
    { type: 'bot-service', tier: 's1', premiumMessages: 2000 }
  ],
  readback: c => `Bot Service ${(c.tier || 's1') === 'free' ? 'Free tier' : 'S1 tier'}: ${fmtN(n(c.premiumMessages))} premium-channel (Direct Line / Web Chat) messages a month; standard channels (Teams, Slack and similar) are free and unlimited`,
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The web app, function or container that hosts the bot code (for example App Service)',
    'AI services the bot calls (language understanding, Azure OpenAI, search) and storage for conversation state'
  ],
  price: async (c, ctx) => {
    const tier = (c.tier || 's1').toLowerCase();
    if (!['free', 's1'].includes(tier)) throw new PricingError('tier must be free or s1.');
    const msgs = n(c.premiumMessages);
    if (msgs < 0) throw new PricingError('premiumMessages cannot be negative.');
    if (tier === 'free' && msgs > FREE_PREMIUM) throw new PricingError(`The Free tier includes ${fmtN(FREE_PREMIUM)} premium-channel messages a month and has no pay-as-you-go beyond that; use tier "s1" for ${fmtN(msgs)} messages.`);
    const gov = /^usgov/.test(ctx.region);
    if (tier === 'free' && (gov || NO_FREE.has(ctx.region))) throw new PricingError(`The Free tier is not offered in ${ctx.region} (the pricing calculator does not list it there); use tier "s1" or pick a region such as eastus2 or westeurope.`);
    // Bot Service meters are regionless: 'Global' for commercial regions, 'US Gov' for US Government regions.
    const rs = await rows(`serviceName eq 'Azure Bot Service' and (armRegionName eq '${gov ? 'US Gov' : 'Global'}'${gov ? '' : " or armRegionName eq ''"}) and priceType eq 'Consumption'`, ctx);
    const name = tier === 'free' ? 'Free Premium Channel Messages' : 'S1 Premium Channel Messages';
    const hit = rs.filter(r => r.meterName === name);
    if (!hit.length) throw new PricingError(`Azure Bot Service ${tier.toUpperCase()} is not priced for ${ctx.region}.`);
    const lines = [meterLine('AI', 'Azure Bot Service', `Bot Service ${tier === 'free' ? 'Free' : 'S1'}: premium-channel messages, ${fmtN(msgs)}/month${tier === 'free' ? ` (up to ${fmtN(FREE_PREMIUM)} included)` : ''}`, single(hit, 'premium channel messages'), msgs, ctx, { unit: 'messages' })];
    const notes = ['Standard channels (Teams, Slack, Facebook and other channels with public bot APIs) are free and unlimited on every tier. Only premium channels (Direct Line, Web Chat) are metered.'];
    if (tier === 's1') notes.push('On S1 every premium-channel message is billed per 1,000; the 10,000 free messages belong to the Free tier only.');
    notes.push(gov ? 'Bot Service uses a US Government rate in US Gov regions. The bot\'s own hosting is billed separately.' : 'Bot Service prices are the same in every commercial region (US Government regions use a higher rate). The bot\'s own hosting is billed separately.');
    return { lines, notes, facts: { tier, premiumMessages: msgs } };
  }
};
