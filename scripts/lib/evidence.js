'use strict';

// Only the native ask_user completion layout observed in Copilot's event log is accepted.
// Questions, schema defaults, other tools and unlinked result strings are never answers.
function humanEvidence(events, { includeUnsupported = false } = {}) {
  const starts = new Map(), answers = [];
  for (const [index, e] of events.entries()) {
    const d = e.data || {};
    if (e.type === 'user.message' && typeof d.content === 'string' && !d.source && !d.content.startsWith('<skill-context')) {
      answers.push({ eventId: e.id, index, text: d.content });
    }
    if (e.type === 'tool.execution_start' && d.toolName === 'ask_user' && d.toolCallId) {
      starts.set(d.toolCallId, { event: e, index });
    }
    if (e.type !== 'tool.execution_complete' || d.success !== true || !d.interactionId || !starts.has(d.toolCallId)) continue;
    const start = starts.get(d.toolCallId), sd = start.event.data;
    if (!d.turnId || d.turnId !== sd.turnId) continue;
    starts.delete(d.toolCallId);
    const a = sd.arguments || {}, r = d.result || {};
    const before = answers.length;
    const common = { eventId: e.id, index, native: true, question: a.question || a.message || '', startIndex: start.index };
    if (typeof a.question === 'string' && Array.isArray(a.choices) &&
        typeof r.content === 'string' && r.content === r.detailedContent &&
        r.content.startsWith('User selected: ')) {
      const text = r.content.slice('User selected: '.length);
      if (a.choices.includes(text)) answers.push({ ...common, responseFields: 1, text });
    } else if (a.requestedSchema && typeof a.message === 'string' &&
        typeof r.content === 'string' && r.content.startsWith('User responded: ') &&
        typeof r.detailedContent === 'string' && r.detailedContent.startsWith('User responded:\n')) {
      const properties = a.requestedSchema.properties || {};
      const rows = r.detailedContent.slice('User responded:\n'.length).split('\n');
      const fields = [];
      let valid = rows.length > 0;
      const used = new Set();
      for (const row of rows) {
        const m = row.match(/^([A-Za-z_][\w-]*): ([^\r\n]+)$/);
        if (!m || used.has(m[1]) || !Object.hasOwn(properties, m[1])) { valid = false; break; }
        used.add(m[1]);
        const type = properties[m[1]].type;
        if (!['string', 'number', 'integer', 'boolean'].includes(type) ||
            (type === 'boolean' && !/^(true|false)$/.test(m[2])) ||
            (['number', 'integer'].includes(type) && (!Number.isFinite(Number(m[2])) || (type === 'integer' && !Number.isInteger(Number(m[2])))))) { valid = false; break; }
        const property = properties[m[1]];
        const about = [m[1], property.title, property.description].filter(Boolean).join(' ');
        const positiveApproval = ['boolean', 'string'].includes(type) &&
          /^(approve|approved|approval|confirm|confirmed|confirmation|accept|accepted)$/.test(m[1]) &&
          /^(approve|confirm|accept) (this|the) (estimate|readback|pricing estimate)( as (shown|displayed))?[.!]?$/i.test(property.title || '') &&
          (!property.description || /^(set |select )?true to (approve|confirm|accept) (this|the) (estimate|readback|pricing estimate)( as (shown|displayed))?[.!]?$/i.test(property.description)) &&
          !/\b(reject|decline|cancel|not|disagree|wrong|incorrect|change|correction|missing)\b/i.test(about) &&
          !['oneOf', 'anyOf', 'allOf', 'enum', 'const'].some(k => Object.hasOwn(property, k));
        fields.push({ ...common, answerField: m[1], about, positiveApproval, text: m[2] });
      }
      if (valid && r.content === 'User responded: ' + fields.map(f => `${f.answerField}=${f.text}`).join(', ')) answers.push(...fields.map(f => ({ ...f, responseFields: fields.length })));
    }
    if (includeUnsupported && answers.length === before) answers.push({ ...common, unsupported: true, text: '' });
  }
  return answers;
}

function parseEvents(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  });
}

module.exports = { humanEvidence, parseEvents };
