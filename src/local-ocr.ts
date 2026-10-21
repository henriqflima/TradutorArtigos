import type { PDFPageProxy } from 'pdfjs-dist';
import type { Page as RecognitionPage, Worker as RecognitionWorker } from 'tesseract.js';
import { abortIfNeeded, type SourceRect } from './structured-document';

const OCR_DPI = 240;
const MAX_OCR_PIXELS = 12_000_000;
const MAX_OCR_SIDE = 6000;
export const OCR_FONT = 'local-ocr';

export type OcrWord = SourceRect & { text: string; confidence: number; line: number; suspect: boolean };
export type OcrLayout = {
  words: OcrWord[];
  figures: SourceRect[];
  equations: SourceRect[];
  confidence: number;
  usableCharacters: number;
  lowConfidenceWords: number;
};

export function localOcrPaths(baseUrl: string) {
  const base = new URL('ocr/', baseUrl);
  return {
    workerPath: new URL('worker.min.js', base).href,
    corePath: new URL('core/', base).href,
    langPath: new URL('lang', base).href,
    workerBlobURL: false,
    // Do not retain article content or let an old language model override the
    // version shipped by this application through a browser cache database.
    cacheMethod: 'none',
    gzip: true,
  };
}

function boundedBox(box: { x0: number; y0: number; x1: number; y1: number },
  scale: number, width: number, height: number): SourceRect | null {
  if (![box.x0, box.y0, box.x1, box.y1, scale].every(Number.isFinite) || scale <= 0) return null;
  const x = Math.max(0, box.x0 / scale), y = Math.max(0, box.y0 / scale);
  const right = Math.min(width, box.x1 / scale), bottom = Math.min(height, box.y1 / scale);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Word coordinates are retained so protected crops can replace OCR spans. */
export function layoutFromOcr(data: Pick<RecognitionPage, 'blocks' | 'confidence'>,
  scale: number, width: number, height: number): OcrLayout {
  const words: OcrWord[] = [], figures: SourceRect[] = [], equations: SourceRect[] = [];
  let lineNumber = 0;
  for (const block of data.blocks || []) {
    if (/image/i.test(block.blocktype || '')) {
      const box = boundedBox(block.bbox, scale, width, height);
      if (box && box.width * box.height < width * height * 0.8) figures.push(box);
      continue;
    }
    for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) {
      const lineId = lineNumber++;
      const lineWords: OcrWord[] = [];
      for (const word of line.words || []) {
        const text = word.text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        const box = boundedBox(word.bbox, scale, width, height);
        if (!text || !box) continue;
        const confidence = Number.isFinite(word.confidence) ? Math.max(0, Math.min(100, word.confidence)) : 0;
        lineWords.push({ ...box, text, confidence, line: lineId,
          suspect: /[=≈≃∑∫√∂∇≤≥∞^_\u0370-\u03ff\u2200-\u22ff]/u.test(text) });
      }
      words.push(...lineWords);
      // This is only a candidate crop, never an OCR-to-math conversion. Keep
      // the source pixels for short operator-heavy display equations.
      const text = lineWords.map(word => word.text).join(' ');
      const proseWords = lineWords.filter(word => /^[\p{L}]{4,}[,.;:]?$/u.test(word.text)).length;
      if (lineWords.some(word => word.suspect) && proseWords <= 2 && text.length < 120) {
        const box = boundedBox(line.bbox, scale, width, height);
        if (box && box.width > 18 && box.height > 3) equations.push(box);
      }
    }
  }
  return { words, figures, equations,
    confidence: Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, data.confidence)) : 0,
    usableCharacters: words.filter(word => word.confidence >= 35 && /[\p{L}\p{N}]/u.test(word.text))
      .reduce((total, word) => total + word.text.replace(/[^\p{L}\p{N}]/gu, '').length, 0),
    lowConfidenceWords: words.filter(word => word.confidence < 65).length };
}

/** Locate substantial ink left outside OCR words (plots, drawings, tables).
 * The conservative candidates require the same page review as native PDFs. */
export function residualVisualRegions(pixels: Uint8ClampedArray, pixelWidth: number, pixelHeight: number,
  pageWidth: number, pageHeight: number, words: readonly OcrWord[]): SourceRect[] {
  const width = Math.max(1, Math.ceil(pageWidth)), height = Math.max(1, Math.ceil(pageHeight));
  const ink = new Uint8Array(width * height), mask = new Uint8Array(width * height);
  const scaleX = pixelWidth / width, scaleY = pixelHeight / height;
  for (const word of words) {
    const startX = Math.max(0, Math.floor(word.x - 2)), endX = Math.min(width, Math.ceil(word.x + word.width + 2));
    const startY = Math.max(0, Math.floor(word.y - 2)), endY = Math.min(height, Math.ceil(word.y + word.height + 2));
    for (let y = startY; y < endY; y++) mask.fill(1, y * width + startX, y * width + endX);
  }
  // Sampling each source point's cell, rather than just its center, retains
  // thin axes/rules when the OCR image is reduced back to PDF points.
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    if (mask[y * width + x]) continue;
    let dark = false;
    for (let py = Math.floor(y * scaleY); py < Math.min(pixelHeight, Math.ceil((y + 1) * scaleY)) && !dark; py++) {
      for (let px = Math.floor(x * scaleX); px < Math.min(pixelWidth, Math.ceil((x + 1) * scaleX)); px++) {
        const index = (py * pixelWidth + px) * 4;
        if (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722 < 165) { dark = true; break; }
      }
    }
    if (dark) ink[y * width + x] = 1;
  }
  const visited = new Uint8Array(ink.length), queue = new Int32Array(ink.length);
  const regions: SourceRect[] = [];
  for (let seed = 0; seed < ink.length; seed++) {
    if (!ink[seed] || visited[seed]) continue;
    let read = 0, end = 1, count = 0;
    queue[0] = seed; visited[seed] = 1;
    let left = seed % width, right = left, top = Math.floor(seed / width), bottom = top;
    while (read < end) {
      const point = queue[read++], x = point % width, y = Math.floor(point / width);
      count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (!ink[next] || visited[next]) continue;
        visited[next] = 1; queue[end++] = next;
      }
    }
    if (count < 120 || right - left < 28 || bottom - top < 24 ||
      (right - left) * (bottom - top) > pageWidth * pageHeight * 0.8) continue;
    regions.push({ x: Math.max(0, left - 4), y: Math.max(0, top - 4),
      width: Math.min(pageWidth, right + 5) - Math.max(0, left - 4),
      height: Math.min(pageHeight, bottom + 5) - Math.max(0, top - 4) });
  }
  return regions;
}

