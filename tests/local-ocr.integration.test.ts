import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorker, PSM } from 'tesseract.js';
import { layoutFromOcr, residualVisualRegions } from '../src/local-ocr';

// Optional model-level smoke check: RUN_LOCAL_OCR_TEST=1 (OCR_PAGES=20 for a
// twenty-page workload). The browser fixture additionally checks PDF handling,
// local workers, asset URLs and CSP. No provider or external request is used.
describe('real local OCR models', () => {
  it.skipIf(process.env.RUN_LOCAL_OCR_TEST !== '1')('recognizes raster prose and protects graph/equation regions', async () => {
    const require = createRequire(import.meta.url);
    const pdfRequire = createRequire(require.resolve('pdfjs-dist/package.json'));
    const { createCanvas } = pdfRequire('@napi-rs/canvas');
    const canvas = createCanvas(1200, 1600), context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 1200, 1600);
    context.fillStyle = '#000'; context.font = '32px Arial';
    ['Scientific translation preserves every source image.',
      'The experiment measures pressure and temperature.',
      'These results require careful review before publication.'].forEach((text, index) => context.fillText(text, 80, 120 + index * 55));
    context.lineWidth = 4; context.beginPath(); context.moveTo(140, 470); context.lineTo(140, 800); context.lineTo(850, 800); context.stroke();
    context.beginPath(); context.moveTo(145, 770); context.lineTo(350, 720); context.lineTo(570, 590); context.lineTo(810, 500); context.stroke();
    context.fillText('Figure 1. Experimental measurements.', 80, 900);
    context.fillText('E = mc²', 300, 1100);
    const worker = await createWorker(['eng', 'por'], 1, { langPath: path.resolve('public/ocr/lang'), cacheMethod: 'none', errorHandler: () => {} });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: '240' });
      const pages = process.env.OCR_PAGES === '20' ? 20 : 1;
      for (let page = 1; page <= pages; page++) {
        const { data } = await worker.recognize(canvas.toBuffer('image/png'), {}, { text: true, blocks: true });
        const result = layoutFromOcr(data, 2, 600, 800);
        expect(result.words.map(word => word.text).join(' ')).toContain('Scientific translation');
        expect(result.usableCharacters).toBeGreaterThan(100);
        expect(result.confidence).toBeGreaterThan(70);
        expect(result.equations.length).toBeGreaterThan(0);
        const pixels = context.getImageData(0, 0, 1200, 1600).data;
        expect(residualVisualRegions(pixels, 1200, 1600, 600, 800, result.words).length).toBeGreaterThan(0);
      }
    } finally { await worker.terminate(); }
  }, 180_000);
});
