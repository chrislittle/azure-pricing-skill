'use strict';
// Azure SRE Agent. Single regional meter "SRE Agent Unit" (one Azure Agent Unit, AAU) under serviceName 'Foundry Tools'.
// Billing (Learn "Pricing and billing for Azure SRE Agent"): always-on 4 AAU per agent-hour + active-flow AAUs from LLM tokens.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const ALWAYS_ON_AAU_PER_HOUR = 4;
// AAUs per 1M tokens (Learn "Pricing and billing for Azure SRE Agent"); GPT 5.3 Codex and GPT 5.2 share rates
const RATE = { opus: { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 }, gpt: { input: 35, output: 280, cacheRead: 3.5, cacheWrite: 0 } };
// Token mix per task from the same page (millions of tokens): input, output, cache read, cache write
const MIX = { quickQuestions: [0.02, 0.002, 0.015, 0.005], incidentInvestigations: [0.2, 0.015, 0.15, 0.05], fullRemediations: [0.5, 0.04, 0.4, 0.1] };
const aau = (m, k) => m[0] * RATE[k].input + m[1] * RATE[k].output + m[2] * RATE[k].cacheRead + m[3] * RATE[k].cacheWrite;
const LABEL = { quickQuestions: 'quick questions', incidentInvestigations: 'incident investigations', fullRemediations: 'full remediations' };
// Exact sums: Opus 3.775 / 35.25 / 86.5, GPT 1.3125 / 11.725 / 30.1 (Learn prints the rounded values)
const TASK = Object.fromEntries(Object.keys(MIX).map(k => [k, { opus: aau(MIX[k], 'opus'), gpt: aau(MIX[k], 'gpt'), label: LABEL[k] }]));
const MONTHLY_CAP = 1000000;
const EU_OPENAI = ['swedencentral', 'uksouth'];

