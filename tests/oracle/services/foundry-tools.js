'use strict';

const { query, dedupe, unitSize, round2 } = require('../api');
const calc = require('../calculator');

const SLUG = 'cognitive-services';
const HOURS_PER_MONTH = 730;
const THOUSAND = 1000;
const MILLION = 1000000;

function totalOf(lines) {
  return round2(lines.reduce((s, l) => s + l.monthlyList, 0));
}

function line(desc, monthlyList, extra = {}) {
  return { desc, monthlyList: round2(monthlyList), ...extra };
}

async function calculatorOffer(offer, region) {
  const p = await calc.offerPrice(SLUG, offer, region);
  return p.value;
}

function tierWalk(table, units) {
  let previous = 0;
  let cost = 0;
  const bands = [];
  for (const band of table.prices) {
    const limit = band.limit;
    const billed = Math.max(0, Math.min(units, limit) - previous);
    if (billed > 0) {
      const unitPrice = band.price.value;
      const bandCost = billed * unitPrice;
      cost += bandCost;
      bands.push({ fromUnits: previous, toUnits: limit === Number.MAX_VALUE ? null : limit, units: billed, unitPrice, cost: round2(bandCost) });
    }
    previous = limit;
    if (units <= limit) break;
  }
  return { cost, bands };
}

async function calculatorGraduated(offer, region, quantity, unitSize = THOUSAND) {
  const data = await calc.product(SLUG);
  const calcRegion = calc.calcRegion(data, region);
  const table = data.graduatedOffers[offer] && data.graduatedOffers[offer][calcRegion];
  if (!table) throw new Error(`calculator has no ${offer} graduated prices for ${calcRegion}`);
  return tierWalk(table, quantity / unitSize);
}

function commitmentIncluded(size) {
  const s = String(size || '').toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
  if (!m) throw new Error(`unsupported commitment size ${size}`);
  const n = Number(m[1]);
  const suffix = m[2] || '';
  if (suffix === 'b') return n * 1000000000;
  if (suffix === 'm') return n * MILLION;
  if (suffix === 'k') return n * THOUSAND;
  return n;
}

function commitmentSlugSize(size) {
  const s = String(size || '').toLowerCase().replace(/\s+/g, '');
  return s.replace(/\.0+/, '');
}

async function commitment({ region, prefix, size, quantity, overageUnit = THOUSAND, includedUnit = 1 }) {
  const slugSize = commitmentSlugSize(size);
  const included = commitmentIncluded(size) * includedUnit;
  const baseSuffix = prefix.includes('speech-services-') ? '-hours-perunitpermonth' : '-perunit';
  const baseOffer = `${prefix}-${slugSize}${baseSuffix}`;
  const overageSuffix = prefix.includes('speech-services-') ? '-hours-perhouroverage' : '-perthousandoveragetransactions';
  const overageOffer = `${prefix}-${slugSize}${overageSuffix}`;
  const base = await calculatorOffer(baseOffer, region);
  const overagePrice = await calculatorOffer(overageOffer, region);
  const overage = Math.max(0, quantity - included);
  const lines = [line(`${baseOffer}: committed tier base`, base, { sourceOffer: baseOffer })];
  if (overage) lines.push(line(`${overageOffer}: ${overage} overage / ${overageUnit} * ${overagePrice}`, (overage / overageUnit) * overagePrice, { sourceOffer: overageOffer }));
  return { monthlyList: totalOf(lines), lines };
}

async function singleOfferUsage({ region, offer, quantity, divisor = 1, hours }) {
  const price = await calculatorOffer(offer, region);
  const usage = hours == null ? quantity / divisor : quantity * hours / divisor;
  const desc = hours == null ? `${offer}: ${quantity} / ${divisor} * ${price}` : `${offer}: ${quantity} * ${hours} hours / ${divisor} * ${price}`;
  const lines = [line(desc, usage * price, { sourceOffer: offer })];
  return { monthlyList: totalOf(lines), lines };
}

async function annualMonthly({ region, offer }) {
  const annual = await singleOfferUsage({ region, offer, quantity: 1 });
  const lines = annual.lines.map(l => ({ ...l, desc: `${l.desc} annual / 12`, monthlyList: round2(l.monthlyList / 12) }));
  return { monthlyList: totalOf(lines), lines };
}

async function commitmentExact({ region, baseOffer, overageOffer, included, quantity, overageUnit }) {
  const base = await calculatorOffer(baseOffer, region);
  const overagePrice = await calculatorOffer(overageOffer, region);
  const overage = Math.max(0, quantity - included);
  const lines = [line(`${baseOffer}: committed tier base`, base, { sourceOffer: baseOffer })];
  if (overage) lines.push(line(`${overageOffer}: ${overage} overage / ${overageUnit} * ${overagePrice}`, (overage / overageUnit) * overagePrice, { sourceOffer: overageOffer }));
  return { monthlyList: totalOf(lines), lines };
}

async function tokenOffer({ region, offer, quantity }) {
  const price = await calculatorOffer(offer, region);
  const tokens = quantity * MILLION;
  const lines = [line(`${offer}: ${quantity}M tokens / 1K * ${price}`, (tokens / THOUSAND) * price, { sourceOffer: offer })];
  return { monthlyList: totalOf(lines), lines };
}

async function languageStandard(region, quantity) {
  const g = await calculatorGraduated('language-service-standard', region, quantity, THOUSAND);
  const lines = [line(`language-service-standard: ${quantity} text records / 1K through graduated bands`, g.cost, { sourceOffer: 'language-service-standard', bands: g.bands })];
  return { monthlyList: totalOf(lines), lines };
}

async function healthText(region, quantity) {
  const g = await calculatorGraduated('language-service-health', region, quantity, THOUSAND);
  const lines = [line(`language-service-health: ${quantity} text records / 1K through graduated bands`, g.cost, { sourceOffer: 'language-service-health', bands: g.bands })];
  return { monthlyList: totalOf(lines), lines };
}

