import { blockText, type DocumentBlock, type SourceRect } from './structured-document';

const right = (rect: SourceRect) => rect.x + rect.width;
const bottom = (rect: SourceRect) => rect.y + rect.height;
const center = (rect: SourceRect) => rect.x + rect.width / 2;
const swapAxes = ({ x, y, width, height }: SourceRect): SourceRect => ({ x: y, y: x, width: height, height: width });
const isVisual = (block: DocumentBlock) => block.kind === 'figure' || block.kind === 'table';
const valid = (rect: SourceRect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
type Candidate = { figure: DocumentBlock; caption: DocumentBlock; gap: number };
type Caption = { block: DocumentBlock; visualKind?: 'figure' | 'table'; numbered: boolean };

function captionCandidate(block: DocumentBlock): Caption | undefined {
  const typed = block.kind === 'caption';
  if (!typed && (block.kind !== 'paragraph' || !['text', 'paragraph', undefined].includes(block.sourceRole))) return;
  const text = (block.originalText ?? blockText(block)).trim().replace(/^[*_]+/u, '');
  const label = /^(fig(?:ure|ura)?|table|tabela|quadro|gráfico|esquema)(?:\.\s*|\s+)(?:[a-z]?\d+(?:\.\d+)*[a-z]?|[ivxlcdm]+)(?![\p{L}\p{N}])/iu.exec(text);
  const numbered = Boolean(label && /^(?:[*_]*[ \t]*[:|–—]|[*_]*[ \t]+-[ \t]+|\.(?=[\s*_]|$))/u.test(text.slice(label[0].length)));
  if (!typed && !numbered) return;
  const visualKind = label ? /^(?:table|tabela|quadro)$/iu.test(label[1]) ? 'table' : 'figure' : undefined;
  return { block, visualKind, numbered };
}

function candidateFor(figure: DocumentBlock, candidate: Caption, blocks: readonly DocumentBlock[]): Candidate | undefined {
  const caption = candidate.block;
  if (candidate.visualKind && figure.kind !== candidate.visualKind) return;
  if (figure.page !== caption.page || !valid(figure.rect) || !valid(caption.rect)) return;
  // A rotated numbered caption can sit next to a portrait crop of a landscape figure.
  const sideways = candidate.numbered && figure.kind === 'figure' && figure.rect.height > figure.rect.width &&
    caption.rect.height >= caption.rect.width * 3;
  const axes = (rect: SourceRect) => sideways ? swapAxes(rect) : rect;
  const a = axes(figure.rect), b = axes(caption.rect);
  const horizontal = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const minimumWidth = Math.min(a.width, b.width);
  const aligned = Math.abs(center(a) - center(b)) <= Math.max(12, minimumWidth * .35) ||
    Math.abs(a.x - b.x) <= 12 || Math.abs(right(a) - right(b)) <= 12 ||
    horizontal >= minimumWidth - 2;
  if (horizontal < minimumWidth * .6 || !aligned) return;
  let gap: number, betweenTop: number, betweenBottom: number;
  if (b.y >= bottom(a) - 2) { gap = b.y - bottom(a); betweenTop = bottom(a); betweenBottom = b.y; }
  else if (bottom(b) <= a.y + 2) { gap = a.y - bottom(b); betweenTop = bottom(b); betweenBottom = a.y; }
  else return;
  if (gap >= 40) return;
  // Nearby prose in the gap is evidence that this is not a figure-caption pair.
  if (gap > 3 && blocks.some(block => {
    if (block.id === figure.id || block.id === caption.id || block.page !== figure.page || !valid(block.rect)) return false;
    const rect = axes(block.rect);
    return rect.y < betweenBottom && bottom(rect) > betweenTop &&
      Math.min(right(rect), right(a), right(b)) - Math.max(rect.x, a.x, b.x) >= minimumWidth * .3;
  })) return;
  return { figure, caption, gap: Math.max(0, gap) };
}

function uniqueClosest(candidates: Candidate[]) {
  const sorted = [...candidates].sort((a, b) => a.gap - b.gap);
  return sorted.length && (sorted.length === 1 || sorted[1].gap - sorted[0].gap > 3) ? sorted[0] : undefined;
}

/** Preserve explicit links and infer unambiguous pairs, including numbered captions reported as prose. */
export function associateCaptions(blocks: readonly DocumentBlock[]): Map<string, string> {
  const figures = blocks.filter(isVisual);
  const captions = blocks.map(captionCandidate).filter((candidate): candidate is Caption => candidate !== undefined);
  const typedCaptions = new Map(blocks.filter(block => block.kind === 'caption').map(block => [block.id, block]));
  const result = new Map<string, string>(), assignedCaptions = new Set<string>();
  for (const figure of figures) {
    if (figure.captionId && !assignedCaptions.has(figure.captionId) && typedCaptions.get(figure.captionId)?.page === figure.page) {
      result.set(figure.id, figure.captionId); assignedCaptions.add(figure.captionId);
    }
  }
  const candidates = figures.flatMap(figure => captions.map(caption => candidateFor(figure, caption, blocks)).filter((candidate): candidate is Candidate => Boolean(candidate)));
  while (true) {
    const remaining = candidates.filter(candidate => !result.has(candidate.figure.id) && !assignedCaptions.has(candidate.caption.id));
    const pairs: Candidate[] = [];
    for (const figure of figures) {
      if (result.has(figure.id)) continue;
      const best = uniqueClosest(remaining.filter(candidate => candidate.figure.id === figure.id));
      if (!best) continue;
      const reciprocal = uniqueClosest(remaining.filter(candidate => candidate.caption.id === best.caption.id));
      if (reciprocal?.figure.id === figure.id) pairs.push(best);
    }
    if (!pairs.length) break;
    for (const pair of pairs) { result.set(pair.figure.id, pair.caption.id); assignedCaptions.add(pair.caption.id); }
  }
  return result;
}

/** Only a caption above its visual on the source page stays above in the export. */
export function captionAboveVisual(caption: DocumentBlock, visual: DocumentBlock): boolean {
  return caption.page === visual.page && bottom(caption.rect) <= visual.rect.y + 2;
}
