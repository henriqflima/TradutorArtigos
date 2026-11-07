import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { createStructuredPdf } from '../src/structured-export';
import type { PdfLayoutReport } from '../src/pdf-layout';
import type { SourceRect } from '../src/structured-document';
import { DENSE_COLUMN, DENSE_LEFT, DENSE_PAGE, DENSE_RIGHT, denseFixture } from './pdf-dense-fixture';

async function inspect(blob: Blob) {
  const task = getDocument({ data: new Uint8Array(await blob.arrayBuffer()), useSystemFonts: true });
  try {
    const pdf = await task.promise, pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), text = await page.getTextContent(), operators = await page.getOperatorList();
      const items = text.items.filter((item): item is TextItem => 'str' in item && Boolean(item.str.trim()));
      const boxes: SourceRect[] = items.map(item => ({ x: item.transform[4], y: page.view[3] - item.transform[5] - item.height * .8, width: item.width, height: item.height }));
      let matrix = [1, 0, 0, 1, 0, 0]; const stack: number[][] = [];
      const multiply = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
      operators.fnArray.forEach((fn, index) => {
        if (fn === OPS.save) stack.push([...matrix]);
        else if (fn === OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        else if (fn === OPS.transform) matrix = multiply(matrix, operators.argsArray[index] as number[]);
        else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) boxes.push({ x: matrix[4], y: DENSE_PAGE.height - matrix[5] - matrix[3], width: Math.abs(matrix[0]), height: Math.abs(matrix[3]) });
      });
      pages.push({ items, boxes, text: items.map(item => item.str).join(' ') });
    }
    return pages;
  } finally { await task.destroy(); }
}
function safeBoxes(pages: Awaited<ReturnType<typeof inspect>>) {
  for (const [number, page] of pages.entries()) for (let index = 0; index < page.boxes.length; index++) {
    const a = page.boxes[index];
    expect(a.x, `Page ${number + 1} left`).toBeGreaterThanOrEqual(-.5); expect(a.y).toBeGreaterThanOrEqual(-.5);
    expect(a.x + a.width).toBeLessThanOrEqual(DENSE_PAGE.width + .5); expect(a.y + a.height).toBeLessThanOrEqual(DENSE_PAGE.height + .5);
    for (const b of page.boxes.slice(index + 1)) {
      const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(dx > .8 && dy > 1, `Page ${number + 1}: overlapping text/figure ${JSON.stringify({ a, b })}`).toBe(false);
    }
  }
}
const markers = Array.from({ length: 5 }, (_, i) => `DENSE_LEFT_${i + 1}`).concat(Array.from({ length: 4 }, (_, i) => `DENSE_RIGHT_${i + 1}`));
function allMarkers(pages: Awaited<ReturnType<typeof inspect>>) {
  const output = pages.map(page => page.text).join(' ');
  for (const marker of markers) for (const suffix of ['BEGIN', 'END']) expect(output.match(new RegExp(`${marker}_${suffix}`, 'g'))?.length, `${marker}_${suffix}`).toBe(1);
}

describe('dense scientific article distribution', () => {
  it('fills a dense article using readable fixed typography when the translation grows', async () => {
    const fixture = await denseFixture();
    expect(fixture.sourceWords).toBeGreaterThan(700); expect(fixture.sourceWords).toBeLessThan(1000);
    expect(fixture.translatedWords / fixture.sourceWords).toBeGreaterThan(1.1); expect(fixture.translatedWords / fixture.sourceWords).toBeLessThan(1.2);
    let report: PdfLayoutReport | undefined;
    const pages = await inspect(await createStructuredPdf(fixture.input, undefined, undefined, value => { report = value; }));
    expect(report?.pages[0].columns).toBe(2);
    expect(report?.pages[0].mode).toBe('flow');
    // The translated text needs more lines at its original 9.5pt size; a final continuation is legitimate.
    expect(pages.length).toBeLessThanOrEqual(2);
    allMarkers(pages); safeBoxes(pages);
    const body = pages[0].items.filter(item => item.str.includes('DENSE_'));
    expect(body.some(item => Math.abs(item.transform[4] - DENSE_LEFT) < 1)).toBe(true);
    expect(body.some(item => Math.abs(item.transform[4] - DENSE_RIGHT) < 1)).toBe(true);
    for (const item of body) expect(Math.hypot(item.transform[2], item.transform[3])).toBeCloseTo(9.5, 1);
    if (pages.length > 1) {
      const rightColumn = pages[0].items.filter(item => Math.abs(item.transform[4] - DENSE_RIGHT) < 1 && Math.abs(item.height - 9.5) < .01);
      expect(Math.min(...rightColumn.map(item => item.transform[5]))).toBeLessThan(110);
    }
  });

  it('does not add a continuation when the dense content fits without reducing typography', async () => {
    const fixture = await denseFixture({ hardBreaks: false });
    for (const block of fixture.input.document.blocks) {
      if (/^dense-(?:left|right)-\d$/u.test(block.id)) fixture.input.blocks[block.id] = structuredClone(block.runs);
    }
    const pages = await inspect(await createStructuredPdf(fixture.input));
    expect(pages).toHaveLength(1);
    allMarkers(pages); safeBoxes(pages);
    for (const item of pages[0].items.filter(item => item.str.includes('DENSE_'))) {
      expect(Math.hypot(item.transform[2], item.transform[3])).toBeCloseTo(9.5, 1);
    }
  });

  it('retains reliable columns when one running header touches the paper edge', async () => {
    const fixture = await denseFixture({ noisyHeader: true, hardBreaks: false });
    let report: PdfLayoutReport | undefined;
    const pages = await inspect(await createStructuredPdf(fixture.input, undefined, undefined, value => { report = value; }));
    expect(report?.pages[0].columns).toBe(2);
    allMarkers(pages); safeBoxes(pages);
    const body = pages.flatMap(page => page.items).filter(item => /DENSE_(?:LEFT|RIGHT)_\d/.test(item.str));
    for (const item of body) {
      expect(Math.min(Math.abs(item.transform[4] - DENSE_LEFT), Math.abs(item.transform[4] - DENSE_RIGHT))).toBeLessThan(1);
      expect(item.width).toBeLessThanOrEqual(DENSE_COLUMN + 1);
      expect(Math.hypot(item.transform[2], item.transform[3])).toBeCloseTo(9.5, 1);
    }
  });

  it('keeps flowing after a continued heading instead of restoring a large obsolete source gap', async () => {
    const fixture = await denseFixture({ hardBreaks: false });
    fixture.input.blocks['dense-left-1'] = [{ type: 'text', text: fixture.input.blocks['dense-left-1'].map(run => run.type === 'text' ? run.text : '').join('') + ' Additional measurement and consistent material response.'.repeat(190) }];
    const pages = await inspect(await createStructuredPdf(fixture.input));
    expect(pages.length).toBeGreaterThan(1); allMarkers(pages); safeBoxes(pages);
    // Intermediate pages should keep filling; the final page may legitimately end with a short remainder.
    for (const page of pages.slice(1, -1)) expect(page.items.filter(item => item.str.trim()).length).toBeGreaterThan(6);
    const headingPage = pages.findIndex(page => page.text.includes('2. Resultados e discussão'));
    const followingPage = pages.findIndex(page => page.text.includes('DENSE_RIGHT_1_BEGIN'));
    expect(headingPage).toBeGreaterThanOrEqual(0);
    expect(followingPage).toBe(headingPage);
  });
});
