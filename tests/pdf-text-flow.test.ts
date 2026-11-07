import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { normalizePdfTextRuns } from '../src/pdf-renderer';
import { createStructuredPdf } from '../src/structured-export';
import type { ContentRun, DocumentBlock, TranslatedDocument } from '../src/structured-document';

function block(value: string, change: Partial<DocumentBlock> = {}): DocumentBlock {
  return { id: 'body', page: 1, kind: 'paragraph', geometry: 'block', rect: { x: 40, y: 80, width: 520, height: 72 },
    fontSize: 10, runs: [{ type: 'text', text: value }], ...change };
}
function input(source: DocumentBlock, target = source.runs): TranslatedDocument {
  return { document: { version: 1, sourceName: 'Text flow regression', sourceHash: 'text-flow', sourceKind: 'pdf',
    pages: [{ width: 600, height: 800 }], blocks: [source], assets: [], issues: [] },
    blocks: { [source.id]: target }, sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
}
async function inspect(value: TranslatedDocument) {
  const task = getDocument({ data: new Uint8Array(await (await createStructuredPdf(value)).arrayBuffer()), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const pages: TextItem[][] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      pages.push(content.items.filter((item): item is TextItem => 'str' in item && Boolean(item.str.trim())));
    }
    return pages;
  } finally { await task.destroy(); }
}
const baselines = (items: TextItem[]) => [...new Set(items.map(item => Math.round(item.transform[5] * 100) / 100))].sort((a, b) => b - a);
const text = (runs: ContentRun[]) => runs.map(run => run.type === 'text' ? run.text : '[asset]').join('');

describe('PDF prose flow and measured density', () => {
  it('joins source wrapping across styled runs without moving inline protected markers or mutating runs', () => {
    const runs: ContentRun[] = [{ type: 'text', text: 'A long original\n', style: { bold: true } },
      { type: 'text', text: 'paragraph includes ' }, { type: 'asset', assetId: 'equation' },
      { type: 'text', text: '\nand keeps its meaning.' }];
    const before = structuredClone(runs);
    const normalized = normalizePdfTextRuns(runs, { kind: 'paragraph' });
    expect(text(normalized)).toBe('A long original paragraph includes [asset] and keeps its meaning.');
    expect(normalized[0]).toMatchObject({ style: { bold: true } });
    expect(normalized.filter(run => run.type === 'asset')).toEqual([{ type: 'asset', assetId: 'equation' }]);
    expect(runs).toEqual(before);
  });

  it('retains blank paragraphs, list items, references, headings and code line endings', () => {
    const prose = 'First paragraph.\n\nSecond paragraph.\n- First list item\n- Second list item';
    expect(text(normalizePdfTextRuns([{ type: 'text', text: prose }], { kind: 'paragraph' }))).toBe(prose);
    for (const sourceRole of ['references', 'list', 'code', 'header', 'footer']) {
      const value = 'First explicit line\nSecond explicit line';
      expect(text(normalizePdfTextRuns([{ type: 'text', text: value }], { kind: 'paragraph', sourceRole }))).toBe(value);
    }
    const title = 'First title line\nSecond title line';
    expect(text(normalizePdfTextRuns([{ type: 'text', text: title }], { kind: 'heading' }))).toBe(title);
  });

  it('normalizes split CRLF and joins wrapped compound terms without removing their hyphens', () => {
    const runs: ContentRun[] = [{ type: 'text', text: 'Temperature-\r' }, { type: 'text', text: '\ndependent behaviour remains.' }];
    expect(text(normalizePdfTextRuns(runs, { kind: 'paragraph' }))).toBe('Temperature-dependent behaviour remains.');
    expect(text(normalizePdfTextRuns([{ type: 'text', text: 'The relation is:\n$x = 2$\nIt is preserved.' }], { kind: 'paragraph' })))
      .toBe('The relation is:\n$x = 2$\nIt is preserved.');
  });

  it('renders short OCR-wrapped prose as one measured line with selectable complete text', async () => {
    const source = block('Short recognized\nlines from the OCR\nshould reflow as prose.');
    const document = input(source), before = structuredClone(document);
    const pages = await inspect(document);
    expect(pages).toHaveLength(1);
    expect(baselines(pages[0])).toHaveLength(1);
    expect(pages[0].map(item => item.str).join(' ')).toContain('Short recognized lines from the OCR should reflow as prose.');
    expect(document).toEqual(before);
  });

  it('keeps an intentional blank paragraph in the rendered PDF', async () => {
    const pages = await inspect(input(block('First paragraph ends.\n\nSecond paragraph starts.')));
    const positions = baselines(pages[0]);
    expect(positions).toHaveLength(2);
    expect(positions[0] - positions[1]).toBeGreaterThanOrEqual(23.5);
  });

  it('uses compact native leading rather than adding a fixed padding floor to every line', async () => {
    const source = block('alpha beta gamma delta '.repeat(22), {
      rect: { x: 40, y: 80, width: 184, height: 150 },
      appearance: { fontSize: 10, lineHeight: 11.5, confidence: 'native' },
    });
    const pages = await inspect(input(source)), positions = baselines(pages[0]);
    expect(positions.length).toBeGreaterThan(4);
    for (let i = 1; i < positions.length; i++) expect(positions[i - 1] - positions[i]).toBeCloseTo(11.5, 1);
  });

  it('keeps the intended font size when a translation grows beyond the source box', async () => {
    const source = block('value '.repeat(56), {
      rect: { x: 40, y: 80, width: 184, height: 96 },
      appearance: { fontSize: 10, lineHeight: 12, confidence: 'native' },
    });
    const pages = await inspect(input(source, [{ type: 'text', text: 'value '.repeat(64) }]));
    expect(pages).toHaveLength(1);
    const sizes = pages[0].map(item => Math.hypot(item.transform[2], item.transform[3]));
    for (const size of sizes) expect(size).toBeCloseTo(10, 1);
    expect(pages.flat().map(item => item.str).join(' ').match(/value/g)).toHaveLength(64);
  });

  it('keeps large expansion readable and lets it continue instead of shrinking into the original box', async () => {
    const source = block('value '.repeat(56), {
      rect: { x: 40, y: 80, width: 184, height: 96 },
      appearance: { fontSize: 10, lineHeight: 12, confidence: 'native' },
    });
    const pages = await inspect(input(source, [{ type: 'text', text: 'value '.repeat(2500) }]));
    expect(pages.length).toBeGreaterThan(1);
    for (const item of pages.flat()) expect(Math.hypot(item.transform[2], item.transform[3])).toBeCloseTo(10, 1);
    expect(pages.flat().map(item => item.str).join(' ').match(/value/g)).toHaveLength(2500);
  });

  it('uses consistent paragraph spacing across original page boundaries', async () => {
    const first = block('First paragraph.', { rect: { x: 40, y: 80, width: 520, height: 12 } });
    const second = block('Second paragraph.', { id: 'next', page: 2, rect: { x: 40, y: 500, width: 520, height: 12 } });
    const value = input(first);
    value.document.pages.push({ width: 600, height: 800 });
    value.document.blocks.push(second); value.blocks[second.id] = second.runs;
    const pages = await inspect(value);
    expect(pages).toHaveLength(1);
    const positions = baselines(pages[0]);
    expect(positions).toHaveLength(2);
    expect(positions[0] - positions[1]).toBeCloseTo(15.5, 1);
  });

  it('enforces a readable font floor without dropping translated text', async () => {
    const pages = await inspect(input(block('Complete translated paragraph.', { fontSize: 6 })));
    for (const item of pages.flat()) expect(Math.hypot(item.transform[2], item.transform[3])).toBeCloseTo(8, 1);
    expect(pages.flat().map(item => item.str).join(' ')).toContain('Complete translated paragraph.');
  });

  it('does not reject supported translated text because the original uses a different alphabet', async () => {
    const pages = await inspect(input(block('Original \u4e2d\u6587 \ud83e\uddea'), [{ type: 'text', text: 'Translated laboratory sample.' }]));
    expect(pages.flat().map(item => item.str).join(' ')).toContain('Translated laboratory sample.');
  });
});