async function questionAnswering(region, quantity) {
  const g = await calculatorGraduated('language-service-question-answering', region, quantity, THOUSAND);
  const lines = [line(`language-service-question-answering: ${quantity} transactions / 1K through graduated bands`, g.cost, { sourceOffer: 'language-service-question-answering', bands: g.bands })];
  return { monthlyList: totalOf(lines), lines };
}

async function visionStandard(region, quantity, offer = 'computer-vision-s1') {
  const g = await calculatorGraduated(offer, region, quantity, THOUSAND);
  const lines = [line(`${offer}: ${quantity} transactions / 1K through graduated bands`, g.cost, { sourceOffer: offer, bands: g.bands })];
  return { monthlyList: totalOf(lines), lines };
}

async function faceStandard(region, quantity) {
  const g = await calculatorGraduated('face-api-standard', region, quantity, THOUSAND);
  const lines = [line(`face-api-standard: ${quantity} transactions / 1K through graduated bands`, g.cost, { sourceOffer: 'face-api-standard', bands: g.bands })];
  return { monthlyList: totalOf(lines), lines };
}

async function immersive(region, quantity, education = false) {
  const offer = education ? 'immersive-reader-education' : 'immersive-reader-standard';
  const g = await calculatorGraduated(offer, region, quantity, MILLION);
  const lines = [line(`${offer}: ${quantity} characters / 1M through graduated bands`, g.cost, { sourceOffer: offer, bands: g.bands })];
  return { monthlyList: totalOf(lines), lines };
}

async function retailTranslatorEur({ region, quantity, currency }) {
  const rows = dedupe(await query(`serviceName eq 'Foundry Tools' and armRegionName eq '${region}' and productName eq 'Translator Text' and skuName eq 'S1'`, currency));
  const hits = rows.filter(r => r.meterName === 'S1 Characters' && r.unitOfMeasure === '1M' && r.type === 'Consumption');
  if (hits.length !== 1) throw new Error(`expected one EUR Translator S1 Characters row, found ${hits.length}`);
  const meter = hits[0];
  const lines = [line(`EUR Retail API Translator S1 Characters: ${quantity} / ${meter.unitOfMeasure} * ${meter.retailPrice}`, (quantity / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId })];
  return { monthlyList: totalOf(lines), lines };
}

async function retailVisionMeter({ region, quantity, skuName, meterName }) {
  const rows = dedupe(await query(`serviceName eq 'Foundry Tools' and armRegionName eq '${region}' and productName eq 'Azure Vision'`, 'USD'));
  const hits = rows.filter(r => r.skuName === skuName && r.meterName === meterName && r.type === 'Consumption');
  if (hits.length !== 1) throw new Error(`expected one Azure Vision Retail API row for ${skuName}/${meterName}, found ${hits.length}`);
  const meter = hits[0];
  const lines = [line(`Retail API ${meterName}: ${quantity} / ${meter.unitOfMeasure} * ${meter.retailPrice}`, (quantity / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId })];
  return { monthlyList: totalOf(lines), lines };
}

