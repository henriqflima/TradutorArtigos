import { describe, expect, it } from 'vitest';
import { planPdfLayout, type PdfLayoutItem, type PdfLayoutPlan } from '../src/pdf-layout';
import type { StructuredDocument } from '../src/structured-document';

const size = { width: 600, height: 800 };
function document(pageCount = 1): StructuredDocument {
  return { version: 1, sourceName: 'flow-invariants.pdf', sourceHash: 'flow-invariants', sourceKind: 'pdf',
    pages: Array.from({ length: pageCount }, () => ({ ...size })), blocks: [], assets: [], issues: [] };
}
function block(id: string, kind: string, x: number, y: number, width: number, sourceHeight: number, heights: number[], page = 1): PdfLayoutItem {
  return { id, kind, page, rect: { x, y, width, height: sourceHeight }, keepWithNext: kind === 'heading',
    measure: () => ({ heights, gapAfter: 8, atomic: /^(?:figure|table|equation)$/u.test(kind) }) };
}
function safeAndComplete(plan: PdfLayoutPlan, items: PdfLayoutItem[]) {
  for (const item of items) {
    const fragments = plan.placements.filter(placement => placement.id === item.id);
    expect(fragments.length, `${item.id} must be present`).toBeGreaterThan(0);
    expect(new Set(fragments.map(fragment => fragment.regionWidth)).size, `${item.id} must keep its measured line width`).toBe(1);
    const first = fragments[0], expected = item.measure(first.regionWidth, first.regionHeight).heights;
    expect(fragments.flatMap(fragment => Array.from({ length: fragment.end - fragment.start }, (_, index) => fragment.start + index)),
      `${item.id} must include every line exactly once`).toEqual(expected.map((_, index) => index));
  }
  for (const [pageIndex, page] of plan.pages.entries()) {
    const placements = plan.placements.filter(placement => placement.pageIndex === pageIndex);
    expect(placements.length, `Output page ${pageIndex + 1} must not be an accidental blank`).toBeGreaterThan(0);
    for (const [index, placement] of placements.entries()) {
      const a = placement.rect;
      expect([a.x, a.y, a.width, a.height].every(Number.isFinite)).toBe(true);
      expect(a.x).toBeGreaterThanOrEqual(0); expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(page.width + .02);
      expect(a.y + a.height).toBeLessThanOrEqual(page.height + .02);
      for (const other of placements.slice(index + 1)) {
        const b = other.rect;
        const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(dx > .01 && dy > .01, `Overlap: page ${pageIndex + 1}, ${placement.id} / ${other.id}`).toBe(false);
      }
    }
  }
}

describe('continuous PDF flow invariants', () => {
  it('keeps successive full-width bottom figures in their physical reading order', () => {
    const items = [block('body-left', 'paragraph', 40, 80, 240, 300, [100]),
      block('body-right', 'paragraph', 320, 80, 240, 300, [20]),
      block('figure-first', 'figure', 40, 420, 520, 120, [120]),
      block('figure-second', 'figure', 40, 560, 520, 100, [100])];
    const plan = planPdfLayout(document(), items);
    const first = plan.placements.find(placement => placement.id === 'figure-first')!;
    const second = plan.placements.find(placement => placement.id === 'figure-second')!;
    expect([first, second].sort((a, b) => a.pageIndex - b.pageIndex || a.rect.y - b.rect.y).map(placement => placement.id))
      .toEqual(['figure-first', 'figure-second']);
    safeAndComplete(plan, items);
  });

  it('does not place a later column figure above an earlier full-width bottom figure', () => {
    const items = [block('body-left', 'paragraph', 40, 80, 240, 300, [100]),
      block('body-right', 'paragraph', 320, 80, 240, 300, [20]),
      block('wide-first', 'figure', 40, 420, 520, 120, [120]),
      block('column-second', 'figure', 40, 560, 240, 80, [80])];
    const plan = planPdfLayout(document(), items);
    const first = plan.placements.find(placement => placement.id === 'wide-first')!;
    const second = plan.placements.find(placement => placement.id === 'column-second')!;
    expect(second.pageIndex > first.pageIndex || second.pageIndex === first.pageIndex && second.rect.y >= first.rect.y + first.rect.height).toBe(true);
    safeAndComplete(plan, items);
  });

  it('does not let an intervening deferred figure strand a heading on the preceding page', () => {
    const items = [block('lead', 'paragraph', 40, 40, 520, 400, [480]),
      block('section-heading', 'heading', 40, 430, 520, 20, [20]),
      block('intervening-figure', 'figure', 40, 450, 520, 160, [160]),
      block('section-body', 'paragraph', 40, 640, 520, 60, [20, 20, 20])];
    const plan = planPdfLayout(document(), items);
    const heading = plan.placements.find(placement => placement.id === 'section-heading')!;
    const body = plan.placements.find(placement => placement.id === 'section-body')!;
    expect(body.pageIndex).toBe(heading.pageIndex);
    expect(body.rect.x).toBe(heading.rect.x);
    expect(body.rect.y).toBeCloseTo(heading.rect.y + heading.rect.height + 8);
    safeAndComplete(plan, items);
  });

  it('keeps a heading with a following full-width equation after column text', () => {
    const items = [block('body-left', 'paragraph', 40, 80, 240, 300, [100]),
      block('body-right', 'paragraph', 320, 80, 240, 300, [100]),
      block('equation-heading', 'heading', 40, 420, 240, 20, [20]),
      block('wide-equation', 'equation', 40, 450, 520, 80, [80])];
    const plan = planPdfLayout(document(), items);
    const heading = plan.placements.find(placement => placement.id === 'equation-heading')!;
    const equation = plan.placements.find(placement => placement.id === 'wide-equation')!;
    expect(heading.pageIndex).toBe(equation.pageIndex);
    safeAndComplete(plan, items);
  });

  it('retains every line and object without collisions across deterministic mixed documents', () => {
    for (let seed = 1; seed <= 120; seed++) {
      let state = seed;
      const random = (max: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
      const items: PdfLayoutItem[] = [];
      for (let index = 0; index < 38; index++) {
        const page = Math.floor(index / 13) + 1;
        const choice = random(12), kind = choice < 2 ? 'figure' : choice === 2 ? 'table' : choice === 3 ? 'equation' : choice === 4 ? 'heading' : 'paragraph';
        const full = random(4) === 0, x = full || random(2) === 0 ? 40 : 320, width = full ? 520 : 240;
        const heights = /^(?:figure|table|equation)$/u.test(kind) ? [60 + random(240)] : kind === 'heading' ? [20, 20] : Array.from({ length: 1 + random(65) }, () => random(30) === 0 ? 420 : 12 + random(9));
        const item = block(`seed-${seed}-block-${index}`, kind, x, 50 + random(500), width, 30 + random(120), heights, page);
        items.push(item);
      }
      const plan = planPdfLayout(document(3), items);
      safeAndComplete(plan, items);
      for (const source of plan.report.pages) for (const output of source.outputPages) {
        expect(plan.report.outputPages[output - 1].sourcePages).toContain(source.sourcePage);
      }
    }
  });
});
