import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import api from '../api/[route]';

beforeEach(() => {
  vi.stubGlobal('Netlify', undefined);
  for (const name of ['LANGUAGE_API_KEY', 'LANGUAGE_API_URL', 'TRANSLATION_MODEL', 'SUMMARY_MODEL', 'OCR_API_KEY', 'OCR_API_URL', 'OCR_MODEL', 'APP_ACCESS_CODE']) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Vercel API entry point', () => {
  it('reports missing credentials as JSON and reads server environment variables without exposing them', async () => {
    const url = 'https://lume.test/api/summary-config';
    const missing = await api.fetch(new Request(url));
    expect(missing.status).toBe(200);
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect(await missing.json()).toMatchObject({ configured: false, ocrConfigured: false, accessRequired: false });

    vi.stubEnv('LANGUAGE_API_KEY', 'language-secret');
    vi.stubEnv('LANGUAGE_API_URL', 'https://processing.test/v1/responses');
    vi.stubEnv('SUMMARY_MODEL', 'summary-model');
    vi.stubEnv('OCR_API_KEY', 'ocr-secret');
    vi.stubEnv('OCR_API_URL', 'https://processing.test/v1/ocr');
    vi.stubEnv('OCR_MODEL', 'ocr-model');
    vi.stubEnv('APP_ACCESS_CODE', 'access-secret');
    const configured = await api.fetch(new Request(url));
    expect(configured.status).toBe(200);
    const body = await configured.text();
    expect(JSON.parse(body)).toMatchObject({ configured: true, ocrConfigured: true, accessRequired: true });
    expect(body).not.toContain('-secret');
  });

  it('returns JSON errors for unknown routes and unsupported methods', async () => {
    const unknown = await api.fetch(new Request('https://lume.test/api/unknown'));
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');

    const wrongMethod = await api.fetch(new Request('https://lume.test/api/summary-config', { method: 'POST' }));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
  });

  it('keeps the original PDF bytes and access checks behind the HTTPS proxy', async () => {
    vi.stubEnv('OCR_API_KEY', 'ocr-secret');
    vi.stubEnv('OCR_API_URL', 'https://processing.test/v1/ocr');
    vi.stubEnv('OCR_MODEL', 'ocr-model');
    vi.stubEnv('APP_ACCESS_CODE', 'access-secret');
    const provider = vi.fn(async (_url: string, _options: RequestInit) => Response.json({}, { status: 429 }));
    vi.stubGlobal('fetch', provider);

    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    const bytes = new Uint8Array(await pdf.save());
    const request = (origin: string, code: string) => new Request('http://lume.test/api/summary-ocr', {
      method: 'POST',
      headers: { origin, 'x-forwarded-proto': 'https', 'content-type': 'application/pdf', 'x-access-code': code },
      body: bytes,
    });

    expect((await api.fetch(request('https://other.test', 'access-secret'))).status).toBe(403);
    expect((await api.fetch(request('https://lume.test', 'wrong-code'))).status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
    expect((await api.fetch(request('https://lume.test', 'access-secret'))).status).toBe(429);
    expect(provider).toHaveBeenCalledTimes(1);
    const [url, options] = provider.mock.calls[0];
    expect(url).toBe('https://processing.test/v1/ocr');
    expect(JSON.parse(String(options.body)).document.document_url).toBe(
      `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
    );
  });
});
