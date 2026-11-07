import type { SourceRect } from './structured-document';

type GeometryItem = { id: string; rect: SourceRect; kind: string; sourceRole?: string };
type Column = { x: number; width: number };
export type PdfPageGeometry = { bounds: SourceRect; columns: Column[]; trusted: boolean; warnings?: string[] };
export type PdfFlowGeometry = PdfPageGeometry & { width: number; height: number };
type Cluster = { items: GeometryItem[]; left: number; right: number; top: number; bottom: number };
const right = (rect: SourceRect) => rect.x + rect.width;
const bottom = (rect: SourceRect) => rect.y + rect.height;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const weight = (item: GeometryItem) => Math.min(180, item.rect.height) * Math.min(320, item.rect.width);
const textKind = (item: GeometryItem) => item.kind === 'paragraph' || item.kind === 'caption';

function validRect(rect: SourceRect, width: number, height: number) {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 &&
    rect.width > 1 && rect.height > 1 && right(rect) <= width + 1 && bottom(rect) <= height + 1;
}
function marginal(item: GeometryItem, pageWidth: number, pageHeight: number) {
  if (/header|footer|page[_ -]?number/i.test(item.sourceRole || '')) return true;
  // Short page furniture often lacks a useful OCR label. It must not widen a column.
  return textKind(item) && item.rect.height <= 18 && item.rect.width < pageWidth * .8 &&
    (item.rect.y < pageHeight * .035 || bottom(item.rect) > pageHeight * .965);
}
function quantile(items: readonly GeometryItem[], value: (item: GeometryItem) => number, fraction: number) {
  const ordered = [...items].sort((a, b) => value(a) - value(b));
  const total = ordered.reduce((sum, item) => sum + weight(item), 0), target = total * fraction;
  let cumulative = 0;
  for (const item of ordered) { cumulative += weight(item); if (cumulative >= target) return value(item); }
  return value(ordered[ordered.length - 1]);
}
function clusterFor(items: GeometryItem[]): Cluster {
  return { items, left: quantile(items, item => item.rect.x, .1), right: quantile(items, item => right(item.rect), .9),
    top: Math.min(...items.map(item => item.rect.y)), bottom: Math.max(...items.map(item => bottom(item.rect))) };
}
function verticalOverlap(a: Cluster, b: Cluster) {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) >= Math.min(a.bottom - a.top, b.bottom - b.top) * .2;
}

/** Repeated paragraph edges outweigh a short label or one noisy OCR rectangle. */
function textClusters(items: GeometryItem[], pageWidth: number): Cluster[] {
  const candidates = items.filter(item => textKind(item) && item.rect.width >= pageWidth * .1 &&
    item.rect.width <= pageWidth * .58 && item.rect.height >= 10);
  const support = (item: GeometryItem) => candidates.reduce((sum, other) => sum +
    (Math.abs(item.rect.x - other.rect.x) <= 8 ? 1 : 0) + (Math.abs(right(item.rect) - right(other.rect)) <= 8 ? 1 : 0), 0) +
    (item.rect.width >= pageWidth * .24 && item.rect.width <= pageWidth * .48 ? 1 : 0);
  const scores = new Map(candidates.map(item => [item, support(item)]));
  const ordered = [...candidates].sort((a, b) => scores.get(b)! - scores.get(a)! || b.rect.width - a.rect.width);
  const clusters: Cluster[] = [];
  for (const item of ordered) {
    const matches = clusters.filter(cluster => {
      const overlap = Math.min(right(item.rect), cluster.right) - Math.max(item.rect.x, cluster.left);
      return overlap >= Math.min(item.rect.width, cluster.right - cluster.left) * .5;
    });
    // A rectangle crossing two established columns describes a span or noise, not a third column.
    if (matches.length > 1) continue;
    if (matches.length === 1) {
      const match = matches[0], replacement = clusterFor([...match.items, item]);
      Object.assign(match, replacement);
    } else clusters.push(clusterFor([item]));
  }
  return clusters.sort((a, b) => a.left - b.left);
}

