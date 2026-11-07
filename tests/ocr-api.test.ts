import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import ocr from '../netlify/functions/ocr';
import config from '../netlify/functions/config';
import { parseMistralOcr, recognizePdf } from '../netlify/functions/_shared/mistral';
import { MAX_OCR_REQUEST_BYTES, OCR_TIMEOUT_MS } from '../src/ocr-contract';

let settings: Record<string, string>;
let pdf: Uint8Array;
const provider = vi.fn();
const source = () => ({
  model: 'mistral-ocr-4-1', usage_info: { pages_processed: 1, doc_size_bytes: 100 },
  pages: [{ index: 0, markdown: '# Results\nMeasured prose.', dimensions: { width: 1700, height: 2200, dpi: 200 },
    confidence_scores: { average_page_confidence_score: 0.98, minimum_page_confidence_score: 0.3 },
    blocks: [
      { type: 'title', top_left_x: 100, top_left_y: 110, bottom_right_x: 700, bottom_right_y: 150,
        content: '# Results', confidence_scores: { average_content_confidence_score: 0.99 } },
      { type: 'text', top_left_x: 100, top_left_y: 180, bottom_right_x: 900, bottom_right_y: 480,
        content: 'Measured prose.', confidence_scores: { average_content_confidence_score: 0.95 } },
      { type: 'image', top_left_x: 100, top_left_y: 600, bottom_right_x: 900, bottom_right_y: 900,
        content: '', confidence_scores: { average_content_confidence_score: null } },
    ],
  }],
});
const request = (bytes: Uint8Array = pdf, headers: Record<string, string> = {}) => new Request('https://lume.test/api/ocr', {
  method: 'POST', headers: { 'Content-Type': 'application/pdf', origin: 'https://lume.test', ...headers },
  body: new Uint8Array(bytes).buffer,
});

