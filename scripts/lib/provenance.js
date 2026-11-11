'use strict';
const vmSizes = require('../../catalog/vm-sizes.json');

const words = text => (text.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)*%?/g) || []).join(' ');
const numbers = text => [...text.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(million|billion)\b)?/gi)]
  .map(m => Number(m[0].replace(/,/g, '').replace(/\s*(million|billion)$/i, '')) * ({ million: 1e6, billion: 1e9 }[m[1]?.toLowerCase()] || 1));

function fieldValue(spec, field) {
  if (typeof field !== 'string' || !/^(region|currency|discountPct|context\.[A-Za-z]+|options\[\d+\]\.(context\.[A-Za-z]+|components\[\d+\]\.[A-Za-z]+))$/.test(field)) return undefined;
  const parts = field.replace(/\[(\d+)\]/g, '.$1').split('.');
  if (spec._expanded && parts[0] === 'options') {
    const index = (spec.options || []).findIndex(o => o.scenario && o.scenario.id === `estimate-${Number(parts[1]) + 1}`);
    if (index < 0) return undefined;
    parts[1] = String(index);
  }
  let value = spec;
  for (const [i, key] of parts.entries()) {
    if (value == null || !Object.hasOwn(value, key)) {
      if (value && value.type === 'vm' && i === parts.length - 1 && ['vcpu', 'memGiB'].includes(key)) {
        const size = vmSizes[value.sku];
        return size && size[key === 'vcpu' ? 'v' : 'm'];
      }
      return undefined;
    }
    value = value[key];
  }
  return ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
}

function sourceErrors(spec, evidence) {
  if (spec.sources == null) return [];
  if (!Array.isArray(spec.sources)) return ['sources must be an array of field-level customer answers or assumptions.'];
  const errs = [], seen = new Set();
  for (const [i, s] of spec.sources.entries()) {
    const prefix = `sources[${i}]${typeof s?.field === 'string' ? ` (${s.field})` : ''}`;
    if (!s || typeof s !== 'object') { errs.push(`${prefix} must be an object.`); continue; }
    const value = fieldValue(spec, s.field);
    if (value === undefined || seen.has(s.field)) errs.push(`${prefix}.field must name a unique existing scalar scope field (VM vcpu/memGiB may be derived from its SKU).`);
    seen.add(s.field);
    if (!['customer', 'assumption'].includes(s.kind)) errs.push(`${prefix}.kind must be customer or assumption.`);
    if (s.kind === 'assumption') {
      if (typeof s.reason !== 'string' || !s.reason.trim()) errs.push(`${prefix}.reason is required for an assumption.`);
      continue;
    }
    if (s.kind !== 'customer') continue;
    const answer = evidence && evidence.find(e => e.eventId === s.eventId && e.answerField === s.answerField);
    if (typeof s.customerSaid !== 'string' || !s.customerSaid.trim() || !answer ||
        !(answer.native ? answer.text.toLowerCase() === s.customerSaid.trim().toLowerCase() :
          (' ' + words(answer.text) + ' ').includes(' ' + words(s.customerSaid) + ' '))) {
      errs.push(`${prefix}: cannot verify this customer answer. Supply the actual human eventId and exact customerSaid; native forms also need answerField. Unlinked or unsupported ask_user layouts are not trusted.`);
      continue;
    }
    // A numeric answer must match the field; a model cannot attach "8" to a 16-vCPU SKU.
    const quote = s.customerSaid.trim().toLowerCase();
    if (s.field === 'discountPct' && answer.native && !/discount/i.test(answer.about || answer.question)) errs.push(`${prefix}: this native answer was not a discount question.`);
    const translated = 'Do not rewrite the quote to match. Omit this optional source entry if the field is translated; keep the real words in customerSaid. For VM sizing, source vcpu/memGiB instead of the selected SKU.';
    if (typeof value === 'number' && !numbers(quote).includes(value)) errs.push(`${prefix}: customerSaid does not contain this field's numeric value (${value}); million and billion are expanded to actual quantities. ${translated}`);
    if (typeof value === 'boolean' && quote !== String(value)) errs.push(`${prefix}: boolean sources must quote true or false exactly. ${translated}`);
    if (typeof value === 'string' && !quote.replace(/\s+/g, '').includes(value.toLowerCase().replace(/\s+/g, ''))) errs.push(`${prefix}: customerSaid does not contain this field's value (${value}). ${translated}`);
  }
  return errs;
}

function sourceFacts(spec) {
  return (Array.isArray(spec.sources) ? spec.sources : []).filter(s => s && fieldValue(spec, s.field) !== undefined).map(s => ({
    field: s.field, value: fieldValue(spec, s.field), kind: s.kind,
    ...(s.kind === 'customer' ? { customerSaid: s.customerSaid } : { reason: s.reason })
  }));
}

function sourceLines(spec) {
  return sourceFacts(spec).map(s => `${s.field}: ${s.value} (${s.kind === 'customer' ? `customer supplied: "${s.customerSaid}"` : `assumption: ${s.reason}`})`);
}

module.exports = { fieldValue, sourceErrors, sourceFacts, sourceLines };
