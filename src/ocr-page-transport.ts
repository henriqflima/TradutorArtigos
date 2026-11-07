import { PDFDocument } from 'pdf-lib';
import { pdfSourceOptions } from './pdf-options';

const MAX_PIXELS = 12_000_000;
const OCR_DPI = 200;
const JPEG_QUALITIES = [.94, .87, .8];

/** An oversized page gets a compact, disposable OCR copy; source bytes and export crops stay untouched. */
export async function rasterizeOcrPage(file: File, pageNumber: number, maxBytes: number): Promise<Uint8Array> {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Esta página precisa ser preparada no navegador para reconhecimento. Abra o PDF no aplicativo.');
  }
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Os parâmetros para preparar esta página de OCR são inválidos.');
  }
  const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
    import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  GlobalWorkerOptions.workerSrc = worker.default;
  const loading = getDocument({ data: new Uint8Array(await file.arrayBuffer()), ...pdfSourceOptions() });
  const canvas = document.createElement('canvas');
  try {
    const pdf = await loading.promise;
    if (pageNumber > pdf.numPages) throw new Error('A página solicitada não existe neste PDF.');
    const page = await pdf.getPage(pageNumber);
    if (page.rotate % 180 !== 0) throw new Error('Gire a página do PDF antes de preparar o reconhecimento.');
    const natural = page.getViewport({ scale: 1 });
    if (![natural.width, natural.height].every(value => Number.isFinite(value) && value >= 100 && value <= 3000)) {
      throw new Error('A página tem dimensões não suportadas para reconhecimento.');
    }
    // PDF.js applies CropBox, rotation and UserUnit. Reserve rounding headroom in the pixel cap.
    const scale = Math.min(OCR_DPI / 72, Math.sqrt((MAX_PIXELS - 10_000) / (natural.width * natural.height)));
    const viewport = page.getViewport({ scale });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('O navegador não conseguiu preparar a imagem desta página para reconhecimento.');
    await page.render({ canvas, canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
    for (const quality of JPEG_QUALITIES) {
      const jpeg = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível preparar a imagem desta página para reconhecimento.')), 'image/jpeg', quality);
      });
      // The PDF adds its own metadata/resources, so check the complete transport document too.
      if (jpeg.size >= maxBytes) continue;
      const output = await PDFDocument.create();
      const image = await output.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
      output.addPage([natural.width, natural.height]).drawImage(image, { x: 0, y: 0, width: natural.width, height: natural.height });
      const bytes = await output.save({ useObjectStreams: true });
      if (bytes.byteLength <= maxBytes) return bytes;
    }
    throw new Error('Esta página contém imagens muito pesadas para reconhecimento. Reduza o tamanho das imagens do PDF e tente novamente.');
  } finally {
    canvas.width = canvas.height = 0;
    await loading.destroy();
  }
}
