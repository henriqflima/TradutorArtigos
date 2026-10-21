import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { pdfSourceOptions } from './pdf-options';
import { MAX_FILE_BYTES, MAX_PDF_PAGES } from './shared';
import { createLocalOcr, OCR_FONT, type OcrLayout } from './local-ocr';
import {
  abortIfNeeded, blockText, sha256, type ContentRun, type DocumentAsset, type DocumentBlock,
  type DocumentIssue, type SourceRect, type StructuredDocument,
} from './structured-document';

type AssetKind = DocumentAsset['kind'];
type TextSpan = SourceRect & {
  id: number;
  page: number;
  text: string;
  font: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  suspect: boolean;
  ocrLine?: number;
};
type VisualRegion = { page: number; rect: SourceRect; kind: 'image' | 'vector'; count: number };
type ColumnZone = { top: number; bottom: number; split: number };
type SourcePage = { width: number; height: number; spans: TextSpan[]; visuals: VisualRegion[]; bodyFont: string; bodySize: number;
  split?: number | null; zones?: ColumnZone[]; ocr?: OcrLayout };
type Analysis = { pages: SourcePage[]; sourceName: string; sourceHash: string; issues: DocumentIssue[] };
type LinePart = { x: number; width: number; text?: string; assetId?: string; style?: { bold?: boolean; italic?: boolean; superscript?: boolean } };
type TextLine = { page: number; column: number; rect: SourceRect; parts: LinePart[]; firstSpan: number; fontSize: number; kind: 'paragraph' | 'heading' | 'caption' };

const MAX_CROP_PIXELS = 20_000_000;
const CROP_DPI = 400;
const PDF_SIGNATURE = '%PDF-';
const rawAnalysis = new WeakMap<StructuredDocument, Analysis>();

function issue(id: string, page: number, message: string, severity: DocumentIssue['severity'] = 'warning', blockId?: string): DocumentIssue {
  return { id, page, message, severity, ...(blockId ? { blockId } : {}) };
}

function rect(x: number, y: number, width: number, height: number): SourceRect {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

function right(box: SourceRect) { return box.x + box.width; }
function bottom(box: SourceRect) { return box.y + box.height; }
function area(box: SourceRect) { return box.width * box.height; }
function centerX(box: SourceRect) { return box.x + box.width / 2; }
function centerY(box: SourceRect) { return box.y + box.height / 2; }
function intersect(a: SourceRect, b: SourceRect) {
  return Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
}
function union(a: SourceRect, b: SourceRect): SourceRect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return rect(x, y, Math.max(right(a), right(b)) - x, Math.max(bottom(a), bottom(b)) - y);
}
function pad(box: SourceRect, amount: number, page: { width: number; height: number }): SourceRect {
  const x = Math.max(0, box.x - amount), y = Math.max(0, box.y - amount);
  return rect(x, y, Math.min(page.width, right(box) + amount) - x,
    Math.min(page.height, bottom(box) + amount) - y);
}
function padXY(box: SourceRect, horizontal: number, vertical: number, page: { width: number; height: number }): SourceRect {
  const x = Math.max(0, box.x - horizontal), y = Math.max(0, box.y - vertical);
  return rect(x, y, Math.min(page.width, right(box) + horizontal) - x,
    Math.min(page.height, bottom(box) + vertical) - y);
}
function overlapWithMargin(a: SourceRect, b: SourceRect, margin: number) {
  return a.x <= right(b) + margin && right(a) + margin >= b.x &&
    a.y <= bottom(b) + margin && bottom(a) + margin >= b.y;
}
function matrixMultiply(a: number[], b: number[]) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
function transformRect(box: [number, number, number, number], transform: number[], viewport: number[]): SourceRect {
  const composed = matrixMultiply(viewport, transform);
  const points = [
    [box[0], box[1]], [box[0], box[3]], [box[2], box[1]], [box[2], box[3]],
  ].map(([x, y]) => [composed[0] * x + composed[2] * y + composed[4], composed[1] * x + composed[3] * y + composed[5]]);
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return rect(x, y, Math.max(...xs) - x, Math.max(...ys) - y);
}

async function openPdf(data: Uint8Array) {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data, ...pdfSourceOptions() });
  return { pdf: await task.promise, ops: pdfjs.OPS };
}

function textSpans(content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>, pageNumber: number,
  viewport: ReturnType<PDFPageProxy['getViewport']>, fontNames: ReadonlyMap<string, string>, issues: DocumentIssue[]): TextSpan[] {
  const usage = new Map<string, number>();
  for (const item of content.items) if ('str' in item) usage.set(item.fontName, (usage.get(item.fontName) || 0) + item.str.trim().length);
  const bodyFont = [...usage].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const bodyChars = [...usage.values()].reduce((a, b) => a + b, 0);
  let serial = 0;
  let approximateMetrics = false;
  const spans: TextSpan[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue;
    const style = content.styles[item.fontName];
    const transform = matrixMultiply(viewport.transform, item.transform);
    const height = Math.max(1, Math.hypot(transform[2], transform[3]) || item.height);
    // PDF.js synthesizes a whitespace item whose geometric width can be the
    // entire gutter when a PDF paints the two columns alternately. It is a
    // separator, not text occupying the gutter; retaining it joins columns.
    if (!item.str.trim() && item.width > Math.max(15, height * 3)) continue;
    // Non-embedded Symbol/Type 1 fonts can expose NaN rather than omit these
    // metrics. Nullish coalescing retains NaN and loses the glyph's geometry.
    const hasAscent = typeof style?.ascent === 'number' && Number.isFinite(style.ascent);
    const hasDescent = typeof style?.descent === 'number' && Number.isFinite(style.descent);
    const ascent = hasAscent ? style.ascent : hasDescent ? 1 + style.descent : 0.8;
    if (!hasAscent) approximateMetrics = true;
    const x = transform[4], y = transform[5] - ascent * height;
    const width = Math.max(0.1, item.width);
    const name = (fontNames.get(item.fontName) || item.fontName).toLowerCase();
    const rareFont = item.fontName !== bodyFont && (usage.get(item.fontName) || 0) < Math.max(30, bodyChars * 0.035);
    const smallSymbol = item.str.trim().length <= 3 && /^[\p{L}\p{N}]+$/u.test(item.str.trim());
    const unusualGlyph = /[\u0000-\u001F\uE000-\uF8FF\uFFFD\u0370-\u03FF\u2200-\u22FF]/u.test(item.str);
    const suspect = unusualGlyph || (rareFont && smallSymbol && height <= 16);
    const bold = /bold|black|\.b(?:old)?$/i.test(style?.fontFamily || '') || /bold|black|\.b(?:old)?$/i.test(name);
    const italic = /italic|oblique|\.i(?:talic)?$/i.test(style?.fontFamily || '') || /italic|oblique|\.i(?:talic)?$/i.test(name);
    spans.push({ id: serial++, page: pageNumber, text: item.str, font: item.fontName,
      fontSize: height, bold, italic, suspect, x, y, width, height });
  }
  if (approximateMetrics) issues.push(issue(`approximate-font-metrics-${pageNumber}`, pageNumber,
    'Algumas fontes não informam métricas verticais confiáveis. A posição dos caracteres foi estimada; confira os símbolos e recortes nesta página.'));
  return spans;
}

