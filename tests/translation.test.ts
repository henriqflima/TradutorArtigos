import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import config from '../netlify/functions/config';
import translateText from '../netlify/functions/translate-text';
import { EXTENSIONS, MAX_FILE_BYTES, MAX_PDF_PAGES, validateFile } from '../src/shared';

let settings: Record<string, string>;
const provider = vi.fn();
beforeEach(() => {
  settings = { OPENAI_API_KEY: 'test-openai-key' };
  vi.stubGlobal('Netlify', { env: { get: (name: string) => settings[name] } });
  vi.stubGlobal('fetch', provider);
  provider.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function request(headers: Record<string, string> = {}) {
  return new Request('https://lume.test/api/translate-text', {
    method: 'POST', headers: { origin: 'https://lume.test', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ text: ['<p id="b0">A scientific article.</p>'], target_lang: 'PT-BR' }),
  });
}

describe('PDF input limits', () => {
  it('accepts only nonempty PDFs up to exactly 4 MB', () => {
    expect(EXTENSIONS).toEqual(['pdf']);
    expect(MAX_FILE_BYTES).toBe(4_000_000);
    expect(MAX_PDF_PAGES).toBe(20);
    expect(validateFile({ name: 'article.pdf', size: 4_000_000 })).toBeNull();
    expect(validateFile({ name: 'ARTICLE.PDF', size: 10 })).toBeNull();
    expect(validateFile({ name: 'article.pdf', size: 4_000_001 })).toContain('4 MB');
    expect(validateFile({ name: 'empty.pdf', size: 0 })).toContain('vazio');
  });

  it.each(['article.doc', 'article.docx', 'scan.jpg', 'scan.jpeg', 'scan.png', 'article.pdf.exe', 'article'])
    ('rejects %s before translation', name => {
      expect(validateFile({ name, size: 1_000 })).toMatch(/PDF/i);
    });
});

describe('OpenAI configuration and access', () => {
  it('reports provider/model without exposing credentials or obsolete plan fields', async () => {
    settings.APP_ACCESS_CODE = 'private';
    const response = await config();
    expect(await response.json()).toEqual({ configured: true, accessRequired: true, provider: 'openai', model: 'gpt-6-luna' });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(provider).not.toHaveBeenCalled();
  });

  it('uses OPENAI_API_KEY and reports an honest unconfigured state', async () => {
    settings = { DEEPL_API_KEY: 'obsolete-provider-key' };
    expect(await (await config()).json()).toMatchObject({ configured: false, accessRequired: false });
    const response = await translateText(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('configuração do serviço');
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects cross-origin requests and missing or incorrect access codes', async () => {
    expect((await translateText(request({ origin: 'https://other.test' }))).status).toBe(403);
    settings.APP_ACCESS_CODE = 'private';
    expect((await translateText(request())).status).toBe(401);
    expect((await translateText(request({ 'X-Access-Code': 'wrong' }))).status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects unsupported methods without contacting OpenAI', async () => {
    expect((await translateText(new Request('https://lume.test/api/translate-text'))).status).toBe(405);
    expect(provider).not.toHaveBeenCalled();
  });
});
