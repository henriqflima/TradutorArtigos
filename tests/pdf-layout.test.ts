import { describe, expect, it } from 'vitest';
import { planPdfLayout, type PdfLayoutItem, type PdfLayoutPlan, type PdfMeasurement } from '../src/pdf-layout';
import type { SourceRect, StructuredDocument } from '../src/structured-document';

const page = { width: 600, height: 800 };
function document(pages = [page]): StructuredDocument {
  return { version: 1, sourceName: 'layout.pdf', sourceHash: 'layout', sourceKind: 'pdf', pages, blocks: [], assets: [], issues: [] };
}
function item(id: string, x: number, y: number, width: number, height: number, measurement: Partial<PdfMeasurement> = {}, kind = 'paragraph', sourcePage = 1): PdfLayoutItem {
  return { id, page: sourcePage, kind, rect: { x, y, width, height }, measure: () => ({ heights: [20], gapAfter: 8, ...measurement }) };
}
function twoColumns() {
  return [item('title', 40, 40, 520, 25, { heights: [25] }, 'heading'),
    item('left-a', 40, 100, 240, 50), item('left-b', 40, 180, 240, 50),
    item('right-a', 320, 100, 240, 50), item('right-b', 320, 180, 240, 50)];
}
function intersects(a: SourceRect, b: SourceRect) {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > .01 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > .01;
}
function expectSafe(plan: PdfLayoutPlan) {
  for (let index = 0; index < plan.pages.length; index++) {
    const placements = plan.placements.filter(placement => placement.pageIndex === index);
    for (let i = 0; i < placements.length; i++) {
      const a = placements[i].rect;
      expect([a.x, a.y, a.width, a.height].every(Number.isFinite)).toBe(true);
      expect(a.x).toBeGreaterThanOrEqual(0); expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(plan.pages[index].width + .02);
      expect(a.y + a.height).toBeLessThanOrEqual(plan.pages[index].height + .02);
      for (const b of placements.slice(i + 1)) expect(intersects(a, b.rect), `Overlapping placements: ${placements[i].id} / ${b.id}`).toBe(false);
    }
  }
}

