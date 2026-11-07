import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, Check, ChevronLeft, ChevronRight, Crop, LoaderCircle, X } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfSourceOptions } from './pdf-options';
import { analyzePdf, cropPdfRegion, rebuildDocument, inheritAnalysisMetadata } from './structured-analyze';
import { translateStructured, type TranslationState } from './structured-translation';
import { createStructuredDocx, createStructuredPdf, validateStructuredSource } from './structured-export';
import type { PdfLayoutReport } from './pdf-layout';
import PdfComparison from './PdfComparison';
import { type StructuredDocument, type DocumentAsset, type SourceRect, type DocumentBlock, type DocumentIssue, type ContentRun, type TranslatedDocument, blockText } from './structured-document';
import { hasUnprotectedOcrMath, ocrMathWarning } from './ocr-layout';
import { MAX_FILE_BYTES, MAX_PDF_PAGES, SOURCE_LANGUAGES, TARGET_LANGUAGES, formatFileSize } from './shared';
import './structured.css';

type Props = { file: File; source: string; target: string; code: string; configured: boolean; ocrConfigured?: boolean; ocrModel?: string; accessRequired?: boolean; workflow?: 'review' | 'direct'; onCodeChange?: (code: string) => void; onClose: () => void };
type Phase = 'analyzing' | 'review' | 'translating' | 'translated-review' | 'exporting' | 'ready' | 'error';
const labels: Record<DocumentAsset['kind'], string> = { 'equation-inline': 'Símbolo na frase', 'equation-block': 'Equação', figure: 'Figura', table: 'Tabela preservada' };
const blockLabels: Record<DocumentBlock['kind'], string> = { paragraph: 'Parágrafo', heading: 'Título', caption: 'Legenda', equation: 'Equação', figure: 'Figura', table: 'Tabela' };
const reason = (e: unknown) => e instanceof Error ? e.message : 'Não foi possível concluir esta operação.';
function sourceTextPositions(text: string, expression: string): number[] {
  if (!expression) return [];
  const positions: number[] = [];
  for (let start = text.indexOf(expression); start >= 0; start = text.indexOf(expression, start + 1)) positions.push(start);
  return positions;
}
function refreshOcrMathIssue(issues: DocumentIssue[], block: DocumentBlock): DocumentIssue[] {
  if (block.geometry !== 'block') return issues;
  const id = `ocr-inline-math-${block.id}`;
  const updated = issues.filter(issue => issue.id !== id);
  if (hasUnprotectedOcrMath(block.runs.map(run => run.type === 'text' ? run.text : '').join(''))) updated.push(ocrMathWarning(block.page, block.id));
  return updated;
}

