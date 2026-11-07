import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import regularFontUrl from './fonts/NotoSerif-Regular.ttf?url';
import boldFontUrl from './fonts/NotoSerif-Bold.ttf?url';
import italicFontUrl from './fonts/NotoSerif-Italic.ttf?url';
import boldItalicFontUrl from './fonts/NotoSerif-BoldItalic.ttf?url';
import { abortIfNeeded, type ContentRun, type DocumentAsset, type DocumentBlock, type RunStyle, type SourceRect, type TranslatedDocument } from './structured-document';
import { planPdfLayout, type PdfLayoutItem, type PdfLayoutReport } from './pdf-layout';

type Ready = { assets: Map<string, DocumentAsset>; runs: Map<string, ContentRun[]>; captions: Set<string> };
type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };
type Family = 'serif' | 'sans-serif' | 'monospace';
type FontSet = Record<Family, Fonts>;
type Piece = { type: 'text'; text: string; style: RunStyle; width: number; size: number } |
  { type: 'asset'; asset: DocumentAsset; width: number; height: number; offset: number };
type Line = { pieces: Piece[]; width: number; above: number; below: number; height: number; paragraphEnd: boolean };
type TextLayout = { lines: Line[]; size: number; fonts: Fonts; alignment: 'left' | 'center' | 'right' | 'justify' };
type VisualLayout = { asset: DocumentAsset; width: number; height: number; gap: number; caption?: TextLayout; captionAbove: boolean; total: number };
type Layout = { type: 'text'; value: TextLayout } | { type: 'visual'; value: VisualLayout };
let unicodeFontBytes: Promise<Uint8Array[]> | undefined;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const isVisual = (block: DocumentBlock) => ['equation', 'figure', 'table'].includes(block.kind);
const lineHeight = (layout: TextLayout) => layout.lines.reduce((sum, line) => sum + line.height, 0);
const fontFor = (fonts: Fonts, style: RunStyle) => style.bold ? style.italic ? fonts.boldItalic : fonts.bold : style.italic ? fonts.italic : fonts.regular;

/** OCR line endings describe source wrapping, rather than translated paragraph breaks. */
export function normalizePdfTextRuns(runs: readonly ContentRun[], block: Pick<DocumentBlock, 'kind' | 'sourceRole'>): ContentRun[] {
  let previousEndedWithCr = false;
  const normalized = runs.map(run => {
    if (run.type === 'asset') { previousEndedWithCr = false; return { ...run }; }
    const text = (previousEndedWithCr && run.text.startsWith('\n') ? run.text.slice(1) : run.text).replace(/\r\n?/g, '\n');
    previousEndedWithCr = run.text.endsWith('\r');
    return { ...run, text };
  });
  if (!['paragraph', 'caption'].includes(block.kind) || /^(?:list|references?|code|header|footer|aside_text)$/u.test(block.sourceRole || '')) return normalized;
  const plain = normalized.map(run => run.type === 'text' ? run.text : '\ufffc').join('');
  const replacements = new Map<number, string>();
  const structured = (line: string) => /^\s*(?:[-*•‣–—]\s|(?:\[\d+\]|\d+[.)]|[A-Za-z][.)])\s|\$|\\[[(])/u.test(line) ||
    /^\s{2,}\S/u.test(line) || /\|/u.test(line) || line.trim() === '\ufffc';
  for (let index = plain.indexOf('\n'); index >= 0; index = plain.indexOf('\n', index + 1)) {
    const before = plain.slice(0, index), after = plain.slice(index + 1);
    const previousLine = before.slice(before.lastIndexOf('\n') + 1), nextLine = after.split('\n', 1)[0];
    // Blank paragraphs, enumerations, code, references and standalone math stay explicit.
    if (!previousLine.trim() || !nextLine.trim() || structured(previousLine) || structured(nextLine) || /:\s*$/u.test(previousLine)) continue;
    replacements.set(index, /-\s*$/u.test(previousLine) || /\s$/u.test(previousLine) || /^\s/u.test(nextLine) ? '' : ' ');
  }
  let offset = 0;
  return normalized.map(run => {
    if (run.type === 'asset') { offset++; return run; }
    const start = offset; offset += run.text.length;
    return { ...run, text: run.text.replace(/\n/g, (_char, index: number) => replacements.get(start + index) ?? '\n') };
  });
}

