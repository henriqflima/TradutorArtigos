import { Buffer } from 'node:buffer';
import { MAX_OCR_BLOCKS, MAX_OCR_RESPONSE_BYTES, OCR_MODEL, OCR_TIMEOUT_MS, type OcrBlock, type OcrResult } from '../../../src/ocr-contract';
import { env, HttpError, readBounded, type ProviderErrorDetails } from './http';

const INVALID_RESPONSE = 'A Mistral retornou uma estrutura de OCR inválida. Tente novamente ou use outro PDF.';
const MAX_ERROR_BYTES = 8_192;

function safeIdentifier(value: unknown, secret: string): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) return undefined;
  // Structured fields and headers may also reflect an upstream credential.
  if (secret && value.toLowerCase().includes(secret.toLowerCase())) return undefined;
  return value;
}
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

/** Preserve only bounded identifiers and a fixed category, never provider prose. */
async function providerErrorDetails(response: Response, signal: AbortSignal): Promise<ProviderErrorDetails> {
  const secret = env('MISTRAL_API_KEY');
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
  const rawCode = data.code ?? nested.code;
  const code = typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 0 && rawCode <= 999_999_999
    ? rawCode : safeIdentifier(rawCode, secret);
  const type = safeIdentifier(data.type ?? nested.type, secret);
  const requestId = [response.headers.get('x-request-id'), response.headers.get('mistral-request-id'),
    response.headers.get('request-id'), data.request_id, nested.request_id].map(value => safeIdentifier(value, secret)).find(Boolean);
  return { provider: 'mistral', status: response.status, reason: limitReason(data.message ?? nested.message ?? data.detail),
    ...(code !== undefined ? { code } : {}), ...(type ? { type } : {}), ...(requestId ? { requestId } : {}) };
}

export function ocrModel() { return env('MISTRAL_OCR_MODEL') || OCR_MODEL; }

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
  // Mistral computes these scores from exp(logprob), on a 0–1 scale.
  return score === undefined || score === null ? null : finite(score, 0, 1) * 100;
}

/** Validate every region before returning content; never invent missing word geometry. */
export function parseMistralOcr(input: unknown): OcrResult {
  const data = record(input);
  if (typeof data.model !== 'string' || !/^mistral-ocr-[a-zA-Z0-9._:-]{1,180}$/.test(data.model) ||
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
  return { model: data.model, page: { width, height, blocks,
    confidence: confidence(source.confidence_scores, 'average_page_confidence_score') }, usage: { pages: 1 } };
}

export async function recognizePdf(bytes: Uint8Array, signal: AbortSignal): Promise<OcrResult> {
  const model = ocrModel();
  if (!/^mistral-ocr-[a-zA-Z0-9._:-]{1,120}$/.test(model)) throw new HttpError(503, 'O modelo de OCR configurado no servidor é inválido.');
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let expired = false;
  const timeout = setTimeout(() => { expired = true; controller.abort(); }, OCR_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    const response = await fetch('https://api.mistral.ai/v1/ocr', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${env('MISTRAL_API_KEY')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model, document: { type: 'document_url', document_url: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}` },
        include_blocks: true, confidence_scores_granularity: 'block', include_image_base64: false }),
    });
    if (!response.ok) {
      const details = await providerErrorDetails(response, controller.signal);
      if (response.status === 429) throw new HttpError(429, 'A API Mistral limitou o processamento (HTTP 429). Confira os limites de uso da conta e tente retomar o OCR.', details);
      if (response.status === 401 || response.status === 403) throw new HttpError(503, 'A chave Mistral não foi aceita ou não tem acesso ao OCR. Confira a configuração do servidor.', details);
      if ([400, 413, 415, 422].includes(response.status)) throw new HttpError(422, 'A Mistral não conseguiu processar esta página do PDF. Confira se o documento é legível e não está protegido.', details);
      throw new HttpError(502, 'O serviço de reconhecimento da Mistral está indisponível. Tente retomar mais tarde.', details);
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
    return parseMistralOcr(data);
  } catch (error) {
    if (expired) throw new HttpError(504, 'O OCR excedeu o tempo de espera. A página pode ter sido processada e cobrada; tente retomar somente quando desejar reenviá-la.');
    if (signal.aborted) throw new HttpError(499, 'O reconhecimento foi interrompido. Uma página já recebida pela Mistral ainda pode ter custo.');
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'A conexão com a Mistral foi interrompida. A página pode ter sido processada e cobrada; tente retomar somente quando desejar reenviá-la.');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
