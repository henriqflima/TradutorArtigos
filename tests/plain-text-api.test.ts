import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import translateText from '../netlify/functions/translate-plain-text';

let settings: Record<string, string>;
const provider = vi.fn();
beforeEach(() => {
  settings = { OPENAI_API_KEY: 'test-key' };
  vi.stubGlobal('Netlify', { env: { get: (name: string) => settings[name] } });
  vi.stubGlobal('fetch', provider);
  provider.mockReset();
  provider.mockImplementation((_url, init) => {
    const input = JSON.parse(JSON.parse(String(init.body)).input);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{
      type: 'output_text', text: JSON.stringify({ translations: input.blocks }),
    }] }] });
  });
});
afterEach(() => vi.unstubAllGlobals());
const request = (data: unknown = { text: 'Hello', target_lang: 'PT-BR' }, headers: Record<string, string> = {}) =>
  new Request('https://lume.test/api/translate-plain-text', { method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://lume.test', ...headers }, body: JSON.stringify(data) });

describe('plain text API', () => {
  it('translates literal text through the existing provider and returns only text with no caching', async () => {
    const text = 'Hello <img src=x onerror="alert(1)"> & world.\n\nNext paragraph.';
    const response = await translateText(request({ text, source_lang: 'EN', target_lang: 'PT-BR' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translations: [text] });
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = JSON.parse(String(provider.mock.calls[0][1].body));
    expect(body.store).toBe(false);
    const input = JSON.parse(body.input);
    expect(input.blocks[0].xml).toContain('&lt;img');
    expect(input.source_language).toBe('Inglês');
    expect(input.target_language).toBe('Português (Brasil)');
  });

  it('accepts exactly 10,000 words and rejects 10,001 before contacting the provider', async () => {
    const text = Array(10_000).fill('word').join(' ');
    expect((await translateText(request({ text, target_lang: 'PT-BR' }))).status).toBe(200);
    provider.mockClear();
    const response = await translateText(request({ text: text + ' extra', target_lang: 'PT-BR' }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('10.000 palavras');
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { text: ['Hello'], target_lang: 'ES' }, { text: { name: 'file.txt' }, target_lang: 'ES' },
    { text: '   ', target_lang: 'ES' }, { text: 'binary\u0000content', target_lang: 'ES' },
    { text: 'Hello', target_lang: 'ES', file: 'file.pdf' }, { text: 'Hello', target_lang: 'INVALID' },
    { text: 'Hello', source_lang: 'INVALID', target_lang: 'ES' }, { text: 'Hello', source_lang: 'EN', target_lang: 'EN-US' }])
    ('rejects invalid input %j before contacting the provider', async data => {
      expect((await translateText(request(data))).status).toBe(400);
      expect(provider).not.toHaveBeenCalled();
    });

  it.each(['multipart/form-data; boundary=test', 'image/png', 'application/pdf', 'text/plain', 'application/json-other'])
    ('rejects non-JSON content type %s', async type => {
      expect((await translateText(request(undefined, { 'Content-Type': type }))).status).toBe(400);
      expect(provider).not.toHaveBeenCalled();
    });

  it('retains the existing access and origin controls', async () => {
    expect((await translateText(new Request('https://lume.test/api/translate-plain-text'))).status).toBe(405);
    expect((await translateText(request(undefined, { origin: 'https://other.test' }))).status).toBe(403);
    settings.APP_ACCESS_CODE = 'private';
    expect((await translateText(request())).status).toBe(401);
    expect((await translateText(request(undefined, { 'X-Access-Code': 'private' }))).status).toBe(200);
    settings = {};
    expect((await translateText(request())).status).toBe(503);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON and oversized bodies', async () => {
    expect((await translateText(new Request('https://lume.test/api/translate-plain-text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    }))).status).toBe(400);
    expect((await translateText(request(undefined, { 'Content-Length': '1000001' }))).status).toBe(413);
    expect(provider).not.toHaveBeenCalled();
  });
});
