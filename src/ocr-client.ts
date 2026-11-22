import { degrees, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { abortIfNeeded } from './structured-document';
import { MAX_FILE_BYTES, MAX_PDF_PAGES, formatFileSize } from './shared';
import { MAX_OCR_BLOCKS, MAX_OCR_REQUEST_BYTES, MAX_OCR_RESPONSE_BYTES, OCR_ENGINE, type OcrBlock, type OcrResult } from './ocr-contract';

export type OcrOptions = { code?: string; ocrConfigured?: boolean; ocrModel?: string };

const CLIENT_TIMEOUT_MS = 55_000;
const DETACH_GRACE_MS = 250;
const LARGE_DOCUMENT_INTERVAL_MS = 2_100;
class OcrClientError extends Error {}
const INVALID_RESPONSE = 'O servidor devolveu uma estrutura de OCR inválida. Tente retomar a análise.';
type Entry = {
  controller: AbortController;
  promise: Promise<OcrResult>;
  subscribers: number;
  settled: boolean;
  started: boolean;
  detachTimer?: ReturnType<typeof setTimeout>;
};
type Session = {
  source?: Promise<PDFDocument>; pageCount?: number; nextStartAt?: number;
  pages: Map<number, Promise<Uint8Array>>; entries: Map<string, Entry>;
};
// A File belongs to the open review session. Neither PDF bytes nor recognition
// results are written to browser storage, and abandoned files can be collected.
const sessions = new WeakMap<File, Session>();

function invalid(): never { throw new OcrClientError(INVALID_RESPONSE); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return invalid();
  return value;
}
function confidence(value: unknown): number | null { return value === null ? null : finite(value, 0, 100); }

export function validateOcrResult(value: unknown): OcrResult {
  const result = record(value), page = record(result.page), usage = record(result.usage);
  if (result.model !== OCR_ENGINE ||
      usage.pages !== 1 || !Array.isArray(page.blocks) || page.blocks.length > MAX_OCR_BLOCKS) return invalid();
  const width = finite(page.width, 1, 100_000), height = finite(page.height, 1, 100_000);
  let characters = 0;
  const blocks: OcrBlock[] = page.blocks.map(value => {
    const block = record(value);
    if (typeof block.type !== 'string' || !/^[a-z][a-z_]{0,39}$/.test(block.type) ||
        typeof block.content !== 'string' || block.content.length > 250_000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(block.content)) return invalid();
    characters += block.content.length;
    if (characters > 1_000_000) return invalid();
    const x = finite(block.x, 0, width), y = finite(block.y, 0, height);
    const blockWidth = finite(block.width, Number.MIN_VALUE, width - x);
    const blockHeight = finite(block.height, Number.MIN_VALUE, height - y);
    return { type: block.type, x, y, width: blockWidth, height: blockHeight, content: block.content,
      confidence: confidence(block.confidence) };
  });
  return { model: result.model, page: { width, height, blocks, confidence: confidence(page.confidence) }, usage: { pages: 1 } };
}

function sessionFor(file: File): Session {
  let session = sessions.get(file);
  if (!session) { session = { pages: new Map(), entries: new Map() }; sessions.set(file, session); }
  return session;
}

async function pagePdf(file: File, session: Session, pageNumber: number): Promise<Uint8Array> {
  let pending = session.pages.get(pageNumber);
  if (!pending) {
    pending = (async () => {
      if (!session.source) session.source = (async () => {
        if (!file.size || file.size > MAX_FILE_BYTES) throw new OcrClientError(`O PDF deve ter até ${formatFileSize(MAX_FILE_BYTES)} e não pode estar vazio.`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') throw new OcrClientError('O arquivo não é um PDF válido.');
        return PDFDocument.load(bytes, { updateMetadata: false });
      })().catch(error => { session.source = undefined; throw error; });
      const source = await session.source;
      session.pageCount = source.getPageCount();
      if (session.pageCount < 1 || session.pageCount > MAX_PDF_PAGES) throw new OcrClientError(`O PDF deve ter no máximo ${MAX_PDF_PAGES} páginas.`);
      if (pageNumber > session.pageCount) throw new OcrClientError('A página solicitada não existe neste PDF.');
      const original = source.getPage(pageNumber - 1);
      const media = original.getMediaBox(), crop = original.getCropBox();
      const coordinates = [media.x, media.y, media.width, media.height, crop.x, crop.y, crop.width, crop.height];
      if (!coordinates.every(Number.isFinite) || media.width <= 0 || media.height <= 0 || crop.width <= 0 || crop.height <= 0) {
        throw new OcrClientError('A página tem limites inválidos. Corrija o PDF antes de usar o OCR.');
      }
      const left = Math.max(media.x, crop.x), bottom = Math.max(media.y, crop.y);
      const right = Math.min(media.x + media.width, crop.x + crop.width);
      const top = Math.min(media.y + media.height, crop.y + crop.height);
      const rotation = ((original.getRotation().angle % 360) + 360) % 360;
      if (rotation !== 0 && rotation !== 180) {
        throw new OcrClientError('Páginas com rotação de 90°/270° ainda não são suportadas. Gire o PDF antes de analisar.');
      }
      const userUnitEntry = original.node.lookup(PDFName.of('UserUnit'));
      const requestedUnit = userUnitEntry instanceof PDFNumber ? userUnitEntry.asNumber() : 1;
      // PDF.js treats missing/invalid UserUnit as 1. Flatten a valid unit into
      // the output dimensions, matching its visible scale-1 viewport.
      const userUnit = Number.isFinite(requestedUnit) && requestedUnit > 0 ? requestedUnit : 1;
      const width = (right - left) * userUnit, height = (top - bottom) * userUnit;
      if (![width, height].every(value => Number.isFinite(value) && value >= 100 && value <= 3000)) {
        throw new OcrClientError('A área visível desta página tem dimensões não suportadas para OCR. Corrija o PDF antes de analisar.');
      }
      const output = await PDFDocument.create(), page = output.addPage([width, height]);
      // Embed the visible source box as vector/PDF content. Copying its page
      // dictionary unchanged would leave CropBox offsets and Rotate metadata
      // for the OCR service to interpret differently from the PDF.js preview.
      // A content-free source page remains a valid, blank normalized page.
      if (original.node.Contents()) {
        const embedded = await output.embedPage(original, { left, bottom, right, top });
        page.drawPage(embedded, { x: rotation === 180 ? width : 0, y: rotation === 180 ? height : 0,
          xScale: userUnit, yScale: userUnit, rotate: degrees(rotation) });
      }
      const bytes = await output.save({ useObjectStreams: true });
      if (bytes.byteLength > MAX_OCR_REQUEST_BYTES) {
        const { rasterizeOcrPage } = await import('./ocr-page-transport');
        return rasterizeOcrPage(file, pageNumber, MAX_OCR_REQUEST_BYTES);
      }
      return bytes;
    })().catch(error => {
      if (error instanceof OcrClientError) throw error;
      throw new OcrClientError('Não foi possível separar esta página para OCR. Confira se o PDF é válido e não está protegido.');
    });
    session.pages.set(pageNumber, pending);
    void pending.catch(() => { if (session.pages.get(pageNumber) === pending) session.pages.delete(pageNumber); });
  }
  return pending;
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_OCR_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    return invalid();
  }
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      abortIfNeeded(signal);
      const part = await reader.read();
      abortIfNeeded(signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_OCR_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); return invalid(); }
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid(); }
}

