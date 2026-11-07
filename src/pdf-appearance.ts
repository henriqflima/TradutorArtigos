import type { PDFPageProxy } from 'pdfjs-dist';
import type { BlockAppearance, DocumentBlock, SourceRect } from './structured-document';

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type Viewport = { width: number; height: number; transform: number[] };
/** Only measurements are retained; native prose never replaces the OCR result. */
export type NativeTextSpan = {
  rect: SourceRect;
  baselineY: number;
  characters: number;
  fontSize: number;
  fontFamily?: BlockAppearance['fontFamily'];
  bold?: boolean;
  italic?: boolean;
};

const right = (rect: SourceRect) => rect.x + rect.width;
const bottom = (rect: SourceRect) => rect.y + rect.height;
const area = (rect: SourceRect) => rect.width * rect.height;
function overlap(a: SourceRect, b: SourceRect) {
  return Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
}
function multiply(a: number[], b: number[]) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
function familyFor(name: string): BlockAppearance['fontFamily'] {
  if (/mono|courier|consolas|typewriter/i.test(name)) return 'monospace';
  if (/sans|arial|helvetica|calibri|verdana|tahoma|roboto/i.test(name)) return 'sans-serif';
  if (/serif|times|cambria|georgia|garamond|palatino|minion|roman/i.test(name)) return 'serif';
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function weightedMedian(spans: NativeTextSpan[]) {
  const sorted = [...spans].sort((a, b) => a.fontSize - b.fontSize);
  const target = sorted.reduce((sum, span) => sum + span.characters, 0) / 2;
  let cumulative = 0;
  for (const span of sorted) { cumulative += span.characters; if (cumulative >= target) return span.fontSize; }
  return sorted.at(-1)!.fontSize;
}

/** Convert PDF.js public text metrics to the same top-left coordinate space as OCR. */
export function nativeTextSpans(content: TextContent, viewport: Viewport): NativeTextSpan[] {
  if (viewport.transform.length !== 6 || !viewport.transform.every(Number.isFinite) ||
      ![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) return [];
  const scale = Math.hypot(viewport.transform[0], viewport.transform[1]);
  const result: NativeTextSpan[] = [];
  for (const item of content.items.slice(0, 30_000)) {
    if (!('str' in item) || !item.str.trim() || item.transform.length !== 6 ||
        !item.transform.every(Number.isFinite) || !Number.isFinite(item.width) || item.width <= 0) continue;
    const style = content.styles[item.fontName];
    if (style?.vertical) continue;
    const transform = multiply(viewport.transform, item.transform);
    const fontSize = Math.hypot(transform[2], transform[3]), baselineLength = Math.hypot(transform[0], transform[1]);
    // Angled labels and vertical writing do not describe the surrounding paragraph.
    if (fontSize < 4 || fontSize > 96 || baselineLength <= 0 || Math.abs(transform[1]) > baselineLength * .1) continue;
    const width = item.width * scale;
    const ascent = Number.isFinite(style?.ascent) && style.ascent >= .4 && style.ascent <= 1.5 ? style.ascent : .82;
    const descent = Number.isFinite(style?.descent) && style.descent >= -.6 && style.descent <= 0 ? style.descent : -.2;
    const along = [transform[0] / baselineLength * width, transform[1] / baselineLength * width];
    const up = [transform[2] / fontSize, transform[3] / fontSize];
    const points = [ascent, descent].flatMap(offset => [0, 1].map(end => ({
      x: transform[4] + along[0] * end + up[0] * fontSize * offset,
      y: transform[5] + along[1] * end + up[1] * fontSize * offset,
    })));
    const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
    const rect = { x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y };
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 ||
        rect.x < -2 || rect.y < -2 || right(rect) > viewport.width + 2 || bottom(rect) > viewport.height + 2) continue;
    const name = `${style?.fontFamily || ''} ${item.fontName}`;
    const fontFamily = familyFor(style?.fontFamily || '');
    result.push({ rect, baselineY: transform[5], characters: Math.min(10000, item.str.replace(/\s/gu, '').length), fontSize,
      ...(fontFamily ? { fontFamily } : {}),
      ...(/bold|semibold|demi|heavy|black/i.test(name) ? { bold: true } : {}),
      ...(/italic|oblique/i.test(name) ? { italic: true } : {}) });
  }
  return result;
}

function scannedAppearance(block: DocumentBlock): BlockAppearance | undefined {
  const text = block.originalText || block.runs.map(run => run.type === 'text' ? run.text : '').join('');
  // A wrapped OCR paragraph can suggest type size; a single bounding box cannot.
  if (/\n\s*\n/u.test(text)) return;
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 60 || ![block.rect.width, block.rect.height].every(value => Number.isFinite(value) && value > 0)) return;
  const fontSize = block.rect.height / ((lines.length - 1) * 1.2 + 1);
  const maxSize = block.kind === 'heading' ? 44 : block.kind === 'caption' ? 16 : 24;
  const expectedWidth = Math.max(...lines.map(line => [...line].length)) * fontSize * .48;
  if (fontSize < 7 || fontSize > maxSize || expectedWidth > block.rect.width * 1.3 || expectedWidth < block.rect.width * .3) return;
  return { fontSize, lineHeight: fontSize * 1.2, confidence: 'estimated' };
}

