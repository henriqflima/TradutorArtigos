import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import translateText from '../netlify/functions/translate-text';
import { readBounded } from '../netlify/functions/_shared/http';
import { translateStructured, type TranslationState } from '../src/structured-translation';
import { ocrMathWarning } from '../src/ocr-layout';
import type { DocumentBlock, StructuredDocument } from '../src/structured-document';

const abort = () => new AbortController();
const paragraph = (id: string, text: string): DocumentBlock => ({
  id, kind: 'paragraph', page: 1, rect: { x: 10, y: 10, width: 100, height: 20 },
  fontSize: 11, runs: [{ type: 'text', text }],
});
function fixture(): StructuredDocument {
  return {
    version: 1, sourceName: 'article.pdf', sourceHash: 'source-hash-1', sourceKind: 'pdf',
    pages: [{ width: 612, height: 792 }], issues: [],
    assets: [{ id: 'eq-gamma', kind: 'equation-inline', page: 1,
      rect: { x: 50, y: 50, width: 10, height: 10 }, widthPt: 10, heightPt: 10,
      png: new Uint8Array([1]), dataUrl: 'data:image/png;base64,AQ==', sha256: 'original-image-hash', alt: 'γ' }],
    blocks: [
      { ...paragraph('heading', 'Plastic strain'), kind: 'heading' },
      { ...paragraph('p1', ''), runs: [
        { type: 'text', text: 'The strain ' }, { type: 'asset', assetId: 'eq-gamma' },
        { type: 'text', text: ' was ' }, { type: 'text', text: '1.9', style: { bold: true } },
        { type: 'text', text: ' at 90°.' },
      ] },
      { ...paragraph('equation-block', ''), kind: 'equation', assetId: 'eq-gamma', runs: [{ type: 'asset', assetId: 'eq-gamma' }] },
    ],
  };
}
function state(): TranslationState { return { completed: {} }; }
const options = { source: 'EN', target: 'PT-BR', code: 'access' };
let provider: ReturnType<typeof vi.fn>;