async function waitForRequestSlot(session: Session, signal: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  if (!session.pageCount || session.pageCount <= 30) return;
  const now = Date.now(), startAt = Math.max(now, session.nextStartAt ?? now);
  // Reserve synchronously: clients sharing a File must not reserve the same start time.
  session.nextStartAt = startAt + LARGE_DOCUMENT_INTERVAL_MS;
  const delay = startAt - now;
  if (delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, delay);
    const cancel = () => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      reject(new DOMException('Operação cancelada.', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  abortIfNeeded(signal);
}

async function requestPage(file: File, session: Session, pageNumber: number, code: string, signal: AbortSignal, onStart: () => void): Promise<OcrResult> {
  const bytes = await pagePdf(file, session, pageNumber);
  await waitForRequestSlot(session, signal);
  abortIfNeeded(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let expired = false;
  const timeout = setTimeout(() => { expired = true; controller.abort(); }, CLIENT_TIMEOUT_MS);
  try {
    abortIfNeeded(signal);
    onStart();
    const response = await fetch('/api/ocr', {
      method: 'POST', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/pdf', Accept: 'application/json', ...(code ? { 'X-Access-Code': code } : {}) },
      body: new Uint8Array(bytes).buffer,
    });
    const json = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json';
    if (!json) {
      void response.body?.cancel().catch(() => {});
      throw new OcrClientError(`O servidor não confirmou o OCR desta página (HTTP ${response.status}). Confira antes de reenviar; uma página recebida pode ter custo.`);
    }
    const result = await readResponse(response, controller.signal);
    abortIfNeeded(controller.signal);
    if (!response.ok) {
      const error = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).error : undefined;
      if (typeof error === 'string' && error.trim() && error.length <= 600 && !/[<>\u0000-\u001f\u007f]/u.test(error)) throw new OcrClientError(error);
      throw new OcrClientError(`Não foi possível reconhecer esta página (HTTP ${response.status}). Aguarde e tente retomar a análise.`);
    }
    return validateOcrResult(result);
  } catch (error) {
    if (expired) throw new OcrClientError('O OCR excedeu o tempo de espera. A página pode ter sido processada e cobrada; retome somente quando desejar reenviá-la.');
    abortIfNeeded(signal);
    if (error instanceof OcrClientError) throw error;
    throw new OcrClientError('Não foi possível confirmar o OCR desta página. Confira a conexão antes de retomar; uma página recebida pode ter custo.');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function subscribe(entry: Entry, session: Session, key: string, signal: AbortSignal): Promise<OcrResult> {
  abortIfNeeded(signal);
  if (entry.detachTimer) { clearTimeout(entry.detachTimer); entry.detachTimer = undefined; }
  entry.subscribers++;
  return new Promise((resolve, reject) => {
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      signal.removeEventListener('abort', cancel);
      entry.subscribers--;
      if (!entry.subscribers && !entry.settled) entry.detachTimer = setTimeout(() => {
        if (!entry.subscribers && !entry.settled) {
          entry.controller.abort();
          if (session.entries.get(key) === entry) session.entries.delete(key);
        }
      }, DETACH_GRACE_MS);
    };
    const cancel = () => {
      detach();
      // Remount grace can retain an in-flight request, but must not start a new paid request after cancellation.
      if (!entry.subscribers && !entry.started && !entry.settled) {
        entry.controller.abort();
        if (session.entries.get(key) === entry) session.entries.delete(key);
      }
      reject(new DOMException('Operação cancelada.', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    entry.promise.then(result => { if (!detached) { detach(); resolve(structuredClone(result)); } }, error => {
      if (!detached) { detach(); reject(error); }
    });
    if (signal.aborted) cancel();
  });
}

export function createOcrClient(file: File, options: OcrOptions, onProgress: (message: string) => void, signal?: AbortSignal) {
  const lifecycle = new AbortController();
  const cancel = () => lifecycle.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const code = options.code?.trim() || '';
  const model = options.ocrModel || OCR_ENGINE;
  return {
    async recognize(pageNumber: number): Promise<OcrResult> {
      abortIfNeeded(lifecycle.signal);
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PDF_PAGES) throw new OcrClientError('A página solicitada para OCR é inválida.');
      if (options.ocrConfigured === false) throw new OcrClientError('O serviço de reconhecimento de texto ainda não foi configurado. Retome a análise quando ele estiver disponível.');
      const session = sessionFor(file), key = JSON.stringify([pageNumber, model, code]);
      let entry = session.entries.get(key);
      onProgress(`Reconhecendo o texto da página ${pageNumber}…`);
      if (!entry || entry.controller.signal.aborted) {
        entry = { controller: new AbortController(), promise: undefined as unknown as Promise<OcrResult>, subscribers: 0, settled: false, started: false };
        const created = entry;
        created.promise = requestPage(file, session, pageNumber, code, created.controller.signal, () => { created.started = true; }).then(result => {
          created.settled = true;
          return result;
        }, error => {
          created.settled = true;
          if (session.entries.get(key) === created) session.entries.delete(key);
          throw error;
        }).finally(() => { if (created.detachTimer) clearTimeout(created.detachTimer); });
        session.entries.set(key, created);
      }
      return subscribe(entry, session, key, lifecycle.signal);
    },
    async close() { lifecycle.abort(); signal?.removeEventListener('abort', cancel); },
  };
}

