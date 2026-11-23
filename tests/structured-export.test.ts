import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { createStructuredDocx, createStructuredPdf, validateStructuredSource } from '../src/structured-export';
import { sha256, type DocumentAsset, type TranslatedDocument } from '../src/structured-document';

async function fixture(): Promise<TranslatedDocument> {
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWAAAAABJRU5ErkJggg==', 'base64'));
  const asset: DocumentAsset = { id: 'symbol-1', kind: 'equation-inline', page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, widthPt: 10, heightPt: 10, png, dataUrl: '', sha256: await sha256(png), alt: 'Φ' };
  const runs = [{ type: 'text' as const, text: 'Pressão & extrusão < científica > ' }, { type: 'asset' as const, assetId: asset.id }, { type: 'text' as const, text: ' termina.' }];
  return { document: { version: 1, sourceName: 'Artigo teste', sourceHash: 'source', sourceKind: 'pdf', pages: [{ width: 612, height: 792 }], blocks: [{ id: 'p1', kind: 'paragraph', page: 1, rect: { x: 0, y: 0, width: 100, height: 20 }, runs, fontSize: 10 }], assets: [asset], issues: [] }, blocks: { p1: runs }, sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
}
describe('structured exports', () => {
  it('embeds exact source PNG bytes, editable escaped text and traceable block bookmarks', async () => {
    const input = await fixture(), output = await createStructuredDocx(input);
    const zip = await JSZip.loadAsync(await output.arrayBuffer());
    const text = await zip.file('word/document.xml')!.async('string');
    expect(text.includes('Pressão &amp; extrusão &lt; científica &gt;')).toBe(true);
    expect(text.includes('w:name="lume_block_1"')).toBe(true);
    expect(text.includes('descr="Φ"')).toBe(true);
    expect(await sha256(await zip.file('word/media/preserved-1.png')!.async('uint8array'))).toBe(input.document.assets[0].sha256);
    expect((await zip.file('customXml/item1.xml')!.async('string')).includes('bookmark="lume_block_1" id="p1"')).toBe(true);
    expect(input.blocks.p1[0]).toEqual({ type: 'text', text: 'Pressão & extrusão < científica > ' });
  });
  it('produces a valid PDF with text and accepts PT accents', async () => {
    const output = await createStructuredPdf(await fixture());
    const pdf = await PDFDocument.load(await output.arrayBuffer());
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Artigo teste');
    expect(pdf.getPage(0).getWidth()).toBe(612);
  });
  it('allows protected objects to change sentence position while retaining every occurrence', async () => {
    const input = await fixture();
    input.document.blocks[0].runs.push({ type: 'asset', assetId: 'symbol-1' });
    input.blocks.p1 = [{ type: 'asset', assetId: 'symbol-1' }, { type: 'asset', assetId: 'symbol-1' }, { type: 'text', text: 'Tradução.' }];
    expect((await createStructuredDocx(input)).size > 0).toBe(true);
    input.blocks.p1.pop(); input.blocks.p1.push({ type: 'text', text: '' });
    await expect(createStructuredDocx(input)).rejects.toThrow(/vazia/);
  });
  it('rejects missing or duplicated protected objects and missing text', async () => {
    const input = await fixture();
    input.blocks.p1 = [{ type: 'text', text: 'Fórmula perdida.' }];
    await expect(createStructuredDocx(input)).rejects.toThrow(/objetos protegidos/);
    input.blocks.p1 = [...input.document.blocks[0].runs, { type: 'asset', assetId: 'symbol-1' }];
    await expect(createStructuredPdf(input)).rejects.toThrow(/objetos protegidos/);
    delete input.blocks.p1;
    await expect(createStructuredDocx(input)).rejects.toThrow(/ausente/);
  });
  it('refuses altered source pixels, blocking issues, invalid XML text and unsupported PDF characters', async () => {
    const input = await fixture();
    input.document.assets[0].sha256 = 'wrong';
    await expect(createStructuredDocx(input)).rejects.toThrow(/alterada/);
    input.document.assets[0].sha256 = await sha256(input.document.assets[0].png);
    input.document.issues.push({ id: 'i1', page: 1, severity: 'blocking', message: 'OCR obrigatório' });
    await expect(createStructuredPdf(input)).rejects.toThrow(/OCR obrigatório/);
    input.document.issues = [];
    input.blocks.p1 = [{ type: 'text', text: '🧪' }, { type: 'asset', assetId: 'symbol-1' }];
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(new URL('../src/fonts/' + url.split('/').at(-1)!.split('?')[0], import.meta.url))));
    try { await expect(createStructuredPdf(input)).rejects.toThrow(/U\+1F9EA/); }
    finally { vi.unstubAllGlobals(); }
    input.blocks.p1 = [{ type: 'text', text: '\u0001' }, { type: 'asset', assetId: 'symbol-1' }];
    await expect(createStructuredDocx(input)).rejects.toThrow(/caracteres inválidos/);
  });
  it('groups a figure with its caption and maps both actual bookmarks', async () => {
    const input = await fixture();
    input.document.assets[0].kind = 'figure';
    input.document.blocks = [{ ...input.document.blocks[0], id: 'f1', kind: 'figure', assetId: 'symbol-1', captionId: 'c1', runs: [] }, { ...input.document.blocks[0], id: 'c1', kind: 'caption', runs: [{ type: 'text', text: 'Figura 1. Legenda.' }] }];
    input.blocks = { c1: input.document.blocks[1].runs };
    const zip = await JSZip.loadAsync(await (await createStructuredDocx(input)).arrayBuffer());
    const text = await zip.file('word/document.xml')!.async('string');
    expect(text.includes('<w:keepNext/>')).toBe(true);
    expect(text.includes('w:val="Caption"')).toBe(true);
    const trace = await zip.file('customXml/item1.xml')!.async('string');
    expect(trace.includes('bookmark="lume_block_1" id="f1"')).toBe(true);
    expect(trace.includes('bookmark="lume_block_2" id="c1"')).toBe(true);
  });
  it('keeps a caption above its drawing on the same Word page', async () => {
    const input = await fixture();
    const asset = input.document.assets[0], original = input.document.blocks[0];
    asset.kind = 'figure';
    asset.rect = { ...asset.rect, x: 42, y: 100 };
    const runs = [{ type: 'text' as const, text: 'Figura 1. Legenda acima da figura.' }];
    input.document.blocks = [
      { ...original, id: 'figure', kind: 'figure', rect: asset.rect, assetId: asset.id, captionId: 'caption', runs: [] },
      { ...original, id: 'caption', kind: 'caption', rect: { x: 42, y: 75, width: 100, height: 15 }, runs },
    ];
    input.blocks = { caption: runs };

    const zip = await JSZip.loadAsync(await (await createStructuredDocx(input)).arrayBuffer());
    const text = await zip.file('word/document.xml')!.async('string');
    const paragraphs = text.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain('Figura 1. Legenda acima da figura.');
    expect(paragraphs[0]).toContain('<w:keepNext/>');
    expect(paragraphs[1]).toContain('<w:drawing>');
    expect(text.match(/Figura 1\. Legenda acima da figura\./g)).toHaveLength(1);
  });
  it('supports cancellation before export', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createStructuredDocx(await fixture(), undefined, controller.signal)).rejects.toThrow(/cancelada/);
  });
  it('embeds Unicode fonts for author names and scientific letters without dropping them', async () => {
    const input = await fixture();
    input.blocks.p1 = [{ type: 'text', text: 'Zaı¨ri · μ · ação e pressão' }, { type: 'asset', assetId: 'symbol-1' }];
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(new URL('../src/fonts/' + url.split('/').at(-1)!.split('?')[0], import.meta.url))));
    try {
      const pdf = await PDFDocument.load(await (await createStructuredPdf(input)).arrayBuffer());
      expect(pdf.getPageCount()).toBe(1);
      expect(pdf.getPage(0).node.Resources()?.toString().includes('Font')).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('validates the source without creating an artifact and catches orphan images before translation', async () => {
    const input = await fixture();
    expect(await validateStructuredSource(input.document)).toBe(undefined);
    input.document.assets.push({ ...input.document.assets[0], id: 'orphan' });
    await expect(validateStructuredSource(input.document)).rejects.toThrow(/não possui posição/);
  });
  it('rejects a caption assigned to two figures before translation', async () => {
    const input = await fixture();
    const original = input.document.blocks[0];
    input.document.assets[0].kind = 'figure';
    input.document.assets.push({ ...input.document.assets[0], id: 'figure-2' });
    input.document.blocks = [{ ...original, id: 'figure-1', kind: 'figure', assetId: 'symbol-1', captionId: 'caption', runs: [] }, { ...original, id: 'figure-2', kind: 'figure', assetId: 'figure-2', captionId: 'caption', runs: [] }, { ...original, id: 'caption', kind: 'caption', runs: [{ type: 'text', text: 'Figura 1. Legenda.' }] }];
    await expect(validateStructuredSource(input.document)).rejects.toThrow(/Associação de legenda inválida/);
  });
});