export function createLocalOcr(onProgress: (message: string) => void, signal?: AbortSignal) {
  let worker: RecognitionWorker | undefined;
  let initializing: Promise<RecognitionWorker> | undefined;
  let currentPage = 0;
  let closed = false;
  const terminate = () => { closed = true; void worker?.terminate(); worker = undefined; };
  signal?.addEventListener('abort', terminate, { once: true });

  async function getWorker() {
    abortIfNeeded(signal);
    if (!initializing) initializing = (async () => {
      const { createWorker, PSM } = await import('tesseract.js');
      onProgress('Carregando reconhecimento local de texto (inglês e português)…');
      let rejectStartup: (error: unknown) => void = () => {};
      const startupFailure = new Promise<never>((_, reject) => { rejectStartup = reject; });
      const startupTimeout = setTimeout(() => rejectStartup(new Error('O reconhecimento local não carregou em 60 segundos. Verifique os arquivos de OCR e reabra o PDF.')), 60_000);
      const abortStartup = () => rejectStartup(new DOMException('Operação cancelada.', 'AbortError'));
      signal?.addEventListener('abort', abortStartup, { once: true });
      const loading = createWorker(['eng', 'por'], 1, {
        ...localOcrPaths(new URL(import.meta.env.BASE_URL, window.location.href).href),
        errorHandler: error => rejectStartup(new Error(String(error))),
        logger: message => {
          if (message.status === 'recognizing text') onProgress(`OCR local: página ${currentPage} · ${Math.round(message.progress * 100)}%…`);
        },
      });
      // A cancelled initialization can still finish loading its local models.
      // Dispose it on arrival instead of leaving a worker alive in the session.
      void loading.then(created => { if (closed || signal?.aborted) void created.terminate(); }, () => {});
      let created: RecognitionWorker;
      try { created = await Promise.race([loading, startupFailure]); }
      finally { clearTimeout(startupTimeout); signal?.removeEventListener('abort', abortStartup); }
      if (closed || signal?.aborted) { await created.terminate(); abortIfNeeded(signal); throw new Error('OCR encerrado.'); }
      worker = created;
      await created.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: String(OCR_DPI) });
      return created;
    })();
    return initializing;
  }

  return {
    async recognize(page: PDFPageProxy, number: number): Promise<OcrLayout> {
      currentPage = number;
      const size = page.getViewport({ scale: 1 });
      const scale = Math.min(OCR_DPI / 72, Math.sqrt(MAX_OCR_PIXELS / (size.width * size.height)),
        MAX_OCR_SIDE / Math.max(size.width, size.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!context) throw new Error('Não foi possível renderizar a página para OCR local.');
      const task = page.render({ canvas, canvasContext: context, viewport, background: '#fff' });
      const cancelRender = () => task.cancel();
      signal?.addEventListener('abort', cancelRender, { once: true });
      try {
        await task.promise;
        abortIfNeeded(signal);
        const active = await getWorker();
        // blocks must be explicitly enabled in Tesseract.js 6+ to obtain
        // coordinates and confidence; text alone cannot preserve source crops.
        const recognition = active.recognize(canvas, {}, { text: true, blocks: true });
        const aborted = new Promise<never>((_, reject) => {
          const abort = () => reject(new DOMException('Operação cancelada.', 'AbortError'));
          signal?.addEventListener('abort', abort, { once: true });
          recognition.then(() => signal?.removeEventListener('abort', abort), () => signal?.removeEventListener('abort', abort));
          if (signal?.aborted) abort();
        });
        const { data } = await Promise.race([recognition, aborted]);
        abortIfNeeded(signal);
        const layout = layoutFromOcr(data, scale, size.width, size.height);
        const residual = residualVisualRegions(context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width, canvas.height, size.width, size.height, layout.words);
        layout.figures.push(...residual.filter(box => !layout.figures.some(existing =>
          Math.abs(existing.x - box.x) < 8 && Math.abs(existing.y - box.y) < 8)));
        return layout;
      } finally {
        signal?.removeEventListener('abort', cancelRender);
        canvas.width = canvas.height = 0;
      }
    },
    async close() {
      signal?.removeEventListener('abort', terminate);
      const active = worker; worker = undefined; closed = true;
      if (active) await active.terminate();
    },
  };
}
