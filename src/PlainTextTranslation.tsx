import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ArrowLeftRight, ArrowRight, Check, ChevronDown, CircleHelp, Copy, Languages, LoaderCircle, LockKeyhole, Square, Type, X } from 'lucide-react';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from './shared';
import { countWords, MAX_TEXT_WORDS, validatePlainText } from './plain-text';
import { EMPTY_LIVE_TRANSLATION, LiveTextTranslation, type LiveTextSnapshot } from './live-text-translation';

type Props = {
  hidden: boolean; configured: boolean; accessRequired: boolean; code: string; onCodeChange: (code: string) => void;
  configLoading: boolean; configError: boolean; onRetryConfig: () => void;
};
const FILE_ERROR = 'Somente texto é aceito aqui. Digite ou cole texto simples; arquivos e imagens não são permitidos.';

function containsFiles(data: DataTransfer): boolean {
  return data.files.length > 0 || Array.from(data.items).some(item => item.kind === 'file') || Array.from(data.types).includes('Files');
}

export default function PlainTextTranslation(props: Props) {
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('PT-BR');
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState<LiveTextSnapshot>({ ...EMPTY_LIVE_TRANSLATION });
  const translator = useRef<LiveTextTranslation | null>(null);
  const composition = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const { text: result, progress } = live;
  const busy = live.status === 'translating', waiting = live.status === 'waiting';
  const paused = live.status === 'paused', failed = live.status === 'error', finished = live.status === 'complete';
  const displayedError = error || live.error;

  const words = countWords(text);
  const overLimit = words > MAX_TEXT_WORDS;
  const sameLanguage = Boolean(source && source === target.split('-')[0]);
  const invalid = text ? validatePlainText(text) : null;
  const canTranslate = Boolean(text.trim()) && !invalid && !sameLanguage && props.configured && !props.configLoading &&
    !props.configError && (!props.accessRequired || Boolean(props.code.trim()));

  useEffect(() => {
    const active = new LiveTextTranslation(setLive);
    translator.current = active;
    return () => { active.dispose(); translator.current = null; };
  }, []);
  useEffect(() => {
    syncTranslation();
  }, [text, source, target, props.code, props.hidden, canTranslate, composing]);

  function syncTranslation(nextText = text, nextSource = source, nextTarget = target, nextCode = props.code) {
    const valid = !validatePlainText(nextText) && (!nextSource || nextSource !== nextTarget.split('-')[0]) &&
      props.configured && !props.configLoading && !props.configError && (!props.accessRequired || Boolean(nextCode.trim()));
    translator.current?.update(valid ? { text: nextText, source: nextSource, target: nextTarget, code: nextCode } : null,
      !props.hidden && !composition.current);
  }
  function updateText(value: string) {
    setError(''); setCopied(false); setText(value); syncTranslation(value);
  }
  function insertText(value: string) {
    const element = input.current;
    if (!element) return;
    const start = element.selectionStart, end = element.selectionEnd;
    updateText(text.slice(0, start) + value + text.slice(end));
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(start + value.length, start + value.length); });
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    if (containsFiles(event.clipboardData) || !event.clipboardData.types.includes('text/plain')) {
      setError(FILE_ERROR); return;
    }
    insertText(event.clipboardData.getData('text/plain'));
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (containsFiles(event.dataTransfer) || !event.dataTransfer.types.includes('text/plain')) {
      setError(FILE_ERROR); return;
    }
    if (event.target === input.current) insertText(event.dataTransfer.getData('text/plain'));
  }
  function swapLanguages() {
    if (!source) return;
    const nextSource = target.split('-')[0];
    const nextTarget = TARGET_LANGUAGES.find(([code]) => code === source)?.[0] ||
      TARGET_LANGUAGES.find(([code]) => code.split('-')[0] === source)?.[0];
    if (!nextTarget) return;
    const nextText = finished ? result : text;
    setError(''); setCopied(false); setSource(nextSource); setTarget(nextTarget); setText(nextText);
    syncTranslation(nextText, nextSource, nextTarget);
  }
  function resumeTranslation() {
    setError(''); translator.current?.resume();
  }
  async function copy() {
    try { await navigator.clipboard.writeText(result); setCopied(true); }
    catch { setError('Não foi possível copiar automaticamente. Selecione e copie o texto na caixa de tradução.'); }
  }

  return <main hidden={props.hidden} className="plain-text-workspace" onDragOver={event => event.preventDefault()} onDrop={drop}>
    <div className="page-heading"><div><div className="eyebrow"><span/> DE UMA LÍNGUA À OUTRA</div><h1>Suas palavras, em outro idioma.</h1><p>Escolha os idiomas e escreva. A tradução aparece automaticamente ao lado.</p></div><span className="version-pill">Texto · até 10.000 palavras</span></div>
    <section className="text-translator" aria-label="Tradutor de textos">
      <div className="text-languages language-selectors">
        <label htmlFor="text-source-language">Idioma original<div className="select-wrap"><select id="text-source-language" value={source} onChange={event => { setError(''); setCopied(false); setSource(event.target.value); syncTranslation(text, event.target.value); }}><option value="">Detectar automaticamente</option>{SOURCE_LANGUAGES.map(([code, label]) => <option value={code} key={code}>{label}</option>)}</select><ChevronDown size={16}/></div></label>
        <button className="icon-button swap-languages" onClick={swapLanguages} disabled={!source} aria-label="Inverter idiomas" title={source ? 'Inverter idiomas' : 'Selecione o idioma original para inverter'}><ArrowLeftRight size={19}/></button>
        <label htmlFor="text-target-language">Traduzir para<div className="select-wrap target-select"><select id="text-target-language" value={target} onChange={event => { setError(''); setCopied(false); setTarget(event.target.value); syncTranslation(text, source, event.target.value); }}>{TARGET_LANGUAGES.map(([code, label]) => <option value={code} key={code}>{label}</option>)}</select><ChevronDown size={16}/></div></label>
      </div>
      <div className="text-panels">
        <div className="text-panel">
          <div className="text-panel-heading"><label htmlFor="text-input"><Type size={17}/>Texto original</label><button className="icon-button" onClick={() => { updateText(''); input.current?.focus(); }} disabled={!text} aria-label="Limpar texto" title="Limpar texto"><X size={18}/></button></div>
          <textarea ref={input} id="text-input" value={text} onChange={event => updateText(event.target.value)} onPaste={paste} onCompositionStart={() => { composition.current = true; setComposing(true); syncTranslation(); }} onCompositionEnd={() => { composition.current = false; setComposing(false); syncTranslation(); }} placeholder="Digite ou cole o texto que deseja traduzir…" aria-describedby="text-limit text-input-error" aria-invalid={Boolean(invalid)} dir="auto" spellCheck={false}/>
          <div className="text-panel-footer"><span>Somente texto simples</span><span id="text-limit" className={overLimit ? 'word-count over-limit' : 'word-count'}>{words.toLocaleString('pt-BR')} / 10.000 palavras</span></div>
        </div>
        <div className="text-panel text-output-panel">
          <div className="text-panel-heading"><label htmlFor="text-output"><Languages size={17}/>{finished ? 'Tradução concluída' : result ? 'Tradução parcial' : 'Tradução'}</label><button className="text-copy" onClick={() => void copy()} disabled={!result} aria-label="Copiar tradução">{copied ? <Check size={16}/> : <Copy size={16}/>}<span>{copied ? 'Copiado' : 'Copiar'}</span></button></div>
          <textarea id="text-output" value={result} readOnly placeholder="A tradução aparecerá automaticamente aqui." aria-busy={busy || waiting} dir="auto" spellCheck={false}/>
          <div className="text-panel-footer"><span>{finished ? 'Pronto para copiar' : result ? 'O resultado ainda está incompleto' : 'Resultado em texto simples'}</span><span>{countWords(result).toLocaleString('pt-BR')} palavras</span></div>
        </div>
      </div>
      <div className="text-controls">
        {props.accessRequired && <label className="access-label" htmlFor="text-access-code">Código de acesso<input id="text-access-code" type="password" autoComplete="off" value={props.code} onChange={event => { setError(''); setCopied(false); props.onCodeChange(event.target.value); syncTranslation(text, source, target, event.target.value); }} placeholder="Informe o código deste aplicativo"/></label>}
        <div id="text-input-error">{(invalid || sameLanguage || displayedError) && <div className="notice error-notice" role="alert"><CircleHelp size={18}/><span>{invalid || (sameLanguage ? 'Escolha idiomas de origem e destino diferentes.' : displayedError)}</span></div>}</div>
        {props.configLoading && <p className="connection-status" role="status"><LoaderCircle size={14} className="spin"/>Verificando o serviço de tradução…</p>}
        {props.configError && <div className="notice" role="status"><CircleHelp size={18}/><span>Não foi possível conectar ao serviço de tradução. <button className="text-button" onClick={props.onRetryConfig}>Tentar novamente</button></span></div>}
        {!props.configLoading && !props.configError && !props.configured && <div className="notice" role="status"><LockKeyhole size={18}/><span>A tradução ainda não está disponível. A configuração do serviço precisa ser concluída.</span></div>}
        <div className="text-action-row"><p><LockKeyhole size={14}/>O texto é enviado automaticamente para tradução enquanto você escreve e fica nesta sessão do aplicativo.</p>{busy || waiting ? <button className="text-stop" onClick={() => translator.current?.pause()}><Square size={16}/>Interromper</button> : paused || failed ? <button className="primary-button" disabled={!canTranslate} onClick={resumeTranslation}><Languages size={18}/><span>{paused || result ? 'Retomar tradução' : 'Tentar novamente'}</span><ArrowRight size={18}/></button> : <span className="text-live-indicator"><Languages size={17}/>Tradução automática ativa</span>}</div>
        <div className="text-translation-status" role="status" aria-live="polite">{busy && <LoaderCircle size={15} className="spin"/>}{waiting ? 'Atualizando enquanto você escreve…' : busy ? `Traduzindo enquanto você escreve… ${progress ? `${progress.completed} de ${progress.total} trechos traduzidos.` : ''}` : paused ? 'Tradução pausada. Continue escrevendo ou retome para concluir.' : failed ? 'Tradução não concluída. Tente novamente ou continue escrevendo.' : finished ? 'Tradução atualizada automaticamente.' : 'A tradução acompanha o texto enquanto você escreve.'}</div>
      </div>
    </section>
    <p className="text-limit-note">Até 10.000 palavras por tradução, contadas pelos espaços e quebras de linha. Arquivos, imagens e anexos não são aceitos nesta opção.</p>
  </main>;
}
