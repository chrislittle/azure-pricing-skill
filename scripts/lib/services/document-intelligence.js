'use strict';
// Azure Document Intelligence (formerly Form Recognizer). Calculator slug: form-recognizer.
// Meters: serviceName 'Foundry Tools', productName 'Azure Document Intelligence'. S0 pay-as-you-go meters are
// per 1,000 pages (Read is graduated); commitment tiers are a monthly unit price plus a per-1,000-page overage.
const { rows, single, regionFilter, meterLine, meterCost, PricingError, fmtN } = require('../kit');

const n = v => Number(v || 0);
const FREE_PAGES = 500;
// field -> [S0 meter, batch S0 meter, plain description]
const FEATURES = {
  readPages: ['S0 Read Pages', 'S0 Batch Read Pages', 'Read (text extraction)'],
  prebuiltPages: ['S0 Pre-built Pages', 'S0 Batch Pre-built Pages', 'Layout and pre-built models (invoice, receipt, ID, business card, W-2, document)'],
  customExtractionPages: ['S0 Custom Pages', 'S0 Batch Custom Extraction Pages', 'custom extraction models'],
  customGenerativePages: ['S0 Custom Generative Pages', 'S0 Batch Custom Generative Pages', 'custom generative extraction models'],
  classificationPages: ['S0 pages for doc classifier', 'S0 Batch Document Classifier Pages', 'custom document classification'],
  queryFieldsPages: ['S0 pages for query fields', 'S0 Batch Pages for Query Fields', 'query fields add-on'],
  addOnPages: ['S0 Add-on for Pages', 'S0 Batch Add-On Pages',   'add-on capabilities (high resolution, formulas, fonts)'],
    queryPages: ['S0 Query Pages', null, 'the separately priced Query meter']
};
const COMMIT = { read: ['Read', 'readPages', 'Read'], prebuilt: ['Pre-Built', 'prebuiltPages', 'layout and pre-built'], custom: ['Custom', 'customExtractionPages', 'custom extraction'] };
const HOST = { azure: 'Azure', 'connected-container': 'Connected', 'disconnected-container': 'Disconnected' };
const kSizes = names => [...new Set(names.map(x => Number(x.match(/ (\d+)K (?:CT )?(?:Unit|Overage)/)[1])))].sort((a, b) => a - b).map(k => fmtN(k * 1000)).join(', ');

