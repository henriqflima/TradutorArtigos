import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createStructuredPdf } from '../src/structured-export';
import { appearanceForBlock, nativeTextSpans } from '../src/pdf-appearance';
import type { PdfLayoutReport } from '../src/pdf-layout';
import type { SourceRect, TranslatedDocument } from '../src/structured-document';

// This fixture contains no provider calls. Real article data lives only under
// ignored tmp/, prepared by tmp/pdfs/continuous/prepare_fixture.py.
GlobalWorkerOptions.workerSrc = workerUrl;
const BASE = '/tmp/pdfs/continuous/';
const element = (id: string) => document.getElementById(id)!;
const urls: string[] = [];
let artifact: Blob | undefined;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function words(text: string) { return text.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []; }
function frequencies(tokens: string[]) {
  const result = new Map<string, number>();
  for (const token of tokens) result.set(token, (result.get(token) || 0) + 1);
  return result;
}
function metric(value: number | string, label: string) {
  const card = document.createElement('div'), number = document.createElement('strong'), caption = document.createElement('span');
  card.className = 'metric'; number.textContent = String(value); caption.textContent = label; card.append(number, caption); element('metrics').append(card);
}
async function loadPdf(path: string) { return getDocument({ data: new Uint8Array(await (await fetch(path)).arrayBuffer()) }).promise; }
async function render(pdf: PDFDocumentProxy, target: string) {
  const host = element(target); host.replaceChildren();
  for (let number = 1; number <= pdf.numPages; number++) {
    const paper = document.createElement('div'), caption = document.createElement('p'), canvas = document.createElement('canvas');
    paper.className = 'paper'; caption.textContent = `Página ${number} de ${pdf.numPages}`; paper.append(caption, canvas); host.append(paper);
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
  }
}
const multiply = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
async function inspect(pdf: PDFDocumentProxy) {
  const pages: { page: number; text: string; textItems: number; images: number; minFont: number; occupiedBottom: number; collisions: { a: SourceRect; b: SourceRect }[] }[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent(), operators = await page.getOperatorList();
    const items = content.items.filter((item): item is TextItem => 'str' in item && Boolean(item.str.trim()));
    const boxes: SourceRect[] = items.map(item => ({ x: item.transform[4], y: viewport.height - item.transform[5] - item.height * .8, width: item.width, height: item.height }));
    let matrix = [1, 0, 0, 1, 0, 0], images = 0; const stack: number[][] = [];
    operators.fnArray.forEach((fn, index) => {
      if (fn === OPS.save) stack.push([...matrix]);
      else if (fn === OPS.restore) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) matrix = multiply(matrix, operators.argsArray[index] as number[]);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        images++;
        boxes.push({ x: matrix[4], y: viewport.height - matrix[5] - matrix[3], width: Math.abs(matrix[0]), height: Math.abs(matrix[3]) });
      }
    });
    for (const box of boxes) assert(box.x >= -.5 && box.y >= -.5 && box.x + box.width <= viewport.width + .5 && box.y + box.height <= viewport.height + .5, `Objeto fora dos limites na página ${number}.`);
    const collisions: { a: SourceRect; b: SourceRect }[] = [];
    for (let index = 0; index < boxes.length; index++) for (const b of boxes.slice(index + 1)) {
      const a = boxes[index], dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (dx > .8 && dy > 1) collisions.push({ a, b });
    }
    pages.push({ page: number, text: items.map(item => item.str).join(' '), textItems: items.length, images, minFont: items.length ? Math.min(...items.map(item => item.height)) : 0,
      occupiedBottom: boxes.length ? Math.max(...boxes.map(box => box.y + box.height)) : 0, collisions });
  }
  return pages;
}
Object.assign(window, { continuousArticleArtifactBase64: async () => {
  assert(artifact, 'O PDF ainda não foi gerado.');
  const bytes = new Uint8Array(await artifact.arrayBuffer()); let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
} });
async function run() {
  const status = element('result'), button = element('run') as HTMLButtonElement, loaded: PDFDocumentProxy[] = [];
  button.disabled = true; status.dataset.status = 'running'; status.textContent = 'Abrindo análise e tradução armazenadas…';
  urls.splice(0).forEach(URL.revokeObjectURL); element('metrics').replaceChildren(); element('downloads').replaceChildren();
  try {
    const response = await fetch(BASE + 'fixture.json');
    assert(response.ok, 'Fixture local ausente. Execute tmp/pdfs/continuous/prepare_fixture.py antes deste ensaio.');
    const input = await response.json() as TranslatedDocument;
    for (const asset of input.document.assets) {
      const binary = atob(asset.png as unknown as string);
      asset.png = Uint8Array.from(binary, char => char.charCodeAt(0));
    }
    const original = await loadPdf(BASE + 'original.pdf'), previous = await loadPdf(BASE + 'previous.pdf'); loaded.push(original, previous);
    // Enrich only native appearance with the same public helpers used by the
    // current extraction. Original/translated runs and reading order stay intact.
    for (let number = 1; number <= original.numPages; number++) {
      const page = await original.getPage(number), viewport = page.getViewport({ scale: 1 });
      const spans = nativeTextSpans(await page.getTextContent(), viewport);
      for (const block of input.document.blocks.filter(block => block.page === number)) block.appearance ??= appearanceForBlock(block, spans, viewport.width);
    }
    let report: PdfLayoutReport | undefined;
    artifact = await createStructuredPdf(input, message => { status.textContent = message; }, undefined, value => { report = value; });
    const translated = await getDocument({ data: new Uint8Array(await artifact.arrayBuffer()) }).promise; loaded.push(translated);
    const pages = await inspect(translated);
    const expected = frequencies(input.document.blocks.filter(block => !/^(?:header|footer|page_number)$/u.test(block.sourceRole || '')).flatMap(block => words((input.blocks[block.id] || block.runs).map(run => run.type === 'text' ? run.text : ' ').join(''))));
    const actual = frequencies(words(pages.map(page => page.text).join(' ')));
    const differences = [...new Set([...expected.keys(), ...actual.keys()])].filter(token => expected.get(token) !== actual.get(token)).map(token => ({ token, expected: expected.get(token) || 0, actual: actual.get(token) || 0 }));
    // Captions may move with figures, while prose must keep its reviewed order.
    // Check distinctive paragraph openings independently from frequency totals.
    const outputWords = words(pages.map(page => page.text).join(' '));
    const signatures = input.document.blocks.filter(block => block.kind === 'paragraph' && !/^(?:header|footer|page_number)$/u.test(block.sourceRole || '')).flatMap(block => {
      const tokens = words((input.blocks[block.id] || block.runs).map(run => run.type === 'text' ? run.text : ' ').join(''));
      if (tokens.length < 12) return [];
      const signature = tokens.slice(0, 8);
      const matches = outputWords.map((_token, index) => index).filter(index => signature.every((token, offset) => outputWords[index + offset] === token));
      return [{ id: block.id, matches }];
    });
    const missingSignatures = signatures.filter(signature => signature.matches.length === 0).map(signature => signature.id);
    const uniquePositions = signatures.filter(signature => signature.matches.length === 1).map(signature => ({ id: signature.id, index: signature.matches[0] }));
    const outOfOrder = uniquePositions.filter((position, index) => index > 0 && position.index < uniquePositions[index - 1].index).map(position => position.id);
    const assets = new Map(input.document.assets.map(asset => [asset.id, asset]));
    const expectedImages = input.document.blocks.filter(block => !/^(?:header|footer|page_number)$/u.test(block.sourceRole || '')).reduce((count, block) => count + (block.assetId ? 1 : (input.blocks[block.id] || block.runs).filter(run => run.type === 'asset' && assets.has(run.assetId)).length), 0);
    const imageCount = pages.reduce((count, page) => count + page.images, 0), collisionCount = pages.reduce((count, page) => count + page.collisions.length, 0);
    const summary = { sourcePages: original.numPages, previousPages: previous.numPages, outputPages: translated.numPages, sourceBlocks: input.document.blocks.length, assetDefinitions: input.document.assets.length,
      expectedWords: [...expected.values()].reduce((a, b) => a + b, 0), actualWords: [...actual.values()].reduce((a, b) => a + b, 0), wordDifferences: differences, expectedImages, imageCount, collisionCount, report,
      paragraphOpeningsChecked: signatures.length, missingSignatures, outOfOrder,
      pages: pages.map(({ text, ...page }) => ({ ...page, textCharacters: text.length })) };
    Object.assign(window, { continuousArticleSummary: summary });
    metric(original.numPages, 'páginas originais'); metric(previous.numPages, 'páginas no PDF anterior'); metric(translated.numPages, 'páginas na nova montagem'); metric(imageCount, 'objetos visuais desenhados');
    const link = document.createElement('a'), url = URL.createObjectURL(artifact); urls.push(url);
    link.href = url; link.download = 'artigo-fluxo-continuo.pdf'; link.textContent = 'Baixar nova montagem'; element('downloads').append(link);
    await render(translated, 'translated'); await render(original, 'original'); await render(previous, 'previous');
    assert(differences.length === 0, `Diferenças no texto extraído (${differences.length}): ${JSON.stringify(differences.slice(0, 12))}`);
    assert(missingSignatures.length === 0 && outOfOrder.length === 0, `Sequência dos parágrafos: aberturas ausentes ${missingSignatures.join(', ')}; fora de ordem ${outOfOrder.join(', ')}.`);
    assert(imageCount === expectedImages, `Objetos visuais: esperados ${expectedImages}, desenhados ${imageCount}.`);
    assert(collisionCount === 0, `${collisionCount} colisões de caixas visuais/texto detectadas.`);
    assert(report, 'Relatório de montagem ausente.');
    assert(translated.numPages < previous.numPages, 'O artigo de referência ainda ocupa tantas páginas quanto a montagem anterior.');
    assert(report.outputPages.some(page => page.sourcePages.length > 1), 'Nenhuma página reúne conteúdo de origens diferentes.');
    for (const source of report.pages) for (const destination of source.outputPages) assert(report.outputPages.find(page => page.outputPage === destination)?.sourcePages.includes(source.sourcePage), 'Mapeamento origem/destino inconsistente.');
    for (const destination of report.outputPages) for (const source of destination.sourcePages) assert(report.pages.find(page => page.sourcePage === source)?.outputPages.includes(destination.outputPage), 'Mapeamento destino/origem inconsistente.');
    status.dataset.status = 'passed';
    status.textContent = `OK: ${input.document.blocks.length} blocos reais, texto completo sem perdas/duplicações por contagem de palavras, ${imageCount} objetos visuais, sem colisões ou saída dos limites.\nOriginal: ${original.numPages} páginas. PDF anterior: ${previous.numPages}. Nova montagem: ${translated.numPages}.\nConferir visualmente todas as páginas; este ensaio usa um manifest de diagnóstico anterior ao fluxo atual de OCR.`;
  } catch (error) {
    status.dataset.status = 'failed'; status.textContent = error instanceof Error ? error.stack || error.message : String(error);
  } finally { await Promise.allSettled(loaded.map(pdf => pdf.destroy())); button.disabled = false; }
}
element('run').addEventListener('click', () => void run());
void run();
