import { describe, expect, it } from 'vitest';
import { inferPdfPageGeometry } from '../src/pdf-page-geometry';
import type { SourceRect } from '../src/structured-document';

type Item = { id: string; rect: SourceRect; kind: string; sourceRole?: string };
const box = (id: string, x: number, y: number, width: number, height: number, kind = 'paragraph', sourceRole?: string): Item =>
  ({ id, rect: { x, y, width, height }, kind, ...(sourceRole ? { sourceRole } : {}) });
function densePage() {
  const items = [box('title', 42, 42, 511, 28, 'heading'), box('abstract', 42, 87, 511, 62)];
  for (let column = 0; column < 2; column++) {
    const x = column === 0 ? 42 : 315;
    for (let index = 0; index < 6; index++) items.push(box(`column-${column}-${index}`, x, 176 + index * 95, 238, 81));
  }
  return items;
}
function expectSafe(value: ReturnType<typeof inferPdfPageGeometry>) {
  expect(value.bounds.x).toBeGreaterThanOrEqual(0);
  expect(value.bounds.y).toBeGreaterThanOrEqual(0);
  expect(value.bounds.x + value.bounds.width).toBeLessThanOrEqual(595);
  expect(value.bounds.y + value.bounds.height).toBeLessThanOrEqual(842);
  for (const column of value.columns) {
    expect(column.x).toBeGreaterThanOrEqual(0);
    expect(column.width).toBeGreaterThan(0);
    expect(column.x + column.width).toBeLessThanOrEqual(595);
  }
}

describe('robust source PDF column geometry', () => {
  it('recognizes dense two-column body below a full-width title and abstract', () => {
    const input = densePage(), snapshot = structuredClone(input);
    const value = inferPdfPageGeometry(595, 842, input);
    expect(value.columns).toEqual([{ x: 42, width: 238 }, { x: 315, width: 238 }]);
    expect(value.trusted).toBe(true);
    expect(value.bounds.x).toBe(42);
    expect(value.bounds.y).toBe(42);
    expect(input).toEqual(snapshot);
    expectSafe(value);
  });
  it('ignores header, footer and page numbers when inferring body columns and margins', () => {
    const input = [...densePage(), box('header', 10, 8, 575, 12, 'paragraph', 'header'),
      box('footer', 14, 815, 565, 12, 'paragraph', 'footer'), box('page-number', 289, 825, 15, 9, 'paragraph', 'page_number')];
    const value = inferPdfPageGeometry(595, 842, input);
    expect(value.columns).toEqual([{ x: 42, width: 238 }, { x: 315, width: 238 }]);
    expect(value.bounds).toEqual(inferPdfPageGeometry(595, 842, densePage()).bounds);
    expect(value.trusted).toBe(true);
  });
  it('does not mistake indented headings, short paragraphs and narrow figures for extra columns', () => {
    const input = [...densePage(), box('indented-heading', 58, 160, 168, 12, 'heading'),
      box('short-left', 58, 747, 90, 13), box('short-right', 335, 747, 111, 13),
      box('narrow-figure', 100, 770, 115, 45, 'figure'), box('caption', 100, 816, 115, 13, 'caption')];
    const value = inferPdfPageGeometry(595, 842, input);
    expect(value.columns).toEqual([{ x: 42, width: 238 }, { x: 315, width: 238 }]);
    expectSafe(value);
  });
  it('retains established columns when one OCR region overlaps the body', () => {
    const input = [...densePage(), box('noisy-recognition', 46, 300, 260, 28)];
    const value = inferPdfPageGeometry(595, 842, input);
    expect(value.columns).toEqual([{ x: 42, width: 238 }, { x: 315, width: 238 }]);
    expect(value.trusted).toBe(false);
    expect(value.warnings?.join(' ')).toMatch(/sobrepostas/u);
    expectSafe(value);
  });
  it('keeps two columns when one tall OCR box is inflated toward the gutter', () => {
    const value = inferPdfPageGeometry(595, 842, [box('left', 42, 100, 238, 100), box('right', 315, 100, 238, 100),
      box('inflated', 46, 100, 260, 500)]);
    expect(value.columns).toEqual([{ x: 42, width: 238 }, { x: 315, width: 238 }]);
    expect(value.trusted).toBe(false);
    expectSafe(value);
  });
  it.each([
    { x: Number.NaN, y: 200, width: 100, height: 20 },
    { x: -40, y: 200, width: 200, height: 20 },
    { x: 500, y: 200, width: 200, height: 20 },
  ])('keeps two clear columns instead of resetting the page for one bad rectangle: %o', rect => {
    const value = inferPdfPageGeometry(595, 842, [...densePage(), { id: 'bad-region', rect, kind: 'paragraph' }]);
    expect(value.columns).toEqual([{ x: 42, width: 238 }, { x: 315, width: 238 }]);
    expect(value.trusted).toBe(false);
    expect(value.warnings?.length).toBeGreaterThan(0);
    expectSafe(value);
  });
  it('uses equal safe widths for slightly unequal source columns', () => {
    const value = inferPdfPageGeometry(595, 842, [box('left', 42, 80, 220, 150), box('right', 315, 80, 238, 150)]);
    expect(value.columns).toEqual([{ x: 42, width: 220 }, { x: 315, width: 220 }]);
  });
  it.each([3, 4])('marks %i parallel columns as unsupported instead of falsely claiming two', count => {
    const width = count === 3 ? 150 : 100, step = count === 3 ? 180 : 140;
    const input = Array.from({ length: count }, (_, index) => box(`column-${index}`, 40 + step * index, 80, width, 180));
    const value = inferPdfPageGeometry(595, 842, input);
    expect(value.trusted).toBe(false);
    expect(value.columns).toHaveLength(1);
    expect(value.warnings?.join(' ')).toMatch(/mais de duas/u);
    expectSafe(value);
  });
  it('keeps a safe simplified body for malformed or entirely overlapping input', () => {
    const malformed = inferPdfPageGeometry(595, 842, [box('invalid', -20, 20, 800, 800)]);
    expect(malformed.trusted).toBe(false); expect(malformed.columns).toHaveLength(1); expectSafe(malformed);
    const overlapping = inferPdfPageGeometry(595, 842, [box('a', 42, 50, 511, 200), box('b', 42, 80, 511, 200)]);
    expect(overlapping.trusted).toBe(false); expect(overlapping.columns).toHaveLength(1); expectSafe(overlapping);
  });
  it('does not invent parallel columns from side notes at different vertical positions', () => {
    const value = inferPdfPageGeometry(595, 842, [box('top-note', 42, 70, 238, 50), box('bottom-note', 315, 680, 238, 50)]);
    expect(value.columns).toHaveLength(1);
    expectSafe(value);
  });
});
