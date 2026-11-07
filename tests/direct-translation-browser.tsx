import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import StructuredTranslation from '../src/StructuredTranslation';
import type { OcrResult } from '../src/ocr-contract';
import '../src/styles.css';

const parameters = new URLSearchParams(location.search);
const scenario = parameters.get('scenario') || 'direct';
const replacementStage = parameters.get('stage') || 'translation';
let releaseOldOperation: (() => void) | undefined;
let exportFontWaiting = false;
const oldOperationGate = new Promise<void>(resolve => { releaseOldOperation = resolve; });
const blockCount = scenario === 'paused' ? 6 : 2;
const text = (index: number) => index === 0
  ? 'The measured relation $x$ describes the sample under controlled experimental conditions.'
  : `The measured observation ${index + 1} describes the sample and preserves the evidence from the original article.`;
const recognition: OcrResult = { model: 'mistral-ocr-4-1', usage: { pages: 1 }, page: {
  width: 600, height: 800, confidence: 98,
  blocks: Array.from({ length: blockCount }, (_, index) => ({
    type: 'text', x: 40, y: 60 + index * 90, width: 520, height: 65,
    content: text(index), confidence: 98,
  })),
} };
if (scenario === 'file-replacement' && replacementStage === 'export') recognition.page.blocks[0].content += ' The mean is μ.';
if (scenario === 'word-failure') {
  // The long caption is supported by the PDF region planner but exceeds the
  // unchanged DOCX single-page figure/caption guard.
  recognition.page.blocks = [
    { type: 'image', x: 40, y: 60, width: 520, height: 100, content: '', confidence: null },
    { type: 'caption', x: 40, y: 180, width: 520, height: 400,
      content: 'Figure description preserves every observation and its scientific context. '.repeat(29), confidence: 99 },
  ];
}

declare global {
  interface Window {
    directUiReady: Promise<void>;
    directUiData: { scenario: string; ocrCalls: number; translationCalls: number; aborted: number; batches: string[][] };
  }
}
window.directUiData = { scenario, ocrCalls: 0, translationCalls: 0, aborted: 0, batches: [] };
const result = document.querySelector<HTMLElement>('#result')!;
const originalFetch = window.fetch.bind(window);
const generatedBlobs = new Map<string, Blob>();
const createObjectUrl = URL.createObjectURL.bind(URL);
URL.createObjectURL = object => { const url = createObjectUrl(object); if (object instanceof Blob) generatedBlobs.set(url, object); return url; };
const previewViolations: string[] = [];
window.addEventListener('securitypolicyviolation', event => previewViolations.push(`CSP: ${event.violatedDirective} ${event.blockedURI}`));
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.protocol === 'blob:') { previewViolations.push('Busca indevida de URL blob.'); throw new Error('A comparação precisa carregar os bytes em memória.'); }
  if (url.origin !== location.origin) throw new Error('O teste tentou acessar um serviço externo.');
  if (scenario === 'file-replacement' && replacementStage === 'export' && /NotoSerif-.*\.ttf/.test(url.pathname)) {
    exportFontWaiting = true;
    await oldOperationGate;
  }
  if (String(input) === '/api/ocr' || url.pathname === '/api/ocr') {
    window.directUiData.ocrCalls++;
    if (init?.method !== 'POST' || new Headers(init.headers).get('Content-Type') !== 'application/pdf' || !(init.body instanceof ArrayBuffer)) {
      throw new Error('A requisição OCR precisa conter uma página PDF binária.');
    }
    if ((await PDFDocument.load(init.body)).getPageCount() !== 1) throw new Error('O OCR recebeu mais de uma página.');
    if (scenario === 'ocr-failure' && window.directUiData.ocrCalls === 2) {
      return Response.json({ error: 'Falha OCR simulada da segunda página.' }, { status: 503 });
    }
    return Response.json(structuredClone(recognition));
  }
  if (String(input) === '/api/translate-text' || url.pathname === '/api/translate-text') {
    window.directUiData.translationCalls++;
    const body = JSON.parse(String(init?.body)) as { text: string[] };
    window.directUiData.batches.push(body.text);
    if (new Headers(init?.headers).get('X-Access-Code') !== 'fixture-access') throw new Error('Tradução sem código de acesso.');
    if (scenario === 'file-replacement' && window.directUiData.translationCalls === 1) {
      init?.signal?.addEventListener('abort', () => { window.directUiData.aborted++; }, { once: true });
      // Deliberately return a late success even after cancellation, exercising
      // the UI generation guard rather than relying on this mock to stop.
      if (replacementStage === 'translation') await oldOperationGate;
    }
    if (scenario === 'translation-failure' && window.directUiData.translationCalls === 1) {
      return Response.json({ error: 'Falha de tradução simulada.' }, { status: 503 });
    }
    if (scenario === 'paused' && window.directUiData.translationCalls === 2) {
      await new Promise<void>((_resolve, reject) => {
        const aborted = () => { window.directUiData.aborted++; reject(new DOMException('Interrompido', 'AbortError')); };
        if (init?.signal?.aborted) aborted();
        else init?.signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    return Response.json({ translations: body.text.map(xml => {
      const translated = xml.replace('The measured', 'A relação medida');
      return scenario === 'translation-warning' ? translated.replace('observation 2', 'observation 3') : translated;
    }) });
  }
  return originalFetch(input, init);
};

async function createFixture(replacement = false): Promise<File> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < (scenario === 'ocr-failure' ? 2 : 1); index++) {
    const page = pdf.addPage([600, 800]);
    page.drawText(replacement ? 'Replacement article for document lifecycle regression.' : 'Synthetic article for direct translation regression.', { x: 40, y: 740, size: 12, font });
  }
  return new File([new Uint8Array(await pdf.save()).buffer], `${replacement ? 'replacement' : 'direct'}-${scenario}.pdf`, { type: 'application/pdf' });
}

