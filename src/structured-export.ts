import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import regularFontUrl from './fonts/NotoSerif-Regular.ttf?url';
import boldFontUrl from './fonts/NotoSerif-Bold.ttf?url';
import italicFontUrl from './fonts/NotoSerif-Italic.ttf?url';
import boldItalicFontUrl from './fonts/NotoSerif-BoldItalic.ttf?url';
import { abortIfNeeded, sha256, translatableBlocks, type ContentRun, type DocumentAsset, type DocumentBlock, type RunStyle, type StructuredDocument, type TranslatedDocument } from './structured-document';

const PAGE = { width: 612, height: 792, margin: 54 };
const WIDTH = PAGE.width - PAGE.margin * 2;
const HEIGHT = PAGE.height - PAGE.margin * 2;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);

type Ready = { assets: Map<string, DocumentAsset>; runs: Map<string, ContentRun[]>; captions: Set<string> };
const isVisual = (block: DocumentBlock) => ['equation', 'figure', 'table'].includes(block.kind);
function refs(runs: ContentRun[]) { return runs.filter(run => run.type === 'asset').map(run => run.assetId).sort(); }
function validText(value: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) {
    throw new Error('O documento contém caracteres inválidos. Revise o bloco de texto antes de exportar.');
  }
}
function imageSize(asset: DocumentAsset, maxHeight = HEIGHT) {
  const scale = Math.min(1, WIDTH / asset.widthPt, maxHeight / asset.heightPt);
  return { width: asset.widthPt * scale, height: asset.heightPt * scale };
}
function textSize(block: DocumentBlock) {
  return block.kind === 'heading' ? Math.min(20, Math.max(14, block.fontSize)) : block.kind === 'caption' ? 10 : 11;
}
async function prepare(translated: TranslatedDocument, signal?: AbortSignal): Promise<Ready> {
  abortIfNeeded(signal);
  const source = translated.document;
  if (source.version !== 1 || source.sourceKind !== 'pdf') throw new Error('Formato estruturado não suportado nesta versão.');
  if (!source.blocks.length || !source.pages.length) throw new Error('O documento não contém blocos suficientes para montar os arquivos.');
  for (const text of [source.sourceName, source.sourceHash, translated.sourceLanguage, translated.targetLanguage]) validText(text);
  const blocking = source.issues.filter(issue => issue.severity === 'blocking');
  if (blocking.length) throw new Error(`Revise o documento antes de exportar: ${blocking[0].message}`);
  const assets = new Map<string, DocumentAsset>();
  for (const asset of source.assets) {
    abortIfNeeded(signal);
    if (assets.has(asset.id)) throw new Error(`Objeto repetido no mapa do documento: ${asset.id}.`);
    if (![asset.widthPt, asset.heightPt].every(value => Number.isFinite(value) && value > 0) || (asset.baselineOffsetPt !== undefined && !Number.isFinite(asset.baselineOffsetPt))) throw new Error(`Dimensões inválidas do objeto ${asset.id}.`);
    const bytes = asset.png;
    if (bytes.length < 24 || bytes.slice(0, 8).join() !== '137,80,78,71,13,10,26,10' || new TextDecoder().decode(bytes.slice(12, 16)) !== 'IHDR') throw new Error(`O objeto ${asset.id} não contém uma imagem PNG válida.`);
    if (await sha256(bytes) !== asset.sha256) throw new Error(`A imagem original do objeto ${asset.id} foi alterada.`);
    validText(asset.id); validText(asset.alt);
    assets.set(asset.id, asset);
  }
  const blocks = new Map<string, DocumentBlock>();
  const runs = new Map<string, ContentRun[]>();
  const captions = new Set<string>();
  const referencedAssets = new Set<string>();
  const translatable = new Set(translatableBlocks(source).map(block => block.id));
  for (const id of Object.keys(translated.blocks)) if (!source.blocks.some(block => block.id === id)) throw new Error(`Bloco desconhecido na tradução: ${id}.`);
  for (const block of source.blocks) {
    if (blocks.has(block.id)) throw new Error(`Bloco repetido no mapa do documento: ${block.id}.`);
    if (!Number.isInteger(block.page) || block.page < 1 || block.page > source.pages.length || !Number.isFinite(block.fontSize) || block.fontSize <= 0) throw new Error(`Página ou tamanho de fonte inválido no bloco ${block.id}.`);
    validText(block.id);
    blocks.set(block.id, block);
    const content = translated.blocks[block.id] ?? (translatable.has(block.id) ? undefined : block.runs);
    if (!content) throw new Error(`A tradução do bloco ${block.id} está ausente.`);
    if (translatable.has(block.id) && !content.some(run => run.type === 'text' && run.text.trim())) throw new Error(`A tradução do bloco ${block.id} está vazia.`);
    if (JSON.stringify(refs(content)) !== JSON.stringify(refs(block.runs))) throw new Error(`A tradução alterou os objetos protegidos no bloco ${block.id}.`);
    for (const run of content) {
      if (run.type === 'text') validText(run.text);
      else if (!assets.has(run.assetId)) throw new Error(`O objeto ${run.assetId} está ausente.`);
      else referencedAssets.add(run.assetId);
    }
    if (isVisual(block) && (!block.assetId || !assets.has(block.assetId))) throw new Error(`A imagem do bloco ${block.id} está ausente.`);
    if (isVisual(block)) referencedAssets.add(block.assetId!);
    else if (block.assetId) throw new Error(`A associação de imagem do bloco ${block.id} é inválida.`);
    runs.set(block.id, content);
  }
  for (const block of source.blocks) if (block.captionId) {
    if (!['figure', 'table'].includes(block.kind) || blocks.get(block.captionId)?.kind !== 'caption' || captions.has(block.captionId)) throw new Error(`Associação de legenda inválida no bloco ${block.id}.`);
    captions.add(block.captionId);
  }
  for (const asset of assets.values()) if (!referencedAssets.has(asset.id)) throw new Error(`O objeto ${asset.id} não possui posição no documento. Revise sua associação antes de traduzir.`);
  abortIfNeeded(signal);
  return { assets, runs, captions };
}

