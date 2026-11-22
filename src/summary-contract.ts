/** Summary-only data model. It deliberately has no dependency on translation contracts. */
export const SUMMARY_VERSION = 'article-evidence-v1';
export const SUMMARY_ENGINE = 'summary-v1';
export const SUMMARY_MAX_FILE_BYTES = 7_000_000;
export const SUMMARY_MAX_PAGES = 50;
export const SUMMARY_SECTIONS = ['objective', 'technical', 'methodology', 'results'] as const;
export type SummarySectionKey = typeof SUMMARY_SECTIONS[number];
export const SUMMARY_LABELS: Record<SummarySectionKey, string> = {
  objective: 'Objetivo', technical: 'Base técnica', methodology: 'Metodologia', results: 'Resultados e conclusões',
};
export type SummarySource = {
  id: string; page: number;
  kind: 'text' | 'heading' | 'caption' | 'table' | 'figure' | 'equation' | 'reference' | 'other';
  text: string; originalText: string; confidence: number | null;
  rect: { x: number; y: number; width: number; height: number };
};
export type SummaryEvidence = {
  id: string; section: SummarySectionKey | 'conclusion' | 'reference' | 'other';
  statement: string; sourceIds: string[]; quotes: string[]; values: string[]; caveats: string[];
  origin: 'study' | 'prior-work'; certainty: 'reported' | 'approximate' | 'unclear';
};
export type SummarySection = {
  key: SummarySectionKey; paragraphs: { text: string; evidenceIds: string[] }[]; missing: string[];
};
export type SummaryComment = { concept: string; explanation: string; sources: { title: string; url: string }[] };
export type SummaryExtraction = { evidence: SummaryEvidence[]; concepts: string[]; warnings: string[] };
export type SummaryPage = {
  number: number; width: number; height: number; sources: SummarySource[]; evidence: SummaryEvidence[];
  concepts: string[]; warnings: string[]; status: 'extracted' | 'analyzed'; image?: string;
  /** Each successfully validated batch is kept, including across explicit retries. */
  completedBatches: Record<string, SummaryExtraction>;
};
export type SummarySession = {
  version: typeof SUMMARY_VERSION; sourceHash: string; fileName: string; pageCount: number;
  pages: SummaryPage[]; sections: Partial<Record<SummarySectionKey, SummarySection>>;
  comments: SummaryComment[]; language?: string; explanationDone?: boolean;
};
export type SummaryConfig = { configured: boolean; ocrConfigured: boolean; accessRequired: boolean; model: string; ocrModel: string };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, max = 20_000): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const strings = (v: unknown, max = 120): v is string[] => Array.isArray(v) && v.length <= max && v.every(x => string(x));
export function validSummarySource(value: unknown): value is SummarySource {
  if (!object(value) || !string(value.id, 100) || !value.id || !Number.isInteger(value.page) || Number(value.page) < 1 || Number(value.page) > SUMMARY_MAX_PAGES ||
      !['text','heading','caption','table','figure','equation','reference','other'].includes(String(value.kind)) ||
      !string(value.text) || !string(value.originalText) || !object(value.rect)) return false;
  const r = value.rect;
  return [r.x,r.y,r.width,r.height].every(x => typeof x === 'number' && Number.isFinite(x)) && Number(r.x) >= 0 && Number(r.y) >= 0 && Number(r.width) > 0 && Number(r.height) > 0 &&
    (value.confidence === null || (typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 100));
}
export function validSummaryEvidence(value: unknown, sourceIds?: Set<string>): value is SummaryEvidence {
  return object(value) && string(value.id,100) && !!value.id && [...SUMMARY_SECTIONS,'conclusion','reference','other'].includes(String(value.section)) &&
    string(value.statement) && !!value.statement.trim() && strings(value.sourceIds) && value.sourceIds.length > 0 && new Set(value.sourceIds).size === value.sourceIds.length &&
    (!sourceIds || value.sourceIds.every(id => sourceIds.has(id))) && strings(value.quotes) && strings(value.values) && strings(value.caveats) &&
    ['study','prior-work'].includes(String(value.origin)) && ['reported','approximate','unclear'].includes(String(value.certainty));
}
export function parseSummaryExtraction(value: unknown, sources: SummarySource[]): SummaryExtraction {
  const ids = new Set(sources.map(s => s.id));
  if (!object(value) || !Array.isArray(value.evidence) || value.evidence.length > 120 || !value.evidence.every(e => validSummaryEvidence(e,ids)) ||
      !strings(value.concepts,12) || !strings(value.warnings,60)) throw new Error('A extração de evidências retornou dados ou referências inválidos.');
  return value as SummaryExtraction;
}
export function parseSummarySection(value: unknown, key: SummarySectionKey, evidence: SummaryEvidence[]): SummarySection {
  const ids = new Set(evidence.map(e => e.id));
  if (!object(value) || value.key !== key || !Array.isArray(value.paragraphs) || value.paragraphs.length > 100 || !strings(value.missing,60) ||
      (!value.paragraphs.length && !value.missing.length) || !value.paragraphs.every(p => object(p) && string(p.text) && !!p.text.trim() && strings(p.evidenceIds) &&
        p.evidenceIds.length > 0 && p.evidenceIds.every(id => ids.has(id)))) throw new Error('O resumo retornou conteúdo ou referências inválidos.');
  return value as SummarySection;
}
export function parseSummaryComments(value: unknown): SummaryComment[] {
  if (!object(value) || !Array.isArray(value.comments) || value.comments.length > 3 || !value.comments.every(c => object(c) && string(c.concept,300) && string(c.explanation) &&
      Array.isArray(c.sources) && c.sources.length <= 5 && c.sources.every(s => object(s) && string(s.title,500) && string(s.url,2000) && /^https?:\/\//i.test(s.url)))) {
    throw new Error('Os comentários explicativos retornaram fontes inválidas.');
  }
  return value.comments as SummaryComment[];
}
export function summaryQuality(session: SummarySession) {
  const issues = session.pages.flatMap(p => p.warnings.map(w => `Página ${p.number}: ${w}`));
  const numbers = new Set(session.pages.filter(p => Number.isInteger(p.number) && p.number >= 1 && p.number <= session.pageCount && p.status === 'analyzed').map(p => p.number));
  const analyzedPages = numbers.size;
  if (new Set(session.pages.map(p => p.number)).size !== session.pages.length || session.pages.some(p => p.number < 1 || p.number > session.pageCount)) issues.push('A relação de páginas do PDF está inconsistente.');
  if (analyzedPages !== session.pageCount) issues.unshift(`${analyzedPages}/${session.pageCount} páginas com evidências analisadas.`);
  for (const section of Object.values(session.sections)) if (section) issues.push(...section.missing.map(m => `${SUMMARY_LABELS[section.key]}: ${m}`));
  return { complete: analyzedPages === session.pageCount && issues.length === 0, issues, analyzedPages, totalPages: session.pageCount };
}
