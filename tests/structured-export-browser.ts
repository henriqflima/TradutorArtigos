import JSZip from 'jszip';
import { renderAsync } from 'docx-preview';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { createStructuredDocx, createStructuredPdf } from '../src/structured-export';
import { sha256, type DocumentAsset, type DocumentBlock, type TranslatedDocument } from '../src/structured-document';

GlobalWorkerOptions.workerSrc = workerUrl;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejects(action: () => Promise<unknown>, match: RegExp) {
  try { await action(); } catch (error) { assert(error instanceof Error && match.test(error.message), `Erro inesperado: ${String(error)}`); return; }
  throw new Error(`Entrada inválida aceita: ${match}`);
}
async function asset(id: string, kind: DocumentAsset['kind'], widthPt: number, heightPt: number, text: string): Promise<DocumentAsset> {
  const canvas = document.createElement('canvas'); canvas.width = Math.round(widthPt * 5); canvas.height = Math.round(heightPt * 5);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'black'; ctx.lineWidth = 3; if (kind === 'figure') ctx.strokeRect(15, 15, canvas.width - 30, canvas.height - 30);
  ctx.fillStyle = 'black'; ctx.font = `${kind === 'equation-inline' ? 55 : 75}px serif`; ctx.fillText(text, 10, canvas.height * .7);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  return { id, kind, page: 1, rect: { x: 0, y: 0, width: widthPt, height: heightPt }, widthPt, heightPt, png, dataUrl: canvas.toDataURL('image/png'), sha256: await sha256(png), alt: text, baselineOffsetPt: kind === 'equation-inline' ? -2 : undefined };
}
const rect = { x: 0, y: 0, width: 200, height: 20 };
function block(id: string, kind: DocumentBlock['kind'], text: string): DocumentBlock { return { id, kind, page: 1, rect, fontSize: 11, runs: [{ type: 'text', text }] }; }
export async function synthetic(): Promise<TranslatedDocument> {
  const symbols = [await asset('inline-phi', 'equation-inline', 11, 13, 'Φ'), await asset('inline-psi', 'equation-inline', 11, 13, 'Ψ')];
  const equation = await asset('equation-1', 'equation-block', 270, 45, 'γ = 2 cot(Φ/2 + Ψ/2)');
  const figure = await asset('figure-1', 'figure', 300, 130, 'Temperatura versus deformação');
  const intro = block('intro', 'paragraph', ''); intro.runs = [{ type: 'text', text: 'Os ângulos ' }, { type: 'asset', assetId: symbols[0].id }, { type: 'text', text: ' e ' }, { type: 'asset', assetId: symbols[1].id }, { type: 'text', text: ' mantêm sua aparência. O português inclui ação, pressão e extrusão.' }];
  const blocks = [block('title', 'heading', 'Ensaio de fidelidade das equações'), intro, { ...block('eq', 'equation', ''), runs: [{ type: 'asset' as const, assetId: equation.id }], assetId: equation.id }, block('body', 'paragraph', 'A deformação foi medida em condições controladas. '.repeat(105)), { ...block('figure', 'figure', ''), runs: [{ type: 'asset' as const, assetId: figure.id }], assetId: figure.id, captionId: 'caption' }, block('caption', 'caption', 'Figura 1. Relação entre a temperatura e a deformação. A figura permanece junto desta legenda.'), block('closing', 'paragraph', 'Fim do ensaio. Número científico 1,9 e referência [28] preservados.')];
  const translation = Object.fromEntries(blocks.filter(value => !['figure', 'equation'].includes(value.kind)).map(value => [value.id, value.runs]));
  translation.intro = [{ type: 'text', text: 'Os ângulos ' }, { type: 'asset', assetId: 'inline-psi' }, { type: 'text', text: ' e ' }, { type: 'asset', assetId: 'inline-phi' }, { type: 'text', text: ' mantêm sua aparência. O português inclui ação, pressão e extrusão. Nome Unicode: Zaı¨ri.', style: { italic: true } }];
  return { document: { version: 1, sourceName: 'Ensaio de fidelidade', sourceHash: 'synthetic-test', sourceKind: 'pdf', pages: [{ width: 612, height: 792 }], blocks, assets: [...symbols, equation, figure], issues: [] }, blocks: translation, sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
}
const blobs = new Map<string, Blob>();
Object.assign(window, { structuredArtifactBase64: async (name: string) => {
  const bytes = new Uint8Array(await blobs.get(name)!.arrayBuffer()); let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
} });
async function run() {
  const result = document.querySelector<HTMLElement>('#result')!, button = document.querySelector<HTMLButtonElement>('#run')!, output = document.querySelector<HTMLElement>('#output')!;
  button.disabled = true; result.dataset.status = 'running'; result.textContent = 'Verificando…';
  const checks: string[] = [];
  try {
    const translated = await synthetic();
    const docx = await createStructuredDocx(translated); const pdf = await createStructuredPdf(translated);
    blobs.set('synthetic.docx', docx); blobs.set('synthetic.pdf', pdf);
    const zip = await JSZip.loadAsync(await docx.arrayBuffer());
    const doc = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
    assert(!doc.querySelector('parsererror'), 'Word contém XML inválido');
    assert(doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'bookmarkStart').length === translated.document.blocks.length, 'IDs/bookmarks de blocos ausentes');
    for (let index = 0; index < translated.document.assets.length; index++) assert(await sha256(await zip.file(`word/media/preserved-${index + 1}.png`)!.async('uint8array')) === translated.document.assets[index].sha256, 'PNG original alterado no Word');
    checks.push('DOCX: texto PT editável, bookmarks e quatro PNGs originais preservados: OK');
    const loading = getDocument({ data: new Uint8Array(await pdf.arrayBuffer()) }); const renderedPdf = await loading.promise;
    const allText: string[] = []; let figureCaptionPage = -1;
    for (let index = 1; index <= renderedPdf.numPages; index++) {
      const page = await renderedPdf.getPage(index), content = await page.getTextContent();
      const text = content.items.filter(item => 'str' in item).map(item => item.str).join(' '); allText.push(text);
      if (text.includes('Figura 1.')) figureCaptionPage = index;
      for (const item of content.items) if ('str' in item && item.str.trim() && item.str !== String(index)) {
        assert(item.transform[4] >= 53 && item.transform[4] + item.width <= 559, 'Texto PDF fora das margens horizontais');
        assert(item.transform[5] >= 53 && item.transform[5] <= 739, 'Texto PDF fora das margens verticais');
      }
    }
    assert(renderedPdf.numPages >= 2 && allText.join(' ').includes('pressão e extrusão') && allText.join(' ').includes('Número científico 1,9'), 'PDF perdeu texto selecionável PT ou não paginou');
    assert(allText.join(' ').includes('Zaı¨ri'), 'PDF perdeu o nome Unicode selecionável');
    assert(figureCaptionPage > 0, 'Legenda ausente no PDF');
    checks.push(`PDF: ${renderedPdf.numPages} páginas, texto selecionável e dentro das margens: OK`);
    const parsed = await PDFDocument.load(await pdf.arrayBuffer());
    const streams = parsed.context.enumerateIndirectObjects().map(([, value]) => value).filter((value): value is PDFRawStream => value instanceof PDFRawStream);
    assert(streams.some(stream => stream.dict.get(PDFName.of('Subtype'))?.toString() === '/Image' && stream.dict.get(PDFName.of('Width'))?.toString() === '1350'), 'Equação PDF perdeu resolução original');
    checks.push('PDF: equação de 1350 pixels preservada, sem rasterizar a página inteira: OK');
    await loading.destroy();
    const lost = { ...translated, blocks: { ...translated.blocks, intro: [{ type: 'text' as const, text: 'Objetos perdidos.' }] } };
    await rejects(() => createStructuredDocx(lost), /objetos protegidos/);
    const corrupted = { ...translated, document: { ...translated.document, assets: translated.document.assets.map((value, index) => index ? value : { ...value, sha256: 'altered' }) } };
    await rejects(() => createStructuredPdf(corrupted), /foi alterada/);
    const missing = { ...translated, blocks: { ...translated.blocks } }; delete missing.blocks.body;
    await rejects(() => createStructuredDocx(missing), /está ausente/);
    const invalid = { ...translated, blocks: { ...translated.blocks, closing: [{ type: 'text' as const, text: '🧪' }] } };
    await rejects(() => createStructuredPdf(invalid), /U\+1F9EA/);
    const control = { ...translated, blocks: { ...translated.blocks, closing: [{ type: 'text' as const, text: 'inválido\u0001' }] } };
    await rejects(() => createStructuredDocx(control), /caracteres inválidos/);
    const aborted = new AbortController(); aborted.abort(); await rejects(() => createStructuredPdf(translated, undefined, aborted.signal), /cancelada/);
    checks.push('Perda de marcador, checksum alterado, tradução ausente, glifo não suportado, XML inválido e cancelamento: recusados: OK');
    await renderAsync(docx, output, undefined, { useBase64URL: true });
    const images = Array.from(output.querySelectorAll('img')); await Promise.all(images.map(value => value.decode()));
    assert(images.length === 4 && images.some(value => value.naturalWidth === 1350), 'Prévia DOCX perdeu equação ou pixels originais');
    const artifacts = document.querySelector('#artifacts')!; artifacts.replaceChildren();
    for (const [name, value] of blobs) { const link = document.createElement('a'); link.href = URL.createObjectURL(value); link.download = name; link.textContent = name; artifacts.append(link); }
    checks.push('Prévia Word: quatro imagens decodificadas e texto final presente: OK');
    result.textContent = checks.join('\n'); result.dataset.status = 'passed';
  } catch (error) { result.textContent = `${checks.join('\n')}\nFALHA: ${error instanceof Error ? error.stack : String(error)}`; result.dataset.status = 'failed'; }
  finally { button.disabled = false; }
}
document.querySelector('#run')!.addEventListener('click', run);
if (new URLSearchParams(location.search).get('autorun') === '1') void run();
