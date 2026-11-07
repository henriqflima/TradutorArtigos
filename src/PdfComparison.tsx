import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, X } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfLayoutReport } from './pdf-layout';
import { pdfSourceOptions } from './pdf-options';

type Props = {
  original: PDFDocumentProxy;
  resultBlob: Blob;
  report: PdfLayoutReport | null;
  onClose: () => void;
};

function PagePreview({ document, pageNumber, label }: { document: PDFDocumentProxy; pageNumber: number; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | undefined;
    setRendering(true); setError('');
    void (async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (cancelled || !canvas.current) return;
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2, window.devicePixelRatio || 1) * Math.min(1.25, 720 / natural.width);
        const viewport = page.getViewport({ scale });
        // Each render owns a separate canvas, including during rapid navigation.
        const surface = window.document.createElement('canvas');
        surface.width = Math.ceil(viewport.width); surface.height = Math.ceil(viewport.height);
        const render = page.render({ canvas: surface, viewport }); task = render;
        await render.promise;
        if (cancelled || !canvas.current) return;
        canvas.current.width = surface.width; canvas.current.height = surface.height;
        const context = canvas.current.getContext('2d');
        if (!context) throw new Error('Não foi possível preparar a prévia.');
        context.drawImage(surface, 0, 0);
        surface.width = surface.height = 0;
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Não foi possível exibir esta página.');
      } finally { if (!cancelled) setRendering(false); }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [document, pageNumber, attempt]);
  return <div className="pdf-comparison-page" aria-busy={rendering}>
    {rendering && <p className="pdf-comparison-loading" role="status"><LoaderCircle size={18} className="spin"/>Carregando página…</p>}
    {error && <p className="notice error-notice" role="alert">{error} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Tentar novamente</button></p>}
    <canvas ref={canvas} hidden={rendering || Boolean(error)} role="img" aria-label={label}/>
  </div>;
}