/** PDF.js exposes both embedded image paints and vector paths as page operators. */
function visualRegions(pageNumber: number, page: PDFPageProxy, ops: Record<string, number>, operatorList: Awaited<ReturnType<PDFPageProxy['getOperatorList']>>) {
  const viewport = page.getViewport({ scale: 1 });
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const images: VisualRegion[] = [], paths: SourceRect[] = [];
  const imageOps = new Set([ops.paintImageXObject, ops.paintJpegXObject, ops.paintInlineImageXObject,
    ops.paintImageXObjectRepeat, ops.paintInlineImageXObjectGroup].filter(value => value !== undefined));
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const fn = operatorList.fnArray[i], args = operatorList.argsArray[i];
    if (fn === ops.save) stack.push([...ctm]);
    else if (fn === ops.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === ops.transform && Array.isArray(args) && args.length >= 6) ctm = matrixMultiply(ctm, args.slice(0, 6) as number[]);
    else if (imageOps.has(fn)) {
      // Image paint commands draw into the current transformed unit square.
      const bounds = transformRect([0, 0, 1, 1], ctm, viewport.transform);
      if (bounds.width > 12 && bounds.height > 12) images.push({ page: pageNumber, rect: bounds, kind: 'image', count: 1 });
    } else if (fn === ops.constructPath && Array.isArray(args) && args[2] &&
      typeof args[2] === 'object' && (args[2] as { length?: number }).length === 4) {
      const values = args[2] as ArrayLike<number>;
      const bounds = transformRect([values[0], values[1], values[2], values[3]], ctm, viewport.transform);
      if (bounds.width > 0.15 || bounds.height > 0.15) paths.push(bounds);
    }
  }
  // A plot consists of numerous touching or nearby paths. Group those paths,
  // but do not treat a single fraction bar or page rule as a figure.
  const parent = paths.map((_, i) => i);
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (overlapWithMargin(paths[i], paths[j], 5)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, { rect: SourceRect; count: number }>();
  paths.forEach((box, i) => {
    const key = find(i), group = groups.get(key);
    if (group) { group.rect = union(group.rect, box); group.count++; }
    else groups.set(key, { rect: box, count: 1 });
  });
  const vectors: VisualRegion[] = [];
  for (const group of groups.values()) {
    if (group.count < 8 || group.rect.width < 25 || group.rect.height < 25 || area(group.rect) < 1300) continue;
    if (images.some(image => intersect(image.rect, group.rect) > area(group.rect) * 0.6)) continue;
    vectors.push({ page: pageNumber, rect: group.rect, kind: 'vector', count: group.count });
  }
  return [...images, ...vectors].filter(region => {
    const box = region.rect;
    return box.x >= -2 && box.y >= -2 && right(box) <= viewport.width + 2 && bottom(box) <= viewport.height + 2;
  });
}

function extendVisualRegions(page: SourcePage) {
  // In scientific PDFs the plot image can exclude axis labels and panel letters
  // because they are drawn as separate text. Include nearby non-body annotations
  // while leaving captions outside the crop.
  for (const visual of page.visuals) {
    const base = visual.rect;
    let expanded = base;
    const captionTop = page.spans.filter(span =>
      /^(?:fig(?:ure|ura)?\.?|table|tabela)\s*\d+/i.test(span.text.trim()) &&
      span.y >= bottom(base) - 2 && span.y <= bottom(base) + 45 &&
      centerX(span) >= base.x - 25 && centerX(span) <= right(base) + 25)
      .reduce((minimum, span) => Math.min(minimum, span.y), Infinity);
    for (const span of page.spans) {
      const text = span.text.trim();
      if (!text || span.font === page.bodyFont || /^(?:fig(?:ure|ura)?\.?|table|tabela)\s*\d+/i.test(text)) continue;
      if (span.width > 80 || span.height > 16) continue;
      if (span.y >= captionTop - 2) continue;
      const horizontal = span.x < base.x && base.x - right(span) <= 30 &&
        centerY(span) >= base.y - 9 && centerY(span) <= bottom(base) + 9;
      const below = span.y >= bottom(base) - 2 && span.y - bottom(base) <= 18 &&
        centerX(span) >= base.x - 8 && centerX(span) <= right(base) + 8;
      const above = bottom(span) <= base.y + 2 && base.y - bottom(span) <= 12 &&
        centerX(span) >= base.x - 8 && centerX(span) <= right(base) + 8;
      if (horizontal || below || above) expanded = union(expanded, span);
    }
    visual.rect = padXY(expanded, 1.2, 1.2, page);
  }
  // Adjacent panels of one figure commonly share one caption (a/b). Merge
  // vertically stacked panels only if no caption separates them.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < page.visuals.length; i++) for (let j = i + 1; j < page.visuals.length; j++) {
      const a = page.visuals[i], b = page.visuals[j];
      const upper = a.rect.y < b.rect.y ? a : b;
      const lower = upper === a ? b : a;
      const gap = lower.rect.y - bottom(upper.rect);
      const xOverlap = Math.max(0, Math.min(right(a.rect), right(b.rect)) - Math.max(a.rect.x, b.rect.x));
      const similarWidth = Math.max(a.rect.width, b.rect.width) / Math.min(a.rect.width, b.rect.width) < 1.25;
      const aligned = Math.abs(centerX(a.rect) - centerX(b.rect)) < Math.min(a.rect.width, b.rect.width) * 0.2;
      if (gap < -25 || gap > 35 || !similarWidth || !aligned ||
        xOverlap < Math.min(a.rect.width, b.rect.width) * 0.65) continue;
      const captionBetween = page.spans.some(span =>
        /^(?:fig(?:ure|ura)?\.?|table|tabela)\s*\d+/i.test(span.text.trim()) &&
        span.y >= bottom(upper.rect) - 2 && span.y <= lower.rect.y + 2 &&
        centerX(span) >= Math.max(a.rect.x, b.rect.x) - 25 && centerX(span) <= Math.min(right(a.rect), right(b.rect)) + 25);
      if (captionBetween) continue;
      upper.rect = union(upper.rect, lower.rect);
      upper.count += lower.count;
      upper.kind = upper.kind === 'vector' || lower.kind === 'vector' ? 'vector' : 'image';
      page.visuals.splice(page.visuals.indexOf(lower), 1);
      merged = true; break outer;
    }
  }
}

function columnSplit(page: SourcePage) {
  if (page.split !== undefined) return page.split;
  const pairedFigures = page.visuals.some(left => centerX(left.rect) < page.width * 0.45 &&
    left.rect.height > 80 && page.visuals.some(other => centerX(other.rect) > page.width * 0.55 &&
      other.rect.height > 80 && right(left.rect) < other.rect.x - 10 &&
      Math.min(bottom(left.rect), bottom(other.rect)) - Math.max(left.rect.y, other.rect.y) > 50));
  const usable = layoutSpans(page).filter(span => span.font === page.bodyFont && span.text.trim().length >= 12 &&
    span.y > page.height * 0.06 && span.y < page.height * 0.94 && span.width < page.width * 0.52);
  if (usable.length < 30) {
    // Figure-heavy pages can have too little prose to establish two columns.
    // Figure-heavy pages can have one chart per column but too little prose to
    // establish a text gutter. Their disjoint, vertically overlapping chart
    // rectangles still establish independent left and right reading streams.
    return (page.split = pairedFigures ? page.width / 2 : null);
  }
  let best = { x: page.width / 2, crossing: Infinity, left: 0, right: 0 };
  for (let fraction = 0.43; fraction <= 0.57; fraction += 0.01) {
    const x = page.width * fraction;
    const left = usable.filter(span => right(span) < x - 2).length;
    const rightCount = usable.filter(span => span.x > x + 2).length;
    const crossing = usable.length - left - rightCount;
    if (crossing < best.crossing && left >= 12 && rightCount >= 12) best = { x, crossing, left, right: rightCount };
  }
  return (page.split = best.left >= 12 && best.right >= 12 && best.crossing / usable.length < 0.16 ? best.x :
    pairedFigures ? page.width / 2 : null);
}