module.exports = {
  type: 'document-intelligence',
  label: 'Azure Document Intelligence',
  family: 'ai-services',
  calculator: ['form-recognizer'],
  keywords: ['document intelligence', 'form recognizer', 'ocr', 'invoice', 'receipt', 'extract text from documents', 'pdf', 'forms', 'id documents'],
  fields: {
    plan: { def: 'payg', enum: ['payg', 'free', 'commitment'], ask: 'Is this a trial of up to 500 pages a month (free), normal pay-as-you-go use (payg), or high steady volume where a monthly prepaid commitment tier is cheaper (commitment)? If unknown, suggest payg and record it as an assumption.' },
    readPages: { int: true, min: 0, def: 0, ask: 'How many document pages a month need plain text extraction (OCR / "Read") only? Use 0 if none.' },
    prebuiltPages: { int: true, min: 0, def: 0, ask: 'How many pages a month go through Microsoft\'s ready-made models, such as layout (tables, structure), invoices, receipts, IDs, business cards or tax forms? Use 0 if none.' },
    customExtractionPages: { int: true, min: 0, def: 0, ask: 'How many pages a month go through a custom model you trained to pull out your own fields? Use 0 if none.' },
    customGenerativePages: { int: true, min: 0, def: 0, ask: 'How many pages a month use a custom generative (AI-assisted) extraction model? Use 0 if none.' },
    classificationPages: { int: true, min: 0, def: 0, ask: 'How many pages a month are sorted by a custom document classifier (what type of document is this)? Use 0 if none.' },
    queryFieldsPages: { int: true, min: 0, def: 0, ask: 'How many pages a month use the query-fields add-on to ask for extra fields with a prompt? Use 0 if none.' },
    addOnPages: { int: true, min: 0, def: 0, ask: 'How many pages a month need add-on capabilities     such as high-resolution OCR, formulas or font styles? (Barcode extraction is free and does not count.) Use 0 if none.' },
        queryPages: { int: true, min: 0, def: 0, ask: 'Leave at 0 unless the customer knows their bill uses the separate "Query" meter (not the same as query fields). How many pages a month use it?' },
        trainingHours: { def: 0, min: 0, ask: 'Will you train custom neural models? Microsoft: template training is free and neural training is free for the first 10 hours only, then $3 an hour (list price). Give only the neural training hours beyond the first 10 (for example 15 hours in total -> 5). Learn: "Billing is calculated for the actual time spent training the neural model with a minimum of 30 minutes per training job." Use 0 if none.' },
    batch: { def: false, ask: 'Will the documents be submitted through the asynchronous batch API (large offline jobs, many files at once)? Yes -> true; most apps say no. Query pages are not available through batch.' },
    commitmentFeature: { def: 'read', enum: Object.keys(COMMIT), ask: 'Commitment plans only: which feature does the commitment cover? Plain text extraction -> read; layout and ready-made models -> prebuilt; custom extraction models -> custom.' },
    commitmentPages: { int: true, min: 0, def: 0, ask: 'Commitment plans only: how many pages a month do they want to commit to? Sizes: read 500,000 / 2,000,000 / 8,000,000 / 16,000,000; prebuilt and custom 20,000 / 100,000 / 500,000 / 1,000,000. Disconnected containers: read 2,000,000 / 8,000,000 / 16,000,000; prebuilt and custom 100,000 / 500,000 / 1,000,000. Pick the size just below their steady monthly volume; the pages above it are billed at an overage rate.' },
    commitmentHosting: { def: 'azure', enum: Object.keys(HOST), ask: 'Commitment plans only: do the documents run in Azure (azure) in a container the customer hosts and connects to Azure for billing (connected-container), or in an offline container with no connection (disconnected-container, bought as a yearly plan)? If unknown, suggest azure.' }
  },
  examples: [
    { type: 'document-intelligence', readPages: 200000 },
    { type: 'document-intelligence', plan: 'payg', readPages: 1500000, prebuiltPages: 40000, customExtractionPages: 12000, customGenerativePages: 2000, classificationPages: 10000, queryFieldsPages: 3000, addOnPages: 5000, queryPages: 100, trainingHours: 8 },
    { type: 'document-intelligence', plan: 'commitment', commitmentFeature: 'prebuilt', commitmentPages: 100000, commitmentHosting: 'azure', prebuiltPages: 130000, readPages: 0, trainingHours: 2 }
  ],
  readback: c => {
    const parts = [];
    for (const [k, v] of Object.entries(FEATURES)) if (n(c[k])) parts.push(`${fmtN(c[k])} pages of ${v[2]}`);
    if (n(c.trainingHours)) parts.push(`${fmtN(c.trainingHours)} billed training hours (beyond the free first 10)`);
    const plan = c.plan || 'payg';
    let head = 'Document Intelligence';
    if (plan === 'free') head += ' free tier (up to 500 pages a month)';
    else if (plan === 'commitment') head += ` ${COMMIT[c.commitmentFeature || 'read'] ? COMMIT[c.commitmentFeature || 'read'][2] : ''} commitment tier of ${fmtN(n(c.commitmentPages))} pages a month (${(c.commitmentHosting || 'azure') === 'azure' ? 'run in Azure' : (c.commitmentHosting === 'disconnected-container' ? 'disconnected container, yearly plan' : 'connected container')})`;
    else head += ' pay-as-you-go';
    if (c.batch) head += ', batch API';
    return `${head}: ${parts.length ? parts.join(', ') : '0 pages'} a month`;
  },
  notIncluded: (types, spec) => (spec && spec.excluded) ? [] : [
    'Storage for the documents and training data, and the app or workflow that submits them',
    'The compute that hosts connected or disconnected containers'
  ],
  price: async (c, ctx) => {
    const plan = (c.plan || 'payg').toLowerCase();
    if (!['payg', 'free', 'commitment'].includes(plan)) throw new PricingError('plan must be payg, free or commitment.');
    const qty = {};
    for (const k of Object.keys(FEATURES)) { qty[k] = n(c[k]); if (qty[k] < 0) throw new PricingError(`${k} cannot be negative.`); }
    const train = n(c.trainingHours);
    if (train < 0) throw new PricingError('trainingHours cannot be negative.');
    const total = Object.values(qty).reduce((a, b) => a + b, 0);
    if (!total && !train) throw new PricingError('Enter at least one page quantity (for example readPages).');
    const batch = !!c.batch;
    if (batch && qty.queryPages) throw new PricingError('Query pages are not available through the batch API; set batch to false or queryPages to 0.');
    const G = 'AI', S = 'Foundry Tools', lines = [];
    const rs = await rows(`serviceName eq 'Foundry Tools' and productName eq 'Azure Document Intelligence' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx);
    if (!rs.length) throw new PricingError(`Azure Document Intelligence is not priced in ${ctx.region}.`);
    const notes = [];
    const facts = { plan, totalPages: total, trainingHours: train, batch, commitmentPages: 0, commitmentFeature: null, commitmentWorthChecking: false };

    if (plan === 'free') {
      if (total > FREE_PAGES) throw new PricingError(`The free tier covers up to ${fmtN(FREE_PAGES)} pages a month in total; use plan "payg" for ${fmtN(total)} pages.`);
      if (train) throw new PricingError('Paid training hours are not part of the free tier; use plan "payg".');
      const free = single(rs.filter(r => r.meterName === 'Free Transactions'), 'free tier');
      lines.push(meterLine(G, S, `Document Intelligence free tier, ${fmtN(total)} pages/month (up to ${fmtN(FREE_PAGES)} included)`, free, total, ctx, { unit: 'pages' }));
      notes.push(`The free tier includes up to ${fmtN(FREE_PAGES)} pages a month. With a free-tier subscription, only the first two pages of each document are processed.`);
      return { lines, notes, facts };
    }

    let committed = null;
    if (plan === 'commitment') {
      const feat = COMMIT[(c.commitmentFeature || 'read').toLowerCase()];
      const host = HOST[(c.commitmentHosting || 'azure').toLowerCase()];
      if (!feat) throw new PricingError(`commitmentFeature must be one of: ${Object.keys(COMMIT).join(', ')}.`);
      if (!host) throw new PricingError(`commitmentHosting must be one of: ${Object.keys(HOST).join(', ')}.`);
      const size = n(c.commitmentPages);
      if (!size) throw new PricingError('A commitment plan needs commitmentPages (pages a month to commit to).');
      const disc = host === 'Disconnected';
      const pool = disc ? await rows(`serviceName eq 'Foundry Tools' and productName eq 'Azure Document Intelligence - Disconnected' and ${regionFilter(ctx)} and priceType eq 'Consumption'`, ctx) : rs;
      const base = `Commitment Tier ${feat[0]} ${host} ${size / 1000}K`;
      const unit = pool.filter(r => r.meterName === `${base} Unit`), over = disc ? [] : rs.filter(r => r.meterName === `${base} CT Overage Transactions`);
      if (!unit.length || (!disc && !over.length)) {
        const avail = kSizes(pool.filter(r => r.meterName.startsWith(`Commitment Tier ${feat[0]} ${host} `) && r.meterName.endsWith(' Unit')).map(r => r.meterName));
        throw new PricingError(`No ${feat[2]} commitment tier of ${fmtN(size)} pages (${host}) in ${ctx.region}. Available sizes (pages a month): ${avail || 'none'}.`);
      }
      const used = qty[feat[1]];
      const overPages = Math.max(0, used - size);
      if (disc) {
        if (overPages) throw new PricingError(`A disconnected-container plan has no overage rate and covers ${fmtN(size)} pages a month (${fmtN(size * 12)} a year); ${fmtN(used)} pages a month needs a larger size.`);
        lines.push(meterLine(G, S, `Document Intelligence ${feat[2]} disconnected-container commitment, ${fmtN(size)} pages/month, yearly price spread over 12 months`, single(unit, 'disconnected commitment tier'), 1 / 12, ctx, { unit: 'tier / month' }));
        notes.push('Disconnected-container plans are bought for a year; the listed price is the yearly price, shown here divided by 12 as a monthly figure. There is no overage meter, so usage above the committed volume is not priced.');
      } else lines.push(meterLine(G, S, `Document Intelligence ${feat[2]} commitment tier, ${fmtN(size)} pages/month (${host === 'Azure' ? 'run in Azure' : host === 'Disconnected' ? 'disconnected container' : 'connected container'})`, single(unit, 'commitment tier'), 1, ctx, { unit: 'tier / month' }));
      if (overPages) lines.push(meterLine(G, S, `Overage beyond the commitment: ${fmtN(used)} pages used - ${fmtN(size)} committed = ${fmtN(overPages)} pages`, single(over, 'commitment overage'), overPages, ctx, { unit: 'pages' }));
      if (!disc) notes.push(`The commitment tier is a fixed monthly charge for ${fmtN(size)} pages whether or not they are used; pages beyond it bill at the overage rate (Microsoft: "If you use the resource above the quota provided, you're charged for the additional usage as per the overage amount mentioned in the commitment tier."). Commitment tier pricing cannot be used with a Foundry Tools or Microsoft Foundry multi-service resource, and the first month after purchase is pro-rated.`);
      if (disc) notes.push('Commitment tier pricing cannot be used with a Foundry Tools or Microsoft Foundry multi-service resource.');
      committed = feat[1];
      facts.commitmentPages = size; facts.commitmentFeature = (c.commitmentFeature || 'read').toLowerCase(); facts.commitmentUsedPages = used;
    }

    for (const [k, [std, bat, what]] of Object.entries(FEATURES)) {
      if (!qty[k] || k === committed) continue;
      let name = batch ? bat : std;
      if (!name) throw new PricingError(`${what} is not available through the batch API.`);
      let m = rs.filter(r => r.meterName === name);
      if (!m.length && batch && k === 'prebuiltPages') { name = 'S0 Batch Layout Pages'; m = rs.filter(r => r.meterName === name); }
      if (!m.length) throw new PricingError(`${what}${batch ? ' (batch)' : ''} is not priced in ${ctx.region}.`);
      const mr = single(m, what);
      lines.push(meterLine(G, S, `Document Intelligence ${batch ? 'batch ' : ''}${what}, ${fmtN(qty[k])} pages/month${mr.length > 1 ? ' (graduated)' : ''}`, mr, qty[k], ctx, { unit: 'pages' }));
    }
    if (train) notes.push('Training hours are billed hours only: Microsoft says custom neural model training is free for the first 10 hours only, so enter the hours beyond those 10 (15 hours in total = 5 billed).');
    if (train) lines.push(meterLine(G, S, `Custom model training, ${fmtN(train)} billed training hours (beyond the free first 10)`, single(rs.filter(r => r.meterName === 'S0 Training'), 'training'), train, ctx, { unit: 'hours' }));
    // A commitment tier is worth raising when the pay-as-you-go cost of a feature already reaches a tier's monthly price.
    if (plan === 'payg') {
      for (const [key, [pre, field]] of Object.entries(COMMIT)) {
        const used = qty[field];
        if (!used) continue;
        const std = rs.filter(r => r.meterName === FEATURES[field][0]);
        if (!std.length) continue;
        const payg = meterCost(std, used).cost;
        const cheaper = rs.filter(r => r.meterName.startsWith('Commitment Tier ' + pre + ' Azure ') && r.meterName.endsWith(' Unit') && r.retailPrice > 0).filter(u => {
          const size = Number(u.meterName.match(/(\d+)K Unit$/)[1]) * 1000;
          const ov = rs.find(r => r.meterName === u.meterName.replace(/ Unit$/, ' CT Overage Transactions'));
          return ov && u.retailPrice + Math.max(0, used - size) / 1000 * ov.retailPrice < payg;
        });
        if (cheaper.length) { facts.commitmentWorthChecking = true; facts.commitmentFeatureHint = key; break; }
      }
    }
    notes.push('Document Intelligence bills per page analysed, priced per 1,000 pages.');
    if (qty.readPages) notes.push('Read pages: the first 1,000,000 pages a month are billed at the higher band, pages beyond that at the lower band.');
    return { lines, notes, facts };
  }
};
