import type { DocumentBlock, SourceRect } from './structured-document';

const right = (rect: SourceRect) => rect.x + rect.width;
const bottom = (rect: SourceRect) => rect.y + rect.height;
const center = (rect: SourceRect) => rect.x + rect.width / 2;
const isVisual = (block: DocumentBlock) => block.kind === 'figure' || block.kind === 'table';
const valid = (rect: SourceRect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
type Candidate = { figure: DocumentBlock; caption: DocumentBlock; gap: number };

function candidateFor(figure: DocumentBlock, caption: DocumentBlock, blocks: readonly DocumentBlock[]): Candidate | undefined {
  if (figure.page !== caption.page || !valid(figure.rect) || !valid(caption.rect)) return;
  const a = figure.rect, b = caption.rect;
  const horizontal = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const minimumWidth = Math.min(a.width, b.width);
  const aligned = Math.abs(center(a) - center(b)) <= Math.max(12, minimumWidth * .35) ||
    Math.abs(a.x - b.x) <= 12 || Math.abs(right(a) - right(b)) <= 12;
  if (horizontal < minimumWidth * .6 || !aligned) return;
  let gap: number, betweenTop: number, betweenBottom: number;
  if (b.y >= bottom(a) - 2) { gap = b.y - bottom(a); betweenTop = bottom(a); betweenBottom = b.y; }
  else if (bottom(b) <= a.y + 2) { gap = a.y - bottom(b); betweenTop = bottom(b); betweenBottom = a.y; }
  else return;
  if (gap >= 40) return;
  // Nearby prose in the gap is evidence that this is not a figure-caption pair.
  if (gap > 3 && blocks.some(block => block.id !== figure.id && block.id !== caption.id && block.page === figure.page &&
      valid(block.rect) && block.rect.y < betweenBottom && bottom(block.rect) > betweenTop &&
      Math.min(right(block.rect), right(a), right(b)) - Math.max(block.rect.x, a.x, b.x) >= minimumWidth * .3)) return;
  return { figure, caption, gap: Math.max(0, gap) };
}

function uniqueClosest(candidates: Candidate[]) {
  const sorted = [...candidates].sort((a, b) => a.gap - b.gap);
  return sorted.length && (sorted.length === 1 || sorted[1].gap - sorted[0].gap > 3) ? sorted[0] : undefined;
}

/** Preserve explicit links; infer only unambiguous, mutually closest pairs above or below. */
export function associateCaptions(blocks: readonly DocumentBlock[]): Map<string, string> {
  const figures = blocks.filter(isVisual), captions = blocks.filter(block => block.kind === 'caption');
  const result = new Map<string, string>(), assignedCaptions = new Set<string>();
  for (const figure of figures) {
    if (figure.captionId && captions.some(caption => caption.id === figure.captionId && caption.page === figure.page)) {
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