function characterWeight(char: string) {
  return /[il.,;:'`!|]/.test(char) || /\s/.test(char) ? 0.45 : /[MW@#]/.test(char) ? 1.35 : 1;
}

function spanTextRect(span: TextSpan, start: number, end: number): SourceRect {
  const chars = Array.from(span.text), weights = chars.map(characterWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const before = weights.slice(0, start).reduce((sum, weight) => sum + weight, 0);
  const selected = weights.slice(start, end).reduce((sum, weight) => sum + weight, 0);
  return rect(span.x + span.width * before / total, span.y,
    Math.max(0.1, span.width * selected / total), span.height);
}

function layoutSpans(page: SourcePage): TextSpan[] {
  if (!page.ocr) return page.spans;
  const lines = new Map<number, TextSpan>();
  for (const span of page.spans) {
    const key = span.ocrLine ?? span.id, line = lines.get(key);
    if (line) { const box = union(line, span); Object.assign(line, box); line.text += ` ${span.text}`; }
    else lines.set(key, { ...span });
  }
  return [...lines.values()];
}

function detectColumnZones(page: SourcePage): ColumnZone[] {
  // Some journals put narrow article metadata beside a wide abstract, then
  // switch to equal-width body columns lower on the same page. Find a repeated
  // wide right-hand text origin and a parallel narrow left-hand stream.
  const candidates = layoutSpans(page).filter(span => span.text.trim().length > 35 &&
    span.x > page.width * 0.27 && span.x < page.width * 0.43 &&
    span.width > page.width * 0.5 && right(span) > page.width * 0.84);
  const groups: TextSpan[][] = [];
  for (const span of candidates) {
    const group = groups.find(entry => Math.abs(entry[0].x - span.x) < 10);
    if (group) group.push(span); else groups.push([span]);
  }
  const zones: ColumnZone[] = [];
  for (const group of groups) {
    if (group.length < 5) continue;
    const first = Math.min(...group.map(span => span.y));
    const last = Math.max(...group.map(span => bottom(span)));
    if (last - first < 55) continue;
    const rightStart = Math.min(...group.map(span => span.x));
    const left = page.spans.filter(span => span.y >= first - 22 && span.y <= last + 10 &&
      span.x < page.width * 0.17 && right(span) < rightStart - 18 && span.text.trim());
    if (left.length < 3) continue;
    const leftEnd = Math.max(...left.map(span => right(span)));
    zones.push({ top: Math.max(0, first - 22), bottom: Math.min(page.height, last + 16),
      split: (leftEnd + rightStart) / 2 });
  }
  return zones.sort((a, b) => a.top - b.top);
}

function splitAt(page: SourcePage, y: number) {
  return page.zones?.find(zone => y >= zone.top && y < zone.bottom)?.split ?? columnSplit(page);
}

function readingOrder<T extends { rect: SourceRect }>(page: SourcePage, items: readonly T[]): T[] {
  const bounds = [0, ...(page.zones || []).flatMap(zone => [zone.top, zone.bottom]), page.height + 2]
    .sort((a, b) => a - b).filter((value, index, all) => !index || value > all[index - 1]);
  const output: T[] = [];
  for (let index = 0; index < bounds.length - 1; index++) {
    const top = bounds[index], bottomY = bounds[index + 1];
    const local = items.filter(item => centerY(item.rect) >= top && centerY(item.rect) < bottomY);
    const split = splitAt(page, (top + bottomY) / 2);
    if (split === null) { output.push(...local.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)); continue; }
    const col = (item: T) => item.rect.x < split && right(item.rect) > split && item.rect.width > page.width * 0.48 ? 2 :
      centerX(item.rect) < split ? 0 : 1;
    const spanning = local.filter(item => col(item) === 2).sort((a, b) => a.rect.y - b.rect.y);
    let previous = top - 1;
    for (const marker of [...spanning, { rect: rect(0, bottomY + 1, 0, 0) } as T]) {
      for (const column of [0, 1]) output.push(...local.filter(item => col(item) === column &&
        item.rect.y >= previous && item.rect.y < marker.rect.y).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x));
      if (marker.rect.y <= bottomY) output.push(marker);
      previous = marker.rect.y;
    }
  }
  return output;
}

function splitSpan(span: TextSpan, assets: readonly DocumentAsset[], pageIssues: DocumentIssue[]): TextSpan[] {
  const relevant = assets.filter(asset => asset.page === span.page && intersect(asset.rect, span) > 0);
  if (!relevant.length) return [span];
  if (relevant.some(asset => intersect(asset.rect, span) / area(span) > 0.88)) return [];
  // PDF.js may coalesce a word into one text item. Approximate character boxes
  // only for a partial crop and report the uncertainty for review.
  const chars = Array.from(span.text);
  if (!chars.length) return [];
  const weights = chars.map(characterWeight);
  const total = weights.reduce((a, b) => a + b, 0);
  let x = span.x;
  const pieces: TextSpan[] = [];
  let current = '', start = x, extent = 0;
  const flush = () => {
    if (current) pieces.push({ ...span, text: current, x: start, width: extent });
    current = ''; extent = 0;
  };
  for (let i = 0; i < chars.length; i++) {
    const width = span.width * weights[i] / total;
    const character = rect(x, span.y, width, span.height);
    const remove = relevant.some(asset => intersect(asset.rect, character) >= area(character) * 0.45);
    if (remove) flush();
    else { if (!current) start = x; current += chars[i]; extent += width; }
    x += width;
  }
  flush();
  if (pieces.map(piece => piece.text).join('') !== span.text && pieces.length) {
    pageIssues.push(issue(`partial-span-${span.page}-${span.id}`, span.page,
      'O recorte intercepta parte de uma linha de texto; confira os caracteres antes e depois da região.'));
  }
  return pieces;
}

function inferLineKind(lineText: string, spans: readonly TextSpan[], bodySize: number): TextLine['kind'] {
  const text = lineText.trim();
  const avgSize = spans.reduce((sum, span) => sum + span.fontSize, 0) / Math.max(1, spans.length);
  if (/^(?:fig(?:ure|ura)?\.?|gr[aá]fico|esquema|table|tabela)\s*\d+[a-z]?[.:\s]/i.test(text) &&
    avgSize < bodySize * 0.94) return 'caption';
  if (/^(?:references|referências|abstract|resumo|conclusions?)$/i.test(text)) return 'heading';
  const startsWithMeasurement = /^\d+(?:[.,]\d+)?\s*(?:[µμnumcdk]?m(?:\/(?:min|s|h))?|[µμmnk]?s|k?g|[kMG]?Pa|[kM]?N|Hz|K)\b/u.test(text);
  if (!startsWithMeasurement && /^(?:\d{1,2}\.|\d{1,2}(?:\.\d{1,2})+\.?)\s+[\p{L}]/u.test(text) && text.length < 100) return 'heading';
  const maxFont = Math.max(...spans.map(span => span.fontSize), 0);
  if (text.length < 110 && maxFont > Math.max(11.5, bodySize * 1.42)) return 'heading';
  return 'paragraph';
}

