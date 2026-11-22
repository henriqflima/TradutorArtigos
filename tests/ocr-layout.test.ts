import { describe, expect, it } from 'vitest';
import { blocksFromOcr, layoutFromOcr, ocrAssetId } from '../src/ocr-layout';
import { OCR_ENGINE, type OcrResult } from '../src/ocr-contract';
import { blockText, sha256, type DocumentAsset, type SourceRect } from '../src/structured-document';
import { createStructuredDocx, createStructuredPdf, validateStructuredSource } from '../src/structured-export';

function result(): OcrResult {
  return { model: OCR_ENGINE, usage: { pages: 1 }, page: { width: 1200, height: 1600, confidence: 98, blocks: [
    { type: 'title', x: 80, y: 70, width: 1040, height: 40, content: '# Scientific article', confidence: 99 },
    { type: 'text', x: 80, y: 140, width: 450, height: 200, content: 'Left column finishes before the right column.', confidence: 98 },
    { type: 'text', x: 650, y: 140, width: 450, height: 200, content: 'The relation $E = mc^2$ describes the sample.', confidence: 60 },
    { type: 'image', x: 80, y: 400, width: 450, height: 200, content: '', confidence: null },
    { type: 'caption', x: 80, y: 620, width: 450, height: 40, content: 'Figure 1. Original image.', confidence: 99 },
    { type: 'table', x: 80, y: 700, width: 1000, height: 200, content: '| A | B |', confidence: 95 },
    { type: 'equation', x: 80, y: 960, width: 450, height: 50, content: '$$F = ma$$', confidence: 98 },
  ] } };
}
function crop(id: string, rect: SourceRect, kind: DocumentAsset['kind'] = 'figure', sourceText?: DocumentAsset['sourceText']): DocumentAsset {
  return { id, rect, kind, page: 1, widthPt: rect.width, heightPt: rect.height,
    png: new Uint8Array(), dataUrl: '', sha256: '', alt: 'Original', ...(sourceText ? { sourceText } : {}) };
}
function fixture() {
  const layout = layoutFromOcr(result(), 600, 800);
  const assets = layout.regions.filter(r => ['image', 'table', 'equation'].includes(r.type))
    .map(r => crop(ocrAssetId(1, r.index), r.rect, r.type === 'image' ? 'figure' : r.type === 'table' ? 'table' : 'equation-block'));
  return { layout, assets };
}