function hasUnsupportedColumns(clusters: Cluster[]) {
  for (let a = 0; a < clusters.length; a++) for (let b = a + 1; b < clusters.length; b++) for (let c = b + 1; c < clusters.length; c++) {
    const first = clusters[a], second = clusters[b], third = clusters[c];
    if (second.left - first.right >= 8 && third.left - second.right >= 8 &&
      [first, second, third].every(cluster => cluster.bottom - cluster.top >= 35) &&
      verticalOverlap(first, second) && verticalOverlap(first, third) && verticalOverlap(second, third)) return true;
  }
  return false;
}

function overlapping(items: GeometryItem[]) {
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    const first = items[a].rect, second = items[b].rect;
    const area = Math.max(0, Math.min(right(first), right(second)) - Math.max(first.x, second.x)) *
      Math.max(0, Math.min(bottom(first), bottom(second)) - Math.max(first.y, second.y));
    if (area > Math.min(first.width * first.height, second.width * second.height) * .12) return true;
  }
  return false;
}

/** Detect the usable body and up to two columns without making one bad region reset the page. */
export function inferPdfPageGeometry(width: number, height: number, items: readonly GeometryItem[]): PdfPageGeometry {
  const marginX = Math.min(54, width * .09), marginY = Math.min(54, height * .07);
  const defaultBounds = { x: marginX, y: marginY, width: width - marginX * 2, height: height - marginY * 2 };
  const fallback = (warning?: string): PdfPageGeometry => ({ bounds: defaultBounds,
    columns: [{ x: marginX, width: defaultBounds.width }], trusted: false, ...(warning ? { warnings: [warning] } : {}) });
  const valid = items.filter(item => validRect(item.rect, width, height));
  const body = valid.filter(item => !marginal(item, width, height));
  const interior = body.filter(item => item.rect.x >= 8 && right(item.rect) <= width - 8);
  if (!interior.length) return fallback();
  const paragraphs = interior.filter(textKind);
  const furniture = interior.filter(item => !textKind(item));
  const left = paragraphs.length ? Math.min(quantile(paragraphs, item => item.rect.x, .05), ...furniture.map(item => item.rect.x)) : Math.min(...interior.map(item => item.rect.x));
  const edge = paragraphs.length ? Math.max(quantile(paragraphs, item => right(item.rect), .95), ...furniture.map(item => right(item.rect))) : Math.max(...interior.map(item => right(item.rect)));
  const top = Math.max(12, Math.min(...interior.map(item => item.rect.y)));
  const lowest = Math.max(...interior.map(item => bottom(item.rect)));
  const lowerMargin = lowest > height * .75 ? clamp(height - lowest, 16, 72) : clamp(top, 24, 54);
  const bounds = { x: left, y: top, width: edge - left, height: height - lowerMargin - top };
  if (bounds.width < width * .2 || bounds.height < 48) return fallback();
  const warnings: string[] = [];
  const invalid = valid.length !== items.length || interior.length !== body.length;
  const overlaps = overlapping(interior);
  if (invalid) warnings.push('Algumas regiões têm medidas imprecisas; a distribuição do texto foi ajustada mantendo as colunas reconhecidas.');
  if (overlaps) warnings.push('Há regiões sobrepostas no reconhecimento; o texto foi redistribuído dentro das colunas reconhecidas.');
  const trusted = !invalid && !overlaps;
  const clusters = textClusters(interior, width);
  if (hasUnsupportedColumns(clusters)) return fallback('A página tem mais de duas colunas; foi usada uma distribuição simplificada para manter a leitura.');
  const supported = clusters.filter(cluster => cluster.right - cluster.left >= bounds.width * .22);
  let best: { left: Cluster; right: Cluster; support: number } | undefined;
  for (let a = 0; a < supported.length; a++) for (let b = a + 1; b < supported.length; b++) {
    const first = supported[a], second = supported[b];
    // One inflated OCR paragraph must not close the gutter of otherwise clear columns.
    // The flow engine uses equal widths, so test the same safe width here.
    const safeWidth = Math.min(first.right - first.left, second.right - second.left);
    const gutter = second.left - first.left - safeWidth;
    if (gutter < Math.max(10, width * .018) || !verticalOverlap(first, second) ||
      (second.left + second.right - first.left - first.right) / 2 < width * .24) continue;
    const support = first.items.reduce((sum, item) => sum + weight(item), 0) + second.items.reduce((sum, item) => sum + weight(item), 0);
    if (!best || support > best.support) best = { left: first, right: second, support };
  }
  if (!best) return { bounds, columns: [{ x: bounds.x, width: bounds.width }], trusted, ...(warnings.length ? { warnings } : {}) };
  // Matching widths are deliberate: a continued paragraph must retain the same measured line offsets.
  const columnWidth = Math.min(best.left.right - best.left.left, best.right.right - best.right.left);
  return { bounds, columns: [{ x: best.left.left, width: columnWidth }, { x: best.right.left, width: columnWidth }], trusted,
    ...(warnings.length ? { warnings } : {}) };
}

