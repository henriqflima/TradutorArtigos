import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translateStructured, type TranslationState } from '../src/structured-translation';
import type { StructuredDocument } from '../src/structured-document';

function document(blocks = 1): StructuredDocument {
  return {
    version: 1, sourceKind: 'pdf', sourceHash: 'transport-fixture', sourceName: 'transport.pdf',
    pages: [{ width: 612, height: 792 }], assets: [], issues: [],
    blocks: Array.from({ length: blocks }, (_, index) => ({
      id: `paragraph-${index}`, kind: 'paragraph', page: 1,
      rect: { x: 10, y: 10, width: 100, height: 20 }, fontSize: 11,
      runs: [{ type: 'text', text: `Scientific paragraph ${index}.` }],
    })),
  };
}
const options = { source: 'EN', target: 'PT-BR', code: '' };
const cache = (): TranslationState => ({ completed: {} });
const translate = (source = document(), state = cache(), controller = new AbortController()) =>
  translateStructured(source, options, state, () => {}, controller.signal);
function success(init: RequestInit) {
  return Response.json({ translations: JSON.parse(String(init.body)).text });
}
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('translation transport errors', () => {
  it.each([502, 503, 504])('reports HTTP %s and a safe request reference without retrying or exposing HTML', async status => {
    fetchMock.mockResolvedValue(new Response('<html>private platform error</html>', {
      status, headers: { 'content-type': 'text/html', 'x-nf-request-id': '01K-VALID_request.123' },
    }));
    const error = await translate().catch(reason => reason as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).toContain('Referência da solicitação: 01K-VALID_request.123');
    expect((error as Error).message).toContain('trechos anteriores');
    expect((error as Error).message).not.toMatch(/<html>|private platform error/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not show an unsafe request reference or automatically retry a server JSON error', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'O lote não foi confirmado.', retryable: true }, {
      status: 502, headers: { 'x-nf-request-id': '<script>private</script>' },
    }));
    await expect(translate()).rejects.toThrow('O lote não foi confirmado.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(new Response('Bad Gateway', {
      status: 502, headers: { 'x-nf-request-id': '<script>private</script>' },
    }));
    const error = await translate().catch(reason => reason as Error);
    expect((error as Error).message).not.toMatch(/script|private|Referência da solicitação/);
  });

  it('reports malformed successful JSON explicitly and does not expose its body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>private invalid response</html>', { status: 200 }));
    await expect(translate()).rejects.toThrow('resposta de tradução inválida (HTTP 200)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unreadable successful body as a translation or retry it', async () => {
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('private stream failure')); },
    }), { status: 200, headers: { 'x-nf-request-id': '01K-STREAM' } }));
    const state = cache();
    const error = await translate(document(), state).catch(reason => reason as Error);
    expect((error as Error).message).toContain('Não foi possível ler a resposta deste lote (HTTP 200)');
    expect((error as Error).message).toContain('01K-STREAM');
    expect((error as Error).message).not.toContain('private stream failure');
    expect(state.completed).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['80', 'Sat, 17 Oct 2026 12:01:20 GMT'])('respects the full platform Retry-After value %s before retrying a textual 429', async retryAfter => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    let started!: () => void;
    const firstRequest = new Promise<void>(resolve => { started = resolve; });
    fetchMock.mockImplementationOnce(() => {
      started();
      return new Response('Too many requests: private details', { status: 429, headers: { 'Retry-After': retryAfter } });
    });
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => success(init));
    const result = translate();
    await firstRequest;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(79_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('limits textual platform 429 retries to three attempts', async () => {
    fetchMock.mockImplementation(() => new Response('private rate limit', {
      status: 429, headers: { 'Retry-After': '0', 'x-nf-request-id': '01K-LIMIT' },
    }));
    const error = await translate().catch(reason => reason as Error);
    expect((error as Error).message).toContain('HTTP 429');
    expect((error as Error).message).toContain('01K-LIMIT');
    expect((error as Error).message).not.toContain('private rate limit');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a JSON quota rejection even if Retry-After is present', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'A cota foi atingida.', retryable: false }, {
      status: 429, headers: { 'Retry-After': '0' },
    }));
    await expect(translate()).rejects.toThrow('A cota foi atingida.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a platform rate limit wait before another attempt', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const firstRequest = new Promise<void>(resolve => { started = resolve; });
    fetchMock.mockImplementation(() => {
      started();
      return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } });
    });
    const controller = new AbortController();
    const result = translate(document(), cache(), controller).catch(error => error);
    await firstRequest;
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves completed batches and resumes only the remaining paragraphs after a platform timeout', async () => {
    const source = document(110), state = cache();
    let calls = 0;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      calls++;
      return calls === 7 ? new Response('Function timed out', { status: 502 }) : success(init);
    });
    await expect(translate(source, state)).rejects.toThrow('HTTP 502');
    const completedIds = Object.keys(state.completed);
    expect(completedIds.length).toBeGreaterThan(0);
    expect(completedIds.length).toBeLessThan(source.blocks.length);
    const completedXmlIds = new Set(completedIds.map(id => `b${source.blocks.findIndex(block => block.id === id)}`));
    const resumedXmlIds: string[] = [];
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      resumedXmlIds.push(...body.text.map((xml: string) => xml.match(/^<p id="([^"]+)"/)![1]));
      return success(init);
    });
    await translate(source, state);
    expect(resumedXmlIds).toHaveLength(source.blocks.length - completedIds.length);
    expect(resumedXmlIds.every(id => !completedXmlIds.has(id))).toBe(true);
    expect(Object.keys(state.completed)).toHaveLength(110);
  });
});