async function documentFonts(pdf: PDFDocument, ready: Ready, signal?: AbortSignal): Promise<FontSet> {
  const characters = new Set([...ready.runs.values()].flatMap(runs => runs.flatMap(run => run.type === 'text' ? [...run.text.replace(/[\r\n\t]/g, '')] : [])));
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const needsUnicode = [...characters].some(char => { try { regular.encodeText(char); return false; } catch { return true; } });
  if (!needsUnicode) {
    const embed = async (names: StandardFonts[]): Promise<Fonts> => {
      const [regular, bold, italic, boldItalic] = await Promise.all(names.map(name => pdf.embedFont(name)));
      return { regular, bold, italic, boldItalic };
    };
    return {
      serif: { regular, bold: await pdf.embedFont(StandardFonts.TimesRomanBold), italic: await pdf.embedFont(StandardFonts.TimesRomanItalic), boldItalic: await pdf.embedFont(StandardFonts.TimesRomanBoldItalic) },
      'sans-serif': await embed([StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique]),
      monospace: await embed([StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique]),
    };
  }
  abortIfNeeded(signal);
  const { default: fontkit } = await import('@pdf-lib/fontkit'); pdf.registerFontkit(fontkit);
  unicodeFontBytes ??= Promise.all([regularFontUrl, boldFontUrl, italicFontUrl, boldItalicFontUrl].map(async url => {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error('Não foi possível carregar a fonte do PDF. Tente gerar o arquivo novamente.');
    return new Uint8Array(await response.arrayBuffer());
  })).catch(error => { unicodeFontBytes = undefined; throw error; });
  const bytes = await unicodeFontBytes; abortIfNeeded(signal);
  const [regularUnicode, bold, italic, boldItalic] = await Promise.all(bytes.map(data => pdf.embedFont(data, { subset: true })));
  const fonts = { regular: regularUnicode, bold, italic, boldItalic };
  for (const font of Object.values(fonts)) {
    const supported = new Set(font.getCharacterSet());
    const missing = [...characters].find(char => !supported.has(char.codePointAt(0)!));
    if (missing) throw new Error(`A fonte do PDF não suporta o caractere “${missing}” (U+${missing.codePointAt(0)!.toString(16).toUpperCase()}). Preserve o símbolo como imagem ou exporte o Word.`);
  }
  return { serif: fonts, 'sans-serif': fonts, monospace: fonts };
}

function wrap(runs: ContentRun[], size: number, leading: number, width: number, fonts: Fonts, assets: Map<string, DocumentAsset>, block: DocumentBlock): Line[] {
  const lines: Line[] = [];
  let line: Line;
  const fresh = (): Line => ({ pieces: [], width: 0, above: size * .82, below: size * .24, height: 0, paragraphEnd: false });
  line = fresh();
  const finish = (paragraphEnd = false) => {
    // Trailing whitespace does not affect alignment or the selectable reading sequence.
    while (line.pieces.at(-1)?.type === 'text' && /^\s+$/u.test((line.pieces.at(-1) as Extract<Piece, { type: 'text' }>).text)) line.width -= line.pieces.pop()!.width;
    line.height = Math.max(leading, line.above + line.below + .35); line.paragraphEnd = paragraphEnd;
    lines.push(line); line = fresh();
  };
  const add = (piece: Piece) => {
    if (piece.width > width + .01) throw new Error(`Um objeto no bloco ${block.id} é maior que a coluna. Revise suas dimensões.`);
    if (line.width + piece.width > width + .01 && line.pieces.length) finish();
    if (piece.type === 'text' && /^\s+$/u.test(piece.text) && !line.pieces.length) return;
    line.pieces.push(piece); line.width += piece.width;
    if (piece.type === 'asset') { line.above = Math.max(line.above, piece.height + piece.offset); line.below = Math.max(line.below, -piece.offset); }
    else if (piece.style.superscript) line.above = Math.max(line.above, piece.size * .84 + size * .35);
  };
  // Keep a formula, its adjacent punctuation and styled parts of a word together.
  // Only whitespace or an explicit newline introduces a normal wrapping point.
  let word: Piece[] = [];
  const flushWord = () => {
    if (!word.length) return;
    const total = word.reduce((sum, piece) => sum + piece.width, 0);
    if (total > width + .01 && word.some(piece => piece.type === 'asset')) {
      throw new Error(`Uma expressão com seu texto adjacente no bloco ${block.id} é maior que a coluna. Revise suas dimensões ou os espaços ao redor.`);
    }
    if (total <= width + .01 && line.width + total > width + .01 && line.pieces.length) finish();
    for (const piece of word) {
      if (piece.width <= width + .01 || piece.type === 'asset') { add(piece); continue; }
      const font = fontFor(fonts, piece.style);
      let chunk = '';
      for (const char of piece.text) {
        if (chunk && font.widthOfTextAtSize(chunk + char, piece.size) > width) {
          add({ ...piece, text: chunk, width: font.widthOfTextAtSize(chunk, piece.size) }); finish(); chunk = '';
        }
        chunk += char;
      }
      if (chunk) add({ ...piece, text: chunk, width: font.widthOfTextAtSize(chunk, piece.size) });
    }
    word = [];
  };
  for (const run of runs) {
    if (run.type === 'asset') {
      const asset = assets.get(run.assetId)!;
      // Inline equations remain atomic and follow their translated marker, never a source x/y.
      word.push({ type: 'asset', asset, width: asset.widthPt, height: asset.heightPt, offset: asset.baselineOffsetPt ?? 0 }); continue;
    }
    const style = { ...run.style, bold: run.style?.bold || block.kind === 'heading' || block.appearance?.bold, italic: run.style?.italic || block.appearance?.italic };
    const font = fontFor(fonts, style), drawSize = size * (style.superscript ? .75 : 1);
    for (const token of run.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split(/(\n|[^\S\n]+)/u).filter(Boolean)) {
      if (token === '\n') { flushWord(); finish(true); continue; }
      const tokenWidth = font.widthOfTextAtSize(token, drawSize);
      const piece: Piece = { type: 'text', text: token, style, width: tokenWidth, size: drawSize };
      if (/^\s+$/u.test(token)) { flushWord(); add(piece); }
      else word.push(piece);
    }
  }
  flushWord();
  if (line.pieces.length || !lines.length) finish(true);
  else if (lines.length) lines[lines.length - 1].paragraphEnd = true;
  return lines;
}