describe('continuous PDF region planner', () => {
  it('fills one page with text from several origins, including joined paragraph fragments', () => {
    const items = [item('one', 40, 200, 520, 40), item('two', 40, 500, 520, 40, {}, 'paragraph', 2)];
    items[1].sourcePages = [2, 3];
    const plan = planPdfLayout(document([page, page, page]), items);
    expect(plan.pages).toEqual([{ ...page, sourcePages: [1, 2, 3] }]);
    expect(plan.report.pages.map(source => source.outputPages)).toEqual([[1], [1], [1]]);
    expect(plan.report.outputPages).toEqual([{ outputPage: 1, sourcePages: [1, 2, 3], columns: 1 }]);
    expect(plan.placements[1].rect.y - bottomOf(plan.placements[0].rect)).toBe(8);
    expectSafe(plan);
  });

  it('fills the remaining space with prose when a figure needs the next page', () => {
    const items = [item('lead', 40, 40, 520, 400, { heights: Array(40).fill(12) }),
      item('figure', 40, 450, 520, 280, { heights: [280], atomic: true }, 'figure'),
      item('tail', 40, 40, 520, 100, { heights: Array(10).fill(12) }, 'paragraph', 2)];
    const plan = planPdfLayout(document([page, page]), items);
    expect(plan.pages).toHaveLength(2);
    expect(plan.placements.find(p => p.id === 'tail')?.pageIndex).toBe(0);
    expect(plan.placements.find(p => p.id === 'figure')?.pageIndex).toBe(1);
    expect(plan.placements.filter(p => p.id === 'figure')).toHaveLength(1);
    expectSafe(plan);
  });

  it('allows a small proportional image fit, but never shrinks a figure into an arbitrary leftover', () => {
    const planFor = (lead: number) => {
      const figure = item('figure', 40, 450, 520, 300, {}, 'figure');
      figure.measure = (_width, maxHeight) => {
        const imageHeight = Math.min(300, maxHeight - 20);
        return { heights: [imageHeight + 20], imageHeight, gapAfter: 8, atomic: true };
      };
      return planPdfLayout(document(), [item('lead', 40, 40, 520, 400, { heights: [lead] }), figure]);
    };
    const modest = planFor(400), large = planFor(500);
    expect(modest.pages).toHaveLength(1);
    expect(modest.placements.find(p => p.id === 'figure')!.regionHeight).toBeLessThan(720);
    expect(large.pages).toHaveLength(2);
    expect(large.placements.find(p => p.id === 'figure')!.rect.height).toBe(320);
    expectSafe(modest); expectSafe(large);
  });

  it('keeps the opening title wide even when small publisher logos precede it', () => {
    const items = [item('logo', 40, 45, 65, 70, { heights: [70], atomic: true }, 'figure'),
      item('main-title', 40, 150, 520, 35, { heights: [35] }, 'heading'),
      item('authors', 40, 200, 400, 20),
      item('body-heading', 40, 270, 150, 20, { heights: [20] }, 'heading'),
      item('body-left', 40, 310, 240, 100), item('body-right', 320, 310, 240, 100)];
    const input = document();
    input.blocks = items.map(value => ({ ...value, kind: value.kind as 'figure' | 'heading' | 'paragraph',
      fontSize: value.id === 'main-title' ? 18 : 10, runs: [{ type: 'text', text: value.id === 'body-heading' ? '1. Introduction' : value.id }] }));
    const plan = planPdfLayout(input, items);
    expect(plan.pages).toHaveLength(1);
    expect(plan.placements.find(p => p.id === 'main-title')?.rect.width).toBe(520);
    expect(plan.placements.find(p => p.id === 'body-left')?.rect.width).toBe(240);
    expectSafe(plan);
  });

  it('reserves a wide bottom figure while both columns remain available for subsequent text', () => {
    const items = twoColumns();
    items[1].measure = () => ({ heights: Array(12).fill(12), gapAfter: 8 });
    const figure = item('bottom-figure', 40, 620, 520, 120, { heights: [120], atomic: true }, 'figure');
    const tail = item('tail', 40, 120, 240, 500, { heights: Array(50).fill(12) }, 'paragraph', 2);
    const plan = planPdfLayout(document([page, page]), [...items, figure, tail]);
    expect(plan.pages).toHaveLength(1);
    const float = plan.placements.find(p => p.id === figure.id)!;
    expect(float.rect.width).toBe(520);
    const fragments = plan.placements.filter(p => p.id === tail.id);
    expect(fragments).toHaveLength(2);
    expect(new Set(fragments.map(p => p.rect.x))).toEqual(new Set([40, 320]));
    expect(fragments.every(p => bottomOf(p.rect) <= float.rect.y)).toBe(true);
    expectSafe(plan);
  });

  it('flushes a long queue of indivisible figures in order and terminates', () => {
    const items = [item('lead', 40, 40, 520, 600, { heights: Array(50).fill(12) }),
      ...Array.from({ length: 12 }, (_, i) => item(`figure-${i}`, 40, 50, 520, 450, { heights: [450], atomic: true }, 'figure'))];
    const plan = planPdfLayout(document(), items);
    const figures = plan.placements.filter(p => p.id.startsWith('figure-'));
    expect(figures.map(p => p.id)).toEqual(items.slice(1).map(value => value.id));
    expect(figures.map(p => p.pageIndex)).toEqual([...figures.map(p => p.pageIndex)].sort((a, b) => a - b));
    expect(figures).toHaveLength(12);
    expectSafe(plan);
  });

  it('lets subsequent text use the tail even when several figures are waiting', () => {
    const items = [item('lead', 40, 40, 520, 500, { heights: Array(40).fill(12) }),
      ...Array.from({ length: 4 }, (_, index) => item(`waiting-${index}`, 40, 400, 520, 300, { heights: [300], atomic: true }, 'figure')),
      item('tail-after-figures', 40, 50, 520, 100, { heights: Array(10).fill(12) }, 'paragraph', 2)];
    const plan = planPdfLayout(document([page, page]), items);
    expect(plan.placements.find(p => p.id === 'tail-after-figures')?.pageIndex).toBe(0);
    expect(plan.placements.filter(p => p.id.startsWith('waiting-'))).toHaveLength(4);
    expectSafe(plan);
  });

  it('retains a real change of page format while flowing normally inside each format', () => {
    const sizes = [page, page, { width: 500, height: 700 }];
    const items = [item('first', 40, 70, 520, 30), item('second', 40, 80, 520, 30, {}, 'paragraph', 2),
      item('new-format', 40, 60, 420, 30, {}, 'paragraph', 3)];
    const plan = planPdfLayout(document(sizes), items);
    expect(plan.pages.map(p => [p.width, p.height, p.sourcePages])).toEqual([[600, 800, [1, 2]], [500, 700, [3]]]);
    expectSafe(plan);
  });

  it('uses the source column style and a full-width opening while flowing in reviewed order', () => {
    const items = twoColumns(), before = items.map(value => ({ ...value, rect: { ...value.rect } }));
    const plan = planPdfLayout(document(), items);
    expect(plan.pages).toHaveLength(1);
    expect(plan.report.pages[0]).toMatchObject({ mode: 'flow', columns: 2, outputPages: [1] });
    expect(plan.placements.map(p => p.id)).toEqual(items.map(value => value.id));
    expect(plan.placements.find(p => p.id === 'title')?.rect).toMatchObject({ x: 40, y: 40, width: 520 });
    expect(plan.placements.find(p => p.id === 'left-a')?.rect).toMatchObject({ x: 40, y: 73 });
    expect(plan.placements.find(p => p.id === 'right-a')?.rect.x).toBe(40);
    expect(items).toEqual(before);
    expectSafe(plan);
  });

  it('respects reviewed order even when original rectangles alternate between columns', () => {
    const source = twoColumns(), items = [source[0], source[1], source[3], source[2], source[4]];
    const plan = planPdfLayout(document(), items);
    expect(plan.report.pages[0]).toMatchObject({ mode: 'flow', columns: 2 });
    expect(plan.placements.map(p => p.id)).toEqual(items.map(value => value.id));
    expect(plan.placements.find(p => p.id === 'left-b')?.rect.x).toBe(40);
    expect(plan.placements.find(p => p.id === 'right-a')?.rect.x).toBe(40);
    expectSafe(plan);
  });

  it('flows paragraphs by their measured height instead of reserving empty OCR boxes', () => {
    const plan = planPdfLayout(document(), [item('short-translation', 40, 60, 520, 90), item('following', 40, 160, 520, 60)]);
    const first = plan.placements.find(p => p.id === 'short-translation')!;
    expect(plan.placements.find(p => p.id === 'following')?.rect.y).toBe(first.rect.y + first.rect.height + 8);
    expect(plan.pages).toHaveLength(1);
    expectSafe(plan);
  });

  it('excludes source page furniture from the continuous body without disturbing columns', () => {
    const header = { ...item('running-header', 4, 8, 592, 10), sourceRole: 'header' };
    const footer = { ...item('page-number', 550, 775, 20, 10), sourceRole: 'footer' };
    const plan = planPdfLayout(document(), [header, ...twoColumns(), footer]);
    expect(plan.report.pages[0].columns).toBe(2);
    expect(plan.placements.find(p => p.id === header.id)).toBeUndefined();
    expect(plan.placements.find(p => p.id === footer.id)).toBeUndefined();
    expectSafe(plan);
  });

  it('does not claim to preserve an unsupported clear three-column layout', () => {
    const items = [item('first-column', 40, 80, 150, 100), item('second-column', 225, 80, 150, 100), item('third-column', 410, 80, 150, 100)];
    const plan = planPdfLayout(document(), items);
    expect(plan.report.pages[0].mode).toBe('simplified');
    expect(plan.report.pages[0].warnings.length).toBeGreaterThan(0);
    expect(plan.placements.map(p => p.id)).toEqual(items.map(value => value.id));
    expectSafe(plan);
  });

  it('does not claim to preserve four narrow source columns', () => {
    const items = [40, 180, 320, 460].map((x, index) => item(`column-${index}`, x, 80, 100, 100));
    const plan = planPdfLayout(document(), items);
    expect(plan.report.pages[0].mode).toBe('simplified');
    expect(plan.report.pages[0].warnings.length).toBeGreaterThan(0);
    expect(plan.placements.map(p => p.id)).toEqual(items.map(value => value.id));
    expectSafe(plan);
  });

  it.each([
    { x: Number.NaN, y: 50, width: 220, height: 30 },
    { x: -10, y: 50, width: 220, height: 30 },
    { x: 40, y: 50, width: 0, height: 30 },
    { x: 40, y: 50, width: 800, height: 30 },
  ])('falls back safely for invalid or out-of-page source geometry: %o', rect => {
    const malformed = { ...item('bad-anchor', 40, 50, 220, 30), rect };
    const plan = planPdfLayout(document(), [malformed, item('after', 40, 100, 220, 30)]);
    expect(plan.report.pages[0].mode).toBe('simplified');
    expect(plan.placements.map(p => p.id)).toEqual(['bad-anchor', 'after']);
    expectSafe(plan);
  });

  it('falls back when source boxes overlap without overlapping the generated placements', () => {
    const plan = planPdfLayout(document(), [item('a', 40, 50, 520, 70), item('b', 40, 80, 520, 70)]);
    expect(plan.report.pages[0].mode).toBe('simplified');
    expect(plan.placements.map(p => p.id)).toEqual(['a', 'b']);
    expectSafe(plan);
  });

  it('assigns every expanded line once across columns and continuation pages', () => {
    const items = twoColumns();
    items[1].measure = () => ({ heights: Array.from({ length: 170 }, () => 12), gapAfter: 8 });
    const plan = planPdfLayout(document(), items);
    expect(plan.pages.length).toBeGreaterThan(1);
    const fragments = plan.placements.filter(p => p.id === 'left-a');
    expect(fragments.flatMap(p => Array.from({ length: p.end - p.start }, (_, i) => p.start + i))).toEqual(Array.from({ length: 170 }, (_, i) => i));
    expect(plan.report.pages[0].outputPages).toHaveLength(plan.pages.length);
    expect(plan.report.outputPages.every(page => page.sourcePages.includes(1))).toBe(true);
    expectSafe(plan);
  });

  it('keeps line identities stable for unequal original columns', () => {
    const items = [item('left', 40, 80, 220, 100), item('right', 320, 80, 240, 100)];
    items[0].measure = width => ({ heights: Array.from({ length: width <= 220 ? 100 : 80 }, () => 12), gapAfter: 8 });
    const plan = planPdfLayout(document(), items);
    const fragments = plan.placements.filter(p => p.id === 'left');
    expect(fragments.flatMap(p => Array.from({ length: p.end - p.start }, (_, i) => p.start + i))).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(new Set(fragments.map(p => p.regionWidth)).size).toBe(1);
    expectSafe(plan);
  });

  it('allows prose to flow around a deferred wide figure without overlaps', () => {
    const source = twoColumns();
    const items = [...source, item('wide-figure', 40, 320, 520, 100, { heights: [110], atomic: true }, 'figure'),
      item('below-left', 40, 470, 240, 50), item('below-right', 320, 470, 240, 50)];
    source[1].measure = () => ({ heights: Array.from({ length: 95 }, () => 12), gapAfter: 8 });
    const plan = planPdfLayout(document(), items);
    expect(plan.report.pages[0].mode).toBe('flow');
    const figure = plan.placements.find(p => p.id === 'wide-figure')!;
    expect(figure.rect.width).toBe(520);
    expect(figure.start).toBe(0); expect(figure.end).toBe(1);
    const belowLeft = plan.placements.find(p => p.id === 'below-left')!, belowRight = plan.placements.find(p => p.id === 'below-right')!;
    expect(belowLeft.pageIndex).toBeLessThanOrEqual(figure.pageIndex);
    expect(belowRight.pageIndex).toBeLessThanOrEqual(figure.pageIndex);
    expectSafe(plan);
  });

  it('allows one tall line per page when keeping two lines would exceed an entire page', () => {
    const plan = planPdfLayout(document(), [item('tall-inline-lines', 40, 50, 520, 30, { heights: [420, 420] })]);
    expect(plan.pages).toHaveLength(2);
    expect(plan.placements.map(p => [p.start, p.end])).toEqual([[0, 1], [1, 2]]);
    expectSafe(plan);
  });

  it('keeps a spanning heading with following text even when they belong to separate bands', () => {
    const heading = item('late-heading', 40, 680, 520, 20, { heights: [20] }, 'heading');
    heading.keepWithNext = true;
    const plan = planPdfLayout(document(), [item('left', 40, 100, 240, 50), item('right', 320, 100, 240, 50), heading,
      item('following', 40, 710, 520, 30, { heights: [30, 30] })]);
    expect(plan.placements.find(p => p.id === 'late-heading')?.pageIndex).toBe(plan.placements.find(p => p.id === 'following')?.pageIndex);
    expectSafe(plan);
  });

  it('keeps the entire multiline heading with the following paragraph', () => {
    const heading = item('multiline-heading', 40, 645, 520, 70, { heights: [30, 30, 30] }, 'heading');
    heading.keepWithNext = true;
    const plan = planPdfLayout(document(), [item('body', 40, 50, 520, 500, { heights: [585] }), heading,
      item('following', 40, 725, 520, 35, { heights: [20, 20] })]);
    const title = plan.placements.filter(p => p.id === 'multiline-heading'), following = plan.placements.find(p => p.id === 'following')!;
    expect(title).toHaveLength(1);
    expect(title[0].pageIndex).toBe(following.pageIndex);
    expect(title[0].end).toBe(3);
    expectSafe(plan);
  });

  it('keeps a final heading with its only following figure instead of leaving a stranded title', () => {
    const heading = item('last-heading', 40, 630, 520, 25, { heights: [25] }, 'heading');
    heading.keepWithNext = true;
    const items = [item('lead', 40, 40, 520, 550, { heights: Array(45).fill(12) }), heading,
      item('last-figure', 40, 670, 520, 180, { heights: [180], atomic: true }, 'figure')];
    const plan = planPdfLayout(document(), items);
    const title = plan.placements.find(p => p.id === heading.id)!, figure = plan.placements.find(p => p.id === 'last-figure')!;
    expect(title.pageIndex).toBe(figure.pageIndex);
    expect(figure.rect.y).toBe(title.rect.y + title.rect.height + 8);
    expectSafe(plan);
  });

  it('rejects invalid page dimensions, invalid measurements and individually oversized lines', () => {
    expect(() => planPdfLayout(document([{ width: 0, height: 800 }]), [])).toThrow(/dimensões inválidas/u);
    expect(() => planPdfLayout(document(), [item('bad-measure', 40, 50, 520, 20, { heights: [Number.NaN] })])).toThrow(/medidas inválidas/u);
    expect(() => planPdfLayout(document(), [item('huge-line', 40, 50, 520, 20, { heights: [1500] })])).toThrow(/não cabe/u);
    expect(() => planPdfLayout(document(), [item('huge-atomic', 40, 50, 520, 20, { heights: [500, 500], atomic: true })])).toThrow(/não cabe/u);
  });

  it('rejects duplicate IDs and invalid source page references instead of losing content silently', () => {
    expect(() => planPdfLayout(document(), [item('duplicate', 40, 50, 520, 20), item('duplicate', 40, 80, 520, 20)])).toThrow();
    expect(() => planPdfLayout(document(), [item('invalid-page', 40, 50, 520, 20, {}, 'paragraph', 2)])).toThrow();
    expect(() => planPdfLayout(document(), [item('invalid-page', 40, 50, 520, 20, {}, 'paragraph', 0)])).toThrow();
    const controller = new AbortController(); controller.abort();
    expect(() => planPdfLayout(document(), twoColumns(), controller.signal)).toThrow(/cancelad|abort/iu);
  });

  it('does not reproduce empty source pages and reports them without a false mapping', () => {
    const plan = planPdfLayout(document([page, { width: 595, height: 842 }, { width: 400, height: 600 }]), [item('last', 40, 70, 320, 40, {}, 'paragraph', 3)]);
    expect(plan.pages).toEqual([{ width: 400, height: 600, sourcePages: [3] }]);
    expect(plan.report.pages.map(value => value.outputPages)).toEqual([[], [], [1]]);
    expect(plan.placements[0].pageIndex).toBe(0);
    expectSafe(plan);
  });
});

function bottomOf(rect: SourceRect) { return rect.y + rect.height; }
