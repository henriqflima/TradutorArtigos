import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist';
import { analyzePdf, rebuildDocument } from '../src/structured-analyze';
import { blockText } from '../src/structured-document';
import { validateStructuredSource } from '../src/structured-export';
import { OCR_ENGINE, type OcrBlock, type OcrResult } from '../src/ocr-contract';

const result = document.querySelector<HTMLElement>('#result')!;
const checks: string[] = [];
const options = { ocrConfigured: true, code: 'fixture-access', ocrModel: OCR_ENGINE };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejects(action: () => Promise<unknown>, expected: RegExp) {
  try { await action(); } catch (error) { assert(error instanceof Error && expected.test(error.message), String(error)); return; }
  throw new Error(`Esperada recusa: ${expected}`);
}
const region = (type: string, x: number, y: number, width: number, height: number, content: string): OcrBlock =>
  ({ type, x, y, width, height, content, confidence: type === 'image' ? null : 98 });
function response(page: number): OcrResult {
  const blocks = page === 2 ? [
    region('text', 40, 50, 220, 90, 'OCR left column begins and finishes before the right column.'),
    region('image', 40, 340, 220, 140, ''),
    region('caption', 40, 485, 220, 25, 'Figure 1. Original experimental graph.'),
    region('text', 330, 50, 220, 90, 'OCR right column follows every region of the left column.'),
    region('table', 330, 540, 200, 140, '| A | B |'),
    region('equation', 330, 400, 200, 50, '$$E = mc^2$$'),
  ] : page === 3 ? [region('title', 40, 60, 300, 25, 'Short OCR title')] : [
    region('title', 40, 60, 520, 25, `OCR authoritative page ${page}`),
    region('text', 40, 110, 520, 70, `Recognized source for page ${page}. Native PDF text is not used as an alternate extraction engine.`),
  ];
  return { model: OCR_ENGINE, usage: { pages: 1 }, page: { width: 600, height: 780, confidence: 98, blocks } };
}
async function nativeFixture(count: number) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= count; number++) {
    const page = pdf.addPage([600, 780]);
    page.drawText(`LOCAL-PAGE-${number}`, { x: 40, y: 710, size: 14, font });
    page.drawText('LOCAL ONLY selectable prose must not bypass mandatory OCR.', { x: 40, y: 680, size: 10, font });
    if (number === 2) {
      page.drawRectangle({ x: 40, y: 300, width: 220, height: 140, borderWidth: 1 });
      page.drawLine({ start: { x: 60, y: 320 }, end: { x: 235, y: 420 }, thickness: 3 });
      page.drawText('Figure 1. Original experimental graph.', { x: 40, y: 280, size: 9, font });
      page.drawText('E = mc2', { x: 350, y: 350, size: 18, font });
      page.drawRectangle({ x: 330, y: 100, width: 200, height: 140, borderWidth: 1 });
      page.drawText('A   B', { x: 345, y: 215, size: 12, font });
    }
  }
  return pdf;
}
const fileFor = async (pdf: PDFDocument, name: string) => new File([new Uint8Array(await pdf.save()).buffer], name, { type: 'application/pdf' });
const fetchOriginal = window.fetch.bind(window);
const calls: number[] = [];
let failPage: number | undefined;
window.fetch = async (input, init) => {
  if (String(input) !== '/api/ocr') return fetchOriginal(input, init);
  assert(init?.body instanceof ArrayBuffer, 'O OCR precisa receber um corpo PDF binário.');
  assert(new Headers(init.headers).get('X-Access-Code') === 'fixture-access', 'Código de acesso ausente.');
  const sent = await getDocument({ data: new Uint8Array(init.body.slice(0)) }).promise;
  let number = 0;
  try {
    assert(sent.numPages === 1, 'Cada chamada deve conter exatamente uma página.');
    const content = await (await sent.getPage(1)).getTextContent();
    const local = content.items.filter(item => 'str' in item).map(item => item.str).join(' ');
    number = Number(local.match(/LOCAL-PAGE-(\d+)/)?.[1]);
    assert(number > 0, 'A página nativa não chegou ao servidor simulado.');
  } finally { await sent.destroy(); }
  calls.push(number);
  if (number === failPage) return Response.json({ error: 'OCR indisponível na página de teste.' }, { status: 503 });
  return Response.json(response(number));
};