function lineText(parts: readonly LinePart[], fontSize: number) {
  let text = '';
  let previous: LinePart | undefined;
  for (const part of parts) {
    if (!part.text) { previous = part; continue; }
    if (previous && part.x - (previous.x + previous.width) > Math.max(0.9, fontSize * 0.19) &&
      !/\s$/.test(text) && !/^\s/.test(part.text)) text += ' ';
    text += part.text;
    previous = part;
  }
  return text;
}

function linesFromSpans(page: SourcePage, remaining: TextSpan[], inlineAssets: DocumentAsset[], issues: DocumentIssue[]): TextLine[] {
  const width = page.width;
  const parents = remaining.map((_, index) => index);
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]));
  for (let i = 0; i < remaining.length; i++) for (let j = i + 1; j < remaining.length; j++) {
    const a = remaining[i], b = remaining[j];
    const gap = Math.max(0, Math.max(a.x - right(b), b.x - right(a)));
    if (Math.abs(centerY(a) - centerY(b)) < Math.min(5, Math.max(3, Math.min(a.height, b.height) * 0.6)) &&
      gap < 15) parents[find(j)] = find(i);
  }
  const rowBounds = new Map<number, SourceRect>();
  remaining.forEach((span, index) => {
    const key = find(index), existing = rowBounds.get(key);
    rowBounds.set(key, existing ? union(existing, span) : span);
  });
  const spanningRows = [...rowBounds.values()].filter(box => {
    const split = splitAt(page, centerY(box));
    const captionUnderWideFigure = page.visuals.some(visual => visual.rect.width > width * 0.5 &&
      box.y >= bottom(visual.rect) - 2 && box.y - bottom(visual.rect) < 40 &&
      Math.abs(centerX(box) - centerX(visual.rect)) < width * 0.2);
    return split !== null && box.x < split && right(box) > split &&
      (box.width > width * 0.48 || captionUnderWideFigure);
  });
  const bucket = (box: SourceRect) => {
    const split = splitAt(page, centerY(box));
    if (split === null) return 0;
    if (box.x < split && right(box) > split && box.width > width * 0.48) return 2;
    // Adjacent font runs can form one full-width row even if each run is
    // shorter than the gutter. This is common in article titles, bylines,
    // affiliations and wide captions above a two-column body.
    if (spanningRows.some(row => Math.abs(centerY(row) - centerY(box)) < 5 &&
      box.x >= row.x - 1 && right(box) <= right(row) + 1)) return 2;
    return centerX(box) < split ? 0 : 1;
  };
  const sorted = [...remaining].sort((a, b) => bucket(a) - bucket(b) || centerY(a) - centerY(b) || a.x - b.x);
  const groups: TextSpan[][] = [];
  for (const span of sorted) {
    let group: TextSpan[] | undefined = groups[groups.length - 1];
    if (span.ocrLine !== undefined) group = groups.find(entry => entry[0].ocrLine === span.ocrLine);
    if (!group || bucket(group[0]) !== bucket(span) ||
      (span.ocrLine === undefined && Math.abs(centerY(group[0]) - centerY(span)) > Math.max(4.6, span.fontSize * 0.58))) {
      group = []; groups.push(group);
    }
    group.push(span);
  }
  const lines: TextLine[] = [];
  for (const group of groups) {
    group.sort((a, b) => a.x - b.x || a.id - b.id);
    let box: SourceRect = group[0];
    for (const span of group.slice(1)) box = union(box, span);
    const dominantHeight = Math.max(...group.map(span => span.height));
    const dominantY = group.filter(span => span.height >= dominantHeight * 0.9).reduce((sum, span) => sum + span.y, 0) /
      Math.max(1, group.filter(span => span.height >= dominantHeight * 0.9).length);
    const parts: LinePart[] = group.map(span => {
      const superscript = span.height < dominantHeight * 0.85 && span.y < dominantY - 1.5;
      const style = span.bold || span.italic || superscript ? { bold: span.bold || undefined,
        italic: span.italic || undefined, superscript: superscript || undefined } : undefined;
      return { x: span.x, width: span.width, text: span.text, style };
    });
    parts.sort((a, b) => a.x - b.x);
    const fontSize = group.reduce((sum, span) => sum + span.fontSize, 0) / group.length;
    const text = lineText(parts, fontSize);
    const kind = inferLineKind(text, group, page.bodySize);
    lines.push({ page: group[0].page, column: bucket(group[0]), rect: box, parts,
      firstSpan: Math.min(...group.map(span => span.id)), fontSize, kind });
  }
  for (const asset of inlineAssets) {
    const target = lines.filter(line =>
      Math.abs(centerY(asset.rect) - centerY(line.rect)) < Math.max(7, line.rect.height * 0.85) &&
      asset.rect.x <= right(line.rect) + 15 && right(asset.rect) >= line.rect.x - 15)
      .sort((a, b) => Math.abs(centerY(asset.rect) - centerY(a.rect)) - Math.abs(centerY(asset.rect) - centerY(b.rect)))[0];
    if (target) {
      target.parts.push({ x: asset.rect.x, width: asset.rect.width, assetId: asset.id });
      target.parts.sort((a, b) => a.x - b.x);
      target.rect = union(target.rect, asset.rect);
    }
  }
  for (const asset of inlineAssets) {
    if (lines.some(line => line.parts.some(part => part.assetId === asset.id))) continue;
    const id = `orphan-inline-${asset.id}`;
    issues.push(issue(id, asset.page, 'Símbolo isolado sem linha de texto associada; revise sua posição.', 'blocking'));
    lines.push({ page: asset.page, column: bucket(asset.rect), rect: asset.rect,
      parts: [{ x: asset.rect.x, width: asset.rect.width, assetId: asset.id }],
      firstSpan: Number.MAX_SAFE_INTEGER, fontSize: Math.max(7, asset.rect.height), kind: 'paragraph' });
  }
  return lines;
}

function appendParts(runs: ContentRun[], parts: LinePart[], fontSize: number) {
  let previous: LinePart | undefined;
  for (const part of parts) {
    const gap = previous ? part.x - (previous.x + previous.width) : 0;
    if (previous?.assetId && previous.width > 15 && part.text && /^[\p{L}]/u.test(part.text) &&
      gap > -1 && !/^\s/u.test(part.text)) runs.push({ type: 'text', text: ' ' });
    const previousRun = runs[runs.length - 1];
    if (previous && gap > Math.max(0.9, fontSize * 0.19) && previousRun?.type === 'text' &&
      !/\s$/.test(previousRun.text) && (part.assetId || (part.text && !/^\s/.test(part.text)))) {
      previousRun.text += ' ';
    }
    if (part.assetId) runs.push({ type: 'asset', assetId: part.assetId });
    else if (part.text) {
      const style = part.style && Object.keys(part.style).length ? part.style : undefined;
      if (previousRun?.type === 'text' && JSON.stringify(previousRun.style || {}) === JSON.stringify(style || {})) previousRun.text += part.text;
      else runs.push({ type: 'text', text: part.text, ...(style ? { style } : {}) });
    }
    previous = part;
  }
}