beforeEach(() => {
  provider = vi.fn();
  vi.stubGlobal('Netlify', { env: { get: (name: string) => name === 'OPENAI_API_KEY' ? 'test-openai-key' : undefined } });
  vi.stubGlobal('fetch', provider);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('structured translation', () => {
  it('translates text containing an OCR formula without requiring a crop', async () => {
    const doc = fixture();
    doc.assets = [];
    doc.blocks = [paragraph('p1', 'The relation $E = mc^2$ describes the sample.')];
    doc.issues = [ocrMathWarning(1, 'p1')];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text.map((xml: string) => xml
        .replace('The relation', 'A relação').replace('describes the sample.', 'descreve a amostra.')) });
    });
    const result = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(provider).toHaveBeenCalledOnce();
    expect(result.blocks.p1).toEqual([{ type: 'text', text: 'A relação $E = mc^2$ descreve a amostra.' }]);
    expect(result.document.issues).toContainEqual(expect.objectContaining({ id: 'ocr-inline-math-p1', severity: 'warning' }));
    expect(result.document.issues.some(issue => issue.severity === 'blocking')).toBe(false);
  });

  it('keeps OCR TeX entirely local, including context, and restores source math across styled runs', async () => {
    const doc = fixture();
    doc.blocks = [
      { ...paragraph('heading', String.raw`Viscosity \(\eta_0\)`), kind: 'heading' },
      { ...paragraph('p1', ''), runs: [
        { type: 'text', text: String.raw`where \( \eta_`, style: { bold: true } },
        { type: 'text', text: '0', style: { superscript: true } },
        { type: 'text', text: String.raw` \) < \(\dot{\gamma}=1/s\), \(\lambda\), \(T_{\mathrm{ref}}\), \(E_a\), \(\tau:\nabla v\) and `, style: { italic: true } },
        { type: 'asset', assetId: 'eq-gamma' }, { type: 'text', text: ' are used.' },
      ] },
    ];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const sent = JSON.stringify(body);
      for (const command of [String.raw`\eta`, String.raw`\dot`, String.raw`\lambda`, String.raw`\mathrm`, String.raw`\tau`, String.raw`\nabla`]) {
        expect(sent).not.toContain(command.replaceAll('\\', '\\\\'));
      }
      expect(body.context).toContain('[protected mathematical expression]');
      expect(body.text[1]).toContain('<b><eq id="m1">LUME_M1_PROTECTED</eq></b>');
      expect(body.text[1]).toContain('<eq id="m7">LUME_M7_PROTECTED</eq>');
      return Response.json({ translations: body.text.map((xml: string) => xml.replace('where ', 'onde ').replace(' are used.', ' são usados.')) });
    });
    const result = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(result.blocks.p1).toEqual([
      { type: 'text', text: String.raw`onde \( \eta_0 \)`, style: { bold: true } },
      { type: 'text', text: String.raw` < \(\dot{\gamma}=1/s\), \(\lambda\), \(T_{\mathrm{ref}}\), \(E_a\), \(\tau:\nabla v\) and `, style: { italic: true } },
      { type: 'asset', assetId: 'eq-gamma' }, { type: 'text', text: ' são usados.' },
    ]);
    expect(result.blocks.heading).toEqual(doc.blocks[0].runs);
  });

  it.each(['missing', 'duplicate', 'changed'])('rejects a %s OCR TeX marker before caching the batch', async failureMode => {
    const doc = fixture(); doc.assets = [];
    doc.blocks = [paragraph('p1', String.raw`Viscosity \(\eta_0\) is measured.`)];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const token = '<eq id="m1">LUME_M1_PROTECTED</eq>';
      return Response.json({ translations: body.text.map((xml: string) => failureMode === 'missing' ? xml.replace(token, '') :
        failureMode === 'duplicate' ? xml.replace(token, token + token) : xml.replace('LUME_M1_PROTECTED', 'CHANGED')) });
    });
    const cache = state();
    await expect(translateStructured(doc, options, cache, () => {}, abort().signal)).rejects.toThrow();
    expect(cache.completed).toEqual({});
  });

  it('warns when a restored OCR symbol loses both spaces and becomes embedded in a word', async () => {
    const doc = fixture(); doc.assets = [];
    doc.blocks = [paragraph('p1', String.raw`A \(\eta\) B`)];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text.map((xml: string) => xml.replace('A <eq', 'A<eq').replace('</eq> B', '</eq>B')) });
    });
    const result = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(result.document.issues).toContainEqual(expect.objectContaining({ id: 'translation-marker-p1', severity: 'warning' }));
  });

  it('invalidates cached translation when only the opaque formula source changes', async () => {
    const doc = fixture(); doc.assets = [];
    doc.blocks = [paragraph('p1', String.raw`Viscosity \(\eta_0\) is measured.`)];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); return Response.json({ translations: body.text });
    });
    const cache = state();
    await translateStructured(doc, options, cache, () => {}, abort().signal);
    const originalSignature = cache.completed.p1.sourceSignature;
    doc.blocks[0].runs = [{ type: 'text', text: String.raw`Viscosity \(\eta_1\) is measured.` }];
    const result = await translateStructured(doc, options, cache, () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(2);
    const bodies = provider.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0].text).toEqual(bodies[1].text);
    expect(cache.completed.p1.sourceSignature).not.toBe(originalSignature);
    expect(result.blocks.p1).toEqual(doc.blocks[0].runs);
  });

  it('retains pure TeX locally and discards a prior prose cache for that block', async () => {
    const doc = fixture(); doc.assets = [];
    doc.blocks = [paragraph('p1', 'Previous prose.')];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); return Response.json({ translations: body.text });
    });
    const cache = state();
    await translateStructured(doc, options, cache, () => {}, abort().signal);
    doc.blocks[0].runs = [{ type: 'text', text: String.raw`\[\rho C_p\]`, style: { bold: true } }];
    const result = await translateStructured(doc, options, cache, () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.blocks.p1).toEqual(doc.blocks[0].runs);
    expect(cache.completed).toEqual({});
  });

  it('rejects documents outside the page limit before any translation call', async () => {
    for (const pageCount of [0, 51]) {
      const doc = fixture();
      doc.pages = Array.from({ length: pageCount }, () => ({ width: 612, height: 792 }));
      await expect(translateStructured(doc, options, state(), () => {}, abort().signal)).rejects.toThrow(/50 páginas/);
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it('translates content on the last page of an exact 50-page document', async () => {
    const doc = fixture();
    doc.pages = Array.from({ length: 50 }, () => ({ width: 612, height: 792 }));
    doc.assets = [];
    doc.blocks = [{ ...paragraph('last-page', 'Evidence on the final page.'), page: 50 }];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text });
    });
    const result = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(result.document.pages).toHaveLength(50);
    expect(result.blocks['last-page']).toEqual(doc.blocks[0].runs);
    expect(provider).toHaveBeenCalledOnce();
  });

  it('invalidates results from a different model or prompt version', async () => {
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text });
    });
    const cache = state();
    await translateStructured(fixture(), options, cache, () => {}, abort().signal);
    cache.engine = 'previous-provider:previous-prompt';
    await translateStructured(fixture(), options, cache, () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(cache.engine).toContain('gpt-6.1-terra:');
  });

  it('accepts asset block IDs generated by the PDF analyzer', async () => {
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text });
    });
    const doc = fixture();
    doc.blocks[2].id = 'asset:auto-2-008';
    const result = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(result.blocks['asset:auto-2-008']).toEqual(doc.blocks[2].runs);
  });

  it('protects inline equations while retaining translated bold text and source objects', async () => {
    const seen: string[] = [];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push(...body.text);
      expect(body.context).toContain('Plastic strain');
      expect(init.headers).toMatchObject({ 'X-Access-Code': 'access' });
      return Response.json({ translations: body.text.map((xml: string) => xml
        .replace('Plastic strain', 'Deformação plástica')
        .replace('The strain ', 'A deformação ')
        .replace(' was ', ' foi ')
        .replace('1.9', '1,9')
        .replace(' at 90°.', ' a 90°.')) });
    });
    const progress: string[] = [];
    const doc = fixture(), cache = state();
    const result = await translateStructured(doc, options, cache, message => progress.push(message), abort().signal);
    expect(seen.some(xml => xml.includes('<eq id="m1">LUME_M1_PROTECTED</eq>'))).toBe(true);
    expect(seen.every(xml => !xml.includes('original-image-hash'))).toBe(true);
    expect(result.blocks.p1).toContainEqual({ type: 'asset', assetId: 'eq-gamma' });
    expect(result.blocks.p1).toContainEqual({ type: 'text', text: '1,9', style: { bold: true } });
    expect(result.blocks['equation-block']).toEqual(doc.blocks[2].runs);
    expect(result.document.issues).toEqual([expect.objectContaining({ id: 'translation-protected-p1', severity: 'warning' })]);
    expect(progress.at(-1)).toBe('2 de 2 trechos traduzidos.');
  });

  it.each(['missing', 'duplicate', 'changed'])('rejects a %s protected equation marker', async failureMode => {
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const translations = body.text.map((xml: string) => {
        if (!xml.includes('<eq')) return xml;
        const token = '<eq id="m1">LUME_M1_PROTECTED</eq>';
        return failureMode === 'missing' ? xml.replace(token, '') :
          failureMode === 'duplicate' ? xml.replace(token, token + token) :
          xml.replace('LUME_M1_PROTECTED', 'LUME_M1_CORRUPTED');
      });
      return Response.json({ translations });
    });
    const cache = state();
    await expect(translateStructured(fixture(), options, cache, () => {}, abort().signal))
      .rejects.toThrow(/marcador|equação|estrutura/i);
    expect(cache.completed).toEqual({});
  });

  it('raises a visible issue when a scientific number changes', async () => {
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text.map((xml: string) => xml.replace('1.9', '1,8')) });
    });
    const result = await translateStructured(fixture(), options, state(), () => {}, abort().signal);
    expect(result.document.issues).toContainEqual(expect.objectContaining({ blockId: 'p1', severity: 'warning' }));
  });

  it('flags a protected equation moved into the middle of a translated word', async () => {
    const doc = fixture();
    doc.blocks[1].runs = [{ type: 'text', text: 'for a high shear strain ' }, { type: 'asset', assetId: 'eq-gamma' }, { type: 'text', text: ' was measured.' }];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text.map((xml: string) => xml.includes('<eq')
        ? '<p id="b1">para um e<eq id="m1">LUME_M1_PROTECTED</eq>e de alta deformação</p>' : xml) });
    });
    const result = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(result.blocks.p1).toContainEqual({ type: 'asset', assetId: 'eq-gamma' });
    expect(result.document.issues).toContainEqual(expect.objectContaining({ id: 'translation-marker-p1', severity: 'warning' }));
  });

  it('allows a marker embedded in a term when it was embedded in the source too', async () => {
    const doc = fixture();
    doc.blocks[1].runs = [{ type: 'text', text: 'a' }, { type: 'asset', assetId: 'eq-gamma' }, { type: 'text', text: 'b' }];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text.map((xml: string) => xml.includes('<eq')
        ? '<p id="b1">x<eq id="m1">LUME_M1_PROTECTED</eq>y</p>' : xml) });
    });
    const result = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(result.document.issues.filter(issue => issue.id === 'translation-marker-p1')).toEqual([]);
  });

  it('keeps adjacent mathematical markers together even when the group moves in a sentence', async () => {
    const doc = fixture();
    doc.assets.push({ ...doc.assets[0], id: 'eq-equals' });
    doc.blocks[1].runs = [{ type: 'text', text: 'for a high shear strain ' },
      { type: 'asset', assetId: 'eq-gamma' }, { type: 'text', text: ' ' },
      { type: 'asset', assetId: 'eq-equals' }, { type: 'text', text: '3.1.' }];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text.map((xml: string) => xml.includes('<eq')
        ? xml.replace('for a high shear strain ', 'Na amostra, ').replace('3.1.', ' foi 3.1.') : xml) });
    });
    const intact = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(intact.document.issues.filter(issue => issue.id === 'translation-marker-p1')).toEqual([]);
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text.map((xml: string) => xml.replace('</eq> <eq', '</eq> e <eq')) });
    });
    const split = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(split.document.issues).toContainEqual(expect.objectContaining({ id: 'translation-marker-p1' }));
  });

  it('flags changed superscript content while preserving the superscript style', async () => {
    const doc = fixture();
    doc.blocks[1].runs = [{ type: 'text', text: 'x ' }, { type: 'text', text: '3', style: { superscript: true } }];
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text.map((xml: string) => xml.replace('<sup>3</sup>', '<sup>³</sup>')) });
    });
    const result = await translateStructured(doc, options, state(), () => {}, abort().signal);
    expect(result.blocks.p1).toContainEqual({ type: 'text', text: '³', style: { superscript: true } });
    expect(result.document.issues).toContainEqual(expect.objectContaining({ id: 'translation-superscript-p1' }));
  });

  it('reuses validated completed blocks but invalidates cache when language or source changes', async () => {
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text });
    });
    const cache = state();
    await translateStructured(fixture(), options, cache, () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(1);
    await translateStructured(fixture(), options, cache, () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(1);
    await translateStructured(fixture(), { ...options, target: 'ES' }, cache, () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(2);
    const changed = fixture(); changed.sourceHash = 'source-hash-2';
    await translateStructured(changed, { ...options, target: 'ES' }, cache, () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it('invalidates only a changed paragraph when the document identity remains the same', async () => {
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text });
    });
    const cache = state();
    await translateStructured(fixture(), options, cache, () => {}, abort().signal);
    const changed = fixture();
    const textRun = changed.blocks[1].runs[2];
    if (textRun.type === 'text') textRun.text = ' became ';
    await translateStructured(changed, options, cache, () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(provider.mock.calls[1][1].body));
    expect(body.text).toHaveLength(1);
    expect(body.text[0]).toContain('became');
  });

  it('retries only an explicit transient provider response', async () => {
    provider.mockResolvedValueOnce(Response.json({ error: 'Aguarde', retryable: true, retryAfterMs: 0 }, { status: 429 }));
    provider.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text });
    });
    await translateStructured(fixture(), options, state(), () => {}, abort().signal);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('stops before a subsequent batch when cancelled after the previous one', async () => {
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text });
    });
    const document = fixture();
    for (let index = 0; index < 9; index++) document.blocks.push(paragraph(`extra-${index}`, `Additional paragraph ${index}.`));
    const controller = abort(), cache = state();
    await expect(translateStructured(document, options, cache, message => {
      if (message.startsWith('4 de ')) controller.abort();
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(Object.keys(cache.completed)).toHaveLength(4);
  });

  it('keeps dense paragraphs in shorter calls without dropping a longer standalone paragraph', async () => {
    provider.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ translations: body.text });
    });
    const document = fixture();
    document.blocks = [paragraph('dense-1', 'a'.repeat(1_800)), paragraph('dense-2', 'b'.repeat(1_800)),
      paragraph('long', 'c'.repeat(4_000)), ...Array.from({ length: 7 }, (_, i) => paragraph(`short-${i}`, 'Short paragraph.'))];
    const cache = state();
    await translateStructured(document, options, cache, () => {}, abort().signal);
    const batches = provider.mock.calls.map(([, init]) => JSON.parse(String(init.body)).text as string[]);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
    expect(batches[2]).toHaveLength(1);
    expect(batches[2][0]).toContain('c'.repeat(4_000));
    expect(batches.every(batch => batch.length <= 4)).toBe(true);
    expect(Object.keys(cache.completed)).toHaveLength(document.blocks.length);
  });

  it('does not start a batch after cancellation or retry an uncertain network failure', async () => {
    const cancelled = abort(); cancelled.abort();
    await expect(translateStructured(fixture(), options, state(), () => {}, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider).toHaveBeenCalledTimes(0);
    provider.mockRejectedValue(new TypeError('network lost'));
    await expect(translateStructured(fixture(), options, state(), () => {}, abort().signal)).rejects.toThrow(/Não foi possível confirmar/);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

function request(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request('https://lume.test/api/translate-text', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', origin: 'https://lume.test', ...extraHeaders },
  });
}
const valid = { text: ['<p id="b1">The strain <eq id="m1">LUME_M1_PROTECTED</eq>.</p>'], source_lang: 'EN', target_lang: 'PT-BR', context: 'Polymer extrusion' };

function openAIResponse(translations = [{ id: 'b1', xml: '<p id="b1">A deformação <eq id="m1">LUME_M1_PROTECTED</eq>.</p>' }]) {
  return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify({ translations }) }] }] });
}

