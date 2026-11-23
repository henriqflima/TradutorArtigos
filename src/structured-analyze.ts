import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfSourceOptions } from './pdf-options';
import { MAX_FILE_BYTES, MAX_PDF_PAGES, formatFileSize } from './shared';
import { createOcrClient, type OcrOptions } from './ocr-client';
import { layoutFromOcr, blocksFromOcr, isVisualRegion, ocrAssetId, type OcrLayout } from './ocr-layout';
import { appearanceForBlock, nativeTextSpans, type NativeTextSpan } from './pdf-appearance';
import { abortIfNeeded, sha256, type DocumentAsset, type DocumentBlock, type DocumentIssue, type SourceRect, type StructuredDocument } from './structured-document';

type SourcePage = { width: number; height: number; ocr?: OcrLayout; appearanceSpans?: NativeTextSpan[] };
type Analysis = { pages: SourcePage[]; sourceName: string; sourceHash: string; issues: DocumentIssue[] };
type AssetKind = DocumentAsset['kind'];
const MAX_CROP_PIXELS = 20_000_000;
const CROP_DPI = 400;
const PDF_SIGNATURE = '%PDF-';
const rawAnalysis = new WeakMap<StructuredDocument, Analysis>();
const right = (box: SourceRect) => box.x + box.width;
const bottom = (box: SourceRect) => box.y + box.height;
const area = (box: SourceRect) => box.width * box.height;
function intersect(a: SourceRect, b: SourceRect) {
  return Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
}
function issue(id: string, page: number, message: string, severity: DocumentIssue['severity'] = 'warning', blockId?: string): DocumentIssue {
  return { id, page, message, severity, ...(blockId ? { blockId } : {}) };
}

/** PDF.js validates and renders the original; extracted prose comes only from the OCR service. */
async function openPdf(data: Uint8Array, signal?: AbortSignal) {
  abortIfNeeded(signal);
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data, ...pdfSourceOptions() });
  const cancel = () => { void task.destroy(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try { return await task.promise; }
  catch (error) { await task.destroy(); abortIfNeeded(signal); throw error; }
  finally { signal?.removeEventListener('abort', cancel); }
}

function buildDocument(analysis: Analysis, assets: readonly DocumentAsset[]): StructuredDocument {
  const issues = [...analysis.issues], blocks: DocumentBlock[] = [];
  const unique = new Set<string>();
  for (const asset of assets) {
    if (unique.has(asset.id)) issues.push(issue(`duplicate-asset-${asset.id}`, asset.page, `Região ${asset.id} foi cadastrada mais de uma vez.`, 'blocking'));
    unique.add(asset.id);
    const page = analysis.pages[asset.page - 1];
    if (!page || ![asset.rect.x, asset.rect.y, asset.rect.width, asset.rect.height].every(Number.isFinite) ||
      asset.rect.width <= 0 || asset.rect.height <= 0 || asset.rect.x < 0 || asset.rect.y < 0 ||
      right(asset.rect) > page.width + 0.5 || bottom(asset.rect) > page.height + 0.5) {
      issues.push(issue(`asset-bounds-${asset.id}`, asset.page, `Região ${asset.id} ultrapassa os limites da página.`, 'blocking'));
    }
  }
  for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) {
    const a = assets[i], b = assets[j];
    if (a.page === b.page && intersect(a.rect, b.rect) > Math.min(area(a.rect), area(b.rect)) * 0.25) {
      issues.push(issue(`asset-overlap-${a.id}-${b.id}`, a.page, `Regiões ${a.id} e ${b.id} se sobrepõem; ajuste os recortes para evitar duplicação.`, 'blocking'));
    }
  }
  for (let index = 0; index < analysis.pages.length; index++) {
    const page = analysis.pages[index], number = index + 1;
    if (!page.ocr) continue;
    const result = blocksFromOcr(page.ocr, number, assets.filter(asset => asset.page === number));
    for (const block of result.blocks) {
      block.appearance = appearanceForBlock(block, page.appearanceSpans || [], page.width);
    }
    issues.push(...result.issues);
    for (const figure of result.blocks) {
      if ((figure.kind === 'figure' || figure.kind === 'table') && !figure.captionId) {
        issues.push(issue(`caption-${figure.id}`, number, 'Figura/tabela sem legenda associada automaticamente; revise a relação.', 'warning', figure.id));
      }
    }
    blocks.push(...result.blocks);
  }
  if (!blocks.length) issues.push(issue('empty-document', 1, 'Nenhum bloco de texto ou figura foi identificado.', 'blocking'));
  const document: StructuredDocument = { version: 1, sourceName: analysis.sourceName, sourceHash: analysis.sourceHash, sourceKind: 'pdf',
    pages: analysis.pages.map(({ width, height }) => ({ width, height })), blocks, assets: [...assets], issues };
  rawAnalysis.set(document, analysis);
  return document;
}