function joinPhysicalLines(runs: ContentRun[], nextText: string, sourceCorpus: string) {
  const last = runs.at(-1);
  if (last?.type !== 'text') return;
  const match = last.text.match(/([\p{L}]+)-\s*$/u);
  // Prefer evidence elsewhere in the source before deciding whether a line-
  // final hyphen is a soft wrap or part of a compound scientific term.
  if (match && /^[\p{Ll}]/u.test(nextText.trimStart())) {
    const suffix = nextText.trimStart().match(/^[\p{L}]+/u)?.[0] || '';
    const prefix = match[1].toLowerCase(), next = suffix.toLowerCase();
    const hasWord = (word: string) => new RegExp(`(?:^|[^\\p{L}-])${word}(?![\\p{L}-])`, 'iu').test(sourceCorpus);
    const lexicalHyphen = /^[\p{Lu}]{2,}$/u.test(match[1]) ||
      /^(?:multi|semi|non|cross|high|low|pre|post|self)$/i.test(match[1]) ||
      sourceCorpus.includes(`${prefix}-${next}`) || sourceCorpus.includes(`${prefix}–${next}`) ||
      (!sourceCorpus.includes(`${prefix}${next}`) && hasWord(prefix) && hasWord(next));
    last.text = last.text.slice(0, match.index) + match[1] + (lexicalHyphen ? '-' : '');
  } else if (!/\s$/.test(last.text)) last.text += ' ';
}

function blocksFromLines(page: SourcePage, lines: TextLine[], sourceCorpus: string): DocumentBlock[] {
  const ordered = readingOrder(page, lines);
  const blocks: DocumentBlock[] = [];
  let previousLine: TextLine | undefined;
  for (const line of ordered) {
    const previous = blocks[blocks.length - 1];
    const lineGap = previousLine ? line.rect.y - bottom(previousLine.rect) : Infinity;
    const indent = previousLine && splitAt(page, centerY(line.rect)) !== null ? line.rect.x - previousLine.rect.x : 0;
    const isCaptionContinuation = previous?.kind === 'caption' && line.kind === 'paragraph' &&
      line.fontSize <= previous.fontSize * 1.18 &&
      /^[\p{Ll}\p{N}(]/u.test(lineText(line.parts, line.fontSize).trim());
    const continueBlock = previous && previousLine && previousLine.column === line.column &&
      (previous.kind === line.kind || isCaptionContinuation) && line.kind !== 'heading' &&
      lineGap >= -Math.max(5, line.fontSize * 0.65) && lineGap <= Math.max(9, line.fontSize * 1.45) &&
      !(indent > 7 && line.kind === 'paragraph') &&
      !(previousLine.parts.at(-1)?.text?.trim().endsWith('.') && lineGap > line.fontSize * 0.75);
    if (continueBlock) {
      joinPhysicalLines(previous.runs, line.parts.find(part => part.text?.trim())?.text || '', sourceCorpus);
      appendParts(previous.runs, line.parts, line.fontSize);
      previous.rect = union(previous.rect, line.rect);
    } else {
      const id = `p${line.page}-s${line.firstSpan}`;
      const block: DocumentBlock = { id, kind: line.kind, page: line.page, rect: { ...line.rect },
        runs: [], fontSize: line.fontSize };
      appendParts(block.runs, line.parts, line.fontSize);
      blocks.push(block);
    }
    previousLine = line;
  }
  return blocks;
}

function orderBlocks(page: SourcePage, blocks: DocumentBlock[]) {
  return readingOrder(page, blocks);
}

function mergeParagraphContinuations(blocks: DocumentBlock[], analysis: Analysis, issues: DocumentIssue[], sourceCorpus: string) {
  // A physical figure at the top of the next column may sit between the two
  // halves of one sentence. Keep it in the output, but translate the sentence
  // as one semantic paragraph. The source bbox remains the first fragment.
  for (let i = 0; i < blocks.length; i++) {
    const first = blocks[i];
    if (first.kind !== 'paragraph') continue;
    const firstText = blockText(first).trimEnd();
    if (!firstText || /[.!?;:]$/.test(firstText)) continue;
    let j = i + 1;
    while (j < blocks.length && blocks[j].page <= first.page + 1 &&
      (['figure', 'caption', 'equation', 'table'].includes(blocks[j].kind) ||
        (blocks[j].kind === 'paragraph' && blocks[j].page === first.page &&
          blocks[j].rect.y > analysis.pages[first.page - 1].height * 0.85 &&
          blocks[j].fontSize < first.fontSize * 0.9))) j++;
    const second = blocks[j];
    if (!second || second.kind !== 'paragraph' || second.page > first.page + 1) continue;
    const secondText = blockText(second).trimStart();
    if (!/^[\p{Ll}\d]/u.test(secondText)) continue;
    const crossedPage = second.page === first.page + 1;
    const page = analysis.pages[first.page - 1];
    const split = splitAt(page, centerY(first.rect));
    const crossedColumn = second.page === first.page && split !== null && centerX(first.rect) < split &&
      centerX(second.rect) > split && bottom(first.rect) > second.rect.y + 15 &&
      !(page.zones || []).some(zone => centerY(first.rect) >= zone.top && centerY(first.rect) < zone.bottom);
    if (!crossedPage && !crossedColumn) continue;
    // Only the last prose block in the current column/page may continue.
    if (blocks.slice(i + 1, j).some(block => block.kind === 'heading' ||
      (block.kind === 'paragraph' && !(block.page === first.page &&
        block.rect.y > page.height * 0.85 && block.fontSize < first.fontSize * 0.9)))) continue;
    const nextText = second.runs.map(run => run.type === 'text' ? run.text : '').find(value => value.trim()) || '';
    joinPhysicalLines(first.runs, nextText, sourceCorpus);
    first.runs.push(...second.runs);
    first.fragments = [...(first.fragments ?? [{ page: first.page, rect: { ...first.rect } }]),
      ...(second.fragments ?? [{ page: second.page, rect: { ...second.rect } }])];
    blocks.splice(j, 1);
    issues.push(issue(`continued-${first.id}`, first.page,
      `Parágrafo continuado ${crossedPage ? 'na página seguinte' : 'na coluna seguinte'}; confira a junção do texto.`, 'warning', first.id));
  }
}

function buildDocument(analysis: Analysis, assets: readonly DocumentAsset[]): StructuredDocument {
  const issues = [...analysis.issues];
  const sourceCorpus = analysis.pages.flatMap(page => page.spans.map(span => span.text)).join(' ').toLowerCase();
  const blocks: DocumentBlock[] = [];
  const unique = new Set<string>();
  for (const asset of assets) {
    if (unique.has(asset.id)) issues.push(issue(`duplicate-asset-${asset.id}`, asset.page, `Região ${asset.id} foi cadastrada mais de uma vez.`, 'blocking'));
    unique.add(asset.id);
    const page = analysis.pages[asset.page - 1];
    if (!page || asset.rect.x < 0 || asset.rect.y < 0 || right(asset.rect) > page.width + 0.5 || bottom(asset.rect) > page.height + 0.5) {
      issues.push(issue(`asset-bounds-${asset.id}`, asset.page, `Região ${asset.id} ultrapassa os limites da página.`, 'blocking'));
    }
  }
  for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) {
    const a = assets[i], b = assets[j];
    if (a.page !== b.page) continue;
    if (intersect(a.rect, b.rect) > Math.min(area(a.rect), area(b.rect)) * 0.25) {
      issues.push(issue(`asset-overlap-${a.id}-${b.id}`, a.page,
        `Regiões ${a.id} e ${b.id} se sobrepõem; ajuste os recortes para evitar duplicação.`, 'blocking'));
    }
  }
  for (let pageIndex = 0; pageIndex < analysis.pages.length; pageIndex++) {
    const page = analysis.pages[pageIndex], pageNumber = pageIndex + 1;
    const selected = assets.filter(asset => asset.page === pageNumber);
    const remaining = page.spans
      .filter(span => page.ocr || pageNumber === 1 || !(span.y < page.height * 0.078 && span.fontSize < page.bodySize * 0.93))
      .flatMap(span => splitSpan(span, selected, issues)).filter(span => span.text.length);
    const inline = selected.filter(asset => asset.kind === 'equation-inline');
    const lines = linesFromSpans(page, remaining, inline, issues);
    const pageBlocks = blocksFromLines(page, lines, sourceCorpus);
    for (const asset of selected.filter(asset => asset.kind !== 'equation-inline')) {
      pageBlocks.push({ id: `asset:${asset.id}`,
        kind: asset.kind === 'figure' ? 'figure' : asset.kind === 'table' ? 'table' : 'equation',
        page: pageNumber, rect: { ...asset.rect }, runs: [{ type: 'asset', assetId: asset.id }],
        fontSize: Math.max(8, Math.min(14, asset.rect.height / 2)), assetId: asset.id });
    }
    const ordered = orderBlocks(page, pageBlocks);
    const assignedCaptions = new Set<string>();
    for (const figure of ordered.filter(block => block.kind === 'figure').sort((a, b) => bottom(b.rect) - bottom(a.rect))) {
      const caption = ordered.filter(block => block.kind === 'caption' && !assignedCaptions.has(block.id) && block.rect.y >= bottom(figure.rect) - 2 &&
        block.rect.y - bottom(figure.rect) < 40 && Math.abs(centerX(block.rect) - centerX(figure.rect)) < page.width * 0.3)
        .sort((a, b) => a.rect.y - b.rect.y)[0];
      if (caption) { figure.captionId = caption.id; assignedCaptions.add(caption.id); }
      else issues.push(issue(`caption-${figure.id}`, pageNumber, 'Figura sem legenda associada automaticamente; revise a relação.', 'warning', figure.id));
    }
    blocks.push(...ordered);
  }
  mergeParagraphContinuations(blocks, analysis, issues, sourceCorpus);
  const document: StructuredDocument = { version: 1, sourceName: analysis.sourceName,
    sourceHash: analysis.sourceHash, sourceKind: 'pdf',
    pages: analysis.pages.map(page => ({ width: page.width, height: page.height })),
    blocks, assets: [...assets], issues };
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
  const page = await pdf.getPage(pageNumber);
  const size = page.getViewport({ scale: 1 });
  if (box.x < 0 || box.y < 0 || right(box) > size.width + 0.5 || bottom(box) > size.height + 0.5) throw new Error('O recorte ultrapassa os limites da página.');
  const scale = CROP_DPI / 72;
  const width = Math.ceil(box.width * scale), height = Math.ceil(box.height * scale);
  if (width * height > MAX_CROP_PIXELS || width > 10000 || height > 10000) throw new Error('O recorte excede o limite de 20 milhões de pixels.');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Não foi possível criar a imagem do recorte.');
  context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
  const task = page.render({ canvas, canvasContext: context, viewport: page.getViewport({ scale }),
    transform: [1, 0, 0, 1, -box.x * scale, -box.y * scale] });
  const abort = () => task.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try { await task.promise; abortIfNeeded(signal); }
  finally { signal?.removeEventListener('abort', abort); }
  const pngBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível codificar o recorte PNG.')), 'image/png'));
  canvas.width = canvas.height = 0;
  const png = new Uint8Array(await pngBlob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < png.length; offset += 8192) binary += String.fromCharCode(...png.subarray(offset, offset + 8192));
  const dataUrl = `data:image/png;base64,${btoa(binary)}`;
  return { id, kind, page: pageNumber, rect: { ...box }, widthPt: box.width, heightPt: box.height,
    png, dataUrl, sha256: await sha256(png), alt: kind === 'equation-inline' || kind === 'equation-block' ?
      'Equação preservada do documento original' : kind === 'table' ? 'Tabela preservada do documento original' : 'Figura preservada do documento original',
    ...(kind === 'equation-inline' ? { baselineOffsetPt: -1 } : {}) };
}

