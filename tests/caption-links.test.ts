import { describe, expect, it } from 'vitest';
import { associateCaptions } from '../src/caption-links';
import type { DocumentBlock } from '../src/structured-document';

function block(id: string, kind: DocumentBlock['kind'], x: number, y: number, width = 220, height = 100, page = 1): DocumentBlock {
  return { id, kind, page, rect: { x, y, width, height }, fontSize: 10, runs: [] };
}

describe('conservative figure/table caption association', () => {
  it('links captions below figures and above tables without changing input blocks', () => {
    const blocks = [block('figure', 'figure', 40, 100), block('figure-caption', 'caption', 40, 208, 220, 25),
      block('table-caption', 'caption', 320, 80, 220, 15), block('table', 'table', 320, 100)];
    const before = structuredClone(blocks);
    expect([...associateCaptions(blocks)]).toEqual([['figure', 'figure-caption'], ['table', 'table-caption']]);
    expect(blocks).toEqual(before);
  });

  it('accepts a centered narrower figure or a shorter left-aligned caption', () => {
    expect(associateCaptions([block('figure', 'figure', 70, 100, 160), block('caption', 'caption', 40, 208, 220, 20)]).get('figure')).toBe('caption');
    expect(associateCaptions([block('figure', 'figure', 40, 100, 520), block('caption', 'caption', 40, 208, 220, 20)]).get('figure')).toBe('caption');
  });

  it('never associates a caption from another column, page, or a distant/overlapping region', () => {
    const figure = block('figure', 'figure', 40, 100);
    for (const caption of [block('caption', 'caption', 320, 205, 220, 20), block('caption', 'caption', 40, 205, 220, 20, 2),
      block('caption', 'caption', 40, 240, 220, 20), block('caption', 'caption', 40, 150, 220, 20)]) {
      expect(associateCaptions([figure, caption]).size).toBe(0);
    }
  });

  it('does not jump across intervening prose to associate a caption', () => {
    const blocks = [block('figure', 'figure', 40, 100), block('prose', 'paragraph', 40, 205, 220, 15), block('caption', 'caption', 40, 225, 220, 20)];
    expect(associateCaptions(blocks).size).toBe(0);
  });

  it('leaves equally plausible captions above and below for manual review', () => {
    const blocks = [block('figure', 'figure', 40, 100), block('above', 'caption', 40, 70, 220, 20), block('below', 'caption', 40, 211, 220, 20)];
    expect(associateCaptions(blocks).size).toBe(0);
  });

  it('does not assign a shared caption when two figures are equally plausible', () => {
    const blocks = [block('first', 'figure', 40, 50, 220, 100), block('shared', 'caption', 40, 160, 220, 20), block('second', 'figure', 40, 190, 220, 100)];
    expect(associateCaptions(blocks).size).toBe(0);
  });

  it('chooses the nearest edge and never duplicates an inferred caption link', () => {
    const blocks = [block('first', 'figure', 40, 50, 220, 100), block('shared', 'caption', 40, 155, 220, 20), block('second', 'figure', 40, 200, 220, 100)];
    const links = associateCaptions(blocks);
    expect([...links]).toEqual([['first', 'shared']]);
    expect(new Set(links.values()).size).toBe(links.size);
  });

  it('preserves explicit manual links ahead of geometry and reserves their captions', () => {
    const manual = block('manual', 'figure', 40, 50); manual.captionId = 'caption';
    const blocks = [manual, block('nearby', 'figure', 320, 400), block('caption', 'caption', 320, 505, 220, 20)];
    expect([...associateCaptions(blocks)]).toEqual([['manual', 'caption']]);
  });

  it('ignores invalid geometry and non-caption prose instead of fabricating relationships', () => {
    const invalid = block('invalid', 'caption', 40, 205, 220, 20); invalid.rect.x = Number.NaN;
    expect(associateCaptions([block('figure', 'figure', 40, 100), invalid, block('prose', 'paragraph', 40, 205, 220, 20)]).size).toBe(0);
  });
});
