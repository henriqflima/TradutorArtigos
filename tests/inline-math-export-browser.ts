import JSZip from 'jszip';
import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createStructuredDocx, createStructuredPdf, validateStructuredSource } from '../src/structured-export';
import { sha256, type ContentRun, type DocumentAsset, type DocumentBlock, type RunStyle, type SourceRect, type TranslatedDocument } from '../src/structured-document';
import { pdfSourceOptions } from '../src/pdf-options';

GlobalWorkerOptions.workerSrc = workerUrl;
const size = { width: 595, height: 842 }, W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const status = document.querySelector<HTMLElement>('#result')!, artifacts = new Map<string, Blob>(), urls: string[] = [];
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const prose = (text: string, style?: RunStyle): ContentRun => ({ type: 'text', text, ...(style ? { style } : {}) });
function rawCode(text: string) { return /\\[()[\]]|\\(?:eta|rho|gamma|tau|lambda|frac|nabla|mathrm|overline|bar|sigma)|[A-Za-z]_\{/u.test(text); }
async function sourceAsset(): Promise<DocumentAsset> {
  const canvas = document.createElement('canvas'); canvas.width = 2040; canvas.height = 192;
  const context = canvas.getContext('2d')!; context.scale(4, 4); context.fillStyle = '#fff'; context.fillRect(0, 0, 510, 48);
  context.fillStyle = '#111'; context.font = 'italic 13px Georgia'; context.fillText('η(γ̇, T) = η₀(T) / [1 + (λγ̇)¹⁻ⁿ]', 130, 26);
  context.font = '11px Georgia'; context.fillText('(3)', 480, 26);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer()); canvas.width = canvas.height = 0;
  return { id: 'original-display-equation', kind: 'equation-block', page: 1, rect: { x: 40, y: 650, width: 510, height: 48 },
    widthPt: 510, heightPt: 48, png, dataUrl: '', sha256: await sha256(png), alt: 'Equação destacada preservada como recorte' };
}
async function fixture() {
  let inlineCount = 0;
  const formula = (tex: string, style?: RunStyle): ContentRun => { inlineCount++; return prose(`\\(${tex}\\)`, style); };
  const rows: { id: string; runs: ContentRun[]; kind?: 'heading' | 'caption'; fontSize?: number }[] = [
    { id: 'title', kind: 'heading', fontSize: 16, runs: [prose('Preservação de símbolos matemáticos no texto')] },
    { id: 'viscosity', runs: [prose('onde m é o índice de consistência (o valor da viscosidade em '), formula(String.raw`\dot{\gamma}=1/s`),
      prose('), n é o expoente da lei de potência, '), formula(String.raw`\eta_0`), prose(' é a viscosidade em cisalhamento zero, e a e '), formula(String.raw`\lambda`),
      prose(' são parâmetros de ajuste. Tanto m quanto '), formula(String.raw`\eta_0`), prose(' são funções da temperatura '), formula('T'),
      prose('. A dependência da temperatura é geralmente expressa pelos modelos simples de Arrhenius ou exponenciais.')] },
    { id: 'reference', runs: [prose('onde '), formula(String.raw`m_{\mathrm{ref}}`), prose(' e '), formula(String.raw`\eta_{0,\mathrm{ref}}`),
      prose(' são medidos em uma temperatura de referência '), formula(String.raw`T_{\mathrm{ref}}`), prose(', '), formula(String.raw`E_a`),
      prose(' é a energia de ativação e '), formula('R'), prose(' é a constante dos gases. A condutividade térmica '), formula('k'),
      prose(' e o calor específico '), formula(String.raw`C_p`), prose(' também são importantes. A densidade do polímero fundido '), formula(String.raw`\rho`),
      prose(' é geralmente cerca de 15% menor que a densidade no estado sólido dos polímeros e pode ser facilmente medida [3].')] },
    { id: 'conservation', runs: [prose('As equações de conservação de massa, quantidade de movimento e energia são as seguintes [3-5]. Aqui '), formula('v'),
      prose(' é o vetor velocidade, p é a pressão, '), formula(String.raw`\tau`), prose(' é o tensor de tensões e o termo '), formula(String.raw`\tau:\nabla v`),
      prose(' representa a dissipação viscosa por aquecimento de atrito. O tensor de tensões é geralmente expresso em termos do modelo de fluido Newtoniano generalizado.')] },
    { id: 'strain', runs: [prose('onde '), formula(String.raw`\eta(II_D)`), prose(' é a viscosidade e '), formula(String.raw`II_D`),
      prose(' é o segundo invariante do tensor de taxa de deformação '), formula('D'), prose(', dado pela relação indicada no original.')] },
    { id: 'style', runs: [prose('A formatação também deve permanecer: ', { bold: true }), formula(String.raw`\eta_0`, { bold: true }),
      prose(' é seguida por texto em itálico e pela referência ', { italic: true }), formula(String.raw`T_{\mathrm{ref}}`, { italic: true }),
      prose('. Um expoente em linha pode usar '), formula('2', { superscript: true }), prose(' sem deslocar o restante do parágrafo.')] },
    { id: 'caption', kind: 'caption', fontSize: 8, runs: [prose('Legenda de teste: a proporção '), formula(String.raw`\lambda`), prose(' acompanha o tamanho menor da legenda.')] },
    { id: 'currency', runs: [prose('Texto comum também deve continuar completo: o custo é R$ 10,00 e a alternativa custa R$ 20,00.')] },
    { id: 'split-style', runs: [prose('Uma fórmula que atravessa a marcação de estilo, '), prose(String.raw`\(\eta`, { italic: true }),
      prose(String.raw`_{0,\mathrm{ref}}`, { bold: true }), prose(String.raw`\)`, { italic: true }), prose(', continua como uma expressão íntegra.')] },
    { id: 'mean-scaling', runs: [prose('onde '), formula(String.raw`X_s`), prose(' representa a variável em escala, '), formula('X'),
      prose(' é a variável sem escala, '), formula(String.raw`\overline{X}`), prose(' é a média da variável e '), formula(String.raw`\sigma`),
      prose(' é o desvio padrão. Uma média conjunta também pode ser representada por '), formula(String.raw`\overline{X+Y}`), prose('.')] },
  ];
  inlineCount++;
  const asset = await sourceAsset();
  const blocks: DocumentBlock[] = rows.map((row, index) => ({ id: row.id, kind: row.kind || 'paragraph', page: 1,
    rect: { x: 40, y: 45 + index * 65, width: 510, height: row.kind === 'heading' ? 24 : 60 },
    fontSize: row.fontSize || 11, appearance: { fontSize: row.fontSize || 11, fontFamily: 'serif', lineHeight: (row.fontSize || 11) * 1.25,
      alignment: row.kind === 'heading' ? 'left' : 'justify', confidence: 'native' }, runs: row.runs }));
  blocks.push({ id: 'display', kind: 'equation', page: 1, rect: { ...asset.rect }, runs: [{ type: 'asset', assetId: asset.id }], fontSize: 11, assetId: asset.id });
  const input: TranslatedDocument = { document: { version: 1, sourceName: 'Verificação de matemática no texto', sourceHash: 'inline-math-example', sourceKind: 'pdf',
    pages: [size], blocks, assets: [asset], issues: [] }, blocks: Object.fromEntries(rows.map(row => [row.id, row.runs])), sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
  return { input, inlineCount, originalPngHash: asset.sha256 };
}
const multiply = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
async function inspect(pdf: PDFDocumentProxy) {
  const pages: { text: string; images: SourceRect[]; baselinePairs: number; orphanPunctuation: string[] }[] = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
    const text = await page.getTextContent(), ops = await page.getOperatorList();
    const items = text.items.filter((item): item is TextItem => 'str' in item && !!item.str.trim()), images: SourceRect[] = [];
    let matrix = [1, 0, 0, 1, 0, 0]; const stack: number[][] = [];
    ops.fnArray.forEach((fn, index) => {
      if (fn === OPS.save) stack.push([...matrix]);
      else if (fn === OPS.restore) matrix = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) matrix = multiply(matrix, ops.argsArray[index] as number[]);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) images.push({ x: matrix[4], y: viewport.height - matrix[5] - matrix[3], width: Math.abs(matrix[0]), height: Math.abs(matrix[3]) });
    });
    for (const item of items) {
      assert(item.transform[4] >= -.5 && item.transform[4] + item.width <= viewport.width + .5, 'Texto fora da largura da página.');
      assert(item.transform[5] >= 0 && item.transform[5] + item.height <= viewport.height + 1, 'Texto fora da altura da página.');
    }
    for (const image of images) assert(image.x >= -.5 && image.y >= -.5 && image.x + image.width <= viewport.width + .5 && image.y + image.height <= viewport.height + .5, 'Imagem matemática fora dos limites.');
    const baselinePairs = images.filter(image => image.width < 200 && image.height < 28 && items.some(item => {
      const baseline = viewport.height - item.transform[5], height = Math.hypot(item.transform[2], item.transform[3]);
      const adjacent = Math.min(Math.abs(image.x - item.transform[4] - item.width), Math.abs(item.transform[4] - image.x - image.width));
      return adjacent < 8 && Math.abs(image.y + image.height - baseline) <= height;
    })).length;
    const orphanPunctuation = items.filter(item => /^[,.;:!?)\]]/u.test(item.str.trimStart()) &&
      !items.some(other => other !== item && other.transform[4] < item.transform[4] - .5 && Math.abs(other.transform[5] - item.transform[5]) < .3) &&
      !images.some(image => image.x + image.width <= item.transform[4] + .5 && item.transform[4] - image.x - image.width < 8 &&
        Math.abs(image.y + image.height - viewport.height + item.transform[5]) <= item.height))
      .map(item => `p${number} y${Math.round(viewport.height - item.transform[5])}: ${item.str}`);
    pages.push({ text: items.map(item => item.str).join(' '), images, baselinePairs, orphanPunctuation });
  }
  return pages;
}
async function render(pdf: PDFDocumentProxy) {
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1.45 }), canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const paper = document.createElement('div'); paper.className = 'paper';
    const label = document.createElement('p'); label.textContent = `Página ${number} de ${pdf.numPages}`; paper.append(label, canvas); document.querySelector('#pages')!.append(paper);
    await page.render({ canvas, viewport }).promise;
  }
}
Object.assign(window, { inlineMathExportArtifact: async (name: string) => {
  const blob = artifacts.get(name); assert(blob, `Artefato ausente: ${name}`);
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
} });
async function run() {
  status.dataset.status = 'running'; status.textContent = 'Preparando os símbolos e gerando os arquivos…';
  urls.splice(0).forEach(URL.revokeObjectURL); artifacts.clear(); document.querySelector('#pages')!.replaceChildren(); document.querySelector('#downloads')!.replaceChildren();
  let pdf: PDFDocumentProxy | undefined;
  try {
    const { input, inlineCount, originalPngHash } = await fixture(), before = JSON.stringify(input);
    await validateStructuredSource(input.document);
    const pdfBlob = await createStructuredPdf(input), docx = await createStructuredDocx(input);
    artifacts.set('simbolos-no-texto.pdf', pdfBlob); artifacts.set('simbolos-no-texto.docx', docx);
    pdf = await getDocument({ data: new Uint8Array(await pdfBlob.arrayBuffer()), ...pdfSourceOptions() }).promise;
    const pages = await inspect(pdf), fullText = pages.map(page => page.text).join(' '), imageCount = pages.reduce((sum, page) => sum + page.images.length, 0);
    assert(!rawCode(fullText), 'Código LaTeX apareceu como texto no PDF.');
    for (const excerpt of ['índice de consistência', 'energia de ativação', 'dissipação viscosa', 'segundo invariante', '10,00', '20,00', 'média da variável', 'desvio padrão']) assert(fullText.includes(excerpt), `Prosa ausente: ${excerpt}`);
    assert(imageCount === inlineCount + 1, `Fórmulas/recorte: esperadas ${inlineCount + 1} ocorrências, encontradas ${imageCount}.`);
    assert(pages.reduce((sum, page) => sum + page.baselinePairs, 0) >= inlineCount - 2, 'Há símbolos pequenos sem vizinho textual próximo da linha de base.');
    const zip = await JSZip.loadAsync(docx), wordXml = await zip.file('word/document.xml')!.async('string');
    const parsed = new DOMParser().parseFromString(wordXml, 'application/xml');
    const wordText = [...parsed.getElementsByTagNameNS(W, 't')].map(node => node.textContent).join('');
    assert(!rawCode(wordText), 'Código LaTeX apareceu como texto no Word.');
    assert(parsed.getElementsByTagNameNS(W, 'drawing').length === inlineCount + 1, 'O Word omitiu ou duplicou símbolos.');
    const media = Object.values(zip.files).filter(file => file.name.startsWith('word/media/') && !file.dir);
    const mediaHashes = await Promise.all(media.map(async file => sha256(new Uint8Array(await file.async('uint8array')))));
    assert(mediaHashes.includes(originalPngHash), 'O recorte destacado original foi alterado no Word.');
    assert(JSON.stringify(input) === before && await sha256(input.document.assets[0].png) === originalPngHash, 'A exportação alterou os dados ou o recorte de origem.');
    const flowing = structuredClone(input), repetitions = 18;
    const body = flowing.document.blocks.find(block => block.id === 'viscosity')!;
    body.runs = Array.from({ length: repetitions }, () => [...body.runs, prose(' ')]).flat();
    flowing.document.blocks = [body, flowing.document.blocks.find(block => block.id === 'display')!];
    flowing.blocks = { viscosity: body.runs };
    const flowBlob = await createStructuredPdf(flowing);
    const flowPdf = await getDocument({ data: new Uint8Array(await flowBlob.arrayBuffer()), ...pdfSourceOptions() }).promise;
    const flowPages = await inspect(flowPdf), flowText = flowPages.map(page => page.text).join(' ');
    assert(flowPages.length > 1, 'O caso longo não atravessou uma página.');
    assert(!rawCode(flowText) && flowText.split('índice de consistência').length - 1 === repetitions, 'O fluxo entre páginas perdeu ou duplicou prosa.');
    assert(flowPages.reduce((sum, page) => sum + page.images.length, 0) === repetitions * 5 + 1, 'O fluxo entre páginas perdeu ou duplicou símbolos.');
    artifacts.set('simbolos-fluxo-entre-paginas.pdf', flowBlob);
    await flowPdf.destroy();
    const punctuation: { width: number; pages: number; orphanPunctuation: string[] }[] = [];
    for (const width of [270, 360, 595]) {
      const stress = structuredClone(input);
      const runs = Array.from({ length: 36 }, (_value, index) => prose(`Na frase ${'valor '.repeat(index % 11 + 1)}de referência (\\(\\eta_0\\)), a temperatura \\(T_{\\mathrm{ref}}\\), continua na mesma expressão; o fechamento deve acompanhar a fórmula. `));
      const block: DocumentBlock = { id: 'punctuation', kind: 'paragraph', page: 1, rect: { x: 24, y: 40, width: width - 48, height: 700 }, fontSize: 11,
        appearance: { fontSize: 11, fontFamily: 'serif', lineHeight: 13.75, alignment: 'justify', confidence: 'native' }, runs };
      stress.document.pages = [{ width, height: 842 }]; stress.document.assets = []; stress.document.blocks = [block]; stress.blocks = { punctuation: runs };
      const stressBlob = await createStructuredPdf(stress);
      const stressPdf = await getDocument({ data: new Uint8Array(await stressBlob.arrayBuffer()), ...pdfSourceOptions() }).promise;
      const pages = await inspect(stressPdf), orphanPunctuation = pages.flatMap(page => page.orphanPunctuation);
      punctuation.push({ width, pages: pages.length, orphanPunctuation });
      await stressPdf.destroy();
    }
    assert(punctuation.every(caseResult => !caseResult.orphanPunctuation.length), `Pontuação sem fórmula na linha: ${JSON.stringify(punctuation)}`);
    const malformed = structuredClone(input);
    malformed.blocks.viscosity = [prose(String.raw`Uma expressão inválida não deve virar código no PDF: \(\frac{a}{b\).`)];
    let rejected = false;
    try { await createStructuredPdf(malformed); } catch { rejected = true; }
    assert(rejected, 'Uma expressão TeX malformada foi exportada silenciosamente.');
    await render(pdf);
    for (const [name, blob] of artifacts) {
      const url = URL.createObjectURL(blob); urls.push(url);
      const link = document.createElement('a'); link.href = url; link.download = name; link.textContent = name; document.querySelector('#downloads')!.append(link);
    }
    const summary = { pages: pages.length, inlineCount, imageCount, wordDrawings: parsed.getElementsByTagNameNS(W, 'drawing').length,
      wordMedia: media.length, baselinePairs: pages.reduce((sum, page) => sum + page.baselinePairs, 0), flowPages: flowPages.length,
      flowInlineCount: repetitions * 5, punctuation, meanScalingRegression: true, originalPngUnchanged: true, noRawTex: true, malformedRejected: true, sourceUnchanged: true };
    Object.assign(window, { inlineMathExportSummary: summary });
    status.textContent = `OK: ${inlineCount} símbolos/expressões em linha e um recorte destacado preservados em PDF e Word, sem código visível, omissões, duplicações ou saída dos limites. Expressão inválida recusada. Conferir linha de base nas prévias.`;
    status.dataset.status = 'passed';
  } catch (error) { status.dataset.status = 'failed'; status.textContent = error instanceof Error ? error.stack || error.message : String(error); }
  finally { await pdf?.destroy(); }
}
document.querySelector('#run')!.addEventListener('click', () => void run());
void run();