module.exports = {
  type: 'sre-agent',
  label: 'Azure SRE Agent',
  family: 'ai-services',
  calculator: ['sre-agent'],
  keywords: ['sre agent', 'ai operations', 'incident response agent', 'autonomous operations', 'site reliability', 'incident investigation'],
  fields: {
    agents: { req: true, int: true, min: 0, ask: 'How many SRE agents will they create? One agent can watch many resources, so most teams need 1. Each agent costs a fixed amount for every hour it exists, even when idle.' },
    hours: { def: 730, ask: 'Hours a month each agent exists before it is deleted (730 = all month; stopping an agent does not stop this charge, only deleting it does).' },
    quickQuestions: { def: 0, int: true, min: 0, ask: 'How many quick chat questions a month will people ask the agent (for example "show me recent alerts")?' },
    incidentInvestigations: { def: 0, int: true, min: 0, ask: 'How many incidents a month should the agent investigate automatically (for example from Azure Monitor alerts)?' },
    fullRemediations: { def: 0, int: true, min: 0, ask: 'How many full diagnose-and-fix tasks a month (for example "find and fix the failing deployment")?' },
    inputMTokens: { def: 0, min: 0, ask: 'If they have token counts from the agent, how many millions of input tokens (prompts, tool results, context) a month? Priced at the model rate; added to the tasks above.' },
    outputMTokens: { def: 0, min: 0, ask: 'Millions of output tokens (responses, reasoning) a month, if known.' },
    cacheReadMTokens: { def: 0, min: 0, ask: 'Millions of cache-read tokens (repeated context served from the prompt cache) a month, if known.' },
    cacheWriteMTokens: { def: 0, min: 0, ask: 'Millions of cache-write tokens a month, if known.' },
    activeAaus: { def: 0, ask: 'If they already know the Azure Agent Units (AAUs) their agent used for work, enter them here; added to the tasks above.' },
    model: { enum: ['opus', 'gpt'], ask: 'Which AI model family will the agent use for the tasks above? Claude Opus (Anthropic) -> opus, more thorough and uses more units; GPT (Azure OpenAI) -> gpt, cheaper. If unknown, leave blank: Learn says to use Anthropic in East US 2 and Australia East and Azure OpenAI in Sweden Central and UK South (EU data residency), and this estimate follows that.' }
  },
  examples: [
    { type: 'sre-agent', agents: 1 },
    { type: 'sre-agent', agents: 2, hours: 730, quickQuestions: 300, incidentInvestigations: 60, fullRemediations: 10, activeAaus: 500, inputMTokens: 10, outputMTokens: 1, cacheReadMTokens: 5, model: 'gpt' }
  ],
  readback: c => {
    const parts = [`${fmtN(n(c.agents))} agent(s) existing ${(c.hours ?? HOURS) === HOURS ? 'all month' : fmtN(c.hours) + ' hours a month'}`];
    for (const k of Object.keys(TASK)) if (n(c[k])) parts.push(`${fmtN(c[k])} ${TASK[k].label}`);
    if (n(c.activeAaus)) parts.push(`${fmtN(c.activeAaus)} extra active-work AAUs`);
    const tok = [['inputMTokens', 'input'], ['outputMTokens', 'output'], ['cacheReadMTokens', 'cache-read'], ['cacheWriteMTokens', 'cache-write']].filter(([k]) => n(c[k])).map(([k, l]) => `${fmtN(c[k])}M ${l}`);
    if (tok.length) parts.push(`${tok.join(' + ')} tokens`);
    const worked = Object.keys(TASK).some(k => n(c[k])) || tok.length;
    return `SRE Agent: ${parts.join(', ')}${worked && c.model ? ` (${c.model === 'gpt' ? 'GPT' : 'Claude Opus'} model)` : ''}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : ['Azure resources the agent monitors and the Log Analytics / Application Insights data it reads are billed separately'],
  price: async (c, ctx) => {
    const hours = c.hours ?? HOURS, agents = n(c.agents);
    const model = (c.model || (EU_OPENAI.includes(ctx.region) ? 'gpt' : 'opus')).toLowerCase();
    if (!['opus', 'gpt'].includes(model)) throw new PricingError('model must be "opus" or "gpt".');
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    for (const k of ['agents', 'activeAaus', 'inputMTokens', 'outputMTokens', 'cacheReadMTokens', 'cacheWriteMTokens', ...Object.keys(TASK)]) if (n(c[k]) < 0) throw new PricingError(`${k} must not be negative.`);
    const rs = await rows(`serviceName eq 'Foundry Tools' and productName eq 'Azure Agent Unit' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure SRE Agent is not priced in ${ctx.region}.`);
    const m = single(rs.filter(r => r.meterName === 'SRE Agent Unit'), 'SRE Agent Units');
    const G = 'AI', S = 'Foundry Tools';
    const billedHours = hours > 0 && hours < 1 ? 1 : hours;
    const alwaysOn = agents * billedHours * ALWAYS_ON_AAU_PER_HOUR;
    const taskAaus = Object.keys(TASK).reduce((s, k) => s + n(c[k]) * TASK[k][model], 0);
    const tokenAaus = n(c.inputMTokens) * RATE[model].input + n(c.outputMTokens) * RATE[model].output + n(c.cacheReadMTokens) * RATE[model].cacheRead + n(c.cacheWriteMTokens) * RATE[model].cacheWrite;
    const active = taskAaus + tokenAaus + n(c.activeAaus);
    const lines = [];
    if (alwaysOn) lines.push(meterLine(G, S, `SRE Agent always-on: ${fmtN(agents)} agent(s) x ${fmtN(billedHours)} hours x ${ALWAYS_ON_AAU_PER_HOUR} AAUs = ${fmtN(alwaysOn)} AAUs`, m, alwaysOn, ctx, { unit: 'AAUs' }));
    if (active) lines.push(meterLine(G, S, `SRE Agent active work: ${fmtN(Math.round(active * 10) / 10)} AAUs`, m, active, ctx, { unit: 'AAUs' }));
    if (!lines.length) throw new PricingError('Nothing to price: set agents to 1 or more, or add active work.');
    const notes = [`Each agent costs ${ALWAYS_ON_AAU_PER_HOUR} Azure Agent Units (AAUs) per hour from creation until it is deleted, even if stopped. Active work is billed in AAUs based on AI tokens used; the per-task figures use Microsoft's typical token mixes at the Learn AAU rates, so real usage varies. Always-on has a one-hour minimum per agent.`,
      'New customers can evaluate SRE Agent with the always-on charge waived; this estimate does not apply that waiver.'];
    if (!c.model) notes.push(`Model not given: priced as ${model === 'gpt' ? 'GPT (Azure OpenAI)' : 'Claude Opus (Anthropic)'}, the Learn default for ${ctx.region}.`);
    if (agents && active / agents > MONTHLY_CAP) notes.push(`Active work is over ${fmtN(MONTHLY_CAP)} AAUs per agent a month, which is the maximum monthly active-flow limit Learn allows; the agent stops taking work at its limit, so check these volumes.`);
    return { lines, notes, facts: { agents, alwaysOnAaus: alwaysOn, activeAaus: active, model, region: ctx.region } };
  }
};