function Fixture({ file }: { file: File }) {
  const [code, setCode] = useState('fixture-access');
  const [activeFile, setActiveFile] = useState(file);
  return <>{scenario === 'file-replacement' && <button id="replace-document" onClick={() => { void createFixture(true).then(setActiveFile); }}>Trocar documento durante a operação</button>}<StructuredTranslation file={activeFile} source="EN" target="PT-BR" code={code} onCodeChange={setCode}
    workflow={scenario === 'review' ? 'review' : 'direct'} configured={scenario !== 'unavailable'}
    ocrConfigured ocrModel="mistral-ocr-latest" accessRequired onClose={() => {}}/></>;
}
window.directUiReady = createFixture().then(file => {
  createRoot(document.querySelector('#root')!).render(<StrictMode><Fixture file={file}/></StrictMode>);
  result.textContent = `Cenário ${scenario} iniciado com APIs simuladas.`;
}).catch(error => {
  result.textContent = error instanceof Error ? error.stack || error.message : String(error);
  result.dataset.status = 'failed'; document.body.dataset.result = 'fail';
  throw error;
});
if (scenario === 'word-failure') {
  void window.directUiReady.then(async () => {
    const start = performance.now();
    while (!document.querySelector('a[download$=".pdf"]') || !document.querySelector('.structured-status')?.textContent?.includes('Não foi possível montar o Word.')) {
      if (performance.now() - start > 20000) throw new Error('Uma falha do Word impediu a entrega independente do PDF.');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (document.querySelector('a[download$=".docx"]')) throw new Error('O cenário deveria recusar o Word com legenda excessiva.');
    if (!document.querySelector('.pdf-comparison')) throw new Error('A falha do Word ocultou a comparação do PDF.');
    const previewStart = performance.now();
    while (document.querySelectorAll('.pdf-comparison canvas:not([hidden])').length !== 2) {
      if (performance.now() - previewStart > 15000) throw new Error('A comparação não renderizou as duas páginas sob a política de segurança.');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    if (previewViolations.length) throw new Error(previewViolations.join('; '));
    result.textContent = 'Exportações independentes: PDF disponível e comparação aberta após falha de montagem do Word: OK'; result.dataset.status = 'passed';
  }).catch(error => { result.textContent = `FALHA: ${error instanceof Error ? error.stack : String(error)}`; result.dataset.status = 'failed'; });
}
if (scenario === 'file-replacement') {
  void window.directUiReady.then(async () => {
    const until = async (check: () => boolean, message: string) => {
      const start = performance.now();
      while (!check()) {
        if (performance.now() - start > 20000) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    };
    await until(() => replacementStage === 'export' ? exportFontWaiting : window.directUiData.translationCalls === 1, 'A operação inicial não começou.');
    document.querySelector<HTMLButtonElement>('#replace-document')!.click();
    await until(() => window.directUiData.ocrCalls >= 2 && window.directUiData.translationCalls >= 2, 'A operação antiga bloqueou a tradução do novo arquivo.');
    if (!window.directUiData.aborted) throw new Error('A operação do documento anterior não foi cancelada.');
    if (replacementStage === 'export') releaseOldOperation?.();
    const ready = () => Boolean(document.querySelector('a[download$=".pdf"]')) && Boolean(document.querySelector('.structured-status')?.textContent?.includes('Word e PDF prontos.'));
    await until(ready, 'O novo documento não concluiu a exportação.');
    if (replacementStage === 'translation') {
      releaseOldOperation?.();
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready()) throw new Error('O término antigo alterou o estado do novo documento.');
    const link = document.querySelector<HTMLAnchorElement>('a[download$=".pdf"]')!;
    const blob = generatedBlobs.get(link.href);
    if (!blob) throw new Error('O PDF gerado não está disponível em memória.');
    const artifact = await PDFDocument.load(await blob.arrayBuffer());
    if (artifact.getTitle() !== 'replacement-file-replacement.pdf') throw new Error('O resultado antigo substituiu o PDF do novo arquivo.');
    if (window.directUiData.translationCalls !== 2) throw new Error('A troca do documento gerou chamadas extras.');
    if (document.querySelector('.error-notice')) throw new Error('A operação antiga deixou um erro no novo documento.');
    if (previewViolations.length) throw new Error(previewViolations.join('; '));
    result.textContent = `Troca durante ${replacementStage}: operação anterior cancelada, novo PDF correto e conclusão antiga sem alterar a sessão: OK`; result.dataset.status = 'passed';
  }).catch(error => { releaseOldOperation?.(); result.textContent = `FALHA: ${error instanceof Error ? error.stack : String(error)}`; result.dataset.status = 'failed'; });
}
