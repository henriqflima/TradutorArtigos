import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import App from '../src/App';
import { TRANSLATION_MODEL } from '../src/shared';
import type { OcrResult } from '../src/ocr-contract';
import type { SummaryEvidence, SummarySource } from '../src/summary-contract';
import '../src/styles.css';
import '../src/plain-text.css';

const parameters = new URLSearchParams(location.search);
const scenario = parameters.get('scenario') || 'complete';
const output = document.getElementById('summary-fixture-result')!;
const fixtureText = [
  ['Objective and methods', 'We compared two concentrations using n = 30 samples in each group.', 'The measurements used a spectrometer calibrated at 20 degrees C.'],
  ['Results and conclusions', 'The measured mean was 1.230 +/- 0.040 mg/L; p = 0.08.', 'The authors concluded the observed difference was not statistically significant.'],
];
const recognition = (number: number): OcrResult => ({ model: 'mistral-ocr-fixture', usage: { pages: 1 }, page: {
  width: 600, height: 800, confidence: 99,
  blocks: [
    ...fixtureText[number - 1].map((content, index) => ({ type: index === 0 ? 'title' : 'text', content,
      x: 40, y: 40 + index * 50, width: 520, height: 40, confidence: 99 })),
    ...(number === 2 ? [
      { type: 'table', content: '| Dose (mg/L) | Mean ± SD |\n| 0.05 | 1.230 ± 0.040 |\n| 0.10 | 1.240 ± 0.050 |', x: 40, y: 280, width: 520, height: 110, confidence: 99 },
      { type: 'image', content: '', x: 40, y: 430, width: 300, height: 200, confidence: null },
      { type: 'caption', content: 'Figure 1. The two measured groups overlap; n = 30 in each group.', x: 40, y: 640, width: 520, height: 40, confidence: 99 },
    ] : []),
  ],
} });
type BrowserData = { scenario: string; requests: string[]; ocrCalls: number; evidenceCalls: number; composeCalls: number; explainCalls: number;
  translationCalls: number; assertions: string[]; errors: string[]; done: boolean };
declare global {
  interface Window { summaryUiReady: Promise<BrowserData>; summaryUiData: BrowserData; summaryUiFile: File; }
}
const data: BrowserData = { scenario, requests: [], ocrCalls: 0, evidenceCalls: 0, composeCalls: 0, explainCalls: 0,
  translationCalls: 0, assertions: [], errors: [], done: false };
