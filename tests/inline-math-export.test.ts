import { beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { ContentRun, TranslatedDocument } from '../src/structured-document';
import { createStructuredDocx, validateStructuredSource } from '../src/structured-export';

const render = vi.hoisted(() => vi.fn());
vi.mock('../src/inline-math-renderer', () => ({ rasterizeInlineMath: render }));
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWAAAAABJRU5ErkJggg==', 'base64'));
function fixture(runs: ContentRun[]): TranslatedDocument {
  return { document: { version: 1, sourceKind: 'pdf', sourceName: 'Math test', sourceHash: 'math', pages: [{ width: 612, height: 792 }],
    assets: [], issues: [], blocks: [{ id: 'paragraph', kind: 'paragraph', page: 1, fontSize: 10,
      rect: { x: 54, y: 54, width: 504, height: 40 }, runs }] }, blocks: { paragraph: runs }, sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
}
beforeEach(() => { render.mockReset(); render.mockResolvedValue({ png, widthPt: 12, heightPt: 9, baselineOffsetPt: -2 }); });

it('validates recognized math before translation without invoking the browser renderer', async () => {
  const input = fixture([{ type: 'text', text: String.raw`Viscosity \(\eta_0\).` }]);
  await validateStructuredSource(input.document);
  expect(render).not.toHaveBeenCalled();
});

it('reuses repeated formulas without losing occurrences or mutating the source', async () => {
  const input = fixture([{ type: 'text', text: String.raw`Viscosity \(\eta_0\) and \(\eta_0\).`, style: { italic: true } }]);
  const before = structuredClone(input);
  const zip = await JSZip.loadAsync(await (await createStructuredDocx(input)).arrayBuffer());
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(render).toHaveBeenCalledExactlyOnceWith(String.raw`\eta_0`, 11, false, { bold: false });
  expect(xml.match(/<w:drawing>/g)).toHaveLength(2);
  expect(Object.keys(zip.files).filter(name => name.startsWith('word/media/') && name.endsWith('.png'))).toHaveLength(1);
  expect(xml).toContain('<w:i/>');
  expect(xml).toContain('<w:position w:val="-4"/>');
  expect(input).toEqual(before);
});

it('preserves ordinary currency and skips literal code blocks', async () => {
  const input = fixture([{ type: 'text', text: 'Custos: R$ 10,00 e R$ 20,00.' }]);
  const zip = await JSZip.loadAsync(await (await createStructuredDocx(input)).arrayBuffer());
  expect(await zip.file('word/document.xml')!.async('string')).toContain('R$ 10,00 e R$ 20,00.');
  input.document.blocks[0].sourceRole = 'code';
  input.blocks.paragraph = [{ type: 'text', text: String.raw`Literal \(\eta_0\)` }];
  await createStructuredDocx(input);
  expect(render).not.toHaveBeenCalled();
});

it('keeps normal and bold mathematical glyphs separate while using the heading weight', async () => {
  const input = fixture([{ type: 'text', text: String.raw`\(\eta_0\) ` },
    { type: 'text', text: String.raw`\(\eta_0\)`, style: { bold: true } }]);
  await createStructuredDocx(input);
  expect(render.mock.calls.map(call => call[3])).toEqual([{ bold: false }, { bold: true }]);
  render.mockClear();
  input.document.blocks[0].kind = 'heading';
  await createStructuredDocx(input);
  expect(render).toHaveBeenCalledExactlyOnceWith(String.raw`\eta_0`, 14, false, { bold: true });
});

it('rejects invalid math with the affected block instead of emitting TeX code', async () => {
  const input = fixture([{ type: 'text', text: String.raw`Viscosity \(\frac\).` }]);
  render.mockRejectedValueOnce(new Error('Invalid math'));
  await expect(createStructuredDocx(input)).rejects.toThrow(/expressão matemática.*paragraph/);
});

it('honors cancellation while a formula is being rendered', async () => {
  const controller = new AbortController();
  const input = fixture([{ type: 'text', text: String.raw`Viscosity \(\eta_0\).` }]);
  render.mockImplementationOnce(async () => { controller.abort(); return { png, widthPt: 12, heightPt: 9, baselineOffsetPt: -2 }; });
  await expect(createStructuredDocx(input, undefined, controller.signal)).rejects.toThrow(/cancelada/);
});
