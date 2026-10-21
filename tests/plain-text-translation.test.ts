import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translatePlainText, type PlainTextState } from '../src/plain-text-translation';
import { splitPlainText } from '../src/plain-text';

const options = { source: 'EN', target: 'PT-BR', code: 'private' };
const state = (): PlainTextState => ({ completed: [] });
const provider = vi.fn();
const identity = (_url: string, init: RequestInit) => Response.json({ translations: [JSON.parse(String(init.body)).text] });
beforeEach(() => { vi.stubGlobal('fetch', provider); provider.mockReset(); provider.mockImplementation(identity); });
afterEach(() => vi.unstubAllGlobals());

describe('plain text translation flow', () => {
  it('translates 10,000 words through small requests and preserves paragraph separators', async () => {
    const text = '  ' + Array(10_000).fill('word').join('\n\n') + '\t\n';
    const cache = state(), progress = vi.fn();
    const result = await translatePlainText(text, options, cache, progress, new AbortController().signal);
    expect(result).toBe(text);
    expect(provider.mock.calls.length).toBeGreaterThan(1);
    for (const [url, init] of provider.mock.calls) {
      const body = JSON.parse(String(init.body));
      expect(url).toBe('/api/translate-plain-text');
      expect(body.text.length).toBeLessThanOrEqual(2_500);
      expect(body).toMatchObject({ source_lang: 'EN', target_lang: 'PT-BR' });
      expect(init.headers['X-Access-Code']).toBe('private');
    }
    expect(progress.mock.lastCall?.[0]).toMatchObject({ text, completed: cache.completed.length, total: cache.completed.length });
  });

  it('rejects excessive input and same-language selections before any request', async () => {
    await expect(translatePlainText('word '.repeat(10_001), options, state(), () => {}, new AbortController().signal)).rejects.toThrow('10.000 palavras');
    await expect(translatePlainText('Hello', { ...options, source: 'PT' }, state(), () => {}, new AbortController().signal)).rejects.toThrow('idiomas');
    expect(provider).not.toHaveBeenCalled();
  });

  it('omits the source language for automatic detection', async () => {
    await translatePlainText('Hello', { ...options, source: '' }, state(), () => {}, new AbortController().signal);
    expect(JSON.parse(String(provider.mock.calls[0][1].body))).not.toHaveProperty('source_lang');
  });

  it('keeps completed chunks after failure and resumes only pending chunks', async () => {
    const text = 'One paragraph. '.repeat(500), cache = state();
    provider.mockImplementationOnce(identity).mockResolvedValueOnce(new Response('Timeout', { status: 504 }));
    await expect(translatePlainText(text, options, cache, () => {}, new AbortController().signal)).rejects.toThrow('HTTP 504');
    expect(cache.completed).toHaveLength(1);
    const completed = cache.completed[0];
    provider.mockClear();
    const result = await translatePlainText(text, options, cache, () => {}, new AbortController().signal);
    expect(result).toBe(text);
    expect(cache.completed[0]).toBe(completed);
    expect(provider).toHaveBeenCalledTimes(splitPlainText(text).length - 1);
  });

  it('stops before another chunk and resumes without repeating the completed one', async () => {
    const abort = new AbortController(), cache = state(), text = 'word '.repeat(1200);
    await expect(translatePlainText(text, options, cache, progress => {
      if (progress.completed === 1) abort.abort();
    }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(cache.completed).toHaveLength(1);
    provider.mockClear();
    expect(await translatePlainText(text, options, cache, () => {}, new AbortController().signal)).toBe(text);
    expect(provider).toHaveBeenCalledTimes(splitPlainText(text).length - 1);
  });

  it.each(['text', 'source', 'target'] as const)('invalidates a previous translation when %s changes', async field => {
    const cache = state();
    await translatePlainText('Hello', options, cache, () => {}, new AbortController().signal);
    provider.mockClear();
    const nextOptions = { ...options, ...(field === 'source' ? { source: 'FR' } : field === 'target' ? { target: 'ES' } : {}) };
    const text = field === 'text' ? 'Goodbye' : 'Hello';
    expect(await translatePlainText(text, nextOptions, cache, () => {}, new AbortController().signal)).toBe(text);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('reuses unchanged leading chunks when more text is typed', async () => {
    const cache = state(), text = 'A sentence about science. '.repeat(300);
    await translatePlainText(text, options, cache, () => {}, new AbortController().signal);
    const originalChunks = splitPlainText(text), completed = [...cache.completed];
    provider.mockClear();
    const next = text + 'Another sentence at the end.';
    const nextChunks = splitPlainText(next);
    const result = await translatePlainText(next, options, cache, () => {}, new AbortController().signal);
    expect(result).toBe(next);
    const reusable = originalChunks.findIndex((chunk, index) => JSON.stringify(chunk) !== JSON.stringify(nextChunks[index]));
    expect(reusable).toBeGreaterThan(0);
    expect(cache.completed.slice(0, reusable)).toEqual(completed.slice(0, reusable));
    expect(provider).toHaveBeenCalledTimes(nextChunks.length - reusable);
  });

  it('retranslates the edited chunk and every following chunk after an edit in the middle', async () => {
    const cache = state(), text = 'The sample was measured. '.repeat(500);
    await translatePlainText(text, options, cache, () => {}, new AbortController().signal);
    const chunks = splitPlainText(text);
    const prefix = chunks.slice(0, 2).map(chunk => chunk.before + chunk.text + chunk.after).join('');
    provider.mockClear();
    const next = prefix + 'Changed measurement. ' + text.slice(prefix.length);
    expect(await translatePlainText(next, options, cache, () => {}, new AbortController().signal)).toBe(next);
    expect(provider).toHaveBeenCalledTimes(splitPlainText(next).length - 2);
    expect(JSON.parse(String(provider.mock.calls[0][1].body)).text).toMatch(/^Changed measurement\./);
  });

  it('ignores a response received after cancellation, even if fetch does not honor abort', async () => {
    let respond!: (response: Response) => void;
    provider.mockImplementationOnce(() => new Promise<Response>(resolve => { respond = resolve; }));
    const cache = state(), abort = new AbortController(), progress = vi.fn();
    const result = translatePlainText('Old text', options, cache, progress, abort.signal).catch(error => error);
    abort.abort();
    respond(Response.json({ translations: ['An outdated response'] }));
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(cache.completed).toEqual([]);
    expect(progress).toHaveBeenCalledTimes(1);
    provider.mockClear();
    expect(await translatePlainText('New text', options, cache, () => {}, new AbortController().signal)).toBe('New text');
  });

  it.each([{ translations: [] }, { translations: [''] }, { translations: ['one', 'two'] }])('does not cache incomplete responses %j', async ({ translations }) => {
    provider.mockResolvedValue(Response.json({ translations }));
    const cache = state();
    await expect(translatePlainText('Hello', options, cache, () => {}, new AbortController().signal)).rejects.toThrow('incompleta');
    expect(cache.completed).toEqual([]);
  });
});