export default function StructuredTranslation({ file, source, target, code, configured, ocrConfigured = false, ocrModel, accessRequired = false, workflow = 'review', onCodeChange, onClose }: Props) {
  const direct = workflow === 'direct';
  const [manifest, setManifest] = useState<StructuredDocument | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [phase, setPhase] = useState<Phase>('analyzing');
  const [message, setMessage] = useState('Analisando o documento…');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());
  const [selection, setSelection] = useState<SourceRect | null>(null);
  const [selectedAsset, setSelectedAsset] = useState('');
  const [sourceBlock, setSourceBlock] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceOccurrence, setSourceOccurrence] = useState(1);
  const [cropKind, setCropKind] = useState<DocumentAsset['kind']>('equation-block');
  const [alt, setAlt] = useState('Equação preservada do original');
  const [editingRegion, setEditingRegion] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [wordUrl, setWordUrl] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfLayout, setPdfLayout] = useState<PdfLayoutReport | null>(null);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [translation, setTranslation] = useState<TranslatedDocument | null>(null);
  const [translationReviewed, setTranslationReviewed] = useState(false);
  const [analysisAttempt, setAnalysisAttempt] = useState(0);
  const [showSourceReview, setShowSourceReview] = useState(!direct);
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sessionVersion = useRef(0);
  const cache = useRef<TranslationState>({ completed: {} });
  const mergedBlocks = useRef(new Map<string, Set<string>>());
  const running = useRef(false);
  const autoStartPending = useRef(direct);
  const busy = phase === 'analyzing' || phase === 'translating' || phase === 'exporting' || editingRegion;
  const pageSize = manifest?.pages[pageNumber - 1];
  const pageBlocks = manifest?.blocks.filter(b => b.page === pageNumber || b.fragments?.some(f => f.page === pageNumber)) || [];
  const pageAssets = manifest?.assets.filter(a => a.page === pageNumber) || [];
  const stem = file.name.replace(/\.[^.]+$/, '') + '-' + target.toLowerCase() + '-preservado';

  useEffect(() => {
    controller.current?.abort();
    const version = ++sessionVersion.current;
    const abort = new AbortController(); controller.current = abort;
    const current = () => sessionVersion.current === version && !abort.signal.aborted;
    running.current = false;
    autoStartPending.current = direct;
    setManifest(null); setPdf(null); setPageNumber(1); setConfirmed(new Set());
    setSelection(null); setSelectedAsset(''); setSourceBlock(''); setSourceText(''); setSourceOccurrence(1);
    setTranslation(null); setTranslationReviewed(false); setEditingRegion(false); setShowSourceReview(!direct);
    cache.current = { completed: {} }; mergedBlocks.current.clear();
    clearArtifacts();
    setPhase('analyzing'); setMessage('Preparando todas as páginas do PDF para o Mistral OCR…'); setError('');
    let sourcePdf: PDFDocumentProxy | undefined;
    let loading: { destroy: () => Promise<void> } | undefined;
    void (async () => {
      try {
        const document = await analyzePdf(file, m => { if (current()) setMessage(m); }, abort.signal, { code, ocrConfigured, ocrModel });
        if (!current()) return;
        const [pdfjs, worker, bytes] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url'), file.arrayBuffer()]);
        if (!current()) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        loading = pdfjs.getDocument({ data: new Uint8Array(bytes), ...pdfSourceOptions() });
        sourcePdf = await (loading as ReturnType<typeof pdfjs.getDocument>).promise;
        if (!current()) { await sourcePdf.destroy(); return; }
        setManifest(document); setPdf(sourcePdf); setPhase('review');
        setMessage(direct ? 'Extração concluída. Preparando a tradução direta…' : 'Confira as páginas antes de enviar o texto para tradução.');
      } catch (e) { if (current()) { setError(reason(e)); setPhase('error'); } }
    })();
    return () => {
      abort.abort();
      if (sessionVersion.current === version) { sessionVersion.current++; controller.current?.abort(); running.current = false; }
      if (sourcePdf) void sourcePdf.destroy().catch(() => {}); else void loading?.destroy().catch(() => {});
    };
  }, [file, analysisAttempt]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (manifest) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [manifest]);
  useEffect(() => () => { if (wordUrl) URL.revokeObjectURL(wordUrl); }, [wordUrl]);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    setSelection(null); setSelectedAsset(''); setSourceBlock(''); setSourceText(''); setSourceOccurrence(1); setRendering(true); setPreviewError('');
    void (async () => {
      try {
        if (!pdf || !canvas.current) return;
        const page = await pdf.getPage(pageNumber);
        if (cancelled || !canvas.current) return;
        const viewport = page.getViewport({ scale: 1.5 });
        canvas.current.width = Math.ceil(viewport.width); canvas.current.height = Math.ceil(viewport.height);
        const task = page.render({ canvas: canvas.current, viewport }); stop = () => task.cancel();
        await task.promise;
      } catch (e) { if (!cancelled) setPreviewError(reason(e)); }
      finally { if (!cancelled) setRendering(false); }
    })();
    return () => { cancelled = true; stop?.(); };
  }, [pdf, pageNumber, previewAttempt, showSourceReview]);

  function clearArtifacts() {
    setWordUrl(''); setPdfUrl(''); setPdfBlob(null); setPdfLayout(null); setComparisonOpen(false);
  }
  function revise(next: StructuredDocument) {
    if (manifest) inheritAnalysisMetadata(manifest, next);
    setManifest(next); setTranslation(null); setTranslationReviewed(false); clearArtifacts(); cache.current = { completed: {} };
    const affected = new Set([pageNumber]);
    for (const before of manifest?.blocks || []) {
      const after = next.blocks.find(b => b.id === before.id);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        affected.add(before.page); before.fragments?.forEach(f => affected.add(f.page));
        if (after) { affected.add(after.page); after.fragments?.forEach(f => affected.add(f.page)); }
      }
    }
    setConfirmed(previous => { const copy = new Set(previous); affected.forEach(p => copy.delete(p)); return copy; });
    setPhase('review'); setError('');
  }
  function reviseRegions(next: StructuredDocument, changed: SourceRect[]) {
    if (!manifest) return;
    const overlaps = (a: SourceRect, b: SourceRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    const touched = (block: DocumentBlock) => (block.fragments || [{ page: block.page, rect: block.rect }]).some(fragment => fragment.page === pageNumber && changed.some(rect => overlaps(rect, fragment.rect)));
    const absorbed = new Set<string>();
    for (const [id, members] of mergedBlocks.current) {
      const previous = manifest.blocks.find(b => b.id === id);
      // A crop touching a manually joined paragraph recalculates its source
      // fragments. Elsewhere, keep the join and hide its absorbed source IDs.
      if (!previous || touched(previous)) mergedBlocks.current.delete(id);
      else members.forEach(member => absorbed.add(member));
    }
    // Rebuilding a crop uses raw PDF spans. Keep other pages and unaffected
    // manual corrections, so a new crop never silently rewrites reviewed pages.
    const rebuilt = next.blocks.filter(b => !absorbed.has(b.id)).map(b => {
      const previous = manifest.blocks.find(old => old.id === b.id);
      if (!previous) return b;
      if (touched(previous) || touched(b)) return b;
      if (JSON.stringify(previous.rect) !== JSON.stringify(b.rect)) return b;
      if (previous.runs.some(r => r.type === 'asset' && !next.assets.some(a => a.id === r.assetId))) return b;
      return previous;
    });
    const blocks = manifest.pages.flatMap((_, index) => {
      const page = index + 1;
      const original = manifest.blocks.filter(b => b.page === page);
      const candidates = rebuilt.filter(b => b.page === page);
      // Preserve a user's ordering on pages whose membership did not change.
      if (page !== pageNumber && original.length === candidates.length && original.every(b => candidates.some(c => c.id === b.id))) return original.map(b => candidates.find(c => c.id === b.id)!);
      return candidates;
    });
    const valid = new Set(blocks.filter(b => b.kind === 'caption').map(b => b.id));
    const finalBlocks = blocks.map(b => b.captionId && !valid.has(b.captionId) ? { ...b, captionId: undefined } : b);
    revise({ ...next, blocks: finalBlocks, issues: finalBlocks.reduce(refreshOcrMathIssue, next.issues) });
  }
  function editBlock(id: string, change: Partial<DocumentBlock>) {
    if (!manifest) return;
    const changed = manifest.blocks.find(block => block.id === id);
    if (!changed) return;
    const block = { ...changed, ...change };
    revise({ ...manifest, blocks: manifest.blocks.map(b => b.id === id ? block : b), issues: refreshOcrMathIssue(manifest.issues, block) });
  }
  function editRun(block: DocumentBlock, index: number, text: string) {
    const runs: ContentRun[] = block.runs.map((r, i) => i === index && r.type === 'text' ? { ...r, text } : r);
    editBlock(block.id, { runs });
  }
  function moveBlock(id: string, direction: number) {
    if (!manifest) return;
    const blocks = [...manifest.blocks], index = blocks.findIndex(b => b.id === id), neighbor = index + direction;
    if (index < 0 || blocks[index].page !== pageNumber || neighbor < 0 || neighbor >= blocks.length || blocks[neighbor].page !== pageNumber) return;
    [blocks[index], blocks[neighbor]] = [blocks[neighbor], blocks[index]];
    revise({ ...manifest, blocks });
  }
  function mergeBlock(id: string) {
    if (!manifest) return;
    const index = manifest.blocks.findIndex(b => b.id === id), first = manifest.blocks[index], next = manifest.blocks[index + 1];
    if (!first || !next || first.assetId || next.assetId || first.kind !== next.kind || !['paragraph', 'heading'].includes(first.kind) || next.page !== first.page) return;
    const runs = first.runs.map(r => r.type === 'text' ? { ...r } : r);
    const last = runs.at(-1);
    if (last?.type === 'text' && !/\s$/.test(last.text)) last.text += ' ';
    else if (last?.type === 'asset') runs.push({ type: 'text', text: ' ' });
    runs.push(...next.runs);
    const joined = { ...first, runs, fragments: [...(first.fragments || [{ page: first.page, rect: first.rect }]), ...(next.fragments || [{ page: next.page, rect: next.rect }])] };
    mergedBlocks.current.set(first.id, new Set([...(mergedBlocks.current.get(first.id) || []), next.id, ...(mergedBlocks.current.get(next.id) || [])]));
    mergedBlocks.current.delete(next.id);
    revise({ ...manifest, blocks: manifest.blocks.flatMap(b => b.id === first.id ? [joined] : b.id === next.id ? [] : [{ ...b, ...(b.captionId === next.id ? { captionId: first.id } : {}) }]) });
  }
  function pointer(e: PointerEvent<HTMLDivElement>) {
    if (!surface.current || !pageSize) return { x: 0, y: 0 };
    const box = surface.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(pageSize.width, (e.clientX - box.left) * pageSize.width / box.width)), y: Math.max(0, Math.min(pageSize.height, (e.clientY - box.top) * pageSize.height / box.height)) };
  }
  function beginSelection(e: PointerEvent<HTMLDivElement>) {
    if (busy || rendering || !pageSize) return;
    origin.current = pointer(e); setSelectedAsset(''); setSourceBlock(''); setSourceText(''); setSourceOccurrence(1);
    setSelection({ ...origin.current, width: 0, height: 0 }); e.currentTarget.setPointerCapture(e.pointerId);
  }
  function dragSelection(e: PointerEvent<HTMLDivElement>) {
    if (!origin.current) return;
    const end = pointer(e), start = origin.current;
    setSelection({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) });
  }
  async function preserveRegion() {
    if (!manifest || !selection || selection.width < 1 || selection.height < 1 || busy) return;
    if (sourceBlock) {
      const block = pageBlocks.find(entry => entry.id === sourceBlock && entry.geometry === 'block');
      const text = block ? originalBlockText(block) : '';
      const positions = sourceTextPositions(text, sourceText);
      if (!Number.isInteger(sourceOccurrence) || !positions.length || sourceOccurrence < 1 || sourceOccurrence > positions.length) {
        setError('Copie o texto exato da fórmula ou expressão original, incluindo suas marcações, e escolha a ocorrência correspondente ao recorte.');
        return;
      }
    }
    setEditingRegion(true); setError('');
    const version = sessionVersion.current;
    const abort = new AbortController(); controller.current = abort;
    try {
      const asset = await cropPdfRegion(file, pageNumber, selection, cropKind, selectedAsset || `asset-${crypto.randomUUID()}`, abort.signal);
      if (abort.signal.aborted || sessionVersion.current !== version) return;
      asset.alt = alt.trim() || labels[cropKind];
      if (sourceBlock) asset.sourceText = { blockId: sourceBlock, text: sourceText, occurrence: sourceOccurrence };
      const assets = [...manifest.assets.filter(a => a.id !== asset.id), asset];
      const old = manifest.assets.find(a => a.id === asset.id);
      reviseRegions(rebuildDocument(manifest, assets), [asset.rect, ...(old ? [old.rect] : [])]); setSelection(null); setSelectedAsset('');
      setMessage('Região preservada. Confira novamente os trechos afetados desta página; sua extração foi recalculada.');
    } catch (e) { if (!abort.signal.aborted && sessionVersion.current === version) setError(reason(e)); }
    finally { if (sessionVersion.current === version) setEditingRegion(false); }
  }
  function removeAsset(id: string) {
    if (!manifest) return;
    try { reviseRegions(rebuildDocument(manifest, manifest.assets.filter(a => a.id !== id)), manifest.assets.filter(a => a.id === id).map(a => a.rect)); setSelection(null); setSelectedAsset(''); }
    catch (e) { setError(reason(e)); }
  }
  function originalBlockText(block?: DocumentBlock) {
    if (!block) return '';
    return block.originalText ?? block.runs.map(run => run.type === 'text' ? run.text : manifest?.assets.find(asset => asset.id === run.assetId)?.sourceText?.text || '').join('');
  }
  function restartAnalysis() {
    setManifest(null); setPdf(null); setPageNumber(1); setConfirmed(new Set()); setSelection(null); setSelectedAsset('');
    setSourceBlock(''); setSourceText(''); setSourceOccurrence(1); setTranslation(null); setTranslationReviewed(false); clearArtifacts();
    cache.current = { completed: {} }; mergedBlocks.current.clear(); setAnalysisAttempt(attempt => attempt + 1);
  }
  function confirmPage() {
    if (!manifest || busy || rendering || previewError) return;
    setConfirmed(previous => new Set(previous).add(pageNumber)); setError('');
    if (manifest && pageNumber < manifest.pages.length) setPageNumber(pageNumber + 1);
  }
  function interrupt() {
    controller.current?.abort();
    if (phase === 'analyzing') {
      setPhase('error'); setError('A análise foi interrompida. Tente novamente ou volte à seleção do PDF.');
      setMessage('A análise parou. Uma página já enviada ao OCR pode continuar sendo processada e gerar cobrança.');
    }
  }
  async function translate() {
    if (!manifest || running.current || !canTranslate) return;
    running.current = true;
    const version = sessionVersion.current;
    const abort = new AbortController(); controller.current = abort;
    const current = () => sessionVersion.current === version && !abort.signal.aborted;
    const progress = (status: string) => { if (current()) setMessage(status); };
    setError('');
    try {
      if (!translation) {
        setPhase('translating');
        setMessage('Conferindo a integridade dos elementos antes da tradução…');
        await validateStructuredSource(manifest, abort.signal);
        if (!current()) return;
        const result = await translateStructured(manifest, { source, target, code }, cache.current, progress, abort.signal);
        if (!current()) return;
        setTranslation(result);
        if (!direct && result.document.issues.some(i => i.id.startsWith('translation-'))) {
          setPhase('translated-review'); setMessage('Confira os trechos sinalizados na tradução antes de gerar os arquivos.');
          return;
        }
        await exportResult(result, abort.signal, version);
      } else { await exportResult(translation, abort.signal, version); }
    } catch (e) {
      if (sessionVersion.current !== version) return;
      if (abort.signal.aborted) { setPhase('review'); setMessage('Operação interrompida. Os blocos já recebidos continuam nesta sessão.'); }
      else { setError(reason(e)); setPhase('error'); }
    } finally {
      if (sessionVersion.current === version) {
        if (abort.signal.aborted) { setPhase('review'); setMessage('Operação interrompida. Os blocos já recebidos continuam nesta sessão.'); }
        running.current = false;
      }
    }
  }
  async function exportResult(result: TranslatedDocument, signal: AbortSignal, version: number) {
    const current = () => sessionVersion.current === version && !signal.aborted;
    const progress = (status: string) => { if (current()) setMessage(status); };
    if (!current()) return;
    clearArtifacts();
    setPhase('exporting');
    const failures: string[] = [];
    let pdfReady = false, wordReady = false;
    try {
      let layout: PdfLayoutReport | null = null;
      const output = await createStructuredPdf(result, progress, signal, (report: PdfLayoutReport) => { layout = report; });
      if (!current()) return;
      setPdfUrl(URL.createObjectURL(output)); setPdfBlob(output); setPdfLayout(layout); setComparisonOpen(true); pdfReady = true;
    } catch (e) {
      if (sessionVersion.current !== version) return;
      if (signal.aborted) throw e;
      failures.push(`PDF: ${reason(e)}`);
    }
    try {
      const word = await createStructuredDocx(result, progress, signal);
      if (!current()) return;
      setWordUrl(URL.createObjectURL(word)); wordReady = true;
    } catch (e) {
      if (sessionVersion.current !== version) return;
      if (signal.aborted) throw e;
      failures.push(`Word: ${reason(e)}`);
    }
    if (!current()) return;
    if (!pdfReady && !wordReady) throw new Error(failures.join(' '));
    setError(failures.join(' ')); setPhase('ready');
    setMessage(pdfReady ? wordReady ? 'Word e PDF prontos. Compare o PDF traduzido com o original antes de usar.' : 'O PDF está pronto para baixar e comparar. Não foi possível montar o Word.' : 'O Word está pronto para baixar. Não foi possível montar o PDF.');
  }
  function editTranslationRun(id: string, index: number, text: string) {
    if (!translation || busy) return;
    const runs = translation.blocks[id];
    if (!runs || runs[index]?.type !== 'text') return;
    setTranslation({ ...translation, blocks: { ...translation.blocks, [id]: runs.map((r, i) => i === index && r.type === 'text' ? { ...r, text } : r) } });
    setTranslationReviewed(false); clearArtifacts(); setPhase('translated-review');
    setMessage('Correção local aplicada. Confira o trecho antes de montar os arquivos.');
  }
  function previewRuns(runs: ContentRun[]) {
    return runs.map((run, index) => {
      if (run.type === 'text') return <span key={index}>{run.text}</span>;
      const asset = manifest?.assets.find(a => a.id === run.assetId);
      return asset ? <img key={index} className="structured-review-symbol" src={asset.dataUrl} alt={asset.alt}/> : <span key={index}>[Símbolo preservado]</span>;
    });
  }
  function translationEditor(block: DocumentBlock) {
    const runs = translation?.blocks[block.id] || [];
    return <><p><strong>Original:</strong> {previewRuns(block.runs)}</p><p><strong>Tradução:</strong> {previewRuns(runs)}</p>{runs.map((run, index) => run.type === 'text' ? <textarea aria-label={`Correção da tradução na página ${block.page}, trecho ${block.id}, parte ${index + 1}`} key={index} value={run.text} disabled={busy} rows={Math.min(8, Math.max(2, Math.ceil(run.text.length / 90)))} onChange={e => editTranslationRun(block.id, index, e.target.value)}/> : <span key={index} className="structured-inline">{previewRuns([run])}</span>)}</>;
  }
  const translationIssues = translation?.document.issues.filter(i => i.id.startsWith('translation-')) || [];
  const accessReady = configured && (!accessRequired || Boolean(code.trim()));
  const canTranslate = manifest && (direct || confirmed.size === manifest.pages.length) && !manifest.issues.some(i => i.severity === 'blocking') && (translation || accessReady) && !busy && (direct || !translationIssues.length || translationReviewed);
  const completedBlocks = Object.keys(cache.current.completed).length;
  const sourceLabel = SOURCE_LANGUAGES.find(([value]) => value === source)?.[1] || 'Detecção automática';
  const targetLabel = TARGET_LANGUAGES.find(([value]) => value === target)?.[1] || target;
  const currentStep = phase === 'analyzing' || (!manifest && phase === 'error') ? 0 : phase === 'ready' ? (direct ? 2 : 3) : direct ? 1 : translation || phase === 'translating' || phase === 'exporting' ? 2 : 1;
  const failedOcr = Boolean(manifest?.issues.some(entry => entry.id.startsWith('ocr-failed-') && entry.severity === 'blocking'));
  const canRetryAnalysis = !busy && ((!manifest && phase === 'error') || failedOcr);
  const ocrTextBlocks = pageBlocks.filter(block => block.geometry === 'block' && !block.assetId);
  const selectedSourceOriginal = originalBlockText(ocrTextBlocks.find(block => block.id === sourceBlock));
  const sourcePositions = sourceTextPositions(selectedSourceOriginal, sourceText);

  useEffect(() => {
    if (!direct || !manifest || phase !== 'review' || !autoStartPending.current) return;
    // Consume the automatic start before launching; pauses and failures require
    // an explicit retry and must never silently send another paid request.
    autoStartPending.current = false;
    if (manifest.issues.some(issue => issue.severity === 'blocking')) {
      setShowSourceReview(true);
      setMessage('A extração encontrou um problema. Confira os trechos sinalizados antes de continuar a tradução.');
      return;
    }
    if (!accessReady) {
      setMessage('Extração concluída. Verifique a disponibilidade da tradução e o código de acesso para continuar.');
      return;
    }
    void translate();
  }, [direct, manifest, phase, accessReady]);

  return <main className="structured-workspace">
    <header className="structured-header"><button className="structured-secondary" disabled={busy} onClick={onClose}><ArrowLeft size={17}/>Voltar à seleção</button><span className="version-pill">PDF · até {formatFileSize(MAX_FILE_BYTES)} · {MAX_PDF_PAGES} páginas</span></header>
    <div className="eyebrow"><span/> IMAGENS E EQUAÇÕES PRESERVADAS</div>
    <h1>{direct ? 'Tradução direta do artigo' : 'Confira o original. Traduza o texto.'}</h1>
    <p className="structured-intro">{direct ? 'Todas as páginas passam pelo Mistral OCR e seguem automaticamente para tradução, sem conferência prévia. O PDF procura preservar a organização do original, e você pode comparar o resultado depois. O Word é montado em uma coluna.' : 'Todas as páginas são processadas pelo Mistral OCR, inclusive as que têm texto selecionável. Confira cada página antes de traduzir; o reconhecimento pode conter erros. O PDF procura preservar a organização do original, com imagens e equações preservadas. O Word é montado em uma coluna.'}</p>
    <p className="structured-file"><strong>{file.name}</strong><span>{formatFileSize(file.size)} · {sourceLabel} → {targetLabel}</span></p>
    <ol className={`structured-steps${direct ? ' direct-steps' : ''}`} aria-label="Etapas da tradução">{(direct ? ['Analisar PDF', 'Traduzir texto', 'Baixar arquivos'] : ['Analisar PDF', 'Conferir páginas', 'Traduzir texto', 'Baixar arquivos']).map((label, index) => <li className={index < currentStep ? 'complete' : index === currentStep ? 'active' : ''} aria-current={index === currentStep ? 'step' : undefined} key={label}><span>{index < currentStep ? <Check size={14}/> : index + 1}</span>{label}</li>)}</ol>
    {error && <p className="notice error-notice" role="alert">{error}</p>}
    {canRetryAnalysis && accessRequired && onCodeChange && <label className="access-label">Código de acesso para OCR<input type="password" autoComplete="off" value={code} onChange={e => onCodeChange(e.target.value)} placeholder="Informe o código deste aplicativo"/></label>}
    <div className="structured-status" role="status" aria-live="polite">{busy && <LoaderCircle size={18} className="spin"/>}<span>{message}</span>{['analyzing', 'translating', 'exporting'].includes(phase) && <button className="structured-secondary" onClick={interrupt}>Interromper</button>}{canRetryAnalysis && <button className="structured-secondary" disabled={accessRequired && !code.trim()} onClick={restartAnalysis}>Analisar novamente</button>}</div>
    {canRetryAnalysis && <p className="structured-hint">Uma nova tentativa reutiliza páginas já reconhecidas nesta sessão e reinicia a revisão manual. Solicitações sem resposta podem ter sido processadas e cobradas pelo provedor.</p>}
    {manifest && <>
      <div className="structured-summary"><span>{manifest.pages.length} páginas</span><span>{manifest.assets.filter(a => a.kind.startsWith('equation')).length} recortes matemáticos</span><span>{manifest.assets.filter(a => a.kind === 'figure' || a.kind === 'table').length} figuras/tabelas</span><strong>{direct ? 'Tradução direta · revisão opcional' : `${confirmed.size}/${manifest.pages.length} páginas conferidas`}</strong></div>
      {direct && <button className="structured-secondary" disabled={busy} aria-expanded={showSourceReview} onClick={() => setShowSourceReview(value => !value)}>{showSourceReview ? 'Ocultar extração e recortes' : 'Revisar extração e recortes'}</button>}
      {showSourceReview && <div className="structured-grid">
        <section className="structured-original" aria-label="Página original e recortes">
          <nav className="structured-page-nav"><button aria-label="Página anterior" disabled={pageNumber <= 1 || busy} onClick={() => setPageNumber(p => p - 1)}><ChevronLeft/></button><span>Página {pageNumber} de {manifest.pages.length}{confirmed.has(pageNumber) ? ' · conferida' : ''}</span><button aria-label="Próxima página" disabled={pageNumber >= manifest.pages.length || busy} onClick={() => setPageNumber(p => p + 1)}><ChevronRight/></button></nav>
          <p className="structured-hint">Arraste sobre uma região para preservar sua aparência. Clique em um recorte listado para ajustar seus limites.</p>
          {previewError && <p className="notice error-notice" role="alert">Não foi possível exibir esta página: {previewError} <button className="text-button" disabled={busy || rendering} onClick={() => setPreviewAttempt(value => value + 1)}>Tentar exibir novamente</button></p>}
          <div className="structured-surface" ref={surface} style={{ aspectRatio: pageSize ? `${pageSize.width}/${pageSize.height}` : '1' }} onPointerDown={beginSelection} onPointerMove={dragSelection} onPointerUp={() => { origin.current = null; }} onPointerCancel={() => { origin.current = null; }}>
            <canvas ref={canvas}/>
            {pageSize && pageAssets.map(a => <span key={a.id} className={`structured-box ${a.kind}`} style={{ left: `${a.rect.x / pageSize.width * 100}%`, top: `${a.rect.y / pageSize.height * 100}%`, width: `${a.rect.width / pageSize.width * 100}%`, height: `${a.rect.height / pageSize.height * 100}%` }} />)}
            {pageSize && selection && <span className="structured-box selection" style={{ left: `${selection.x / pageSize.width * 100}%`, top: `${selection.y / pageSize.height * 100}%`, width: `${selection.width / pageSize.width * 100}%`, height: `${selection.height / pageSize.height * 100}%` }}/>} 
          </div>
          {selection && <div className="structured-crop-tools">
            <label>Conteúdo<select aria-label="Conteúdo" value={cropKind} disabled={busy} onChange={e => { const kind = e.target.value as DocumentAsset['kind']; setCropKind(kind); if (/^(?:Figura|Equação|Tabela|Símbolo).*preservad[ao](?: do original| do documento original)?$/.test(alt)) setAlt(`${labels[kind]} preservad${kind === 'equation-inline' ? 'o' : 'a'} do original`); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Descrição<input value={alt} disabled={busy} onChange={e => setAlt(e.target.value)}/></label>
            {ocrTextBlocks.length > 0 && <>
              <p className="structured-hint">Para preservar um símbolo dentro de uma frase reconhecida por OCR, escolha o trecho e copie exatamente toda a fórmula ou expressão que o recorte substitui, incluindo suas marcações.</p>
              <label className="structured-ocr-field">Trecho de texto substituído<select aria-label="Trecho de texto substituído" value={sourceBlock} disabled={busy} onChange={e => { setSourceBlock(e.target.value); setSourceText(''); setSourceOccurrence(1); }}><option value="">Nenhum trecho associado</option>{ocrTextBlocks.map((block, index) => <option key={block.id} value={block.id}>{index + 1} · {originalBlockText(block).slice(0, 100)}</option>)}</select></label>
              {sourceBlock && <>
                <label className="structured-ocr-field">Texto original substituído pelo recorte<textarea aria-label="Texto original substituído pelo recorte" value={sourceText} disabled={busy} rows={3} onChange={e => { setSourceText(e.target.value); setSourceOccurrence(1); }}/></label>
                {sourcePositions.length > 1 && <label className="structured-ocr-field">Ocorrência da expressão<select aria-label="Ocorrência da expressão" value={sourceOccurrence} disabled={busy} onChange={e => setSourceOccurrence(Number(e.target.value))}>{sourcePositions.map((position, index) => <option key={position} value={index + 1}>{index + 1} · …{selectedSourceOriginal.slice(Math.max(0, position - 28), position)}【{sourceText}】{selectedSourceOriginal.slice(position + sourceText.length, position + sourceText.length + 28)}…</option>)}</select></label>}
                <details><summary>Ver texto original do trecho</summary><textarea aria-label="Texto original do trecho escolhido" readOnly rows={5} value={selectedSourceOriginal}/></details>
              </>}
            </>}
            <div className="structured-coordinates">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{({ x: 'Esquerda', y: 'Topo', width: 'Largura', height: 'Altura' })[key]}<input type="number" step="0.1" min="0" value={Number(selection[key].toFixed(2))} disabled={busy} onChange={e => setSelection({ ...selection, [key]: Number(e.target.value) })}/></label>)}</div>
            <button className="structured-secondary" disabled={busy || selection.width < 1 || selection.height < 1} onClick={() => void preserveRegion()}><Crop size={17}/>{selectedAsset ? 'Atualizar recorte' : 'Preservar região'}</button>
          </div>}
          <div className="structured-assets">{pageAssets.map((a, i) => <div key={a.id}><button disabled={busy} onClick={() => { setSelection(a.rect); setSelectedAsset(a.id); setCropKind(a.kind); setAlt(a.alt); setSourceBlock(a.sourceText?.blockId || ''); setSourceText(a.sourceText?.text || ''); setSourceOccurrence(a.sourceText?.occurrence || 1); }}><img src={a.dataUrl} alt={a.alt}/><span>{labels[a.kind]} {i + 1}</span></button><button className="icon-button" aria-label={`Remover ${labels[a.kind]} ${i + 1}`} disabled={busy} onClick={() => removeAsset(a.id)}><X size={16}/></button></div>)}</div>
        </section>
        <section className="structured-reading" aria-label="Texto extraído na ordem de leitura">
          <h2>Ordem de leitura e conteúdo</h2>
          <p className="structured-hint">A sequência abaixo será usada na montagem. Revise as palavras extraídas e mantenha as legendas junto das figuras.</p>
          {manifest.issues.filter(i => i.page === pageNumber).map(i => <p key={i.id} className={`notice ${i.severity === 'blocking' ? 'error-notice' : ''}`}>{i.message}</p>)}
          <div className="structured-blocks">{pageBlocks.map((block, index) => <article key={block.id} className="structured-block"><div className="structured-block-head"><span>{index + 1} · {blockLabels[block.kind]}{block.page !== pageNumber ? ' · continuação da página anterior' : ''}</span><button disabled={busy || index === 0 || block.page !== pageNumber} aria-label={`Mover trecho ${index + 1} para cima`} onClick={() => moveBlock(block.id, -1)}>↑</button><button disabled={busy || index === pageBlocks.length - 1 || block.page !== pageNumber} aria-label={`Mover trecho ${index + 1} para baixo`} onClick={() => moveBlock(block.id, 1)}>↓</button></div>
            {block.assetId ? <p>{manifest.assets.find(a => a.id === block.assetId)?.alt || blockText(block)}</p> : <>
              <label className="visually-hidden" htmlFor={`kind-${block.id}`}>Tipo do trecho {index + 1}</label><select id={`kind-${block.id}`} value={block.kind} disabled={busy} onChange={e => editBlock(block.id, { kind: e.target.value as DocumentBlock['kind'] })}>{['paragraph', 'heading', 'caption'].map(kind => <option key={kind} value={kind}>{blockLabels[kind as DocumentBlock['kind']]}</option>)}</select>
              {block.runs.map((r, j) => r.type === 'text' ? <textarea key={j} aria-label={`Texto do trecho ${index + 1}, parte ${j + 1}`} disabled={busy} rows={Math.min(8, Math.max(2, Math.ceil(r.text.length / 65)))} value={r.text} onChange={e => editRun(block, j, e.target.value)}/> : <span className="structured-inline" key={j}>[{manifest.assets.find(a => a.id === r.assetId)?.alt || 'Símbolo preservado'}]</span>)}
              {(() => { const next = manifest.blocks[manifest.blocks.indexOf(block) + 1]; return block.geometry !== 'block' && ['paragraph', 'heading'].includes(block.kind) && next && next.geometry !== 'block' && next.page === block.page && next.kind === block.kind && !next.assetId ? <button className="structured-secondary" disabled={busy} onClick={() => mergeBlock(block.id)}>Unir ao próximo trecho de texto</button> : null; })()}
              {block.kind === 'caption' && <label>Figura associada<select value={manifest.blocks.find(b => b.captionId === block.id)?.id || ''} disabled={busy} onChange={e => { const chosen = e.target.value; revise({ ...manifest, blocks: manifest.blocks.map(b => b.id === chosen ? { ...b, captionId: block.id } : b.captionId === block.id ? { ...b, captionId: undefined } : b) }); }}><option value="">Sem associação</option>{pageBlocks.filter(b => b.assetId && ['figure', 'table'].includes(b.kind)).map((b, k) => <option key={b.id} value={b.id}>Figura/tabela {k + 1}</option>)}</select></label>}
            </>}
          </article>)}</div>
          {!direct && <button className="structured-secondary structured-confirm" disabled={busy || rendering || Boolean(previewError) || manifest.issues.some(i => i.page === pageNumber && i.severity === 'blocking')} onClick={confirmPage}><Check size={18}/>{confirmed.has(pageNumber) ? pageNumber < manifest.pages.length ? 'Página conferida · avançar' : 'Página conferida' : 'Conferi texto, recortes e ordem desta página'}</button>}
        </section>
      </div>}
      {translation && translationIssues.length > 0 && <section className="structured-actions" aria-label="Conferir trechos traduzidos"><h2>{direct ? 'Sugestões de conferência' : 'Trechos que precisam de conferência'}</h2><p>Compare a tradução com o original. As correções abaixo são locais; os símbolos preservados permanecem no documento.{direct ? ' Essa conferência é opcional neste modo.' : ''}</p>{translationIssues.filter((issue, index, all) => all.findIndex(i => i.blockId === issue.blockId) === index).map(issue => {
        const original = manifest.blocks.find(b => b.id === issue.blockId);
        return original ? <article className="structured-block" key={issue.id}><p>{translationIssues.filter(i => i.blockId === issue.blockId).map(i => i.message).join(' ')} · Página original {issue.page}</p>{translationEditor(original)}</article> : null;
      })}{!direct && <label><input type="checkbox" checked={translationReviewed} disabled={busy} onChange={e => setTranslationReviewed(e.target.checked)}/> Conferi os trechos sinalizados e aceito montar os arquivos.</label>}</section>}
      {translation && <details className="structured-actions"><summary>Revisar todo o texto traduzido</summary><p>Confira termos técnicos e o sentido das frases. As correções são locais e não geram outro envio para tradução.</p><div className="structured-blocks">{manifest.blocks.filter(block => !block.assetId && translation.blocks[block.id]?.some(run => run.type === 'text')).map(block => <article className="structured-block" key={block.id}><p>{blockLabels[block.kind]} · Página original {block.page}</p>{translationEditor(block)}</article>)}</div></details>}
      <section className="structured-actions" aria-label="Traduzir e baixar">
        <h2>{phase === 'ready' ? 'Sua tradução está pronta' : translation ? 'Montar os arquivos traduzidos' : 'Pronto para traduzir?'}</h2>
        <p>O PDF usa o tamanho das páginas e a organização do original como referência. Equações, figuras e tabelas recortadas mantêm a aparência e o idioma do original. A paginação e algumas fontes podem mudar.</p>
        {!configured && !translation && <p className="notice">A tradução ainda não está disponível. Você pode analisar e revisar o PDF normalmente.</p>}
        {accessRequired && !translation && onCodeChange && <label className="access-label">Código de acesso<input type="password" autoComplete="off" value={code} disabled={busy} onChange={e => onCodeChange(e.target.value)} placeholder="Informe o código deste aplicativo"/></label>}
        {!direct && confirmed.size < manifest.pages.length && <p className="structured-hint">Confira as {manifest.pages.length - confirmed.size} páginas restantes para liberar a tradução.</p>}
        <button className="primary-button" disabled={!canTranslate} onClick={() => void translate()}>{busy ? <LoaderCircle size={18} className="spin"/> : null}{phase === 'translating' ? 'Traduzindo o texto…' : phase === 'exporting' ? 'Montando os arquivos…' : translation ? (wordUrl || pdfUrl ? 'Gerar os arquivos novamente' : 'Montar Word e PDF') : completedBlocks ? 'Retomar tradução' : 'Traduzir texto'}</button>
        <p className="structured-hint">{direct ? 'O texto extraído e o contexto necessário são enviados automaticamente para tradução.' : 'Somente o texto revisado e o contexto necessário são enviados para tradução.'} Mantenha esta página aberta para preservar o progresso.</p>
        {!translation && completedBlocks > 0 && <p className="structured-hint">{completedBlocks} blocos concluídos preservados nesta sessão.</p>}
        {wordUrl && <a className="structured-secondary" href={wordUrl} download={`${stem}.docx`}><ArrowDownToLine size={18}/>Baixar Word</a>}{pdfUrl && <a className="structured-secondary" href={pdfUrl} download={`${stem}.pdf`}><ArrowDownToLine size={18}/>Baixar PDF com texto selecionável</a>}
        {pdfUrl && pdfBlob && pdf && !comparisonOpen && <button className="structured-secondary" onClick={() => setComparisonOpen(true)}>Comparar PDF com o original</button>}
      </section>
      {pdfUrl && pdfBlob && pdf && comparisonOpen && <PdfComparison key={pdfUrl} original={pdf} resultBlob={pdfBlob} report={pdfLayout} onClose={() => setComparisonOpen(false)}/>}
    </>}
  </main>;
}