export function inheritAnalysisMetadata(from: StructuredDocument, to: StructuredDocument): void {
  const analysis = rawAnalysis.get(from);
  if (analysis) rawAnalysis.set(to, analysis);
}
export function rebuildDocument(document: StructuredDocument, assets: DocumentAsset[]): StructuredDocument {
  const analysis = rawAnalysis.get(document);
  if (!analysis) return { ...document, assets: [...assets], issues: [...document.issues,
    issue('analysis-unavailable', 1, 'A geometria original não está disponível nesta sessão; reabra o PDF antes de alterar recortes.', 'blocking')] };
  return buildDocument(analysis, assets);
}
export function replaceRegion(document: StructuredDocument, asset: DocumentAsset): StructuredDocument {
  return rebuildDocument(document, [...document.assets.filter(existing => existing.id !== asset.id), asset]);
}
export function removeRegion(document: StructuredDocument, assetId: string): StructuredDocument {
  return rebuildDocument(document, document.assets.filter(asset => asset.id !== assetId));
}

async function captureRegion(pdf: PDFDocumentProxy, pageNumber: number, box: SourceRect, kind: AssetKind, id: string, signal?: AbortSignal): Promise<DocumentAsset> {
  abortIfNeeded(signal);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) throw new Error('Página do recorte inválida.');
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 1 || box.height < 1) throw new Error('A região do recorte é inválida.');
  const page = await pdf.getPage(pageNumber), size = page.getViewport({ scale: 1 });
  if (box.x < 0 || box.y < 0 || right(box) > size.width + 0.5 || bottom(box) > size.height + 0.5) throw new Error('O recorte ultrapassa os limites da página.');
  const scale = CROP_DPI / 72, width = Math.ceil(box.width * scale), height = Math.ceil(box.height * scale);
  if (width * height > MAX_CROP_PIXELS || width > 10000 || height > 10000) throw new Error('O recorte excede o limite de 20 milhões de pixels.');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Não foi possível criar a imagem do recorte.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    const task = page.render({ canvas, canvasContext: context, viewport: page.getViewport({ scale }),
      transform: [1, 0, 0, 1, -box.x * scale, -box.y * scale] });
    const abort = () => task.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try { await task.promise; abortIfNeeded(signal); }
    finally { signal?.removeEventListener('abort', abort); }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Não foi possível codificar o recorte PNG.')), 'image/png'));
    abortIfNeeded(signal);
    const png = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < png.length; offset += 8192) binary += String.fromCharCode(...png.subarray(offset, offset + 8192));
    return { id, kind, page: pageNumber, rect: { ...box }, widthPt: box.width, heightPt: box.height,
      png, dataUrl: `data:image/png;base64,${btoa(binary)}`, sha256: await sha256(png),
      alt: kind.startsWith('equation') ? 'Equação preservada do documento original' : kind === 'table' ? 'Tabela preservada do documento original' : 'Figura preservada do documento original',
      ...(kind === 'equation-inline' ? { baselineOffsetPt: -1 } : {}) };
  } finally { canvas.width = canvas.height = 0; }
}

