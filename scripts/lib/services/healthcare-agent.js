'use strict';
// Healthcare agent service. Agent (C1) and Free (F0) meters sit under serviceName 'Azure API for FHIR', productName
// 'Healthcare Agent Service'. The legacy Standard (S1) plan sits under 'Azure Bot Service' / 'Microsoft Azure Health Bot'.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, DAYS, HOURS } = require('../kit');

const n = v => Number(v || 0);
// Actions consumed per item (Learn: healthcare agent service billing rates)
const PER = { classicMessages: 1, customerSourceResponses: 2, customerExtensionResponses: 2, credibleSourceResponses: 5, triageSessions: 18 };
const ACTION_FIELDS = [...Object.keys(PER), 'actions'];
const LEGACY_MSGS = 10000, LEGACY_MCU = 1000;
const LEGACY_REGIONS = 'australiaeast, centralindia, eastus, eastus2, jioindiacentral, jioindiawest, northeurope, southcentralus, southeastasia, taiwannorth, taiwannorthwest, uksouth, westeurope, westus2';
const INT = { int: true, min: 0 };

module.exports = {
  type: 'healthcare-agent',
  label: 'Healthcare agent service',
  family: 'ai-services',
  calculator: ['healthcare-agent-service'],
  keywords: ['healthcare bot', 'health bot', 'healthcare agent', 'patient chatbot', 'symptom triage', 'clinical chatbot'],
  fields: {
    plan: { def: 'agent', enum: ['agent', 'free', 'legacy-standard'], ask: 'Is this for evaluation and development only (free plan, limited to 15 requests per second) or for real use (agent plan, pay per action)? Free -> free; otherwise agent. Use legacy-standard only if they already have an older Standard (S1) bot with a fixed monthly fee; Microsoft no longer allows new ones.' },
    classicMessages: Object.assign({ def: 0, ask: 'Agent plan: how many fixed, rule-based or template answers will the agent give a month? (1 action each)' }, INT),
    customerSourceResponses: Object.assign({ def: 0, ask: 'Agent plan: how many answers a month will be drawn from your own websites or documents? (2 actions each)' }, INT),
    customerExtensionResponses: Object.assign({ def: 0, ask: 'Agent plan: how many answers a month will call your own systems or APIs? (2 actions each)' }, INT),
    credibleSourceResponses: Object.assign({ def: 0, ask: 'Agent plan: how many answers a month will come from the built-in trusted healthcare sources (medical databases, guidelines)? (5 actions each)' }, INT),
    triageSessions: Object.assign({ def: 0, ask: 'Agent plan: how many guided symptom-triage sessions a month? (18 actions each)' }, INT),
    actions: Object.assign({ def: 0, ask: 'Agent plan: if they already know their total number of billable actions a month, give it here instead of the breakdown above (it is added to anything above).' }, INT),
    legacyUnits: Object.assign({ def: 1, ask: 'Legacy Standard plan only: how many Standard units does the existing bot have? Each unit is a fixed daily fee and includes 10,000 messages and 1,000 medical content units a month.' }, { int: true, min: 0 }),
    legacyMessages: Object.assign({ def: 0, ask: 'Legacy Standard plan only: how many messages a month does the bot handle in total?' }, INT),
    legacyMedicalContentUnits: Object.assign({ def: 0, ask: 'Legacy Standard plan only: how many medical content units (MCUs, used when answers draw on built-in medical content) a month in total?' }, INT),
    hours: { def: 730, ask: 'Legacy Standard plan only: hours a month the bot exists, for the daily unit fee (730 = all month).' }
  },
  context: ['production'],
  examples: [
    { type: 'healthcare-agent', credibleSourceResponses: 2000, classicMessages: 10000 },
    { type: 'healthcare-agent', plan: 'agent', classicMessages: 50000, customerSourceResponses: 8000, customerExtensionResponses: 3000, credibleSourceResponses: 4000, triageSessions: 500, actions: 1000 },
    { type: 'healthcare-agent', plan: 'legacy-standard', legacyUnits: 2, legacyMessages: 30000, legacyMedicalContentUnits: 5000 }
  ],
  readback: c => {
    if (c.plan === 'legacy-standard') {
      const hrs = c.hours ?? HOURS;
      return `Healthcare agent service legacy Standard plan: ${fmtN(c.legacyUnits ?? 1)} unit(s) for ${hrs === HOURS ? 'all month' : fmtN(hrs) + ' hours'}, ${fmtN(n(c.legacyMessages))} messages and ${fmtN(n(c.legacyMedicalContentUnits))} medical content units a month`;
    }
    const parts = [];
    const lab = { classicMessages: 'rule-based messages', customerSourceResponses: 'answers from your own sources', customerExtensionResponses: 'answers via your own extensions', credibleSourceResponses: 'answers from built-in healthcare sources', triageSessions: 'triage sessions' };
    for (const k of Object.keys(PER)) if (n(c[k])) parts.push(`${fmtN(c[k])} ${lab[k]}`);
    if (n(c.actions)) parts.push(`${fmtN(c.actions)} other actions`);
    if (!parts.length) parts.push('no actions');
    return `Healthcare agent service, ${c.plan === 'free' ? 'free' : 'agent (pay-per-action)'} plan: ${parts.join(', ')} a month`;
  },
  price: async (c, ctx) => {
    const plan = (c.plan || 'agent').toLowerCase();
    if (!['agent', 'free', 'legacy-standard'].includes(plan)) throw new PricingError('plan must be "agent", "free" or "legacy-standard".');
    for (const k of [...ACTION_FIELDS, 'legacyUnits', 'legacyMessages', 'legacyMedicalContentUnits']) if (n(c[k]) < 0) throw new PricingError(`${k} must not be negative.`);
    const G = 'AI';
    if (plan === 'legacy-standard') {
      const units = n(c.legacyUnits ?? 1), msgs = n(c.legacyMessages), mcu = n(c.legacyMedicalContentUnits), hours = c.hours ?? HOURS;
      if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
      if (!units) throw new PricingError('legacy-standard needs at least 1 legacyUnits.');
      const bs = await rows(`serviceName eq 'Azure Bot Service' and productName eq 'Microsoft Azure Health Bot' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
      if (!bs.length) throw new PricingError(`The legacy Standard healthcare agent plan is not priced in ${ctx.region}. Priced regions: ${LEGACY_REGIONS}.`);
      const S = 'Azure Bot Service';
      const overMsgs = Math.max(0, msgs - units * LEGACY_MSGS), overMcu = Math.max(0, mcu - units * LEGACY_MCU);
      const lines = [meterLine(G, S, `Healthcare agent legacy Standard: ${fmtN(units)} unit(s) x ${fmtN(Math.round(hours / 24 * 100) / 100)} days (includes ${fmtN(units * LEGACY_MSGS)} messages and ${fmtN(units * LEGACY_MCU)} medical content units)`, single(bs.filter(r => r.meterName === 'Standard Unit'), 'legacy Standard unit'), units * hours / 24, ctx, { unit: 'unit-days' })];
      if (overMsgs) lines.push(meterLine(G, S, `Messages above the included amount: ${fmtN(overMsgs)}`, single(bs.filter(r => r.meterName === 'Standard Overage Messages'), 'legacy overage messages'), overMsgs, ctx, { unit: 'messages' }));
      if (overMcu) lines.push(meterLine(G, S, `Medical content units above the included amount: ${fmtN(overMcu)}`, single(bs.filter(r => r.meterName === 'Standard Overage MCU'), 'legacy overage MCU'), overMcu, ctx, { unit: 'MCUs' }));
      return { lines, notes: ['The legacy Standard (S1) plan is deprecated: existing customers can still use it, but no new instances can be created. Learn quotes a $500 fixed monthly fee per unit; the Retail API bills per day, which over 730 hours is about $490 per unit. Overage is billed only above the messages and medical content units included with each unit.'], facts: { plan, legacyUnits: units, legacyMessages: msgs } };
    }
    const total = Object.keys(PER).reduce((s, k) => s + n(c[k]) * PER[k], 0) + n(c.actions);
    if (plan === 'agent' && !total) throw new PricingError('Give at least one quantity (messages, answers, triage sessions or actions) for the agent plan.');
    const rs = (await rows(`serviceName eq 'Azure API for FHIR' and ${regionFilter(ctx)} and priceType eq 'Consumption' and productName eq 'Healthcare Agent Service'`, ctx));
    if (!rs.length) throw new PricingError(`Healthcare agent service is not priced in ${ctx.region}. Priced regions: australiaeast, centralindia, eastus, eastus2, northeurope, southcentralus, southeastasia, uaenorth, uksouth, westcentralus, westeurope, westus2.`);
    const free = plan === 'free';
    const m = single(rs.filter(r => r.meterName === (free ? 'Free Action' : 'Action')), `Healthcare agent ${free ? 'free ' : ''}actions`);
    const lines = [meterLine(G, 'Healthcare agent service', `Healthcare agent service, ${free ? 'free' : 'agent (pay-per-action)'} plan: ${fmtN(total)} actions a month`, m, total, ctx, { unit: 'actions' })];
    const notes = free
      ? ['The free plan offers only a limited number of free actions a month, for evaluation in non-production deployments, and is limited to 15 requests per second. This line is priced at zero and does not cap the quantity: check the allowance before relying on it.']
      : ['Every action is billed at the same rate. Actions used per answer: rule-based message 1, answer from your own sources 2, answer via your extensions 2, answer from built-in healthcare sources 5, triage session 18.'];
    return { lines, notes, facts: { plan, actions: total, triageSessions: n(c.triageSessions) } };
  }
};