function union(a: SourceRect, b: SourceRect): SourceRect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Render the continuous article plan as selectable text and preserved source objects. */
export async function renderStructuredPdf(translated: TranslatedDocument, ready: Ready, onProgress: (message: string) => void,
  signal?: AbortSignal, onLayout?: (report: PdfLayoutReport) => void): Promise<Blob> {
  const pdf = await PDFDocument.create(), fonts = await documentFonts(pdf, ready, signal);
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();
  for (const asset of ready.assets.values()) { abortIfNeeded(signal); images.set(asset.id, await pdf.embedPng(asset.png)); }
  const textLayout = (block: DocumentBlock, width: number): TextLayout => {
    const size = clamp(block.appearance?.fontSize ?? block.fontSize, 8, block.kind === 'heading' ? 44 : 24);
    const leading = clamp(block.appearance?.lineHeight ?? size * 1.2, size * 1.1, size * 1.8);
    const family = block.appearance?.fontFamily ?? 'serif', selectedFonts = fonts[family];
    const runs = normalizePdfTextRuns(ready.runs.get(block.id)!, block);
    return {
      lines: wrap(runs, size, leading, width, selectedFonts, ready.assets, block), size,
      fonts: selectedFonts, alignment: block.appearance?.alignment ?? 'left',
    };
  };
  const layouts = new Map<string, Layout>();
  const key = (id: string, width: number, height: number) => `${id}:${width}:${height}`;
  const blocks = new Map(translated.document.blocks.map(block => [block.id, block]));
  const flowBlocks = translated.document.blocks.filter(block => !ready.captions.has(block.id));
  const sourceRect = (block: DocumentBlock) => {
    const caption = block.captionId ? blocks.get(block.captionId) : undefined;
    return caption && caption.page === block.page ? union(block.rect, caption.rect) : block.rect;
  };
  const gapAfterBlock = (block: DocumentBlock) => {
    if (isVisual(block)) return 6;
    if (block.kind === 'caption') return 3;
    if (/^(?:list|references?|code)$/u.test(block.sourceRole || '')) return 2;
    const size = clamp(block.appearance?.fontSize ?? block.fontSize, 8, 44);
    return block.kind === 'heading' ? clamp(size * .4, 4, 10) : clamp(size * .35, 3, 6);
  };
  const items: PdfLayoutItem[] = flowBlocks.map(block => {
    const caption = block.captionId ? blocks.get(block.captionId) : undefined;
    const gapAfter = gapAfterBlock(block);
    const origins = [block, ...(caption ? [caption] : [])];
    const sourcePages = [...new Set(origins.flatMap(origin => [origin.page, ...(origin.fragments?.map(fragment => fragment.page) || [])]))].sort((a, b) => a - b);
    return { id: block.id, page: block.page, kind: block.kind, sourceRole: block.sourceRole, rect: sourceRect(block),
      sourcePages, deferrable: block.kind === 'figure' || block.kind === 'table',
      keepWithNext: block.kind === 'heading', measure(width, maxHeight) {
        const cacheKey = key(block.id, width, maxHeight);
        let layout = layouts.get(cacheKey);
        if (!layout) {
          if (!isVisual(block)) layout = { type: 'text', value: textLayout(block, width) };
          else {
            const asset = ready.assets.get(block.assetId!)!, captionLayout = caption ? textLayout(caption, width) : undefined;
            const captionHeight = captionLayout ? lineHeight(captionLayout) : 0;
            if (captionHeight > maxHeight * .6) throw new Error(`A legenda ${caption!.id} é longa demais para acompanhar a figura numa página.`);
            const captionAbove = Boolean(caption && caption.page === block.page && caption.rect.y < block.rect.y);
            const gap = caption ? 6 : 0;
            const scale = Math.min(1, width / asset.widthPt, (maxHeight - captionHeight - gap - 4) / asset.heightPt);
            if (scale <= 0) throw new Error(`A figura ${block.id} não cabe com sua legenda.`);
            layout = { type: 'visual', value: { asset, width: asset.widthPt * scale, height: asset.heightPt * scale, gap,
              caption: captionLayout, captionAbove, total: asset.heightPt * scale + captionHeight + gap } };
          }
          layouts.set(cacheKey, layout);
        }
        return { heights: layout.type === 'text' ? layout.value.lines.map(line => line.height) : [layout.value.total],
          gapAfter, atomic: layout.type === 'visual', ...(layout.type === 'visual' ? { imageHeight: layout.value.height } : {}) };
      } };
  });
  onProgress('Distribuindo o artigo entre colunas e páginas…');
  const plan = planPdfLayout(translated.document, items, signal);
  const pages = plan.pages.map(page => pdf.addPage([page.width, page.height]));
  const drawLines = (pageIndex: number, layout: TextLayout, lines: Line[], x: number, y: number, width: number) => {
    const page = pages[pageIndex], pageHeight = plan.pages[pageIndex].height;
    for (const line of lines) {
      abortIfNeeded(signal);
      const extra = Math.max(0, width - line.width);
      let left = x + (layout.alignment === 'center' ? extra / 2 : layout.alignment === 'right' ? extra : 0);
      const spaces = line.pieces.filter(piece => piece.type === 'text' && /^\s+$/u.test(piece.text)).length;
      const justify = layout.alignment === 'justify' && !line.paragraphEnd && spaces > 0 ? extra / spaces : 0;
      const baseline = pageHeight - y - line.above;
      for (const piece of line.pieces) {
        if (piece.type === 'asset') page.drawImage(images.get(piece.asset.id)!, { x: left, y: baseline + piece.offset, width: piece.width, height: piece.height });
        else page.drawText(piece.text, { x: left, y: baseline + (piece.style.superscript ? layout.size * .35 : 0), size: piece.size, font: fontFor(layout.fonts, piece.style), color: rgb(0, 0, 0) });
        left += piece.width + (piece.type === 'text' && /^\s+$/u.test(piece.text) ? justify : 0);
      }
      y += line.height;
    }
  };
  for (let index = 0; index < plan.placements.length; index++) {
    abortIfNeeded(signal);
    const placement = plan.placements[index], block = blocks.get(placement.id)!;
    const layout = layouts.get(key(block.id, placement.regionWidth, placement.regionHeight))!;
    onProgress(`Montando o PDF: elemento ${index + 1} de ${plan.placements.length}…`);
    const { x, y, width } = placement.rect;
    if (layout.type === 'text') { drawLines(placement.pageIndex, layout.value, layout.value.lines.slice(placement.start, placement.end), x, y, width); continue; }
    const value = layout.value;
    let imageY = y;
    if (value.caption && value.captionAbove) { drawLines(placement.pageIndex, value.caption, value.caption.lines, x, y, width); imageY += lineHeight(value.caption) + value.gap; }
    const offset = (width - value.width) / 2;
    pages[placement.pageIndex].drawImage(images.get(value.asset.id)!, { x: x + offset, y: plan.pages[placement.pageIndex].height - imageY - value.height, width: value.width, height: value.height });
    if (value.caption && !value.captionAbove) drawLines(placement.pageIndex, value.caption, value.caption.lines, x, imageY + value.height + value.gap, width);
  }
  pdf.setTitle(translated.document.sourceName); pdf.setCreator('Lume'); pdf.setSubject(`Tradução ${translated.sourceLanguage} → ${translated.targetLanguage}`);
  abortIfNeeded(signal); const bytes = await pdf.save(); abortIfNeeded(signal);
  onLayout?.(plan.report);
  return new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' });
}
