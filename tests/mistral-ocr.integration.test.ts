import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognizePdf } from '../netlify/functions/_shared/mistral';
import { layoutFromMistral } from '../src/ocr-layout';

// Opt-in only: RUN_MISTRAL_OCR_TEST=1 and MISTRAL_API_KEY must be supplied by
// the caller. This sends one synthetic scanned page to Mistral and has API cost.
// Ordinary tests and the browser fixture use simulated responses instead.
afterEach(() => vi.unstubAllGlobals());

describe('real Mistral OCR API', () => {
  it.skipIf(process.env.RUN_MISTRAL_OCR_TEST !== '1')('recognizes a synthetic scanned page with structured regions', async () => {
    const key = process.env.MISTRAL_API_KEY?.trim();
    expect(key, 'Configure MISTRAL_API_KEY antes de ativar o teste real.').toBeTruthy();
    vi.stubGlobal('Netlify', { env: { get: (name: string) => name === 'MISTRAL_API_KEY' ? key : process.env[name] } });
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
    const layout = layoutFromMistral(result, 600, 800);
    expect(result.model).toMatch(/^mistral-ocr-/);
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
