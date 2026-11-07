import { describe, expect, it } from 'vitest';
import {
  SUMMARY_VERSION, parseSummaryComments, parseSummaryExtraction, parseSummarySection,
  summaryQuality, validSummaryEvidence, validSummarySource,
  type SummaryEvidence, type SummarySession, type SummarySource,
} from '../src/summary-contract';

function source(): SummarySource {
  return { id: 'p2-b1', page: 2, kind: 'table',
    text: '| Concentration (mg L⁻¹) | Mean ± SD |\n| 0.05 | 1.23 ± 0.04 |',
    originalText: '| Concentration (mg L⁻¹) | Mean ± SD |\n| 0.05 | 1.23 ± 0.04 |',
    confidence: 94, rect: { x: 20, y: 40, width: 300, height: 120 } };
}
function evidence(): SummaryEvidence {
  return { id: 'e1', section: 'results', statement: 'A média foi 1.23 ± 0.04.', sourceIds: ['p2-b1'],
    quotes: ['1.23 ± 0.04'], values: ['0.05 mg L⁻¹', '1.23 ± 0.04'], caveats: ['Condição específica de concentração.'],
    origin: 'study', certainty: 'reported' };
}
function session(): SummarySession {
  return { version: SUMMARY_VERSION, sourceHash: 'fixture-hash', fileName: 'article.pdf', pageCount: 2,
    pages: [1, 2].map(number => ({ number, width: 600, height: 800,
      sources: [{ ...source(), id: `p${number}-b1`, page: number }], evidence: [], concepts: [], warnings: [],
      status: 'analyzed' as const, completedBatches: {} })), sections: {}, comments: [] };
}

describe('independent summary evidence contract', () => {
  it('preserves numerical precision, Unicode units, table structure and caveats without normalization', () => {
    const raw = { evidence: [evidence()], concepts: ['Desvio padrão'], warnings: [] };
    const result = parseSummaryExtraction(raw, [source()]);
    expect(result).toEqual(raw);
    expect(result.evidence[0].values).toEqual(['0.05 mg L⁻¹', '1.23 ± 0.04']);
    expect(result.evidence[0].caveats).toEqual(['Condição específica de concentração.']);
    expect(validSummarySource(source())).toBe(true);
  });

  it('rejects evidence citing a source from an unsent page or an invented ID', () => {
    const raw = { evidence: [{ ...evidence(), sourceIds: ['p9-fabricated'] }], concepts: [], warnings: [] };
    expect(() => parseSummaryExtraction(raw, [source()])).toThrow(/referências inválidos/);
  });

  it.each([
    { sourceIds: [] }, { sourceIds: ['p2-b1', 'p2-b1'] }, { statement: ' ' },
    { origin: 'unknown' }, { certainty: 'certain' }, { section: 'invented' },
    { values: ['1\u0000.23'] }, { caveats: 'missing array' },
  ])('rejects malformed evidence: %j', change => {
    expect(validSummaryEvidence({ ...evidence(), ...change }, new Set(['p2-b1']))).toBe(false);
  });

  it.each([
    { page: 0 }, { page: 51 }, { confidence: 101 }, { confidence: Number.NaN },
    { rect: { x: -1, y: 0, width: 10, height: 10 } },
    { rect: { x: 0, y: 0, width: 0, height: 10 } },
    { text: 'x'.repeat(20_001) },
  ])('rejects malformed source geometry, page or text: %j', change => {
    expect(validSummarySource({ ...source(), ...change })).toBe(false);
  });

  it('keeps prior research explicitly distinct from the study results', () => {
    const previous = { ...evidence(), origin: 'prior-work' as const, section: 'technical' as const };
    expect(parseSummaryExtraction({ evidence: [previous], concepts: [], warnings: [] }, [source()])
      .evidence[0].origin).toBe('prior-work');
  });

  it('rejects composed paragraphs with fabricated, absent or empty supporting citations', () => {
    const section = { key: 'results', paragraphs: [{ text: 'Um achado.', evidenceIds: ['e1'] }], missing: [] };
    expect(parseSummarySection(section, 'results', [evidence()])).toEqual(section);
    expect(() => parseSummarySection({ ...section, paragraphs: [{ text: 'Inventado.', evidenceIds: ['e99'] }] }, 'results', [evidence()])).toThrow();
    expect(() => parseSummarySection({ ...section, paragraphs: [{ text: 'Sem apoio.', evidenceIds: [] }] }, 'results', [evidence()])).toThrow();
    expect(() => parseSummarySection(section, 'methodology', [evidence()])).toThrow();
  });

  it('allows explicit missing information rather than an empty or invented summary', () => {
    const missing = { key: 'methodology', paragraphs: [], missing: ['O equipamento não foi identificado no artigo.'] };
    expect(parseSummarySection(missing, 'methodology', [evidence()])).toEqual(missing);
    expect(() => parseSummarySection({ ...missing, missing: [] }, 'methodology', [evidence()])).toThrow();
  });

  it('rejects unsafe source link schemes in explanatory comments', () => {
    const comment = { concept: 'Variância', explanation: 'Medida de dispersão.', sources: [{ title: 'Fonte', url: 'https://example.org/variance' }] };
    expect(parseSummaryComments({ comments: [comment] })).toEqual([comment]);
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///local/document']) {
      expect(() => parseSummaryComments({ comments: [{ ...comment, sources: [{ title: 'Fonte', url }] }] })).toThrow();
    }
  });

  it('does not label partial extraction as complete and retains the affected page', () => {
    const partial = session();
    partial.pages[1].status = 'extracted';
    expect(summaryQuality(partial)).toMatchObject({ complete: false, analyzedPages: 1, totalPages: 2 });
    expect(summaryQuality(partial).issues[0]).toContain('1/2');
    partial.pages[1].status = 'analyzed';
    partial.pages[1].warnings = ['Eixo vertical ilegível; valor aproximado.'];
    expect(summaryQuality(partial)).toMatchObject({ complete: false, analyzedPages: 2 });
    expect(summaryQuality(partial).issues).toContain('Página 2: Eixo vertical ilegível; valor aproximado.');
    partial.pages[1].warnings = [];
    expect(summaryQuality(partial).complete).toBe(true);
  });

  it('counts distinct physical PDF pages rather than accepting duplicate processed pages', () => {
    const duplicated = session();
    duplicated.pages[1] = structuredClone(duplicated.pages[0]);
    expect(summaryQuality(duplicated).complete).toBe(false);
  });

  it('treats out-of-range pages and missing section information as unresolved coverage', () => {
    const invalid = session();
    invalid.pages[1].number = 3;
    expect(summaryQuality(invalid).complete).toBe(false);
    expect(summaryQuality(invalid).analyzedPages).toBe(1);
    const missing = session();
    missing.sections.methodology = { key: 'methodology', paragraphs: [], missing: ['A calibração do equipamento não foi descrita.'] };
    expect(summaryQuality(missing).complete).toBe(false);
    expect(summaryQuality(missing).issues.some(issue => issue.includes('calibração'))).toBe(true);
  });
});
