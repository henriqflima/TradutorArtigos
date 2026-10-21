import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, FileText, Languages, LayoutTemplate, LoaderCircle, LockKeyhole, ScanLine, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, MAX_PDF_PAGES, validateFile, formatFileSize } from './shared';
import PlainTextTranslation from './PlainTextTranslation';

type Config = { configured: boolean; accessRequired: boolean; provider: 'openai'; model: 'gpt-6-luna' };
const StructuredTranslation = lazy(() => import('./StructuredTranslation'));

export default function App() {
  const [mode, setMode] = useState<'pdf' | 'text'>('pdf');
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
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  async function loadConfig() {
    setConfigError(false); setConfigLoading(true);
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (typeof data.configured !== 'boolean' || typeof data.accessRequired !== 'boolean' || data.provider !== 'openai' || data.model !== 'gpt-6-luna') throw new Error();
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
  function analyze() {
    if (!file) return;
    const invalid = validateFile(file);
    if (invalid) { setError(invalid); return; }
    if (source && source === target.split('-')[0]) { setError('Escolha idiomas de origem e destino diferentes.'); return; }
    setError(''); setReviewing(true);
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Lume, início"><img src="/favicon.svg" alt=""/><span>lume<span className="brand-dot">.</span></span></a>
      <div className="sidebar-label">ESPAÇO DE TRADUÇÃO</div>
      <nav className="translation-nav" aria-label="Modos de tradução">
        <button className={`nav-item ${mode === 'pdf' ? 'active' : ''}`} aria-current={mode === 'pdf' ? 'page' : undefined} onClick={() => setMode('pdf')}><FileText size={20}/><span>Traduzir PDF</span>{mode === 'pdf' && <span className="nav-dot"/>}</button>
        <button className={`nav-item ${mode === 'text' ? 'active' : ''}`} aria-current={mode === 'text' ? 'page' : undefined} onClick={() => setMode('text')}><Languages size={20}/><span>Traduzir texto</span>{mode === 'text' && <span className="nav-dot"/>}</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><div className="mini-spark"><Sparkles size={20}/></div><h3>Mais conhecimento.<br/>Menos fronteiras.</h3><p>Texto em outro idioma. Figuras e equações do original.</p></div>
        <button aria-label="Como funciona" onClick={() => setModal('help')}><CircleHelp size={18}/>Como funciona<ArrowUpRight size={16}/></button>
        <button aria-label="Privacidade" onClick={() => setModal('privacy')}><ShieldCheck size={18}/>Privacidade<ArrowUpRight size={16}/></button>
        <span className="sidebar-foot">FEITO PARA QUEM PESQUISA</span>
      </div>
    </aside>
    <div className={`workspace ${mode === 'pdf' && reviewing ? 'review-workspace' : ''}`}>
      <header className="topbar"><span>{mode === 'text' ? 'Textos' : 'Documentos'} <span className="slash">/</span> <strong>{mode === 'pdf' && reviewing ? 'Revisão e tradução' : 'Nova tradução'}</strong></span><span className="engine"><span className="engine-mark"><Languages size={13}/></span>{mode === 'text' ? 'Tradução de texto' : 'Tradução de PDF'}</span></header>
      <PlainTextTranslation hidden={mode !== 'text'} configured={Boolean(config?.configured)} accessRequired={Boolean(config?.accessRequired)}
        code={code} onCodeChange={setCode} configLoading={configLoading} configError={configError} onRetryConfig={() => void loadConfig()}/>
      <div className="mode-panel" hidden={mode !== 'pdf'}>
      {reviewing && file ? <Suspense fallback={<main className="loading-workspace" role="status"><LoaderCircle size={24} className="spin"/><p>Abrindo a análise local do PDF…</p></main>}>
        <StructuredTranslation file={file} source={source} target={target} code={code}
          configured={Boolean(config?.configured)} accessRequired={Boolean(config?.accessRequired)} onCodeChange={setCode}
          onClose={() => setReviewing(false)}/>
      </Suspense> : <main>
        <div className="page-heading"><div><div className="eyebrow"><span/> DA PESQUISA À COMPREENSÃO</div><h1>Uma nova língua.<br className="mobile-break"/> O mesmo conhecimento.</h1><p>Traduza artigos em PDF e preserve imagens e equações do original.</p></div><span className="version-pill">PDF · até 20 páginas</span></div>
        <div className="translation-grid">
          <section className="translation-card" aria-label="Selecionar PDF para tradução">
            <div className="card-heading"><div><span className="step-number">01</span><h2>Seu PDF</h2></div><span className="muted small">Um arquivo por vez</span></div>
            <input ref={input} id="document" type="file" accept=".pdf,application/pdf" className="visually-hidden" onChange={e => selectFiles(e.target.files)}/>
            {!file ? <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); selectFiles(e.dataTransfer.files); }}>
              <div className="upload-symbol"><FileText size={31} strokeWidth={1.5}/><span><Upload size={13}/></span></div>
              <h3>Seu próximo artigo começa aqui</h3><p>Arraste o PDF para esta área ou</p><button className="select-file" onClick={() => input.current?.click()}><Upload size={16}/>Escolher PDF</button>
              <span className="upload-limits">Somente PDF · até 4 MB · até {MAX_PDF_PAGES} páginas</span>
            </div> : <div className="selected-file"><div className="file-icon"><FileText size={30}/></div><div className="file-description"><strong>{file.name}</strong><span>PDF <span>·</span> {formatFileSize(file.size)}<span>·</span> Páginas verificadas na análise</span></div><button className="icon-button" onClick={clearFile} aria-label="Remover PDF"><X size={19}/></button></div>}
            <div className="format-row"><span><ScanLine size={15}/>Análise no navegador</span><span><ShieldCheck size={15}/>Recortes preservados</span></div>
            <div className="section-divider"/>
            <div className="card-heading language-heading"><div><span className="step-number">02</span><h2>Escolha os idiomas</h2></div></div>
            <div className="language-selectors"><label>Idioma original<div className="select-wrap"><select value={source} onChange={e => setSource(e.target.value)}><option value="">Detectar automaticamente</option>{SOURCE_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={16}/></div></label><ArrowRight className="language-arrow" size={19}/><label>Traduzir para<div className="select-wrap target-select"><select value={target} onChange={e => setTarget(e.target.value)}>{TARGET_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={16}/></div></label></div>
            {config?.accessRequired && <label className="access-label">Código de acesso<input type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} placeholder="Informe o código deste aplicativo"/></label>}
            <p className="inline-note">Primeiro, confira a extração de cada página. Só depois o texto será enviado para tradução. Figuras e equações são preservadas como imagens do PDF original.</p>
            {error && <div className="notice error-notice" role="alert"><CircleHelp size={18}/><span>{error}</span></div>}
            {configError && <div className="notice" role="status"><CircleHelp size={18}/><span>Não foi possível conectar ao serviço de tradução. Você pode analisar o PDF localmente. <button className="text-button" onClick={() => void loadConfig()}>Tentar novamente</button></span></div>}
            {config && !config.configured && <div className="notice"><LockKeyhole size={18}/><span>A tradução ainda não está disponível. Você pode analisar e revisar o PDF normalmente.</span></div>}
            {configLoading && <p className="connection-status" role="status"><LoaderCircle size={14} className="spin"/>Verificando o serviço de tradução…</p>}
            <button className="primary-button" disabled={!file || configLoading} onClick={analyze}><ScanLine size={19}/><span>Analisar e revisar PDF</span><ArrowRight size={19}/></button>
            <p className="privacy-line"><LockKeyhole size={13}/>Somente o texto revisado é enviado para tradução.</p>
          </section>
          <aside className="details-column">
            <section className="output-card"><div className="output-heading"><span className="eyebrow">DO ORIGINAL À TRADUÇÃO</span><span className="output-icon"><LayoutTemplate size={21}/></span></div><h2>O texto muda.<br/><span>As fórmulas ficam.</span></h2><p>Traduza o texto, preserve imagens e equações e baixe o resultado em Word ou PDF.</p><div className="output-format"><div className="pdf-icon">PDF</div><div><strong>Word e PDF traduzidos</strong><span>Texto editável e selecionável</span></div><ArrowDownToLine size={20}/></div><ol className="workflow-list"><li><span>1</span><div><strong>Analise o PDF</strong><p>Extração e recortes no navegador.</p></div></li><li><span>2</span><div><strong>Confira cada página</strong><p>Ajuste texto, figuras e equações.</p></div></li><li><span>3</span><div><strong>Traduza o texto</strong><p>Revise o resultado e baixe os arquivos.</p></div></li></ol><div className="fidelity-note"><span>LEITURA EM UMA COLUNA</span><p>O documento é remontado. Fontes, colunas e paginação podem mudar. O texto dentro de figuras e tabelas preservadas permanece no idioma original.</p></div></section>
            <section className="privacy-card"><div className="privacy-icon"><ShieldCheck size={21}/></div><div><h3>O PDF permanece nesta página</h3><p>O texto é enviado para tradução. Imagens e equações são preservadas no navegador.</p><button onClick={() => setModal('privacy')}>Entenda a privacidade<ArrowUpRight size={14}/></button></div></section>
          </aside>
        </div>
        <div className="bottom-caption"><span><Check size={16}/>Revise termos técnicos e elementos científicos antes de usar o resultado.</span><button onClick={() => setModal('help')}>Como funciona a revisão?<ArrowUpRight size={14}/></button></div>
      </main>}
      </div>
      <footer><span>lume<span className="brand-dot">.</span><span className="footer-divider">/</span>Conhecimento que vai além.</span><span>{mode === 'text' ? 'Textos' : 'Arquivos'} na memória desta página <LockKeyhole size={12}/></span></footer>
    </div>
    <dialog ref={dialog} onCancel={() => setModal(null)} onClose={() => setModal(null)} onClick={e => { if (e.target === e.currentTarget) setModal(null); }} aria-labelledby="dialog-title"><div className="dialog-content"><button className="icon-button dialog-close" onClick={() => setModal(null)} aria-label="Fechar"><X size={22}/></button><div className="dialog-icon">{modal === 'privacy' ? <ShieldCheck size={26}/> : <CircleHelp size={26}/>}</div><h2 id="dialog-title">{modal === 'privacy' ? 'Privacidade, com clareza.' : 'Do PDF à sua próxima leitura.'}</h2>{modal === 'privacy' ? <>
      <p>O PDF, os recortes de imagens e equações e os arquivos gerados são processados na memória desta página. O Lume não mantém histórico nem salva esses documentos em banco de dados ou armazenamento local.</p>
      <p>Na opção Traduzir texto, o conteúdo digitado ou colado é enviado automaticamente a um serviço externo enquanto você escreve. Você pode interromper a tradução. Na opção PDF, os trechos revisados e o contexto necessário são enviados após sua conferência. O PDF completo, as imagens e as equações permanecem no navegador.</p>
      <p>O serviço de tradução aplica suas próprias políticas de processamento e retenção de dados e pode manter registros técnicos das solicitações.</p>
      <p>Ao fechar ou recarregar a página, você perde a revisão, o progresso e os resultados desta sessão. Interromper no Lume não garante o cancelamento de um trecho já enviado para tradução.</p>
      <a href="https://platform.openai.com/docs/guides/your-data" target="_blank" rel="noreferrer">Consultar a política de tratamento de dados<ArrowUpRight size={15}/></a>
    </> : <>
      <p><strong>Tradução de texto:</strong> escolha “Traduzir texto” no menu, selecione os idiomas e digite ou cole até 10.000 palavras. A tradução começa automaticamente e é atualizada na segunda caixa enquanto você escreve, sem precisar parar de digitar. O resultado permanece visível durante as atualizações e pode ser copiado. Esta opção aceita somente texto simples, sem arquivos, imagens ou anexos. Textos longos são traduzidos em trechos; se interromper, você pode retomar ou continuar escrevendo enquanto mantém esta página aberta.</p>
      <ol><li><strong>Escolha um PDF.</strong> Até 4 MB (4.000.000 bytes) e {MAX_PDF_PAGES} páginas. O número de páginas é conferido antes da tradução.</li><li><strong>Revise a análise local.</strong> Confira palavras e ordem de leitura. Ajuste os recortes de figuras, tabelas e equações e confirme cada página.</li><li><strong>Traduza o texto.</strong> Acompanhe o progresso e retome os trechos pendentes após uma interrupção, mantendo esta página aberta.</li><li><strong>Confira e baixe.</strong> Corrija a tradução localmente e gere Word editável e PDF com texto selecionável.</li></ol>
      <p><strong>PDF digitalizado:</strong> o reconhecimento de texto ocorre no navegador, com suporte inicial a inglês e português. Confira especialmente palavras, símbolos e limites dos recortes; a leitura automática pode conter erros.</p>
      <p><strong>Elementos científicos:</strong> figuras e equações são preservadas como imagens do original. Textos dentro desses recortes permanecem no idioma original. Legendas extraídas como texto são traduzidas.</p>
      <p><strong>Montagem:</strong> o resultado usa uma coluna, com paginação e fontes próprias. Se algum caractere não for suportado pela fonte do PDF, o Word continuará disponível para edição.</p>
      <p><strong>Sua sessão:</strong> mantenha a página aberta para conservar a revisão, o progresso e as traduções concluídas.</p>
    </>}</div></dialog>
  </div>;
}
