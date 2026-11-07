import { degrees, PDFDocument, PDFName, PDFNumber, rgb, StandardFonts } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { rasterizeOcrPage } from '../src/ocr-page-transport';
import { pdfSourceOptions } from '../src/pdf-options';

GlobalWorkerOptions.workerSrc = workerUrl;
const status = document.querySelector<HTMLElement>('#result')!;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function render(bytes: Uint8Array, label: string) {
  const task = getDocument({ data: new Uint8Array(bytes), ...pdfSourceOptions() });
  try {
    const pdf = await task.promise, page = await pdf.getPage(1), viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise;
    const container = document.createElement('section'), title = document.createElement('h2'); title.textContent = label;
    container.append(title, canvas); document.querySelector('#previews')!.append(container);
    return { width: viewport.width, height: viewport.height, canvas };
  } finally { await task.destroy(); }
}
function pixel(canvas: HTMLCanvasElement, x: number, y: number) {
  const [r, g, b] = canvas.getContext('2d')!.getImageData(x, y, 1, 1).data;
  return { r, g, b };
}
async function run() {
  status.dataset.status = 'running';
  const failures: string[] = [];
  const onError = (event: ErrorEvent) => failures.push(event.message);
  window.addEventListener('error', onError);
  try {
    // An uncompressed source image is larger than 4 MB while the complete valid PDF is below 7 MB.
    const pdf = await PDFDocument.create();
    const width = 1250, height = 1250, channels = new Uint8Array(width * height * 3);
    let seed = 7919;
    for (let index = 0; index < channels.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; channels[index] = seed >>> 24; }
    const image = pdf.context.stream(channels, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 });
    const ref = pdf.context.register(image), page = pdf.addPage([600, 780]);
    const key = page.node.newXObject('Heavy', ref);
    page.node.addContentStream(pdf.context.register(pdf.context.stream(`q 520 0 0 520 40 130 cm /${key.asString().replace(/^\//, '')} Do Q`)));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('Heavy PDF: letters and source bytes must remain unchanged.', { x: 40, y: 700, size: 12, font });
    const source = await pdf.save({ useObjectStreams: true });
    assert(source.length > 4_000_000 && source.length <= 7_000_000, `Fixture size ${source.length}`);
    const file = new File([new Uint8Array(source)], 'heavy-page.pdf', { type: 'application/pdf' });
    const before = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const compressed = await rasterizeOcrPage(file, 1, 4_000_000);
    assert(compressed.length <= 4_000_000, `OCR transport too large ${compressed.length}`);
    const output = await PDFDocument.load(compressed);
    assert(output.getPageCount() === 1 && output.getPage(0).getWidth() === 600 && output.getPage(0).getHeight() === 780, 'Transport geometry changed');
    const after = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    assert(new Uint8Array(before).every((value, index) => value === new Uint8Array(after)[index]), 'The original source file was modified');
    await render(compressed, 'Cópia compacta para OCR');
    // Crop origin, 180-degree rotation and physical UserUnit must match the visible PDF.js page.
    const transformed = await PDFDocument.create(), original = transformed.addPage([700, 900]);
    original.setCropBox(50, 70, 500, 700); original.setRotation(degrees(180));
    original.node.set(PDFName.of('UserUnit'), PDFNumber.of(1.5));
    original.drawRectangle({ x: 80, y: 100, width: 50, height: 60, color: rgb(1, 0, 0) });
    const transformedBytes = await transformed.save();
    const raster = await rasterizeOcrPage(new File([new Uint8Array(transformedBytes)], 'transformed.pdf'), 1, 4_000_000);
    const a = await render(transformedBytes, 'Original com recorte, rotação e escala'), b = await render(raster, 'Cópia OCR com a mesma geometria');
    assert(a.width === b.width && a.height === b.height && a.width === 750 && a.height === 1050, 'Crop/Rotate/UserUnit geometry changed');
    for (const [x, y] of [[660, 90], [15, 15], [400, 400]]) {
      const originalPixel = pixel(a.canvas, x, y), rasterPixel = pixel(b.canvas, x, y);
      assert(Math.abs(originalPixel.r - rasterPixel.r) < 20 && Math.abs(originalPixel.g - rasterPixel.g) < 20 && Math.abs(originalPixel.b - rasterPixel.b) < 20, `Visible geometry moved at ${x}/${y}`);
    }
    let rejected = false;
    try { await rasterizeOcrPage(file, 1, 1000); } catch (error) { rejected = error instanceof Error && /imagens muito pesadas/.test(error.message); }
    assert(rejected, 'An impossibly small transport cap was not rejected clearly');
    assert(failures.length === 0, failures.join('; '));
    Object.assign(window, { ocrTransportSummary: { sourceBytes: source.length, transportBytes: compressed.length, geometry: [a.width, a.height], sourceUnchanged: true } });
    status.textContent = `OK: PDF original ${source.length} bytes → cópia OCR ${compressed.length} bytes; arquivo intacto, uma página, CropBox/Rotate/UserUnit preservados, limite impossível recusado.`;
    status.dataset.status = 'passed';
  } catch (error) {
    status.textContent = error instanceof Error ? error.stack || error.message : String(error); status.dataset.status = 'failed';
  } finally { window.removeEventListener('error', onError); }
}
void run();
