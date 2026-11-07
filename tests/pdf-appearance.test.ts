import { describe, expect, it } from 'vitest';
import { appearanceForBlock, nativeTextSpans, type NativeTextSpan } from '../src/pdf-appearance';
import type { DocumentBlock } from '../src/structured-document';

const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
function content(fontFamily = 'sans-serif') {
  return { items: [{ str: 'Original source text', dir: 'ltr', transform: [12, 0, 0, 12, 40, 700], width: 150, height: 12, fontName: 'g_d0_f1', hasEOL: true }],
    styles: { g_d0_f1: { ascent: .8, descent: -.2, vertical: false, fontFamily } }, lang: null };
}
const paragraph = (): DocumentBlock => ({ id: 'p1-ocr-0', page: 1, kind: 'paragraph', rect: { x: 38, y: 85, width: 230, height: 65 },
  fontSize: 10, originalText: 'OCR text remains authoritative.', runs: [{ type: 'text', text: 'OCR text remains authoritative.' }] });
function span(x: number, y: number, width: number, fontSize = 12, characters = 30): NativeTextSpan {
  return { rect: { x, y: y - fontSize * .8, width, height: fontSize }, baselineY: y, fontSize, characters, fontFamily: 'sans-serif' };
}

describe('source PDF appearance metadata', () => {
  it('uses public native font/geometry data without retaining native prose', () => {
    const spans = nativeTextSpans(content(), viewport);
    expect(spans).toHaveLength(1);
    expect(spans[0].fontSize).toBe(12);
    expect(spans[0].rect).toEqual({ x: 40, y: 90.4, width: 150, height: 12 });
    expect(spans[0].fontFamily).toBe('sans-serif');
    expect(JSON.stringify(spans)).not.toContain('Original source text');
    const block = paragraph(), before = structuredClone(block);
    expect(appearanceForBlock(block, spans, 600)).toEqual({ fontSize: 12, fontFamily: 'sans-serif', confidence: 'native' });
    expect(block).toEqual(before);
  });

  it('normalizes crop origins, scale and 180 degree rotation into source page coordinates', () => {
    const offset = nativeTextSpans(content('Times New Roman'), { width: 600, height: 800, transform: [1, 0, 0, -1, -20, 820] });
    expect(offset[0].rect.x).toBe(20);
    expect(offset[0].rect.y).toBeCloseTo(110.4);
    const rotated = nativeTextSpans(content(), { width: 1200, height: 1600, transform: [-2, 0, 0, 2, 1200, 0] });
    expect(rotated[0].fontSize).toBe(24);
    expect(rotated[0].rect.x).toBe(820);
    expect(rotated[0].rect.y).toBeCloseTo(1395.2);
    expect(rotated[0].rect.width).toBe(300);
    expect(rotated[0].rect.height).toBe(24);
  });

  it('ignores invalid, vertical and angled labels instead of contaminating paragraph style', () => {
    const input = content();
    input.items = [
      { ...input.items[0], transform: [Number.NaN, 0, 0, 12, 40, 700] },
      { ...input.items[0], transform: [0, 12, -12, 0, 40, 700] },
      { ...input.items[0], width: Number.POSITIVE_INFINITY },
      { ...input.items[0], str: ' ' },
    ];
    expect(nativeTextSpans(input, viewport)).toEqual([]);
    const vertical = content(); vertical.styles.g_d0_f1.vertical = true;
    expect(nativeTextSpans(vertical, viewport)).toEqual([]);
    expect(nativeTextSpans(content(), { ...viewport, transform: [1, 0, 0, 1, 0, Number.NaN] })).toEqual([]);
  });

  it('matches by region, weights body typography over superscripts and estimates line spacing/alignment', () => {
    const block = paragraph();
    const spans = [span(40, 100, 200), span(40, 115, 200), span(40, 130, 100),
      span(45, 99, 5, 7, 1), span(330, 100, 200, 16)];
    expect(appearanceForBlock(block, spans, 600)).toMatchObject({ fontSize: 12, lineHeight: 15, alignment: 'justify', fontFamily: 'sans-serif', confidence: 'native' });
  });

  it('infers centered and right-aligned blocks from line geometry', () => {
    const block = paragraph();
    expect(appearanceForBlock(block, [span(40, 100, 200), span(90, 115, 100)], 600)?.alignment).toBe('center');
    expect(appearanceForBlock(block, [span(40, 100, 200), span(140, 115, 100)], 600)?.alignment).toBe('right');
    const heading = { ...block, kind: 'heading' as const, rect: { x: 200, y: 85, width: 200, height: 25 } };
    expect(appearanceForBlock(heading, [span(200, 100, 200, 18)], 600)?.alignment).toBe('center');
  });

  it('recognizes justified prose with a first-line indent even when every line reaches the right edge', () => {
    const block = paragraph();
    const spans = [span(54, 100, 186, 10), span(40, 112, 200, 10), span(40, 124, 200, 10), span(40, 136, 200, 10)];
    expect(appearanceForBlock(block, spans, 600)).toMatchObject({ alignment: 'justify', fontSize: 10, lineHeight: 12 });
    spans[3] = span(40, 136, 100, 10);
    expect(appearanceForBlock(block, spans, 600)?.alignment).toBe('justify');
  });

  it('preserves genuinely varying centered and right-aligned line starts', () => {
    const block = paragraph();
    expect(appearanceForBlock(block, [span(40, 100, 200), span(70, 115, 140), span(100, 130, 80)], 600)?.alignment).toBe('center');
    expect(appearanceForBlock(block, [span(40, 100, 200), span(90, 115, 150), span(140, 130, 100)], 600)?.alignment).toBe('right');
    const header = { ...block, sourceRole: 'header' };
    expect(appearanceForBlock(header, [span(54, 100, 186, 10), span(40, 112, 200, 10), span(40, 124, 200, 10)], 600)?.alignment).toBe('right');
  });

  it.each([[10, 12], [12, 10]])('uses the dominant same-page fragment without combining separate columns (%i/%i pt)', (firstSize, continuationSize) => {
    const block = paragraph();
    block.rect = { x: 38, y: 85, width: 230, height: 34 };
    const continuationRect = { x: 328, y: 85, width: 230, height: 65 };
    block.fragments = [{ page: 1, rect: block.rect }, { page: 1, rect: continuationRect }];
    const leading = continuationSize * 1.2;
    const spans = [span(54, 100, 186, firstSize, 10), span(40, 115, 200, firstSize, 10),
      span(330, 100, 200, continuationSize, 60), span(330, 100 + leading, 200, continuationSize, 60), span(330, 100 + leading * 2, 110, continuationSize, 60)];
    const appearance = appearanceForBlock(block, spans, 600);
    expect(appearance).toMatchObject({ fontSize: continuationSize, alignment: 'justify' });
    expect(appearance?.lineHeight).toBeCloseTo(leading, 5);
  });

  it('recognizes an indented two-line start when the merged paragraph continues on another page', () => {
    const block = paragraph();
    block.rect = { x: 38, y: 85, width: 230, height: 34 };
    block.fragments = [{ page: 1, rect: block.rect }, { page: 2, rect: { x: 328, y: 85, width: 230, height: 65 } }];
    const spans = [span(54, 100, 186, 10), span(40, 112, 200, 10), { ...span(330, 100, 200, 18, 1000), bold: true }];
    const appearance = appearanceForBlock(block, spans, 600);
    expect(appearance).toMatchObject({ fontSize: 10, lineHeight: 12, alignment: 'justify' });
    expect(appearance?.bold).toBeUndefined();
  });

  it('only uses public font names as optional evidence for bold and italic', () => {
    const generic = nativeTextSpans(content(), viewport);
    expect(generic[0].bold).toBeUndefined();
    expect(generic[0].italic).toBeUndefined();
    const named = nativeTextSpans(content('Times New Roman Bold Italic'), viewport);
    expect(named[0]).toMatchObject({ fontFamily: 'serif', bold: true, italic: true });
    expect(appearanceForBlock(paragraph(), named, 600)).toMatchObject({ bold: true, italic: true });
  });

  it('uses conservative multiline OCR estimates for scans, with a fallback for ambiguous boxes', () => {
    const block = paragraph();
    block.originalText = 'The first line contains several words.\nThe second line contains several words.\nThe last line.';
    block.rect = { x: 40, y: 80, width: 220, height: 34 };
    expect(appearanceForBlock(block, [], 600)).toEqual({ fontSize: 10, lineHeight: 12, confidence: 'estimated' });
    block.originalText = 'This OCR paragraph has no reliable line breaks.';
    expect(appearanceForBlock(block, [], 600)).toBeUndefined();
    block.originalText = 'Separate paragraphs.\n\nSeparate paragraphs.';
    expect(appearanceForBlock(block, [], 600)).toBeUndefined();
    block.originalText = 'Short\nlines'; block.rect.height = 200;
    expect(appearanceForBlock(block, [], 600)).toBeUndefined();
  });

  it('does not infer text typography for images or equations', () => {
    expect(appearanceForBlock({ ...paragraph(), kind: 'figure' }, [span(40, 100, 150)], 600)).toBeUndefined();
  });
});
