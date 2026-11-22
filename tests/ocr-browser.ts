import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist';
import { analyzePdf, cropPdfRegion, rebuildDocument } from '../src/structured-analyze';
import { blockText, sha256, type TranslatedDocument } from '../src/structured-document';
import { createStructuredDocx, createStructuredPdf, validateStructuredSource } from '../src/structured-export';
import { OCR_ENGINE, type OcrBlock, type OcrResult } from '../src/ocr-contract';

const output = document.querySelector<HTMLElement>('#result')!;
const checks: string[] = [];
function report(message: string) { checks.push(message); output.textContent = checks.join('\n'); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function rejects(action: () => Promise<unknown>, message: RegExp) {
  try { await action(); } catch (error) { assert(error instanceof Error && message.test(error.message), String(error)); return; }
  throw new Error(`Era esperada a recusa: ${message}`);
}

const block = (type: string, x: number, y: number, width: number, height: number, content: string): OcrBlock =>
  ({ type, x, y, width, height, content, confidence: type === 'image' ? null : 97 });
const recognized: OcrResult = {
  model: OCR_ENGINE, usage: { pages: 1 }, page: { width: 1200, height: 1600, confidence: 96, blocks: [
    block('title', 80, 60, 1040, 60, '# Scientific scan in two columns'),
    block('text', 80, 180, 480, 130, 'Left paragraph first. The experiment measures pressure and temperature under controlled conditions.'),
    block('text', 80, 330, 480, 160, 'The measured mass obeys $E = mc^2$ under controlled conditions.'),
    block('image', 80, 560, 480, 240, ''),
    block('caption', 80, 810, 480, 50, 'Figure 1. Experimental measurements.'),
    // Native reading order finishes the left column before the right column,
    // even though this paragraph starts above the previous left-column blocks.
    block('text', 650, 180, 470, 180, 'Right paragraph last. The material retains every source image and its scientific meaning.'),
    block('table', 650, 450, 470, 180, '| Sample | Pressure |\n| A | 10 |'),
    block('equation', 650, 740, 470, 70, '$\\gamma = 2 \\cot(\\Phi/2)$'),
  ] },
};
const nativeRecognized: OcrResult = {
  model: OCR_ENGINE, usage: { pages: 1 }, page: { width: 1200, height: 1600, confidence: 98, blocks: [
    block('title', 80, 100, 1040, 50, '# OCR authoritative native page'),
    block('text', 80, 190, 1040, 100, 'OCR recognized this selectable PDF. Its authoritative result replaces the local embedded text.'),
  ] },
};

async function scannedPng() {
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1600;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111'; ctx.font = 'bold 36px Arial'; ctx.fillText('Scientific scan in two columns', 80, 105);
  ctx.font = '25px Arial';
  ['Left paragraph first.', 'The experiment measures pressure', 'and temperature under controlled conditions.']
    .forEach((text, index) => ctx.fillText(text, 80, 210 + index * 40));
  ctx.fillText('The measured mass obeys', 80, 365);
  ctx.font = '32px Times New Roman'; ctx.fillText('E = mc²', 80, 412);
  ctx.font = '25px Arial'; ctx.fillText('under controlled conditions.', 80, 462);
  ['Right paragraph last.', 'The material retains every source', 'image and its scientific meaning.']
    .forEach((text, index) => ctx.fillText(text, 650, 215 + index * 45));
  ctx.strokeStyle = '#111'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(110, 580); ctx.lineTo(110, 770); ctx.lineTo(530, 770); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(110, 760); ctx.lineTo(230, 720); ctx.lineTo(380, 640); ctx.lineTo(520, 590); ctx.stroke();
  ctx.font = '24px Arial'; ctx.fillText('Figure 1. Experimental measurements.', 80, 844);
  ctx.strokeRect(650, 450, 470, 180); ctx.beginPath();
  ctx.moveTo(650, 510); ctx.lineTo(1120, 510); ctx.moveTo(650, 570); ctx.lineTo(1120, 570);
  ctx.moveTo(880, 450); ctx.lineTo(880, 630); ctx.stroke();
  ctx.fillText('Sample', 675, 490); ctx.fillText('Pressure', 910, 490);
  ctx.fillText('A', 675, 550); ctx.fillText('10', 910, 550);
  ctx.fillText('B', 675, 610); ctx.fillText('20', 910, 610);
  ctx.font = '32px Times New Roman'; ctx.fillText('γ = 2 cot(Φ/2)', 680, 790);
  return canvas.toDataURL('image/png');
}

async function mixedFixture(): Promise<File> {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const native = pdf.addPage([600, 800]);
  native.drawText('Native digital page', { x: 40, y: 730, size: 17, font });
  native.drawText('LOCAL ONLY embedded text must not bypass OCR.', { x: 40, y: 690, size: 10, font });
  native.drawText('Methods and scientific observations are extracted directly from the original PDF.', { x: 40, y: 665, size: 10, font });
  const image = await pdf.embedPng(await scannedPng());
  pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  return new File([new Uint8Array(await pdf.save()).buffer], 'mixed-scientific-article.pdf', { type: 'application/pdf' });
}

const originalFetch = window.fetch.bind(window);
let ocrCalls = 0;
const sentPages: string[] = [];
let failNative = false;
let failScan = false;
window.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input), location.href);
  assert(target.origin === location.origin, `A verificação tentou acessar um serviço externo: ${target.origin}`);
  if (String(input) !== '/api/ocr' && target.pathname !== '/api/ocr') return originalFetch(input, init);
  ocrCalls++;
  assert(init?.method === 'POST', 'OCR precisa usar POST.');
  assert(new Headers(init.headers).get('Content-Type') === 'application/pdf', 'OCR precisa enviar PDF binário.');
  assert(new Headers(init.headers).get('X-Access-Code') === 'fixture-access', 'Código de acesso não chegou ao OCR.');
  assert(init.body instanceof ArrayBuffer, 'O corpo do OCR precisa ser binário.');
  const pdf = await PDFDocument.load(init.body);
  assert(pdf.getPageCount() === 1, 'Cada chamada OCR precisa enviar exatamente uma página.');
  const text = await getDocument({ data: new Uint8Array(init.body.slice(0)) }).promise;
  let native = false;
  try {
    const page = await text.getPage(1), content = await page.getTextContent();
    native = content.items.some(item => 'str' in item && item.str.includes('Native digital page'));
    const hasText = content.items.some(item => 'str' in item && item.str.trim());
    assert(native || !hasText, 'A página enviada ao OCR não corresponde à fixture esperada.');
  } finally { await text.destroy(); }
  sentPages.push(native ? 'native' : 'scan');
  if (native && failNative) return Response.json({ error: 'Falha de OCR simulada na página nativa.' }, { status: 429 });
  if (!native && failScan) return Response.json({ error: 'Falha de OCR simulada na página digitalizada.' }, { status: 503 });
  return Response.json(structuredClone(native ? nativeRecognized : recognized), { headers: { 'Cache-Control': 'no-store' } });
};

