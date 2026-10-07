'use strict';
// Foundry Tools (formerly Azure AI services / Cognitive Services): Language, Speech, Translator, Vision,
// Face, Content Safety, Custom Vision and Immersive Reader. Calculator slug: cognitive-services.
// Meters: serviceName 'Foundry Tools', regional (a few are 'Global'). One component = one feature of one tool.
// Document Intelligence, Content Understanding and Video Indexer share the serviceName but are other recipes.
const { query, single, meterLine, meterCost, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const SERVICE = 'Foundry Tools';

// Product names differ slightly between regions ("Translator Text" / "Azure Translator"), so match by pattern.
const P = {
  language: /^(Azure )?Language$/, speech: /^(Azure )?Speech$/, translator: /^(Azure )?Translator( Text)?$/,
  vision: /^(Azure )?Vision$/, face: /^(Azure )?Vision - Face$/, safety: /^Content Safety$/,
  custom: /^(Azure )?Custom Vision$/, reader: /Immersive Reader$/
};

// f(id, tool, product, meter, label, unit, extra). kind: use (default) | hosted (count x hours) | count (monthly units).
// scale: multiply the customer's number to get the raw meter quantity (tokens are entered in millions).
const DEPRECATED = 'Deprecated: Microsoft lists this under deprecated features, so it is for existing customers only.';
const NOT_ON_PAGE = 'This meter is in the Retail Prices API but not on the public pricing page; confirm it is still available to you.';
const FEATURES = [];
const f = (id, tool, p, m, label, unit, x) => FEATURES.push(Object.assign({ id, tool, p: P[p], m, label, unit }, x || {}));

// Language: a text record is up to 1,000 characters.
const REC = 'text records (1 record = up to 1,000 characters)';
f('text-analysis', 'language', 'language', 'Standard Text Records', 'Text analysis (sentiment, key phrases, entities, PII detection, language detection)', REC, { free: 'Free Text Records', allow: 5000, commit: 'lang-text' });
f('health-text-analysis', 'language', 'language', 'Standard Health Text Records', 'Text Analytics for health', REC);
f('summarization', 'language', 'language', 'Standard Summarization Text Records', 'Summarization', REC, { commit: 'lang-summ' });
f('custom-summarization', 'language', 'language', 'Standard Custom Summarization Text Records', 'Custom summarization', REC);
f('conversation-understanding', 'language', 'language', 'Standard CLU Text Records', 'Conversational language understanding (intents and entities)', REC, { commit: 'lang-clu' });
f('conversation-understanding-training', 'language', 'language', 'Standard CLU Advanced Training Unit', 'Conversational language understanding model training', 'training hours');
f('custom-text', 'language', 'language', 'Standard Custom Text Records', 'Custom text classification and custom entity recognition (predictions)', REC);
f('custom-text-training', 'language', 'language', 'Standard Custom Training Unit', 'Custom text model training', 'training hours');
f('custom-text-hosting', 'language', 'language', 'Standard Custom Hosting Unit', 'Custom text model endpoint hosting', 'hosted endpoints', { kind: 'count' });
f('question-answering', 'language', 'language', 'Standard QA Text Records', 'Question answering', REC);
f('document-pii-redaction', 'language', 'language', 'Doc-PII Redaction Pages', 'PII redaction in documents', 'document pages');

// Speech
f('speech-to-text', 'speech', 'speech', 'S1 Speech To Text', 'Speech to text, real-time', 'hours of audio', { free: 'Free Speech To Text', allow: 5, commit: 'stt' });
f('speech-to-text-batch', 'speech', 'speech', 'S1 Speech to Text Batch', 'Speech to text, batch', 'hours of audio');
f('speech-to-text-fast', 'speech', 'speech', 'Fast Transcription Speech To Text', 'Fast transcription (speech to text for files)', 'hours of audio', { commit: 'stt-fast', u: /^1 Hour$/ });
f('mai-transcribe', 'speech', 'speech', 'Fast Transcription Promo Speech To Text', 'MAI-Transcribe speech to text', 'hours of audio');
f('speech-to-text-enhanced', 'speech', 'speech', 'S1 Speech to Text Enhanced Feature Audio', 'Speech to text enhanced add-ons (diarization, pronunciation assessment and similar)', 'hours of audio', { commit: 'stt-addon' });
f('custom-speech-to-text', 'speech', 'speech', 'S1 Custom Speech To Text', 'Speech to text with a custom speech model, real-time', 'hours of audio', { free: 'Free Custom Speech To Text', allow: 5, commit: 'stt-custom' });
f('custom-speech-to-text-batch', 'speech', 'speech', 'S1 Custom Speech to Text Batch', 'Speech to text with a custom speech model, batch', 'hours of audio');
f('custom-speech-to-text-fast', 'speech', 'speech', 'Custom - Fast Transcription Speech To Text', 'Fast transcription with a custom speech model', 'hours of audio');
f('custom-speech-training', 'speech', 'speech', 'S1 Custom Speech Training', 'Custom speech model training', 'training hours');
f('custom-speech-hosting', 'speech', 'speech', 'S1 Custom Speech Model Hosting Unit', 'Custom speech model endpoint hosting', 'hosted models', { kind: 'hosted', u: /\/Hour$/, free: 'Free Custom Speech Model Hosting Unit', freeU: /\/Day$/, allow: 1 });
f('conversation-transcription', 'speech', 'speech', 'S1 Conversation Transcription Audio', 'Conversation transcription (meetings, who said what), audio (not on the public pricing page)', 'hours of audio', { flag: NOT_ON_PAGE });
f('conversation-transcription-multichannel', 'speech', 'speech', 'S1 Conversation Transcription Multichannel Audio', 'Conversation transcription, multichannel audio (not on the public pricing page)', 'hours of audio', { flag: NOT_ON_PAGE });
f('conversation-transcription-video', 'speech', 'speech', 'S1 Conversation Transcription Video', 'Conversation transcription, video (not on the public pricing page)', 'hours of video', { flag: NOT_ON_PAGE });
f('speech-translation', 'speech', 'speech', 'S1 Speech Translation', 'Speech translation', 'hours of audio', { free: 'Free Speech Translation', allow: 5 });
f('live-interpreter-input', 'speech', 'speech', 'Live Interpreter Input Audio', 'Live interpreter, input audio', 'hours of audio');
f('live-interpreter-output-standard-voice', 'speech', 'speech', 'Live Interpreter Std Audio Output', 'Live interpreter, spoken output with a standard voice', 'hours of audio');
f('live-interpreter-output-custom-voice', 'speech', 'speech', 'Live Interpreter Custom Audio', 'Live interpreter, spoken output with a custom voice', 'hours of audio');
f('live-interpreter-output-text', 'speech', 'speech', 'Live Interpreter Text Output Characters', 'Live interpreter, text output', 'characters');
f('text-to-speech', 'speech', 'speech', 'S1 Text To Speech Characters', 'Text to speech with standard voices (deprecated, existing customers only)', 'characters', { free: 'Free Text To Speech Characters', allow: 5e6, flag: DEPRECATED });
f('text-to-speech-neural', 'speech', 'speech', 'S1 Neural Text To Speech Characters', 'Text to speech with neural voices', 'characters', { free: 'Free Text To Speech Characters', allow: 5e5, commit: 'tts-neural' });
f('text-to-speech-neural-hd', 'speech', 'speech', 'Neural HD Text to Speech Characters', 'Text to speech with neural HD voices', 'characters');
f('text-to-speech-long-audio', 'speech', 'speech', 'S1 Neural Long Audio Characters', 'Text to speech long audio creation', 'characters');
f('custom-voice', 'speech', 'speech', 'S1 Custom Text To Speech Characters', 'Text to speech with a custom voice (non-neural; deprecated, existing customers only)', 'characters', { free: 'Free Custom Text To Speech Characters', allow: 5e6, flag: DEPRECATED });
f('custom-voice-hosting', 'speech', 'speech', 'S1 Custom Voice Font Hosting Unit', 'Custom voice endpoint hosting (non-neural; deprecated, existing customers only)', 'hosted voices', { kind: 'hosted', u: /\/Hour$/, free: 'Free Custom Voice Font Hosting Unit', freeU: /\/Day$/, allow: 1, flag: DEPRECATED });
f('custom-neural-voice', 'speech', 'speech', 'S1 Custom Neural Realtime Characters', 'Text to speech with a custom neural voice, real-time', 'characters');
f('custom-neural-voice-hd', 'speech', 'speech', 'CNV Neural HD Synthesis Characters', 'Text to speech with a custom neural HD voice', 'characters');
f('custom-neural-voice-long-audio', 'speech', 'speech', 'S1 Custom Neural Long Audio Characters', 'Text to speech with a custom neural voice, long audio', 'characters');
f('custom-neural-voice-training', 'speech', 'speech', 'S1 Custom Neural Training', 'Custom neural voice training (capped at 936 USD per training)', 'training hours', { capUsd: 936 });
f('custom-neural-voice-hosting', 'speech', 'speech', 'S1 Custom Neural Voice Model Hosting Unit', 'Custom neural voice endpoint hosting', 'hosted voices', { kind: 'hosted', u: /\/Hour$/ });
f('personal-voice', 'speech', 'speech', 'Text to Speech - Personal Voice Characters', 'Text to speech with personal voice', 'characters');
f('personal-voice-storage', 'speech', 'speech', 'Text to Speech - Personal Voice Voice Storage', 'Personal voice profile storage', 'voice profiles', { int: true });
f('avatar-standard-realtime', 'speech', 'speech', 'TTS Standard Avatar Realtime Speech', 'Text to speech avatar, standard avatar, real-time', 'minutes of video');
f('avatar-standard-batch', 'speech', 'speech', 'TTS Standard Avatar Batch Speech', 'Text to speech avatar, standard avatar, batch', 'minutes of video');
f('avatar-hd-standard-realtime', 'speech', 'speech', 'TTS HD Standard Avatar Realtime Speech', 'Text to speech avatar, standard avatar with HD voice, real-time', 'minutes of video');
f('avatar-hd-standard-batch', 'speech', 'speech', 'TTS HD Standard Avatar Batch Speech', 'Text to speech avatar, standard avatar with HD voice, batch', 'minutes of video');
f('avatar-custom-realtime', 'speech', 'speech', 'TTS Custom Avatar Realtime Speech', 'Text to speech avatar, custom avatar, real-time', 'minutes of video');
f('avatar-custom-batch', 'speech', 'speech', 'TTS Custom Avatar Batch Speech', 'Text to speech avatar, custom avatar, batch', 'minutes of video');
f('avatar-hd-custom-realtime', 'speech', 'speech', 'TTS HD Custom Avatar Realtime Speech', 'Text to speech avatar, custom avatar with HD voice, real-time', 'minutes of video');
f('avatar-hd-custom-batch', 'speech', 'speech', 'TTS HD Custom Avatar Batch Speech', 'Text to speech avatar, custom avatar with HD voice, batch', 'minutes of video');
f('avatar-custom-training', 'speech', 'speech', 'TTS Custom Avatar Training Unit', 'Custom avatar model training (limited access)', 'training hours');
f('avatar-custom-hosting', 'speech', 'speech', 'TTS Custom Avatar Hosting Unit', 'Custom avatar endpoint hosting', 'hosted avatars', { kind: 'hosted', u: /\/Hour$/ });
f('photo-avatar-creation', 'speech', 'speech', 'Photo Avatar Creation Images', 'Photo avatar creation', 'images', { int: true });
f('video-translation-input', 'speech', 'speech', 'Video Translation Input Audio', 'Video translation, input audio', 'hours of audio');
f('video-translation-output-standard-voice', 'speech', 'speech', 'Video Translation Std Audio Output', 'Video translation, output audio with a standard voice', 'hours of audio');
f('video-translation-output-custom-voice', 'speech', 'speech', 'Video Translation Cstm Audio Output', 'Video translation, output audio with a custom voice', 'hours of audio');
f('video-translation-automated', 'speech', 'speech', 'Video Translation Automated Speech', 'Video translation, automated (batch)', 'minutes of video');
f('video-translation-personal-voice', 'speech', 'speech', 'Video Translation AddOn PersonalVoice Speech', 'Video translation, personal voice add-on', 'minutes of video');
f('video-translation-editing', 'speech', 'speech', 'Video Translation Edit Text to Video Speech', 'Video translation, content editing', 'minutes of video');
f('speaker-verification', 'speech', 'speech', 'S1 Speaker Verification Transactions', 'Speaker verification (not on the public pricing page)', 'transactions', { flag: NOT_ON_PAGE });
f('speaker-identification', 'speech', 'speech', 'S1 Speaker Identification Transactions', 'Speaker identification (not on the public pricing page)', 'transactions', { flag: NOT_ON_PAGE });
f('speaker-voice-storage', 'speech', 'speech', 'S1 Voice Storage', 'Speaker recognition voice profile storage (not on the public pricing page)', 'voice profiles', { int: true, flag: NOT_ON_PAGE });

// Voice Live: billed per token. Customer numbers are in millions of tokens (scale 1e6, meters are per 1,000).
const VL_PARTS = [
  ['speech-audio-input', 'speech', 'Audio', 'Input'], ['speech-audio-output', 'speech', 'Audio', 'Output'], ['speech-audio-cached', 'speech', 'Audio', 'Cached'],
  ['model-audio-input', 'LLM', 'Audio', 'Input'], ['model-audio-output', 'LLM', 'Audio', 'Output'], ['model-audio-cached', 'LLM', 'Audio', 'Cached'],
  ['model-text-input', 'LLM', 'Text', 'Input'], ['model-text-output', 'LLM', 'Text', 'Output'], ['model-text-cached', 'LLM', 'Text', 'Cached'],
  ['model-image-input', 'LLM', 'Image', 'Input'], ['model-image-cached', 'LLM', 'Image', 'Cached'],
  ['model-text-output-realtime-2', 'LLM', 'Text', 'Output 2']
];
const VL_NAMES = { 'speech-audio-input': 'speech recognition and synthesis audio, input', 'speech-audio-output': 'speech recognition and synthesis audio, output', 'speech-audio-cached': 'speech audio, cached input',
  'model-audio-input': 'built-in AI model, audio input', 'model-audio-output': 'built-in AI model, audio output', 'model-audio-cached': 'built-in AI model, cached audio input',
  'model-text-input': 'built-in AI model, text input', 'model-text-output': 'built-in AI model, text output (gpt-realtime, gpt-4o, gpt-4.1, gpt-5, gpt-5-chat; pro tier)', 'model-text-output-realtime-2': 'built-in AI model, text output for gpt-realtime-2 and gpt-realtime-2.1 (pro tier only)', 'model-text-cached': 'built-in AI model, cached text input',
  'model-image-input': 'built-in AI model, image input', 'model-image-cached': 'built-in AI model, cached image input' };
for (const [part] of VL_PARTS) f(`voice-live-${part}`, 'speech', 'speech', null, `Voice Live, ${VL_NAMES[part]}`, 'million tokens', { voiceLive: part, scale: 1e6 });

// Translator
f('text-translation', 'translator', 'translator', 'S1 Characters', 'Text translation', 'characters', { free: 'Free Characters', allow: 2e6, commit: 'translator' });
f('document-translation', 'translator', 'translator', 'S1 Document Characters', 'Document translation', 'characters');
f('document-translation-images', 'translator', 'translator', 'S1 Image Images', 'Document translation of images (500 characters per image)', 'images', { int: true });
f('custom-translation', 'translator', 'translator', 'S1 Custom Translation Characters', 'Custom translation', 'characters');
f('custom-translation-training', 'translator', 'translator', 'S1 Custom Training Characters', 'Custom translation model training (capped at 300 USD per training)', 'characters of training data', { capUsd: 300 });
f('custom-translation-hosting', 'translator', 'translator', 'Custom Model Hosting Unit', 'Custom translation model hosting', 'hosted models', { kind: 'count' });
f('volume-plan', 'translator', 'translator', null, 'Translator volume-discount plan: c2/c3/c4 for custom translation, d3 for document translation (s2/s3/s4 are deprecated, existing customers only; for standard translation use a commitment tier)', 'characters', { volume: 'translator' });
f('legacy-volume-plan', 'language', 'language', null, 'Language legacy fixed-fee plan s0 to s4 (legacy, existing customers; new work should use pay as you go or a commitment tier)', REC, { volume: 'language', flag: 'Legacy fixed-fee Language plans are for pricing an existing resource; new work should use pay as you go or a commitment tier.' });

// Vision
f('image-analysis-basic', 'vision', 'vision', 'Image Analysis Group 1 Transactions', 'Image analysis: tags, objects, brands, face detection, adult content, celebrities, landmarks, color, image type, thumbnails, people detection, smart crops', 'transactions', { free: 'Free Transactions', allow: 5000 });
f('image-analysis-read', 'vision', 'vision', 'Image Analysis Group 2 Transactions', 'Image analysis: Read (OCR), describe, caption, dense captions', 'transactions', { free: 'Free Transactions', allow: 5000, commit: 'vision' });
f('custom-classification-training', 'vision', 'vision', 'Custom Image Classification Training', 'Image analysis custom image classification training', 'training hours');
f('custom-classification', 'vision', 'vision', 'Custom Image Classification Transactions', 'Image analysis custom image classification predictions', 'transactions', { free: 'Free Transactions', allow: 5000 });
f('custom-detection-training', 'vision', 'vision', 'Custom Object Detection Training', 'Image analysis custom object detection training', 'training hours');
f('custom-detection', 'vision', 'vision', 'Custom Object Detection Transactions', 'Image analysis custom object detection predictions', 'transactions', { free: 'Free Transactions', allow: 5000 });
f('spatial-analysis', 'vision', 'vision', 'Spatial Analysis Video Stream Edge', 'Spatial analysis, video streams on an edge device', 'stream hours');
f('image-vectorize', 'vision', 'vision', 'Vectorize Image Transactions', 'Multimodal embeddings, image vectorization', 'transactions', { global: true });
f('text-vectorize', 'vision', 'vision', 'Vectorize Text Transactions', 'Multimodal embeddings, text vectorization', 'transactions', { global: true });
f('image-retrieval-ingestion', 'vision', 'vision', 'Image Retrieval - Ingestion Transactions', 'Image retrieval, ingestion (not on the public pricing page or calculator)', 'transactions', { flag: NOT_ON_PAGE });
f('image-retrieval-query', 'vision', 'vision', 'Image Retrieval - Query Transactions', 'Image retrieval, queries (not on the public pricing page or calculator)', 'transactions', { flag: NOT_ON_PAGE });
f('video-retrieval-ingestion', 'vision', 'vision', 'Video Retrieval and Description - Ingestion Vision', 'Video retrieval and description, ingestion', 'hours of video', { global: true });
f('video-retrieval-query', 'vision', 'vision', 'Video Retrieval - Query Transactions', 'Video retrieval, queries', 'transactions', { global: true });
f('shelf-image-composition', 'vision', 'vision', 'Shelf Image Composition Transactions', 'Product recognition: shelf image composition', 'transactions');
f('shelf-planogram-compliance', 'vision', 'vision', 'Shelf Planogram Compliance Transactions', 'Product recognition: planogram compliance', 'transactions');
f('shelf-product-recognition', 'vision', 'vision', 'Shelf Product Recognition - Custom Objects', 'Product recognition: custom objects', 'objects', { int: true });

// Face
f('face-transactions', 'face', 'face', 'Standard Transactions', 'Face detection, verification, identification and grouping', 'transactions', { free: 'Free Transactions', allow: 30000 });
f('face-storage', 'face', 'face', 'Face Storage', 'Stored faces', 'faces stored', { int: true });
f('face-group-training', 'face', 'face', 'Standard Faces', 'Training a face group or index', 'faces trained (add up every retraining)');
f('face-liveness', 'face', 'face', 'Liveness Transactions', 'Face liveness checks', 'transactions');
f('face-liveness-verification', 'face', 'face', 'Liveness and Verification Transactions', 'Face liveness checks with face verification', 'transactions');

// Content Safety
f('moderate-text', 'content-safety', 'safety', 'Standard Text Records', 'Text moderation (also prompt shields, protected material and groundedness detection, billed as text records)', 'text records (1 record = up to 1,000 characters)', { free: 'Free Text Records', allow: 5000, commit: 'cs-text' });
f('moderate-images', 'content-safety', 'safety', 'Standard Images', 'Image moderation', 'images', { free: 'Free Images', allow: 5000, commit: 'cs-image' });

// Custom Vision
f('custom-vision-predictions', 'custom-vision', 'custom', 'S0 Transactions', 'Custom Vision uploads and predictions', 'transactions', { free: 'Free Transactions', allow: 10000 });
f('custom-vision-training', 'custom-vision', 'custom', 'S0 Training', 'Custom Vision training', 'training hours');
f('custom-vision-storage', 'custom-vision', 'custom', 'S0 Image Storage', 'Custom Vision image storage', 'stored images', { int: true });

// Immersive Reader: first 3 million characters a month are free.
f('immersive-reader', 'immersive-reader', 'reader', 'Commercial Characters', 'Immersive Reader, standard', 'characters');
f('immersive-reader-education', 'immersive-reader', 'reader', /^EDU[ /]Nonprofit Characters$/, 'Immersive Reader, education or nonprofit', 'characters');

const BY_ID = Object.fromEntries(FEATURES.map(x => [x.id, x]));
const TOOLS = { language: 'Language', speech: 'Speech', translator: 'Translator', vision: 'Vision', face: 'Face', 'content-safety': 'Content Safety', 'custom-vision': 'Custom Vision', 'immersive-reader': 'Immersive Reader' };

// Commitment tiers: fixed monthly (or annual, for disconnected containers) fee that includes a volume,
// plus an overage rate. Size in the SKU name is the included volume (K = thousand, M = million).
const SZ = '(\\d+[KM])';
const fam = (azure, connected, disc, p) => ({
  azure: azure && { p, sku: new RegExp(azure) }, connected: connected && { p, sku: new RegExp(connected) },
  disconnected: disc && { p: disc[0], sku: new RegExp(disc[1]), global: !!disc[2], sizes: disc[3] }
});
const FAMILIES = {
  'lang-text': fam(`^Commitment Tier Azure ${SZ}$`, `^Commitment Tier Connected ${SZ}$`, [/^(Azure )?Language - Disconnected$/, `^Commitment Tier Standard ${SZ}$`], P.language),
  'lang-summ': fam(`^Commitment Tier Summarization Azure ${SZ}$`, `^Commitment Tier Summarization Connected ${SZ}$`, [/^(Azure )?Language - Disconnected$/, `^Commitment Tier Summarization ${SZ}$`], P.language),
  'lang-clu': fam(`^Commitment Tier CLU Azure ${SZ}$`, `^Commitment Tier CLU Connected Cont ${SZ}$`, [/^(Azure )?Language - Disconnected$/, `^Commitment Tier DC CLU ${SZ}$`], P.language),
  translator: fam(`^Commitment Tier Azure ${SZ}$`, `^Commitment Tier Connected ${SZ}$`, [/^(Azure )?Translator - Disconnected$/, `^Commitment Tier Disconnected ${SZ}$`], P.translator),
  vision: fam(`^Commitment Tier Azure ${SZ}$`, `^Commitment Tier Connected ${SZ}$`, [/^(Azure )?Vision - Disconnected$/, `^Commitment Tier Disconnected ${SZ}$`], P.vision),
  'cs-text': fam(null, null, [/^Content Safety - Disconnected$/, `^Commitment Tier Txt DC ${SZ}(?: Unit)?$`, true], P.safety),
  'cs-image': fam(null, null, [/^Content Safety - Disconnected$/, `^Commitment Tier Image DC ${SZ}(?: Unit)?$`, true], P.safety),
  stt: fam(`^Commitment Tier Speech to Text Azure ${SZ}$`, `^Commitment Tier Speech to Text Connected ${SZ}$`, [/^(Azure )?Speech - Disconnected$/, `^Commitment Tier STT Disconnected ${SZ}$`], P.speech),
  'stt-fast': fam(null, null, [/^(Azure )?Speech - Disconnected$/, `^Fast Transcription Disconnected ${SZ}$`, false, { '100K': 50000 }], P.speech),
  'stt-custom': fam(`^Commitment Tier Custom Speech to Text Azure ${SZ}$`, `^Commit(ment)? Tier Custom (Speech to Text|STT) Connected ${SZ}$`, [/^(Azure )?Speech - Disconnected$/, `^Commitment Tier CSTT Disconnected ${SZ}$`], P.speech),
  'stt-addon': fam(`^Commitment Tier STT AddOn Azure ${SZ}$`, `^Commitment Tier STT AddOn Connected ${SZ}$`, [/^(Azure )?Speech - Disconnected$/, `^Commitment Tier STT AddOn ${SZ}$`], P.speech),
  'tts-neural': fam(`^Commitment Tier Neural Text to Speech Azure ${SZ}$`, `^Commit Tier Neural TTS Connected ${SZ}$`, [/^(Azure )?Speech - Disconnected$/, `^Commitment Tier NTTS Disconnected ${SZ}$`], P.speech)
};
const DEPLOY = { 'commitment': 'azure', 'commitment-connected-container': 'connected', 'commitment-disconnected-container': 'disconnected' };
const DEPLOY_TEXT = { azure: 'hosted by Azure', connected: 'in your own containers, connected to Azure for billing', disconnected: 'in your own containers, fully offline (annual commitment)' };

// Translator volume-discount plans. Included characters per month come from the Azure Pricing Calculator;
// the fixed fee is the daily "Unit" meter for a 31-day month, which is how the calculator shows it.
const VOLUME = {
  translator: { plans: { s2: 250e6, s3: 1000e6, s4: 10000e6, c2: 62.5e6, c3: 250e6, c4: 2500e6, d3: 675e6 }, over: V => `${V} Overage Characters`, what: 'characters', deprecated: /^s/ },
  language: { plans: { s0: 25e3, s1: 100e3, s2: 500e3, s3: 2.5e6, s4: 10e6 }, over: V => `${V} Overage Transactions`, what: 'text records' }
};
const ALL_VOLUME_PLANS = ['s0', 's1', 's2', 's3', 's4', 'c2', 'c3', 'c4', 'd3'];

const sizeValue = s => parseFloat(s) * (/M$/i.test(s) ? 1e6 : /K$/i.test(s) ? 1e3 : 1);
const PLANS = ['payg', 'free', 'commitment', 'commitment-connected-container', 'commitment-disconnected-container'];

// The same meterId is shared by several SKUs here (a commitment overage often equals a plain overage meter),
// so rows are fetched without kit.rows de-duplication and de-duplicated per selection instead.
const uniq = rs => { const seen = new Set(); return rs.filter(r => { const k = [r.meterId, r.tierMinimumUnits, r.retailPrice].join('|'); return !seen.has(k) && seen.add(k); }); };
// Per meter, prefer the region's own rows over 'Global' ones, then drop duplicates.
function reg(rs, region, allowGlobal) {
  if (!allowGlobal) return uniq(rs.filter(r => r.armRegionName === region));
  const own = new Set(rs.filter(r => r.armRegionName === region).map(r => r.meterId));
  return uniq(rs.filter(r => r.armRegionName === region || !own.has(r.meterId)));
}
function pick(rs, p, m, u, region, allowGlobal) {
  return reg(rs.filter(r => (!p || p.test(r.productName)) && (m instanceof RegExp ? m.test(r.meterName) : r.meterName === m) && (!u || u.test(r.unitOfMeasure))), region, allowGlobal);
}
// Every commitment tier of one family and deployment that can cover qty, with its monthly cost.
function tierCandidates(rs, cfg, annual, qty, region) {
  if (!cfg) return [];
  const tiers = new Map();
  for (const r of rs) {
    if (!cfg.p.test(r.productName)) continue;
    const m = r.skuName.match(cfg.sku);
    if (!m) continue;
    const t = tiers.get(r.skuName) || { sku: r.skuName, size: m[m.length - 1], rows: [] };
    t.rows.push(r); tiers.set(r.skuName, t);
  }
  const cands = [];
  for (const t of tiers.values()) {
    const rr = reg(t.rows, region, cfg.global);
    const feeRows = rr.filter(r => /\/(Month|Year)$/.test(r.unitOfMeasure));
    const overRows = rr.filter(r => !/\/(Month|Year)$/.test(r.unitOfMeasure));
    if (!feeRows.length) continue;
    const incl = (cfg.sizes && cfg.sizes[t.size.toUpperCase()]) || sizeValue(t.size);
    const fee = feeRows[0].retailPrice / (annual ? 12 : 1);
    const over = Math.max(0, qty - incl);
    if (over > 0 && (annual || !overRows.length)) continue;
    const overCost = over > 0 ? meterCost(overRows, over).cost : 0;
    cands.push({ t, incl, fee, feeRows, overRows, over, total: fee + overCost });
  }
  return cands;
}
module.exports = {
  type: 'foundry-tools',
  label: 'Foundry Tools (Azure AI services: Language, Speech, Translator, Vision, Face, Content Safety)',
  family: 'ai-services',
  mayBeZero: true,
  calculator: ['cognitive-services'],
  keywords: ['speech to text', 'text to speech', 'translator', 'translation', 'sentiment', 'ocr', 'content safety', 'face', 'cognitive services', 'ai services', 'transcription', 'voice live', 'language service'],
  fields: {
    tool: { req: true, enum: Object.keys(TOOLS), ask: `Which prebuilt AI service do they need? ${Object.entries(TOOLS).map(([k, v]) => `${k} = ${v}`).join('; ')}. Language = analysing or understanding text; Speech = voice to text, text to voice, spoken translation, avatars; Translator = translating text or documents; Vision = reading text in images (OCR), describing images; Face = face detection; Content Safety = screening text or images for harmful content. QnA Maker is retired: price it as Language question answering (feature question-answering). If they need several, add one component per feature. (Azure OpenAI, Document Intelligence and Content Understanding are priced elsewhere.)` },
    feature: { req: true, enum: FEATURES.map(x => x.id), ask: `What exactly will they do with it? One feature per component. ${Object.keys(TOOLS).map(t => `${t}: ${FEATURES.filter(x => x.tool === t).map(x => `${x.id} (${x.label})`).join('; ')}`).join('. ')}.` },
    quantity: { req: true, ask: 'How much will they use it in a month? The unit depends on the feature: text records (one record is up to 1,000 characters), characters, hours or minutes of audio or video, images, transactions (one API call), training hours, or for hosted models and endpoints how many are running. Voice Live is in millions of tokens. If unknown, ask for a typical day and multiply by 30, or suggest a small number and record it as an assumption.' },
    plan: { def: 'payg', enum: PLANS, ask: 'Do they want pay as you go (payg, the default, nothing committed), the free tier for a trial (free, limited volume), or a monthly commitment for a lower unit price (commitment, with Azure hosting the service)? If they will run the service in their own containers because of data residency or no internet access: commitment-connected-container (container reports usage to Azure) or commitment-disconnected-container (offline, annual).' },
    commitmentSize: { def: 'auto', ask: 'Only for commitment plans: which volume tier, such as 1M, 10K or 250M? (Disconnected containers are an annual commitment.) Leave as auto and the cheapest tier for their volume is chosen.' },
    trainings: { def: 1, ask: 'Only for training features: how many separate training runs a month? Each run is capped at a maximum charge (custom neural voice 936 USD, Translator custom model 300 USD).' },
    hours: { def: HOURS, ask: 'Only for hosted custom models, voices or avatars: how many hours a month are they deployed? (730 = all month.)' },
    voiceLiveTier: { def: 'standard', enum: ['lite', 'standard', 'pro', 'byo'], ask: 'Voice Live only: which tier? lite, standard or pro choose how capable the built-in AI model is; byo means they bring their own model. If unknown, use standard.' },
    voiceLiveVoice: { def: 'standard', enum: ['standard', 'custom'], ask: 'Voice Live only: does the assistant speak with a standard voice or a custom voice they trained? If unknown, use standard.' },
    volumePlan: { enum: ALL_VOLUME_PLANS, ask: 'Only for fixed-fee volume plans (features volume-plan and legacy-volume-plan): which plan? Translator: c2, c3 or c4 = custom translation, d3 = document translation (s2, s3 and s4 are deprecated and only for existing customers; for standard text translation use plan commitment instead). Language legacy: s0 to s4. No default: ask which plan the customer is on.' }
  },
  examples: [
    { type: 'foundry-tools', tool: 'language', feature: 'text-analysis', quantity: 2000000 },
    { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text', quantity: 1500, plan: 'commitment', commitmentSize: '2K' },
    { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text', quantity: 2500, plan: 'commitment' },
    { type: 'foundry-tools', tool: 'speech', feature: 'text-to-speech-neural', quantity: 30000000, plan: 'payg' },
    { type: 'foundry-tools', tool: 'speech', feature: 'custom-neural-voice-hosting', quantity: 1, hours: 400 },
    { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-text-output', quantity: 5, voiceLiveTier: 'pro' },
    { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-text-output-realtime-2', quantity: 3, voiceLiveTier: 'pro' },
    { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-speech-audio-input', quantity: 20, voiceLiveTier: 'standard', voiceLiveVoice: 'custom' },
    { type: 'foundry-tools', tool: 'translator', feature: 'text-translation', quantity: 400000000, plan: 'commitment' },
    { type: 'foundry-tools', tool: 'translator', feature: 'volume-plan', quantity: 300000000, volumePlan: 'c2' },
    { type: 'foundry-tools', tool: 'language', feature: 'legacy-volume-plan', quantity: 300000, volumePlan: 's1' },
    { type: 'foundry-tools', tool: 'vision', feature: 'image-analysis-read', quantity: 3000000, plan: 'commitment-connected-container' },
    { type: 'foundry-tools', tool: 'face', feature: 'face-transactions', quantity: 250000 },
    { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-text', quantity: 3000, plan: 'free' },
    { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-images', quantity: 100000 },
    { type: 'foundry-tools', tool: 'language', feature: 'summarization', quantity: 2000000, plan: 'commitment-disconnected-container' },
    { type: 'foundry-tools', tool: 'custom-vision', feature: 'custom-vision-predictions', quantity: 50000 }
  ],
  readback: c => {
    const x = BY_ID[c.feature];
    if (!x) return `Foundry Tools: ${c.feature}, ${fmtN(n(c.quantity))} a month`;
    let qty = `${fmtN(n(c.quantity))} ${x.unit}`;
    if (x.kind === 'hosted') qty = `${fmtN(n(c.quantity))} ${x.unit} deployed ${(c.hours ?? HOURS) < HOURS ? `${fmtN(c.hours)} hours a month` : 'all month'}`;
    else if (x.kind === 'count') qty = `${fmtN(n(c.quantity))} ${x.unit}`;
    else qty += ' a month';
    const plan = c.plan || 'payg';
    const extra = [];
    if (x.voiceLive) extra.push(`${c.voiceLiveTier || 'standard'} tier${x.voiceLive.startsWith('speech') ? `, ${c.voiceLiveVoice || 'standard'} voice` : ''}`);
    if (x.volume) extra.push(`volume plan ${String(c.volumePlan || '?').toUpperCase()}`);
    if (x.flag && x.flag === DEPRECATED) extra.push('deprecated');
    if (plan === 'free') extra.push('free tier');
    else if (plan !== 'payg') extra.push(`${plan === 'commitment-disconnected-container' ? 'annual' : 'monthly'} commitment${c.commitmentSize && c.commitmentSize !== 'auto' ? ` tier ${c.commitmentSize}` : ' (cheapest tier that fits)'}, ${DEPLOY_TEXT[DEPLOY[plan]] || plan}`);
    return `${TOOLS[x.tool]} - ${x.label}: ${qty}${extra.length ? ` (${extra.join('; ')})` : ''}`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded ? [] : ['Storage, networking, and the app or compute that calls the AI service are not included.']),
  price: async (c, ctx) => {
    let hint = null;
    const x = BY_ID[c.feature];
    if (!x) throw new PricingError(`Unknown Foundry Tools feature "${c.feature}". Known: ${FEATURES.map(y => y.id).join(', ')}.`);
    if (c.tool && c.tool !== x.tool) throw new PricingError(`Feature "${c.feature}" belongs to tool "${x.tool}", not "${c.tool}".`);
    const plan = c.plan || 'payg';
    if (!PLANS.includes(plan)) throw new PricingError(`plan must be one of ${PLANS.join(', ')}.`);
    const qty = n(c.quantity);
    if (!(qty >= 0)) throw new PricingError('quantity must be zero or more.');
    const rs = await query(`serviceName eq '${SERVICE}' and (armRegionName eq '${ctx.region}' or armRegionName eq 'Global') and priceType eq 'Consumption'`, ctx.currency);
    if (!rs.length) throw new PricingError(`Foundry Tools is not priced in ${ctx.region}.`);
    const G = 'AI', S = SERVICE, region = ctx.region, tool = TOOLS[x.tool];
    const hours = c.hours ?? HOURS;
    const notes = [], lines = [];
    const facts = { tool: x.tool, feature: x.id, plan, quantity: qty, commitmentSize: null };
    const need = (found, what) => {
      if (!found.length) { const e = new PricingError(`${what} is not offered in ${region}.`); e.notOffered = hint; throw e; }
      return single(found, what);
    };
    const pk = (p, m, u) => pick(rs, p, m, u, region, x.global);
    const setHint = m => { hint = m instanceof RegExp ? { prefix: m.source.replace(/^\^/, '').split(/[\\\[(.*+?$|{]/)[0], test: m, p: x.p } : { name: m, p: x.p }; };
    if (x.int && !Number.isInteger(qty)) throw new PricingError(`quantity for "${x.label}" must be a whole number.`);
    if (x.kind === 'hosted' || x.kind === 'count') { if (!Number.isInteger(qty)) throw new PricingError(`quantity for "${x.label}" must be a whole number of ${x.unit}.`); }
    if (x.flag) notes.push(x.flag);

    // Raw meter quantity and a short plain-words description of the quantity.
    const rawQty = x.kind === 'hosted' ? qty * hours : qty * (x.scale || 1);
    const qtyText = x.kind === 'hosted' ? `${fmtN(qty)} deployed x ${fmtN(hours)} hours` : `${fmtN(qty)} ${x.unit}`;

    if (x.volume) {
      const VT = VOLUME[x.volume], TN = x.volume === 'translator' ? 'Translator' : 'Language';
      if (!c.volumePlan) throw new PricingError(`volumePlan is required for ${TN} fixed-fee plans. Options: ${Object.keys(VT.plans).join(', ')}.`);
      const vp = String(c.volumePlan).toLowerCase();
      if (!VT.plans[vp]) throw new PricingError(`volumePlan for ${TN} must be one of ${Object.keys(VT.plans).join(', ')}.`);
      const V = vp.toUpperCase();
      setHint(`${V} Unit`);
      const unit = need(pk(x.p, `${V} Unit`, null), `${TN} ${V} plan fee`);
      setHint(VT.over(V));
      const over = need(pk(x.p, VT.over(V), null), `${TN} ${V} overage`);
      const incl = VT.plans[vp];
      lines.push(meterLine(G, S, `${TN} fixed-fee plan ${V}: ${fmtN(incl)} ${VT.what} included (31-day month)`, unit, 31, ctx, { unit: 'days' }));
      if (qty > incl) lines.push(meterLine(G, S, `${TN} ${V} plan overage: ${fmtN(qty - incl)} ${VT.what} above the included ${fmtN(incl)}`, over, VT.what === 'text records' ? (qty - incl) : qty - incl, ctx));
      notes.push(`${TN} ${V} plan: a fixed daily fee for the month that includes ${fmtN(incl)} ${VT.what}; usage beyond that is billed at the overage rate. The included volume comes from the Azure Pricing Calculator.`);
      if (VT.deprecated && VT.deprecated.test(vp)) notes.push('Translator S2, S3 and S4 are deprecated and only for existing customers; for new standard text translation use a commitment tier or pay as you go.');
      Object.assign(facts, { volumePlan: vp, includedQuantity: incl });
      return { lines, notes, facts };
    }

    // Usage meter rows (pay as you go / free).
    let usage;
    if (x.voiceLive) {
      const tier = (c.voiceLiveTier || 'standard').toLowerCase();
      const T = { lite: 'Lite', standard: 'Std', pro: 'Pro', byo: 'BYO' }[tier];
      if (!T) throw new PricingError('voiceLiveTier must be lite, standard, pro or byo.');
      const [, kind0, mod, dir] = VL_PARTS.find(p => p[0] === x.voiceLive);
      if (tier === 'byo' && kind0 === 'LLM') throw new PricingError('Voice Live "byo" means you bring your own model, so the built-in AI model is not billed. Use the speech parts only.');
      const voice = (c.voiceLiveVoice || 'standard').toLowerCase();
      if (!['standard', 'custom'].includes(voice)) throw new PricingError('voiceLiveVoice must be standard or custom.');
      const kind = kind0 === 'LLM' ? 'LLM' : voice === 'custom' ? 'Custom Speech' : 'Standard Speech';
      if (dir === 'Output 2' && tier !== 'pro') throw new PricingError('The gpt-realtime-2 text output meter exists only in the Voice Live pro tier. Use voiceLiveTier pro or the standard text-output part.');
      const dirRe = dir === 'Output 2' ? 'Output\\s+2' : dir === 'Output' ? 'Out(pu|p)?t' : dir === 'Cached' ? 'Cache[d]?' : 'Input';
      const re = new RegExp(`^Voice Live (API )?${T}\\s*-?\\s*${kind}\\s+${mod}\\s+${dirRe}\\s+Tokens$`);
      setHint(re);
      usage = need(pk(x.p, re, null), `Voice Live ${tier} ${VL_NAMES[x.voiceLive]}`);
      facts.voiceLiveTier = tier;
    } else if (plan !== 'free') {
      let m = x.m;
      if (x.id === 'custom-translation-training' && c.volumePlan) {
        const vp = String(c.volumePlan).toUpperCase();
        if (!['C2', 'C3', 'C4'].includes(vp)) throw new PricingError('For custom translation training volumePlan can only be c2, c3 or c4 (or leave it out for pay as you go).');
        m = `${vp} Custom Training Characters`;
        notes.push(`Training rate for the ${vp} plan.`);
      }
      setHint(m);
      usage = need(pk(x.p, m, x.u || (x.kind === 'hosted' ? /\/Hour$/ : null)), x.label);
    }
    const desc = what => `${tool}: ${what}`;

    if (plan === 'free') {
      if (!x.free) throw new PricingError(`There is no free tier for "${x.label}". Use plan "payg".`);
      if (x.allow !== undefined && qty > x.allow) throw new PricingError(`The free tier of "${x.label}" covers only ${fmtN(x.allow)} ${x.unit} a month; ${fmtN(qty)} is over. Use plan payg.`);
      setHint(x.free);
      const fr = need(pk(x.p, x.free, x.freeU || (x.kind === 'hosted' ? /\/Hour$/ : null)), `free tier of ${x.label}`);
      lines.push(meterLine(G, S, desc(`${x.label}, free tier, ${qtyText}`), fr, x.freeU ? qty * hours / 24 : rawQty, ctx));
      notes.push(x.allow !== undefined ? `The free tier includes ${fmtN(x.allow)} ${x.unit} a month (from the Azure Pricing Calculator); it is limited in speed and meant for trials.` : 'The free tier has no charge but is limited in volume and speed and is meant for trials; check the pricing page for the current monthly allowance.');
      return { lines, notes, facts };
    }

    if (plan === 'payg') {
      let billQty = rawQty;
      if (x.capUsd) {
        const runs = n(c.trainings ?? 1);
        if (!Number.isInteger(runs) || runs < 1) throw new PricingError('trainings must be a whole number of 1 or more.');
        if (ctx.currency === 'USD') {
          const per = meterCost(usage, rawQty / runs).cost;
          if (per > x.capUsd) { billQty = rawQty * (x.capUsd / per); notes.push(`Each training run is capped at ${x.capUsd} USD, so ${runs} run(s) of ${fmtN(qty / runs)} ${x.unit} cost ${fmtN(x.capUsd * runs)} USD instead of the uncapped ${fmtN(per * runs)}. The cap comes from the Azure Pricing Calculator and the pricing page.`); }
          else notes.push(`Each training run is capped at ${x.capUsd} USD; this volume (${runs} run(s)) is under the cap.`);
        } else notes.push(`Each training run is capped at ${x.capUsd} USD (converted amount not published), so the price shown may be higher than the real bill; the cap is not applied outside USD.`);
      }
      lines.push(meterLine(G, S, desc(`${x.label}, ${qtyText}${billQty !== rawQty ? ' (capped per training)' : ''}`), usage, billQty, ctx, x.kind === 'hosted' ? { unit: 'hours' } : undefined));
      if (usage.length > 1) notes.push('Price drops in bands as monthly volume grows; the bands apply to the total volume of this feature in the month.');
      if (x.id === 'immersive-reader' || x.id === 'immersive-reader-education') notes.push('The first 3 million characters a month are free.');
      if (/Group 1|Group 2/.test(x.m || '')) notes.push('Image analysis prices drop in bands as monthly transactions grow.');
      if (x.kind === 'hosted') notes.push('Hosted custom models, voices and avatars bill for every hour they are deployed, whether or not they are used.');
      if (/^Standard Health/.test(x.m || '')) notes.push('The first 5,000 text records a month for Text Analytics for health are free.');
      const az = x.commit && FAMILIES[x.commit].azure;
      if (az && qty > 0) {
        const paygCost = meterCost(usage, rawQty).cost, cs = tierCandidates(rs, az, false, qty, region);
        if (cs.length) {
          const best = cs.reduce((a, b) => (b.total < a.total ? b : a));
          if (best.total < paygCost) {
            facts.commitmentSaving = paygCost - best.total;
            facts.commitmentSuggested = best.t.size;
            notes.push(`A commitment tier (${best.t.size}) would cost about ${best.total.toFixed(2)} a month instead of ${paygCost.toFixed(2)} pay as you go at list price (estimate currency).`);
          }
        }
      }
      return { lines, notes, facts };
    }

    // Commitment tiers.
    const fm = FAMILIES[x.commit];
    if (!fm) throw new PricingError(`"${x.label}" has no commitment tier. Use plan "payg".`);
    const deploy = DEPLOY[plan], cfg = fm[deploy];
    if (!cfg) throw new PricingError(`"${x.label}" has no ${deploy} commitment tier. Use plan "commitment" or "payg".`);
    const annual = deploy === 'disconnected';
    const cands = tierCandidates(rs, cfg, annual, qty, region);
    if (!cands.length) throw new PricingError(`No complete {deploy} commitment tier (monthly fee and overage rate) for "${x.label}" in ${region} covers ${fmtN(qty)} ${x.unit} a month${annual ? ' (offline containers have no overage, so the volume must fit the tier)' : ''}.`);
    let ch;
    if (c.commitmentSize && c.commitmentSize !== 'auto') {
      const want = String(c.commitmentSize).toUpperCase().trim();
      ch = cands.find(k => k.t.size.toUpperCase() === want || (cfg.sizes && cfg.sizes[k.t.size.toUpperCase()] && `${cfg.sizes[k.t.size.toUpperCase()] / 1000}K` === want));
      if (!ch) throw new PricingError(`No commitment tier "${c.commitmentSize}" for "${x.label}" in ${region}. Available: ${cands.map(k => k.t.size).join(', ')}.`);
    } else {
      ch = cands.reduce((a, b) => (b.total < a.total ? b : a));
      notes.push(`No commitment size was given, so the cheapest tier for this volume was chosen: ${ch.t.size} (${fmtN(ch.incl)} ${x.unit} included a month).`);
    }
    const label = `${x.label} commitment tier ${ch.t.size}`;
    lines.push(meterLine(G, S, desc(`${label}, ${fmtN(ch.incl)} ${x.unit} included a month, ${DEPLOY_TEXT[deploy]}${annual ? ' (annual fee shown as one twelfth)' : ''}`), ch.feeRows, annual ? 1 / 12 : 1, ctx, { unit: annual ? 'year' : 'month' }));
    if (ch.over > 0) lines.push(meterLine(G, S, desc(`${x.label} overage above the commitment: ${fmtN(ch.over)} ${x.unit}`), ch.overRows, ch.over, ctx));
    notes.push(`A commitment tier is a fixed ${annual ? 'annual' : 'monthly'} fee that includes ${fmtN(ch.incl)} ${x.unit} a month; usage above that is billed at the overage rate. The fee is charged even if you use less.`);
    if (x.commit === 'stt-fast' && annual) notes.push('The Retail SKU for the largest fast transcription disconnected tier says 100K, but the Azure Pricing Calculator and the speech pricing page describe it as 50,000 hours a month, so capacity is checked against 50,000 hours.');
    if (annual) notes.push('Disconnected containers run fully offline with an annual commitment and have no overage, so choose a tier that covers peak monthly volume (extra units can be bought during the year).');
    try {
      const pg = need(pk(x.p, x.m, x.u || null), 'pay-as-you-go');
      const alt = meterCost(pg, rawQty).cost;
      notes.push(`For comparison, the same volume pay-as-you-go costs about ${alt.toFixed(2)} a month at list price (in the estimate currency).`);
      facts.paygList = alt;
    } catch (e) { /* no pay-as-you-go meter to compare with */ }
    Object.assign(facts, { commitmentSize: ch.t.size, includedQuantity: ch.incl, overageQuantity: ch.over, deployment: deploy });
    return { lines, notes, facts };
  }
};
const innerPrice = module.exports.price;
module.exports.price = async (c, ctx) => {
  try { return await innerPrice(c, ctx); } catch (e) {
    if (!e.notOffered) throw e;
    const h = e.notOffered;
    let regions = [];
    try {
      const flt = h.name ? `meterName eq '${h.name}'` : h.prefix ? `contains(meterName,'${h.prefix}')` : null;
      if (flt) {
        const all = await query(`serviceName eq '${SERVICE}' and ${flt} and priceType eq 'Consumption'`, ctx.currency);
        regions = [...new Set(all.filter(r => (!h.p || h.p.test(r.productName)) && (!h.test || h.test.test(r.meterName)) && r.armRegionName && r.armRegionName !== 'Global').map(r => r.armRegionName))].sort();
      }
    } catch (x) { /* listing is best effort */ }
    throw new PricingError(`${e.message} ${regions.length ? `It is offered in: ${regions.join(', ')}. Ask which region to use.` : 'Check another region.'}`);
  }
};
