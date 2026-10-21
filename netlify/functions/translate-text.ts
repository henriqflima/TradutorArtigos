import type { Config } from '@netlify/functions';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../../src/shared';
import { readSourceMarkup } from '../../src/translation-markup';
import { HttpError, authorize, failure, headers, readBounded } from './_shared/http';
import { ProviderError, translateXmlBlocks } from './_shared/openai';

const MAX_REQUEST_BYTES = 32_000;
const MAX_TEXTS = 8;
const FIELDS = new Set(['text', 'source_lang', 'target_lang', 'context']);

export default async (req: Request) => {
  try {
    authorize(req);
    if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
      throw new HttpError(400, 'Envie os trechos em JSON.');
    }
    const bytes = await readBounded(req, MAX_REQUEST_BYTES);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new HttpError(400, 'A solicitação de tradução é inválida.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'A solicitação de tradução é inválida.');
    const data = input as Record<string, unknown>;
    if (Object.keys(data).some(key => !FIELDS.has(key))) throw new HttpError(400, 'A solicitação contém campos não permitidos.');
    const texts = data.text;
    const source = data.source_lang;
    const target = data.target_lang;
    const context = data.context;
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_TEXTS ||
        !texts.every(text => typeof text === 'string' && text.length > 0 && text.length <= 24_000)) {
      throw new HttpError(400, 'Envie até oito trechos de texto válidos por lote.');
    }
    if (typeof target !== 'string' || !TARGET_LANGUAGES.some(([code]) => code === target) ||
        (source !== undefined && (typeof source !== 'string' || !SOURCE_LANGUAGES.some(([code]) => code === source)))) {
      throw new HttpError(400, 'Selecione idiomas válidos.');
    }
    if (source && target.split('-')[0] === source) throw new HttpError(400, 'Escolha idiomas de origem e destino diferentes.');
    if (context !== undefined && (typeof context !== 'string' || context.length > 1_200)) {
      throw new HttpError(400, 'O contexto excede o limite permitido.');
    }
    const ids = new Set<string>();
    const blocks = texts.map(xml => {
      let sourceBlock: ReturnType<typeof readSourceMarkup>;
      try { sourceBlock = readSourceMarkup(xml); }
      catch { throw new HttpError(400, 'Os trechos contêm marcação ou objetos protegidos inválidos.'); }
      if (ids.has(sourceBlock.id)) throw new HttpError(400, 'Os IDs dos trechos precisam ser únicos.');
      ids.add(sourceBlock.id);
      return { ...sourceBlock, xml };
    });
    const translations = await translateXmlBlocks(blocks, {
      source: SOURCE_LANGUAGES.find(([code]) => code === source)?.[1] || 'Detect automatically from the document',
      target: TARGET_LANGUAGES.find(([code]) => code === target)![1],
      context: typeof context === 'string' ? context : '',
    }, req.signal);
    return Response.json({ translations }, { headers: headers() });
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
  path: '/api/translate-text',
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