export async function cropPdfRegion(file: Blob, page: number, box: SourceRect, kind: AssetKind, id: string, signal?: AbortSignal): Promise<DocumentAsset> {
  abortIfNeeded(signal);
  if (file.size > MAX_FILE_BYTES) throw new Error('O PDF deve ter até 4 MB nesta análise.');
  const data = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder('ascii').decode(data.subarray(0, 5)) !== PDF_SIGNATURE) throw new Error('O arquivo não é um PDF válido.');
  const { pdf } = await openPdf(data);
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error('O PDF deve ter no máximo 20 páginas.');
    return await captureRegion(pdf, page, box, kind, id, signal);
  }
  finally { await pdf.destroy(); }
}

function detectEquationRegions(page: SourcePage, visuals: VisualRegion[]): SourceRect[] {
  const split = columnSplit(page);
  const candidates = page.spans.filter(span => span.suspect && !visuals.some(region => intersect(region.rect, span) > area(span) * 0.6));
  const result: SourceRect[] = [];
  for (const seed of candidates) {
    const col = split === null ? 0 : centerX(seed) < split ? 0 : 1;
    const near = page.spans.filter(span => Math.abs(centerY(span) - centerY(seed)) <= 16 &&
      (split === null || (centerX(span) < split ? 0 : 1) === col));
    const suspicious = near.filter(span => span.suspect);
    const text = near.map(span => span.text).join('');
    if (suspicious.length < 4 || !/(?:=|¼|cot|cosec|sin|cos|tan|\+|∑|∫)/i.test(text)) continue;
    let bounds = suspicious[0] as SourceRect;
    for (const span of suspicious.slice(1)) bounds = union(bounds, span);
    const sameRegion = near.filter(span => span.x >= bounds.x - 35 && span.x <= right(bounds) + 55 &&
      span.y >= bounds.y - 5 && span.y <= bottom(bounds) + 5);
    for (const span of sameRegion) bounds = union(bounds, span);
    // Include an equation number aligned at the right edge of the same strip.
    const number = near.find(span => /^\(\d+[a-z]?\)$/.test(span.text.trim()) && span.x > right(bounds) + 12);
    if (number) bounds = union(bounds, number);
    const padded = pad(bounds, 2.5, page);
    if (padded.width < 45 || padded.height < 10) continue;
    if (!result.some(other => intersect(other, padded) > Math.min(area(other), area(padded)) * 0.3)) result.push(padded);
  }
  return result;
}

function padInlineBetweenLines(page: SourcePage, source: SourceRect, horizontal: number) {
  const padded = padXY(source, horizontal, 1.7, page);
  let left = padded.x, end = right(padded), top = padded.y, foot = bottom(padded);
  for (const span of page.spans) {
    if (!span.text.trim()) continue;
    // Adjacent italic text advances can overlap a symbol's metric rectangle
    // slightly. Limit the padding at that boundary to avoid taking a stroke
    // from the preceding word into the preserved glyph.
    if (Math.abs(centerY(span) - centerY(source)) < source.height * 0.3) {
      if (right(span) >= padded.x && right(span) <= source.x + 0.2 && span.x < source.x - 0.2)
        left = Math.max(left, (right(span) + source.x) / 2 + 0.05);
      if (span.x <= right(padded) && span.x >= right(source) - 0.2 && right(span) > right(source) + 0.2)
        end = Math.min(end, (span.x + right(source)) / 2 - 0.05);
    }
    if (right(span) <= padded.x || span.x >= right(padded)) continue;
    if (bottom(span) < source.y && source.y - bottom(span) < 3)
      top = Math.max(top, bottom(span) + 0.2);
    if (span.y > bottom(source) && span.y - bottom(source) < 3)
      foot = Math.min(foot, span.y - 0.2);
  }
  return rect(left, top, end - left, foot - top);
}