describe('OCR block geometry and source preservation', () => {
  it('scales regions to PDF points and uses confidence without fabricating words or font sizes', () => {
    const { layout, assets } = fixture();
    expect(layout.regions[1].rect).toEqual({ x: 40, y: 70, width: 225, height: 100 });
    expect(layout.lowConfidenceBlocks).toBe(1);
    expect(layout.regions[0].text).toBe('Scientific article');
    const built = blocksFromOcr(layout, 1, assets);
    expect(built.blocks[1].fontSize).toBe(10);
    expect(built.blocks[1].geometry).toBe('block');
    expect(built.blocks[1].originalText).toBe(layout.regions[1].text);
  });
  it('keeps provider reading order even when columns share the same vertical position', () => {
    const { layout, assets } = fixture();
    expect(blocksFromOcr(layout, 1, assets).blocks.map(b => b.id)).toEqual([
      'p1-ocr-0', 'p1-ocr-1', 'p1-ocr-2', 'asset:auto-1-ocr-3', 'p1-ocr-4', 'asset:auto-1-ocr-5', 'asset:auto-1-ocr-6',
    ]);
  });
  it('preserves images, tables and display equations as exact source assets', () => {
    const { layout, assets } = fixture();
    const built = blocksFromOcr(layout, 1, assets);
    expect(built.blocks.filter(b => b.assetId).map(b => b.kind)).toEqual(['figure', 'table', 'equation']);
    expect(built.blocks.some(b => blockText(b).includes('F = ma'))).toBe(false);
    expect(built.issues.find(i => i.id === 'ocr-inline-math-p1-ocr-2')?.severity).toBe('warning');
  });
  it('allows recognized inline math through translation integrity checks without requiring a crop', async () => {
    const input = result();
    input.page.blocks = [input.page.blocks[2]];
    const layout = layoutFromOcr(input, 600, 800);
    const built = blocksFromOcr(layout, 1, []);
    expect(built.issues).toHaveLength(1);
    expect(built.issues[0]).toMatchObject({ id: 'ocr-inline-math-p1-ocr-0', severity: 'warning' });
    expect(blockText(built.blocks[0])).toBe('The relation $E = mc^2$ describes the sample.');
    const document = { version: 1 as const, sourceName: 'scan.pdf', sourceHash: 'source', sourceKind: 'pdf' as const,
      pages: [{ width: 600, height: 800 }], assets: [], blocks: built.blocks, issues: built.issues };
    await expect(validateStructuredSource(document)).resolves.toBeUndefined();
    // Source checks run before translation in a DOM-free environment. Mathematical
    // typesetting is exercised separately in the browser export fixture.
    expect(document.assets).toEqual([]);
    expect(blockText(document.blocks[0])).toContain('$E = mc^2$');
  });
  it('replaces only explicitly linked inline math and restores it when the crop is removed', () => {
    const { layout, assets } = fixture();
    const math = crop('inline', { x: 380, y: 85, width: 50, height: 10 }, 'equation-inline', { blockId: 'p1-ocr-2', text: '$E = mc^2$' });
    const built = blocksFromOcr(layout, 1, [...assets, math]);
    expect(built.blocks.find(b => b.id === 'p1-ocr-2')?.runs).toEqual([
      { type: 'text', text: 'The relation ' }, { type: 'asset', assetId: 'inline' }, { type: 'text', text: ' describes the sample.' },
    ]);
    expect(built.issues).toEqual([]);
    expect(blocksFromOcr(layout, 1, assets).issues.find(i => i.id.startsWith('ocr-inline-math'))?.severity).toBe('warning');
  });
  it('retains all prose and blocks an ambiguous partial crop rather than approximating character boxes', () => {
    const { layout, assets } = fixture();
    const extra = crop('partial', { x: 65, y: 100, width: 40, height: 10 }, 'equation-inline');
    const built = blocksFromOcr(layout, 1, [...assets, extra]);
    expect(blockText(built.blocks.find(b => b.id === 'p1-ocr-1')!)).toBe(layout.regions[1].text);
    expect(built.issues.some(i => i.id === 'ocr-partial-partial-p1-ocr-1' && i.severity === 'blocking')).toBe(true);
  });
  it('rejects missing, repeated, overlapping or misplaced text links without deleting prose', () => {
    const { layout, assets } = fixture();
    for (const math of [
      crop('bad', { x: 380, y: 85, width: 50, height: 10 }, 'equation-inline', { blockId: 'p1-ocr-2', text: 'absent' }),
      crop('bad', { x: 0, y: 0, width: 5, height: 5 }, 'equation-inline', { blockId: 'p1-ocr-2', text: '$E = mc^2$' }),
      crop('bad', { x: 380, y: 85, width: 50, height: 10 }, 'equation-inline', { blockId: 'unknown', text: '$E = mc^2$' }),
    ]) {
      const built = blocksFromOcr(layout, 1, [...assets, math]);
      expect(blockText(built.blocks.find(b => b.id === 'p1-ocr-2')!)).toBe(layout.regions[2].text);
      expect(built.issues.some(i => i.severity === 'blocking' && /vínculo|associado/.test(i.message))).toBe(true);
    }
    layout.regions[2].text = '$x$ and $x$';
    const repeated = crop('duplicate', layout.regions[2].rect, 'equation-inline', { blockId: 'p1-ocr-2', text: '$x$' });
    expect(blocksFromOcr(layout, 1, [...assets, repeated]).issues.some(i => i.id === 'ocr-link-duplicate')).toBe(true);
  });
  it('allows a whole text block to be preserved as a crop without also exporting its text', () => {
    const { layout, assets } = fixture();
    const whole = crop('whole', layout.regions[1].rect);
    const built = blocksFromOcr(layout, 1, [...assets, whole]);
    expect(built.blocks.some(b => b.id === 'p1-ocr-1')).toBe(false);
    expect(built.blocks.filter(b => b.assetId === 'whole')).toHaveLength(1);
  });
  it('keeps the uncovered part of a nearly complete block as prose requiring review', () => {
    const { layout, assets } = fixture();
    const original = layout.regions[1].rect;
    const crop96 = crop('nearly-all', { ...original, width: original.width * 0.96 });
    const built = blocksFromOcr(layout, 1, [...assets, crop96]);
    expect(blockText(built.blocks.find(b => b.id === 'p1-ocr-1')!)).toBe(layout.regions[1].text);
    expect(built.issues.some(i => i.id === 'ocr-partial-nearly-all-p1-ocr-1')).toBe(true);
  });
  it('preserves repeated inline formulas by explicitly chosen occurrence without removing their prose', () => {
    const { layout, assets } = fixture();
    layout.regions[2].text = 'The formula $x$ occurs twice: $x$.';
    const first = crop('first', { x: 380, y: 85, width: 20, height: 10 }, 'equation-inline', { blockId: 'p1-ocr-2', text: '$x$', occurrence: 1 });
    const second = crop('second', { x: 430, y: 105, width: 20, height: 10 }, 'equation-inline', { blockId: 'p1-ocr-2', text: '$x$', occurrence: 2 });
    const built = blocksFromOcr(layout, 1, [...assets, first, second]);
    expect(built.issues).toEqual([]);
    expect(built.blocks.find(b => b.id === 'p1-ocr-2')?.runs).toEqual([
      { type: 'text', text: 'The formula ' }, { type: 'asset', assetId: 'first' },
      { type: 'text', text: ' occurs twice: ' }, { type: 'asset', assetId: 'second' }, { type: 'text', text: '.' },
    ]);
  });
  it('blocks a removed recognized visual until its original region is preserved again', () => {
    const { layout, assets } = fixture();
    expect(blocksFromOcr(layout, 1, assets.slice(1)).issues.some(i => i.id === 'ocr-region-p1-ocr-3')).toBe(true);
    const replacement = crop('manual', layout.regions[3].rect);
    expect(blocksFromOcr(layout, 1, [...assets.slice(1), replacement]).issues.some(i => i.id === 'ocr-region-p1-ocr-3')).toBe(false);
  });
  it('does not invent confidence when the provider omits it', () => {
    const input = result(); input.page.confidence = null; input.page.blocks.forEach(b => { b.confidence = null; });
    const layout = layoutFromOcr(input, 600, 800);
    expect(layout.confidence).toBeNull(); expect(layout.lowConfidenceBlocks).toBe(0);
  });
  it('exports reviewed OCR prose and every linked original crop to DOCX and PDF', async () => {
    const { layout, assets } = fixture();
    assets.push(crop('inline', { x: 380, y: 85, width: 50, height: 10 }, 'equation-inline', { blockId: 'p1-ocr-2', text: '$E = mc^2$' }));
    for (const asset of assets) {
      asset.png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWAAAAABJRU5ErkJggg==', 'base64'));
      asset.sha256 = await sha256(asset.png);
    }
    const built = blocksFromOcr(layout, 1, assets);
    const document = { version: 1 as const, sourceName: 'scan.pdf', sourceHash: 'source', sourceKind: 'pdf' as const,
      pages: [{ width: 600, height: 800 }], assets, blocks: built.blocks, issues: built.issues };
    const translated = { document, blocks: Object.fromEntries(built.blocks.filter(b => !b.assetId).map(b => [b.id, b.runs])), sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
    expect((await createStructuredDocx(translated)).size).toBeGreaterThan(1000);
    expect((await createStructuredPdf(translated)).size).toBeGreaterThan(1000);
  });
});