/** Infer style for a whole OCR block without changing any source/translated runs. */
export function appearanceForBlock(block: DocumentBlock, spans: NativeTextSpan[], pageWidth: number): BlockAppearance | undefined {
  if (!['paragraph', 'heading', 'caption'].includes(block.kind)) return;
  const fragments = block.fragments?.filter(fragment => fragment.page === block.page).map(fragment => fragment.rect) || [];
  const regions = fragments.length ? fragments : [block.rect];
  const inRegion = (span: NativeTextSpan, rect: SourceRect) => overlap(span.rect, rect) / area(span.rect) >= .65;
  const matched = spans.filter(span => inRegion(span, block.rect) || regions.some(rect => inRegion(span, rect)));
  if (!matched.length) return scannedAppearance(block);
  const fontSize = weightedMedian(matched);
  const bodySpans = matched.filter(span => span.fontSize >= fontSize * .8 && span.fontSize <= fontSize * 1.2);
  const total = bodySpans.reduce((sum, span) => sum + span.characters, 0);
  const families = new Map<NonNullable<BlockAppearance['fontFamily']>, number>();
  for (const span of bodySpans) if (span.fontFamily) families.set(span.fontFamily, (families.get(span.fontFamily) || 0) + span.characters);
  const dominantFamily = [...families].sort((a, b) => b[1] - a[1])[0];
  const appearance: BlockAppearance = { fontSize, confidence: 'native',
    ...(dominantFamily && dominantFamily[1] >= total * .6 ? { fontFamily: dominantFamily[0] } : {}),
    ...(bodySpans.reduce((sum, span) => sum + (span.bold ? span.characters : 0), 0) >= total * .75 ? { bold: true } : {}),
    ...(bodySpans.reduce((sum, span) => sum + (span.italic ? span.characters : 0), 0) >= total * .75 ? { italic: true } : {}) };
  // A merged paragraph can cross columns. Estimate line geometry within its most informative fragment.
  const alignmentSpans = regions.map(rect => bodySpans.filter(span => inRegion(span, rect))).reduce<NativeTextSpan[]>((best, candidate) =>
    candidate.reduce((count, span) => count + span.characters, 0) > best.reduce((count, span) => count + span.characters, 0) ? candidate : best, []);
  const lines: { y: number; left: number; right: number }[] = [];
  for (const span of [...alignmentSpans].sort((a, b) => a.baselineY - b.baselineY)) {
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.y - span.baselineY) < Math.max(1, fontSize * .2)) {
      previous.left = Math.min(previous.left, span.rect.x); previous.right = Math.max(previous.right, right(span.rect));
    } else lines.push({ y: span.baselineY, left: span.rect.x, right: right(span.rect) });
  }
  if (lines.length > 1) {
    const steps = lines.slice(1).map((line, index) => line.y - lines[index].y).filter(step => step >= fontSize && step <= fontSize * 1.8);
    if (steps.length) appearance.lineHeight = median(steps);
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    const left = spread(lines.map(line => line.left)), rightSpread = spread(lines.map(line => line.right));
    const center = spread(lines.map(line => (line.left + line.right) / 2));
    const tolerance = Math.max(2, fontSize * .6);
    const continuation = lines.slice(1), indent = lines[0].left - median(continuation.map(line => line.left));
    // An indented first line shares the right edge of justified prose. It is not evidence of right alignment.
    const hasContinuation = (block.fragments?.length || 0) > 1;
    const indentedProse = block.kind === 'paragraph' && (lines.length >= 3 || hasContinuation) &&
      !/^(?:header|footer|page_number|aside_text|code)$/u.test(block.sourceRole || '') &&
      indent >= tolerance && indent <= fontSize * 3 && spread(continuation.map(line => line.left)) < tolerance &&
      (lines.length >= 3 ? spread(lines.slice(0, -1).map(line => line.right)) : rightSpread) < tolerance;
    if (indentedProse) appearance.alignment = 'justify';
    else if (center < tolerance && left > fontSize) appearance.alignment = 'center';
    else if (rightSpread < tolerance && left > fontSize) appearance.alignment = 'right';
    else if (left < tolerance) {
      appearance.alignment = lines.length >= 3 && spread(lines.slice(0, -1).map(line => line.right)) < tolerance ? 'justify' : 'left';
    }
  } else if (block.kind === 'heading' && Number.isFinite(pageWidth) &&
      Math.abs((block.rect.x + block.rect.width / 2) - pageWidth / 2) < Math.max(6, fontSize * .5) && block.rect.width < pageWidth * .85) {
    appearance.alignment = 'center';
  }
  return appearance;
}