/** A stable body profile uses all pages of the same format, rather than inheriting a title/figure's whitespace. */
export function inferPdfFlowGeometry(size: { width: number; height: number }, pages: readonly { width: number; height: number }[],
  items: readonly (GeometryItem & { page: number })[]): PdfFlowGeometry {
  const median = (values: number[], fallback: number) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : fallback;
  };
  const candidates = pages.flatMap((page, index) => {
    if (Math.abs(page.width - size.width) > 2 || Math.abs(page.height - size.height) > 2) return [];
    const body = items.filter(item => item.page === index + 1 && !marginal(item, page.width, page.height));
    if (!body.length) return [];
    return [{ geometry: inferPdfPageGeometry(page.width, page.height, body),
      weight: body.filter(textKind).reduce((total, item) => total + weight(item), 0) }];
  });
  const doubles = candidates.filter(candidate => candidate.geometry.columns.length === 2);
  const doubleWeight = doubles.reduce((total, candidate) => total + candidate.weight, 0);
  const singleWeight = candidates.filter(candidate => candidate.geometry.columns.length === 1).reduce((total, candidate) => total + candidate.weight, 0);
  const selected = doubles.length && doubleWeight >= singleWeight * .6 ? doubles : candidates;
  const marginX = Math.min(54, size.width * .09), marginY = Math.min(54, size.height * .07);
  const top = clamp(median(selected.map(candidate => candidate.geometry.bounds.y), marginY), 24, 54);
  const lower = clamp(median(selected.map(candidate => size.height - bottom(candidate.geometry.bounds)), marginY), 16, 72);
  let left = clamp(median(selected.map(candidate => candidate.geometry.bounds.x), marginX), 12, size.width * .25);
  let edge = clamp(median(selected.map(candidate => right(candidate.geometry.bounds)), size.width - marginX), size.width * .5, size.width - 12);
  let columns: Column[];
  if (selected === doubles) {
    left = clamp(median(doubles.map(candidate => candidate.geometry.columns[0].x), left), 12, size.width * .25);
    const rightX = median(doubles.map(candidate => candidate.geometry.columns[1].x), size.width / 2 + 8);
    const width = Math.min(median(doubles.map(candidate => candidate.geometry.columns[0].width), (edge - left - 20) / 2),
      rightX - left - 10, size.width - 12 - rightX);
    columns = [{ x: left, width }, { x: rightX, width }];
    edge = rightX + width;
  } else {
    // A lone short/narrow box is insufficient evidence for a narrow document body.
    if (edge - left < size.width * .6) edge = size.width - left;
    columns = [{ x: left, width: edge - left }];
  }
  const warnings = [...new Set(candidates.flatMap(candidate => candidate.geometry.warnings || []))];
  return { ...size, bounds: { x: left, y: top, width: edge - left, height: size.height - lower - top }, columns,
    trusted: selected.length > 0 && selected.some(candidate => candidate.geometry.trusted), ...(warnings.length ? { warnings } : {}) };
}