beforeAll(async () => {
  const document = await PDFDocument.create();
  document.addPage([612, 792]);
  pdf = await document.save();
});
beforeEach(() => {
  settings = { MISTRAL_API_KEY: 'test-mistral-secret' };
  vi.stubGlobal('Netlify', { env: { get: (name: string) => settings[name] } });
  vi.stubGlobal('fetch', provider);
  provider.mockReset().mockImplementation(() => Response.json(source()));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Mistral OCR API', () => {
  it('sends a single PDF using the latest model from the server and returns only normalized blocks', async () => {
    const response = await ocr(request());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ model: 'mistral-ocr-4-1', usage: { pages: 1 }, page: {
      width: 1700, height: 2200, confidence: 98,
      blocks: [
        { type: 'title', x: 100, y: 110, width: 600, height: 40, content: '# Results', confidence: 99 },
        { type: 'text', x: 100, y: 180, width: 800, height: 300, content: 'Measured prose.', confidence: 95 },
        { type: 'image', x: 100, y: 600, width: 800, height: 300, content: '', confidence: null },
      ],
    } });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('netlify-cdn-cache-control')).toBe('no-store');
    expect(provider).toHaveBeenCalledTimes(1);
    const [url, init] = provider.mock.calls[0];
    expect(url).toBe('https://api.mistral.ai/v1/ocr');
    expect(init.headers.Authorization).toBe('Bearer test-mistral-secret');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'mistral-ocr-latest', include_blocks: true,
      confidence_scores_granularity: 'block', include_image_base64: false });
    expect(body.document.type).toBe('document_url');
    expect(body.document.document_url).toBe(`data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`);
    expect(JSON.stringify(result)).not.toContain('test-mistral-secret');
    expect(JSON.stringify(result)).not.toContain('doc_size_bytes');
  });

  it('reports independent OCR and translation configuration without exposing keys', async () => {
    settings.MISTRAL_OCR_MODEL = 'mistral-ocr-4-1';
    const data = await (await config()).json();
    expect(data).toMatchObject({ configured: false, ocr: { configured: true, provider: 'mistral', model: 'mistral-ocr-4-1' } });
    expect(JSON.stringify(data)).not.toContain('test-mistral-secret');
    expect((await ocr(request())).status).toBe(200);
    expect(JSON.parse(provider.mock.calls[0][1].body).model).toBe('mistral-ocr-4-1');
    settings = { OPENAI_API_KEY: 'translation-only' };
    expect((await ocr(request())).status).toBe(503);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('checks method, origin and shared code before contacting the provider', async () => {
    expect((await ocr(new Request('https://lume.test/api/ocr'))).status).toBe(405);
    expect((await ocr(request(pdf, { origin: 'https://other.test' }))).status).toBe(403);
    settings.APP_ACCESS_CODE = 'private';
    expect((await ocr(request())).status).toBe(401);
    expect((await ocr(request(pdf, { 'X-Access-Code': 'wrong' }))).status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
    expect((await ocr(request(pdf, { 'X-Access-Code': 'private' }))).status).toBe(200);
  });

  it.each(['application/json', 'multipart/form-data', 'image/png', 'application/pdf-other'])('rejects content type %s', async contentType => {
    expect((await ocr(request(pdf, { 'Content-Type': contentType }))).status).toBe(415);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects oversized, malformed and multipage documents before sending any content', async () => {
    expect((await ocr(request(pdf, { 'Content-Length': String(MAX_OCR_REQUEST_BYTES + 1) }))).status).toBe(413);
    expect((await ocr(request(new Uint8Array(MAX_OCR_REQUEST_BYTES + 1)))).status).toBe(413);
    expect((await ocr(request(new TextEncoder().encode('not a PDF')))).status).toBe(400);
    expect((await ocr(request(new TextEncoder().encode('%PDF-broken')))).status).toBe(400);
    const multiple = await PDFDocument.create();
    multiple.addPage([612, 792]); multiple.addPage([612, 792]);
    expect((await ocr(request(await multiple.save()))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects unsupported rotation and dimensions before provider calls', async () => {
    for (const [width, height, rotation] of [[50, 792, 0], [612, 4000, 0], [612, 792, 90]]) {
      const document = await PDFDocument.create();
      document.addPage([width, height]).setRotation(degrees(rotation));
      expect((await ocr(request(await document.save()))).status).toBe(400);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([[401, 503], [403, 503], [429, 429], [422, 422], [413, 422], [500, 502]])(
    'sanitizes provider status %i into %i without retrying', async (status, expected) => {
      provider.mockResolvedValue(new Response('private PDF content and test-mistral-secret', { status }));
      const response = await ocr(request());
      expect(response.status).toBe(expected);
      expect(await response.text()).not.toMatch(/private PDF content|test-mistral-secret/);
      expect(provider).toHaveBeenCalledTimes(1);
    });

  it('retains bounded diagnostic identifiers and a category without returning provider prose or credentials', async () => {
    const message = 'Requests rate limit exceeded. Private scientific PDF content and test-mistral-secret must remain private.';
    provider.mockResolvedValue(Response.json({ message, type: 'rate_limit_error', code: '1300', param: 'private document' },
      { status: 429, headers: { 'X-Request-ID': 'diagnostic-123', Authorization: 'Bearer test-mistral-secret' } }));
    const response = await ocr(request());
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'A API Mistral limitou o processamento (HTTP 429). Confira os limites de uso da conta e tente retomar o OCR.',
      providerError: { provider: 'mistral', status: 429, code: '1300', type: 'rate_limit_error', reason: 'request_rate', requestId: 'diagnostic-123' },
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('netlify-cdn-cache-control')).toBe('no-store');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Monthly quota exceeded.', 'monthly_quota'],
    ['Your free tier monthly quota exceeded.', 'monthly_quota'],
    ['Organization spending limit reached.', 'spending_limit'],
    ['Insufficient credits remaining.', 'credits'],
    ['OCR pages per minute limit exceeded.', 'page_rate'],
    ['Tokens per minute limit exceeded.', 'token_rate'],
    ['Free tier capacity exceeded.', 'free_tier_capacity'],
    ['Free tier request capacity exceeded.', 'free_tier_capacity'],
    ['Service capacity exceeded.', 'capacity'],
    ['The API returned a quota error.', 'unknown'],
    ['private source text contains no explanation', 'unknown'],
  ])('classifies only explicit upstream evidence: %s', async (message, reason) => {
    provider.mockResolvedValue(Response.json({ message }, { status: 429 }));
    const error = await recognizePdf(pdf, new AbortController().signal).catch(error => error);
    expect(error.status).toBe(429);
    expect(error.providerError).toEqual({ provider: 'mistral', status: 429, reason });
    expect(error.message).not.toContain(message);
  });

  it('omits malformed identifiers and credential reflections even in otherwise valid structured fields', async () => {
    for (const value of ['test-mistral-secret', 'PREFIX-TEST-MISTRAL-SECRET-SUFFIX', 'private PDF content', '<script>', 'x'.repeat(101)]) {
      provider.mockResolvedValueOnce(Response.json({ message: 'Unexpected failure', code: value, type: value, request_id: value },
        { status: 429, headers: { 'X-Request-ID': value } }));
      const response = await ocr(request());
      expect(response.status).toBe(429);
      const result = await response.json();
      expect(result).toMatchObject({ providerError: { provider: 'mistral', status: 429, reason: 'unknown' } });
      // None of these values are valid public identifiers, including the secret
      // that would otherwise satisfy the alphanumeric identifier allowlist.
      expect(result.providerError.code).toBeUndefined();
      expect(result.providerError.type).toBeUndefined();
      expect(result.providerError.requestId).toBeUndefined();
    }
  });

  it('accepts nested documented diagnostics and bounded numeric codes', async () => {
    provider.mockResolvedValue(Response.json({ error: { code: 1301, type: 'rate_limit_error', message: 'Tokens per minute limit exceeded.', request_id: 'request-456' } }, { status: 429 }));
    const error = await recognizePdf(pdf, new AbortController().signal).catch(error => error);
    expect(error.providerError).toEqual({ provider: 'mistral', status: 429, code: 1301, type: 'rate_limit_error', reason: 'token_rate', requestId: 'request-456' });
  });

  it('keeps HTTP 429 when its diagnostic body is oversized or malformed and cancels an oversized stream', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(8193))); }, cancel });
    for (const response of [new Response(stream, { status: 429, headers: { 'Content-Type': 'application/json' } }),
      new Response('{', { status: 429, headers: { 'Content-Type': 'application/json' } }),
      new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', 'Content-Length': '8193' } })]) {
      provider.mockResolvedValueOnce(response);
      const result = await ocr(request());
      expect(result.status).toBe(429);
      expect(await result.json()).toMatchObject({ providerError: { provider: 'mistral', status: 429, reason: 'unknown' } });
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it('enforces the total deadline and cancellation while reading an upstream error body', async () => {
    vi.useFakeTimers();
    const cancelledByTimeout = vi.fn();
    provider.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelledByTimeout }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
    const timed = recognizePdf(pdf, new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS + 1);
    expect((await timed).status).toBe(504);
    expect(cancelledByTimeout).toHaveBeenCalledTimes(1);

    const cancelledByClient = vi.fn(), controller = new AbortController();
    provider.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelledByClient }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
    const pending = recognizePdf(pdf, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(cancelledByClient).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('rejects non-JSON and oversized provider responses without leaking their content', async () => {
    for (const response of [new Response('<html>private</html>'),
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '2000001' } })]) {
      provider.mockResolvedValueOnce(response);
      const result = await ocr(request());
      expect(result.status).toBe(502);
      expect(await result.text()).not.toContain('private');
    }
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it('refuses an OCR page whose aspect ratio is incompatible with the source PDF', async () => {
    const data = source(); data.pages[0].dimensions.width = 2200;
    provider.mockResolvedValue(Response.json(data));
    const response = await ocr(request());
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('dimensões incompatíveis');
  });

  it('bounds the whole provider call with a timeout and does not retry an ambiguous result', async () => {
    vi.useFakeTimers();
    provider.mockImplementation((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = recognizePdf(pdf, new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS + 1);
    const error = await pending;
    expect(error.status).toBe(504);
    expect(error.message).toContain('cobrada');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('also enforces the deadline while reading a stalled response body', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    provider.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
    const pending = recognizePdf(pdf, new AbortController().signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(OCR_TIMEOUT_MS + 1);
    expect((await pending).status).toBe(504);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('propagates client cancellation without starting another request', async () => {
    provider.mockImplementation((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const controller = new AbortController();
    const pending = recognizePdf(pdf, controller.signal).catch(error => error);
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe('Mistral OCR response validation', () => {
  it('retains unscored regions as null and accepts an actually blank page', () => {
    const data = source();
    delete (data.pages[0] as { confidence_scores?: unknown }).confidence_scores;
    delete (data.pages[0].blocks[0] as { confidence_scores?: unknown }).confidence_scores;
    const result = parseMistralOcr(data);
    expect(result.page.confidence).toBeNull();
    expect(result.page.blocks[0].confidence).toBeNull();
    data.pages[0].blocks = []; data.pages[0].markdown = '';
    expect(parseMistralOcr(data).page.blocks).toEqual([]);
  });

  it.each([
    (data: any) => { data.pages = []; },
    (data: any) => { data.pages[0].index = 1; },
    (data: any) => { data.usage_info.pages_processed = 2; },
    (data: any) => { data.model = 'unrelated-model'; },
    (data: any) => { data.pages[0].dimensions.width = 0; },
    (data: any) => { data.pages[0].blocks = null; },
    (data: any) => { data.pages[0].blocks = []; },
    (data: any) => { data.pages[0].blocks[0].top_left_x = -1; },
    (data: any) => { data.pages[0].blocks[0].bottom_right_y = 2201; },
    (data: any) => { data.pages[0].blocks[0].bottom_right_x = 100; },
    (data: any) => { data.pages[0].blocks[0].content = 'text\u0000binary'; },
    (data: any) => { data.pages[0].blocks[0].confidence_scores.average_content_confidence_score = 99; },
  ])('rejects incomplete or inconsistent data', mutate => {
    const data = source(); mutate(data);
    expect(() => parseMistralOcr(data)).toThrow(/estrutura de OCR inválida/);
  });
});
