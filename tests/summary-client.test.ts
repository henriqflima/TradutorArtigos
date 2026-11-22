import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  batchSummarySources, composeSummary, formatSummary, sourcesFromOcr, updateSummarySource,
} from '../src/summary-client';
import { SUMMARY_VERSION, type SummarySession, type SummarySource } from '../src/summary-contract';
import { OCR_ENGINE, type OcrResult } from '../src/ocr-contract';

function source(id = 'p1-b1', page = 1, text = 'The mean was 1.23 ± 0.04 mg L⁻¹; n = 30; p = 0.08.'): SummarySource {
  return { id, page, kind: 'text', text, originalText: text, confidence: 98,
    rect: { x: 20, y: 40, width: 400, height: 50 } };
}
function session(): SummarySession {
  return { version: SUMMARY_VERSION, sourceHash: 'source-hash', fileName: 'study.pdf', pageCount: 2, language: 'PT-BR',
    pages: [1, 2].map(number => ({ number, width: 600, height: 800, sources: [source(`p${number}-b1`, number)],
      evidence: [{ id: `e${number}`, section: 'results' as const, statement: `Achado ${number}: 1.23 ± 0.04 mg L⁻¹.`,
        sourceIds: [`p${number}-b1`], quotes: ['1.23 ± 0.04 mg L⁻¹'], values: ['1.23 ± 0.04 mg L⁻¹'], caveats: [],
        origin: 'study' as const, certainty: 'reported' as const }], concepts: ['Desvio padrão'], warnings: [],
      status: 'analyzed' as const, completedBatches: { batch: { evidence: [], concepts: [], warnings: [] } } })),
    sections: {}, comments: [] };
}
function ocr(blocks: OcrResult['page']['blocks']): OcrResult {
  return { model: OCR_ENGINE, page: { width: 600, height: 800, confidence: 98, blocks }, usage: { pages: 1 } };
}
const block = (type: string, content: string): OcrResult['page']['blocks'][number] => ({
  type, content, x: 20, y: 40, width: 400, height: 100, confidence: 98,
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('summary-only extraction preparation', () => {
  it('keeps raw tables, equations, captions and empty image regions with page provenance', () => {
    const table = '| Dose (µg mL⁻¹) | Mean ± SD |\n| 0.05 | 1.230 ± 0.040 |';
    const equation = '$E = mc^2$';
    const sources = sourcesFromOcr(ocr([
      block('title', 'Results'), block('table', table), block('equation', equation),
      block('image', ''), block('caption', 'Figure 2. n = 30; p = 0.08.'),
    ]), 3);
    expect(sources).toHaveLength(5);
    expect(sources.map(s => s.kind)).toEqual(['heading', 'table', 'equation', 'figure', 'caption']);
    expect(sources.every(s => s.page === 3)).toBe(true);
    expect(new Set(sources.map(s => s.id)).size).toBe(5);
    expect(sources[1].text).toBe(table);
    expect(sources[1].originalText).toBe(table);
    expect(sources[2].text).toBe(equation);
    expect(sources[3].text).toBe('');
  });

  it('splits exceptionally long OCR blocks without truncating any source content', () => {
    const text = 'Concentration 0.005 µg mL⁻¹; n = 123; p < 0.001. '.repeat(1200);
    const sources = sourcesFromOcr(ocr([block('text', text)]), 1);
    expect(sources.length).toBeGreaterThan(1);
    expect(sources.every(s => s.text.length <= 20_000 && s.originalText.length <= 20_000)).toBe(true);
    expect(sources.map(s => s.text).join('')).toBe(text);
    expect(sources.map(s => s.originalText).join('')).toBe(text);
    expect(new Set(sources.map(s => s.id)).size).toBe(sources.length);
  });

  it('keeps Unicode code points intact at source fragmentation boundaries', () => {
    const text = `${'x'.repeat(17_999)}𝛼${'y'.repeat(1000)}`;
    const sources = sourcesFromOcr(ocr([block('text', text)]), 1);
    expect(sources.map(s => s.text).join('')).toBe(text);
    expect(sources.every(s => !/\p{Surrogate}/u.test(s.text))).toBe(true);
  });

  it('batches all sources in original order and respects the text budget', () => {
    const sources = Array.from({ length: 11 }, (_, index) => source(`s${index}`, 1, 'x'.repeat(5500)));
    const batches = batchSummarySources(sources);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(sources);
    expect(batches.every(batch => batch.reduce((sum, s) => sum + s.text.length, 0) <= 24_000)).toBe(true);
  });

  it('keeps original OCR when a correction invalidates the affected evidence and composed sections', () => {
    const original = session();
    original.sections.results = { key: 'results', paragraphs: [{ text: 'Resultado anterior.', evidenceIds: ['e1'] }], missing: [] };
    original.comments = [{ concept: 'Desvio padrão', explanation: 'Comentário anterior.', sources: [] }];
    original.explanationDone = true;
    const before = JSON.stringify(original);
    const corrected = updateSummarySource(original, 'p1-b1', 'Corrected: 1.24 ± 0.04 mg L⁻¹.');
    expect(corrected.pages[0].sources[0].originalText).toBe(original.pages[0].sources[0].text);
    expect(corrected.pages[0].sources[0].text).toBe('Corrected: 1.24 ± 0.04 mg L⁻¹.');
    expect(corrected.pages[0].evidence).toEqual([]);
    expect(corrected.pages[0].completedBatches).toEqual({});
    expect(corrected.pages[0].status).toBe('extracted');
    expect(corrected.pages[1]).toEqual(original.pages[1]);
    expect(corrected.sections).toEqual({});
    expect(corrected.comments).toEqual([]);
    expect(corrected.explanationDone).not.toBe(true);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe('summary-only composition transport', () => {
  it('refuses duplicate or missing physical pages before making any paid request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const invalid = session();
    invalid.pages[1] = structuredClone(invalid.pages[0]);
    await expect(composeSummary(invalid, { code: '', language: 'PT-BR', web: false,
      signal: new AbortController().signal, onProgress: () => {}, onUpdate: () => {} })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resumes completed sections and never calls translation or shared OCR endpoints', async () => {
    const existing = session();
    existing.sections.objective = { key: 'objective', paragraphs: [{ text: 'Objetivo já concluído.', evidenceIds: ['e1'] }], missing: [] };
    const requests: { url: string; section: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url: String(url), section: body.section });
      return Response.json({ key: body.section, paragraphs: [{ text: `Conteúdo ${body.section}.`, evidenceIds: ['e1'] }], missing: [] });
    }));
    const result = await composeSummary(existing, { code: 'summary-code', language: 'PT-BR', web: false,
      signal: new AbortController().signal, onProgress: () => {}, onUpdate: () => {} });
    expect(requests.map(r => r.section)).toEqual(['technical', 'methodology', 'results']);
    expect(requests.every(r => r.url === '/api/summary-compose')).toBe(true);
    expect(result.sections.objective).toEqual(existing.sections.objective);
    expect(result.sections.results?.paragraphs[0].text).toContain('results');
    const text = formatSummary(result);
    expect(text).toContain('Objetivo');
    expect(text).toContain('Resultados e conclusões');
    expect(text).toContain('Objetivo já concluído.');
  });

  it('does not accept a completed provider response after the operation was interrupted', async () => {
    const controller = new AbortController();
    const updates: SummarySession[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      controller.abort();
      return Response.json({ key: body.section, paragraphs: [{ text: 'Resposta atrasada.', evidenceIds: ['e1'] }], missing: [] });
    }));
    await expect(composeSummary(session(), { code: '', language: 'PT-BR', web: false, signal: controller.signal,
      onProgress: () => {}, onUpdate: next => updates.push(structuredClone(next)) })).rejects.toThrow();
    expect(updates.every(update => !Object.values(update.sections).some(s => s?.paragraphs.some(p => p.text === 'Resposta atrasada.')))).toBe(true);
  });

  it('rejects unsupported evidence citations before storing a section', async () => {
    const updates: SummarySession[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return Response.json({ key: body.section, paragraphs: [{ text: 'Achado sem origem.', evidenceIds: ['invented-evidence'] }], missing: [] });
    }));
    await expect(composeSummary(session(), { code: '', language: 'PT-BR', web: false,
      signal: new AbortController().signal, onProgress: () => {}, onUpdate: next => updates.push(structuredClone(next)) })).rejects.toThrow();
    expect(updates.every(update => Object.keys(update.sections).length === 0)).toBe(true);
  });
});
