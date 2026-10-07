'use strict';
// Products deliberately not priced by this skill (retiring or out of scope). Source: catalog/excluded.json
// { type: { label, keywords, reason, url, verified } }. Add an entry to refuse a type with a clear message.
const EXCLUDED = require('../../catalog/excluded.json');

const message = e => `${e.reason} It is not priced by this skill. See ${e.url}.`;
const excludedMessage = type => (EXCLUDED[type] ? message(EXCLUDED[type]) : null);
const findExcluded = words => Object.entries(EXCLUDED)
  .filter(([t, e]) => words.some(w => `${t} ${e.label} ${(e.keywords || []).join(' ')}`.toLowerCase().includes(w)))
  .map(([t, e]) => ({ type: t, excluded: message(e) }));

module.exports = { EXCLUDED, excludedMessage, findExcluded };
