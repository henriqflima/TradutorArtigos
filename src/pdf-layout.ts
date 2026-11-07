import { inferPdfFlowGeometry, inferPdfPageGeometry, type PdfFlowGeometry } from './pdf-page-geometry';
import { abortIfNeeded, type SourceRect, type StructuredDocument } from './structured-document';

export type PdfLayoutReport = {
  pages: { sourcePage: number; outputPages: number[]; mode: 'flow' | 'simplified'; columns: 1 | 2; warnings: string[] }[];
  outputPages: { outputPage: number; sourcePages: number[]; columns: 1 | 2 }[];
};
export type PdfMeasurement = { heights: number[]; gapAfter: number; atomic?: boolean; imageHeight?: number };
export type PdfLayoutItem = {
  id: string; page: number; rect: SourceRect; kind: string; keepWithNext?: boolean; sourceRole?: string;
  sourcePages?: number[]; widthMode?: 'column' | 'page'; deferrable?: boolean;
  measure: (width: number, maxHeight: number) => PdfMeasurement;
};
export type PdfPlacement = {
  id: string; pageIndex: number; rect: SourceRect; start: number; end: number;
  regionWidth: number; regionHeight: number;
};
export type PdfLayoutPlan = {
  pages: { width: number; height: number; sourcePages: number[] }[];
  placements: PdfPlacement[]; report: PdfLayoutReport;
};
const bottom = (rect: SourceRect) => rect.y + rect.height;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const visual = (item: PdfLayoutItem) => /^(?:figure|table|equation)$/u.test(item.kind);
const deferred = (item: PdfLayoutItem) => item.deferrable ?? /^(?:figure|table)$/u.test(item.kind);
const sameFormat = (a: { width: number; height: number }, b: { width: number; height: number }) =>
  Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

