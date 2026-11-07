import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createStructuredPdf } from '../src/structured-export';
import type { PdfLayoutReport } from '../src/pdf-layout';
import { sha256, type ContentRun, type DocumentAsset, type DocumentBlock, type SourceRect, type TranslatedDocument } from '../src/structured-document';

GlobalWorkerOptions.workerSrc = workerUrl;
const SIZE = { width: 595, height: 842 };
const LEFT = 42, RIGHT = 315, COLUMN = 238, FULL = 511;
const blobs = new Map<string, Blob>();
const urls: string[] = [];
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function block(id: string, kind: DocumentBlock['kind'], value: string, rect: SourceRect, fontSize = 10): DocumentBlock {
  return { id, kind, page: 1, rect, fontSize, runs: [{ type: 'text', text: value }], geometry: 'block' };
}
async function image(id: string, kind: DocumentAsset['kind'], rect: SourceRect) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(rect.width * 4); canvas.height = Math.round(rect.height * 4);
  const context = canvas.getContext('2d')!;
  context.scale(4, 4); context.fillStyle = '#fff'; context.fillRect(0, 0, rect.width, rect.height);
  context.fillStyle = '#18383e';
  if (kind === 'equation-inline') {
    context.font = '11px serif'; context.fillText('ε = 0.2', 1, 10);
  } else {
    context.fillStyle = '#f0f5f3'; context.fillRect(0, 0, rect.width, rect.height);
    context.strokeStyle = '#597c73'; context.lineWidth = 0.5;
    for (let row = 1; row < 4; row++) { context.beginPath(); context.moveTo(32, row * 20); context.lineTo(rect.width - 20, row * 20); context.stroke(); }
    context.strokeStyle = '#18383e'; context.lineWidth = 1.2; context.beginPath(); context.moveTo(32, 10); context.lineTo(32, 77); context.lineTo(rect.width - 20, 77); context.stroke();
    context.strokeStyle = '#16766b'; context.lineWidth = 2; context.beginPath();
    for (let i = 0; i < 17; i++) { const x = 34 + i * 27, y = 69 - Math.sin(i / 6) * 42; if (!i) context.moveTo(x, y); else context.lineTo(x, y); }
    context.stroke(); context.fillStyle = '#18383e'; context.font = '9px sans-serif'; context.fillText('Temperature / strain', rect.width / 2 - 42, 90);
  }
  const png = new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'))).arrayBuffer());
  return { id, kind, page: 1, rect, widthPt: rect.width, heightPt: rect.height, png, dataUrl: canvas.toDataURL('image/png'), sha256: await sha256(png), alt: id,
    ...(kind === 'equation-inline' ? { baselineOffsetPt: -2 } : {}) } satisfies DocumentAsset;
}
async function fixture() {
  const equation = await image('equation-inline', 'equation-inline', { x: 108, y: 135, width: 36, height: 12 });
  const figure = await image('figure-wide', 'figure', { x: LEFT, y: 390, width: FULL, height: 96 });
  const blocks: DocumentBlock[] = [
    block('title', 'heading', 'Scientific layout across two columns', { x: LEFT, y: 42, width: FULL, height: 25 }, 18),
    block('subtitle', 'paragraph', 'A synthetic paper for source-informed PDF reconstruction', { x: LEFT, y: 78, width: FULL, height: 16 }, 10),
    block('left-1', 'paragraph', '', { x: LEFT, y: 125, width: COLUMN, height: 67 }),
    block('left-2', 'paragraph', 'MATERIALS The specimens were heated under controlled conditions. The experiment records the response of the material. Measurements are grouped by temperature and applied pressure.', { x: LEFT, y: 215, width: COLUMN, height: 73 }),
    block('left-3', 'paragraph', 'METHOD The same procedure was repeated in three independent runs. The original figure is preserved without changing its proportions or scientific content.', { x: LEFT, y: 307, width: COLUMN, height: 59 }),
    block('right-1', 'paragraph', 'RESULTS These paragraphs originally appeared in the right column. The translation follows the reviewed reading sequence, filling the available column before continuing into the next one.', { x: RIGHT, y: 125, width: COLUMN, height: 67 }),
    block('right-2', 'paragraph', 'DISCUSSION A continuous article flow allows text to grow naturally. Margins, column widths, type styles and figure proportions provide the visual reference for its new composition.', { x: RIGHT, y: 215, width: COLUMN, height: 73 }),
    block('right-3', 'paragraph', 'OBSERVATIONS Figure captions should remain near their figures. Inline equations remain inside the sentence when the surrounding words change length.', { x: RIGHT, y: 307, width: COLUMN, height: 59 }),
    { ...block('figure', 'figure', '', figure.rect), runs: [], assetId: figure.id, captionId: 'caption' },
    block('caption', 'caption', 'Figure 1. The original graph spans the two columns and remains together with its caption.', { x: LEFT, y: 495, width: FULL, height: 24 }, 9),
    block('below-left', 'paragraph', 'CONCLUSION The lower part of the article returns to two columns. A source-aware planner must recognize that the full-width graph separates two distinct text bands.', { x: LEFT, y: 550, width: COLUMN, height: 72 }),
    block('below-left-2', 'paragraph', 'The PDF keeps selectable translated text. The graph and equation are embedded from their original image bytes. No translation API is needed to run this visual regression.', { x: LEFT, y: 640, width: COLUMN, height: 72 }),
    block('below-right', 'paragraph', 'LIMITATIONS A translated paragraph may need more lines. It may continue into another region or page, while retaining a readable size and never covering another element.', { x: RIGHT, y: 550, width: COLUMN, height: 72 }),
    block('below-right-2', 'paragraph', 'END_OF_ARTICLE This final marker confirms that the complete document survived reconstruction. Visual similarity must be verified on representative real articles as well.', { x: RIGHT, y: 640, width: COLUMN, height: 72 }),
  ];
  blocks[2].runs = [{ type: 'text', text: 'INTRODUCTION The strain ' }, { type: 'asset', assetId: equation.id }, { type: 'text', text: ' is measured before the material is extruded. Scientific figures, symbols and reading order are preserved in the translated PDF.' }];
  const translations: Record<string, ContentRun[]> = {
    title: [{ type: 'text', text: 'Diagramação científica em duas colunas' }],
    subtitle: [{ type: 'text', text: 'Artigo sintético para verificar a reconstrução do PDF' }],
    'left-1': [{ type: 'text', text: 'INTRODUÇÃO A deformação ' }, { type: 'asset', assetId: equation.id }, { type: 'text', text: ' é medida antes da extrusão do material. Figuras, símbolos e ordem de leitura são preservados no PDF traduzido.' }],
    'left-2': [{ type: 'text', text: 'MATERIAIS As amostras foram aquecidas em condições controladas. O experimento registra a resposta do material. As medições são agrupadas por temperatura e pressão aplicada.' }],
    'left-3': [{ type: 'text', text: 'MÉTODO O procedimento foi repetido em três ensaios independentes. A figura original é preservada com suas proporções e seu conteúdo científico.' }],
    'right-1': [{ type: 'text', text: 'RESULTADOS Estes parágrafos estavam na coluna direita. A tradução segue a ordem de leitura revisada, preenchendo o espaço da coluna disponível antes de continuar na próxima.' }],
    'right-2': [{ type: 'text', text: 'DISCUSSÃO O fluxo contínuo permite o crescimento natural do texto. Margens, largura das colunas, estilos das letras e proporções das figuras orientam a nova montagem.' }],
    'right-3': [{ type: 'text', text: 'OBSERVAÇÕES As legendas devem acompanhar as figuras. As equações dentro das frases acompanham o texto quando as palavras mudam de tamanho.' }],
    caption: [{ type: 'text', text: 'Figura 1. O gráfico original ocupa as duas colunas e permanece junto de sua legenda traduzida.' }],
    'below-left': [{ type: 'text', text: 'CONCLUSÃO A parte inferior do artigo retorna a duas colunas. O planejador precisa reconhecer que o gráfico de largura total separa duas faixas distintas de texto.' }],
    'below-left-2': [{ type: 'text', text: 'O PDF mantém o texto traduzido selecionável. O gráfico e a equação utilizam as imagens originais. Esta verificação visual funciona sem chamadas à API de tradução.' }],
    'below-right': [{ type: 'text', text: 'LIMITAÇÕES Um parágrafo traduzido pode precisar de mais linhas. Ele pode continuar em outra região ou página, com tamanho legível e sem cobrir outro elemento.' }],
    'below-right-2': [{ type: 'text', text: 'FIM_DO_ARTIGO Este marcador final confirma a reconstrução do documento completo. A semelhança visual também precisa ser avaliada em artigos reais representativos.' }],
  };
  const result: TranslatedDocument = { document: { version: 1, sourceName: 'Artigo sintético A4', sourceHash: 'synthetic-layout-browser', sourceKind: 'pdf', pages: [SIZE], blocks, assets: [equation, figure], issues: [] }, blocks: translations, sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
  return result;
}
async function originalPdf(translated: TranslatedDocument) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([SIZE.width, SIZE.height]);
  const regular = await pdf.embedFont(StandardFonts.TimesRoman), bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const assets = new Map(translated.document.assets.map(asset => [asset.id, asset]));
  const images = new Map(await Promise.all(translated.document.assets.map(async asset => [asset.id, await pdf.embedPng(asset.png)] as const)));
  for (const block of translated.document.blocks) {
    if (block.assetId) {
      const asset = assets.get(block.assetId)!;
      page.drawImage(images.get(asset.id)!, { x: block.rect.x, y: SIZE.height - block.rect.y - block.rect.height, width: block.rect.width, height: block.rect.height });
      continue;
    }
    const size = block.fontSize, font: PDFFont = block.kind === 'heading' ? bold : regular, leading = size * 1.22;
    let x = block.rect.x, top = block.rect.y;
    for (const run of block.runs) {
      if (run.type === 'asset') {
        const asset = assets.get(run.assetId)!;
        if (x + asset.widthPt > block.rect.x + block.rect.width) { x = block.rect.x; top += leading; }
        page.drawImage(images.get(asset.id)!, { x, y: SIZE.height - top - size * .84 - 2, width: asset.widthPt, height: asset.heightPt });
        x += asset.widthPt;
      } else {
        for (const token of run.text.split(/(\s+)/).filter(Boolean)) {
          const width = font.widthOfTextAtSize(token, size);
          if (x + width > block.rect.x + block.rect.width && x > block.rect.x) { x = block.rect.x; top += leading; }
          if (x === block.rect.x && /^\s+$/.test(token)) continue;
          page.drawText(token, { x, y: SIZE.height - top - size * .84, size, font, color: rgb(0, 0, 0) }); x += width;
        }
      }
    }
  }
  return new Blob([new Uint8Array(await pdf.save()).buffer], { type: 'application/pdf' });
}
async function open(blob: Blob) { return getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise; }
async function render(pdf: PDFDocumentProxy, host: HTMLElement, scale = 1) {
  for (let index = 1; index <= pdf.numPages; index++) {
    const paper = document.createElement('div'); paper.className = 'paper';
    const label = document.createElement('p'); label.textContent = `Página ${index} de ${pdf.numPages}`;
    const canvas = document.createElement('canvas'), page = await pdf.getPage(index), viewport = page.getViewport({ scale });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    paper.append(label, canvas); host.append(paper);
    await page.render({ canvas, viewport }).promise;
  }
}
async function content(pdf: PDFDocumentProxy) {
  const pages: { items: TextItem[]; width: number; height: number }[] = [];
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index), viewport = page.getViewport({ scale: 1 }), text = await page.getTextContent();
    const items = text.items.filter((item): item is TextItem => 'str' in item && Boolean(item.str.trim()));
    for (const item of items) {
      assert(item.transform[4] >= -0.5 && item.transform[4] + item.width <= viewport.width + .5, `Texto fora da página ${index}: ${item.str}`);
      assert(item.transform[5] >= 0 && item.transform[5] + item.height <= viewport.height + 1, `Texto fora da página ${index}: ${item.str}`);
    }
    pages.push({ items, width: viewport.width, height: viewport.height });
  }
  return pages;
}
Object.assign(window, { pdfReconstructionArtifactBase64: async (name: string) => {
  const blob = blobs.get(name); assert(blob, 'Artefato não encontrado.');
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
} });
async function run() {
  const result = document.querySelector<HTMLElement>('#result')!, button = document.querySelector<HTMLButtonElement>('#run')!, checks: string[] = [];
  button.disabled = true; result.dataset.status = 'running'; result.textContent = 'Reconstruindo e verificando o artigo…';
  urls.splice(0).forEach(URL.revokeObjectURL); blobs.clear();
  for (const id of ['original', 'translated', 'expanded', 'artifacts']) document.getElementById(id)!.replaceChildren();
  const loaded: PDFDocumentProxy[] = [];
  try {
    const input = await fixture(), original = await originalPdf(input);
    let report: PdfLayoutReport | undefined;
    const translated = await createStructuredPdf(input, status => { result.textContent = status; }, undefined, value => { report = value; });
    blobs.set('original-layout.pdf', original); blobs.set('translated-layout.pdf', translated);
    const sourcePdf = await open(original); loaded.push(sourcePdf);
    const translatedPdf = await open(translated); loaded.push(translatedPdf);
    const pages = await content(translatedPdf), text = pages.flatMap(p => p.items.map(item => item.str)).join(' ');
    assert(pages.length === 1 && pages[0].width === SIZE.width && pages[0].height === SIZE.height, 'Dimensões/paginação A4 inesperadas.');
    const left = pages[0].items.find(item => item.str.includes('INTRODUÇÃO')), right = pages[0].items.find(item => item.str.includes('RESULTADOS'));
    assert(left && right && Math.abs(left.transform[4] - LEFT) < 2, 'Início do corpo não está na primeira coluna.');
    assert(Math.min(Math.abs(right.transform[4] - LEFT), Math.abs(right.transform[4] - RIGHT)) < 2, 'Texto não respeitou a largura das colunas.');
    const readingOrder = ['INTRODUÇÃO', 'MATERIAIS', 'MÉTODO', 'RESULTADOS', 'DISCUSSÃO', 'OBSERVAÇÕES', 'CONCLUSÃO', 'LIMITAÇÕES', 'FIM_DO_ARTIGO'].map(marker => text.indexOf(marker));
    assert(readingOrder.every((position, index) => position >= 0 && (!index || position > readingOrder[index - 1])), 'A ordem de leitura dos parágrafos foi alterada.');
    assert(text.includes('FIM_DO_ARTIGO') && text.includes('Figura 1.'), 'Legenda ou fim do artigo ausente.');
    assert(report?.pages[0].columns === 2, 'Relatório não reconheceu as duas colunas.');
    assert(report.outputPages[0]?.sourcePages.includes(1), 'Relatório não registrou a procedência do conteúdo.');
    checks.push('A4: fluxo contínuo em duas colunas, uma página e leitura completa: OK');
    checks.push('Título, figura em largura total, legenda e equação preservada: conferir nas prévias');
    await render(sourcePdf, document.getElementById('original')!); await render(translatedPdf, document.getElementById('translated')!);
    const expanded: TranslatedDocument = { ...input, blocks: { ...input.blocks } };
    const tokens = Array.from({ length: 800 }, (_, index) => `expansion_${String(index).padStart(4, '0')}`);
    expanded.blocks['left-2'] = [{ type: 'text', text: tokens.join(' ') }];
    let expansionReport: PdfLayoutReport | undefined;
    const stress = await createStructuredPdf(expanded, undefined, undefined, value => { expansionReport = value; });
    blobs.set('expanded-layout.pdf', stress);
    const stressPdf = await open(stress); loaded.push(stressPdf);
    const stressPages = await content(stressPdf), stressText = stressPages.flatMap(p => p.items.map(item => item.str)).join(' ');
    assert(stressPdf.numPages > 1, 'O texto expandido não gerou continuação.');
    assert(JSON.stringify(stressText.match(/expansion_\d{4}/g)) === JSON.stringify(tokens), 'Texto expandido perdido, duplicado ou fora da ordem.');
    assert(stressText.includes('FIM_DO_ARTIGO'), 'Fim do artigo perdido após a expansão.');
    assert(expansionReport?.pages[0].outputPages.length === stressPdf.numPages, 'Relatório não mapeia todas as páginas de continuação.');
    checks.push(`Expansão: ${stressPdf.numPages} páginas, 800 marcadores sem perdas/duplicações e texto dentro dos limites: OK`);
    await render(stressPdf, document.getElementById('expanded')!, .6);
    for (const [name, blob] of blobs) {
      const link = document.createElement('a'), url = URL.createObjectURL(blob); urls.push(url);
      link.href = url; link.download = name; link.textContent = name; document.getElementById('artifacts')!.append(link);
    }
    Object.assign(window, { pdfReconstructionReport: report, pdfReconstructionExpansionReport: expansionReport });
    result.textContent = checks.join('\n'); result.dataset.status = 'passed';
  } catch (error) {
    result.textContent = checks.join('\n') + '\nFALHA: ' + (error instanceof Error ? error.stack : String(error)); result.dataset.status = 'failed';
  } finally { await Promise.allSettled(loaded.map(pdf => pdf.destroy())); button.disabled = false; }
}
document.querySelector('#run')!.addEventListener('click', () => void run());
if (new URLSearchParams(location.search).get('autorun') === '1') void run();