window.summaryUiData = data;
const previousFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (!url.pathname.startsWith('/api/')) return previousFetch(input, init);
  data.requests.push(url.pathname);
  if (url.pathname === '/api/config') return Response.json({ configured: true, accessRequired: false, provider: 'openai', model: TRANSLATION_MODEL,
    ocr: { configured: true, provider: 'mistral', model: 'mistral-ocr-fixture' } });
  if (url.pathname === '/api/summary-config') return Response.json({ configured: true, ocrConfigured: true,
    accessRequired: false, model: 'gpt-6.1-terra', ocrModel: 'mistral-ocr-fixture' });
  if (!url.pathname.startsWith('/api/summary-')) { data.translationCalls++; throw new Error(`O resumo chamou uma API de tradução: ${url.pathname}`); }
  if (url.pathname === '/api/summary-ocr') {
    data.ocrCalls++;
    if (!(init?.body instanceof ArrayBuffer)) throw new Error('O OCR do resumo deve receber uma página PDF binária.');
    const pdf = await PDFDocument.load(init.body);
    if (pdf.getPageCount() !== 1) throw new Error('Mais de uma página foi enviada ao OCR.');
    return Response.json(recognition(data.ocrCalls));
  }
  const body = JSON.parse(String(init?.body));
  if (url.pathname === '/api/summary-evidence') {
    data.evidenceCalls++;
    if (!body.image?.startsWith('data:image/jpeg;base64,')) throw new Error('A análise visual não recebeu a imagem real da página.');
    const sources = body.sources as SummarySource[];
    const evidence: SummaryEvidence[] = sources.map((source, index) => ({ id: `mock-e${index}`,
      section: source.kind === 'table' || source.kind === 'figure' || source.page === 2 ? 'results' : index === 0 ? 'objective' : 'methodology',
      statement: source.kind === 'figure' ? 'As séries do gráfico apresentam sobreposição.' : source.text,
      sourceIds: [source.id], quotes: source.text ? [source.text] : [],
      values: source.kind === 'table' ? ['1.230 ± 0.040 mg/L', '1.240 ± 0.050 mg/L'] : [],
      caveats: source.kind === 'figure' ? ['A interpretação do gráfico é visual; valores exatos constam na tabela.'] : [],
      origin: 'study', certainty: source.kind === 'figure' ? 'approximate' : 'reported',
    }));
    return Response.json({ evidence, concepts: ['Desvio padrão'], warnings: [] });
  }
  if (url.pathname === '/api/summary-compose') {
    data.composeCalls++;
    const text: Record<string, string> = {
      objective: 'O estudo comparou duas concentrações para verificar possíveis diferenças nas medidas.',
      technical: 'A comparação usa a média e o desvio padrão para descrever os grupos analisados.',
      methodology: 'Foram analisadas 30 amostras por grupo com um espectrômetro calibrado a 20 °C.',
      results: 'Os autores observaram 1.230 ± 0.040 mg/L e 1.240 ± 0.050 mg/L. Com p = 0.08, a diferença não foi estatisticamente significativa nas condições estudadas.',
    };
    const evidence = body.evidence as SummaryEvidence[];
    const chosen = evidence.find(item => item.section === body.section) || evidence[0];
    return Response.json({ key: body.section, paragraphs: [{ text: text[body.section], evidenceIds: [chosen.id] }], missing: [] });
  }
  if (url.pathname === '/api/summary-explain') {
    data.explainCalls++;
    if (scenario === 'comments-failure') return Response.json({ error: 'Falha simulada na pesquisa complementar.' }, { status: 502 });
    return Response.json({ comments: [{ concept: 'Desvio padrão', explanation: 'O desvio padrão descreve quanto as medidas se espalham ao redor da média.',
      sources: [{ title: 'Fonte acadêmica de exemplo para o teste', url: 'https://example.edu/statistics' }] }] });
  }
  throw new Error(`API desconhecida: ${url.pathname}`);
};

async function buildFile() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index++) {
    const page = pdf.addPage([600, 800]);
    fixtureText[index].forEach((text, line) => page.drawText(text, { x: 40, y: 750 - line * 50, size: 11, font, maxWidth: 520 }));
    if (index === 1) {
      for (let row = 0; row < 4; row++) page.drawLine({ start: { x: 40, y: 520 - row * 28 }, end: { x: 560, y: 520 - row * 28 }, color: rgb(.2,.2,.2) });
      ['Dose (mg/L)              Mean +/- SD', '0.05                          1.230 +/- 0.040', '0.10                          1.240 +/- 0.050'].forEach((text, row) =>
        page.drawText(text, { x: 50, y: 500 - row * 28, size: 11, font }));
      page.drawLine({ start: { x: 60, y: 180 }, end: { x: 60, y: 350 }, color: rgb(.2,.2,.2) });
      page.drawLine({ start: { x: 60, y: 180 }, end: { x: 320, y: 180 }, color: rgb(.2,.2,.2) });
      for (let point = 0; point < 6; point++) page.drawCircle({ x: 90 + point * 35, y: 240 + (point % 2) * 8, size: 4, color: rgb(.2,.5,.3) });
      page.drawText('Figure 1. Groups overlap; n = 30 per group.', { x: 40, y: 150, size: 11, font });
    }
  }
  return new File([new Uint8Array(await pdf.save()).buffer], 'summary-evidence-fixture.pdf', { type: 'application/pdf' });
}
const delay = (ms = 35) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor<T>(read: () => T | false | null | undefined, label: string, timeout = 65_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = read(); if (result) return result; await delay(); }
  throw new Error(`Tempo excedido: ${label}`);
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text); }
function assert(condition: unknown, text: string) { if (!condition) throw new Error(text); data.assertions.push(text); }
async function loadFile() {
  (await waitFor(() => button('Resumir artigo'), 'navegação de resumo')).click();
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('#summary-file'), 'entrada do resumo');
  const transfer = new DataTransfer(); transfer.items.add(window.summaryUiFile); input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
