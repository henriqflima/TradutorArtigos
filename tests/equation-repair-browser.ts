import JSZip from 'jszip';
import { renderAsync } from 'docx-preview';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { applyEquationRepairs, inspectRepairDocument, type EquationRepair, type RepairImage } from '../src/equation-repair';
import { createPdf, renderWordPages } from '../src/pdf';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const r = (text: string, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (text: string) => `<w:p>${r(text)}</w:p>`;
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function parse(value: string) { return new DOMParser().parseFromString(value, 'application/xml'); }
async function rejects(action: () => Promise<unknown>, expected: RegExp) {
  try { await action(); } catch (error) {
    assert(error instanceof Error && expected.test(error.message), `Erro inesperado: ${String(error)}`); return;
  }
  throw new Error(`Operação inválida aceita: ${expected}`);
}
async function fixture(body: string, pngType = 'image/png') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<Types xmlns="${CONTENT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="${pngType}"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="${REL}"><Relationship Id="rIdLumeEquation3" Type="${R}/hyperlink" Target="https://example.org/untouched" TargetMode="External"/></Relationships>`);
  zip.file('customXml/preserved.xml', '<unchanged>metadados originais</unchanged>');
  zip.file('word/media/lume-equation-crop-1.png', new Uint8Array([1, 2, 3]));
  return zip;
}
async function blob(zip: JSZip) { return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }); }
async function png(): Promise<RepairImage> {
  const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 180;
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'black'; context.font = '60px serif'; context.fillText('γ = 2 cot(Φ/2 + Ψ/2)', 15, 110);
  const encoded = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
  return { image: new Uint8Array(await encoded.arrayBuffer()), widthPt: 270, heightPt: 54, alt: 'γ = 2 cot(Φ/2 + Ψ/2)' };
}

