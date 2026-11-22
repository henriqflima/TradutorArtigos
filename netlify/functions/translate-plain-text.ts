import type { Config } from '@netlify/functions';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../../src/shared.js';
import { validatePlainText } from '../../src/plain-text.js';
import { parseTranslationMarkup } from '../../src/translation-markup.js';
import { HttpError, authorize, failure, headers, readBounded } from './_shared/http.js';
import { ProviderError, translateXmlBlocks } from './_shared/translation-service.js';

const FIELDS = new Set(['text', 'source_lang', 'target_lang']);

export default async (req: Request) => {
  try {
    authorize(req);
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(400, 'Envie somente texto em JSON. Arquivos e imagens não são aceitos.');
    }
    const bytes = await readBounded(req, 1_000_000);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new HttpError(400, 'A solicitação de tradução é inválida.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Envie somente texto e os idiomas.');
    const data = input as Record<string, unknown>;
    if (Object.keys(data).some(key => !FIELDS.has(key))) throw new HttpError(400, 'A solicitação contém campos não permitidos. Envie somente texto e os idiomas.');
    const invalid = validatePlainText(data.text);
    if (invalid) throw new HttpError(400, invalid);
    const source = data.source_lang;
    const target = data.target_lang;
    if (typeof target !== 'string' || !TARGET_LANGUAGES.some(([code]) => code === target) ||
        (source !== undefined && (typeof source !== 'string' || !SOURCE_LANGUAGES.some(([code]) => code === source)))) {
      throw new HttpError(400, 'Selecione idiomas válidos.');
    }
    if (source && target.split('-')[0] === source) throw new HttpError(400, 'Escolha idiomas de origem e destino diferentes.');
    // Reuse the existing translation service. User markup remains literal text.
    const escaped = (data.text as string).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const markers = new Map();
    const translated = await translateXmlBlocks([{ id: 'text', xml: `<p id="text">${escaped}</p>`, markers }], {
      source: SOURCE_LANGUAGES.find(([code]) => code === source)?.[1] || 'Detect automatically from the text',
      target: TARGET_LANGUAGES.find(([code]) => code === target)![1], context: '',
    }, req.signal);
    const runs = parseTranslationMarkup(translated[0], 'text', markers);
    const text = runs.map(run => run.type === 'text' ? run.text : '').join('');
    return Response.json({ translations: [text] }, { headers: headers() });
  } catch (error) {
    if (error instanceof ProviderError) {
      return Response.json({ error: error.message, retryable: error.retryable,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) },
      { status: error.status, headers: headers() });
    }
    return failure(error);
  }
};

export const config: Config = {
  path: '/api/translate-plain-text',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
