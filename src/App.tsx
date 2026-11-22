import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, FileText, Languages, LayoutTemplate, LoaderCircle, LockKeyhole, ScanLine, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, MAX_FILE_BYTES, MAX_PDF_PAGES, TRANSLATION_ENGINE, validateFile, formatFileSize } from './shared';
import { OCR_ENGINE } from './ocr-contract';
import PlainTextTranslation from './PlainTextTranslation';
import ArticleSummary from './ArticleSummary';

type Config = { configured: boolean; accessRequired: boolean; provider: 'translation'; model: typeof TRANSLATION_ENGINE; ocr: { configured: boolean; provider: 'ocr'; model: typeof OCR_ENGINE } };
const StructuredTranslation = lazy(() => import('./StructuredTranslation'));

export default function App() {
  const [mode, setMode] = useState<'pdf' | 'text' | 'summary'>('pdf');
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('PT-BR');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [code, setCode] = useState('');
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [modal, setModal] = useState<'privacy' | 'help' | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [workflow, setWorkflow] = useState<'review' | 'direct'>('review');
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  async function loadConfig() {
    setConfigError(false); setConfigLoading(true);
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (typeof data.configured !== 'boolean' || typeof data.accessRequired !== 'boolean' || data.provider !== 'translation' || data.model !== TRANSLATION_ENGINE ||
        typeof data.ocr?.configured !== 'boolean' || data.ocr.provider !== 'ocr' || data.ocr.model !== OCR_ENGINE) throw new Error();
      setConfig(data);
    } catch { setConfig(null); setConfigError(true); }
    finally { setConfigLoading(false); }
  }
  useEffect(() => { void loadConfig(); }, []);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);

  function clearFile() {
    setFile(null); setError('');
    if (input.current) input.current.value = '';
  }
  function selectFiles(files: FileList | null) {
    if (!files?.length) return;
    if (files.length > 1) { setError('Escolha um PDF por vez.'); return; }
    const selected = files[0];
    const invalid = validateFile(selected);
    if (invalid) { setError(invalid); if (input.current) input.current.value = ''; return; }
    setError(''); setFile(selected);
  }
  function startWorkflow(selectedWorkflow: 'review' | 'direct') {
    if (!file) return;
    const invalid = validateFile(file);
    if (invalid) { setError(invalid); return; }
    if (configLoading || configError || !config?.ocr.configured) { setError('O serviço de reconhecimento de texto precisa estar disponível para analisar o PDF. Verifique a configuração.'); return; }
    if (selectedWorkflow === 'direct' && !config.configured) { setError('O serviço de tradução precisa estar disponível para traduzir diretamente.'); return; }
    if (config?.accessRequired && !code.trim()) { setError('Informe o código de acesso antes de continuar.'); return; }
    if (source && source === target.split('-')[0]) { setError('Escolha idiomas de origem e destino diferentes.'); return; }
    setError(''); setWorkflow(selectedWorkflow); setReviewing(true);
  }
  const analysisUnavailable = !file || configLoading || configError || !config?.ocr.configured || Boolean(config?.accessRequired && !code.trim());

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Lume, início"><img src="/favicon.svg" alt=""/><span>lume<span className="brand-dot">.</span></span></a>
      <div className="sidebar-label">ESPAÇO DE LEITURA</div>
      <nav className="translation-nav" aria-label="Modos de leitura">
        <button className={`nav-item ${mode === 'pdf' ? 'active' : ''}`} aria-current={mode === 'pdf' ? 'page' : undefined} onClick={() => setMode('pdf')}><FileText size={20}/><span>Traduzir PDF</span>{mode === 'pdf' && <span className="nav-dot"/>}</button>
        <button className={`nav-item ${mode === 'text' ? 'active' : ''}`} aria-current={mode === 'text' ? 'page' : undefined} onClick={() => setMode('text')}><Languages size={20}/><span>Traduzir texto</span>{mode === 'text' && <span className="nav-dot"/>}</button>
        <button className={`nav-item ${mode === 'summary' ? 'active' : ''}`} aria-current={mode === 'summary' ? 'page' : undefined} onClick={() => setMode('summary')}><ScanLine size={20}/><span>Resumir artigo</span>{mode === 'summary' && <span className="nav-dot"/>}</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><div className="mini-spark"><Sparkles size={20}/></div><h3>Leitura de artigos científicos</h3><p>Tradução com preservação de figuras e equações e resumo com evidências por página.</p></div>
        <button aria-label="Como funciona" onClick={() => setModal('help')}><CircleHelp size={18}/>Como funciona<ArrowUpRight size={16}/></button>
        <button aria-label="Privacidade" onClick={() => setModal('privacy')}><ShieldCheck size={18}/>Privacidade<ArrowUpRight size={16}/></button>
        <span className="sidebar-foot">FEITO PARA QUEM PESQUISA</span>
      </div>
    </aside>
    <div className={`workspace ${mode === 'pdf' && reviewing ? 'review-workspace' : ''}`}>
      <header className={`topbar ${mode === 'summary' ? 'summary-topbar' : ''}`}><span>{mode === 'text' ? 'Textos' : 'Documentos'} <span className="slash">/</span> <strong>{mode === 'summary' ? 'Resumo de artigo' : mode === 'pdf' && reviewing ? workflow === 'direct' ? 'Tradução direta' : 'Revisão e tradução' : 'Nova tradução'}</strong></span><span className="engine"><span className="engine-mark"><Languages size={13}/></span>{mode === 'summary' ? 'Resumo com evidências' : mode === 'text' ? 'Tradução de texto' : 'Tradução de PDF'}</span></header>
      <ArticleSummary hidden={mode !== 'summary'}/>
      <PlainTextTranslation hidden={mode !== 'text'} configured={Boolean(config?.configured)} accessRequired={Boolean(config?.accessRequired)}
        code={code} onCodeChange={setCode} configLoading={configLoading} configError={configError} onRetryConfig={() => void loadConfig()}/>
      <div className="mode-panel" hidden={mode !== 'pdf'}>
      {reviewing && file ? <Suspense fallback={<main className="loading-workspace" role="status"><LoaderCircle size={24} className="spin"/><p>Abrindo a análise do PDF…</p></main>}>
        <StructuredTranslation file={file} source={source} target={target} code={code} workflow={workflow}
          configured={Boolean(config?.configured)} ocrConfigured={Boolean(config?.ocr.configured)} ocrModel={config?.ocr.model}
          accessRequired={Boolean(config?.accessRequired)} onCodeChange={setCode}
          onClose={() => setReviewing(false)}/>
      </Suspense> : <main>
        <div className="page-heading"><div><div className="eyebrow"><span/> TRADUÇÃO CIENTÍFICA</div><h1>Traduza artigos em PDF</h1><p>Traduza diretamente ou revise o texto extraído antes. Exporte o resultado em DOCX e PDF com as imagens e equações do original.</p></div><span className="version-pill">PDF · até {MAX_PDF_PAGES} páginas</span></div>
        <div className="translation-grid">
          <section className="translation-card" aria-label="Selecionar PDF para tradução">
            <div className="card-heading"><div><span className="step-number">01</span><h2>Seu PDF</h2></div><span className="muted small">Um arquivo por vez</span></div>
            <input ref={input} id="document" type="file" accept=".pdf,application/pdf" className="visually-hidden" onChange={e => selectFiles(e.target.files)}/>
            {!file ? <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); selectFiles(e.dataTransfer.files); }}>
              <div className="upload-symbol"><FileText size={31} strokeWidth={1.5}/><span><Upload size={13}/></span></div>
              <h3>Selecione o artigo</h3><p>Arraste o PDF para esta área ou</p><button className="select-file" onClick={() => input.current?.click()}><Upload size={16}/>Escolher PDF</button>
              <span className="upload-limits">Somente PDF · até {formatFileSize(MAX_FILE_BYTES)} · até {MAX_PDF_PAGES} páginas</span>
            </div> : <div className="selected-file"><div className="file-icon"><FileText size={30}/></div><div className="file-description"><strong>{file.name}</strong><span>PDF <span>·</span> {formatFileSize(file.size)}<span>·</span> Páginas verificadas na análise</span></div><button className="icon-button" onClick={clearFile} aria-label="Remover PDF"><X size={19}/></button></div>}
            <div className="format-row"><span><ScanLine size={15}/>Reconhecimento de texto em todas as páginas</span><span><ShieldCheck size={15}/>Recortes preservados</span></div>
            <div className="section-divider"/>
            <div className="card-heading language-heading"><div><span className="step-number">02</span><h2>Escolha os idiomas</h2></div></div>
            <div className="language-selectors"><label>Idioma original<div className="select-wrap"><select value={source} onChange={e => setSource(e.target.value)}><option value="">Detectar automaticamente</option>{SOURCE_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={16}/></div></label><ArrowRight className="language-arrow" size={19}/><label>Traduzir para<div className="select-wrap target-select"><select value={target} onChange={e => setTarget(e.target.value)}>{TARGET_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={16}/></div></label></div>
            {config?.accessRequired && <label className="access-label">Código de acesso<input type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} placeholder="Informe o código deste aplicativo"/></label>}
            <p className="inline-note">Nos dois modos, todas as páginas, inclusive as que têm texto selecionável, são enviadas a um serviço externo de reconhecimento de texto (OCR), com cobrança por página.</p>
            {error && <div className="notice error-notice" role="alert"><CircleHelp size={18}/><span>{error}</span></div>}
            {configError && <div className="notice" role="status"><CircleHelp size={18}/><span>Não foi possível verificar o serviço de reconhecimento de texto. A análise de PDFs está indisponível até restabelecer a conexão. <button className="text-button" onClick={() => void loadConfig()}>Tentar novamente</button></span></div>}
            {config && !config.configured && <div className="notice"><LockKeyhole size={18}/><span>A tradução ainda não está disponível. A análise de PDFs funciona conforme a disponibilidade do OCR.</span></div>}
            {config && !config.ocr.configured && <div className="notice"><ScanLine size={18}/><span>A análise de PDFs ficará disponível após a configuração do serviço de reconhecimento de texto. <button className="text-button" onClick={() => void loadConfig()}>Verificar novamente</button></span></div>}
            {configLoading && <p className="connection-status" role="status"><LoaderCircle size={14} className="spin"/>Verificando tradução e OCR…</p>}
            <div className="pdf-workflow-actions" role="group" aria-label="Forma de tradução do PDF">
              <div><button className="primary-button" disabled={analysisUnavailable || !config?.configured} onClick={() => startWorkflow('direct')} aria-describedby="direct-workflow-description"><Languages size={19}/><span>Traduzir diretamente</span><ArrowRight size={19}/></button><p id="direct-workflow-description">A tradução começa após o OCR, sem confirmar cada página. Você pode revisar o resultado depois.</p></div>
              <div><button className="pdf-review-button" disabled={analysisUnavailable} onClick={() => startWorkflow('review')} aria-describedby="review-workflow-description"><ScanLine size={19}/><span>Analisar e revisar PDF</span><ArrowRight size={19}/></button><p id="review-workflow-description">Confira e ajuste texto, figuras e equações antes de traduzir.</p></div>
            </div>
            <p className="privacy-line"><LockKeyhole size={13}/>OCR e tradução usam serviços externos. As chaves ficam no servidor.</p>
          </section>
          <aside className="details-column">
            <section className="output-card"><div className="output-heading"><span className="eyebrow">DO ORIGINAL À TRADUÇÃO</span><span className="output-icon"><LayoutTemplate size={21}/></span></div><h2>O texto muda.<br/><span>As fórmulas ficam.</span></h2><p>Traduza o texto, preserve imagens e equações e baixe o resultado em Word ou PDF.</p><div className="output-format"><div className="pdf-icon">PDF</div><div><strong>Word e PDF traduzidos</strong><span>Texto editável e selecionável</span></div><ArrowDownToLine size={20}/></div><ol className="workflow-list"><li><span>1</span><div><strong>Escolha como traduzir</strong><p>Traduza diretamente ou revise a extração antes.</p></div></li><li><span>2</span><div><strong>Acompanhe a tradução</strong><p>O texto de todas as páginas é extraído antes da tradução.</p></div></li><li><span>3</span><div><strong>Baixe os arquivos</strong><p>Revise o resultado se desejar e gere Word ou PDF.</p></div></li></ol><div className="fidelity-note"><span>DIAGRAMAÇÃO APROXIMADA</span><p>O PDF procura manter a organização do original. Fontes e paginação podem mudar. O Word usa uma coluna. O texto dentro de figuras e tabelas preservadas permanece no idioma original.</p></div></section>
            <section className="privacy-card"><div className="privacy-icon"><ShieldCheck size={21}/></div><div><h3>Saiba o que é enviado</h3><p>Todas as páginas do PDF são enviadas a um serviço externo de OCR. O texto extraído segue para o serviço de tradução, automaticamente no modo direto. Os recortes são feitos no navegador.</p><button onClick={() => setModal('privacy')}>Entenda a privacidade<ArrowUpRight size={14}/></button></div></section>
          </aside>
        </div>
        <div className="bottom-caption"><span><Check size={16}/>Revise termos técnicos e elementos científicos antes de usar o resultado.</span><button onClick={() => setModal('help')}>Como funciona a revisão?<ArrowUpRight size={14}/></button></div>
      </main>}
      </div>
      <footer><span>lume<span className="brand-dot">.</span><span className="footer-divider">/</span>Tradução e resumo de artigos científicos</span><span>{mode === 'text' ? 'Textos' : 'Arquivos'} na memória desta página <LockKeyhole size={12}/></span></footer>
    </div>
    <dialog ref={dialog} onCancel={() => setModal(null)} onClose={() => setModal(null)} onClick={e => { if (e.target === e.currentTarget) setModal(null); }} aria-labelledby="dialog-title"><div className="dialog-content"><button className="icon-button dialog-close" onClick={() => setModal(null)} aria-label="Fechar"><X size={22}/></button><div className="dialog-icon">{modal === 'privacy' ? <ShieldCheck size={26}/> : <CircleHelp size={26}/>}</div><h2 id="dialog-title">{modal === 'privacy' ? 'Privacidade e processamento' : 'Como funciona o Lume'}</h2>{modal === 'privacy' ? <>
      <p>O Lume mantém o PDF, os recortes e os arquivos gerados na memória desta página. O aplicativo não mantém histórico nem salva documentos em banco de dados ou armazenamento local.</p>
      <p>Ao analisar um PDF, o servidor envia todas as páginas a um serviço externo de OCR, incluindo seu texto e conteúdo visual. Isso também se aplica a PDFs com texto selecionável. Figuras e equações usadas na exportação são recortadas do original no navegador.</p>
      <p>Na opção Traduzir texto, o conteúdo digitado ou colado é enviado a um serviço externo de tradução enquanto você escreve. Nos PDFs, o texto extraído e o contexto necessário também são enviados a esse serviço. Em “Traduzir diretamente”, o envio começa automaticamente após o OCR. Em “Analisar e revisar PDF”, começa após sua conferência. Os envios passam pela infraestrutura de hospedagem do aplicativo.</p>
      <p>Os serviços externos aplicam suas próprias políticas de processamento e retenção. As credenciais ficam no servidor.</p>
      <p>Ao fechar ou recarregar a página, você perde a revisão, o progresso e os resultados. Interromper impede novos envios, mas uma solicitação de OCR ou tradução já aceita pode continuar e gerar cobrança.</p>
    </> : <>
      <p><strong>Tradução de texto:</strong> escolha “Traduzir texto” no menu, selecione os idiomas e digite ou cole até 10.000 palavras. A tradução começa automaticamente e é atualizada na segunda caixa enquanto você escreve, sem precisar parar de digitar. O resultado permanece visível durante as atualizações e pode ser copiado. Esta opção aceita somente texto simples, sem arquivos, imagens ou anexos. Textos longos são traduzidos em trechos; se interromper, você pode retomar ou continuar escrevendo enquanto mantém esta página aberta.</p>
      <ol><li><strong>Escolha um PDF.</strong> Até {formatFileSize(MAX_FILE_BYTES)} ({MAX_FILE_BYTES.toLocaleString('pt-BR')} bytes) e {MAX_PDF_PAGES} páginas. Todas as páginas são enviadas a um serviço externo de OCR.</li><li><strong>Escolha como traduzir.</strong> Em “Traduzir diretamente”, a tradução começa após o OCR, sem confirmar cada página. Em “Analisar e revisar PDF”, confira palavras, ordem de leitura e recortes e confirme cada página antes de traduzir.</li><li><strong>Acompanhe a tradução.</strong> Retome os trechos pendentes após uma interrupção, mantendo esta página aberta.</li><li><strong>Baixe os arquivos.</strong> Revise e corrija o resultado se desejar e gere Word editável e PDF com texto selecionável.</li></ol>
      <p><strong>Extração de PDFs:</strong> o reconhecimento de texto usa um serviço externo com cobrança por página. Confira especialmente palavras, símbolos e limites dos recortes; a leitura automática pode conter erros.</p>
      <p><strong>Elementos científicos:</strong> figuras e equações são preservadas como imagens do original. Textos dentro desses recortes permanecem no idioma original. Legendas extraídas como texto são traduzidas.</p>
      <p><strong>Montagem:</strong> o PDF usa a organização do original como referência, com uma ou duas colunas e comparação visual. O texto pode continuar em páginas adicionais. O Word usa uma coluna. Se algum caractere não for suportado pela fonte do PDF, o Word continuará disponível para edição.</p>
      <p><strong>Sua sessão:</strong> mantenha a página aberta para conservar a revisão, o progresso e as traduções concluídas.</p>
    </>}</div></dialog>
  </div>;
}
