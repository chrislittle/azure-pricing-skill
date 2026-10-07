'use strict';
// Azure AI Video Indexer. Calculator slug: video-indexer (v3 calculator: azure.microsoft.com/api/v3/pricing/video-indexer/calculator/).
// Deliberately unpriced calculator items: caption-subtitle-generation and caption-subtitles (0.00333/min) and media-transcription
// (0.0167/min) have no Retail Prices API meter; the Azure Video Analyzer offers (iot-edge, live-video-analysis, stream-cloud,
// video-exporting, video-streaming-*-egress) are retired.
// Meters: serviceName 'Foundry Tools', productName 'Azure Video Indexer'. Billed per input minute of content,
// separately for the audio preset and the video preset, plus an optional video modification (encoding / face redaction).
// Older "Audio Analysis" / "Video Analysis" meters are not the presets listed on the pricing page and are not used.
const { rows, single, regionFilter, meterLine, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const PRESETS = ['none', 'basic', 'standard', 'advanced'];
const cap = s => s[0].toUpperCase() + s.slice(1);

module.exports = {
  type: 'video-indexer',
  label: 'Azure AI Video Indexer',
  family: 'ai-services',
  calculator: ['video-indexer'],
  keywords: ['video indexer', 'index videos', 'video insights', 'transcribe video', 'subtitles', 'captions', 'face redaction', 'media analysis'],
  fields: {
    minutes: { def: 0, int: true, min: 0, ask: 'How many minutes of audio or video will you index in a month? (A 1-hour video is 60 minutes.) If unknown, suggest 600 (10 hours) and record it as an assumption.' },
    audioPreset: { def: 'standard', enum: PRESETS, ask: 'How much audio analysis do you need? Only transcripts, translation and captions -> basic. Plus speakers, language detection, sentiment, topics, keywords and named entities -> standard. Everything the service offers -> advanced. No audio analysis -> none. If unknown, suggest standard and record it as an assumption.' },
    videoPreset: { def: 'standard', enum: PRESETS, ask: 'How much video analysis do you need? Objects, visual labels, on-screen text (OCR), keyframes, scenes and shots -> basic. Plus face and celebrity recognition and OCR-based keywords and topics -> standard. Everything, sampled more often, plus extras like clapperboards -> advanced. Audio only -> none. If unknown, suggest standard and record it as an assumption.' },
    modificationMinutes: { def: 0, int: true, min: 0, ask: 'Will you also re-encode videos or blur faces (face redaction)? If yes, how many minutes of video a month? Use 0 if not.' }
  },
  examples: [
    { type: 'video-indexer', minutes: 600 },
    { type: 'video-indexer', minutes: 5000, audioPreset: 'advanced', videoPreset: 'basic', modificationMinutes: 800 },
    { type: 'video-indexer', minutes: 1200, audioPreset: 'basic', videoPreset: 'none' }
  ],
  readback: c => {
    const a = (c.audioPreset || 'standard'), v = (c.videoPreset || 'standard');
    const parts = [];
    if (n(c.minutes)) parts.push(`${fmtN(n(c.minutes))} minutes of content indexed a month`, a === 'none' ? 'no audio analysis' : `${a} audio analysis`, v === 'none' ? 'no video analysis' : `${v} video analysis`);
    if (n(c.modificationMinutes)) parts.push(`${fmtN(c.modificationMinutes)} minutes of video modification (encoding or face redaction)`);
    return `Video Indexer: ${parts.join(', ')}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'The Azure Storage account connected to the Video Indexer account (Azure Media Services is retired), plus any network charges',
    'Azure Video Indexer enabled by Arc supports only the basic audio and basic video presets'
  ],
  price: async (c, ctx) => {
    const minutes = n(c.minutes), mod = n(c.modificationMinutes);
    const a = (c.audioPreset || 'standard').toLowerCase(), v = (c.videoPreset || 'standard').toLowerCase();
    if (!PRESETS.includes(a) || !PRESETS.includes(v)) throw new PricingError(`audioPreset and videoPreset must be one of: ${PRESETS.join(', ')}.`);
    if (minutes < 0 || mod < 0) throw new PricingError('Quantities cannot be negative.');
    if (minutes && a === 'none' && v === 'none') throw new PricingError('Choose at least one of audioPreset or videoPreset, or set minutes to 0.');
    if (!minutes && !mod) throw new PricingError('Enter minutes of content to index (or modificationMinutes).');
    const rs = await rows(`serviceName eq 'Foundry Tools' and productName eq 'Azure Video Indexer' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Video Indexer is not priced in ${ctx.region}.`);
    const G = 'AI', S = 'Foundry Tools', lines = [];
    const m = (name, what) => {
      const hit = rs.filter(r => r.meterName === `${name} Input Content Minutes`);
      if (!hit.length) throw new PricingError(`${what} is not priced in ${ctx.region}. Choose another preset (for example standard or advanced video) or another region such as eastus2 or westeurope.`);
      return single(hit, what);
    };
    if (minutes && a !== 'none') lines.push(meterLine(G, S, `Audio analysis, ${a} preset, ${fmtN(minutes)} minutes/month`, m(`${cap(a)} Audio Indexing Analysis`, `${a} audio indexing`), minutes, ctx, { unit: 'minutes' }));
    if (minutes && v !== 'none') lines.push(meterLine(G, S, `Video analysis, ${v} preset, ${fmtN(minutes)} minutes/month`, m(`${cap(v)} Video Indexing Analysis`, `${v} video indexing`), minutes, ctx, { unit: 'minutes' }));
    if (mod) lines.push(meterLine(G, S, `Video modification (encoding, face redaction), ${fmtN(mod)} minutes/month`, m('Video Modification', 'video modification'), mod, ctx, { unit: 'minutes' }));
    const notes = ['Video Indexer bills by the duration of the input file. When both audio and video are indexed, each minute is billed for the audio preset and again for the video preset.'];
    return { lines, notes, facts: { minutes, audioPreset: a, videoPreset: v, modificationMinutes: mod } };
  }
};
