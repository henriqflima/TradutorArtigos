import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowDownToLine, ChevronLeft, ChevronRight, Crop, FileText, LoaderCircle, Undo2, X } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfSourceOptions } from './pdf-options';
import { applyEquationRepairs, inspectRepairDocument, type EquationRepair, type RepairParagraph } from './equation-repair';
import { createPdf } from './pdf';
import './equation-repair.css';

type Props = {
  initialSource?: File;
  initialWord?: Blob;
  originalName?: string;
  onClose: () => void;
  onRepaired?: (blob: Blob) => void;
};
type Rectangle = { x: number; y: number; width: number; height: number };
type CropImage = { dataUrl: string; bytes: Uint8Array; widthPt: number; heightPt: number; page: number };
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'Não foi possível concluir esta operação.';

/** Offsets intentionally use UTF-16, matching the DOCX repair API and JS strings. */
function occurrences(text: string, search: string) {
  const result: number[] = [];
  if (search) for (let cursor = 0; cursor <= text.length - search.length;) {
    const offset = text.indexOf(search, cursor);
    if (offset < 0) break;
    result.push(offset);
    cursor = offset + search.length;
  }
  return result;
}

export default function EquationRepair({ initialSource, initialWord, originalName, onClose, onRepaired }: Props) {
  const [source, setSource] = useState<File | undefined>(initialSource);
  const [word, setWord] = useState<Blob | undefined>(initialWord);
  const [originalWord, setOriginalWord] = useState<Blob | undefined>(initialWord);
  const [wordName, setWordName] = useState(originalName || 'documento-traduzido.docx');
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [rectangle, setRectangle] = useState<Rectangle | null>(null);
  const [crop, setCrop] = useState<CropImage | null>(null);
  const [paragraphs, setParagraphs] = useState<RepairParagraph[]>([]);
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(0);
  const [mode, setMode] = useState<'block' | 'inline'>('block');
  const [search, setSearch] = useState('');
  const [inlineText, setInlineText] = useState('');
  const [occurrence, setOccurrence] = useState(1);
  const [baselineOffset, setBaselineOffset] = useState(-1);
  const [alt, setAlt] = useState('Equação preservada do documento original');
  const [history, setHistory] = useState<Blob[]>([]);
  const [wordUrl, setWordUrl] = useState('');
  const [outputPdf, setOutputPdf] = useState<Blob | null>(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [loadingSource, setLoadingSource] = useState(false);
  const [loadingWord, setLoadingWord] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const selectionSurface = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  const busy = loadingSource || loadingWord || rendering || working;
  // The undo buffer is bounded; exhausting it can still leave older repairs.
  const hasRepairs = Boolean(word && word !== originalWord);
  const selected = paragraphs.filter(p => p.index >= first && p.index <= (mode === 'inline' ? first : last));
  const selectedText = selected.map(p => p.text).join('\n');
  const matches = occurrences(selected[0]?.text || '', inlineText);
  const inlineOffset = matches[occurrence - 1];
  const validDestination = selected.length > 0 && (mode === 'block' ? first <= last : inlineOffset !== undefined);
  const outputName = wordName.replace(/\.[^.]+$/, '') + '-equacoes-reparadas';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!hasRepairs) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [hasRepairs]);
  useEffect(() => {
    let cancelled = false;
    let document: PDFDocumentProxy | undefined;
    let destroyLoading: (() => Promise<void>) | undefined;
    setPdf(null); setPageNumber(1); setPageSize({ width: 0, height: 0 }); setRectangle(null); setCrop(null);
    if (!source) return;
    setLoadingSource(true); setError('');
    void (async () => {
      try {
        if (source.size > 40_000_000) throw new Error('O PDF original deve ter até 40 MB para a revisão local.');
        const [pdfjs, worker, data] = await Promise.all([
          import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url'), source.arrayBuffer(),
        ]);
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({ data: new Uint8Array(data), ...pdfSourceOptions() });
        destroyLoading = () => task.destroy();
        document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch (cause) { if (!cancelled) setError(`PDF original: ${errorMessage(cause)}`); }
      finally { if (!cancelled) setLoadingSource(false); }
    })();
    return () => { cancelled = true; if (document) void document.destroy(); else if (destroyLoading) void destroyLoading(); };
  }, [source]);

  useEffect(() => {
    let cancelled = false;
    let cancelRender: (() => void) | undefined;
    setRectangle(null); setCrop(null);
    if (!pdf) { setRendering(false); return; }
    setRendering(true);
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled || !canvas.current) return;
        const viewport = page.getViewport({ scale: 1 });
        if (viewport.width > 3000 || viewport.height > 3000) throw new Error('A página excede o tamanho permitido para revisão local.');
        setPageSize({ width: viewport.width, height: viewport.height });
        const displayViewport = page.getViewport({ scale: 1.6 });
        const target = canvas.current;
        target.width = Math.ceil(displayViewport.width);
        target.height = Math.ceil(displayViewport.height);
        const task = page.render({ canvas: target, viewport: displayViewport });
        cancelRender = () => task.cancel();
        await task.promise;
      } catch (cause) { if (!cancelled) setError(`Exibição da página: ${errorMessage(cause)}`); }
      finally { if (!cancelled) setRendering(false); }
    })();
    return () => { cancelled = true; cancelRender?.(); };
  }, [pdf, pageNumber]);

  useEffect(() => {
    let cancelled = false;
    setParagraphs([]); setFirst(0); setLast(0); setInlineText(''); setOccurrence(1); setSearch('');
    if (!word) return;
    setLoadingWord(true);
    void inspectRepairDocument(word).then(result => {
      if (!cancelled) {
        setParagraphs(result);
        setFirst(result[0]?.index ?? 0); setLast(result[0]?.index ?? 0);
      }
    }).catch(cause => { if (!cancelled) setError(`Word traduzido: ${errorMessage(cause)}`); })
      .finally(() => { if (!cancelled) setLoadingWord(false); });
    return () => { cancelled = true; };
  }, [word]);

  useEffect(() => {
    if (!word || !hasRepairs) { setWordUrl(''); return; }
    const url = URL.createObjectURL(word); setWordUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [word, hasRepairs]);
  useEffect(() => {
    if (!outputPdf) { setPdfUrl(''); return; }
    const url = URL.createObjectURL(outputPdf); setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [outputPdf]);

  function pointerPosition(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(pageSize.width, (event.clientX - bounds.left) * pageSize.width / bounds.width)),
      y: Math.max(0, Math.min(pageSize.height, (event.clientY - bounds.top) * pageSize.height / bounds.height)),
    };
  }
  function startSelection(event: PointerEvent<HTMLDivElement>) {
    if (busy || !pdf || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPosition(event); dragOrigin.current = point;
    setRectangle({ ...point, width: 0, height: 0 }); setCrop(null);
  }
  function moveSelection(event: PointerEvent<HTMLDivElement>) {
    if (!dragOrigin.current) return;
    const point = pointerPosition(event), origin = dragOrigin.current;
    setRectangle({ x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y), width: Math.abs(point.x - origin.x), height: Math.abs(point.y - origin.y) });
  }
  function finishSelection(event: PointerEvent<HTMLDivElement>) {
    moveSelection(event); dragOrigin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function changeRectangle(key: keyof Rectangle, value: number) {
    if (!Number.isFinite(value)) return;
    setCrop(null);
    setRectangle(previous => {
      const next = { ...(previous || { x: 0, y: 0, width: Math.min(200, pageSize.width), height: Math.min(40, pageSize.height) }), [key]: Math.max(0, value) };
      next.x = Math.min(next.x, pageSize.width); next.y = Math.min(next.y, pageSize.height);
      next.width = Math.min(next.width, pageSize.width - next.x); next.height = Math.min(next.height, pageSize.height - next.y);
      return next;
    });
  }
  async function prepareCrop() {
    if (!pdf || !rectangle || rectangle.width < 1 || rectangle.height < 1 || operation.current) return;
    operation.current = true; setWorking(true); setError(''); setMessage('Preparando o recorte do original…');
    try {
      const scale = 400 / 72;
      const width = Math.ceil(rectangle.width * scale), height = Math.ceil(rectangle.height * scale);
      if (width * height > 20_000_000) throw new Error('A região é muito grande. Selecione apenas a equação e uma pequena margem.');
      const page = await pdf.getPage(pageNumber);
      const target = document.createElement('canvas'); target.width = width; target.height = height;
      try {
        await page.render({ canvas: target, viewport: page.getViewport({ scale }), transform: [1, 0, 0, 1, -rectangle.x * scale, -rectangle.y * scale], background: '#ffffff' }).promise;
        const dataUrl = target.toDataURL('image/png');
        const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        if (mounted.current) { setCrop({ dataUrl, bytes, widthPt: rectangle.width, heightPt: rectangle.height, page: pageNumber }); setMessage('Recorte pronto. Confira a imagem e o conteúdo que será substituído.'); }
      } finally { target.width = 0; target.height = 0; }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { operation.current = false; if (mounted.current) setWorking(false); }
  }
  async function applyRepair() {
    if (!word || !crop || !validDestination || operation.current) return;
    operation.current = true; setWorking(true); setError(''); setMessage('Inserindo a equação original no Word…');
    try {
      const image = { image: crop.bytes, widthPt: crop.widthPt, heightPt: crop.heightPt, alt: alt.trim() || 'Equação preservada do documento original' };
      const repair: EquationRepair = mode === 'block'
        ? { ...image, kind: 'block', startParagraph: first, endParagraph: last }
        : { ...image, kind: 'inline', paragraph: first, startOffset: inlineOffset, endOffset: inlineOffset + inlineText.length, baselineOffsetPt: baselineOffset };
      const repaired = await applyEquationRepairs(word, [repair]);
      if (!mounted.current) return;
      setHistory(previous => [...previous.slice(-9), word]); setWord(repaired); setOutputPdf(null); setCrop(null); setRectangle(null);
      setMessage('Equação inserida. O Word está disponível para download. Selecione outro trecho para continuar.');
      onRepaired?.(repaired);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { operation.current = false; if (mounted.current) setWorking(false); }
  }
  async function generatePdf() {
    if (!word || operation.current) return;
    operation.current = true; setWorking(true); setError('');
    try {
      const result = await createPdf(word, 'reparado.docx', value => { if (mounted.current) setMessage(value); });
      if (mounted.current) { setOutputPdf(result); setMessage('PDF gerado. Confira a paginação e as equações antes de usar.'); }
    } catch (cause) { if (mounted.current) setError(`${errorMessage(cause)} O Word reparado continua disponível para download.`); }
    finally { operation.current = false; if (mounted.current) setWorking(false); }
  }
  function undo() {
    const previous = history[history.length - 1];
    if (!previous || busy) return;
    setWord(previous); setHistory(items => items.slice(0, -1)); setOutputPdf(null); setError('');
    setMessage('Última substituição desfeita.'); onRepaired?.(previous);
  }

  return <section className="equation-repair" aria-labelledby="equation-repair-title">
    <div className="repair-heading"><div><span className="eyebrow">FIDELIDADE AO ORIGINAL</span><h2 id="equation-repair-title">Reparar equações</h2><p>Recorte a fórmula no PDF original e escolha exatamente onde inseri-la no Word traduzido.</p></div><button type="button" className="icon-button" aria-label="Fechar reparação de equações" onClick={onClose} disabled={busy}><X size={22}/></button></div>
    <p className="repair-local-note">Os arquivos são processados neste navegador, sem uma nova tradução. Equações e símbolos precisam ser conferidos no original.</p>
    <fieldset className="repair-files" disabled={busy}><label><span>PDF original</span><input type="file" accept=".pdf,application/pdf" onChange={event => { const file = event.target.files?.[0]; if (file) { setSource(file); setError(''); } }}/>{source && <small>{source.name}</small>}</label><label><span>Word traduzido (.docx)</span><input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={event => { const file = event.target.files?.[0]; if (file) { setWord(file); setOriginalWord(file); setWordName(file.name); setHistory([]); setOutputPdf(null); setError(''); setMessage(''); } }}/>{word && <small>{wordName}</small>}</label></fieldset>
    {error && <div className="notice error-notice" role="alert">{error}</div>}
    {(busy || message) && <div className="repair-status" role="status" aria-live="polite">{busy && <LoaderCircle size={17} className="spin"/>}{loadingSource ? 'Abrindo PDF original…' : loadingWord ? 'Lendo parágrafos do Word…' : rendering ? 'Exibindo página…' : message}</div>}
    <div className="repair-columns">
      <section className="repair-panel" aria-labelledby="repair-source-title"><div className="repair-panel-heading"><h3 id="repair-source-title">1. Recorte a equação original</h3>{pdf && <div className="repair-pagination"><button type="button" aria-label="Página anterior" disabled={busy || pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}><ChevronLeft size={17}/></button><label>Página <input aria-label="Página do PDF original" type="number" min={1} max={pdf.numPages} value={pageNumber} disabled={busy} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= pdf.numPages) setPageNumber(value); }}/> de {pdf.numPages}</label><button type="button" aria-label="Próxima página" disabled={busy || pageNumber >= pdf.numPages} onClick={() => setPageNumber(value => value + 1)}><ChevronRight size={17}/></button></div>}</div>
        <p className="repair-hint">Arraste sobre a fórmula, deixando uma pequena margem. Evite incluir texto ou figuras vizinhas.</p>
        <div className="repair-page-scroll">{pdf ? <div ref={selectionSurface} className={`repair-page ${busy ? 'is-busy' : ''}`} style={{ aspectRatio: pageSize.width && pageSize.height ? `${pageSize.width}/${pageSize.height}` : undefined }} onPointerDown={startSelection} onPointerMove={moveSelection} onPointerUp={finishSelection} onPointerCancel={() => { dragOrigin.current = null; }} aria-label="Página original; selecione uma região com o ponteiro ou use os ajustes abaixo">
          <canvas ref={canvas}/>{rectangle && pageSize.width > 0 && <div className="repair-selection" style={{ left: `${rectangle.x / pageSize.width * 100}%`, top: `${rectangle.y / pageSize.height * 100}%`, width: `${rectangle.width / pageSize.width * 100}%`, height: `${rectangle.height / pageSize.height * 100}%` }}/>}
        </div> : <div className="repair-empty"><FileText size={30}/><span>Escolha o PDF original para visualizar suas páginas.</span></div>}</div>
        {pdf && <><details className="repair-coordinates"><summary>Ajustar região com precisão</summary><fieldset disabled={busy}><legend>Posição e tamanho em pontos (72 pontos = 1 polegada)</legend>{([['x', 'Esquerda'], ['y', 'Topo'], ['width', 'Largura'], ['height', 'Altura']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min={0} step={0.5} value={rectangle ? Math.round(rectangle[key] * 10) / 10 : 0} onChange={event => changeRectangle(key, Number(event.target.value))}/></label>)}</fieldset></details><button type="button" className="repair-secondary" disabled={busy || !rectangle || rectangle.width < 1 || rectangle.height < 1} onClick={() => void prepareCrop()}><Crop size={17}/>Preparar recorte</button></>}
      </section>
      <section className="repair-panel" aria-labelledby="repair-target-title"><h3 id="repair-target-title">2. Escolha o conteúdo a substituir</h3><p className="repair-hint">A lista mostra os parágrafos do Word atual. Clique no parágrafo da equação ou do símbolo incorreto.</p>
        <fieldset className="repair-destination" disabled={busy || !paragraphs.length}><label>Buscar no Word<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Digite parte de uma frase…"/></label><div className="repair-paragraphs" aria-label="Parágrafos do Word">{paragraphs.filter(p => !search || p.text.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(p => <button type="button" key={p.index} className={`repair-paragraph ${p.index >= first && p.index <= (mode === 'inline' ? first : last) ? 'is-selected' : ''}`} aria-pressed={p.index >= first && p.index <= (mode === 'inline' ? first : last)} onClick={() => { setFirst(p.index); setLast(p.index); setInlineText(''); setOccurrence(1); }}><span className="repair-paragraph-number">{p.index + 1}</span><span>{p.text || (p.hasMath ? 'Equação matemática' : p.hasDrawing ? 'Imagem ou desenho' : 'Parágrafo vazio')}{(p.hasMath || p.hasDrawing) && <small>{p.hasMath ? 'Equação' : ''}{p.hasMath && p.hasDrawing ? ' · ' : ''}{p.hasDrawing ? 'Imagem' : ''}</small>}</span></button>)}</div>
          <label>Tipo de substituição<select value={mode} onChange={event => { setMode(event.target.value as 'block' | 'inline'); setLast(first); }}><option value="block">Parágrafo(s) completo(s)</option><option value="inline">Trecho dentro de um parágrafo</option></select></label>
          <div className="repair-range"><label>{mode === 'block' ? 'Primeiro parágrafo' : 'Parágrafo'}<input type="number" min={1} max={(paragraphs.at(-1)?.index ?? 0) + 1} value={first + 1} onChange={event => { const next = Number(event.target.value) - 1; if (Number.isInteger(next) && paragraphs.some(p => p.index === next)) { setFirst(next); if (last < next || mode === 'inline') setLast(next); setOccurrence(1); } }}/></label>{mode === 'block' && <label>Último parágrafo<input type="number" min={first + 1} max={(paragraphs.at(-1)?.index ?? 0) + 1} value={last + 1} onChange={event => { const next = Number(event.target.value) - 1; if (Number.isInteger(next) && paragraphs.some(p => p.index === next)) setLast(next); }}/></label>}</div>
          {mode === 'inline' && <><label>Texto exato que será substituído<input value={inlineText} onChange={event => { setInlineText(event.target.value); setOccurrence(1); }} placeholder="Ex.: g = 1,9"/></label><label>Ocorrência no parágrafo<input type="number" min={1} max={Math.max(1, matches.length)} value={occurrence} onChange={event => setOccurrence(Math.max(1, Number(event.target.value) || 1))}/></label><p className="repair-hint">{matches.length} ocorrência(s). Copie o trecho exato do texto abaixo, incluindo espaços.</p></>}
          {mode === 'inline' && <label>Deslocamento vertical do símbolo (pt)<input type="number" step={0.5} value={baselineOffset} onChange={event => setBaselineOffset(Number(event.target.value))}/><small>Valores negativos aproximam a base do recorte da linha do texto.</small></label>}
        </fieldset>{!word && <div className="repair-empty"><FileText size={30}/><span>Escolha o Word traduzido para selecionar o destino.</span></div>}
      </section>
    </div>
    <section className="repair-review" aria-labelledby="repair-review-title"><h3 id="repair-review-title">3. Confira antes de aplicar</h3><div className="repair-review-grid"><div><h4>Imagem do original</h4>{crop ? <><div className="repair-crop-preview"><img src={crop.dataUrl} alt={alt || 'Recorte da equação original'}/></div><p className="repair-hint">Página {crop.page} · PNG sem perdas · 400 dpi</p></> : <p className="repair-hint">Prepare um recorte para visualizar a fórmula.</p>}</div><div><h4>Conteúdo que será removido</h4><div className="repair-text-preview">{mode === 'inline' && inlineOffset !== undefined ? <>{selectedText.slice(0, inlineOffset)}<mark>{selectedText.slice(inlineOffset, inlineOffset + inlineText.length)}</mark>{selectedText.slice(inlineOffset + inlineText.length)}</> : selectedText || (selected.length ? '(Parágrafo sem texto; imagens e equações também serão substituídas.)' : 'Selecione um destino no Word.')}</div>{mode === 'block' && selected.some(p => p.hasDrawing) && <p className="repair-hint repair-warning">O intervalo inclui imagens. Elas também serão removidas ao substituir os parágrafos completos.</p>}{mode === 'inline' && <p className="repair-hint">Somente o trecho destacado será substituído.</p>}</div></div><label className="repair-alt">Descrição da equação para acessibilidade<input value={alt} onChange={event => setAlt(event.target.value)} disabled={busy}/></label><button type="button" className="primary-button" disabled={busy || !crop || !validDestination} onClick={() => void applyRepair()}><Crop size={18}/>Aplicar substituição no Word</button></section>
    {hasRepairs && <div className="repair-results"><div><strong>Word atualizado com os recortes originais</strong><p>Baixe o Word reparado ou gere um PDF com a diagramação do Lume.</p></div><div className="repair-result-actions">{wordUrl && <a className="repair-secondary" href={wordUrl} download={`${outputName}.docx`}><ArrowDownToLine size={16}/>Baixar Word reparado</a>}{pdfUrl ? <a className="repair-secondary" href={pdfUrl} download={`${outputName}.pdf`}><ArrowDownToLine size={16}/>Baixar PDF reparado</a> : <button type="button" className="repair-secondary" disabled={busy} onClick={() => void generatePdf()}>Gerar PDF reparado</button>}<button type="button" className="repair-undo" disabled={busy || history.length === 0} onClick={undo}><Undo2 size={15}/>Desfazer última</button></div></div>}
  </section>;
}
