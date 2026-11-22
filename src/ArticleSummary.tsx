import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Clipboard, Download, FileText, LoaderCircle, Save, ScanLine, ShieldCheck, Upload, X } from 'lucide-react';
import { composeSummary, extractSummary, formatSummary, updateSummarySource } from './summary-client';
import { OCR_ENGINE } from './ocr-contract';
import { SUMMARY_ENGINE, SUMMARY_LABELS, SUMMARY_MAX_FILE_BYTES, SUMMARY_MAX_PAGES, SUMMARY_SECTIONS, summaryQuality,
  type SummaryConfig, type SummaryEvidence, type SummarySession, type SummarySource } from './summary-contract';
import './summary.css';

const LANGUAGES = [['PT-BR', 'Português (Brasil)'], ['PT-PT', 'Português (Portugal)'], ['EN-US', 'English'], ['ES', 'Español'], ['FR', 'Français']] as const;
const KINDS: Record<SummarySource['kind'], string> = { text: 'Texto', heading: 'Título', caption: 'Legenda', table: 'Tabela', figure: 'Figura / gráfico', equation: 'Equação', reference: 'Referência', other: 'Outro elemento' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Não foi possível concluir esta operação.';
function safeUrl(value: string) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } }

function SourceEditor({ source, busy, active, onSave }: { source: SummarySource; busy: boolean; active: boolean; onSave: (text: string) => void }) {
  const [text, setText] = useState(source.text);
  useEffect(() => { setText(source.text); }, [source.text]);
  return <article className={`summary-source ${active ? 'summary-source-active' : ''}`} id={`summary-source-${source.id}`} tabIndex={-1}>
    <div className="summary-source-heading"><strong>{KINDS[source.kind]}</strong><span>{source.id}{source.confidence !== null ? ` · OCR ${Math.round(source.confidence)}%` : ''}</span></div>
    <label htmlFor={`summary-text-${source.id}`}>Conteúdo extraído da página {source.page}</label>
    <textarea id={`summary-text-${source.id}`} value={text} maxLength={20_000} rows={Math.min(12, Math.max(3, text.split('\n').length))} disabled={busy} onChange={e => setText(e.target.value)}/>
    {text !== source.text && <button className="summary-small-button" disabled={busy} onClick={() => onSave(text)}><Save size={15}/>Salvar correção</button>}
    {source.text !== source.originalText && <details><summary>Texto original reconhecido pelo OCR</summary><pre>{source.originalText || '(Sem texto reconhecido)'}</pre></details>}
    {!source.text.trim() && <p className="summary-hint">Região visual. A evidência pode depender da leitura da imagem e da legenda.</p>}
  </article>;
}

