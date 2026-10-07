'use strict';
// Azure Content Understanding in Foundry Tools. Calculator slug: content-understanding (price data: /api/v3/pricing/content-understanding/calculator/, 23 offers).
// Meters: serviceName 'Foundry Tools', productName 'Azure Content Understanding'. Content extraction is billed per
// 1,000 pages (documents) or per hour (audio, video); contextualization tokens are added when generative features run.
// Foundry model tokens (field extraction LLM, embeddings) are billed on the model deployment, not here.
// Calculator/Retail offers deliberately NOT priced: the field-extraction, face, formula, classification and Pro token meters
// (Document/Image/Audio/Video Field Extraction, Add-On Face Grouping Video, Add-On Formula, Face Transaction, Face Storage,
// Std/Pro Field Extract tokens, Pro Contextualization, Classification tokens) belong to the retired preview APIs
// (2024-12-01-preview and 2025-05-01-preview, retired 2026-07-15), are listed only in australiaeast, swedencentral and westus,
// and the current pricing page shows only content extraction and contextualization.
// Sources: https://learn.microsoft.com/azure/ai-services/content-understanding/how-to/migration-preview-to-ga and
// https://azure.microsoft.com/pricing/details/content-understanding/. 'minimal-document-sync-content-extraction' has no price anywhere.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
// contextualization tokens per unit of content (Learn: Pricing for Azure Content Understanding)
const TOK = { page: 1000, image: 1000, audioHour: 100000, videoHour: 1000000 };

