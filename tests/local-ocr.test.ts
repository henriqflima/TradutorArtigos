import { describe, expect, it } from 'vitest';
import type { Page } from 'tesseract.js';
import { layoutFromOcr, localOcrPaths, residualVisualRegions, type OcrWord } from '../src/local-ocr';

function recognition(lines: { text: string; confidence?: number; box?: number[] }[][], confidence = 88) {
  return { confidence, blocks: [{ blocktype: 'FLOWING_TEXT', paragraphs: [{ lines: lines.map((words, line) => ({
    bbox: { x0: 20, y0: 20 + line * 30, x1: 400, y1: 45 + line * 30 },
    words: words.map((word, index) => ({ text: word.text, confidence: word.confidence ?? confidence,
      bbox: { x0: word.box?.[0] ?? 20 + index * 70, y0: word.box?.[1] ?? 20 + line * 30,
        x1: word.box?.[2] ?? 80 + index * 70, y1: word.box?.[3] ?? 45 + line * 30 } })),
  })) }] }] } as unknown as Page;
}

describe('local OCR', () => {
  it('loads the worker, core and languages from the application origin without blob/CDN fallback', () => {
    const paths = localOcrPaths('https://local.example/app/');
    expect(paths.workerPath).toBe('https://local.example/app/ocr/worker.min.js');
    expect(paths.corePath).toBe('https://local.example/app/ocr/core/');
    expect(paths.langPath).toBe('https://local.example/app/ocr/lang');
    expect(paths.workerBlobURL).toBe(false);
    expect(paths.cacheMethod).toBe('none');
  });
  it('retains coordinates, line identity and uncertainty in PDF points for source crop review', () => {
    const data = recognition([[{ text: 'Scientific' }, { text: 'article', confidence: 42 }], [{ text: 'continued' }]]);
    const result = layoutFromOcr(data, 2, 612, 792);
    expect(result.words[0]).toMatchObject({ text: 'Scientific', x: 10, y: 10, width: 30, height: 12.5, line: 0 });
    expect(result.words[2].line).toBe(1);
    expect(result.lowConfidenceWords).toBe(1);
    expect(result.confidence).toBe(88);
    expect(result.usableCharacters).toBe(26);
    expect(result.equations).toEqual([]);
  });
  it('keeps equation candidates as source rectangles, never treating recognized math as a guaranteed formula', () => {
    const result = layoutFromOcr(recognition([[{ text: 'E' }, { text: '=' }, { text: 'mc2' }]]), 2, 612, 792);
    expect(result.equations).toHaveLength(1);
    expect(result.words[1].suspect).toBe(true);
    expect(result.equations[0]).toEqual({ x: 10, y: 10, width: 190, height: 12.5 });
  });
  it('does not fabricate usable prose from empty, invalid or untrustworthy recognition', () => {
    expect(layoutFromOcr({ blocks: null, confidence: 0 }, 2, 612, 792).usableCharacters).toBe(0);
    const result = layoutFromOcr(recognition([[{ text: 'garbled', confidence: 5 },
      { text: 'invalid', box: [NaN, 0, 100, 20] }, { text: '\u0000' }]]), 2, 612, 792);
    expect(result.usableCharacters).toBe(0);
    expect(result.words).toHaveLength(1);
  });
  it('finds substantial plot ink while excluding recognized prose pixels', () => {
    const width = 200, height = 200, pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    const black = (x: number, y: number) => { const index = (y * width + x) * 4; pixels[index] = pixels[index + 1] = pixels[index + 2] = 0; };
    for (let x = 20; x <= 150; x++) black(x, 150);
    for (let y = 65; y <= 150; y++) black(20, y);
    for (let x = 20; x < 120; x++) for (let y = 15; y < 25; y++) black(x, y);
    const words = [{ x: 20, y: 15, width: 100, height: 10, text: 'Scientific article', confidence: 90, line: 0, suspect: false }] satisfies OcrWord[];
    expect(residualVisualRegions(pixels, width, height, width, height, words)).toEqual([
      { x: 16, y: 61, width: 139, height: 94 },
    ]);
  });
});