export async function cropPdfRegion(file: Blob, page: number, box: SourceRect, kind: AssetKind, id: string, signal?: AbortSignal): Promise<DocumentAsset> {
  abortIfNeeded(signal);
  if (file.size > MAX_FILE_BYTES) throw new Error(`O PDF deve ter até ${formatFileSize(MAX_FILE_BYTES)} nesta análise.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== PDF_SIGNATURE) throw new Error('O arquivo não é um PDF válido.');
  const pdf = await openPdf(bytes, signal);
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`O PDF deve ter no máximo ${MAX_PDF_PAGES} páginas.`);
    return await captureRegion(pdf, page, box, kind, id, signal);
  } finally { await pdf.destroy(); }
}

export async function analyzePdf(file: File, onProgress: (message: string) => void, signal?: AbortSignal, options: OcrOptions = {}): Promise<StructuredDocument> {
  abortIfNeeded(signal);
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error(`O PDF deve ter até ${formatFileSize(MAX_FILE_BYTES)} e não pode estar vazio.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== PDF_SIGNATURE) throw new Error('O arquivo não é um PDF válido.');
  const sourceHash = await sha256(bytes), pdf = await openPdf(bytes, signal);
  let ocr: ReturnType<typeof createOcrClient> | undefined;
  try {
    if (pdf.numPages < 1 || pdf.numPages > MAX_PDF_PAGES) throw new Error(`O PDF deve ter no máximo ${MAX_PDF_PAGES} páginas.`);
    const pages: SourcePage[] = [];
    // Validate the whole document before the first paid request, including late pages.
    for (let number = 1; number <= pdf.numPages; number++) {
      abortIfNeeded(signal);
      onProgress(`Conferindo o PDF antes do OCR: página ${number} de ${pdf.numPages}…`);
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      if (page.rotate % 180 !== 0) throw new Error(`Página ${number}: rotação de 90°/270° ainda não é suportada; gire o PDF antes de analisar.`);
      if (![viewport.width, viewport.height].every(value => Number.isFinite(value) && value >= 100 && value <= 3000)) {
        throw new Error(`Página ${number}: dimensões não suportadas.`);
      }
      pages.push({ width: viewport.width, height: viewport.height });
      page.cleanup();
    }
    if (options.ocrConfigured !== true) throw new Error('A análise de PDFs depende da configuração do serviço de reconhecimento de texto. Verifique a configuração do serviço e tente novamente.');
    ocr = createOcrClient(file, options, onProgress, signal);
    const issues: DocumentIssue[] = [];
    let failed = false;
    for (let index = 0; index < pages.length; index++) {
      abortIfNeeded(signal);
      const page = pages[index], number = index + 1;
      if (failed) {
        issues.push(issue(`ocr-failed-${number}`, number, 'O OCR desta página aguarda retomada após a falha na página anterior.', 'blocking'));
        continue;
      }
      onProgress(`Reconhecendo o texto da página ${number} de ${pages.length}…`);
      try {
        const recognition = layoutFromOcr(await ocr.recognize(number), page.width, page.height);
        page.ocr = recognition;
        issues.push(issue(`ocr-review-${number}`, number,
          `Texto reconhecido por OCR (${recognition.confidence === null ? 'confiança não informada' : `confiança média ${Math.round(recognition.confidence)}%`}; ${recognition.lowConfidenceBlocks} blocos com baixa confiança). Confira o texto, as fórmulas e a ordem de leitura. Se desejar manter a aparência de uma fórmula, preserve-a como recorte do original.`));
        if (!recognition.regions.length) {
          recognition.regions = [{ index: 0, type: 'image', rect: { x: 0, y: 0, width: page.width, height: page.height }, text: '', confidence: null }];
          issues.push(issue(`ocr-unusable-${number}`, number, 'O OCR não identificou conteúdo. A página foi preservada integralmente como imagem do original; se houver texto a traduzir, confira a legibilidade antes de continuar.'));
        } else if (recognition.usableCharacters < 20) {
          issues.push(issue(`ocr-sparse-${number}`, number, 'O OCR encontrou pouco texto nesta página. Confira se todo o conteúdo está representado antes de confirmar.'));
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        failed = true;
        issues.push(issue(`ocr-failed-${number}`, number, `Falha no reconhecimento de texto: ${error instanceof Error ? error.message : 'erro desconhecido'}. Retome a análise para processar as páginas pendentes.`, 'blocking'));
      }
    }
    // Native metrics enrich appearance only. A scan or a parsing failure retains
    // the required OCR text and conservative typographic defaults.
    for (let index = 0; index < pages.length; index++) {
      abortIfNeeded(signal);
      if (!pages[index].ocr) continue;
      onProgress(`Lendo a diagramação do original: página ${index + 1} de ${pages.length}…`);
      let nativePage: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined;
      try {
        nativePage = await pdf.getPage(index + 1);
        pages[index].appearanceSpans = nativeTextSpans(await nativePage.getTextContent(), nativePage.getViewport({ scale: 1 }));
      } catch {
        abortIfNeeded(signal);
      } finally { nativePage?.cleanup(); }
    }
    const assets: DocumentAsset[] = [];
    for (let index = 0; index < pages.length; index++) for (const region of pages[index].ocr?.regions.filter(isVisualRegion) || []) {
      abortIfNeeded(signal);
      const number = index + 1, kind: AssetKind = region.type === 'equation' ? 'equation-block' : region.type === 'table' ? 'table' : 'figure';
      try {
        onProgress(`Preservando região reconhecida: página ${number} de ${pages.length}…`);
        assets.push(await captureRegion(pdf, number, region.rect, kind, ocrAssetId(number, region.index), signal));
      } catch (error) {
        if (signal?.aborted) throw error;
        // Missing crops are diagnosed on every rebuild, so a manual repair clears the issue.
      }
    }
    const result = buildDocument({ pages, sourceName: file.name, sourceHash, issues }, assets);
    onProgress(`Análise concluída: ${result.blocks.length} blocos e ${result.assets.length} regiões preservadas.`);
    return result;
  } finally { await ocr?.close(); await pdf.destroy(); }
}