document.getElementById('summary-fixture-load')!.addEventListener('click', () => { void loadFile(); });
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);

window.summaryUiReady = (async () => {
  window.summaryUiFile = await buildFile();
  output.textContent = 'PDF pronto. Clique em “Carregar PDF de teste”. Use ?auto=1 para executar a verificação automática.';
  if (parameters.get('auto') !== '1') return data;
  try {
    await loadFile();
    const extract = await waitFor(() => { const b = button('Extrair dados do artigo'); return b && !b.disabled ? b : null; }, 'extração disponível');
    extract.click();
    await waitFor(() => { const b = button('Gerar resumo completo'); return b && !b.disabled ? b : null; }, 'evidências analisadas');
    assert(data.ocrCalls === 2, 'As duas páginas foram reconhecidas por endpoints próprios.');
    assert(data.evidenceCalls === 2, 'As duas páginas tiveram leitura de evidências e imagem.');
    assert(document.querySelectorAll('.summary-page-preview img').length === 1, 'A prévia do original está disponível para conferência.');

    const textarea = document.querySelector<HTMLTextAreaElement>('.summary-page-data textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, `${textarea.value}\nHuman-reviewed correction.`);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    (await waitFor(() => button('Salvar correção'), 'correção editável')).click();
    await delay();
    assert(button('Gerar resumo completo')?.disabled, 'A correção invalida a análise antes da geração.');
    (await waitFor(() => button('Atualizar / retomar extração'), 'retomada da extração')).click();
    await waitFor(() => { const b = button('Gerar resumo completo'); return b && !b.disabled ? b : null; }, 'evidências atualizadas');
    assert(data.ocrCalls === 2, 'A correção reaproveita OCR e atualiza somente as evidências necessárias.');
    assert(data.evidenceCalls === 3, 'Somente a página corrigida teve evidências reanalisadas.');
    button('Gerar resumo completo')!.click();
    await waitFor(() => data.composeCalls === 4 && document.querySelectorAll('.summary-result-paragraph').length === 4, 'quatro partes do resumo');
    await waitFor(() => scenario === 'comments-failure' ? !!document.querySelector('.summary-workspace .error-notice') : !!document.querySelector('.summary-comments'), 'comentários ou falha preservada');
    assert(document.querySelectorAll('.summary-result-part').length === 4, 'O resumo apresenta quatro partes com resultados e conclusões.');
    assert(document.querySelector('.summary-result-priority')?.textContent?.includes('p = 0.08'), 'Os resultados preservam valores e a interpretação sem significância.');
    if (scenario === 'comments-failure') assert(document.querySelectorAll('.summary-result-paragraph').length === 4, 'Uma falha na pesquisa mantém as quatro partes já geradas.');
    else assert(document.querySelector('.summary-comments a')?.getAttribute('href') === 'https://example.edu/statistics', 'O comentário explicativo exibe fonte clicável.');
    const citation = document.querySelector<HTMLButtonElement>('.summary-result-paragraph .summary-citations button')!;
    citation.click();
    await waitFor(() => document.querySelector('.summary-evidence.summary-source-active'), 'referência de evidência');
    assert(true, 'A referência do resumo abre a evidência correspondente.');
    document.querySelector<HTMLButtonElement>('.summary-evidence.summary-source-active .summary-citations button')!.click();
    await waitFor(() => document.querySelector('.summary-source.summary-source-active'), 'origem da evidência');
    assert(true, 'A evidência permite acessar seu trecho original.');
    button('Traduzir PDF')!.click(); await delay(); button('Resumir artigo')!.click(); await delay();
    assert(document.querySelectorAll('.summary-result-paragraph').length === 4, 'A navegação preserva a sessão independente do resumo.');
    assert(data.translationCalls === 0 && !data.requests.includes('/api/ocr'), 'Nenhum processamento de tradução foi usado pelo resumo.');
    data.done = true;
    output.textContent = `PASSOU: ${data.assertions.length} verificações.\n${data.assertions.join('\n')}`;
  } catch (error) {
    data.errors.push(error instanceof Error ? error.message : String(error));
    output.textContent = `FALHOU: ${data.errors.join('\n')}\n${data.assertions.join('\n')}`;
  }
  return data;
})();