/** A separate workspace: no translation props, sessions, endpoints or results enter this component. */
export default function ArticleSummary({ hidden = false }: { hidden?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [session, setSession] = useState<SummarySession | null>(null);
  const [config, setConfig] = useState<SummaryConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState(false);
  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('PT-BR');
  const [web, setWeb] = useState(true);
  const [busy, setBusy] = useState<'extracting' | 'composing' | null>(null);
  const [status, setStatus] = useState('Escolha o artigo para extrair e conferir suas evidências.');
  const [error, setError] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [view, setView] = useState<'sources' | 'evidence'>('sources');
  const [activeSource, setActiveSource] = useState('');
  const [activeEvidence, setActiveEvidence] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const configController = useRef<AbortController | null>(null);

  async function loadConfig() {
    configController.current?.abort();
    const abort = new AbortController(); configController.current = abort;
    setConfigLoading(true); setConfigError(false);
    try {
      const response = await fetch('/api/summary-config', { cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (typeof value.configured !== 'boolean' || typeof value.ocrConfigured !== 'boolean' || typeof value.accessRequired !== 'boolean' || value.model !== SUMMARY_ENGINE || value.ocrModel !== OCR_ENGINE) throw new Error();
      if (!abort.signal.aborted) setConfig(value);
    } catch { if (!abort.signal.aborted) { setConfig(null); setConfigError(true); } }
    finally { if (!abort.signal.aborted) setConfigLoading(false); }
  }
  useEffect(() => { void loadConfig(); return () => { configController.current?.abort(); controller.current?.abort(); epoch.current++; }; }, []);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (busy || session?.pages.length) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [busy, session]);

  function stop() {
    controller.current?.abort(); epoch.current++; setBusy(null);
    setStatus('Operação interrompida. Os dados recebidos continuam nesta sessão; retome quando desejar.');
  }
  function chooseFile(files: FileList | null) {
    if (!files?.length) return;
    if (files.length !== 1) { setError('Escolha um artigo por vez.'); return; }
    const selected = files[0];
    if (!/\.pdf$/i.test(selected.name) || selected.size <= 0 || selected.size > SUMMARY_MAX_FILE_BYTES) {
      setError('Escolha um PDF válido de até 7 MB.'); if (input.current) input.current.value = ''; return;
    }
    controller.current?.abort(); epoch.current++; setBusy(null); setFile(selected); setSession(null); setPageNumber(1);
    setError(''); setActiveSource(''); setActiveEvidence(''); setStatus('Artigo selecionado. Extraia os dados antes de gerar o resumo.');
  }
  function removeFile() {
    controller.current?.abort(); epoch.current++; setBusy(null); setFile(null); setSession(null); setError('');
    if (input.current) input.current.value = '';
    setStatus('Escolha o artigo para extrair e conferir suas evidências.');
  }
  async function run(operation: 'extracting' | 'composing') {
    if (busy || !file || (operation === 'composing' && !session)) return;
    const id = ++epoch.current;
    const abort = new AbortController(); controller.current = abort;
    const current = () => epoch.current === id && !abort.signal.aborted;
    setBusy(operation); setError('');
    const options = { code, signal: abort.signal, onProgress: (message: string) => { if (current()) setStatus(message); },
      onUpdate: (value: SummarySession) => { if (current()) setSession(value); } };
    try {
      const value = operation === 'extracting' ? await extractSummary(file, session, options)
        : await composeSummary(session!, { ...options, language, web });
      if (current()) {
        setSession(value);
        setStatus(operation === 'extracting' ? 'Extração concluída. Confira os dados e gere o resumo.' : 'Resumo gerado. Confira as referências e eventuais pendências.');
      }
    } catch (failure) { if (current()) { setError(errorMessage(failure)); setStatus('A operação precisa de atenção. O progresso recebido foi preservado.'); } }
    finally { if (epoch.current === id) setBusy(null); }
  }
  function editSource(id: string, text: string) {
    if (busy || !session) return;
    try {
      setSession(updateSummarySource(session, id, text));
      setError(''); setStatus('Correção salva. Atualize as evidências desta página antes de gerar o resumo.');
    } catch (failure) { setError(errorMessage(failure)); }
  }
  function showSource(id: string) {
    const source = session?.pages.flatMap(p => p.sources).find(s => s.id === id);
    if (!source) return;
    setPageNumber(source.page); setView('sources'); setActiveSource(id);
    setTimeout(() => document.getElementById(`summary-source-${id}`)?.focus(), 0);
  }
  function showEvidence(id: string) {
    const page = session?.pages.find(p => p.evidence.some(e => e.id === id));
    if (!page) return;
    setPageNumber(page.number); setView('evidence'); setActiveEvidence(id);
    setTimeout(() => document.getElementById(`summary-evidence-${id}`)?.focus(), 0);
  }
  function download(content: string, extension: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a'); a.href = url; a.download = `${file?.name.replace(/\.pdf$/i, '') || 'artigo'}-resumo.${extension}`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  async function copy() {
    if (!session) return;
    try { await navigator.clipboard.writeText(formatSummary(session)); setStatus('Resumo copiado.'); }
    catch { setError('Não foi possível copiar. Use o download de texto para salvar o resumo.'); }
  }
  function exportEvidence() {
    if (!session) return;
    download(JSON.stringify({ ...session, pages: session.pages.map(({ image: _image, completedBatches: _batches, ...page }) => page) }, null, 2), 'json', 'application/json;charset=utf-8');
  }

  const quality = session ? summaryQuality(session) : null;
  const page = session?.pages.find(p => p.number === pageNumber);
  const highlightedSource = page?.sources.find(source => source.id === activeSource);
  const evidence = session?.pages.flatMap(p => p.evidence) || [];
  const accessReady = !config?.accessRequired || Boolean(code.trim());
  const configured = Boolean(config?.configured && config?.ocrConfigured && accessReady && !configLoading && !configError);
  const canCompose = configured && !!session && quality?.analyzedPages === session.pageCount && session.pages.length === session.pageCount &&
    new Set(session.pages.map(p => p.number)).size === session.pageCount && session.pages.every(p => p.status === 'analyzed' && p.number >= 1 && p.number <= session.pageCount) && evidence.length > 0;
  const hasResult = Boolean(session && SUMMARY_SECTIONS.some(key => session.sections[key]));
  const allSections = Boolean(session && SUMMARY_SECTIONS.every(key => session.sections[key]));
  const hasMissing = Boolean(session && SUMMARY_SECTIONS.some(key => session.sections[key]?.missing.length));
  const citeLabel = (item: SummaryEvidence) => {
    const pages = [...new Set(item.sourceIds.flatMap(id => session?.pages.flatMap(p => p.sources).filter(s => s.id === id).map(s => s.page) || []))];
    return `p. ${pages.join(', ') || '?'}`;
  };

  return <main className="summary-workspace" hidden={hidden}>
    <div className="page-heading"><div><div className="eyebrow"><span/> EVIDÊNCIAS PARA COMPREENDER</div><h1>O artigo em perspectiva.</h1><p>Extraia os dados da pesquisa e leia um resumo completo, com referências ao original.</p></div><span className="version-pill">PDF · até {SUMMARY_MAX_PAGES} páginas</span></div>
    <div className="summary-input-grid">
      <section className="translation-card summary-input" aria-labelledby="summary-input-title">
        <div className="card-heading"><div><span className="step-number">01</span><h2 id="summary-input-title">Seu artigo</h2></div><BookOpen size={21}/></div>
        <input ref={input} type="file" id="summary-file" className="visually-hidden" accept=".pdf,application/pdf" onChange={e => chooseFile(e.target.files)}/>
        {!file ? <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); chooseFile(e.dataTransfer.files); }}>
          <div className="upload-symbol"><FileText size={31}/><span><Upload size={13}/></span></div><h3>Comece pelo artigo original</h3><p>Arraste o PDF ou escolha um arquivo.</p>
          <button className="select-file" onClick={() => input.current?.click()}><Upload size={16}/>Escolher artigo PDF</button><span className="upload-limits">Até 7 MB · {SUMMARY_MAX_PAGES} páginas · um artigo por vez</span>
        </div> : <div className="selected-file"><div className="file-icon"><FileText size={28}/></div><div className="file-description"><strong>{file.name}</strong><span>{(file.size / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB{session ? ` · ${session.pageCount} páginas` : ''}</span></div><button className="icon-button" onClick={removeFile} aria-label="Remover artigo"><X size={19}/></button></div>}
        {file && <button className="summary-text-button" onClick={() => input.current?.click()}>Escolher outro artigo</button>}
        {config?.accessRequired && <label className="access-label" htmlFor="summary-code">Código de acesso<input id="summary-code" type="password" autoComplete="off" value={code} disabled={Boolean(busy)} onChange={e => setCode(e.target.value)}/></label>}
        {configLoading && <p className="connection-status"><LoaderCircle size={14} className="spin"/>Verificando os serviços de resumo…</p>}
        {configError && <div className="notice" role="alert">Não foi possível verificar os serviços de resumo. <button className="text-button" onClick={() => void loadConfig()}>Tentar novamente</button></div>}
        {config && (!config.configured || !config.ocrConfigured) && <div className="notice" role="alert">{!config.ocrConfigured ? 'O serviço de reconhecimento de texto precisa ser configurado para extrair os dados do artigo.' : 'O serviço de análise precisa ser configurado para conferir as evidências e gerar o resumo.'} <button className="text-button" onClick={() => void loadConfig()}>Verificar novamente</button></div>}
        <button className="primary-button" disabled={!file || !configured || Boolean(busy)} onClick={() => void run('extracting')}><ScanLine size={19}/><span>{session ? session.pages.some(p => p.status !== 'analyzed') ? 'Atualizar / retomar extração' : 'Conferir extração novamente' : 'Extrair dados do artigo'}</span><ArrowRight size={19}/></button>
        <p className="summary-hint">A extração preserva texto, tabelas, figuras e equações, com identificação da página de origem.</p>
      </section>
      <aside className="summary-guide">
        <div className="eyebrow">DO DADO À EXPLICAÇÃO</div><h2>Entenda o que<br/>a pesquisa encontrou.</h2>
        <ol><li><strong>Extraia as evidências</strong><p>O OCR lê todas as páginas. Elementos visuais recebem leitura complementar quando necessário.</p></li><li><strong>Confira o conteúdo</strong><p>Inspecione dados, valores, unidades e pendências. Correções atualizam as evidências.</p></li><li><strong>Gere as quatro partes</strong><p>Objetivo, base técnica, metodologia e resultados com as conclusões dos autores.</p></li></ol>
        <details className="summary-privacy"><summary><ShieldCheck size={16}/>Processamento e privacidade</summary><p>As páginas do PDF são enviadas a um serviço externo de OCR. O serviço de análise recebe o texto e uma imagem de cada página para conferir as evidências. Os envios passam pela infraestrutura de hospedagem do aplicativo. Há cobrança pelos provedores.</p><p>A pesquisa complementar usa conceitos da base técnica e apresenta as fontes consultadas. As chaves ficam no servidor. Os provedores aplicam suas políticas de retenção. O aplicativo mantém o progresso somente na memória desta página.</p><p>Recarregar ou fechar esta página descarta os dados. Interromper impede novas etapas. Solicitações já aceitas podem continuar e gerar cobrança.</p></details>
      </aside>
    </div>
    <div className="summary-status" role="status" aria-live="polite">{busy ? <LoaderCircle size={18} className="spin"/> : <ScanLine size={18}/>}<span>{status}</span>{busy && <button className="summary-small-button" onClick={stop}>Interromper</button>}</div>
    {error && <div className="notice error-notice" role="alert"><AlertTriangle size={18}/><span>{error}</span></div>}
    {session && <>
      <section className="summary-review" aria-labelledby="summary-review-title">
        <div className="summary-section-heading"><div><span className="eyebrow">02 · CONFERÊNCIA</span><h2 id="summary-review-title">Dados e evidências do artigo</h2></div><button className="summary-small-button" onClick={exportEvidence}><Download size={16}/>Baixar evidências JSON</button></div>
        <div className="summary-metrics"><span><strong>{quality?.analyzedPages}/{session.pageCount}</strong> páginas analisadas</span><span><strong>{session.pages.reduce((n, p) => n + p.sources.length, 0)}</strong> elementos extraídos</span><span><strong>{evidence.length}</strong> evidências</span><span className={quality?.complete ? 'summary-quality-ok' : 'summary-quality-pending'}>{quality?.complete ? <Check size={15}/> : <AlertTriangle size={15}/>}<strong>{quality?.complete ? 'Cobertura sem alertas automáticos' : 'Conferência necessária'}</strong></span></div>
        <p className="summary-hint">A cobertura indica páginas processadas. A conferência automática não garante a exatidão científica. A numeração abaixo corresponde às páginas físicas do PDF.</p>
        {!!quality?.issues.length && <details className="summary-issues"><summary>{quality.issues.length} pendência(s) de extração</summary><ul>{quality.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
        <div className="summary-review-toolbar"><nav aria-label="Páginas do artigo"><button className="icon-button" aria-label="Página anterior do artigo" disabled={pageNumber <= 1} onClick={() => setPageNumber(n => n - 1)}><ChevronLeft/></button><label>Página <select aria-label="Página do artigo" value={pageNumber} onChange={e => setPageNumber(Number(e.target.value))}>{Array.from({ length: session.pageCount }, (_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}</select> de {session.pageCount}</label><button className="icon-button" aria-label="Próxima página do artigo" disabled={pageNumber >= session.pageCount} onClick={() => setPageNumber(n => n + 1)}><ChevronRight/></button></nav><div className="summary-view-switch" role="group" aria-label="Conteúdo da conferência"><button aria-pressed={view === 'sources'} onClick={() => setView('sources')}>Extração</button><button aria-pressed={view === 'evidence'} onClick={() => setView('evidence')}>Evidências</button></div></div>
        {!page ? <p className="summary-empty">Esta página ainda não foi extraída. Retome a extração para processá-la.</p> : <div className={`summary-review-grid ${page.image ? '' : 'summary-without-image'}`}>
          {page.image && <figure className="summary-page-preview"><div style={{position:'relative'}}><img src={page.image} alt={`Página ${page.number} do artigo original`}/>{highlightedSource && <span className="summary-source-overlay" aria-label={`Região de origem ${highlightedSource.id}`} style={{left:`${highlightedSource.rect.x/page.width*100}%`,top:`${highlightedSource.rect.y/page.height*100}%`,width:`${highlightedSource.rect.width/page.width*100}%`,height:`${highlightedSource.rect.height/page.height*100}%`}}/>}</div><figcaption>Original · página {page.number}{highlightedSource ? ` · região ${highlightedSource.id}` : ''}</figcaption></figure>}
          <div className="summary-page-data">{view === 'sources' ? <>{page.sources.map(source => <SourceEditor key={source.id} source={source} busy={Boolean(busy)} active={activeSource === source.id} onSave={text => editSource(source.id, text)}/>)}{!page.sources.length && <p className="summary-empty">O OCR não reconheceu elementos nesta página. Confira o original.</p>}</> : <>{page.evidence.map(item => <article key={item.id} id={`summary-evidence-${item.id}`} tabIndex={-1} className={`summary-evidence ${activeEvidence === item.id ? 'summary-source-active' : ''}`}><div className="summary-source-heading"><strong>{item.section in SUMMARY_LABELS ? SUMMARY_LABELS[item.section as keyof typeof SUMMARY_LABELS] : item.section === 'conclusion' ? 'Conclusão' : item.section === 'reference' ? 'Referência' : 'Contexto'}</strong><span>{item.origin === 'prior-work' ? 'Trabalho anterior citado' : 'Pesquisa deste artigo'}</span></div><p>{item.statement}</p><div className="summary-evidence-tags">{item.certainty !== 'reported' && <span>{item.certainty === 'approximate' ? 'Leitura aproximada' : 'Informação incerta'}</span>}{item.values.map((value, i) => <span key={i}>{value}</span>)}</div>{!!item.quotes.length && <details><summary>Trechos que sustentam a evidência</summary>{item.quotes.map((quote, i) => <blockquote key={i}>{quote}</blockquote>)}</details>}{!!item.caveats.length && <ul className="summary-caveats">{item.caveats.map((caveat, i) => <li key={i}>{caveat}</li>)}</ul>}<div className="summary-citations">{item.sourceIds.map(id => <button key={id} onClick={() => showSource(id)}>Ver origem · {id}</button>)}</div></article>)}{!page.evidence.length && <p className="summary-empty">{page.status === 'extracted' ? 'Os elementos desta página aguardam análise. Retome a extração.' : 'Não foram localizadas evidências utilizáveis nesta página.'}</p>}</>}</div>
        </div>}
      </section>
      <section className="summary-generation" aria-labelledby="summary-generate-title"><div className="summary-section-heading"><div><span className="eyebrow">03 · COMPREENSÃO</span><h2 id="summary-generate-title">Gere seu resumo</h2></div></div><div className="summary-options"><label htmlFor="summary-language">Idioma do resumo<select id="summary-language" value={language} disabled={Boolean(busy)} onChange={e => { setLanguage(e.target.value); setSession(previous => previous ? { ...previous, sections: {}, comments: [], language: undefined, explanationDone: false } : previous); }}>{LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="summary-web-option"><input type="checkbox" checked={web} disabled={Boolean(busy)} onChange={e => { setWeb(e.target.checked); setSession(previous => previous ? { ...previous, comments: [], explanationDone: false } : previous); }}/><span>Permitir pesquisa breve para explicar conceitos da base técnica<small>Comentários explicativos identificados, com links para as fontes consultadas.</small></span></label></div><button className="primary-button" disabled={!canCompose || Boolean(busy)} onClick={() => void run('composing')}><BookOpen size={19}/><span>{hasResult && !allSections ? 'Retomar geração do resumo' : hasResult ? 'Atualizar resumo' : 'Gerar resumo completo'}</span><ArrowRight size={19}/></button>{!canCompose && <p className="summary-hint">Conclua a análise das páginas e obtenha evidências utilizáveis para liberar a geração.</p>}</section>
      {hasResult && <section className="summary-result" aria-labelledby="summary-result-title"><div className="summary-section-heading"><div><span className="eyebrow">SEU RESUMO</span><h2 id="summary-result-title">{allSections && quality?.complete && !hasMissing ? 'Resumo do artigo' : 'Resumo com pendências'}</h2></div><div className="summary-downloads"><button className="summary-small-button" onClick={() => void copy()}><Clipboard size={16}/>Copiar</button><button className="summary-small-button" onClick={() => download(formatSummary(session), 'txt', 'text/plain;charset=utf-8')}><Download size={16}/>Baixar texto</button></div></div><nav className="summary-result-nav" aria-label="Partes do resumo">{SUMMARY_SECTIONS.map(key => <a key={key} href={`#summary-part-${key}`}>{SUMMARY_LABELS[key]}</a>)}</nav>
        {SUMMARY_SECTIONS.map(key => <section key={key} id={`summary-part-${key}`} className={`summary-result-part ${key === 'results' ? 'summary-result-priority' : ''}`}><h3>{SUMMARY_LABELS[key]}</h3>{session.sections[key] ? <>{session.sections[key]!.paragraphs.map((paragraph, index) => <div key={index} className="summary-result-paragraph"><p>{paragraph.text}</p><div className="summary-citations">{paragraph.evidenceIds.map(id => { const item = evidence.find(e => e.id === id); return item ? <button key={id} onClick={() => showEvidence(id)} aria-label={`Ver evidência ${id}, ${citeLabel(item)}`}>{citeLabel(item)}</button> : null; })}</div></div>)}{!!session.sections[key]!.missing.length && <div className="summary-missing"><strong>Informações ausentes ou não confirmadas</strong><ul>{session.sections[key]!.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</> : <p className="summary-empty">Esta parte ainda não foi gerada. Retome a geração para concluir.</p>}
          {key === 'technical' && !!session.comments.length && <aside className="summary-comments" aria-label="Comentários explicativos"><h4>Comentários explicativos</h4><p className="summary-hint">Explicações complementares; fontes externas indicadas quando consultadas.</p>{session.comments.map((comment, index) => <div key={index}><strong>{comment.concept}</strong><p>{comment.explanation}</p><ul>{comment.sources.map((source, i) => { const url = safeUrl(source.url); return url ? <li key={i}><a href={url} target="_blank" rel="noopener noreferrer">{source.title || new URL(url).hostname}</a></li> : null; })}</ul></div>)}</aside>}
        </section>)}
      </section>}
    </>}
  </main>;
}