describe('GPT-6.1 Terra text proxy', () => {
  it('uses Responses with strict structured output and keeps provider credentials server-side', async () => {
    provider.mockResolvedValue(openAIResponse());
    const response = await translateText(request(valid));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translations: ['<p id="b1">A deformação <eq id="m1">LUME_M1_PROTECTED</eq>.</p>'] });
    const [url, init] = provider.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer test-openai-key');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'gpt-6.1-terra', store: false, reasoning: { effort: 'medium' }, max_output_tokens: 16_384,
      text: { format: { type: 'json_schema', name: 'document_translation', strict: true } } });
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.text.format.schema.properties.translations.items.properties.id.enum).toEqual(['b1']);
    expect(typeof body.instructions).toBe('string');
    expect(body.instructions.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.input)).toContain('LUME_M1_PROTECTED');
    expect(JSON.stringify(body)).not.toContain('test-openai-key');
    expect(body).not.toHaveProperty('tools');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('orders provider blocks by their IDs rather than the response order', async () => {
    provider.mockResolvedValue(openAIResponse([
      { id: 'b2', xml: '<p id="b2">Segundo.</p>' },
      { id: 'b1', xml: '<p id="b1">A deformação <eq id="m1">LUME_M1_PROTECTED</eq>.</p>' },
    ]));
    const response = await translateText(request({ ...valid, text: [...valid.text, '<p id="b2">Second.</p>'] }));
    expect(response.status).toBe(200);
    expect((await response.json()).translations).toEqual([
      '<p id="b1">A deformação <eq id="m1">LUME_M1_PROTECTED</eq>.</p>', '<p id="b2">Segundo.</p>',
    ]);
  });

  it('rejects invalid languages, oversized batches/context and obsolete or caller-controlled fields', async () => {
    const badRequests = [
      { ...valid, target_lang: 'BAD' }, { ...valid, source_lang: 'PT' },
      { ...valid, text: Array(9).fill('<p id="b1">x</p>') },
      { ...valid, context: 'a'.repeat(1_201) },
      { ...valid, glossary_id: '3c82cce0-c55e-4517-8e34-56cb7ce6f502' },
      { ...valid, model: 'some-other-model' }, { ...valid, tools: [] },
    ];
    for (const body of badRequests) expect((await translateText(request(body))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ['plain text', ['plain text']],
    ['duplicate block IDs', ['<p id="b1">First</p>', '<p id="b1">Second</p>']],
    ['unclosed XML', ['<p id="b1">Unclosed']],
    ['unsupported markup', ['<p id="b1"><script>ignored</script></p>']],
    ['empty text', []],
  ])('rejects malformed source: %s', async (_name, text) => {
    expect((await translateText(request({ ...valid, text }))).status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects non-JSON requests and oversized request bodies before invoking the model', async () => {
    const nonJson = request(valid); nonJson.headers.set('content-type', 'text/plain');
    expect((await translateText(nonJson)).status).toBe(400);
    const oversized = request({ ...valid, text: [`<p id="b1">${'x'.repeat(65_000)}</p>`] });
    expect((await translateText(oversized)).status).toBe(413);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ['missing block', []],
    ['unknown block', [{ id: 'unknown', xml: '<p id="unknown">Unexpected</p>' }]],
    ['duplicate block', [{ id: 'b1', xml: valid.text[0] }, { id: 'b1', xml: valid.text[0] }]],
    ['mismatched root ID', [{ id: 'b1', xml: valid.text[0].replace('id="b1"', 'id="b2"') }]],
    ['missing marker', [{ id: 'b1', xml: '<p id="b1">A deformação.</p>' }]],
    ['altered marker', [{ id: 'b1', xml: valid.text[0].replace('LUME_M1_PROTECTED', 'LUME_M1_CHANGED') }]],
    ['duplicated marker', [{ id: 'b1', xml: valid.text[0].replace('</eq>', '</eq><eq id="m1">LUME_M1_PROTECTED</eq>') }]],
  ])('rejects unsafe model output: %s', async (_name, translations) => {
    provider.mockResolvedValue(openAIResponse(translations));
    expect((await translateText(request(valid))).status).toBe(502);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete, refused and malformed Responses output without exposing its text', async () => {
    const responses = [
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
      { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'private refusal' }] }] },
      { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private invalid JSON' }] }] },
    ];
    for (const output of responses) {
      provider.mockResolvedValueOnce(Response.json(output));
      const response = await translateText(request(valid));
      expect([422, 502]).toContain(response.status);
      expect(await response.text()).not.toContain('private');
    }
  });

  it('distinguishes rate limits from exhausted quota without forwarding provider bodies', async () => {
    provider.mockResolvedValueOnce(Response.json({ error: { message: 'private text test-openai-key', code: 'rate_limit_exceeded', type: 'rate_limit_exceeded' } },
      { status: 429, headers: { 'Retry-After': '2' } }));
    const retry = await translateText(request(valid));
    expect(retry.status).toBe(429);
    expect(await retry.json()).toMatchObject({ retryable: true, retryAfterMs: 2_000 });
    provider.mockResolvedValueOnce(Response.json({ error: { message: 'private text test-openai-key', code: 'insufficient_quota', type: 'insufficient_quota' } }, { status: 429 }));
    const quota = await translateText(request(valid));
    expect(quota.status).toBe(429);
    const quotaBody = await quota.text();
    expect(quotaBody).not.toContain('private text');
    expect(quotaBody).not.toContain('test-openai-key');
    expect(JSON.parse(quotaBody).retryable).toBe(false);
  });

  it('preserves a longer provider Retry-After so the client does not retry too early', async () => {
    provider.mockResolvedValueOnce(Response.json({ error: { code: 'rate_limit_exceeded' } },
      { status: 429, headers: { 'Retry-After': '60' } }));
    const response = await translateText(request(valid));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ retryable: true, retryAfterMs: 60_000 });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized streamed body without waiting for cancellation cleanup', async () => {
    const cancelled = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4)); }, cancel: cancelled,
    }));
    await expect(readBounded(response, 2)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('handles a provider credential/access error %s without leaking secrets', async status => {
    provider.mockResolvedValueOnce(Response.json({ error: { message: 'private text test-openai-key' } }, { status }));
    const response = await translateText(request(valid));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain('private text');
    expect(body).not.toContain('test-openai-key');
  });

  it('does not mark a provider server failure for automatic retry', async () => {
    provider.mockResolvedValueOnce(Response.json({ error: { message: 'private text' } }, { status: 503 }));
    const response = await translateText(request(valid));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.json()).toMatchObject({ retryable: false });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('does not retry an uncertain network failure', async () => {
    provider.mockRejectedValueOnce(new Error('private text test-openai-key'));
    const response = await translateText(request(valid));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private text');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('returns a JSON timeout before the platform deadline without repeating the paid request', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    provider.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const pending = translateText(request(valid));
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    expect(timeout).toHaveBeenCalledWith(25_000);
    deadline.abort(new DOMException('private timeout', 'TimeoutError'));
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/tempo de resposta/), retryable: false });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('keeps the same deadline while reading the provider response body', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const cancelled = vi.fn();
    provider.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { status: 200 }));
    const pending = translateText(request(valid));
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    deadline.abort(new DOMException('private timeout', 'TimeoutError'));
    const response = await pending;
    expect(response.status).toBe(504);
    const result = await response.json();
    expect(result).toMatchObject({ error: expect.stringMatching(/tempo de resposta/), retryable: false });
    expect(result.error).not.toContain('private');
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