try {
  await rejects(() => analyzePdf(new File([new Uint8Array(7_000_001)], 'large.pdf'), () => {}, undefined, options), /7 MB/);
  await rejects(() => analyzePdf(new File(['not a PDF'], 'invalid.pdf'), () => {}, undefined, options), /PDF válido/);
  const excessive = await fileFor(await nativeFixture(51), 'fifty-one.pdf');
  await rejects(() => analyzePdf(excessive, () => {}, undefined, options), /50 páginas/);
  const lateRotation = await nativeFixture(2); lateRotation.getPage(1).setRotation(degrees(90));
  const rotated = await fileFor(lateRotation, 'rotated-last-page.pdf');
  await rejects(() => analyzePdf(rotated, () => {}, undefined, options), /90|270|rotação/);
  const lateSize = await nativeFixture(2); lateSize.getPage(1).setSize(3100, 780);
  const oversized = await fileFor(lateSize, 'oversized-last-page.pdf');
  await rejects(() => analyzePdf(oversized, () => {}, undefined, options), /dimensões/);
  const source = await fileFor(await nativeFixture(3), 'universal-ocr.pdf');
  await rejects(() => analyzePdf(source, () => {}, undefined, { ...options, ocrConfigured: false }), /serviço de reconhecimento de texto/);
  assert(calls.length === 0, 'A pré-validação deve terminar antes de qualquer chamada OCR.');
  checks.push('7 MB, assinatura, 50 páginas, rotação e dimensões de todas as páginas: validados antes de enviar.');

  const analyzed = await analyzePdf(source, () => {}, undefined, options);
  assert(calls.join(',') === '1,2,3', `Páginas nativas não passaram todas pelo OCR: ${calls.join(',')}`);
  const nativeAppearance = analyzed.blocks.find(block => block.appearance?.confidence === 'native');
  assert(nativeAppearance?.appearance?.fontSize === 14, 'A fonte nativa não complementou a aparência do bloco OCR.');
  const rebuilt = rebuildDocument(analyzed, [...analyzed.assets]);
  assert(JSON.stringify(rebuilt.blocks.find(block => block.id === nativeAppearance.id)?.appearance) === JSON.stringify(nativeAppearance.appearance), 'Reconstruir recortes perdeu a tipografia nativa.');
  assert(rebuilt.blocks.find(block => block.id === nativeAppearance.id)?.sourceRole === nativeAppearance.sourceRole, 'Reconstruir recortes perdeu o papel original do bloco.');
  const text = analyzed.blocks.map(blockText).join('\n');
  assert(text.includes('OCR authoritative page 1') && !/LOCAL-PAGE|LOCAL ONLY/.test(text), 'O texto local sobrepôs a resposta do OCR.');
  assert(analyzed.blocks.some(block => blockText(block) === 'Short OCR title'), 'Texto OCR curto foi omitido ou convertido em imagem.');
  const second = analyzed.blocks.filter(block => block.page === 2);
  assert(second.findIndex(block => blockText(block).startsWith('OCR left')) < second.findIndex(block => blockText(block).startsWith('OCR right')), 'Ordem do OCR das colunas foi alterada.');
  assert(second.find(block => block.kind === 'figure')?.captionId === 'p2-ocr-2', 'Legenda reconhecida não foi associada.');
  assert(analyzed.assets.map(asset => asset.kind).sort().join(',') === 'equation-block,figure,table', 'Regiões visuais reconhecidas não foram preservadas.');
  for (const asset of analyzed.assets) {
    assert(asset.png.length > 100 && asset.rect.x >= 0 && asset.rect.y >= 0, `Recorte inválido: ${asset.id}`);
  }
  await validateStructuredSource(analyzed);
  checks.push('Todas as páginas nativas usam exclusivamente blocos do OCR; título curto, colunas, figura, tabela, equação e legenda preservados.');

  await analyzePdf(source, () => {}, undefined, options);
  assert(Number(calls.length) === 3, 'Reanalisar repetiu chamadas OCR já concluídas na sessão.');
  const fifty = await analyzePdf(await fileFor(await nativeFixture(50), 'fifty.pdf'), () => {}, undefined, options);
  assert(fifty.pages.length === 50 && Number(calls.length) === 53 && calls.at(-1) === 50, 'O limite de 50 páginas não processou todas as páginas.');
  checks.push('Retomada reaproveita páginas concluídas; PDF no limite exato de 50 páginas processa todas.');

  const resourceHeavy = await nativeFixture(1);
  resourceHeavy.context.register(resourceHeavy.context.stream(new Uint8Array(6_000_000)));
  const largeSource = await fileFor(resourceHeavy, 'large-valid.pdf');
  assert(largeSource.size > 4_000_000 && largeSource.size <= 7_000_000, 'A fixture deve ultrapassar o antigo limite sem ultrapassar o novo.');
  const largeAnalyzed = await analyzePdf(largeSource, () => {}, undefined, options);
  assert(largeAnalyzed.pages.length === 1 && Number(calls.length) === 54, 'O arquivo maior que 4 MB não foi reconhecido pela sua página isolada.');
  checks.push('PDF válido maior que 4 MB e menor que 7 MB é aceito e enviado como página isolada.');

  failPage = 1;
  const failed = await analyzePdf(await fileFor(await nativeFixture(1), 'failed-native.pdf'), () => {}, undefined, options);
  assert(failed.issues.some(issue => issue.id === 'ocr-failed-1' && issue.severity === 'blocking'), 'Falha OCR nativa não bloqueou confirmação.');
  assert(!failed.blocks.some(block => /LOCAL-PAGE|LOCAL ONLY/.test(blockText(block))), 'Falha OCR resultou em fallback local.');
  checks.push('Falha do OCR em PDF selecionável bloqueia a análise sem usar texto nativo como alternativa.');
  result.dataset.status = 'passed'; result.textContent = checks.map(check => 'OK: ' + check).join('\n');
} catch (error) {
  result.dataset.status = 'failed'; result.textContent = `${checks.join('\n')}\nFALHA: ${error instanceof Error ? error.stack : String(error)}`;
} finally { window.fetch = fetchOriginal; }