try {
  await rejects(() => analyzePdf(new File([new Uint8Array(7_000_001)], 'large.pdf'), () => {}), /7 MB/);
  const excessive = await PDFDocument.create();
  for (let index = 0; index < 51; index++) excessive.addPage([600, 800]);
  const excessiveBytes = new Uint8Array(await excessive.save()).buffer;
  await rejects(() => analyzePdf(new File([excessiveBytes], 'fifty-one.pdf'), () => {}), /50 páginas/);
  assert(Number(ocrCalls) === 0, 'OCR foi chamado antes da validação de limites.');
  report('PASS: limites de 7 MB e 50 páginas verificados antes de qualquer envio.');

  const file = await mixedFixture();
  const options = { code: 'fixture-access', ocrConfigured: true, ocrModel: OCR_ENGINE };
  await rejects(() => analyzePdf(file, () => {}, undefined, { ...options, ocrConfigured: false }), /serviço de reconhecimento de texto/);
  assert(Number(ocrCalls) === 0, 'Uma análise sem OCR configurado iniciou envio.');
  const nativePdf = await PDFDocument.create();
  const sourcePdf = await PDFDocument.load(await file.arrayBuffer());
  nativePdf.addPage((await nativePdf.copyPages(sourcePdf, [0]))[0]);
  nativePdf.addPage((await nativePdf.copyPages(sourcePdf, [1]))[0]);
  const nativeFile = new File([new Uint8Array(await nativePdf.save()).buffer], 'native-failure.pdf', { type: 'application/pdf' });
  failNative = true;
  const failed = await analyzePdf(nativeFile, () => {}, undefined, options);
  failNative = false;
  assert(failed.issues.some(i => i.id === 'ocr-failed-1' && i.severity === 'blocking'), 'Falha OCR de página nativa não bloqueou a análise.');
  assert(failed.issues.some(i => i.id === 'ocr-failed-2' && i.severity === 'blocking'), 'Página posterior à falha precisa permanecer pendente e bloqueada.');
  assert(!failed.blocks.some(b => /Native digital page|LOCAL ONLY/.test(blockText(b))), 'Falha OCR recuperou texto local como alternativa silenciosa.');
  assert(Number(ocrCalls) === 1, 'Falha OCR iniciou novas tentativas silenciosas.');
  ocrCalls = 0; sentPages.length = 0;
  report('PASS: OCR obrigatório; falta de configuração impede envio e falha no PDF nativo bloqueia sem extração local alternativa.');
  const manifest = await analyzePdf(file, message => { output.textContent = `${checks.join('\n')}\n${message}`; }, undefined, options);
  assert(ocrCalls === 2, `Esperadas duas chamadas OCR, obtidas ${ocrCalls}. ${JSON.stringify(manifest.issues)}`);
  assert(sentPages.join(',') === 'native,scan', `Nem todas as páginas foram enviadas em ordem: ${sentPages.join(',')}`);
  assert(manifest.pages.length === 2, 'PDF misto perdeu páginas.');
  assert(manifest.blocks.some(b => b.page === 1 && blockText(b).includes('OCR authoritative native page')), 'Resposta OCR da página nativa ausente.');
  assert(!manifest.blocks.some(b => /Native digital page|LOCAL ONLY/.test(blockText(b))), 'Texto nativo foi usado no lugar da resposta do OCR.');
  const scan = manifest.blocks.filter(b => b.page === 2), text = scan.map(blockText).join('\n');
  assert(text.indexOf('Left paragraph first') < text.indexOf('The measured mass obeys') &&
    text.indexOf('The measured mass obeys') < text.indexOf('Right paragraph last'), 'Ordem nativa de duas colunas foi alterada.');
  assert(scan.filter(b => ['paragraph', 'heading', 'caption'].includes(b.kind)).every(b => b.geometry === 'block'), 'OCR fabricou geometria por palavra.');
  assert(scan.find(b => b.id === 'p2-ocr-1')?.rect.x === 40, 'Escala de pixels OCR para pontos PDF incorreta.');
  assert(manifest.assets.some(a => a.kind === 'figure') && manifest.assets.some(a => a.kind === 'table') &&
    manifest.assets.some(a => a.kind === 'equation-block'), 'Figura, tabela ou equação ausente nos recortes.');
  assert(scan.find(b => b.kind === 'figure')?.captionId === 'p2-ocr-4', 'Legenda não foi associada à figura.');
  assert(manifest.issues.some(i => i.id === 'ocr-review-2') && manifest.issues.some(i => i.id === 'ocr-review-1'), 'Todas as páginas devem exigir revisão OCR.');
  assert(!manifest.issues.some(i => i.severity === 'blocking'),
    `Bloqueio inesperado: ${JSON.stringify(manifest.issues)}`);
  assert(manifest.issues.some(i => i.id === 'ocr-inline-math-p2-ocr-2' && i.severity === 'warning'), 'Fórmula inline não gerou aviso de revisão.');
  await validateStructuredSource(manifest);
  report('PASS: páginas nativas e digitalizadas passam pelo OCR; texto autoritativo, ordem de duas colunas e três recortes preservados.');
  report('PASS: fórmula inline gera somente aviso e permite validação para tradução sem recorte manual.');

  const repeated = await analyzePdf(file, () => {}, undefined, options);
  assert(ocrCalls === 2 && repeated.blocks.length === manifest.blocks.length, 'Retomada repetiu uma página já reconhecida.');
  const crop = await cropPdfRegion(file, 2, { x: 39, y: 186, width: 85, height: 28 }, 'equation-inline', 'manual-inline');
  const unlinked = rebuildDocument(manifest, [...manifest.assets, crop]);
  assert(unlinked.issues.some(i => i.id.startsWith('ocr-partial-') && i.severity === 'blocking'), 'Recorte parcial sem vínculo foi aceito silenciosamente.');
  crop.sourceText = { blockId: 'p2-ocr-2', text: '$E = mc^2$' };
  const reviewed = rebuildDocument(manifest, [...manifest.assets, crop]);
  assert(!reviewed.issues.some(i => i.severity === 'blocking'), `Vínculo correto manteve bloqueios: ${JSON.stringify(reviewed.issues)}`);
  const paragraph = reviewed.blocks.find(b => b.id === 'p2-ocr-2')!;
  assert(paragraph.runs.filter(r => r.type === 'asset').length === 1 &&
    blockText(paragraph).includes('The measured mass obeys') && blockText(paragraph).includes('under controlled conditions.') &&
    !blockText(paragraph).includes('mc^2'), 'Reconstrução perdeu prosa ou duplicou a fórmula.');
  assert(!reviewed.blocks.some(b => b.assetId === 'manual-inline'), 'Fórmula inline foi duplicada como bloco separado.');
  await validateStructuredSource(reviewed);
  const removed = rebuildDocument(reviewed, reviewed.assets.filter(a => a.id !== 'manual-inline'));
  assert(removed.issues.some(i => i.id === 'ocr-inline-math-p2-ocr-2' && i.severity === 'warning'), 'Remover recorte não restaurou o aviso da fórmula.');
  assert(!removed.issues.some(i => i.severity === 'blocking'), 'Remover recorte opcional voltou a bloquear a fórmula em texto.');
  report('PASS: retomada reutiliza OCR; vínculo de recorte preserva prosa e remove fórmula reconhecida sem duplicação.');

  const translated: TranslatedDocument = { document: reviewed, blocks: Object.fromEntries(reviewed.blocks.map(b => [b.id, b.runs])), sourceLanguage: 'EN', targetLanguage: 'EN-US' };
  const docx = await createStructuredDocx(translated), pdf = await createStructuredPdf(translated);
  const zip = await JSZip.loadAsync(await docx.arrayBuffer());
  const xml = await zip.file('word/document.xml')!.async('string');
  assert(xml.includes('Left paragraph first') && xml.includes('Right paragraph last') && !xml.includes('mc^2'), 'DOCX perdeu texto ou duplicou fórmula.');
  for (let index = 0; index < reviewed.assets.length; index++) {
    assert(await sha256(await zip.file(`word/media/preserved-${index + 1}.png`)!.async('uint8array')) === reviewed.assets[index].sha256,
      `PNG original alterado no DOCX: ${reviewed.assets[index].id}`);
  }
  const exported = await getDocument({ data: new Uint8Array(await pdf.arrayBuffer()) }).promise;
  let exportedText = '';
  try {
    for (let number = 1; number <= exported.numPages; number++) {
      const content = await (await exported.getPage(number)).getTextContent();
      exportedText += content.items.filter(i => 'str' in i).map(i => i.str).join(' ') + '\n';
    }
    assert(exportedText.includes('Left paragraph first') && exportedText.includes('Right paragraph last') &&
      !exportedText.includes('mc^2'), 'PDF perdeu texto selecionável ou duplicou fórmula.');
  } finally { await exported.destroy(); }
  const links = document.querySelector('#artifacts')!;
  for (const [name, blob] of [['ocr-fixture.docx', docx], ['ocr-fixture.pdf', pdf]] as const) {
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name;
    link.textContent = name; links.append(link, document.createTextNode(' '));
  }
  report(`PASS: DOCX/PDF exportados com texto editável/selecionável e ${reviewed.assets.length} imagens originais preservadas.`);

  const partialFile = new File([await file.arrayBuffer()], 'partial-failure.pdf', { type: 'application/pdf' });
  const callsBeforeFailure = ocrCalls;
  failScan = true;
  const partial = await analyzePdf(partialFile, () => {}, undefined, options);
  failScan = false;
  assert(partial.issues.some(i => i.id === 'ocr-failed-2' && i.severity === 'blocking'), 'Falha na segunda página não foi bloqueada.');
  assert(partial.blocks.some(b => b.page === 1 && blockText(b).includes('OCR authoritative native page')), 'Falha posterior perdeu a primeira página reconhecida.');
  const resumed = await analyzePdf(partialFile, () => {}, undefined, options);
  assert(ocrCalls === callsBeforeFailure + 3, 'Retomada reenviou a primeira página já concluída ou repetiu automaticamente a falha.');
  assert(!resumed.issues.some(i => i.id.startsWith('ocr-failed-')), 'Retomada concluída manteve falhas de OCR antigas.');
  report('PASS: falha interrompe novos envios; retomada repete apenas a página pendente e preserva as páginas já reconhecidas.');
  report('PASS: integração completa com OCR simulado; nenhuma API paga foi utilizada.');
  output.dataset.status = 'passed'; document.body.dataset.result = 'pass';
} catch (error) {
  report(`FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  output.dataset.status = 'failed'; document.body.dataset.result = 'fail';
} finally { window.fetch = originalFetch; }
