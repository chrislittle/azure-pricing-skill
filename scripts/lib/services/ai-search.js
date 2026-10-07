'use strict';
// Azure AI Search (Foundry IQ). Calculator slug: search.
// Meters: serviceName 'Azure Cognitive Search', productName 'Azure AI Search'. Dedicated tiers bill per search unit
// (replicas x partitions) per hour; premium features (semantic ranker, agentic retrieval, image extraction, custom
// entity lookup) bill on usage; the serverless preview bills compute-unit hours plus GB stored.
const { rows, single, regionFilter, meterLine, PricingError, fmtN, HOURS } = require('../kit');

const n = v => Number(v || 0);
const TIERS = {
  free: { sku: 'Free', name: 'Free', max: { r: 1, p: 1 } },
  basic: { sku: 'Basic', name: 'Basic', max: { r: 3, p: 3 } },
  s1: { sku: 'Standard S1', name: 'Standard S1', max: { r: 12, p: 12 } },
  s2: { sku: 'Standard S2', name: 'Standard S2', max: { r: 12, p: 12 } },
  s3: { sku: 'Standard S3', name: 'Standard S3', max: { r: 12, p: 12 } },
  l1: { sku: 'Storage Optimized L1', name: 'Storage Optimized L1', max: { r: 12, p: 12 } },
  l2: { sku: 'Storage Optimized L2', name: 'Storage Optimized L2', max: { r: 12, p: 12 } },
  serverless: { name: 'Serverless (preview)' }
};
const REASONING = { minimum: 'Agentic Retrieval Minimum Reasoning Tokens', low: 'Agentic Retrieval Low Reasoning Tokens', medium: 'Agentic Retrieval Medium Reasoning Tokens' };
const SEMANTIC_FREE_QUERIES = 1000;
const AGENTIC_FREE_MTOKENS = 50;