/** Source coordinates inform the body style; only the reviewed reading sequence controls the flow. */
export function planPdfLayout(document: StructuredDocument, items: PdfLayoutItem[], signal?: AbortSignal): PdfLayoutPlan {
  const plan: PdfLayoutPlan = { pages: [], placements: [], report: { pages: [], outputPages: [] } };
  abortIfNeeded(signal);
  for (const size of document.pages) {
    if (![size.width, size.height].every(value => Number.isFinite(value) && value >= 72 && value <= 14400)) {
      throw new Error('O documento contém dimensões inválidas para montar o PDF.');
    }
  }
  const ids = new Set<string>(), order = new Map<string, number>();
  const blocks = new Map(document.blocks.map(block => [block.id, block]));
  const origins = new Map<string, number[]>();
  for (const [index, item] of items.entries()) {
    const sourcePages = [...new Set([item.page, ...(item.sourcePages || []), ...(blocks.get(item.id)?.fragments?.map(fragment => fragment.page) || [])])].sort((a, b) => a - b);
    if (ids.has(item.id) || sourcePages.some(page => !Number.isInteger(page) || page < 1 || page > document.pages.length)) {
      throw new Error(`O bloco ${item.id} tem página ou identificador inválido.`);
    }
    ids.add(item.id); order.set(item.id, index); origins.set(item.id, sourcePages);
  }
  const furniture = (item: PdfLayoutItem) => {
    if (!/^(?:header|footer|page_number)$/u.test(item.sourceRole || '') || item.kind === 'heading') return false;
    const size = document.pages[item.page - 1];
    return Number.isFinite(item.rect.y) && item.rect.height < size.height * .12 &&
      (item.rect.y < size.height * .15 || bottom(item.rect) > size.height * .85);
  };
  const flow = items.filter(item => !furniture(item));
  const profiles = document.pages.map(size => inferPdfFlowGeometry(size, document.pages, flow));
  const prefix = new Set<string>();
  if (flow.length) {
    const firstPage = flow[0].page, geometry = profiles[firstPage - 1];
    if (geometry.columns.length === 2) {
      const title = flow.findIndex(item => item.page === firstPage && item.kind === 'heading' && item.rect.width > geometry.columns[0].width * 1.25);
      if (title >= 0 && blocks.has(flow[title].id)) {
        const titleSize = blocks.get(flow[title].id)?.fontSize;
        const body = flow.findIndex((item, index) => index > title && (item.page !== firstPage ||
          (item.kind === 'heading' && (/^\s*\d+(?:\.\d+)*[.)]?\s+\S/u.test(blocks.get(item.id)?.runs.map(run => run.type === 'text' ? run.text : '').join('') || '') ||
            (titleSize !== undefined && (blocks.get(item.id)?.fontSize || titleSize) < titleSize * .85))) ||
          (item.kind === 'paragraph' && item.rect.width >= geometry.columns[0].width * .8 && item.rect.width <= geometry.columns[0].width * 1.2 &&
            item.rect.height >= Math.max(24, (blocks.get(item.id)?.fontSize || 10) * 3))));
        if (body > title) flow.slice(0, body).forEach(item => prefix.add(item.id));
      }
    }
  }
  for (const [index, size] of document.pages.entries()) {
    const sourceItems = flow.filter(item => item.page === index + 1);
    const source = inferPdfPageGeometry(size.width, size.height, sourceItems);
    plan.report.pages.push({ sourcePage: index + 1, outputPages: [], mode: source.trusted ? 'flow' : 'simplified',
      columns: profiles[index].columns.length === 2 ? 2 : 1, warnings: [...(source.warnings || [])] });
  }
  const measurements = new Map<string, PdfMeasurement>();
  const measured = (item: PdfLayoutItem, width: number, height: number) => {
    const key = `${item.id}:${width}:${height}`;
    let result = measurements.get(key);
    if (!result) {
      result = item.measure(width, height);
      if (!result.heights.length || result.heights.some(value => !Number.isFinite(value) || value <= 0) ||
          !Number.isFinite(result.gapAfter) || result.gapAfter < 0) throw new Error(`O bloco ${item.id} tem medidas inválidas.`);
      measurements.set(key, result);
    }
    return result;
  };
  let profile: PdfFlowGeometry, pageIndex = -1, column = 0;
  let cursors: number[] = [], limits: number[] = [], columnUsed = false, opening = true, bottomFloat = false;
  let keepTarget: string | undefined;
  const pending: PdfLayoutItem[] = [];
  const newPage = () => {
    abortIfNeeded(signal);
    if (plan.pages.length >= 300) throw new Error('O documento excede o limite de 300 páginas desta versão.');
    plan.pages.push({ width: profile.width, height: profile.height, sourcePages: [] });
    plan.report.outputPages.push({ outputPage: plan.pages.length, sourcePages: [], columns: profile.columns.length === 2 ? 2 : 1 });
    pageIndex = plan.pages.length - 1; column = 0; columnUsed = false; bottomFloat = false;
    cursors = profile.columns.map(() => profile.bounds.y);
    limits = profile.columns.map(() => bottom(profile.bounds));
  };
  const advance = () => {
    abortIfNeeded(signal);
    column++;
    if (column >= profile.columns.length) newPage();
  };
  const wide = (item: PdfLayoutItem, allowOpening = false) => prefix.has(item.id) || item.widthMode === 'page' ||
    (item.widthMode !== 'column' && profile.columns.length === 2 && (visual(item) || allowOpening) &&
      Number.isFinite(item.rect.width) && item.rect.width > profile.columns[0].width * 1.25 &&
      item.rect.x < profile.columns[1].x && item.rect.x + item.rect.width > profile.columns[1].x);
  const place = (item: PdfLayoutItem, x: number, y: number, width: number, start: number, end: number, height: number, regionHeight = profile.bounds.height) => {
    plan.placements.push({ id: item.id, pageIndex, rect: { x, y, width, height }, start, end,
      regionWidth: width, regionHeight });
  };
  const tooTall = (item: PdfLayoutItem) => new Error(`O elemento ${item.id} não cabe numa página sem perder legibilidade. Revise o recorte ou suas dimensões.`);
  const tryPending = () => {
    if (keepTarget || bottomFloat) return;
    while (pending.length) {
      abortIfNeeded(signal);
      const item = pending[0], full = wide(item), area = full ? profile.bounds : profile.columns[column];
      let measurement = measured(item, area.width, profile.bounds.height), height = sum(measurement.heights), regionHeight = profile.bounds.height;
      if (height > profile.bounds.height + .01) throw tooTall(item);
      const available = full ? Math.min(...limits) - Math.max(...cursors) : limits[column] - cursors[column];
      // A small proportional adjustment can fit a figure after a wide prefix without making it tiny.
      if (height > available && measurement.imageHeight && available >= height * .9 && available > 24) {
        try {
          const fitted = measured(item, area.width, available);
          if (fitted.imageHeight && fitted.imageHeight >= measurement.imageHeight * .92 && sum(fitted.heights) <= available + .01) {
            measurement = fitted; height = sum(fitted.heights); regionHeight = available;
          }
        } catch { /* A short remaining region is not a reason to reject an otherwise valid figure. */ }
      }
      if (!full) {
        if (cursors[column] + height > limits[column] + .01) return;
        place(item, area.x, cursors[column], area.width, 0, measurement.heights.length, height, regionHeight);
        cursors[column] += height + measurement.gapAfter; columnUsed = true;
      } else {
        const top = Math.max(...cursors), limit = Math.min(...limits);
        if (!columnUsed && top + height <= limit + .01) {
          place(item, area.x, top, area.width, 0, measurement.heights.length, height, regionHeight);
          cursors.fill(top + height + measurement.gapAfter);
        } else if (column === 0 && top + height + measurement.gapAfter <= limit + .01) {
          // Reserve a bottom float across both columns; later prose can fill all space above it.
          const floatTop = limit - height;
          place(item, area.x, floatTop, area.width, 0, measurement.heights.length, height, regionHeight);
          limits.fill(floatTop - measurement.gapAfter);
          bottomFloat = true;
        } else return;
      }
      pending.shift();
      if (bottomFloat) return;
    }
  };
  const flushPending = () => {
    while (pending.length) {
      tryPending();
      if (pending.length) advance();
    }
  };
  for (const [index, item] of flow.entries()) {
    abortIfNeeded(signal);
    const nextProfile = profiles[item.page - 1];
    if (pageIndex < 0) { profile = nextProfile; newPage(); }
    else if (!sameFormat(profile!, nextProfile)) {
      flushPending(); profile = nextProfile; opening = true; newPage();
    }
    const followingItem = item.keepWithNext ? flow.slice(index + 1).find(candidate => !deferred(candidate)) ?? flow[index + 1] : undefined;
    const full = wide(item, opening) || Boolean(followingItem && visual(followingItem) && wide(followingItem));
    if (!full) opening = false;
    const sourceText = blocks.get(item.id)?.runs.map(run => run.type === 'text' ? run.text : '').join('') || '';
    if (item.kind === 'heading' && /^\s*(?:references|bibliography|referências|bibliografia)\b/iu.test(sourceText)) flushPending();
    if (deferred(item) && keepTarget !== item.id) {
      pending.push(item); tryPending();
      // Bound the queue, and guarantee that a long run of figures cannot be postponed forever.
      if (pending.length >= 8 && !keepTarget) flushPending();
      continue;
    }
    tryPending();
    let start = 0;
    while (true) {
      abortIfNeeded(signal);
      const area = full ? profile!.bounds : profile!.columns[column];
      const measurement = measured(item, area.width, profile!.bounds.height);
      const atomic = measurement.atomic || visual(item) || item.keepWithNext;
      if (full && columnUsed) { newPage(); tryPending(); continue; }
      let top = full ? Math.max(...cursors) : cursors[column];
      const limit = full ? Math.min(...limits) : limits[column];
      const remaining = measurement.heights.slice(start), total = sum(remaining);
      const firstTwo = sum(remaining.slice(0, 2));
      const minimum = atomic ? total : firstTwo <= profile!.bounds.height ? firstTwo : remaining[0];
      if (minimum > profile!.bounds.height + .01) throw tooTall(item);
      let keep = 0;
      if (item.keepWithNext) {
        const next = followingItem;
        if (next && sameFormat(profile!, document.pages[next.page - 1])) {
          const nextWidth = wide(next) ? profile!.bounds.width : profile!.columns[column].width;
          const following = measured(next, nextWidth, profile!.bounds.height);
          const followingHeight = following.atomic || visual(next) ? sum(following.heights) : sum(following.heights.slice(0, 2));
          if (total + measurement.gapAfter + followingHeight <= profile!.bounds.height) keep = measurement.gapAfter + followingHeight;
        }
      }
      if (top + minimum + keep > limit + .01) {
        if (full) newPage(); else advance();
        tryPending(); continue;
      }
      let end = start, height = 0;
      while (end < measurement.heights.length && top + height + measurement.heights[end] <= limit + .01) height += measurement.heights[end++];
      if (atomic && end !== measurement.heights.length) throw tooTall(item);
      if (end < measurement.heights.length && measurement.heights.length - end === 1 && end - start > 2) height -= measurement.heights[--end];
      if (end === start) throw tooTall(item);
      place(item, area.x, top, area.width, start, end, height);
      if (keepTarget === item.id) keepTarget = undefined;
      if (item.keepWithNext && keep && followingItem) keepTarget = followingItem.id;
      top += height + (end === measurement.heights.length ? measurement.gapAfter : 0);
      if (full) cursors.fill(top); else { cursors[column] = top; columnUsed = true; }
      if (end === measurement.heights.length) break;
      start = end;
      if (full) newPage(); else advance();
      tryPending();
    }
  }
  if (pending.length) flushPending();
  // A blank input has a single deliberate blank output, never one blank for every source page.
  if (pageIndex < 0 && document.pages.length) { profile = profiles[0]; newPage(); }
  for (const placement of plan.placements) {
    for (const sourcePage of origins.get(placement.id)!) {
      const outputPage = placement.pageIndex + 1, source = plan.report.pages[sourcePage - 1];
      if (!source.outputPages.includes(outputPage)) source.outputPages.push(outputPage);
      const destination = plan.pages[placement.pageIndex];
      if (!destination.sourcePages.includes(sourcePage)) destination.sourcePages.push(sourcePage);
    }
  }
  for (const [index, page] of plan.pages.entries()) {
    page.sourcePages.sort((a, b) => a - b);
    plan.report.outputPages[index].sourcePages = [...page.sourcePages];
  }
  for (const source of plan.report.pages) {
    source.outputPages.sort((a, b) => a - b);
    if (!source.outputPages.length) source.warnings.push('Esta página não contém conteúdo principal representado no PDF traduzido.');
  }
  plan.placements.sort((a, b) => a.pageIndex - b.pageIndex || order.get(a.id)! - order.get(b.id)! || a.start - b.start);
  return plan;
}