module.exports = {
  type: 'content-understanding',
  label: 'Azure Content Understanding in Foundry Tools',
  family: 'ai-services',
  calculator: ['content-understanding'],
  keywords: ['content understanding', 'document extraction', 'audio transcription', 'video analysis', 'field extraction', 'analyzer', 'rag ingestion', 'multimodal'],
  fields: {
    documentMinimalPages: { def: 0, int: true, min: 0, ask: 'How many pages a month are digital-native files (Word, Excel, PowerPoint, HTML, text, email) where no scanning is needed? Use 0 if none.' },
    documentReadPages: { def: 0, int: true, min: 0, ask: 'How many pages a month are scans or images (PDF, PNG, TIFF, JPG) where you only need the text read out (OCR)? Use 0 if none.' },
    documentLayoutPages: { def: 0, int: true, min: 0, ask: 'How many pages a month are scans or images where you need layout too (tables, structure, forms, invoices, receipts)? Use 0 if none.' },
    synchronous: { def: false, ask: 'Do you call the service synchronously (one document in, answer returned in the same call; preview) rather than the usual asynchronous way? Yes -> true; most people say no. Applies to the scanned-page quantities only; digital files have no published synchronous rate.' },
    addOnLayoutPages: { def: 0, int: true, min: 0, ask: 'Leave at 0 unless the customer knows they use the separately listed "Add-On Layout" meter. Layout analysis is normally billed on the standard scanned-page meter above, so do not count the same pages here and there. How many pages a month use the add-on meter?' },
    images: { def: 0, int: true, min: 0, ask: 'How many standalone images a month will be analysed (captions, descriptions, fields)? Content extraction is not charged for images; they only add contextualization when generative features are on. Use 0 if none.' },
    audioMinutes: { def: 0, min: 0, ask: 'How many minutes of audio a month will be transcribed or analysed (calls, meetings, podcasts)? Use 0 if none.' },
    videoMinutes: { def: 0, min: 0, ask: 'How many minutes of video a month will be processed (frames, shots, speech)? Use 0 if none.' },
    contextualization: { def: 'none', enum: ['none', 'standard', 'advanced'], ask: 'Will you use generative features that pull out your own fields, describe figures, split or classify content, or train custom analyzers? None, plain text/layout extraction only -> none. Yes, standard fields extraction or the ready-made RAG, invoice and receipt analyzers -> standard. Custom analyzers trained with labelled examples, agentic mode, or the ready-made US tax-form analyzers for 1095-A/1095-C, K-1 schedules and Minnesota M1 -> advanced (documents and images only; if only some of the workload is advanced, price it as two components). If unknown, suggest standard and record it as an assumption.' }
  },
  examples: [
    { type: 'content-understanding', documentMinimalPages: 20000 },
    { type: 'content-understanding', documentMinimalPages: 20000, documentReadPages: 50000, documentLayoutPages: 100000, synchronous: false, images: 5000, audioMinutes: 6000, videoMinutes: 1200, contextualization: 'standard' },
    { type: 'content-understanding', documentMinimalPages: 0, documentLayoutPages: 30000, synchronous: true, images: 2000, contextualization: 'advanced' }
  ],
  readback: c => {
    const parts = [];
    if (n(c.documentMinimalPages)) parts.push(`${fmtN(c.documentMinimalPages)} pages of digital files (Word, Excel, HTML, text)`);
    if (n(c.documentReadPages)) parts.push(`${fmtN(c.documentReadPages)} scanned pages read as text only${c.synchronous ? ' (synchronous)' : ''}`);
    if (n(c.documentLayoutPages)) parts.push(`${fmtN(c.documentLayoutPages)} scanned pages with layout analysis${c.synchronous ? ' (synchronous)' : ''}`);
    if (n(c.addOnLayoutPages)) parts.push(`${fmtN(c.addOnLayoutPages)} pages with the layout add-on`);
    if (n(c.images)) parts.push(`${fmtN(c.images)} images analysed`);
    if (n(c.audioMinutes)) parts.push(`${fmtN(c.audioMinutes)} minutes of audio`);
    if (n(c.videoMinutes)) parts.push(`${fmtN(c.videoMinutes)} minutes of video`);
    const gen = (c.contextualization || 'none');
    parts.push(gen === 'none' ? 'no generative features (extraction only)' : `${gen} contextualization for generative features`);
    return `Content Understanding a month: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Foundry model tokens (the language model that extracts fields and the embeddings used for training), billed on your Foundry model deployment',
    'Storage for the files and the app or workflow that submits them',
    'Retired preview-API meters (field extraction, face, formula, classification and Pro tokens) are not priced; those API versions were retired on 2026-07-15'
  ],
  price: async (c, ctx) => {
    const minimal = n(c.documentMinimalPages), addOn = n(c.addOnLayoutPages), read = n(c.documentReadPages), layout = n(c.documentLayoutPages);
    const images = n(c.images), audioMin = n(c.audioMinutes), videoMin = n(c.videoMinutes);
    if ([minimal, read, layout, addOn, images, audioMin, videoMin].some(v => v < 0)) throw new PricingError('Quantities cannot be negative.');
    if (!(minimal + read + layout + addOn + images + audioMin + videoMin)) throw new PricingError('Enter at least one quantity (pages, images, audio or video minutes).');
    const ctxl = (c.contextualization || 'none').toLowerCase();
    if (!['none', 'standard', 'advanced'].includes(ctxl)) throw new PricingError('contextualization must be none, standard or advanced.');
    if (images && ctxl === 'none') throw new PricingError('Images are only billed through contextualization; set contextualization to standard or advanced, or set images to 0.');
    if (ctxl === 'advanced' && (audioMin || videoMin)) throw new PricingError('Advanced contextualization is not available for audio or video; use standard, or price the audio and video in a separate component.');
    const sync = !!c.synchronous;
    const rs = await rows(`serviceName eq 'Foundry Tools' and productName eq 'Azure Content Understanding' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Content Understanding is not priced in ${ctx.region}.`);
    const m = (name, what) => {
      const hit = rs.filter(r => r.meterName === name);
      if (!hit.length) {
        const have = [...new Set(rs.map(r => r.meterName.replace(/ (Pages|Tokens)$/, '')))].join(', ');
        throw new PricingError(`Content Understanding ${what} is not priced in ${ctx.region}; this region offers only: ${have}. Pick a region with full availability such as eastus2 or westeurope.`);
      }
      return single(hit, `Content Understanding ${what} in ${ctx.region}`);
    };
    const G = 'AI', S = 'Foundry Tools', lines = [], notes = [];
    if (minimal) lines.push(meterLine(G, S, `Document content extraction, digital files (minimal), ${fmtN(minimal)} pages/month`, m('Doc Content Extraction Min Pages', 'minimal document extraction'), minimal, ctx, { unit: 'pages' }));
    if (read) lines.push(meterLine(G, S, `Document content extraction, scanned pages read as text (basic${sync ? ', synchronous' : ''}), ${fmtN(read)} pages/month`, m(sync ? 'Doc Co Extr Sync Basic Pages' : 'Doc Content Extraction Basic Pages', 'basic document extraction'), read, ctx, { unit: 'pages' }));
    if (layout) lines.push(meterLine(G, S, `Document content extraction, scanned pages with layout (standard${sync ? ', synchronous' : ''}), ${fmtN(layout)} pages/month`, m(sync ? 'Doc Co Extr Sync Standard Pages' : 'Doc Content Extraction Standard Pages', 'standard document extraction'), layout, ctx, { unit: 'pages' }));
    if (addOn) lines.push(meterLine(G, S, `Document layout add-on, ${fmtN(addOn)} pages/month`, m('Add-On Layout Pages', 'layout add-on'), addOn, ctx, { unit: 'pages' }));
    if (audioMin) lines.push(meterLine(G, S, `Audio content extraction (speech to text), ${fmtN(audioMin)} minutes = ${fmtN(Math.round(audioMin / 60 * 100) / 100)} hours/month`, m('Audio Content Extraction', 'audio extraction'), audioMin / 60, ctx, { unit: 'hours' }));
    if (videoMin) lines.push(meterLine(G, S, `Video content extraction (frames, shots, speech), ${fmtN(videoMin)} minutes = ${fmtN(Math.round(videoMin / 60 * 100) / 100)} hours/month`, m('Video Content Extraction', 'video extraction'), videoMin / 60, ctx, { unit: 'hours' }));

    let tokens = 0;
    if (ctxl !== 'none') {
      const pages = minimal + read + layout;
      tokens = (pages + images) * TOK.page + audioMin / 60 * TOK.audioHour + videoMin / 60 * TOK.videoHour;
      if (!tokens) throw new PricingError('Contextualization needs pages, images, audio or video to apply to.');
      const adv = ctxl === 'advanced';
      lines.push(meterLine(G, S, `${adv ? 'Advanced' : 'Standard'} contextualization, ${fmtN(Math.round(tokens))} tokens/month (1,000 per page or image, 100,000 per hour of audio, 1,000,000 per hour of video)`, m(adv ? 'Adv Contextual Tokens' : 'Std Contextualization Tokens', `${ctxl} contextualization`), tokens, ctx, { unit: 'tokens' }));
      notes.push('Contextualization tokens are added whenever generative features run (field extraction, figure analysis, segmentation, classification, training). Content Understanding charges the tokens at a fixed rate per page, image, hour of audio or hour of video.');
    }
    if (sync && minimal) notes.push('Synchronous mode has no published rate for digital files; the digital pages are priced at the standard (asynchronous) minimal rate.');
    notes.push('Document extraction is billed by the processing actually performed on each page, not by the analyzer chosen: digital files use the minimal meter, scanned pages the basic (read) or standard (layout) meter.');
    notes.push('The language model that extracts fields and any embeddings are billed on your Foundry model deployment, not here.');
    return { lines, notes, facts: { contextualization: ctxl, contextualizationTokens: Math.round(tokens), synchronous: sync, pages: minimal + read + layout, images, audioMinutes: audioMin, videoMinutes: videoMin } };
  }
};