async function run() {
  const button = document.querySelector<HTMLButtonElement>('#run')!;
  const result = document.querySelector<HTMLElement>('#result')!;
  const output = document.querySelector<HTMLElement>('#output')!;
  button.disabled = true; result.dataset.status = 'running'; result.textContent = 'Verificando…'; output.replaceChildren();
  const checks: string[] = [];
  try {
    const image = await png();
    const exact = '<w:pPr><w:spacing w:line="100" w:lineRule="exact"/><w:tabs><w:tab w:val="left" w:pos="500"/></w:tabs><w:ind w:left="500" w:firstLine="200"/></w:pPr>';
    const source = await fixture(`${p('Texto anterior permanece.')}<w:p>${exact}<w:bookmarkStart w:id="7" w:name="Equacao1"/>${r('g = 2 cot F + J')}</w:p><w:p>${r('2  2')}<w:bookmarkEnd w:id="7"/></w:p><w:p>${exact}${r('Ângulo F e J.', '<w:i/><w:vertAlign w:val="superscript"/>')}</w:p>${p('Texto posterior permanece.')}`, 'application/octet-stream');
    const original = await blob(source);
    const repairs: EquationRepair[] = [
      { ...image, startParagraph: 1, endParagraph: 2 },
      { ...image, widthPt: 10, heightPt: 10, kind: 'inline', paragraph: 3, startOffset: 7, endOffset: 8, alt: 'Φ', baselineOffsetPt: -1 },
      { ...image, widthPt: 10, heightPt: 10, kind: 'inline', paragraph: 3, startOffset: 11, endOffset: 12, alt: 'Ψ', baselineOffsetPt: -1 },
    ];
    const repaired = await applyEquationRepairs(original, repairs);
    const zip = await JSZip.loadAsync(await repaired.arrayBuffer());
    const doc = parse(await zip.file('word/document.xml')!.async('string'));
    const paragraphs = Array.from(doc.getElementsByTagNameNS(W, 'p'));
    const text = (el: Element) => Array.from(el.getElementsByTagNameNS(W, 't')).map(t => t.textContent).join('');
    assert(paragraphs.length === 4 && text(paragraphs[0]) === 'Texto anterior permanece.' && text(paragraphs[3]) === 'Texto posterior permanece.', 'Limites da substituição em bloco incorretos');
    assert(!text(paragraphs[1]) && paragraphs[1].getElementsByTagNameNS(W, 'drawing').length === 1, 'Denominadores fragmentados permaneceram ou imagem ausente');
    assert(paragraphs[1].getElementsByTagNameNS(W, 'bookmarkStart')[0]?.getAttributeNS(W, 'id') === '7' && paragraphs[1].getElementsByTagNameNS(W, 'bookmarkEnd')[0]?.getAttributeNS(W, 'id') === '7', 'Bookmark de referência foi perdido');
    const repairedIndent = paragraphs[1].getElementsByTagNameNS(W, 'ind')[0];
    assert(repairedIndent?.getAttributeNS(W, 'left') === '500' && !repairedIndent.hasAttributeNS(W, 'firstLine') && !paragraphs[1].getElementsByTagNameNS(W, 'tabs').length, 'Recuo da coluna perdido ou primeira linha/tabulação fragmentada mantida');
    checks.push('Bloco de dois parágrafos: imagem completa, denominadores removidos, bookmarks e texto vizinho preservados: OK');

    assert(text(paragraphs[2]) === 'Ângulo  e .', 'Múltiplos reparos inline deslocaram os offsets originais');
    const inlineRuns = Array.from(paragraphs[2].getElementsByTagNameNS(W, 'r')).filter(run => run.getElementsByTagNameNS(W, 'drawing').length);
    assert(inlineRuns.length === 2 && inlineRuns.every(run => run.getElementsByTagNameNS(W, 'i').length === 1 && !run.getElementsByTagNameNS(W, 'vertAlign').length && run.getElementsByTagNameNS(W, 'position')[0]?.getAttributeNS(W, 'val') === '-2'), 'Estilo ou posição inline incorretos');
    assert(paragraphs[2].getElementsByTagNameNS(W, 'spacing')[0]?.getAttributeNS(W, 'lineRule') === 'atLeast', 'Altura exata ainda corta símbolos inline');
    checks.push('Dois símbolos no mesmo run: offsets originais, itálico, linha de base e altura sem corte: OK');

    const rels = parse(await zip.file('word/_rels/document.xml.rels')!.async('string'));
    const allIds = Array.from(rels.documentElement.children).map(el => el.getAttribute('Id'));
    assert(new Set(allIds).size === allIds.length, 'IDs de relacionamento colidiram');
    const types = parse(await zip.file('[Content_Types].xml')!.async('string'));
    assert(types.getElementsByTagNameNS(CONTENT, 'Default')[2].getAttribute('ContentType') === 'application/octet-stream', 'Tipo de imagens existentes alterado');
    const inserted = Array.from(types.getElementsByTagNameNS(CONTENT, 'Override')).filter(el => el.getAttribute('ContentType') === 'image/png');
    assert(inserted.length === 3 && inserted.every(el => zip.file(el.getAttribute('PartName')!.slice(1))), 'PNG sem tipo de conteúdo específico');
    assert(await zip.file('customXml/preserved.xml')!.async('string') === '<unchanged>metadados originais</unchanged>', 'Parte não selecionada alterada');
    assert((await zip.file('word/media/lume-equation-crop-1.png')!.async('uint8array')).join() === '1,2,3', 'Arquivo de mídia existente sobrescrito');
    assert((await inspectRepairDocument(original))[1].text === 'g = 2 cot F + J', 'Entrada original alterada');
    checks.push('ZIP: mídia existente, XML externo, entrada original, IDs e MIME PNG preservados: OK');

    const split = await fixture(`<w:p>${r('Antes a', '<w:b/>')}<w:bookmarkStart w:id="8" w:name="fragmento"/>${r('b', '<w:i/>')}<w:bookmarkEnd w:id="8"/>${r('c depois.', '<w:u w:val="single"/>')}</w:p><w:p><w:r><w:t>Um </w:t><w:t>F</w:t><w:t> final.</w:t></w:r></w:p>`);
    const splitResult = await applyEquationRepairs(await blob(split), [
      { ...image, kind: 'inline', paragraph: 0, startOffset: 6, endOffset: 9 },
      { ...image, kind: 'inline', paragraph: 1, startOffset: 3, endOffset: 4 },
    ]);
    const splitZip = await JSZip.loadAsync(await splitResult.arrayBuffer());
    const splitDoc = parse(await splitZip.file('word/document.xml')!.async('string'));
    const splitParagraphs = Array.from(splitDoc.getElementsByTagNameNS(W, 'p'));
    assert(text(splitParagraphs[0]) === 'Antes  depois.' && text(splitParagraphs[1]) === 'Um  final.', 'Texto fragmentado não substituído');
    assert(splitDoc.getElementsByTagNameNS(W, 'bookmarkStart').length === 1 && splitDoc.getElementsByTagNameNS(W, 'bookmarkEnd').length === 1, 'Bookmarks inline perdidos');
    assert(splitParagraphs[0].lastElementChild?.getElementsByTagNameNS(W, 'u').length === 1, 'Formato do sufixo perdido');
    checks.push('Trecho entre runs com estilos diferentes e vários w:t: fragmentos removidos, sufixos e bookmarks preservados: OK');

    await rejects(() => applyEquationRepairs(original, [repairs[0], { ...image, startParagraph: 2, endParagraph: 3 }]), /mesmo parágrafo/);
    await rejects(() => applyEquationRepairs(original, [repairs[1], { ...repairs[1], startOffset: 7, endOffset: 10 } as EquationRepair]), /mesmo parágrafo/);
    await rejects(() => applyEquationRepairs(original, [{ ...image, kind: 'inline', paragraph: 3, startOffset: 0, endOffset: 100 }]), /intervalo de texto/);
    await rejects(() => applyEquationRepairs(original, [{ ...image, image: new Uint8Array([0]), startParagraph: 1, endParagraph: 2 }]), /PNG/);
    checks.push('Reparos sobrepostos, offsets inválidos e PNG inválido recusados: OK');

    const section = await blob(await fixture(`<w:p><w:pPr><w:sectPr/></w:pPr>${r('Equação')}</w:p>`));
    await rejects(() => applyEquationRepairs(section, [{ ...image, startParagraph: 0, endParagraph: 0 }]), /quebra de seção/);
    const table = await blob(await fixture(`${p('Antes')}<w:tbl><w:tr><w:tc>${p('Célula')}</w:tc></w:tr></w:tbl>${p('Depois')}`));
    await rejects(() => applyEquationRepairs(table, [{ ...image, startParagraph: 0, endParagraph: 1 }]), /sem atravessar tabelas/);
    const field = await blob(await fixture(`<w:p>${r('ab')}<w:r><w:fldChar w:fldCharType="begin"/></w:r>${r('cd')}</w:p>`));
    await rejects(() => applyEquationRepairs(field, [{ ...image, kind: 'inline', paragraph: 0, startOffset: 1, endOffset: 3 }]), /campos ou estruturas/);
    checks.push('Quebras de seção, fronteiras de tabelas e campos no meio do trecho recusados: OK');

    const brokenXml = await fixture(p('válido')); brokenXml.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body>`);
    await rejects(() => inspectRepairDocument(new Blob(['invalid'])), /DOCX válido/);
    await rejects(async () => inspectRepairDocument(await blob(brokenXml)), /XML inválida/);
    const traversal = await fixture(p('válido')); traversal.file('../outside.xml', 'unsafe');
    await rejects(async () => inspectRepairDocument(await blob(traversal)), /caminho interno/);
    checks.push('ZIP inválido, XML truncado e caminho externo recusados: OK');

    await renderAsync(repaired, output, undefined, { useBase64URL: true });
    const images = Array.from(output.querySelectorAll('img'));
    assert(images.length === 3, `Word renderizou ${images.length}/3 recortes`);
    await Promise.all(images.map(img => img.decode()));
    assert(images.every(img => img.naturalWidth === 900 && img.naturalHeight === 180), 'Bytes originais dos recortes foram alterados');
    assert(output.textContent?.includes('Texto posterior permanece.'), 'Renderização perdeu texto após a equação');
    checks.push('DOCX reparado renderizado: três PNGs decodificados, dimensões originais e texto posterior presentes: OK');

    const preview = await renderWordPages(repaired, () => undefined);
    try {
      const crops = preview.pages.flatMap(page => Array.from(page.querySelectorAll<HTMLImageElement>('img[data-source-equation="true"]')));
      assert(crops.length === 3 && crops.every(crop => crop.dataset.equation === 'true' && crop.naturalWidth === 900), 'Paginação perdeu identificação ou resolução dos recortes');
    } finally { preview.dispose(); }
    const pdf = await PDFDocument.load(await (await createPdf(repaired, 'repaired.docx', () => undefined)).arrayBuffer());
    const streams = pdf.context.enumerateIndirectObjects().map(([, value]) => value).filter((value): value is PDFRawStream => value instanceof PDFRawStream);
    const preservedImages = streams.filter(stream => stream.dict.get(PDFName.of('Subtype'))?.toString() === '/Image' && stream.dict.get(PDFName.of('Width'))?.toString() === '900' && stream.dict.get(PDFName.of('Height'))?.toString() === '180');
    assert(preservedImages.length >= 1, 'PDF final não contém a imagem na resolução original');
    const paintCommands = streams.filter(stream => !stream.dict.has(PDFName.of('Subtype'))).map(stream => new TextDecoder().decode(decodePDFRawStream(stream).decode())).join('\n').match(/\/I\d+\s+Do/g) ?? [];
    assert(paintCommands.length === pdf.getPageCount() + 3, 'PDF não sobrepôs os três recortes em alta resolução');
    assert(document.querySelectorAll('.pdf-render-host').length === 0, 'Conversão deixou iframe temporário');
    checks.push('PDF final: três recortes identificados, resolução 900×180 preservada e três sobreposições após a página rasterizada: OK');
    result.textContent = checks.join('\n'); result.dataset.status = 'passed';
  } catch (error) {
    result.textContent = `${checks.join('\n')}\nFALHA: ${error instanceof Error ? error.stack : String(error)}`; result.dataset.status = 'failed';
  } finally { button.disabled = false; }
}
document.querySelector('#run')!.addEventListener('click', run);
if (new URLSearchParams(location.search).get('autorun') === '1') void run();