module.exports = {
  type: 'ai-search',
  label: 'Azure AI Search (Foundry IQ)',
  family: 'ai-services',
  calculator: ['search'],
  keywords: ['search', 'ai search', 'cognitive search', 'vector search', 'semantic search', 'rag', 'foundry iq', 'agentic retrieval', 'knowledge base', 'index'],
  fields: {
    tier: { def: 's1', enum: Object.keys(TIERS), ask: 'How big is the search index? Tiny test or tutorial with under 50 MB and 10,000 documents -> free (no SLA, one copy only). Per-partition storage on services created after April 2024 (older services have less): basic 15 GB, s1 160 GB, s2 512 GB, s3 1 TB, l1 2 TB, l2 4 TB. Small production app up to 15 GB per partition -> basic; up to 160 GB -> s1; larger indexes -> s2 or s3 (only when s1 will not fit, they cost much more). Very large, rarely changing archives that can tolerate slower queries -> l1 or l2. Only occasional or very spiky use and a preview service is fine -> serverless. If unknown, suggest s1 and record it as an assumption.' },
    replicas: { def: 1, int: true, min: 1, ask: 'How many copies (replicas) of the search service should answer queries? One is enough for a test; use at least 2 for a production app that must stay up during maintenance, and 3 if it also writes (indexes) while serving. Each extra copy multiplies the hourly cost. Not used for serverless.' },
    partitions: { def: 1, int: true, min: 1, ask: 'How many partitions (slices of storage) do you need? One partition holds a fixed amount of data for the tier chosen; add partitions only when the index will not fit or indexing is too slow. If unknown, suggest 1 and record it as an assumption. Not used for serverless.' },
    confidential: { def: false, ask: 'Does the data need confidential computing (hardware-encrypted memory, a "CC" service)? Yes -> true; most people say no. Not available on free. Confidential computing disables or restricts semantic ranker, agentic retrieval, query rewrite and skillset features (image extraction, custom entity lookup), so it cannot be combined with those quantities.' },
    hours: { def: 730, ask: 'Hours a month the search service exists (730 = all month). It bills every hour it exists even when idle; the only way to stop billing is to delete the service.' },
    semanticQueries: { def: 0, int: true, min: 0, ask: 'Will searches use the semantic ranker (better relevance with Microsoft language models)? If yes, roughly how many such queries a month? The first 1,000 each month are free; use 0 if they will not use it.' },
    agenticTokens: { def: 0, min: 0, ask: 'Will an AI agent use agentic retrieval (the service plans subqueries, runs them and reranks)? If yes, roughly how many million tokens a month does the reranking handle? (Chunks reranked x tokens per chunk.) The first 50 million tokens a month are free (one allowance across reasoning levels), so a small workload costs nothing; agentic retrieval needs Basic or higher beyond that. Use 0 if they will not use it. The language model that plans the queries and writes the answer is billed separately by Azure OpenAI/Foundry.' },
    agenticReasoning: { def: 'low', enum: Object.keys(REASONING), ask: 'How much reasoning effort should agentic retrieval use? minimal or low -> low-cost planning (minimum / low); medium -> deeper planning at a higher per-token rate (medium). If unknown, suggest low and record it as an assumption.' },
    imageExtractions: { def: 0, int: true, min: 0, ask: 'Will the indexer pull images out of documents (for example PDFs) so they can be analysed (OCR, captions)? If yes, how many images a month? Text extraction is free; only images are billed. Use 0 if none.' },
    customEntityRecords: { def: 0, int: true, min: 0, ask: 'Will a skillset use the Custom Entity Lookup skill to find your own terms in text? If yes, how many text records (about 1,000 characters each) a month? Use 0 if none.' },
    serverlessComputeHours: { def: 0, ask: 'Serverless only: how many compute-unit hours a month do queries, indexing and enrichment use? If unknown, suggest 100 and record it as an assumption (it is measured after a trial with a sample).' },
    serverlessStorageGb: { def: 0, ask: 'Serverless only: how many GB will the indexes occupy on disk?' }
  },
  context: ['production', 'zoneResilience'],
  examples: [
    { type: 'ai-search', tier: 's1', replicas: 2, partitions: 1 },
    { type: 'ai-search', tier: 's2', replicas: 3, partitions: 2, hours: 730, semanticQueries: 250000, agenticTokens: 80, agenticReasoning: 'medium', imageExtractions: 8000, customEntityRecords: 20000 },
    { type: 'ai-search', tier: 'basic', replicas: 3, partitions: 1, semanticQueries: 500 }
  ],
  readback: c => {
    const tier = (c.tier || 's1').toLowerCase();
    const T = TIERS[tier] || { name: tier };
    const hrs = (c.hours ?? HOURS) === HOURS ? 'running all month' : `${fmtN(c.hours)} hours a month`;
    const parts = [];
    if (tier === 'serverless') parts.push(`Azure AI Search ${T.name}: ${fmtN(n(c.serverlessComputeHours))} compute-unit hours a month, ${fmtN(n(c.serverlessStorageGb))} GB of indexed storage`);
    else {
      const r = n(c.replicas ?? 1), p = n(c.partitions ?? 1);
      parts.push(`Azure AI Search ${T.name}${c.confidential ? ' (confidential computing)' : ''}: ${fmtN(r)} replica(s) x ${fmtN(p)} partition(s) = ${fmtN(r * p)} search units, ${hrs}`);
    }
    if (n(c.semanticQueries)) parts.push(`${fmtN(c.semanticQueries)} semantic ranker queries a month (first ${fmtN(SEMANTIC_FREE_QUERIES)} free)`);
    if (n(c.agenticTokens)) parts.push(`${fmtN(c.agenticTokens)} million agentic retrieval tokens a month at ${c.agenticReasoning || 'low'} reasoning (first ${AGENTIC_FREE_MTOKENS} million free)`);
    if (n(c.imageExtractions)) parts.push(`${fmtN(c.imageExtractions)} images extracted from documents a month`);
    if (n(c.customEntityRecords)) parts.push(`${fmtN(c.customEntityRecords)} Custom Entity Lookup text records a month`);
    return parts.join('; ');
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Azure OpenAI / Foundry models for embeddings, query planning, answer synthesis and built-in AI skills (billed on those services)',
    'The data source and storage account that hold the documents to index (and knowledge store or enrichment cache storage)',
    'Private endpoints, bandwidth and customer-managed key (Key Vault) charges'
  ],
  price: async (c, ctx) => {
    const tier = (c.tier || 's1').toLowerCase();
    const T = TIERS[tier];
    if (!T) throw new PricingError(`Unknown tier "${c.tier}". Use one of: ${Object.keys(TIERS).join(', ')}.`);
    const hours = c.hours ?? HOURS;
    if (hours < 0 || hours > 744) throw new PricingError('hours must be between 0 and 744 (the longest month).');
    const r = n(c.replicas ?? 1), p = n(c.partitions ?? 1), su = r * p;
    const sem = n(c.semanticQueries), tok = n(c.agenticTokens), img = n(c.imageExtractions), cer = n(c.customEntityRecords);
    const reasoning = (c.agenticReasoning || 'low').toLowerCase();
    if (!REASONING[reasoning]) throw new PricingError(`agenticReasoning must be one of: ${Object.keys(REASONING).join(', ')}.`);
    if ([sem, tok, img, cer, n(c.serverlessComputeHours), n(c.serverlessStorageGb)].some(v => v < 0)) throw new PricingError('Quantities cannot be negative.');
    if (tier !== 'serverless') {
      if (!(r >= 1 && p >= 1) || !Number.isInteger(r) || !Number.isInteger(p)) throw new PricingError('replicas and partitions must be whole numbers of at least 1.');
      if (r > T.max.r || p > T.max.p) throw new PricingError(`The ${T.name} tier allows at most ${T.max.r} replica(s) and ${T.max.p} partition(s).`);
      if (tier === 'basic' && su > 9) throw new PricingError('The Basic tier is limited to 9 search units.');
      if (su > 36) throw new PricingError('A Standard or Storage Optimized service is limited to 36 search units (replicas x partitions).');
      if (c.confidential && (sem || tok || img || cer)) throw new PricingError('Confidential computing disables or restricts semantic ranker, agentic retrieval, query rewrite and skillset execution (image extraction, custom entity lookup); remove confidential or set those quantities to 0.');
      if (tier === 'free' && tok > AGENTIC_FREE_MTOKENS) throw new PricingError(`The Free tier can only use the free agentic retrieval allowance (${AGENTIC_FREE_MTOKENS} million tokens a month); the paid agentic plan needs Basic or higher.`);
      if (tier === 'free' && c.confidential) throw new PricingError('The Free tier has no confidential computing option.');
      if (tier === 'free' && sem > SEMANTIC_FREE_QUERIES) throw new PricingError(`The Free tier can only use the free semantic ranker allowance (${fmtN(SEMANTIC_FREE_QUERIES)} queries a month); the pay-as-you-go plan needs Basic or higher.`);
    } else if (c.confidential) throw new PricingError('Serverless has no confidential computing option.');
    else if (r > 1 || p > 1) throw new PricingError('Serverless has no replicas or partitions; use serverlessComputeHours and serverlessStorageGb instead.');

    // Enrichment meters are listed in the service's own region; fall back to the Global rows when a region has none.
    const rs = await rows(`serviceName eq 'Azure Cognitive Search' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure AI Search is not priced in ${ctx.region}.`);
    let glob = [];
    const need = (name, rr) => { const hit = rr.filter(x => x.meterName === name); return hit.length ? hit : glob.filter(x => x.meterName === name); };
    if (sem || tok || img || cer) glob = await rows(`serviceName eq 'Azure Cognitive Search' and armRegionName eq 'Global' and priceType eq 'Consumption'`, ctx);
    const byName = (name, what) => single(need(name, rs), `Azure AI Search ${what} in ${ctx.region}`);
    const G = 'AI', S = 'Azure Cognitive Search', lines = [];
    const notes = ['Azure AI Search bills every hour the service exists, even when idle; stopping the charge means deleting the service.'];

    if (tier === 'serverless') {
      const comp = rs.filter(x => x.meterName === 'Serverless Compute Unit'), stor = rs.filter(x => x.meterName === 'Serverless Storage Data Stored');
      if (!comp.length || !stor.length) throw new PricingError(`Serverless Azure AI Search is not offered in ${ctx.region}; pick a region where the serverless preview is available.`);
      if (!n(c.serverlessComputeHours) && !n(c.serverlessStorageGb)) throw new PricingError('Serverless needs serverlessComputeHours and/or serverlessStorageGb.');
      if (n(c.serverlessComputeHours)) lines.push(meterLine(G, S, `Azure AI Search serverless compute, ${fmtN(c.serverlessComputeHours)} compute-unit hours/month`, single(comp, 'serverless compute'), n(c.serverlessComputeHours), ctx, { unit: 'CU hours' }));
      if (n(c.serverlessStorageGb)) lines.push(meterLine(G, S, `Azure AI Search serverless indexed storage, ${fmtN(c.serverlessStorageGb)} GB`, single(stor, 'serverless storage'), n(c.serverlessStorageGb), ctx, { unit: 'GB / month' }));
      notes.push('Serverless is a preview with no SLA. It has no idle compute charge, but indexed storage always bills.');
    } else {
      const cc = !!c.confidential && tier !== 'free';
      const meter = `${T.sku}${cc ? ' CC' : ''} Unit`;
      const unit = rs.filter(x => x.meterName === meter);
      if (!unit.length) throw new PricingError(`${T.name}${cc ? ' with confidential computing' : ''} is not priced in ${ctx.region}.`);
      lines.push(meterLine(G, S, `Azure AI Search ${T.name}${cc ? ' (confidential computing)' : ''}: ${fmtN(r)} replica(s) x ${fmtN(p)} partition(s) = ${fmtN(su)} search units x ${fmtN(hours)} hours`, single(unit, `${T.name} search unit`), su * hours, ctx, { unit: 'search-unit hours' }));
      notes.push('Search units = replicas x partitions; each search unit bills at the tier\'s hourly rate.');
      if (tier === 'free') notes.push('The Free tier is shared, has no SLA, cannot scale, and is limited to 50 MB, 10,000 documents and 3 indexes.');
    }

    if (sem) {
      const billable = Math.max(0, sem - SEMANTIC_FREE_QUERIES);
      const q = need('Semantic Ranker queries', rs);
      if (!q.length) throw new PricingError(`Semantic ranker is not priced in ${ctx.region}.`);
      lines.push(meterLine(G, S, `Semantic ranker queries, ${fmtN(sem)}/month less ${fmtN(Math.min(sem, SEMANTIC_FREE_QUERIES))} free = ${fmtN(billable)} billed`, single(q, 'semantic ranker queries'), billable, ctx, { unit: 'queries' }));
      notes.push(`Semantic ranker: the first ${fmtN(SEMANTIC_FREE_QUERIES)} queries a month are free; after that the standard plan (Basic tier or higher) bills per 1,000 queries that use queryType=semantic.`);
    }
    if (tok) {
      const t = need(REASONING[reasoning], rs);
      if (!t.length) throw new PricingError(`Agentic retrieval (${reasoning} reasoning) is not priced in ${ctx.region}.`);
      const billableTok = Math.max(0, tok - AGENTIC_FREE_MTOKENS);
      lines.push(meterLine(G, S, `Agentic retrieval, ${fmtN(tok)} million tokens/month less ${fmtN(Math.min(tok, AGENTIC_FREE_MTOKENS))} million free = ${fmtN(billableTok)} million billed at ${reasoning} reasoning`, single(t, 'agentic retrieval tokens'), billableTok * 1e6, ctx, { unit: 'tokens' }));
      notes.push(`Agentic retrieval: the first ${AGENTIC_FREE_MTOKENS} million tokens a month are free (one allowance shared across reasoning levels, per the pricing page); the rest bill at the pay-as-you-go rate and need the Basic tier or higher. The language model that plans queries and writes answers is billed by Azure OpenAI/Foundry.`);
    }
    if (img) {
      lines.push(meterLine(G, S, `Image extraction from documents (AI enrichment), ${fmtN(img)} images/month`, byName('Document Cracking Image Extraction', 'image extraction'), img, ctx, { unit: 'images' }));
      notes.push('Image extraction bills per 1,000 images in graduated bands; text extraction is free.');
    }
    if (cer) {
      lines.push(meterLine(G, S, `Custom Entity Lookup skill, ${fmtN(cer)} text records/month`, byName('Custom Entity Skills Text Records', 'custom entity skills'), cer, ctx, { unit: 'text records' }));
      notes.push('Custom Entity Lookup bills per 1,000 text records in graduated bands. Band edges follow the Retail Prices API (0.5M, 2.5M and 10M records), which differ from the 1M/3M/10M labels on the pricing page; the Retail API is the billing source.');
    }
    return { lines, notes, facts: { tier, confidential: !!c.confidential, replicas: r, partitions: p, searchUnits: tier === 'serverless' ? 0 : su, semanticQueries: sem, agenticTokens: tok, imageExtractions: img, customEntityRecords: cer } };
  }
};