module.exports = {
  type: 'foundry-tools',
  source: 'both',
  cases: [
    {
      name: 'language text analysis first payg band', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'text-analysis', quantity: 499000 },
      // Calculator graduated offer language-service-standard is per 1K text records; this stays inside the first 500-unit band.
      expected: async () => languageStandard('eastus2', 499000),
    },
    {
      name: 'language text analysis crosses second payg band', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'text-analysis', quantity: 600000 },
      // Calculator language-service-standard charges first 500 1K-record units at band 1, then the rest at band 2.
      expected: async () => languageStandard('eastus2', 600000),
    },
    {
      name: 'language text analysis crosses third payg band', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'text-analysis', quantity: 3000000 },
      // Calculator language-service-standard charges 500 + 2,000 + remaining 1K-record units through graduated bands.
      expected: async () => languageStandard('eastus2', 3000000),
    },
    {
      name: 'language text analysis crosses fourth payg band', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'text-analysis', quantity: 12000000 },
      // Calculator language-service-standard final band applies after 10,000 1K-record units.
      expected: async () => languageStandard('eastus2', 12000000),
    },
    {
      name: 'language health text free grant only', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'health-text-analysis', quantity: 5000 },
      // Calculator language-service-health first 5 1K-record units are free.
      expected: async () => healthText('eastus2', 5000),
    },
    {
      name: 'language health text above free grant', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'health-text-analysis', quantity: 7000 },
      // Calculator language-service-health charges only 1K-record units above the 5K free grant.
      expected: async () => healthText('eastus2', 7000),
    },
    {
      name: 'language question answering graduated', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'question-answering', quantity: 3000000 },
      // Calculator language-service-question-answering is graduated per 1K transactions with a second band after 2.5M transactions.
      expected: async () => questionAnswering('eastus2', 3000000),
    },
    {
      name: 'language connected commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'text-analysis', quantity: 1200000, plan: 'commitment-connected-container', commitmentSize: '1m' },
      // Calculator connected container 1M commitment has a fixed monthly unit plus per-1K overage records above 1M.
      expected: async () => commitment({ region: 'eastus2', prefix: 'language-service-connectedcontainer', size: '1m', quantity: 1200000 }),
    },
    {
      name: 'language disconnected annual 3m tier', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'text-analysis', quantity: 2500000, plan: 'commitment-disconnected-container', commitmentSize: '3m' },
      // Calculator language-service-disconnectedcontainer-3m is the annual disconnected-container tier price exposed by the calculator.
      expected: async () => {
        const annual = await singleOfferUsage({ region: 'eastus2', offer: 'language-service-disconnectedcontainer-3m', quantity: 1 });
        const lines = annual.lines.map(l => ({ ...l, desc: l.desc + ' annual / 12', monthlyList: round2(l.monthlyList / 12) }));
        return { monthlyList: totalOf(lines), lines };
      },
    },
    {
      name: 'speech to text standard payg hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text', quantity: 125 },
      // Calculator speech-services-speech-to-text-standard is per audio hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-speech-to-text-standard', quantity: 125 }),
    },
    {
      name: 'speech batch transcription payg hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text-batch', quantity: 250 },
      // Calculator speech-services-speech-to-text-batch is per audio hour for batch transcription.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-speech-to-text-batch', quantity: 250 }),
    },
    {
      name: 'speech neural text to speech characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'text-to-speech-neural', quantity: 2500000 },
      // Calculator speech-services-neural-text-to-speech-standard is per 1M characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-neural-text-to-speech-standard', quantity: 2500000, divisor: MILLION }),
    },
    {
      name: 'speech azure commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text', quantity: 2500, plan: 'commitment', commitmentSize: '2K' },
      // Calculator Azure Speech standard 2,000-hour commitment is fixed monthly plus per-hour overage above 2,000 hours.
      expected: async () => commitment({ region: 'eastus2', prefix: 'speech-services-azure-commitment-speech-to-text-standard', size: '2000', quantity: 2500, overageUnit: 1 }),
    },
    {
      name: 'speech disconnected annual 10000 hour tier', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text', quantity: 8000, plan: 'commitment-disconnected-container', commitmentSize: '10K' },
      // Calculator speech-services-azure-disconnected-speech-to-text-standard-10000-hours is annual, so monthly list is one twelfth.
      expected: async () => {
        const annual = await singleOfferUsage({ region: 'eastus2', offer: 'speech-services-azure-disconnected-speech-to-text-standard-10000-hours', quantity: 1 });
        const lines = annual.lines.map(l => ({ ...l, desc: l.desc + ' annual / 12', monthlyList: round2(l.monthlyList / 12) }));
        return { monthlyList: totalOf(lines), lines };
      },
    },
    {
      name: 'speech fast transcription disconnected annual 50000 hour tier', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text-fast', quantity: 50000, plan: 'commitment-disconnected-container', commitmentSize: '50K' },
      // Calculator speech-services-azure-disconnected-speech-to-text-fast-transcription-50000-hours is annual, so monthly list is one twelfth.
      expected: async () => annualMonthly({ region: 'eastus2', offer: 'speech-services-azure-disconnected-speech-to-text-fast-transcription-50000-hours' }),
    },
    {
      name: 'translator text translation payg characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'text-translation', quantity: 1500000 },
      // Calculator translator-text-api-s1 is per 1M translated characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'translator-text-api-s1', quantity: 1500000, divisor: MILLION }),
    },
    {
      name: 'translator document translation payg characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'document-translation', quantity: 2000000 },
      // Calculator translator-text-api-s1-document-standard-translation is per 1M document-translation characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'translator-text-api-s1-document-standard-translation', quantity: 2000000, divisor: MILLION }),
    },
    {
      name: 'translator volume plan s2 with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'volume-plan', quantity: 300000000, volumePlan: 's2' },
      // Calculator Translator S2 volume plan has a fixed per-month unit plus per-1M characters over the 250M included volume.
      expected: async () => {
        const base = await calculatorOffer('translator-text-api-s2-permonth', 'eastus2');
        const overage = await calculatorOffer('translator-text-api-s2-permillion', 'eastus2');
        const over = 50000000;
        const lines = [
          line('translator-text-api-s2-permonth: fixed monthly unit', base, { sourceOffer: 'translator-text-api-s2-permonth' }),
          line(`translator-text-api-s2-permillion: ${over} overage / 1M * ${overage}`, (over / MILLION) * overage, { sourceOffer: 'translator-text-api-s2-permillion' }),
        ];
        return { monthlyList: totalOf(lines), lines };
      },
    },
    {
      name: 'translator disconnected annual 4000m tier', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'text-translation', quantity: 3500000000, plan: 'commitment-disconnected-container', commitmentSize: '4000m' },
      // Calculator translator-text-api-disconnected-4000M is the annual disconnected-container tier price.
      expected: async () => {
        const annual = await singleOfferUsage({ region: 'eastus2', offer: 'translator-text-api-disconnected-4000M', quantity: 1 });
        const lines = annual.lines.map(l => ({ ...l, desc: l.desc + ' annual / 12', monthlyList: round2(l.monthlyList / 12) }));
        return { monthlyList: totalOf(lines), lines };
      },
    },
    {
      name: 'vision image analysis basic graduated', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'image-analysis-basic', quantity: 12000000 },
      // Calculator computer-vision-s1 is per 1K image-analysis transactions and graduates after 1M and 10M transactions.
      expected: async () => visionStandard('eastus2', 12000000),
    },
    {
      name: 'vision custom classification training hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'custom-classification-training', quantity: 12 },
      // Calculator computer-vision-custom-image-classification-training is per training hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'computer-vision-custom-image-classification-training', quantity: 12 }),
    },
    {
      name: 'vision west europe image analysis read', region: 'westeurope', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'image-analysis-read', quantity: 2500000 },
      // Calculator computer-vision-s1 is also used for read/OCR transactions; West Europe verifies non-US calculator region mapping.
      expected: async () => visionStandard('westeurope', 2500000, 'computer-vision-s3'),
    },
    {
      name: 'face standard transactions graduated', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'face', feature: 'face-transactions', quantity: 6000000 },
      // Calculator face-api-standard is per 1K transactions with lower bands after 1M and 5M transactions.
      expected: async () => faceStandard('eastus2', 6000000),
    },
    {
      name: 'face liveness with verification', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'face', feature: 'face-liveness-verification', quantity: 2000 },
      // Calculator face-api-face-liveliness-verification is per 1K liveness transactions with verification.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'face-api-face-liveliness-verification', quantity: 2000, divisor: THOUSAND }),
    },
    {
      name: 'content safety text moderation standard', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-text', quantity: 200000 },
      // Calculator content-safety-standard-perthousandtextrecords is per 1K text records.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'content-safety-standard-perthousandtextrecords', quantity: 200000, divisor: THOUSAND }),
    },
    {
      name: 'content safety image free tier', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-images', quantity: 3000, plan: 'free' },
      // Calculator content-safety-free-perthousandimages is the free image-moderation meter; price is zero per 1K images.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'content-safety-free-perthousandimages', quantity: 3000, divisor: THOUSAND }),
    },
    {
      name: 'custom vision predictions and uploads', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'custom-vision', feature: 'custom-vision-predictions', quantity: 50000 },
      // Calculator custom-vision-service-standard is per 1K prediction/upload transactions.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'custom-vision-service-standard', quantity: 50000, divisor: THOUSAND }),
    },
    {
      name: 'custom vision training hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'custom-vision', feature: 'custom-vision-training', quantity: 6 },
      // Calculator custom-vision-service-training is per training hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'custom-vision-service-training', quantity: 6 }),
    },
    {
      name: 'immersive reader standard over free grant', region: 'westeurope', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'immersive-reader', feature: 'immersive-reader', quantity: 5000000 },
      // Calculator immersive-reader-standard is graduated per 1M characters; first 3 units are free, then standard price applies.
      expected: async () => immersive('westeurope', 5000000, false),
    },
    {
      name: 'immersive reader education tier', region: 'westeurope', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'immersive-reader', feature: 'immersive-reader-education', quantity: 5000000 },
      // Calculator immersive-reader-education uses the same 3M free grant and then the lower education per-1M price.
      expected: async () => immersive('westeurope', 5000000, true),
    },
    {
      name: 'language azure commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'text-analysis', quantity: 1500000, plan: 'commitment', commitmentSize: '1M' },
      // Calculator language-service-azurestandard 1M tier has a fixed monthly unit plus per-1K overage records above 1M.
      expected: async () => commitment({ region: 'eastus2', prefix: 'language-service-azurestandard', size: '1m', quantity: 1500000 }),
    },
    {
      name: 'language summarization azure commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'summarization', quantity: 3500000, plan: 'commitment', commitmentSize: '3M' },
      // Calculator language-service-summarization-azurestandard 3M tier has 3M included text records and per-1K overage.
      expected: async () => commitment({ region: 'eastus2', prefix: 'language-service-summarization-azurestandard', size: '3m', quantity: 3500000 }),
    },
    {
      name: 'language conversation understanding payg', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'conversation-understanding', quantity: 800000 },
      // Calculator language-service-conversational-language-understanding is per 1K prediction transactions.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'language-service-conversational-language-understanding', quantity: 800000, divisor: THOUSAND }),
    },
    {
      name: 'language conversation training hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'conversation-understanding-training', quantity: 12 },
      // Calculator language-service-advanced-training is per training hour for advanced Language custom models.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'language-service-advanced-training', quantity: 12 }),
    },
    {
      name: 'language custom text prediction', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'custom-text', quantity: 100000 },
      // Calculator language-service-custom-text-classification is per 1K custom text prediction transactions.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'language-service-custom-text-classification', quantity: 100000, divisor: THOUSAND }),
    },
    {
      name: 'language custom text training', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'custom-text-training', quantity: 10 },
      // Calculator language-service-custom-named-entity-recognition-training is per custom text training hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'language-service-custom-named-entity-recognition-training', quantity: 10 }),
    },
    {
      name: 'language custom text hosting endpoint units', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'custom-text-hosting', quantity: 2 },
      // Calculator language-service-custom-named-entity-recognition-endpoint is per hosted endpoint unit.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'language-service-custom-named-entity-recognition-endpoint', quantity: 2 }),
    },
    {
      name: 'language legacy s1 volume plan with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'legacy-volume-plan', quantity: 120000, volumePlan: 's1' },
      // Calculator legacy Language S1 uses the fixed plan charge plus per-1K overage records above the included 100K.
      expected: async () => {
        const base = await calculatorOffer('language-service-s1-permonth', 'eastus2');
        const overage = await calculatorOffer('language-service-s1-perthousandapitransactions', 'eastus2');
        const lines = [
          line('language-service-s1-permonth: fixed monthly plan', base, { sourceOffer: 'language-service-s1-permonth' }),
          line(`language-service-s1-perthousandapitransactions: 20000 overage / 1K * ${overage}`, (20000 / THOUSAND) * overage, { sourceOffer: 'language-service-s1-perthousandapitransactions' }),
        ];
        return { monthlyList: totalOf(lines), lines };
      },
    },
    {
      name: 'language document pii redaction', region: 'australiaeast', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'language', feature: 'document-pii-redaction', quantity: 250000 },
      // Calculator language-service-document-pii-redaction is per 1K document PII redaction text records; Australia East is the calculator-priced region.
      expected: async () => singleOfferUsage({ region: 'australiaeast', offer: 'language-service-document-pii-redaction', quantity: 250000, divisor: THOUSAND }),
    },
    {
      name: 'speech fast transcription hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text-fast', quantity: 80 },
      // Calculator speech-services-speech-to-text-fast is per audio hour for fast transcription.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-speech-to-text-fast', quantity: 80 }),
    },
    {
      name: 'speech mai transcribe hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'mai-transcribe', quantity: 90 },
      // Calculator speech-services-mai-transcribe-2-speech-to-text is per audio hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-mai-transcribe-2-speech-to-text', quantity: 90 }),
    },
    {
      name: 'speech enhanced addon hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text-enhanced', quantity: 200 },
      // Calculator speech-services-enhanced-add-on-standard is per audio hour of enhanced speech add-ons.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-enhanced-add-on-standard', quantity: 200 }),
    },
    {
      name: 'speech custom speech realtime hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-speech-to-text', quantity: 75 },
      // Calculator speech-services-custom-speech-to-text-standard is per audio hour for custom real-time speech to text.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-speech-to-text-standard', quantity: 75 }),
    },
    {
      name: 'speech custom speech batch hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-speech-to-text-batch', quantity: 75 },
      // Calculator speech-services-custom-speech-to-text-batch is per audio hour for custom batch transcription.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-speech-to-text-batch', quantity: 75 }),
    },
    {
      name: 'speech custom speech training hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-speech-training', quantity: 8 },
      // Calculator speech-services-custom-speech-training is per training hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-speech-training', quantity: 8 }),
    },
    {
      name: 'speech custom speech hosting part month', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-speech-hosting', quantity: 3, hours: 100 },
      // Calculator speech-services-custom-speech-model-hosting-standard is hourly; multiply endpoints by deployed hours.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-speech-model-hosting-standard', quantity: 3, hours: 100 }),
    },
    {
      name: 'speech connected commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'speech-to-text', quantity: 11000, plan: 'commitment-connected-container', commitmentSize: '10K' },
      // Calculator connected-container Speech standard 10K-hour commitment is fixed monthly plus per-hour overage above 10K hours.
      expected: async () => commitment({ region: 'eastus2', prefix: 'speech-services-connected-container-commitment-speech-to-text-standard', size: '10000', quantity: 11000, overageUnit: 1 }),
    },
    {
      name: 'speech text to speech standard characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'text-to-speech', quantity: 2000000 },
      // Calculator speech-services-text-to-speech-standard is per 1M characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-standard', quantity: 2000000, divisor: MILLION }),
    },
    {
      name: 'speech neural hd characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'text-to-speech-neural-hd', quantity: 1000000 },
      // Calculator speech-services-neural-hd-text-to-speech is per 1M characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-neural-hd-text-to-speech', quantity: 1000000, divisor: MILLION }),
    },
    {
      name: 'speech long audio characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'text-to-speech-long-audio', quantity: 1000000 },
      // Calculator speech-services-neural-long-audio-characters-standard is per 1M long-audio characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-neural-long-audio-characters-standard', quantity: 1000000, divisor: MILLION }),
    },
    {
      name: 'speech custom voice characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-voice', quantity: 1500000 },
      // Calculator speech-services-custom-text-to-speech-standard is per 1M custom voice characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-text-to-speech-standard', quantity: 1500000, divisor: MILLION }),
    },
    {
      name: 'speech custom voice hosting hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-voice-hosting', quantity: 2, hours: 200 },
      // Calculator speech-services-custom-voice-font-hosting-standard is hourly; multiply deployed voices by hours.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-voice-font-hosting-standard', quantity: 2, hours: 200 }),
    },
    {
      name: 'speech custom neural voice characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-neural-voice', quantity: 1000000 },
      // Calculator speech-services-custom-neural-realtime-characters-standard is per 1M characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-neural-realtime-characters-standard', quantity: 1000000, divisor: MILLION }),
    },
    {
      name: 'speech custom neural voice hd characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-neural-voice-hd', quantity: 1000000 },
      // Calculator speech-services-custom-neural-hd-realtime-characters-standard is per 1M HD characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-neural-hd-realtime-characters-standard', quantity: 1000000, divisor: MILLION }),
    },
    {
      name: 'speech custom neural voice training hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-neural-voice-training', quantity: 4 },
      // Calculator speech-services-custom-neural-training-standard-perhour is per training hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-neural-training-standard-perhour', quantity: 4 }),
    },
    {
      name: 'speech custom neural voice hosting hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'custom-neural-voice-hosting', quantity: 1, hours: 100 },
      // Calculator speech-services-custom-neural-voice-model-hosting-standard is hourly for deployed custom neural voice models.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-custom-neural-voice-model-hosting-standard', quantity: 1, hours: 100 }),
    },
    {
      name: 'speech personal voice characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'personal-voice', quantity: 1000000 },
      // Calculator speech-services-text-to-speech-personal-voice-characters is per 1M characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-personal-voice-characters', quantity: 1000000, divisor: MILLION }),
    },
    {
      name: 'speech personal voice storage profiles', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'personal-voice-storage', quantity: 2 },
      // Calculator speech-services-text-to-speech-personal-voice-storage is per 1K stored personal voice profiles.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-personal-voice-storage', quantity: 2, divisor: THOUSAND }),
    },
    {
      name: 'voice live lite speech audio input tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-speech-audio-input', quantity: 2, voiceLiveTier: 'lite', voiceLiveVoice: 'standard' },
      // Calculator Voice Live Lite standard speech audio input is per 1K tokens; component quantity is in millions.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-lite-audio-with-azure-ai-speech-standard-input', quantity: 2 }),
    },
    {
      name: 'voice live standard speech audio output custom voice tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-speech-audio-output', quantity: 1.5, voiceLiveTier: 'standard', voiceLiveVoice: 'custom' },
      // Calculator Voice Live Standard custom speech audio output is per 1K tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-audio-azure-ai-speech-custom-output', quantity: 1.5 }),
    },
    {
      name: 'voice live standard speech audio cached tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-speech-audio-cached', quantity: 3, voiceLiveTier: 'standard', voiceLiveVoice: 'standard' },
      // Calculator Voice Live Standard speech cached input is per 1K cached tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-audio-azure-ai-speech-standard-cached-input', quantity: 3 }),
    },
    {
      name: 'voice live pro model audio input tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-audio-input', quantity: 1, voiceLiveTier: 'pro' },
      // Calculator Voice Live Pro LLM audio input is per 1K model tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-plus-llm-audio-input', quantity: 1 }),
    },
    {
      name: 'voice live pro model audio output tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-audio-output', quantity: 1, voiceLiveTier: 'pro' },
      // Calculator Voice Live Pro LLM audio output is per 1K model tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-plus-llm-audio-output', quantity: 1 }),
    },
    {
      name: 'voice live pro model audio cached tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-audio-cached', quantity: 1, voiceLiveTier: 'pro' },
      // Calculator Voice Live Pro LLM cached audio input is per 1K cached tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-plus-llm-audio-input-cached', quantity: 1 }),
    },
    {
      name: 'voice live pro model text input tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-text-input', quantity: 1, voiceLiveTier: 'pro' },
      // Calculator Voice Live Pro LLM text input is per 1K model tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-plus-llm-text-input', quantity: 1 }),
    },
    {
      name: 'voice live pro model text output tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-text-output', quantity: 1, voiceLiveTier: 'pro' },
      // Calculator Voice Live Pro LLM text output is per 1K model tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-plus-llm-text-output', quantity: 1 }),
    },
    {
      name: 'voice live pro realtime 2 text output tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-text-output-realtime-2', quantity: 1, voiceLiveTier: 'pro' },
      // Calculator Voice Live Pro realtime-2 text output uses the separate output2 meter per 1K model tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-plus-llm-text-output2', quantity: 1 }),
    },
    {
      name: 'voice live pro model text cached tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-text-cached', quantity: 1, voiceLiveTier: 'pro' },
      // Calculator Voice Live Pro LLM cached text input is per 1K cached tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-plus-llm-text-cached', quantity: 1 }),
    },
    {
      name: 'voice live pro model image input tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-model-image-input', quantity: 1, voiceLiveTier: 'pro' },
      // Calculator Voice Live Pro LLM image input is per 1K image tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-api-plus-llm-image-input', quantity: 1 }),
    },
    {
      name: 'voice live byo speech audio input tokens', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'voice-live-speech-audio-input', quantity: 1, voiceLiveTier: 'byo', voiceLiveVoice: 'standard' },
      // Calculator Voice Live BYO standard speech audio input is per 1K tokens.
      expected: async () => tokenOffer({ region: 'eastus2', offer: 'speech-services-voice-live-byo-audio-azure-ai-speech-standard-input', quantity: 1 }),
    },
    {
      name: 'avatar standard realtime minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-standard-realtime', quantity: 30 },
      // Calculator speech-services-text-to-speech-avatar-synthesis-interactive-standard is per real-time avatar minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-avatar-synthesis-interactive-standard', quantity: 30 }),
    },
    {
      name: 'avatar standard batch minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-standard-batch', quantity: 30 },
      // Calculator speech-services-text-to-speech-avatar-synthesis-standard is per batch avatar minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-avatar-synthesis-standard', quantity: 30 }),
    },
    {
      name: 'avatar hd standard realtime minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-hd-standard-realtime', quantity: 30 },
      // Calculator speech-services-text-to-speech-hd-standard-avatar-realtime-standard is per HD standard real-time avatar minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-hd-standard-avatar-realtime-standard', quantity: 30 }),
    },
    {
      name: 'avatar hd standard batch minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-hd-standard-batch', quantity: 30 },
      // Calculator speech-services-text-to-speech-hd-avatar-batch-standard is per HD standard batch avatar minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-hd-avatar-batch-standard', quantity: 30 }),
    },
    {
      name: 'avatar custom realtime minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-custom-realtime', quantity: 20 },
      // Calculator speech-services-text-to-speech-avatar-streaming-custom is per custom real-time avatar minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-avatar-streaming-custom', quantity: 20 }),
    },
    {
      name: 'avatar custom batch minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-custom-batch', quantity: 20 },
      // Calculator speech-services-text-to-speech-avatar-content-custom is per custom batch avatar minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-avatar-content-custom', quantity: 20 }),
    },
    {
      name: 'avatar custom hosting hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-custom-hosting', quantity: 2, hours: 100 },
      // Calculator speech-services-text-to-speech-avatar-hosting-custom is hourly; multiply hosted avatars by hours.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-avatar-hosting-custom', quantity: 2, hours: 100 }),
    },
    {
      name: 'avatar photo creation', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'photo-avatar-creation', quantity: 1 },
      // Calculator speech-services-text-to-speech-avatar-photo-creation is per 1K photo avatar creation images.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-text-to-speech-avatar-photo-creation', quantity: 1, divisor: THOUSAND }),
    },
    {
      name: 'video translation input minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'video-translation-input', quantity: 60 },
      // Calculator speech-services-video-translation-input-audio is per input video minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-video-translation-input-audio', quantity: 60 }),
    },
    {
      name: 'video translation standard voice output minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'video-translation-output-standard-voice', quantity: 60 },
      // Calculator speech-services-video-translation-std-audio-output is per output video minute with a standard voice.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-video-translation-std-audio-output', quantity: 60 }),
    },
    {
      name: 'video translation custom voice output minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'video-translation-output-custom-voice', quantity: 60 },
      // Calculator speech-services-video-translation-cstm-audio-output is per output video minute with a custom voice.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-video-translation-cstm-audio-output', quantity: 60 }),
    },
    {
      name: 'video translation automated batch minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'video-translation-automated', quantity: 60 },
      // Calculator speech-services-video-translation-batch is per automated batch video translation minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-video-translation-batch', quantity: 60 }),
    },
    {
      name: 'video translation personal voice add-on minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'video-translation-personal-voice', quantity: 60 },
      // Calculator speech-services-video-translation-personal-voice is per minute for the personal voice add-on.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-video-translation-personal-voice', quantity: 60 }),
    },
    {
      name: 'video translation editing minutes', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'video-translation-editing', quantity: 60 },
      // Calculator speech-services-video-translation-content-editing is per edited video minute.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'speech-services-video-translation-content-editing', quantity: 60 }),
    },
    {
      name: 'avatar custom training not offered in east us 2', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-custom-training', quantity: 10 },
      // Calculator custom avatar training is offered in West Europe, West US 2 and Southeast Asia, not East US 2 or arbitrary fallback regions.
      expectEngineError: /not available|no price|No meter|not offered|No.*price/i,
    },
    {
      name: 'avatar custom training west europe', region: 'westeurope', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'speech', feature: 'avatar-custom-training', quantity: 10 },
      // Calculator speech-services-text-to-speech-avatar-training-custom is per training hour and is offered in West Europe.
      expected: async () => singleOfferUsage({ region: 'westeurope', offer: 'speech-services-text-to-speech-avatar-training-custom', quantity: 10 }),
    },
    {
      name: 'translator custom translation characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'custom-translation', quantity: 1000000 },
      // Calculator translator-text-api-s1-custom-translation is per 1M custom translated characters.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'translator-text-api-s1-custom-translation', quantity: 1000000, divisor: MILLION }),
    },
    {
      name: 'translator custom translation training characters', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'custom-translation-training', quantity: 1000000, volumePlan: 'c2' },
      // Calculator translator-text-api-c2-custom-training is per 1M custom translation training characters when the C2 plan is selected.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'translator-text-api-c2-custom-training', quantity: 1000000, divisor: MILLION }),
    },
    {
      name: 'translator custom translation hosting', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'custom-translation-hosting', quantity: 2 },
      // Calculator translator-text-api-custom-model-hosting is per hosted custom model unit-month.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'translator-text-api-custom-model-hosting', quantity: 2 }),
    },
    {
      name: 'translator azure commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'text-translation', quantity: 300000000, plan: 'commitment', commitmentSize: '250M' },
      // Calculator Translator Azure 250M commitment has a fixed monthly unit plus per-1M character overage above 250M.
      expected: async () => commitmentExact({ region: 'eastus2', baseOffer: 'translator-text-api-azure-250M-perunit', overageOffer: 'translator-text-api-azure-250M-permillionoveragecharacters', included: 250 * MILLION, quantity: 300 * MILLION, overageUnit: MILLION }),
    },
    {
      name: 'translator connected commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'text-translation', quantity: 300000000, plan: 'commitment-connected-container', commitmentSize: '250M' },
      // Calculator Translator connected 250M commitment has a fixed monthly unit plus per-1M overage characters.
      expected: async () => commitmentExact({ region: 'eastus2', baseOffer: 'translator-text-api-connected-250M-perunit', overageOffer: 'translator-text-api-connected-250M-permillionoveragecharacters', included: 250 * MILLION, quantity: 300 * MILLION, overageUnit: MILLION }),
    },
    {
      name: 'translator document translation images', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'document-translation-images', quantity: 2000 },
      // Calculator has no commercial East US 2 document-image translation price; the module should refuse the unavailable region.
      expectEngineError: /not offered|not available|No.*price/i,
    },
    {
      name: 'vision azure commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'image-analysis-read', quantity: 600000, plan: 'commitment', commitmentSize: '500K' },
      // Calculator Computer Vision Azure 500K commitment has a fixed monthly unit plus per-1K transaction overage above 500K.
      expected: async () => commitmentExact({ region: 'eastus2', baseOffer: 'computer-vision-azure-commitment-500k-perunit', overageOffer: 'computer-vision-azure-commitment-500k-perthousandoveragetransactions', included: 500000, quantity: 600000, overageUnit: THOUSAND }),
    },
    {
      name: 'vision connected commitment with overage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'image-analysis-read', quantity: 600000, plan: 'commitment-connected-container', commitmentSize: '500K' },
      // Calculator Computer Vision connected-container 500K commitment has a fixed monthly unit plus per-1K overage transactions.
      expected: async () => commitmentExact({ region: 'eastus2', baseOffer: 'computer-vision-connected-container-commitment-500k-perunit', overageOffer: 'computer-vision-connected-container-commitment-500k-perthousandoveragetransactions', included: 500000, quantity: 600000, overageUnit: THOUSAND }),
    },
    {
      name: 'vision disconnected annual 2000k tier', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'image-analysis-read', quantity: 1500000, plan: 'commitment-disconnected-container', commitmentSize: '2000K' },
      // Calculator computer-vision--disconnected-2000k is annual, so monthly list is one twelfth.
      expected: async () => annualMonthly({ region: 'eastus2', offer: 'computer-vision--disconnected-2000k' }),
    },
    {
      name: 'vision custom classification predictions', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'custom-classification', quantity: 50000 },
      // Calculator computer-vision-custom-image-classification-transactions is per 1K custom classification predictions.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'computer-vision-custom-image-classification-transactions', quantity: 50000, divisor: THOUSAND }),
    },
    {
      name: 'vision custom detection training hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'custom-detection-training', quantity: 10 },
      // Calculator computer-vision-custom-object-detection-training is per custom object detection training hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'computer-vision-custom-object-detection-training', quantity: 10 }),
    },
    {
      name: 'vision custom detection predictions', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'custom-detection', quantity: 50000 },
      // Calculator computer-vision-custom-object-detection-transactions is per 1K custom object detection predictions.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'computer-vision-custom-object-detection-transactions', quantity: 50000, divisor: THOUSAND }),
    },
    {
      name: 'vision spatial analysis hours', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'spatial-analysis', quantity: 100 },
      // Calculator computer-vision-spatial-analysis-standard is per video stream hour.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'computer-vision-spatial-analysis-standard', quantity: 100 }),
    },
    {
      name: 'vision image vectorize transactions', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'image-vectorize', quantity: 100000 },
      // Calculator computer-vision-vectorize-image is a global per-1K image vectorization transaction price.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'computer-vision-vectorize-image', quantity: 100000, divisor: THOUSAND }),
    },
    {
      name: 'vision text vectorize transactions', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'text-vectorize', quantity: 100000 },
      // Calculator computer-vision-vectorize-text is a global per-1K text vectorization transaction price.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'computer-vision-vectorize-text', quantity: 100000, divisor: THOUSAND }),
    },
    {
      name: 'vision image retrieval ingestion', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'image-retrieval-ingestion', quantity: 10000 },
      // Retail API Azure Vision / Image Retrieval - Ingestion meter is the dedicated image retrieval ingestion meter, per 1K transactions.
      expected: async () => retailVisionMeter({ region: 'eastus2', quantity: 10000, skuName: 'Image Retrieval - Ingestion', meterName: 'Image Retrieval - Ingestion Transactions' }),
    },
    {
      name: 'vision image retrieval query', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'image-retrieval-query', quantity: 10000 },
      // Retail API Azure Vision / Image Retrieval - Query meter is the dedicated image retrieval query meter, per 1K transactions.
      expected: async () => retailVisionMeter({ region: 'eastus2', quantity: 10000, skuName: 'Image Retrieval - Query', meterName: 'Image Retrieval - Query Transactions' }),
    },
    {
      name: 'vision shelf planogram compliance east us', region: 'eastus', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'vision', feature: 'shelf-planogram-compliance', quantity: 1000 },
      // Calculator computer-vision--shelf-planogram-compliance is priced in East US per 1K shelf transactions.
      expected: async () => singleOfferUsage({ region: 'eastus', offer: 'computer-vision--shelf-planogram-compliance', quantity: 1000, divisor: THOUSAND }),
    },
    {
      name: 'face storage units', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'face', feature: 'face-storage', quantity: 10000 },
      // Calculator face-api-storage is per 1K stored faces.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'face-api-storage', quantity: 10000, divisor: THOUSAND }),
    },
    {
      name: 'face group training transactions', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'face', feature: 'face-group-training', quantity: 5000000 },
      // Retail API Azure Vision - Face / Standard Faces meter is $1 per 1M trained faces; 5M faces should cost $5.
      expected: async () => {
        const rows = dedupe(await query(`serviceName eq 'Foundry Tools' and armRegionName eq 'eastus2' and productName eq 'Azure Vision - Face' and skuName eq 'Standard'`, 'USD'));
        const hits = rows.filter(r => r.meterName === 'Standard Faces' && r.unitOfMeasure === '1M' && r.type === 'Consumption');
        if (hits.length !== 1) throw new Error(`expected one Standard Faces row, found ${hits.length}`);
        const meter = hits[0];
        const lines = [line(`Retail API Standard Faces: 5000000 / ${meter.unitOfMeasure} * ${meter.retailPrice}`, (5000000 / unitSize(meter.unitOfMeasure)) * meter.retailPrice, { meterId: meter.meterId })];
        return { monthlyList: totalOf(lines), lines };
      },
    },
    {
      name: 'face liveness checks', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'face', feature: 'face-liveness', quantity: 2000 },
      // Calculator face-api-face-liveliness is per 1K liveness transactions.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'face-api-face-liveliness', quantity: 2000, divisor: THOUSAND }),
    },
    {
      name: 'content safety image moderation standard', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-images', quantity: 200000 },
      // Calculator content-safety-standard-perthousandimages is per 1K moderated images.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'content-safety-standard-perthousandimages', quantity: 200000, divisor: THOUSAND }),
    },
    {
      name: 'content safety free text beyond allowance', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-text', quantity: 100000, plan: 'free' },
      // The module enforces the public free allowance and should refuse free text moderation usage above 5K records.
      expectEngineError: /free tier.*covers only|over.*Use plan payg/i,
    },
    {
      name: 'content safety disconnected annual text tier', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-text', quantity: 60000000, plan: 'commitment-disconnected-container', commitmentSize: '60M' },
      // Retail/API SKU name is Commitment Tier Txt DC 60M Unit; calculator content-safety--disconnected-text is annual, so monthly list is one twelfth.
      expected: async () => annualMonthly({ region: 'eastus2', offer: 'content-safety--disconnected-text' }),
    },
    {
      name: 'content safety disconnected annual image tier', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-images', quantity: 15000000, plan: 'commitment-disconnected-container', commitmentSize: '15M' },
      // Retail/API SKU name is Commitment Tier Image DC 15M Unit; calculator content-safety--disconnected-image is annual, so monthly list is one twelfth.
      expected: async () => annualMonthly({ region: 'eastus2', offer: 'content-safety--disconnected-image' }),
    },
    {
      name: 'content safety disconnected text over capacity', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'content-safety', feature: 'moderate-text', quantity: 60000001, plan: 'commitment-disconnected-container', commitmentSize: '60M' },
      // Disconnected Content Safety tiers have fixed capacity; the module should refuse usage above the selected tier instead of silently pricing it.
      expectEngineError: /over|above|capacity|exceed|No commitment tier/i,
    },
    {
      name: 'custom vision image storage', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'custom-vision', feature: 'custom-vision-storage', quantity: 10000 },
      // Calculator custom-vision-service-image-storage is per 1K stored images.
      expected: async () => singleOfferUsage({ region: 'eastus2', offer: 'custom-vision-service-image-storage', quantity: 10000, divisor: THOUSAND }),
    },
    {
      name: 'custom vision free predictions beyond allowance', region: 'eastus2', currency: 'USD',
      component: { type: 'foundry-tools', tool: 'custom-vision', feature: 'custom-vision-predictions', quantity: 100000, plan: 'free' },
      // The module enforces the Custom Vision free allowance and should refuse free prediction usage above 10K transactions.
      expectEngineError: /free tier.*covers only|over.*Use plan payg/i,
    },
    {
      name: 'translator eur text translation retail api', region: 'eastus2', currency: 'EUR',
      component: { type: 'foundry-tools', tool: 'translator', feature: 'text-translation', quantity: 1500000 },
      // Retail API EUR Foundry Tools / Translator Text / S1 Characters row is per 1M translated characters.
      expected: async () => retailTranslatorEur({ region: 'eastus2', quantity: 1500000, currency: 'EUR' }),
    },
  ],
};

