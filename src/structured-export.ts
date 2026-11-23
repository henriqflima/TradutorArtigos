import { renderStructuredPdf } from './pdf-renderer';
import { captionAboveVisual } from './caption-links';
import type { PdfLayoutReport } from './pdf-layout';
import JSZip from 'jszip';
import { splitMathRuns } from './inline-math';
import { abortIfNeeded, sha256, translatableBlocks, type ContentRun, type DocumentAsset, type DocumentBlock, type StructuredDocument, type TranslatedDocument } from './structured-document';

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

/** Materialize recognized math only for export. Source validation stays DOM-free and original assets stay unchanged. */
async function prepareMath(ready: Ready, document: StructuredDocument, format: 'pdf' | 'docx', onProgress: (status: string) => void,
  signal?: AbortSignal): Promise<void> {
  const cache = new Map<string, Promise<DocumentAsset>>();
  let ordinal = 0;
  for (const block of document.blocks) {
    abortIfNeeded(signal);
    if (isVisual(block) || block.sourceRole === 'code') continue;
    const output: ContentRun[] = [];
    for (const segment of splitMathRuns(ready.runs.get(block.id)!)) {
        if (segment.type !== 'math') { output.push(segment); continue; }
        abortIfNeeded(signal);
        const style = segment.style;
        const bold = Boolean(style?.bold || block.kind === 'heading' || format === 'pdf' && block.appearance?.bold);
        const baseSize = format === 'docx' ? textSize(block) : Math.min(block.kind === 'heading' ? 44 : 24, Math.max(8, block.appearance?.fontSize ?? block.fontSize));
        const size = baseSize * (style?.superscript ? .75 : 1);
        const key = JSON.stringify([segment.tex, size, segment.display, Boolean(style?.superscript), bold]);
        let pending = cache.get(key);
        if (!pending) {
          pending = (async () => {
            onProgress('Preparando os símbolos matemáticos dentro do texto…');
            const { rasterizeInlineMath } = await import('./inline-math-renderer');
            let image: Awaited<ReturnType<typeof rasterizeInlineMath>>;
            try { image = await rasterizeInlineMath(segment.tex, size, segment.display, { bold }); }
            catch {
              throw new Error(`Não foi possível montar a expressão matemática “${segment.text.slice(0, 120)}” do bloco ${block.id}. Confira a expressão reconhecida ou preserve-a como recorte do original.`);
            }
            abortIfNeeded(signal);
            let id: string;
            do { id = `lume-inline-math-${++ordinal}`; } while (ready.assets.has(id));
            const asset: DocumentAsset = { id, kind: 'equation-inline', page: block.page, rect: { ...block.rect },
              png: image.png, dataUrl: '', widthPt: image.widthPt, heightPt: image.heightPt,
              baselineOffsetPt: image.baselineOffsetPt + (style?.superscript ? baseSize * .35 : 0),
              sha256: await sha256(image.png), alt: `Expressão matemática reconhecida: ${segment.tex}` };
            ready.assets.set(id, asset);
            return asset;
          })();
          cache.set(key, pending);
        }
        const asset = await pending;
        output.push({ type: 'asset', assetId: asset.id });
    }
    ready.runs.set(block.id, output);
  }
}

/** Runs export integrity checks before any billable translation request. */
export async function validateStructuredSource(document: StructuredDocument, signal?: AbortSignal): Promise<void> {
  await prepare({ document, blocks: Object.fromEntries(document.blocks.map(block => [block.id, block.runs])), sourceLanguage: '', targetLanguage: '' }, signal);
}

/** Rebuilds a single-column Word document. Source PNG bytes are embedded without resizing. */
export async function createStructuredDocx(translated: TranslatedDocument, onProgress: (status: string) => void = () => undefined, signal?: AbortSignal): Promise<Blob> {
  onProgress('Conferindo texto, equações e imagens…');
  const ready = await prepare(translated, signal);
  await prepareMath(ready, translated.document, 'docx', onProgress, signal);
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
    const captionAbove = Boolean(caption && captionAboveVisual(caption, block));
    // Reserve enough room for the complete caption; Word keeps the two paragraphs together.
    const captionLength = caption ? ready.runs.get(caption.id)!.map(run => run.type === 'text' ? run.text : ' ').join('').length : 0;
    const captionHeight = caption ? Math.ceil(captionLength / 82) * 14 + 20 : 0;
    if (captionHeight > HEIGHT / 2) throw new Error(`A legenda ${caption!.id} é longa demais para acompanhar a figura numa página.`);
    if (caption && captionAbove) body.push(paragraph(caption, true));
    body.push(`<w:p><w:pPr><w:jc w:val="center"/><w:keepLines/>${caption && !captionAbove ? '<w:keepNext/>' : ''}<w:spacing w:before="100" w:after="100" w:line="240" w:lineRule="auto"/></w:pPr>${bookmark(block.id, image(ready.assets.get(block.assetId!)!, HEIGHT - captionHeight - 20))}</w:p>`);
    if (caption && !captionAbove) body.push(paragraph(caption));
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

/** Source-informed PDF layout with selectable translated text and unchanged source crops. */
export async function createStructuredPdf(translated: TranslatedDocument, onProgress: (status: string) => void = () => undefined,
  signal?: AbortSignal, onLayout?: (report: PdfLayoutReport) => void): Promise<Blob> {
  onProgress('Conferindo os elementos e preparando o PDF…');
  const ready = await prepare(translated, signal);
  await prepareMath(ready, translated.document, 'pdf', onProgress, signal);
  return renderStructuredPdf(translated, ready, onProgress, signal, onLayout);
}
