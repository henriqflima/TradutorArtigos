import { Buffer } from 'node:buffer';
import { MAX_OCR_BLOCKS, MAX_OCR_RESPONSE_BYTES, OCR_ENGINE, OCR_TIMEOUT_MS, type OcrBlock, type OcrResult } from '../../../src/ocr-contract.js';
import { HttpError, readBounded, requireProcessingService, type ProviderErrorDetails } from './http.js';

const INVALID_RESPONSE = 'O serviço retornou uma estrutura de OCR inválida. Tente novamente ou use outro PDF.';
const MAX_ERROR_BYTES = 8_192;

function limitReason(message: unknown): ProviderErrorDetails['reason'] {
  if (typeof message !== 'string') return 'unknown';
  const text = message.toLowerCase().replace(/[_-]/g, ' ');
  const restricted = /limit|quota|exceed|exhaust|reached|insufficient|too many|capacity/.test(text);
  if (/spend(?:ing)?|budget/.test(text) && restricted) return 'spending_limit';
  if (/month(?:ly)?/.test(text) && restricted) return 'monthly_quota';
  if (/\bcredits?\b/.test(text) && restricted) return 'credits';
  const rate = /rate|per\s+(?:second|minute)|too many/.test(text);
  if (/\bpages?\b/.test(text) && rate) return 'page_rate';
  if (/\btokens?\b/.test(text) && rate) return 'token_rate';
  if (/\brequests?\b/.test(text) && rate) return 'request_rate';
  if (/free\s+tier|free\s+(?:api|plan|mode)/.test(text) && restricted) return 'free_tier_capacity';
  if (/capacity/.test(text) && restricted) return 'capacity';
  return 'unknown';
}

/** Expose only HTTP status and a fixed category derived from the upstream response. */
async function providerErrorDetails(response: Response, signal: AbortSignal): Promise<ProviderErrorDetails> {
  let data: Record<string, unknown> = {};
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() || '';
  if (/^application\/(?:[\w.+-]*\+)?json$/i.test(contentType)) {
    try {
      const bytes = await readBounded(response, MAX_ERROR_BYTES, signal);
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch (error) {
      void response.body?.cancel().catch(() => {});
      if (signal.aborted) throw error;
      // Oversized, malformed or unavailable diagnostics must not turn a 429
      // into a response-parsing error or expose any part of the response body.
    }
  } else { void response.body?.cancel().catch(() => {}); }
  signal.throwIfAborted();
  const nested = data.error && typeof data.error === 'object' && !Array.isArray(data.error) ? data.error as Record<string, unknown> : {};
  return { provider: 'ocr', status: response.status, reason: limitReason(data.message ?? nested.message ?? data.detail) };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(502, INVALID_RESPONSE);
  return value as Record<string, unknown>;
}
function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new HttpError(502, INVALID_RESPONSE);
  return value;
}
function confidence(value: unknown, key: string): number | null {
  if (value === undefined || value === null) return null;
  const score = record(value)[key];
  // The upstream scores are on a 0–1 scale.
  return score === undefined || score === null ? null : finite(score, 0, 1) * 100;
}

/** Validate every region before returning content; never invent missing word geometry. */
export function parseOcrResponse(input: unknown): OcrResult {
  const data = record(input);
  if (typeof data.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,180}$/.test(data.model) ||
      !Array.isArray(data.pages) || data.pages.length !== 1) throw new HttpError(502, INVALID_RESPONSE);
  const source = record(data.pages[0]), dimensions = record(source.dimensions), usage = record(data.usage_info);
  if (source.index !== 0 || usage.pages_processed !== 1 || !Array.isArray(source.blocks) || source.blocks.length > MAX_OCR_BLOCKS) {
    throw new HttpError(502, INVALID_RESPONSE);
  }
  const width = finite(dimensions.width, 1, 100_000), height = finite(dimensions.height, 1, 100_000);
  let characters = 0;
  const blocks: OcrBlock[] = source.blocks.map(value => {
    const block = record(value);
    if (typeof block.type !== 'string' || !/^[a-z][a-z_]{0,39}$/.test(block.type) ||
        typeof block.content !== 'string' || block.content.length > 250_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(block.content)) {
      throw new HttpError(502, INVALID_RESPONSE);
    }
    characters += block.content.length;
    if (characters > 1_000_000) throw new HttpError(502, INVALID_RESPONSE);
    const x = finite(block.top_left_x, 0, width), y = finite(block.top_left_y, 0, height);
    const right = finite(block.bottom_right_x, x, width), bottom = finite(block.bottom_right_y, y, height);
    if (right <= x || bottom <= y) throw new HttpError(502, INVALID_RESPONSE);
    return { type: block.type, x, y, width: right - x, height: bottom - y, content: block.content,
      confidence: confidence(block.confidence_scores, 'average_content_confidence_score') };
  });
  // An empty block array is acceptable only for an actually empty recognition,
  // not a model that returned Markdown but omitted the requested structure.
  if (!blocks.length && (typeof source.markdown !== 'string' || source.markdown.trim())) throw new HttpError(502, INVALID_RESPONSE);
  return { model: OCR_ENGINE, page: { width, height, blocks,
    confidence: confidence(source.confidence_scores, 'average_page_confidence_score') }, usage: { pages: 1 } };
}

export async function recognizePdf(bytes: Uint8Array, signal: AbortSignal): Promise<OcrResult> {
  const { key, model, url } = requireProcessingService('ocr');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let expired = false;
  const timeout = setTimeout(() => { expired = true; controller.abort(); }, OCR_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch(url, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model, document: { type: 'document_url', document_url: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}` },
        include_blocks: true, confidence_scores_granularity: 'block', include_image_base64: false }),
    });
    if (!response.ok) {
      const details = await providerErrorDetails(response, controller.signal);
      if (response.status === 429) throw new HttpError(429, 'O serviço de OCR atingiu um limite de uso (HTTP 429). Confira os limites da conta e tente retomar o reconhecimento.', details);
      if (response.status === 401 || response.status === 403) throw new HttpError(503, 'O serviço de OCR recusou as credenciais. Confira a configuração do servidor.', details);
      if ([400, 413, 415, 422].includes(response.status)) throw new HttpError(422, 'O serviço de OCR não conseguiu processar esta página. Confira se o PDF é legível e está sem proteção.', details);
      throw new HttpError(502, 'O serviço de OCR está indisponível. Tente retomar mais tarde.', details);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      void response.body?.cancel().catch(() => {});
      throw new HttpError(502, INVALID_RESPONSE);
    }
    let data: unknown;
    try {
      const result = await readBounded(response, MAX_OCR_RESPONSE_BYTES, controller.signal);
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result));
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new HttpError(502, INVALID_RESPONSE);
    }
    controller.signal.throwIfAborted();
    return parseOcrResponse(data);
  } catch (error) {
    if (expired) throw new HttpError(504, 'O OCR excedeu o tempo de espera. A página pode ter sido processada e cobrada; tente retomar somente quando desejar reenviá-la.');
    if (signal.aborted) throw new HttpError(499, 'O reconhecimento foi interrompido. Uma página já recebida pelo serviço de OCR ainda pode ter custo.');
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'A conexão com o serviço de OCR foi interrompida. A página pode ter sido processada e cobrada. Retome quando desejar reenviá-la.');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
