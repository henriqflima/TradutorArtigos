import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createStructuredPdf } from '../src/structured-export';
import type { PdfLayoutReport } from '../src/pdf-layout';
import { DENSE_PAGE, DENSE_LEFT, DENSE_RIGHT, denseFixture } from './pdf-dense-fixture';

GlobalWorkerOptions.workerSrc = workerUrl;
const artifacts = new Map<string, Blob>(), urls: string[] = [];
const failures: string[] = [];
window.addEventListener('error', event => failures.push(event.message));
window.addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
window.addEventListener('securitypolicyviolation', event => failures.push(`CSP ${event.violatedDirective}: ${event.blockedURI}`));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const markers = Array.from({ length: 5 }, (_, i) => `DENSE_LEFT_${i + 1}`).concat(Array.from({ length: 4 }, (_, i) => `DENSE_RIGHT_${i + 1}`));
const element = (id: string) => document.getElementById(id)!;
async function read(blob: Blob) { return getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise; }
async function inspect(pdf: PDFDocumentProxy) {
  const pages: { items: TextItem[]; text: string }[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), content = await page.getTextContent();
    const items = content.items.filter((item): item is TextItem => 'str' in item && Boolean(item.str.trim()));
    for (const item of items) {
      assert(item.transform[4] >= -.5 && item.transform[4] + item.width <= DENSE_PAGE.width + .5, `Texto fora da largura na página ${number}.`);
      assert(item.transform[5] >= 0 && item.transform[5] + item.height <= DENSE_PAGE.height + .5, `Texto fora da altura na página ${number}.`);
    }
    pages.push({ items, text: items.map(item => item.str).join(' ') });
  }
  const output = pages.map(page => page.text).join(' ');
  for (const marker of markers) for (const suffix of ['BEGIN', 'END']) assert(output.match(new RegExp(`${marker}_${suffix}`, 'g'))?.length === 1, `Trecho perdido ou duplicado: ${marker}_${suffix}.`);
  return pages;
}
async function render(pdf: PDFDocumentProxy, host: HTMLElement, scale = 1.3) {
  for (let number = 1; number <= pdf.numPages; number++) {
    const paper = document.createElement('div'), label = document.createElement('p'), canvas = document.createElement('canvas');
    paper.className = 'paper'; label.textContent = `Página ${number} de ${pdf.numPages}`; paper.append(label, canvas); host.append(paper);
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
  }
}
function metric(value: string, label: string) {
  const card = document.createElement('div'), number = document.createElement('strong'), caption = document.createElement('span');
  card.className = 'metric'; number.textContent = value; caption.textContent = label; card.append(number, caption); element('metrics').append(card);
}
Object.assign(window, { denseLayoutArtifactBase64: async (name: string) => {
  const blob = artifacts.get(name); assert(blob, 'Artefato de teste não encontrado.');
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
} });
async function run() {
  const result = element('result'), button = element('run') as HTMLButtonElement, loaded: PDFDocumentProxy[] = [];
  const noisy = (element('scenario') as HTMLSelectElement).value === 'noisy';
  button.disabled = true; result.dataset.status = 'running'; result.textContent = 'Medindo e distribuindo os blocos…';
  urls.splice(0).forEach(URL.revokeObjectURL); artifacts.clear(); failures.splice(0);
  for (const id of ['original', 'translated', 'stress', 'metrics', 'downloads']) element(id).replaceChildren();
  try {
    const fixture = await denseFixture({ noisyHeader: noisy, hardBreaks: !noisy });
    let report: PdfLayoutReport | undefined;
    const translated = await createStructuredPdf(fixture.input, status => { result.textContent = status; }, undefined, value => { report = value; });
    const originalPdf = await read(fixture.original), translatedPdf = await read(translated); loaded.push(originalPdf, translatedPdf);
    const pages = await inspect(translatedPdf);
    artifacts.set('dense-original.pdf', fixture.original); artifacts.set('dense-translated.pdf', translated);
    metric(String(fixture.sourceWords), 'palavras no original');
    metric(`+${Math.round((fixture.translatedWords / fixture.sourceWords - 1) * 100)}%`, 'crescimento da tradução');
    metric(String(translatedPdf.numPages), 'páginas traduzidas');
    metric(String(report?.pages[0].columns || '?'), 'colunas identificadas');
    await render(originalPdf, element('original')); await render(translatedPdf, element('translated'));
    assert(report?.pages[0].columns === 2, 'Uma imprecisão local fez o documento perder suas duas colunas.');
    assert(translatedPdf.numPages <= 2, 'O conteúdo denso exigiu mais páginas do que o volume legível permite.');
    const first = pages[0].items.find(item => item.str.includes('DENSE_LEFT_1_BEGIN'));
    assert(first && Math.abs(first.transform[4] - DENSE_LEFT) < 2, 'O fluxo não começou na primeira coluna.');
    const body = pages.flatMap(page => page.items).filter(item => /DENSE_(?:LEFT|RIGHT)_\d/.test(item.str));
    assert(body.some(item => Math.abs(item.transform[4] - DENSE_RIGHT) < 2), 'O fluxo não aproveitou a segunda coluna.');
    for (const item of body) {
      assert(Math.min(Math.abs(item.transform[4] - DENSE_LEFT), Math.abs(item.transform[4] - DENSE_RIGHT)) < 2, 'Parágrafo fora das colunas.');
      assert(Math.abs(Math.hypot(item.transform[2], item.transform[3]) - 9.5) < .1, 'O texto foi reduzido para caber na caixa original.');
    }
    assert(report.outputPages.length === translatedPdf.numPages && report.outputPages.every(page => page.sourcePages.includes(1)), 'Relatório de procedência incompleto.');
    const stress = { ...fixture.input, blocks: { ...fixture.input.blocks } };
    stress.blocks['dense-left-1'] = [{ type: 'text', text: fixture.input.blocks['dense-left-1'].map(run => run.type === 'text' ? run.text : '').join('') + ' Additional measurement and consistent material response.'.repeat(190) }];
    const stressBlob = await createStructuredPdf(stress), stressPdf = await read(stressBlob); loaded.push(stressPdf);
    await inspect(stressPdf); await render(stressPdf, element('stress'), .7); artifacts.set('dense-expanded.pdf', stressBlob);
    for (const [name, blob] of artifacts) {
      const link = document.createElement('a'), url = URL.createObjectURL(blob); urls.push(url); link.href = url; link.download = name; link.textContent = name; element('downloads').append(link);
    }
    assert(failures.length === 0, `Falhas assíncronas: ${failures.join('; ')}`);
    Object.assign(window, { denseLayoutReport: report });
    result.textContent = `OK: artigo com ${fixture.sourceWords} palavras e tradução ${Math.round((fixture.translatedWords / fixture.sourceWords - 1) * 100)}% maior em ${translatedPdf.numPages} páginas, duas colunas, corpo de 9,5 pontos e todos os trechos preservados.\nOK: expansão extrema em ${stressPdf.numPages} páginas, sem perda ou duplicação dos marcadores.\nAs prévias permitem conferir densidade, espaços, figura e legenda.`;
    result.dataset.status = 'passed';
  } catch (error) {
    result.textContent = `FALHA: ${error instanceof Error ? error.stack : String(error)}`; result.dataset.status = 'failed';
    // Leave the rendered PDFs visible even when a distribution assertion fails.
  } finally { await Promise.allSettled(loaded.map(pdf => pdf.destroy())); button.disabled = false; }
}
element('run').addEventListener('click', () => void run());
element('scenario').addEventListener('change', () => void run());
void run();