export default function PdfComparison({ original, resultBlob, report, onClose }: Props) {
  const [result, setResult] = useState<PDFDocumentProxy | null>(null);
  const [sourcePage, setSourcePage] = useState(1);
  const [selectedOutput, setSelectedOutput] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let loading: { destroy: () => Promise<void> } | undefined;
    setResult(null); setError(''); setSourcePage(1); setSelectedOutput(null);
    void (async () => {
      try {
        const [pdfjs, worker, bytes] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url'), resultBlob.arrayBuffer()]);
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        // Load in-memory bytes; fetching a blob URL is blocked by connect-src 'self'.
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...pdfSourceOptions() }); loading = task;
        const document = await task.promise;
        if (!cancelled) setResult(document);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Não foi possível abrir o PDF traduzido.');
      }
    })();
    return () => { cancelled = true; void loading?.destroy().catch(() => {}); };
  }, [resultBlob, attempt]);
  const pageReport = report?.pages.find(page => page.sourcePage === sourcePage);
  const mappedPages = [...new Set(pageReport?.outputPages.filter(page => Number.isInteger(page) && page > 0 && (!result || page <= result.numPages)) || [])];
  const outputPage = selectedOutput !== null && Number.isInteger(selectedOutput) && selectedOutput > 0 && (!result || selectedOutput <= result.numPages)
    ? selectedOutput : mappedPages[0] ?? null;
  const outputReport = report?.outputPages.find(page => page.outputPage === outputPage);
  const sourcePages = [...new Set(outputReport?.sourcePages.filter(page => Number.isInteger(page) && page > 0 && page <= original.numPages) || [])];
  const notices = pageReport?.warnings || [];
  const simplified = report?.pages.filter(page => page.mode === 'simplified').map(page => page.sourcePage) || [];
  const chooseSource = (page: number) => { setSourcePage(page); setSelectedOutput(null); };
  const chooseOutput = (page: number) => {
    setSelectedOutput(page);
    const sources = report?.outputPages.find(output => output.outputPage === page)?.sourcePages
      .filter(source => Number.isInteger(source) && source > 0 && source <= original.numPages) || [];
    if (sources.length) setSourcePage(current => sources.includes(current) ? current : sources[0]);
  };
  return <section className="pdf-comparison" aria-label="Comparação do PDF original com a tradução">
    <div className="pdf-comparison-heading"><div><h2>Compare o PDF com o original</h2><p>O conteúdo segue em fluxo contínuo. Uma página traduzida pode reunir trechos de várias páginas originais.</p></div><button className="structured-secondary" onClick={onClose}><X size={16}/>Ocultar comparação</button></div>
    {simplified.length > 0 && <p className="notice">Montagem simplificada nas páginas originais {simplified.join(', ')}. Confira a distribuição do conteúdo nessas páginas.</p>}
    <nav className="pdf-comparison-nav" aria-label="Páginas da comparação">
      <button className="structured-secondary" aria-label="Página original anterior na comparação" disabled={sourcePage <= 1} onClick={() => chooseSource(sourcePage - 1)}><ChevronLeft size={18}/></button>
      <label>Página original <select aria-label="Página original na comparação" value={sourcePage} onChange={event => chooseSource(Number(event.target.value))}>{Array.from({ length: original.numPages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} de {original.numPages}</option>)}</select></label>
      <button className="structured-secondary" aria-label="Próxima página original na comparação" disabled={sourcePage >= original.numPages} onClick={() => chooseSource(sourcePage + 1)}><ChevronRight size={18}/></button>
      {result && <label className="pdf-comparison-output-nav">Página traduzida <select aria-label="Página traduzida na comparação" value={outputPage ?? ''} onChange={event => chooseOutput(Number(event.target.value))}>
        {outputPage === null && <option value="" disabled>Escolha uma página</option>}
        {Array.from({ length: result.numPages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} de {result.numPages}</option>)}
      </select></label>}
    </nav>
    {pageReport && <p className="structured-hint">{mappedPages.length
      ? `O conteúdo da página original ${sourcePage} aparece ${mappedPages.length === 1 ? 'na página traduzida' : 'nas páginas traduzidas'} ${mappedPages.join(', ')}.`
      : 'Esta página original não tem conteúdo representado no PDF traduzido.'}</p>}
    {outputReport && outputPage !== null && <p className="structured-hint">Página traduzida {outputPage} · {outputReport.columns === 2 ? 'duas colunas' : 'uma coluna'}{sourcePages.length ? ` · conteúdo ${sourcePages.length === 1 ? 'da página original' : 'das páginas originais'} ${sourcePages.join(', ')}` : ' · sem origem registrada'}.</p>}
    {!report && <p className="structured-hint">A correspondência entre as páginas não está disponível. Use os controles para conferir cada documento.</p>}
    {notices.length > 0 && <ul className="pdf-comparison-notices">{notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>}
    {error && <p className="notice error-notice" role="alert">{error} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Tentar abrir novamente</button></p>}
    <div className="pdf-comparison-grid">
      <div className="pdf-comparison-column"><h3>Original <span>Página {sourcePage}</span></h3><PagePreview document={original} pageNumber={sourcePage} label={`Página original ${sourcePage}`}/></div>
      <div className="pdf-comparison-column"><h3>Tradução <span>{result ? outputPage === null ? 'Sem página correspondente' : `Página ${outputPage}` : 'Preparando prévia'}</span></h3>{result ? outputPage !== null
        ? <PagePreview document={result} pageNumber={outputPage} label={`Página traduzida ${outputPage}`}/>
        : <p className="structured-hint">{pageReport ? 'Não há página traduzida associada a esta página original. Você pode escolher outra página traduzida para conferir o documento.' : 'Escolha uma página traduzida para visualizar.'}</p>
        : !error && <p className="pdf-comparison-loading" role="status"><LoaderCircle size={18} className="spin"/>Abrindo o PDF traduzido…</p>}</div>
    </div>
  </section>;
}