function detectInlineMathExpressions(page: SourcePage, occupied: readonly SourceRect[]): SourceRect[] {
  const available = page.spans.filter(span => span.text.trim() &&
    !occupied.some(box => intersect(box, span) > area(span) * 0.5));
  const nextTo = (previous: SourceRect, maxGap: number, predicate: (span: TextSpan) => boolean) =>
    available.filter(span => span.x >= right(previous) - 0.6 && span.x - right(previous) < maxGap &&
      Math.abs(centerY(span) - centerY(previous)) < 6 && predicate(span))
      .sort((a, b) => Math.abs(a.x - right(previous)) - Math.abs(b.x - right(previous)))[0];
  const result: SourceRect[] = [];
  for (const seed of available) {
    // In some embedded fonts gamma is extracted as the ASCII "g" and equals
    // as "¼". Preserve the visual symbol, operator and numeric value as one
    // object so translation cannot move any component independently.
    if (!seed.suspect || !/^[\p{L}\p{S}]$/u.test(seed.text.trim())) continue;
    const operator = nextTo(seed, 5, span => /^[=¼≈≃]$/u.test(span.text.trim()));
    if (!operator) continue;
    const value = nextTo(operator, 5, span => /^\d+(?:[.,]\d+)?/u.test(span.text));
    if (!value) continue;
    const numeric = value.text.match(/^\d+(?:[.,]\d+)?[.,;:]?/u)![0];
    const valueBox = spanTextRect(value, 0, Array.from(numeric).length);
    const expression = padInlineBetweenLines(page, union(union(seed, operator), valueBox), 0.45);
    if (expression.width > 10 && expression.width < 90) result.push(expression);
  }
  for (const base of available) {
    // Capture scientific units such as 10⁻³ s⁻¹ as one inline image. The
    // leading "10" may be only the suffix of a prose text item.
    const match = base.text.match(/(\d{1,3})\s*$/u);
    if (!match || base.fontSize < 7) continue;
    const baseBox = spanTextRect(base, Array.from(base.text.slice(0, match.index)).length,
      Array.from(base.text.slice(0, match.index! + match[1].length)).length);
    const sign = (span: TextSpan) => span.fontSize < base.fontSize * 0.9 &&
      /^(?:[\u0000-\u001f−–-])\d*\s*$/u.test(span.text);
    const minus1 = nextTo(base, 2.5, sign);
    const power1 = minus1 && /\d/u.test(minus1.text) ? minus1 :
      minus1 && nextTo(minus1, 2.5, span => /^\d+\s*$/u.test(span.text) &&
        span.fontSize < base.fontSize * 0.9);
    const unit = power1 && nextTo(power1, 2.5, span => /^[\p{L}µμ]$/u.test(span.text.trim()) &&
      span.fontSize >= base.fontSize * 0.85);
    const minus2 = unit && nextTo(unit, 2.5, sign);
    const power2 = minus2 && /\d/u.test(minus2.text) ? minus2 :
      minus2 && nextTo(minus2, 2.5, span => /^\d+\s*$/u.test(span.text) &&
        span.fontSize < base.fontSize * 0.9);
    if (!minus1 || !power1 || !unit || !minus2 || !power2) continue;
    const power2Text = power2.text.match(/^[\u0000-\u001f−–-]?\d+/u)![0];
    const power2Box = spanTextRect(power2, 0, Array.from(power2Text).length);
    const box = [minus1, power1, unit, minus2, power2Box].reduce<SourceRect>((current, span) => union(current, span), baseBox);
    const expression = padInlineBetweenLines(page, box, 0.15);
    if (expression.width > 15 && expression.width < 80) result.push(expression);
  }
  for (const variable of available) {
    // A subscript can share a PDF.js text item with following prose or a
    // measurement (for example the lowered "y: 2.5" after an italic u).
    // Crop only its first glyph together with the base variable.
    // A lowered index in an ordinary body font is still mathematical. The
    // relative position and smaller size establish the pair independently of
    // the font rarity used to find standalone symbols.
    const baseMatch = variable.text.match(/(?:^|\s)([\p{L}])\s*$/u);
    if (!baseMatch) continue;
    const baseStart = Array.from(variable.text.slice(0, baseMatch.index)).length +
      Array.from(baseMatch[0]).indexOf(baseMatch[1]);
    const variableBox = spanTextRect(variable, baseStart, baseStart + 1);
    const subscript = available.filter(span => span !== variable &&
      span.x >= right(variableBox) - 0.3 && span.x - right(variableBox) < 1.5 &&
      span.y > variable.y + variable.fontSize * 0.2 &&
      span.y - variable.y < variable.fontSize * 0.65 &&
      span.fontSize < variable.fontSize * 0.87 &&
      /^[\p{L}](?=\s|[.,;:]|$)/u.test(span.text))
      .sort((a, b) => Math.abs(a.x - right(variableBox)) - Math.abs(b.x - right(variableBox)))[0];
    if (!subscript) continue;
    const firstGlyph = spanTextRect(subscript, 0, 1);
    // Proportional text-width allocation can run into the following colon;
    // a single small lowercase glyph is at most about 0.62 em here.
    firstGlyph.width = Math.min(firstGlyph.width, subscript.fontSize * 0.62);
    const expression = padInlineBetweenLines(page, union(variableBox, firstGlyph), 0.12);
    if (expression.width > 5 && expression.width < 35) result.push(expression);
  }
  return result.filter((box, index) => !result.some((other, otherIndex) => otherIndex < index &&
    intersect(box, other) > Math.min(area(box), area(other)) * 0.6));
}

function detectInlineRegions(page: SourcePage, occupied: readonly SourceRect[]) {
  const candidates = page.spans.filter(span => span.suspect && span.text.trim() &&
    !occupied.some(box => intersect(box, span) > area(span) * 0.5));
  return candidates.map(span => padInlineBetweenLines(page, span, 0.4)).filter((box, i, all) =>
    !all.some((other, j) => j < i && intersect(box, other) > Math.min(area(box), area(other)) * 0.6));
}