/** Runs export integrity checks before any billable translation request. */
export async function validateStructuredSource(document: StructuredDocument, signal?: AbortSignal): Promise<void> {
  await prepare({ document, blocks: Object.fromEntries(document.blocks.map(block => [block.id, block.runs])), sourceLanguage: '', targetLanguage: '' }, signal);
}

/** Rebuilds a single-column Word document. Source PNG bytes are embedded without resizing. */
export async function createStructuredDocx(translated: TranslatedDocument, onProgress: (status: string) => void = () => undefined, signal?: AbortSignal): Promise<Blob> {
  onProgress('Conferindo texto, equações e imagens…');
  const ready = await prepare(translated, signal);
  const zip = new JSZip();
  const imageRels: string[] = [];
  const relById = new Map<string, string>();
  let imageIndex = 0;
  for (const asset of ready.assets.values()) {
    const id = `rIdImage${++imageIndex}`;
    const name = `preserved-${imageIndex}.png`;
    zip.file(`word/media/${name}`, asset.png);
    imageRels.push(`<Relationship Id="${id}" Type="${R}/image" Target="media/${name}"/>`);
    relById.set(asset.id, id);
  }
  let drawingId = 0;
  let bookmarkId = 0;
  const bookmarkNames = new Map<string, string>();
  const bookmark = (blockId: string, body: string) => { const id = ++bookmarkId; bookmarkNames.set(blockId, `lume_block_${id}`); return `<w:bookmarkStart w:id="${id}" w:name="lume_block_${id}"/>${body}<w:bookmarkEnd w:id="${id}"/>`; };
  const image = (asset: DocumentAsset, maxHeight?: number, inline = false) => {
    const size = inline ? { width: asset.widthPt, height: asset.heightPt } : imageSize(asset, maxHeight);
    if (size.width > WIDTH || size.height + Math.abs(asset.baselineOffsetPt ?? 0) > HEIGHT) throw new Error(`O símbolo ${asset.id} é grande demais para ficar dentro do texto.`);
    const cx = Math.round(size.width * 12700), cy = Math.round(size.height * 12700), id = ++drawingId;
    const position = inline && asset.baselineOffsetPt ? `<w:rPr><w:position w:val="${Math.round(asset.baselineOffsetPt * 2)}"/></w:rPr>` : '';
    return `<w:r>${position}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${xml(asset.id)}" descr="${xml(asset.alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${xml(asset.id)}" descr="${xml(asset.alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relById.get(asset.id)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };
  const renderRuns = (block: DocumentBlock) => ready.runs.get(block.id)!.map(run => {
    if (run.type === 'asset') return image(ready.assets.get(run.assetId)!, undefined, true);
    const props = `${run.style?.bold ? '<w:b/>' : ''}${run.style?.italic ? '<w:i/>' : ''}${run.style?.superscript ? '<w:vertAlign w:val="superscript"/>' : ''}${block.kind === 'heading' ? `<w:sz w:val="${Math.round(textSize(block) * 2)}"/>` : ''}`;
    return run.text.split(/(\n|\t)/).map(part => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${part === '\n' ? '<w:br/>' : part === '\t' ? '<w:tab/>' : `<w:t xml:space="preserve">${xml(part)}</w:t>`}</w:r>`).join('');
  }).join('');
  const paragraph = (block: DocumentBlock, keep = false) => `<w:p><w:pPr><w:pStyle w:val="${block.kind === 'heading' ? 'Heading1' : block.kind === 'caption' ? 'Caption' : 'Normal'}"/>${keep || block.kind === 'heading' ? '<w:keepNext/>' : ''}<w:widowControl/><w:spacing w:after="${block.kind === 'caption' ? 160 : 140}" w:line="276" w:lineRule="auto"/></w:pPr>${bookmark(block.id, renderRuns(block))}</w:p>`;
  const body: string[] = [];
  for (const block of translated.document.blocks) {
    abortIfNeeded(signal);
    if (ready.captions.has(block.id)) continue;
    if (!isVisual(block)) { body.push(paragraph(block)); continue; }
    const caption = block.captionId ? translated.document.blocks.find(value => value.id === block.captionId)! : undefined;
    // Reserve enough room for the complete caption; Word keeps the two paragraphs together.
    const captionLength = caption ? ready.runs.get(caption.id)!.map(run => run.type === 'text' ? run.text : ' ').join('').length : 0;
    const captionHeight = caption ? Math.ceil(captionLength / 82) * 14 + 20 : 0;
    if (captionHeight > HEIGHT / 2) throw new Error(`A legenda ${caption!.id} é longa demais para acompanhar a figura numa página.`);
    body.push(`<w:p><w:pPr><w:jc w:val="center"/><w:keepLines/>${caption ? '<w:keepNext/>' : ''}<w:spacing w:before="100" w:after="100" w:line="240" w:lineRule="auto"/></w:pPr>${bookmark(block.id, image(ready.assets.get(block.assetId!)!, HEIGHT - captionHeight - 20))}</w:p>`);
    if (caption) body.push(paragraph(caption));
  }
  onProgress('Montando o Word com os elementos preservados…');
  const namespaces = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  zip.file('_rels/.rels', `<Relationships xmlns="${REL}"><Relationship Id="rIdOffice" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('docProps/core.xml', `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(translated.document.sourceName)}</dc:title><dc:creator>Lume</dc:creator><dc:language>${xml(translated.targetLanguage)}</dc:language></cp:coreProperties>`);
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="${REL}"><Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rIdManifest" Type="${R}/customXml" Target="../customXml/item1.xml"/>${imageRels.join('')}</Relationships>`);
  zip.file('word/styles.xml', `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="22"/><w:color w:val="000000"/><w:lang w:val="${xml(translated.targetLanguage.toLowerCase())}"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="000000"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:pPr><w:keepLines/></w:pPr><w:rPr><w:sz w:val="20"/><w:color w:val="000000"/></w:rPr></w:style></w:styles>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${namespaces}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="540" w:footer="540"/></w:sectPr></w:body></w:document>`);
  zip.file('customXml/item1.xml', `<lume xmlns="urn:lume:structured-document" version="1"><sourceHash>${xml(translated.document.sourceHash)}</sourceHash>${translated.document.blocks.map(block => `<block bookmark="${bookmarkNames.get(block.id)}" id="${xml(block.id)}" page="${block.page}"/>`).join('')}</lume>`);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  abortIfNeeded(signal);
  return new Blob([new Uint8Array(bytes).buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };
let unicodeFontBytes: Promise<Uint8Array[]> | undefined;
async function documentFonts(pdf: PDFDocument, ready: Ready, signal?: AbortSignal): Promise<Fonts> {
  const standard = await pdf.embedFont(StandardFonts.TimesRoman);
  const characters = new Set([...ready.runs.values()].flatMap(runs => runs.flatMap(r => r.type === 'text' ? [...r.text.replace(/[\r\n\t]/g, '')] : [])));
  const needsUnicode = [...characters].some(char => { try { standard.encodeText(char); return false; } catch { return true; } });
  if (!needsUnicode) return { regular: standard, bold: await pdf.embedFont(StandardFonts.TimesRomanBold), italic: await pdf.embedFont(StandardFonts.TimesRomanItalic), boldItalic: await pdf.embedFont(StandardFonts.TimesRomanBoldItalic) };
  abortIfNeeded(signal);
  const { default: fontkit } = await import('@pdf-lib/fontkit');
  pdf.registerFontkit(fontkit);
  // These licensed fonts are application assets. No document is persisted.
  unicodeFontBytes ??= Promise.all([regularFontUrl, boldFontUrl, italicFontUrl, boldItalicFontUrl].map(async url => {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error('Não foi possível carregar a fonte do PDF. Tente gerar o arquivo novamente.');
    return new Uint8Array(await response.arrayBuffer());
  })).catch(error => { unicodeFontBytes = undefined; throw error; });
  const bytes = await unicodeFontBytes;
  abortIfNeeded(signal);
  const [regular, bold, italic, boldItalic] = await Promise.all(bytes.map(data => pdf.embedFont(data, { subset: true })));
  for (const font of [regular, bold, italic, boldItalic]) {
    const supported = new Set(font.getCharacterSet());
    const missing = [...characters].find(char => !supported.has(char.codePointAt(0)!));
    if (missing) throw new Error(`A fonte do PDF não suporta o caractere “${missing}” (U+${missing.codePointAt(0)!.toString(16).toUpperCase()}). Preserve o símbolo como imagem ou exporte o Word.`);
  }
  return { regular, bold, italic, boldItalic };
}
type Piece = { type: 'text'; text: string; style?: RunStyle; width: number; size: number } | { type: 'asset'; asset: DocumentAsset; width: number };
type Line = { pieces: Piece[]; width: number; above: number; below: number; height: number };
function fontFor(fonts: Fonts, style?: RunStyle) { return style?.bold ? style?.italic ? fonts.boldItalic : fonts.bold : style?.italic ? fonts.italic : fonts.regular; }
function wrap(runs: ContentRun[], size: number, fonts: Fonts, assets: Map<string, DocumentAsset>, bold = false): Line[] {
  const lines: Line[] = [];
  let line: Line = { pieces: [], width: 0, above: size * .84, below: size * .3, height: 0 };
  const finish = () => { line.height = Math.max(size * 1.25, line.above + line.below + 2); lines.push(line); line = { pieces: [], width: 0, above: size * .84, below: size * .3, height: 0 }; };
  const add = (piece: Piece) => {
    if (piece.width > WIDTH) throw new Error('Há um objeto maior que a largura da página. Revise o documento.');
    if (line.width + piece.width > WIDTH && line.pieces.length) finish();
    if (piece.type === 'text' && /^\s+$/u.test(piece.text) && !line.pieces.length) return;
    line.pieces.push(piece); line.width += piece.width;
    if (piece.type === 'asset') {
      const offset = piece.asset.baselineOffsetPt ?? 0;
      line.above = Math.max(line.above, piece.asset.heightPt + offset);
      line.below = Math.max(line.below, -offset);
    } else if (piece.style?.superscript) line.above = Math.max(line.above, piece.size * .84 + size * .35);
  };
  for (const run of runs) {
    if (run.type === 'asset') { const asset = assets.get(run.assetId)!; add({ type: 'asset', asset, width: asset.widthPt }); continue; }
    const style = { ...run.style, bold: run.style?.bold || bold };
    const font = fontFor(fonts, style), drawSize = size * (style.superscript ? .75 : 1);
    for (const token of run.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split(/(\n|[^\S\n]+)/u).filter(Boolean)) {
      if (token === '\n') { finish(); continue; }
      let width: number;
      try { width = font.widthOfTextAtSize(token, drawSize); } catch {
        const unsupported = [...token].find(char => { try { font.encodeText(char); return false; } catch { return true; } });
        throw new Error(`O PDF desta versão não suporta o caractere ${unsupported ? `“${unsupported}” (U+${unsupported.codePointAt(0)!.toString(16).toUpperCase()})` : 'encontrado'}. Preserve o símbolo como imagem ou exporte o Word.`);
      }
      if (width <= WIDTH) { add({ type: 'text', text: token, style, width, size: drawSize }); continue; }
      let chunk = '';
      for (const char of token) {
        if (chunk && font.widthOfTextAtSize(chunk + char, drawSize) > WIDTH) {
          add({ type: 'text', text: chunk, style, width: font.widthOfTextAtSize(chunk, drawSize), size: drawSize }); finish(); chunk = '';
        }
        chunk += char;
      }
      if (chunk) add({ type: 'text', text: chunk, style, width: font.widthOfTextAtSize(chunk, drawSize), size: drawSize });
    }
  }
  if (line.pieces.length || !lines.length) finish();
  for (const item of lines) if (item.height > HEIGHT) throw new Error('Um símbolo dentro do texto é maior que a altura da página. Revise o documento.');
  return lines;
}

/** Selectable text is drawn as PDF text; equations and figures keep source pixels. */
export async function createStructuredPdf(translated: TranslatedDocument, onProgress: (status: string) => void = () => undefined, signal?: AbortSignal): Promise<Blob> {
  onProgress('Conferindo os elementos e preparando o PDF…');
  const ready = await prepare(translated, signal);
  const pdf = await PDFDocument.create();
  const fonts = await documentFonts(pdf, ready, signal);
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();
  for (const asset of ready.assets.values()) { abortIfNeeded(signal); images.set(asset.id, await pdf.embedPng(asset.png)); }
  const layouts = new Map<string, Line[]>();
  for (const block of translated.document.blocks) if (!isVisual(block)) layouts.set(block.id, wrap(ready.runs.get(block.id)!, textSize(block), fonts, ready.assets, block.kind === 'heading'));
  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let top = PAGE.height - PAGE.margin;
  const nextPage = () => { page = pdf.addPage([PAGE.width, PAGE.height]); top = PAGE.height - PAGE.margin; if (pdf.getPageCount() > 300) throw new Error('O documento excede o limite de 300 páginas desta versão.'); };
  const ensure = (height: number) => { if (height > HEIGHT) throw new Error('Um elemento não cabe numa página. Revise suas dimensões.'); if (top - height < PAGE.margin) nextPage(); };
  const drawLines = (lines: Line[], size: number) => {
    for (const line of lines) {
      abortIfNeeded(signal); ensure(line.height);
      const baseline = top - line.above;
      let x = PAGE.margin;
      for (const piece of line.pieces) {
        if (piece.type === 'asset') page.drawImage(images.get(piece.asset.id)!, { x, y: baseline + (piece.asset.baselineOffsetPt ?? 0), width: piece.width, height: piece.asset.heightPt });
        else page.drawText(piece.text, { x, y: baseline + (piece.style?.superscript ? size * .35 : 0), size: piece.size, font: fontFor(fonts, piece.style), color: rgb(0, 0, 0) });
        x += piece.width;
      }
      top -= line.height;
    }
  };
  for (let index = 0; index < translated.document.blocks.length; index++) {
    const block = translated.document.blocks[index];
    abortIfNeeded(signal);
    if (ready.captions.has(block.id)) continue;
    onProgress(`Montando o PDF: bloco ${index + 1} de ${translated.document.blocks.length}…`);
    if (!isVisual(block)) {
      const lines = layouts.get(block.id)!;
      if (block.kind === 'heading') {
        const next = translated.document.blocks.slice(index + 1).find(value => !ready.captions.has(value.id));
        const nextHeight = next && layouts.has(next.id) ? layouts.get(next.id)!.slice(0, 2).reduce((sum, line) => sum + line.height, 0) : 20;
        const headingHeight = lines.reduce((sum, line) => sum + line.height, 0);
        ensure(Math.min(HEIGHT, headingHeight + nextHeight + 8));
      } else ensure(lines.slice(0, 2).reduce((sum, line) => sum + line.height, 0));
      drawLines(lines, textSize(block)); top -= 8;
      continue;
    }
    const caption = block.captionId ? translated.document.blocks.find(value => value.id === block.captionId)! : undefined;
    const captionLines = caption ? layouts.get(caption.id)! : [];
    const captionHeight = captionLines.reduce((sum, line) => sum + line.height, 0);
    if (captionHeight > HEIGHT / 2) throw new Error(`A legenda ${caption!.id} é longa demais para acompanhar a figura numa página.`);
    const asset = ready.assets.get(block.assetId!)!;
    const size = imageSize(asset, HEIGHT - captionHeight - 24);
    ensure(size.height + captionHeight + 24);
    top -= 6;
    page.drawImage(images.get(asset.id)!, { x: PAGE.margin + (WIDTH - size.width) / 2, y: top - size.height, width: size.width, height: size.height });
    top -= size.height + 6;
    if (caption) drawLines(captionLines, textSize(caption));
    top -= 12;
  }
  for (let index = 0; index < pdf.getPageCount(); index++) pdf.getPage(index).drawText(String(index + 1), { x: PAGE.width / 2 - 3, y: 27, font: fonts.regular, size: 9 });
  pdf.setTitle(translated.document.sourceName); pdf.setCreator('Lume'); pdf.setSubject(`Tradução ${translated.sourceLanguage} → ${translated.targetLanguage}`);
  abortIfNeeded(signal);
  const bytes = await pdf.save();
  abortIfNeeded(signal);
  return new Blob([new Uint8Array(bytes).buffer], { type: 'application/pdf' });
}
