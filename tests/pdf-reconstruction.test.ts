import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { blocksFromOcr, ocrAssetId, ocrBlockId } from '../src/ocr-layout';
import { createStructuredPdf } from '../src/structured-export';
import { planPdfLayout, type PdfLayoutItem, type PdfLayoutReport } from '../src/pdf-layout';
import { blockText, sha256, type ContentRun, type DocumentAsset, type DocumentBlock, type SourceRect, type TranslatedDocument } from '../src/structured-document';

const A4 = { width: 595, height: 842 };
function text(id: string, value: string, rect: SourceRect, page = 1, kind: DocumentBlock['kind'] = 'paragraph'): DocumentBlock {
  return { id, kind, page, rect, runs: [{ type: 'text', text: value }], fontSize: kind === 'heading' ? 16 : 10, geometry: 'block' };
}
function documentFor(blocks: DocumentBlock[], assets: DocumentAsset[] = [], pages = [A4]): TranslatedDocument {
  return { document: { version: 1, sourceName: 'Layout regression', sourceHash: 'synthetic-layout', sourceKind: 'pdf', pages, blocks, assets, issues: [] },
    blocks: Object.fromEntries(blocks.filter(b => !b.assetId).map(b => [b.id, b.runs])), sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
}
function columns(): DocumentBlock[] {
  return [text('title', 'FULL_WIDTH_TITLE', { x: 42, y: 42, width: 511, height: 24 }, 1, 'heading'),
    text('left-a', 'LEFT_A Translation follows the article order.', { x: 42, y: 100, width: 238, height: 50 }),
    text('left-b', 'LEFT_B Paragraphs fill available column space.', { x: 42, y: 182, width: 238, height: 50 }),
    text('right-a', 'RIGHT_A Originally on the right, this paragraph now follows the text.', { x: 315, y: 100, width: 238, height: 50 }),
    text('right-b', 'RIGHT_B Reading order follows the source blocks.', { x: 315, y: 182, width: 238, height: 50 })];
}
async function pngAsset(id: string, rect: SourceRect, kind: DocumentAsset['kind']): Promise<DocumentAsset> {
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWAAAAABJRU5ErkJggg==', 'base64'));
  return { id, rect, kind, page: 1, widthPt: rect.width, heightPt: rect.height, png, dataUrl: '', sha256: await sha256(png), alt: id };
}
async function inspect(blob: Blob) {
  const task = getDocument({ data: new Uint8Array(await blob.arrayBuffer()), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is TextItem => 'str' in item && Boolean(item.str.trim()));
      const operators = await page.getOperatorList();
      let matrix = [1, 0, 0, 1, 0, 0];
      const stack: number[][] = [], images: SourceRect[] = [];
      const multiply = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
      operators.fnArray.forEach((fn, i) => {
        if (fn === OPS.save) stack.push([...matrix]);
        if (fn === OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        if (fn === OPS.transform) matrix = multiply(matrix, operators.argsArray[i] as number[]);
        if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
          const xs = [matrix[4], matrix[4] + matrix[0], matrix[4] + matrix[2], matrix[4] + matrix[0] + matrix[2]];
          const ys = [matrix[5], matrix[5] + matrix[1], matrix[5] + matrix[3], matrix[5] + matrix[1] + matrix[3]];
          images.push({ x: Math.min(...xs), y: viewport.height - Math.max(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
        }
      });
      pages.push({ width: viewport.width, height: viewport.height, items, images, text: items.map(item => item.str).join(' ') });
    }
    return pages;
  } finally { await task.destroy(); }
}
const itemWith = (items: TextItem[], value: string) => items.find(item => item.str.includes(value))!;
function expectNoOverlaps(pages: Awaited<ReturnType<typeof inspect>>) {
  for (const page of pages) {
    const rectangles = page.items.map(item => ({ x: item.transform[4], y: page.height - item.transform[5] - item.height * .8, width: item.width, height: item.height }));
    const all = [...rectangles, ...page.images];
    for (const rectangle of all) {
      expect(rectangle.x).toBeGreaterThanOrEqual(-.5);
      expect(rectangle.y).toBeGreaterThanOrEqual(-.5);
      expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(page.width + .5);
      expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(page.height + .5);
    }
    for (let first = 0; first < all.length; first++) for (let second = first + 1; second < all.length; second++) {
      const a = all[first], b = all[second];
      const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(x > .8 && y > 1, `Elements overlap on a reconstructed page: ${JSON.stringify({ a, b })}`).toBe(false);
    }
  }
}

describe('continuous PDF composition with source visual references', () => {
  it('starts a new format section when the original page dimensions change', async () => {
    const input = documentFor([
      text('a4', 'A4_ANCHOR', { x: 42, y: 70, width: 511, height: 25 }),
      text('letter', 'LETTER_ANCHOR', { x: 54, y: 85, width: 504, height: 25 }, 2),
    ], [], [A4, { width: 612, height: 792 }]);
    const pages = await inspect(await createStructuredPdf(input));
    expect(pages.map(page => [page.width, page.height])).toEqual([[595, 842], [612, 792]]);
    expect(itemWith(pages[0].items, 'A4_ANCHOR').transform[4]).toBeCloseTo(42, 0);
    expect(itemWith(pages[1].items, 'LETTER_ANCHOR').transform[4]).toBeCloseTo(54, 0);
  });

  it('places the spanning title before a continuous body without jumping to the original right column', async () => {
    const pages = await inspect(await createStructuredPdf(documentFor(columns())));
    expect(pages).toHaveLength(1);
    const left = itemWith(pages[0].items, 'LEFT_A'), right = itemWith(pages[0].items, 'RIGHT_A');
    expect(left.transform[4]).toBeCloseTo(42, 0);
    expect(right.transform[4]).toBeCloseTo(left.transform[4], 0);
    expect(right.transform[5]).toBeLessThan(left.transform[5]);
    const title = itemWith(pages[0].items, 'FULL_WIDTH_TITLE');
    expect(title.transform[5]).toBeGreaterThan(left.transform[5]);
    const textOrder = ['FULL_WIDTH_TITLE', 'LEFT_A', 'LEFT_B', 'RIGHT_A', 'RIGHT_B'].map(value => pages[0].text.indexOf(value));
    expect(textOrder.every(value => value >= 0)).toBe(true);
    expect(textOrder).toEqual([...textOrder].sort((a, b) => a - b));
    for (const item of pages[0].items) {
      if (/(?:LEFT|RIGHT)_[AB]/.test(item.str)) expect(item.transform[4] + item.width).toBeLessThanOrEqual(281);
    }
    expectNoOverlaps(pages);
  });

  it('reports simplified layout honestly when overlapping source boxes cannot be anchored safely', async () => {
    const input = documentFor([
      text('ambiguous-a', 'AMBIGUOUS_A The OCR boxes overlap.', { x: 42, y: 100, width: 511, height: 80 }),
      text('ambiguous-b', 'AMBIGUOUS_B Both paragraphs must remain readable.', { x: 42, y: 120, width: 511, height: 80 }),
    ]);
    let report: PdfLayoutReport | undefined;
    const pages = await inspect(await createStructuredPdf(input, undefined, undefined, value => { report = value; }));
    expect(report?.pages[0].mode).toBe('simplified');
    expect(report?.pages[0].warnings.length).toBeGreaterThan(0);
    expect(report?.pages[0].outputPages).toEqual([1]);
    expect(pages[0].text).toContain('AMBIGUOUS_A');
    expect(pages[0].text).toContain('AMBIGUOUS_B');
    expectNoOverlaps(pages);
  });

  it('uses advisory source font size and alignment without rewriting the source or translated runs', async () => {
    const block = text('appearance', 'CENTERED_APPEARANCE', { x: 42, y: 100, width: 511, height: 28 });
    block.appearance = { fontSize: 13, fontFamily: 'sans-serif', alignment: 'center', bold: true, confidence: 'native' };
    const input = documentFor([block]), before = JSON.stringify(input);
    const pages = await inspect(await createStructuredPdf(input)), item = itemWith(pages[0].items, 'CENTERED_APPEARANCE');
    expect(item.transform[4] + item.width / 2).toBeCloseTo(42 + 511 / 2, 0);
    expect(Math.hypot(item.transform[2], item.transform[3])).toBeCloseTo(13, 1);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('measures a following full-width figure at its spanning width when keeping a column heading with it', () => {
    const input = documentFor([]);
    const measuredWidths: number[] = [];
    const items: PdfLayoutItem[] = [
      { id: 'left', page: 1, kind: 'paragraph', rect: { x: 42, y: 100, width: 238, height: 450 }, measure: () => ({ heights: [20], gapAfter: 5 }) },
      { id: 'right', page: 1, kind: 'paragraph', rect: { x: 315, y: 100, width: 238, height: 450 }, measure: () => ({ heights: Array(48).fill(12), gapAfter: 5 }) },
      { id: 'figure-heading', page: 1, kind: 'heading', widthMode: 'page', rect: { x: 315, y: 640, width: 238, height: 20 }, keepWithNext: true, measure: () => ({ heights: [20], gapAfter: 6 }) },
      { id: 'full-width-figure', page: 1, kind: 'figure', widthMode: 'page', rect: { x: 42, y: 680, width: 511, height: 100 }, measure: width => {
        measuredWidths.push(width); return { heights: [100 * Math.min(1, width / 511)], atomic: true, gapAfter: 5 };
      } },
    ];
    const plan = planPdfLayout(input.document, items);
    expect(plan.report.pages[0].mode).toBe('flow');
    expect(measuredWidths).toContain(511);
    expect(plan.placements.find(p => p.id === 'full-width-figure')?.regionWidth).toBe(511);
    expect(plan.placements.find(p => p.id === 'figure-heading')?.pageIndex).toBe(plan.placements.find(p => p.id === 'full-width-figure')?.pageIndex);
  });

  it('does not restore old vertical anchors between bands on a continuation page', () => {
    const input = documentFor([]);
    const items: PdfLayoutItem[] = [
      { id: 'left', page: 1, kind: 'paragraph', rect: { x: 42, y: 100, width: 238, height: 500 }, measure: () => ({ heights: [20], gapAfter: 5 }) },
      { id: 'right', page: 1, kind: 'paragraph', rect: { x: 315, y: 100, width: 238, height: 500 }, measure: () => ({ heights: Array(130).fill(12), gapAfter: 5 }) },
      { id: 'continued-heading', page: 1, kind: 'heading', rect: { x: 42, y: 640, width: 511, height: 20 }, keepWithNext: true, measure: () => ({ heights: [20], gapAfter: 6 }) },
      { id: 'following-band', page: 1, kind: 'paragraph', rect: { x: 42, y: 680, width: 511, height: 100 }, measure: () => ({ heights: [20], gapAfter: 5 }) },
    ];
    const plan = planPdfLayout(input.document, items);
    const heading = plan.placements.find(p => p.id === 'continued-heading')!, following = plan.placements.find(p => p.id === 'following-band')!;
    expect(heading.pageIndex).toBeGreaterThan(0);
    expect(following.pageIndex).toBe(heading.pageIndex);
    expect(following.rect.y - heading.rect.y - heading.rect.height).toBeLessThanOrEqual(10);
  });

  it('keeps a full-width figure and caption together with original proportions while the body flows', async () => {
    const asset = await pngAsset('wide-figure', { x: 42, y: 320, width: 511, height: 90 }, 'figure');
    const visual: DocumentBlock = { id: 'figure', kind: 'figure', page: 1, rect: asset.rect, runs: [], assetId: asset.id, captionId: 'caption', fontSize: 10 };
    const input = documentFor([...columns(), visual,
      text('caption', 'FIGURE_CAPTION A full width figure.', { x: 42, y: 418, width: 511, height: 22 }, 1, 'caption'),
      text('below-left', 'BELOW_LEFT Content below the spanning figure.', { x: 42, y: 490, width: 238, height: 45 }),
      text('below-right', 'BELOW_RIGHT Second column below the figure.', { x: 315, y: 490, width: 238, height: 45 }),
    ], [asset]);
    const pages = await inspect(await createStructuredPdf(input));
    expect(pages).toHaveLength(1);
    expect(pages[0].images).toHaveLength(1);
    const image = pages[0].images[0], caption = itemWith(pages[0].items, 'FIGURE_CAPTION');
    expect(image.x).toBeCloseTo(42, 0);
    expect(image.width).toBeCloseTo(511, 0);
    expect(image.width / image.height).toBeCloseTo(511 / 90, 3);
    expect(pages[0].height - caption.transform[5]).toBeGreaterThan(image.y + image.height);
    for (const marker of ['BELOW_LEFT', 'BELOW_RIGHT']) expect(pages[0].text.match(new RegExp(marker, 'g'))).toHaveLength(1);
    expectNoOverlaps(pages);
  });

  it('continues expanded translations without losing or duplicating any token or drawing outside a page', async () => {
    const input = documentFor(columns());
    const tokens = Array.from({ length: 700 }, (_, i) => `stress_${String(i).padStart(4, '0')}`);
    input.blocks['left-a'] = [{ type: 'text', text: tokens.join(' ') }];
    const pages = await inspect(await createStructuredPdf(input));
    expect(pages.length).toBeGreaterThan(1);
    const output = pages.map(page => page.text).join(' ');
    expect(output.match(/stress_\d{4}/g)).toEqual(tokens);
    for (const page of pages) for (const item of page.items) {
      expect(item.transform[4]).toBeGreaterThanOrEqual(0);
      expect(item.transform[4] + item.width).toBeLessThanOrEqual(page.width + 0.5);
      expect(item.transform[5]).toBeGreaterThanOrEqual(0);
      expect(item.transform[5] + item.height).toBeLessThanOrEqual(page.height + 0.5);
      expect(Math.hypot(item.transform[2], item.transform[3])).toBeGreaterThanOrEqual(8);
    }
    expectNoOverlaps(pages);
  });

  it('keeps the complete figure-caption pair together after a translated paragraph overflows', async () => {
    const asset = await pngAsset('late-figure', { x: 42, y: 600, width: 511, height: 140 }, 'figure');
    const visual: DocumentBlock = { id: 'figure', kind: 'figure', page: 1, rect: asset.rect, runs: [], assetId: asset.id, captionId: 'caption', fontSize: 10 };
    const input = documentFor([...columns(), visual,
      text('caption', 'CAPTION_AFTER_OVERFLOW This caption must stay with the complete figure even when previous text expands.', { x: 42, y: 750, width: 511, height: 30 }, 1, 'caption'),
    ], [asset]);
    input.blocks['left-a'] = [{ type: 'text', text: 'Expanded translation preserves every sentence and figure. '.repeat(160) }];
    const pages = await inspect(await createStructuredPdf(input));
    expect(pages.length).toBeGreaterThan(1);
    const imagePage = pages.findIndex(page => page.images.length > 0), captionPage = pages.findIndex(page => page.text.includes('CAPTION_AFTER_OVERFLOW'));
    expect(imagePage).toBeGreaterThanOrEqual(0);
    expect(captionPage).toBe(imagePage);
    expect(pages.flatMap(page => page.images)).toHaveLength(1);
    expectNoOverlaps(pages);
  });

  it('moves a numbered OCR text caption with its off-center figure onto a continuation page', async () => {
    const sourceRegions = columns().map((block, index) => ({ index, rect: block.rect,
      type: block.kind === 'heading' ? 'title' : 'text', text: blockText(block), confidence: 99 }));
    const figureIndex = sourceRegions.length, captionIndex = figureIndex + 1;
    const asset = await pngAsset(ocrAssetId(1, figureIndex), { x: 154, y: 620, width: 110, height: 145 }, 'figure');
    const recognized = blocksFromOcr({ model: 'ocr-v1', confidence: 99, usableCharacters: 300, lowConfidenceBlocks: 0,
      regions: [...sourceRegions,
        { index: figureIndex, type: 'image', rect: asset.rect, text: '', confidence: null },
        { index: captionIndex, type: 'text', rect: { x: 42, y: 771, width: 238, height: 19 }, text: 'Fig. 1. Typical sheet extrusion system.', confidence: 99 },
      ] }, 1, [asset]);
    const captionId = ocrBlockId(1, captionIndex);
    expect(recognized.blocks.find(block => block.assetId === asset.id)?.captionId).toBe(captionId);
    expect(recognized.blocks.find(block => block.id === captionId)?.kind).toBe('caption');

    const input = documentFor(recognized.blocks, [asset]);
    input.blocks[ocrBlockId(1, 1)] = [{ type: 'text', text: 'O texto traduzido ocupa mais linhas na coluna do artigo. '.repeat(160) }];
    input.blocks[captionId] = [{ type: 'text', text: 'Figura 1. Sistema típico de extrusão de chapas.' }];
    const pages = await inspect(await createStructuredPdf(input));
    const imagePage = pages.findIndex(page => page.images.length > 0);
    expect(imagePage).toBeGreaterThan(0);
    const page = pages[imagePage], image = page.images[0], caption = itemWith(page.items, 'Figura 1.');
    expect(caption).toBeDefined();
    const gapToCaptionBaseline = page.height - caption.transform[5] - image.y - image.height;
    expect(gapToCaptionBaseline).toBeGreaterThan(0);
    expect(gapToCaptionBaseline).toBeLessThan(24);
    expect(pages.flatMap(entry => entry.images)).toHaveLength(1);
    expect(pages.map(entry => entry.text).join(' ').match(/Figura 1\./g)).toHaveLength(1);
    expectNoOverlaps(pages);
  });

  it('fills remaining space with following text while a large figure waits for the next page', async () => {
    const asset = await pngAsset('deferred-figure', { x: 42, y: 500, width: 511, height: 300 }, 'figure');
    const figure: DocumentBlock = { id: 'figure', kind: 'figure', page: 1, rect: asset.rect, runs: [], assetId: asset.id, captionId: 'caption', fontSize: 10 };
    const input = documentFor([
      text('lead', 'LEAD_START ' + 'flow '.repeat(1100) + 'LEAD_END', { x: 42, y: 60, width: 511, height: 420 }),
      figure,
      text('caption', 'DEFERRED_CAPTION The complete graph remains linked to this caption.', { x: 42, y: 808, width: 511, height: 25 }, 1, 'caption'),
      text('tail', 'TAIL_START ' + 'following text '.repeat(20) + 'TAIL_END', { x: 42, y: 60, width: 511, height: 50 }, 2),
    ], [asset], [A4, A4]);
    let report: PdfLayoutReport | undefined;
    const pages = await inspect(await createStructuredPdf(input, undefined, undefined, value => { report = value; }));
    const leadEndPage = pages.findIndex(page => page.text.includes('LEAD_END'));
    const tailPage = pages.findIndex(page => page.text.includes('TAIL_START'));
    const figurePage = pages.findIndex(page => page.images.length > 0);
    expect(leadEndPage).toBeGreaterThanOrEqual(0);
    expect(tailPage).toBe(leadEndPage);
    expect(figurePage).toBeGreaterThan(tailPage);
    expect(pages[figurePage].text).toContain('DEFERRED_CAPTION');
    expect(report?.pages.find(page => page.sourcePage === 2)?.outputPages).toContain(tailPage + 1);
    const output = pages.map(page => page.text).join(' ');
    for (const marker of ['LEAD_START', 'LEAD_END', 'TAIL_START', 'TAIL_END', 'DEFERRED_CAPTION']) expect(output.match(new RegExp(marker, 'g'))).toHaveLength(1);
    expect(output.match(/\bflow\b/g)).toHaveLength(1100);
    expect(pages.flatMap(page => page.images)).toHaveLength(1);
    expectNoOverlaps(pages);
  });

  it('preserves an explicitly linked caption above its figure', async () => {
    const asset = await pngAsset('caption-above-figure', { x: 42, y: 220, width: 511, height: 140 }, 'figure');
    const visual: DocumentBlock = { id: 'figure', kind: 'figure', page: 1, rect: asset.rect, runs: [], assetId: asset.id, captionId: 'caption-above', fontSize: 10 };
    const input = documentFor([
      text('intro', 'INTRO_ABOVE An introductory paragraph.', { x: 42, y: 80, width: 511, height: 40 }),
      text('caption-above', 'CAPTION_ABOVE This caption belongs above the figure.', { x: 42, y: 190, width: 511, height: 20 }, 1, 'caption'),
      visual,
      text('after', 'AFTER_FIGURE The article continues below.', { x: 42, y: 400, width: 511, height: 40 }),
    ], [asset]);
    const pages = await inspect(await createStructuredPdf(input));
    expect(pages).toHaveLength(1);
    const caption = itemWith(pages[0].items, 'CAPTION_ABOVE'), image = pages[0].images[0];
    expect(pages[0].height - caption.transform[5]).toBeLessThan(image.y);
    expect(pages[0].text.indexOf('CAPTION_ABOVE')).toBeLessThan(pages[0].text.indexOf('AFTER_FIGURE'));
    expectNoOverlaps(pages);
  });

  it('keeps inline preserved equations in the translated sentence rather than at absolute source coordinates', async () => {
    const asset = await pngAsset('inline-equation', { x: 200, y: 100, width: 18, height: 11 }, 'equation-inline');
    asset.baselineOffsetPt = -2;
    const runs: ContentRun[] = [{ type: 'text', text: 'BEFORE ' }, { type: 'asset', assetId: asset.id }, { type: 'text', text: ' AFTER' }];
    const block = { ...text('inline', '', { x: 42, y: 100, width: 238, height: 30 }), runs };
    const input = documentFor([block], [asset]);
    const originalHash = asset.sha256;
    const pages = await inspect(await createStructuredPdf(input));
    expect(pages).toHaveLength(1);
    expect(pages[0].images).toHaveLength(1);
    const before = itemWith(pages[0].items, 'BEFORE'), after = itemWith(pages[0].items, 'AFTER'), image = pages[0].images[0];
    expect(image.x).toBeGreaterThan(before.transform[4]);
    expect(image.x + image.width).toBeLessThanOrEqual(after.transform[4] + 0.5);
    expect(Math.abs(before.transform[5] - after.transform[5])).toBeLessThan(0.5);
    expectNoOverlaps(pages);
    expect(await sha256(asset.png)).toBe(originalHash);
    const loaded = await PDFDocument.load(await (await createStructuredPdf(input)).arrayBuffer());
    expect(loaded.getPage(0).getWidth()).toBe(A4.width);
  });
});
