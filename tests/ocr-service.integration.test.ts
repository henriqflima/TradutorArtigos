import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognizePdf } from '../netlify/functions/_shared/ocr-service';
import { layoutFromOcr } from '../src/ocr-layout';

// Opt-in only: RUN_OCR_INTEGRATION_TEST=1 and the server OCR settings must be supplied by
// the caller. This sends one synthetic scanned page to the OCR service and may have a cost.
// Ordinary tests and the browser fixture use simulated responses instead.
afterEach(() => vi.unstubAllGlobals());

describe('live OCR service', () => {
  it.skipIf(process.env.RUN_OCR_INTEGRATION_TEST !== '1')('recognizes a synthetic scanned page with structured regions', async () => {
    for (const name of ['OCR_API_KEY', 'OCR_API_URL', 'OCR_MODEL']) {
      expect(Boolean(process.env[name]?.trim()), 'Configure ' + name + ' antes de ativar o teste real.').toBe(true);
    }
    vi.stubGlobal('Netlify', undefined);
    const require = createRequire(import.meta.url), pdfRequire = createRequire(require.resolve('pdfjs-dist/package.json'));
    const { createCanvas } = pdfRequire('@napi-rs/canvas');
    const canvas = createCanvas(1200, 1600), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1200, 1600);
    ctx.fillStyle = '#111'; ctx.font = 'bold 38px Arial'; ctx.fillText('Scientific translation test', 80, 110);
    ctx.font = '30px Arial';
    ['The experiment measures pressure and temperature.',
      'The material retains its original structure.',
      'Every scientific result requires careful review.'].forEach((text, i) => ctx.fillText(text, 80, 200 + i * 60));
    ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(120, 600); ctx.lineTo(120, 850); ctx.lineTo(950, 850); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(120, 830); ctx.lineTo(360, 770); ctx.lineTo(600, 670); ctx.lineTo(900, 620); ctx.stroke();
    ctx.fillText('Figure 1. Experimental measurements.', 80, 930);
    ctx.font = '42px Times New Roman'; ctx.fillText('E = mc²', 350, 1120);
    const pdf = await PDFDocument.create(), image = await pdf.embedPng(canvas.toBuffer('image/png'));
    pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
    const result = await recognizePdf(await pdf.save(), new AbortController().signal);
    const layout = layoutFromOcr(result, 600, 800);
    expect(result.model).toBe('ocr-v1');
    expect(result.usage.pages).toBe(1);
    expect(layout.regions.map(r => r.text).join(' ')).toMatch(/experiment measures pressure/i);
    expect(layout.usableCharacters).toBeGreaterThan(100);
    expect(layout.regions.length).toBeGreaterThan(1);
    for (const region of layout.regions) {
      expect(region.rect.x).toBeGreaterThanOrEqual(0); expect(region.rect.y).toBeGreaterThanOrEqual(0);
      expect(region.rect.x + region.rect.width).toBeLessThanOrEqual(600.01);
      expect(region.rect.y + region.rect.height).toBeLessThanOrEqual(800.01);
    }
  }, 60_000);
});
