import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePDFRawStream, degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts } from 'pdf-lib';
import { createMistralOcr, validateOcrResult } from '../src/mistral-ocr';
import { MAX_OCR_REQUEST_BYTES, MAX_OCR_RESPONSE_BYTES, type OcrResult } from '../src/ocr-contract';
import { MAX_FILE_BYTES, MAX_PDF_PAGES } from '../src/shared';

const { rasterizeMock } = vi.hoisted(() => ({ rasterizeMock: vi.fn() }));
vi.mock('../src/ocr-page-transport', () => ({ rasterizeOcrPage: rasterizeMock }));

const output = (): OcrResult => ({
  model: 'mistral-ocr-4-1',
  page: { width: 1200, height: 1600, confidence: 94, blocks: [
    { type: 'text', x: 50, y: 100, width: 500, height: 100, content: 'Scientific evidence.', confidence: 95 },
  ] }, usage: { pages: 1 },
});
async function fixture(pages = 2) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([600 + i, 800 + i]);
  return new File([new Uint8Array(await pdf.save())], 'scan.pdf', { type: 'application/pdf' });
}
async function sizedFixture(totalBytes: number) {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]); pdf.addPage([600, 800]);
  // Unused PDF resources can make the source larger than an individually extracted page.
  const reference = pdf.context.register(pdf.context.stream(new Uint8Array(1)));
  let streamBytes = totalBytes;
  for (let attempt = 0; attempt < 3; attempt++) {
    pdf.context.assign(reference, pdf.context.stream(new Uint8Array(streamBytes)));
    const bytes = new Uint8Array(await pdf.save({ useObjectStreams: false }));
    if (bytes.byteLength === totalBytes) return new File([bytes], 'large-valid.pdf', { type: 'application/pdf' });
    streamBytes += totalBytes - bytes.byteLength;
  }
  throw new Error('Could not construct the exact-size PDF fixture');
}
const client = (file: File, signal?: AbortSignal, code = '') => createMistralOcr(file, { code, ocrConfigured: true }, () => {}, signal);
function numbers(array: PDFArray) { return array.asArray().map(value => (value as PDFNumber).asNumber()); }
function content(stream: PDFRawStream) { return new TextDecoder().decode(decodePDFRawStream(stream).decode()); }
function multiply(a: number[], b: number[]) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { rasterizeMock.mockReset(); fetchMock = vi.fn(() => Promise.resolve(Response.json(output()))); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Mistral OCR browser client', () => {
  it('extracts only the requested source page and posts binary PDF with access code', async () => {
    const ocr = client(await fixture(), undefined, ' shared-code ');
    expect(fetchMock).not.toHaveBeenCalled();
    await ocr.recognize(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/ocr');
    expect(init.cache).toBe('no-store');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/pdf', 'X-Access-Code': 'shared-code' });
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    const pagePdf = await PDFDocument.load(init.body as ArrayBuffer);
    expect(pagePdf.getPageCount()).toBe(1);
    expect(pagePdf.getPage(0).getSize()).toEqual({ width: 601, height: 801 });
    await ocr.close();
  });

  it.each([
    { rotation: 0, unit: 1, partialCrop: false, box: [100, 200, 500, 700] },
    { rotation: 180, unit: 1, partialCrop: false, box: [100, 200, 500, 700] },
    { rotation: 180, unit: 2, partialCrop: false, box: [100, 200, 500, 700] },
    { rotation: 0, unit: 1, partialCrop: true, box: [40, 60, 500, 700] },
  ])('normalizes visible crop, orientation and units while retaining source PDF content: %j', async ({ rotation, unit, partialCrop, box }) => {
    const source = await PDFDocument.create(), original = source.addPage([600, 800]);
    original.setMediaBox(40, 60, 600, 800);
    original.setCropBox(...(partialCrop ? [0, 0, 500, 700] : [100, 200, 400, 500]) as [number, number, number, number]);
    original.setRotation(degrees(rotation));
    original.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
    const font = await source.embedFont(StandardFonts.Helvetica);
    const [left, bottom, right, top] = box, sourceX = left + 15, sourceY = bottom + 25;
    original.drawText('Crop visible text', { x: sourceX, y: sourceY, font, size: 12 });
    const file = new File([new Uint8Array(await source.save())], 'cropped.pdf', { type: 'application/pdf' });
    await client(file).recognize(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const normalized = await PDFDocument.load(init.body as ArrayBuffer), page = normalized.getPage(0);
    const width = (right - left) * unit, height = (top - bottom) * unit;
    expect(normalized.getPageCount()).toBe(1);
    expect(page.getMediaBox()).toEqual({ x: 0, y: 0, width, height });
    expect(page.getCropBox()).toEqual(page.getMediaBox());
    expect(page.getRotation().angle).toBe(0);
    expect(page.node.get(PDFName.of('UserUnit'))).toBeUndefined();
    const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    expect(xobjects.keys()).toHaveLength(1);
    const form = normalized.context.lookup(xobjects.values()[0]) as PDFRawStream;
    expect(numbers(form.dict.lookup(PDFName.of('BBox'), PDFArray))).toEqual(box);
    const fonts = form.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
    expect(fonts.keys().length).toBeGreaterThan(0);
    expect(content(form)).toContain(Buffer.from('Crop visible text').toString('hex').toUpperCase());
    // Follow the actual output PDF transforms to a known source text origin.
    // Its position in a top-left viewport must match PDF.js's visible crop.
    const streams = page.node.Contents() as PDFArray;
    const drawing = streams.asArray().map(ref => content(normalized.context.lookup(ref) as PDFRawStream)).join('\n');
    const matrices = [...drawing.matchAll(/([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+cm/g)]
      .map(match => match.slice(1).map(Number));
    let transform = [1, 0, 0, 1, 0, 0];
    for (const matrix of matrices) transform = multiply(transform, matrix);
    transform = multiply(transform, numbers(form.dict.lookup(PDFName.of('Matrix'), PDFArray)));
    const renderedX = transform[0] * sourceX + transform[2] * sourceY + transform[4];
    const renderedY = height - (transform[1] * sourceX + transform[3] * sourceY + transform[5]);
    expect(renderedX).toBeCloseTo((rotation === 180 ? right - sourceX : sourceX - left) * unit, 7);
    expect(renderedY).toBeCloseTo((rotation === 180 ? sourceY - bottom : top - sourceY) * unit, 7);
  });

  it.each([90, 270])('rejects source rotation %s before uploading a differently oriented page', async rotation => {
    const pdf = await PDFDocument.create();
    pdf.addPage([600, 800]).setRotation(degrees(rotation));
    const file = new File([new Uint8Array(await pdf.save())], 'rotated.pdf');
    await expect(client(file).recognize(1)).rejects.toThrow('90°/270°');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous recognition and reuses completed results without exposing cached mutations', async () => {
    const file = await fixture();
    const first = client(file), second = client(file);
    const [a, b] = await Promise.all([first.recognize(1), second.recognize(1)]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    a.page.blocks[0].content = 'edited';
    await first.close(); await second.close();
    const resumed = client(file);
    expect((await resumed.recognize(1)).page.blocks[0].content).toBe('Scientific evidence.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await resumed.close();
  });

  it('keeps caches separate for page, file, model and access code', async () => {
    const file = await fixture();
    await client(file).recognize(1);
    await client(file).recognize(2);
    await client(await fixture()).recognize(1);
    await client(file, undefined, 'other-code').recognize(1);
    await createMistralOcr(file, { ocrModel: 'mistral-ocr-4-1' }, () => {}).recognize(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('allows an immediate remount to reuse a request after the original subscriber cancels', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    const file = await fixture(), abort = new AbortController();
    const first = client(file, abort.signal);
    const cancelled = first.recognize(1).catch(error => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    const remounted = client(file), result = remounted.recognize(1);
    finish(Response.json(output()));
    await expect(result).resolves.toEqual(output());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await first.close(); await remounted.close();
  });

  it('aborts a request after all subscribers leave and the grace interval ends', async () => {
    let requestSignal!: AbortSignal;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal!;
      return new Promise<Response>((_resolve, reject) => requestSignal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')), { once: true }));
    });
    const abort = new AbortController(), ocr = client(await fixture(), abort.signal);
    const pending = ocr.recognize(1).catch(error => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    abort.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(249);
    expect(requestSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal.aborted).toBe(true);
    await ocr.close();
  });

  it('does not cancel a shared request while another subscriber is still listening', async () => {
    let finish!: (response: Response) => void, requestSignal!: AbortSignal;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal!;
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    const file = await fixture(), abort = new AbortController();
    const first = client(file, abort.signal), second = client(file);
    const cancelled = first.recognize(1).catch(error => error), received = second.recognize(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(requestSignal.aborted).toBe(false);
    finish(Response.json(output()));
    await expect(received).resolves.toEqual(output());
    await first.close(); await second.close();
  });

  it('rejects unavailable configuration, invalid page and already cancelled work before sending content', async () => {
    const file = await fixture();
    const unavailable = createMistralOcr(file, { ocrConfigured: false }, () => {});
    await expect(unavailable.recognize(1)).rejects.toThrow('MISTRAL_API_KEY');
    await expect(client(file).recognize(0)).rejects.toThrow('inválida');
    await expect(client(file).recognize(3)).rejects.toThrow('não existe');
    const abort = new AbortController(); abort.abort();
    await expect(client(file, abort.signal).recognize(1)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid, oversized and over-page-limit PDFs before sending content', async () => {
    await expect(client(new File(['not pdf'], 'scan.pdf')).recognize(1)).rejects.toThrow('PDF válido');
    await expect(client(new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'large.pdf')).recognize(1)).rejects.toThrow('7 MB');
    await expect(client(await fixture(MAX_PDF_PAGES + 1)).recognize(1)).rejects.toThrow('50 páginas');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts an exact 7 MB source while keeping each OCR request below its separate transport limit', async () => {
    const source = await sizedFixture(MAX_FILE_BYTES);
    expect(source.size).toBe(7_000_000);
    expect(source.size).toBeGreaterThan(MAX_OCR_REQUEST_BYTES);
    const ocr = client(source);
    await expect(ocr.recognize(2)).resolves.toEqual(output());
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = fetchMock.mock.calls[0][1].body as ArrayBuffer;
    expect(body.byteLength).toBeLessThan(MAX_OCR_REQUEST_BYTES);
    expect((await PDFDocument.load(body)).getPageCount()).toBe(1);
    expect(rasterizeMock).not.toHaveBeenCalled();
    await ocr.close();
  });

  it('accepts recognition of page 50 and rejects page 51 without another request', async () => {
    const ocr = client(await fixture(50));
    await expect(ocr.recognize(50)).resolves.toEqual(output());
    const body = fetchMock.mock.calls[0][1].body as ArrayBuffer;
    expect((await PDFDocument.load(body)).getPage(0).getSize()).toEqual({ width: 649, height: 849 });
    await expect(ocr.recognize(51)).rejects.toThrow('inválida');
    expect(fetchMock).toHaveBeenCalledOnce();
    await ocr.close();
  });

  it('paces new page requests for a 50-page File across clients sharing the session', async () => {
    const starts: number[] = [];
    fetchMock.mockImplementation(() => { starts.push(Date.now()); return Promise.resolve(Response.json(output())); });
    const file = await fixture(50), first = client(file), second = client(file);
    vi.useFakeTimers();
    const initial = first.recognize(1);
    await vi.advanceTimersByTimeAsync(0);
    await initial;
    expect(fetchMock).toHaveBeenCalledOnce();
    const pending = second.recognize(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_099);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(output());
    expect(starts).toEqual([starts[0], starts[0] + 2_100]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await first.close(); await second.close();
  });

  it.each([0, 2_099])('cancels a waiting large-document page at %s ms without sending or retrying it', async elapsed => {
    const file = await fixture(50), first = client(file);
    vi.useFakeTimers();
    const initial = first.recognize(1);
    await vi.advanceTimersByTimeAsync(0);
    await initial;
    const abort = new AbortController(), waitingClient = client(file, abort.signal);
    const pending = waitingClient.recognize(2).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(fetchMock).toHaveBeenCalledOnce();
    abort.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    await waitingClient.close(); await first.close();
  });

  it('adds no pacing delay to documents with at most 30 pages', async () => {
    const ocr = client(await fixture(30));
    await ocr.recognize(1);
    vi.useFakeTimers();
    const pending = ocr.recognize(2);
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual(output());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await ocr.close();
  });

  it('normalizes an extracted page exceeding the transport limit before sending it', async () => {
    const file = await fixture();
    const transportPdf = new Uint8Array(await (await fixture(1)).arrayBuffer());
    rasterizeMock.mockResolvedValue(transportPdf);
    vi.spyOn(PDFDocument.prototype, 'save').mockResolvedValue(new Uint8Array(MAX_OCR_REQUEST_BYTES + 1));
    await expect(client(file).recognize(1)).resolves.toEqual(output());
    expect(MAX_OCR_REQUEST_BYTES).toBe(4_000_000);
    expect(rasterizeMock).toHaveBeenCalledWith(file, 1, MAX_OCR_REQUEST_BYTES);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1].body as ArrayBuffer).byteLength).toBe(transportPdf.byteLength);
    expect(transportPdf.byteLength).toBeLessThan(MAX_OCR_REQUEST_BYTES);
  });

  it('does not send an oversized page when the transport normalization fails', async () => {
    const file = await fixture();
    rasterizeMock.mockRejectedValue(new Error('Could not normalize the large page'));
    vi.spyOn(PDFDocument.prototype, 'save').mockResolvedValue(new Uint8Array(MAX_OCR_REQUEST_BYTES + 1));
    await expect(client(file).recognize(1)).rejects.toThrow('Não foi possível separar esta página para OCR');
    expect(rasterizeMock).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 429, 502, 504])('never retries HTTP %s silently, and permits an explicit retry', async status => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(Response.json({ error: 'A página precisa de nova tentativa.' }, { status })));
    const ocr = client(await fixture());
    await expect(ocr.recognize(1)).rejects.toThrow('nova tentativa');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(ocr.recognize(1)).resolves.toEqual(output());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await ocr.close();
  });

  it('does not expose infrastructure HTML or a network error, and never retries either', async () => {
    const file = await fixture(), ocr = client(file);
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('<html>private provider details</html>', { status: 502 })));
    const htmlError = await ocr.recognize(1).catch(error => error as Error);
    expect((htmlError as Error).message).toContain('HTTP 502');
    expect((htmlError as Error).message).not.toContain('private');
    fetchMock.mockRejectedValueOnce(new TypeError('private provider details'));
    const networkError = await ocr.recognize(1).catch(error => error as Error);
    expect((networkError as Error).message).toContain('conexão');
    expect((networkError as Error).message).not.toContain('private');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await ocr.close();
  });

  it('enforces the response size even when content-length is missing', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(' '.repeat(MAX_OCR_RESPONSE_BYTES + 1), { headers: { 'Content-Type': 'application/json' } })));
    await expect(client(await fixture()).recognize(1)).rejects.toThrow('estrutura de OCR inválida');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies the timeout to a stalled response body as well as the initial fetch', async () => {
    const file = await fixture();
    let started!: () => void;
    const receiving = new Promise<void>(resolve => { started = resolve; });
    const cancel = vi.fn();
    fetchMock.mockImplementation(() => {
      started();
      return Promise.resolve(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
    });
    vi.useFakeTimers();
    const ocr = client(file), pending = ocr.recognize(1).catch(error => error as Error);
    await receiving;
    await vi.advanceTimersByTimeAsync(55_000);
    expect(((await pending) as Error).message).toContain('processada e cobrada');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    await ocr.close();
  });

  it('bounds total request and response reading time without silently resending the page', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('', 'AbortError')), { once: true });
    }));
    const ocr = client(await fixture());
    const pending = ocr.recognize(1).catch(error => error as Error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    // The timer began before fake timers were installed. A fresh explicit
    // request with another page starts the controlled timeout used below.
    const second = ocr.recognize(2).catch(error => error as Error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(55_000);
    expect(((await second) as Error).message).toContain('processada e cobrada');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await ocr.close();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(250);
  });
});

describe('OCR response validation', () => {
  it('retains missing confidence as null instead of inventing a score', () => {
    const input = output(); input.page.confidence = input.page.blocks[0].confidence = null;
    expect(validateOcrResult(input)).toEqual(input);
  });

  it.each([
    (input: OcrResult) => { input.page.blocks[0].width = 2000; },
    (input: OcrResult) => { input.page.blocks[0].x = -1; },
    (input: OcrResult) => { input.page.blocks[0].height = 0; },
    (input: OcrResult) => { input.page.blocks[0].confidence = 101; },
    (input: OcrResult) => { input.page.blocks[0].content = 'bad\u0000text'; },
    (input: OcrResult) => { input.page.width = Number.NaN; },
    (input: OcrResult) => { input.usage.pages = 2; },
  ])('rejects invalid coordinates, confidence, content and usage', mutate => {
    const input = output(); mutate(input);
    expect(() => validateOcrResult(input)).toThrow('estrutura de OCR inválida');
  });
});

