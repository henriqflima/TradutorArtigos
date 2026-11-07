import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import PdfComparison from '../src/PdfComparison';
import type { PdfLayoutReport } from '../src/pdf-layout';
import { pdfSourceOptions } from '../src/pdf-options';
import '../src/styles.css';
import '../src/structured.css';

GlobalWorkerOptions.workerSrc = workerUrl;
const result = document.querySelector<HTMLElement>('#result')!;
const failures: string[] = [];
window.addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
window.addEventListener('securitypolicyviolation', event => failures.push(`CSP: ${event.violatedDirective} ${event.blockedURI}`));
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.protocol === 'blob:') { failures.push('A prévia tentou buscar uma URL blob.'); return Promise.reject(new Error('Busca de URL blob bloqueada pelo teste.')); }
  return nativeFetch(input, init);
};
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(test: () => boolean, message: string) {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > 15000) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
async function pdfBytes(label: string, pages: number) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  for (let index = 1; index <= pages; index++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`${label} - page ${index}`, { x: 45, y: 780, font, size: 18 });
    page.drawText('Content preserved with selectable text.', { x: 45, y: 750, font, size: 11 });
  }
  return new Uint8Array(await pdf.save());
}
const report: PdfLayoutReport = { pages: [
  { sourcePage: 1, outputPages: [1, 2], mode: 'flow', columns: 2, warnings: [] },
  { sourcePage: 2, outputPages: [2, 3], mode: 'simplified', columns: 2, warnings: ['Distribuição conservadora para geometria ambígua.'] },
  { sourcePage: 3, outputPages: [], mode: 'flow', columns: 2, warnings: [] },
], outputPages: [
  { outputPage: 1, sourcePages: [1], columns: 2 },
  { outputPage: 2, sourcePages: [1, 2], columns: 2 },
  { outputPage: 3, sourcePages: [2], columns: 2 },
] };
const nextReport: PdfLayoutReport = { pages: [
  { sourcePage: 1, outputPages: [1], mode: 'flow', columns: 1, warnings: [] },
  { sourcePage: 2, outputPages: [1, 2], mode: 'flow', columns: 1, warnings: [] },
  { sourcePage: 3, outputPages: [], mode: 'flow', columns: 1, warnings: [] },
], outputPages: [
  { outputPage: 1, sourcePages: [1, 2], columns: 1 },
  { outputPage: 2, sourcePages: [2], columns: 1 },
] };
function Fixture({ original, blobs }: { original: PDFDocumentProxy; blobs: Blob[] }) {
  const [open, setOpen] = useState(true);
  const [version, setVersion] = useState(0);
  return <div className="structured-workspace">
    <button className="structured-secondary" id="open" onClick={() => setOpen(true)}>Abrir comparação</button>
    <button className="structured-secondary" id="replace" onClick={() => setVersion(value => 1 - value)}>Trocar resultado</button>
    {open && <PdfComparison key={version} original={original} resultBlob={blobs[version]} report={version === 0 ? report : nextReport} onClose={() => setOpen(false)}/>}
  </div>;
}
function choose(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  assert(select, `Controle ${label} ausente.`);
  select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
}
async function rendered() {
  await until(() => document.querySelectorAll('.pdf-comparison canvas:not([hidden])').length === 2 && !document.querySelector('.pdf-comparison-page[aria-busy="true"]'), 'As duas páginas não foram renderizadas.');
  assert(!document.querySelector('.pdf-comparison .error-notice'), 'A prévia mostrou um erro de renderização.');
}
async function run() {
  result.dataset.status = 'running';
  try {
    const [source, translated, replacement] = await Promise.all([pdfBytes('Original', 3), pdfBytes('Translation', 3), pdfBytes('Replacement', 2)]);
    const original = await getDocument({ data: source, ...pdfSourceOptions() }).promise;
    const blobs = [translated, replacement].map(bytes => new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' }));
    createRoot(document.querySelector('#root')!).render(<StrictMode><Fixture original={original} blobs={blobs}/></StrictMode>);
    await rendered();
    assert(document.querySelector('.pdf-comparison')?.textContent?.includes('páginas originais 2'), 'Aviso de montagem simplificada ausente.');
    choose('Página traduzida na comparação', '2');
    await until(() => Boolean(document.querySelector('.pdf-comparison-column:last-child h3')?.textContent?.includes('Página 2')), 'A segunda página traduzida não foi selecionada.');
    await rendered();
    assert(document.querySelector('.pdf-comparison')?.textContent?.includes('conteúdo das páginas originais 1, 2'), 'A página traduzida não informa suas duas origens.');
    choose('Página original na comparação', '2');
    await until(() => Boolean(document.querySelector('.pdf-comparison-column:last-child h3')?.textContent?.includes('Página 2')), 'A página original 2 não foi associada à página traduzida compartilhada.');
    await rendered();
    const output = document.querySelector<HTMLSelectElement>('select[aria-label="Página traduzida na comparação"]')!;
    assert(output.options.length === 3, 'A navegação deve permitir acessar todas as páginas traduzidas.');
    choose('Página original na comparação', '1');
    choose('Página traduzida na comparação', '3');
    await until(() => document.querySelector<HTMLSelectElement>('select[aria-label="Página original na comparação"]')?.value === '2', 'Selecionar o destino não localizou a página original correspondente.');
    await rendered();
    assert(document.querySelector('.pdf-comparison-column:last-child h3')?.textContent?.includes('Página 3'), 'O destino selecionado foi substituído pelo primeiro destino da origem.');
    choose('Página original na comparação', '3');
    await until(() => Boolean(document.querySelector('.pdf-comparison-column:last-child h3')?.textContent?.includes('Sem página correspondente')), 'Uma página sem conteúdo ganhou uma correspondência falsa.');
    assert(!document.querySelector('.pdf-comparison-column:last-child canvas'), 'Uma prévia ordinal foi exibida para uma origem sem conteúdo exportado.');
    assert(document.querySelector('.pdf-comparison')?.textContent?.includes('não tem conteúdo representado no PDF traduzido'), 'A ausência de conteúdo exportado não foi explicada.');
    choose('Página traduzida na comparação', '1');
    await until(() => document.querySelector<HTMLSelectElement>('select[aria-label="Página original na comparação"]')?.value === '1', 'A navegação por destino não saiu da origem sem conteúdo.');
    await rendered();
    choose('Página original na comparação', '1');
    await new Promise(resolve => setTimeout(resolve, 0));
    choose('Página original na comparação', '2');
    await rendered();
    assert(document.querySelector('.pdf-comparison-column:last-child h3')?.textContent?.includes('Página 2'), 'Uma renderização antiga substituiu a página atual.');
    const close = Array.from(document.querySelectorAll<HTMLButtonElement>('.pdf-comparison button')).find(button => button.textContent?.includes('Ocultar comparação'))!;
    close.click();
    await until(() => !document.querySelector('.pdf-comparison'), 'Fechar comparação não removeu a prévia.');
    document.querySelector<HTMLButtonElement>('#open')!.click(); await rendered();
    document.querySelector<HTMLButtonElement>('#replace')!.click();
    await until(() => document.querySelector<HTMLSelectElement>('select[aria-label="Página traduzida na comparação"]')?.options[0]?.textContent === '1 de 2', 'A nova geração não substituiu o PDF anterior.');
    await rendered();
    assert(!document.querySelector('.pdf-comparison')?.textContent?.includes('Montagem simplificada'), 'Os avisos do resultado anterior permaneceram após gerar outro PDF.');
    assert(failures.length === 0, `Falhas assíncronas: ${failures.join('; ')}`);
    result.textContent = 'Comparação: correspondência de várias origens e destinos, navegação nos dois sentidos, origem sem conteúdo sem prévia falsa, navegação rápida e troca de resultado: OK';
    result.dataset.status = 'passed';
  } catch (error) {
    result.textContent = `FALHA: ${error instanceof Error ? error.stack : String(error)}`;
    result.dataset.status = 'failed';
  }
}
void run();