export async function analyzePdf(file: File, onProgress: (message: string) => void, signal?: AbortSignal): Promise<StructuredDocument> {
  abortIfNeeded(signal);
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('O PDF deve ter até 4 MB e não pode estar vazio.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== PDF_SIGNATURE) throw new Error('O arquivo não é um PDF válido.');
  const sourceHash = await sha256(bytes);
  const { pdf, ops } = await openPdf(bytes);
  const ocr = createLocalOcr(onProgress, signal);
  try {
    if (pdf.numPages < 1 || pdf.numPages > MAX_PDF_PAGES) throw new Error('O PDF deve ter no máximo 20 páginas.');
    const issues: DocumentIssue[] = [], pages: SourcePage[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      abortIfNeeded(signal);
      onProgress(`Analisando texto e elementos visuais: página ${number} de ${pdf.numPages}…`);
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      if (page.rotate % 180 !== 0) throw new Error(`Página ${number}: rotação de 90°/270° ainda não é suportada; gire o PDF antes de analisar.`);
      if (viewport.width > 3000 || viewport.height > 3000 || viewport.width < 100 || viewport.height < 100) throw new Error(`Página ${number}: dimensões não suportadas.`);
      const [text, operatorList] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
      const fontNames = new Map<string, string>();
      for (const id of Object.keys(text.styles)) {
        try {
          const entry = (page as unknown as { commonObjs: { get(name: string): { name?: string } } }).commonObjs.get(id);
          if (entry.name) fontNames.set(id, entry.name);
        } catch { /* fall back to PDF.js family and geometry */ }
      }
      let spans = textSpans(text, number, viewport, fontNames, issues);
      let recognition: OcrLayout | undefined;
      const sourceVisuals = visualRegions(number, page, ops, operatorList);
      const digitalCharacters = spans.reduce((sum, span) => sum + span.text.trim().length, 0);
      const imageCoverage = sourceVisuals.filter(region => region.kind === 'image').reduce((sum, region) => sum + area(region.rect), 0) /
        (viewport.width * viewport.height);
      if (digitalCharacters < 80 && imageCoverage > 0.5) {
        onProgress(`Reconhecendo texto da página ${number} de ${pdf.numPages} no navegador…`);
        try {
          recognition = await ocr.recognize(page, number);
          if (recognition.words.length) spans = recognition.words.map((word, id) => ({ ...word, id, page: number,
            font: OCR_FONT, fontSize: Math.max(3, word.height), bold: false, italic: false, ocrLine: word.line }));
          issues.push(issue(`ocr-review-${number}`, number,
            `Texto reconhecido por OCR local em inglês/português (confiança média ${Math.round(recognition.confidence)}%; ${recognition.lowConfidenceWords} palavras com baixa confiança). Confira texto e ordem de leitura; marque figuras, tabelas e toda equação/símbolo incorreto como recortes do original antes de confirmar esta página.`));
          if (recognition.usableCharacters < 20) {
            // Figure-only pages remain reviewable and intact. Weak recognition
            // must never become a silently empty page in the exported article.
            spans = [];
            recognition.figures = [{ x: 0, y: 0, width: viewport.width, height: viewport.height }];
            recognition.equations = [];
            issues.push(issue(`ocr-unusable-${number}`, number,
              'O OCR não encontrou prosa utilizável. A página será preservada integralmente como imagem do original; confira se ela contém somente figuras/equações. Se houver prosa a traduzir, reabra uma digitalização legível antes de continuar.'));
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          issues.push(issue(`ocr-failed-${number}`, number,
            `Falha no OCR local: ${error instanceof Error ? error.message : 'erro desconhecido'}. Reabra uma digitalização legível ou um PDF com texto selecionável.`, 'blocking'));
        }
      }
      const bodyFont = [...new Map(spans.map(span => [span.font, 0]))].map(([font]) =>
        [font, spans.filter(span => span.font === font).reduce((sum, span) => sum + span.text.length, 0)] as const)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const bodyHeights = spans.filter(span => span.font === bodyFont && span.text.trim()).map(span => span.fontSize).sort((a, b) => a - b);
      const bodySize = bodyHeights[Math.floor(bodyHeights.length / 2)] || 8;
      const visuals = recognition ? recognition.figures.map(box => ({ page: number, rect: box, kind: 'image' as const, count: 1 })) : sourceVisuals;
      if (!recognition && digitalCharacters < 80) issues.push(issue(`sparse-page-${number}`, number,
        digitalCharacters || visuals.length ? 'Esta página tem pouco texto digital. Confira se o texto e as regiões preservadas representam todo o conteúdo.' :
          'Nenhum texto ou elemento visual utilizável foi identificado nesta página. Reabra um PDF legível antes de continuar.',
        digitalCharacters || visuals.length ? 'warning' : 'blocking'));
      const pageModel: SourcePage = { width: viewport.width, height: viewport.height, spans, visuals, bodyFont, bodySize, ocr: recognition };
      extendVisualRegions(pageModel);
      pageModel.zones = detectColumnZones(pageModel);
      pages.push(pageModel);
      page.cleanup();
    }
    if (pages.slice(1).some(page => !page.ocr && page.spans.some(span =>
      span.y < page.height * 0.078 && span.fontSize < page.bodySize * 0.93 && span.text.trim()))) {
      issues.push(issue('running-headers', 1,
        'Cabeçalhos correntes e números de página foram separados do corpo para evitar repetições na tradução.'));
    }
    const analysis: Analysis = { pages, sourceName: file.name, sourceHash, issues };
    const assets: DocumentAsset[] = [];
    let next = 0;
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      abortIfNeeded(signal);
      const page = pages[pageIndex], number = pageIndex + 1;
      const equationBoxes = page.ocr ? page.ocr.equations.filter(box => !page.visuals.some(visual =>
        intersect(visual.rect, box) > area(box) * 0.5)).map(box => pad(box, 2, page)) : detectEquationRegions(page, page.visuals);
      const visualBoxes = page.visuals.map(visual => pad(visual.rect, visual.kind === 'vector' ? 4 : 1.3, page));
      const mathBoxes = detectInlineMathExpressions(page, [...equationBoxes, ...visualBoxes]);
      const inlineBoxes = detectInlineRegions(page, [...equationBoxes, ...visualBoxes, ...mathBoxes]);
      const candidates: { box: SourceRect; kind: AssetKind; source: string }[] = [
        ...visualBoxes.map((box, index) => ({ box, kind: 'figure' as const, source: page.visuals[index].kind })),
        ...equationBoxes.map(box => ({ box, kind: 'equation-block' as const, source: 'equation' })),
        ...mathBoxes.map(box => ({ box, kind: 'equation-inline' as const, source: 'math expression' })),
        ...inlineBoxes.map(box => ({ box, kind: 'equation-inline' as const, source: 'symbol' })),
      ];
      for (const candidate of candidates) {
        const id = `auto-${number}-${String(++next).padStart(3, '0')}`;
        try {
          onProgress(`Preservando ${candidate.source}: página ${number} de ${pages.length}…`);
          assets.push(await captureRegion(pdf, number, candidate.box, candidate.kind, id, signal));
        } catch (error) {
          if (signal?.aborted) throw error;
          issues.push(issue(`crop-failed-${id}`, number,
            `Não foi possível preservar uma região ${candidate.source} (${Math.round(candidate.box.x)}, ${Math.round(candidate.box.y)}, ${Math.round(candidate.box.width)} × ${Math.round(candidate.box.height)} pt): ${error instanceof Error ? error.message : 'erro desconhecido'}.`, 'blocking'));
        }
      }
      if (!equationBoxes.length && page.spans.some(span => /[=∑∫]/.test(span.text) &&
        !page.visuals.some(visual => intersect(visual.rect, span) > area(span) * 0.5))) {
        issues.push(issue(`possible-equation-${number}`, number, 'Há possíveis fórmulas que não foram classificadas automaticamente; revise esta página.'));
      }
      if (page.visuals.some(visual => visual.kind === 'vector')) issues.push(issue(`vector-review-${number}`, number,
        'Gráficos vetoriais foram agrupados por geometria; revise se os recortes incluem rótulos e curvas completos.'));
    }
    const result = buildDocument(analysis, assets);
    if (!result.blocks.length) result.issues.push(issue('empty-document', 1, 'Nenhum bloco de texto ou figura foi identificado.', 'blocking'));
    onProgress(`Análise concluída: ${result.blocks.length} blocos e ${result.assets.length} regiões preservadas.`);
    return result;
  } finally { await ocr.close(); await pdf.destroy(); }
}
