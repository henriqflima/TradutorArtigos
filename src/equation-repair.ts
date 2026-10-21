import JSZip from 'jszip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 3000;

export type RepairParagraph = { index: number; text: string; hasDrawing: boolean; hasMath: boolean };
export type RepairImage = { image: Uint8Array; widthPt: number; heightPt: number; alt: string; baselineOffsetPt?: number };
export type BlockEquationRepair = RepairImage & {
  kind?: 'block'; startParagraph: number; endParagraph: number;
};
export type InlineEquationRepair = RepairImage & {
  kind: 'inline'; paragraph: number; startOffset: number; endOffset: number;
};
/** Indices and UTF-16 text offsets always refer to the unmodified input DOCX. */
export type EquationRepair = BlockEquationRepair | InlineEquationRepair;

function parseXml(text: string, name: string, namespace: string, root: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(`${name}: XML com entidades não é aceito.`);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement.namespaceURI !== namespace || doc.documentElement.localName !== root) {
    throw new Error(`${name}: estrutura XML inválida ou formato Word não compatível.`);
  }
  return doc;
}

async function openPackage(blob: Blob) {
  if (!blob.size || blob.size > MAX_BYTES) throw new Error('O Word deve ter até 40 MB e não pode estar vazio.');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(await blob.arrayBuffer()); }
  catch { throw new Error('Não foi possível abrir o Word. Selecione um arquivo DOCX válido.'); }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error('O Word contém mais de 3000 arquivos internos.');
  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    // JSZip exposes the central-directory uncompressed size on loaded entries.
    // Check it before asking the inflater to allocate an XML part.
    const size = (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || (total += size) > MAX_BYTES) throw new Error('O conteúdo descompactado do Word excede 40 MB.');
    if (entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').includes('..') ||
      (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)) throw new Error('O Word contém um caminho interno inválido.');
  }
  const xml = parseXml(await readPart(zip, 'word/document.xml'), 'Documento', W, 'document');
  const body = Array.from(xml.documentElement.children).find(el => el.namespaceURI === W && el.localName === 'body');
  if (!body) throw new Error('O Word não possui o corpo principal do documento.');
  const paragraphs = Array.from(body.getElementsByTagNameNS(W, 'p')).filter(p => {
    for (let ancestor = p.parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
      if (ancestor.namespaceURI === W && (ancestor.localName === 'p' || ancestor.localName === 'txbxContent')) return false;
    }
    return true;
  });
  return { zip, xml, paragraphs, total };
}

async function readPart(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`O Word não contém ${path}.`);
  // Streaming also checks actual expanded data rather than trusting ZIP metadata.
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let length = 0, failed = false;
    const stream = (file as JSZip.JSZipObject & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream('uint8array');
    stream.on('data', chunk => {
      if (failed) return;
      length += chunk.byteLength;
      if (length > MAX_BYTES) {
        failed = true; stream.pause(); reject(new Error('Uma parte XML do Word excede 40 MB.')); return;
      }
      chunks.push(chunk);
    });
    stream.on('error', () => reject(new Error('O Word contém uma parte ZIP inválida.')));
    stream.on('end', () => {
      if (failed) return;
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      resolve(result);
    });
    stream.resume();
  });
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function ownTextNodes(paragraph: Element) {
  return Array.from(paragraph.getElementsByTagNameNS(W, 't')).filter(text => {
    for (let ancestor = text.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.namespaceURI === W && ancestor.localName === 'p') return ancestor === paragraph;
    }
    return false;
  });
}

export async function inspectRepairDocument(blob: Blob): Promise<RepairParagraph[]> {
  const { paragraphs } = await openPackage(blob);
  return paragraphs.map((paragraph, index) => ({
    index, text: ownTextNodes(paragraph).map(node => node.textContent ?? '').join(''),
    hasDrawing: ['drawing', 'pict', 'object'].some(name => paragraph.getElementsByTagNameNS(W, name).length > 0),
    hasMath: paragraph.getElementsByTagNameNS(M, 'oMath').length > 0,
  }));
}

function validateImage(repair: RepairImage) {
  const image = repair.image;
  if (!(image instanceof Uint8Array) || image.length < 33 || image.length > 16 * 1024 * 1024 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => image[index] === value)) {
    throw new Error('O recorte deve ser uma imagem PNG válida de até 16 MB.');
  }
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error('O cabeçalho do recorte PNG é inválido.');
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > 10000 || height > 10000 || width * height > 40_000_000) throw new Error('O recorte PNG deve ter até 10000 pixels por lado e 40 milhões de pixels.');
  if (![repair.widthPt, repair.heightPt].every(size => Number.isFinite(size) && size >= 0.5 && size <= 2000)) {
    throw new Error('Informe um tamanho de recorte entre 0,5 e 2000 pontos.');
  }
  if (typeof repair.alt !== 'string' || repair.alt.length > 2000) throw new Error('A descrição do recorte deve ter até 2000 caracteres.');
  if (repair.baselineOffsetPt !== undefined && (!Number.isFinite(repair.baselineOffsetPt) || Math.abs(repair.baselineOffsetPt) > repair.heightPt)) throw new Error('O ajuste da linha de base deve estar dentro da altura do recorte.');
}

const firstParagraph = (repair: EquationRepair) => repair.kind === 'inline' ? repair.paragraph : repair.startParagraph;
const lastParagraph = (repair: EquationRepair) => repair.kind === 'inline' ? repair.paragraph : repair.endParagraph;
const direct = (element: Element, name: string) => Array.from(element.children).find(child => child.namespaceURI === W && child.localName === name);

function inlineTarget(paragraph: Element, repair: InlineEquationRepair) {
  const targets: { run: Element; start: number; end: number; value: string }[] = [];
  const seenRuns = new Set<Element>();
  let offset = 0;
  for (const text of ownTextNodes(paragraph)) {
    const run = text.parentElement!;
    if (seenRuns.has(run)) continue;
    seenRuns.add(run);
    const value = Array.from(run.children).filter(child => child.namespaceURI === W && child.localName === 't').map(child => child.textContent ?? '').join('');
    const length = value.length;
    if (repair.startOffset < offset + length && repair.endOffset > offset) {
      const simpleRun = run.namespaceURI === W && run.localName === 'r' &&
        Array.from(run.children).every(child => child.namespaceURI === W && (child.localName === 't' || child.localName === 'rPr'));
      let supportedContainer = true;
      for (let parent = run.parentElement; parent && parent !== paragraph; parent = parent.parentElement) {
        if (parent.namespaceURI !== W || parent.localName !== 'hyperlink') supportedContainer = false;
      }
      if (!simpleRun || !supportedContainer) throw new Error('Esse trecho possui campos ou estruturas especiais. Escolha um trecho simples ou substitua o parágrafo inteiro.');
      targets.push({ run, value, start: Math.max(0, repair.startOffset - offset), end: Math.min(length, repair.endOffset - offset) });
    }
    offset += length;
  }
  if (!targets.length) throw new Error('O trecho de texto selecionado não foi encontrado.');
  const container = targets[0].run.parentElement;
  if (targets.some(target => target.run.parentElement !== container)) throw new Error('O trecho atravessa um link ou outra estrutura do Word. Selecione um símbolo por vez ou substitua o parágrafo inteiro.');
  const runs = new Set(targets.map(target => target.run));
  for (let sibling: Element | null = targets[0].run; sibling; sibling = sibling.nextElementSibling) {
    // Never silently remove a field, drawing, tab or tracked change between runs.
    if (!runs.has(sibling) && !(sibling.namespaceURI === W && ['bookmarkStart', 'bookmarkEnd', 'proofErr'].includes(sibling.localName))) {
      throw new Error('Esse trecho possui campos ou estruturas especiais. Escolha um trecho simples ou substitua o parágrafo inteiro.');
    }
    if (sibling === targets[targets.length - 1].run) break;
  }
  return targets;
}

function validateRepairs(paragraphs: Element[], repairs: readonly EquationRepair[]) {
  if (!repairs.length || repairs.length > 200) throw new Error('Selecione de 1 a 200 reparos por documento.');
  for (const repair of repairs) {
    if (repair.kind !== undefined && repair.kind !== 'inline' && repair.kind !== 'block') throw new Error('Tipo de reparo inválido.');
    validateImage(repair);
    const start = firstParagraph(repair), end = lastParagraph(repair);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= paragraphs.length) throw new Error('O intervalo de parágrafos selecionado é inválido.');
    if (repair.kind === 'inline') {
      const length = ownTextNodes(paragraphs[start]).reduce((sum, text) => sum + (text.textContent?.length ?? 0), 0);
      if (!Number.isInteger(repair.startOffset) || !Number.isInteger(repair.endOffset) || repair.startOffset < 0 || repair.endOffset <= repair.startOffset || repair.endOffset > length) throw new Error('O intervalo de texto selecionado é inválido.');
      inlineTarget(paragraphs[start], repair);
    } else {
      for (let index = start; index <= end; index++) {
        const paragraph = paragraphs[index];
        if (paragraph.parentElement !== paragraphs[start].parentElement || (index > start && paragraphs[index - 1].nextElementSibling !== paragraph)) {
          throw new Error('Escolha parágrafos consecutivos da mesma região do Word, sem atravessar tabelas.');
        }
        if (direct(paragraph, 'pPr')?.getElementsByTagNameNS(W, 'sectPr').length) throw new Error('O intervalo contém uma quebra de seção. Selecione somente os parágrafos da equação.');
      }
    }
  }
  for (let index = 0; index < repairs.length; index++) for (let other = index + 1; other < repairs.length; other++) {
    const a = repairs[index], b = repairs[other];
    if (firstParagraph(a) > lastParagraph(b) || firstParagraph(b) > lastParagraph(a)) continue;
    if (a.kind === 'inline' && b.kind === 'inline' && (a.endOffset <= b.startOffset || b.endOffset <= a.startOffset)) continue;
    throw new Error('Dois reparos atingem o mesmo parágrafo ou trecho. Remova a seleção duplicada.');
  }
}

function element(xml: Document, namespace: string, name: string, attrs: Record<string, string | number> = {}) {
  const node = xml.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function imageRun(xml: Document, repair: RepairImage, relationship: string, drawingId: number, filename: string) {
  const cx = Math.round(repair.widthPt * 12700), cy = Math.round(repair.heightPt * 12700);
  const run = element(xml, W, 'w:r');
  const drawing = element(xml, W, 'w:drawing');
  const inline = element(xml, WP, 'wp:inline', { distT: 0, distB: 0, distL: 0, distR: 0 });
  inline.append(element(xml, WP, 'wp:extent', { cx, cy }));
  inline.append(element(xml, WP, 'wp:docPr', { id: drawingId, name: `LumeEquationCrop-${drawingId}`, descr: repair.alt }));
  const frame = element(xml, WP, 'wp:cNvGraphicFramePr');
  frame.append(element(xml, A, 'a:graphicFrameLocks', { noChangeAspect: 1 })); inline.append(frame);
  const graphic = element(xml, A, 'a:graphic');
  const data = element(xml, A, 'a:graphicData', { uri: PIC });
  const picture = element(xml, PIC, 'pic:pic');
  const nonVisual = element(xml, PIC, 'pic:nvPicPr');
  nonVisual.append(element(xml, PIC, 'pic:cNvPr', { id: drawingId, name: filename, descr: repair.alt }), element(xml, PIC, 'pic:cNvPicPr'));
  const fill = element(xml, PIC, 'pic:blipFill');
  const blip = element(xml, A, 'a:blip'); blip.setAttributeNS(R, 'r:embed', relationship);
  const stretch = element(xml, A, 'a:stretch'); stretch.append(element(xml, A, 'a:fillRect')); fill.append(blip, stretch);
  const shape = element(xml, PIC, 'pic:spPr');
  const transform = element(xml, A, 'a:xfrm'); transform.append(element(xml, A, 'a:off', { x: 0, y: 0 }), element(xml, A, 'a:ext', { cx, cy }));
  const geometry = element(xml, A, 'a:prstGeom', { prst: 'rect' }); geometry.append(element(xml, A, 'a:avLst')); shape.append(transform, geometry);
  picture.append(nonVisual, fill, shape); data.append(picture); graphic.append(data); inline.append(graphic); drawing.append(inline); run.append(drawing);
  return run;
}

function allowImageHeight(paragraph: Element) {
  // PDF converters often create exact-height lines, which would clip the image.
  const spacing = direct(paragraph, 'pPr')?.getElementsByTagNameNS(W, 'spacing')[0];
  if (spacing?.getAttributeNS(W, 'lineRule') === 'exact') spacing.setAttributeNS(W, 'w:lineRule', 'atLeast');
}

/** Replace only explicitly selected content; no OCR guesses, translation, or network requests. */
export async function applyEquationRepairs(blob: Blob, repairs: readonly EquationRepair[]): Promise<Blob> {
  const { zip, xml, paragraphs, total } = await openPackage(blob);
  validateRepairs(paragraphs, repairs);
  if (total + repairs.reduce((sum, repair) => sum + repair.image.byteLength, 0) > MAX_BYTES) throw new Error('Os recortes fazem o Word ultrapassar o limite de 40 MB. Reduza a resolução ou a quantidade.');
  const relPath = 'word/_rels/document.xml.rels';
  const rels = parseXml(zip.file(relPath) ? await readPart(zip, relPath) : `<Relationships xmlns="${REL}"/>`, 'Relações', REL, 'Relationships');
  const content = parseXml(await readPart(zip, '[Content_Types].xml'), 'Tipos de conteúdo', CONTENT, 'Types');
  const relationIds = new Set(Array.from(rels.documentElement.children).map(node => node.getAttribute('Id')));
  const drawingIds = new Set(Array.from(xml.getElementsByTagNameNS(WP, 'docPr')).map(node => node.getAttribute('id')));
  let sequence = 1, nextDrawingId = 1;
  const ordered = [...repairs].sort((a, b) => firstParagraph(b) - firstParagraph(a) || ((b.kind === 'inline' ? b.startOffset : 0) - (a.kind === 'inline' ? a.startOffset : 0)));
  for (const repair of ordered) {
    let filename: string;
    do { filename = `lume-equation-crop-${sequence++}.png`; } while (zip.file(`word/media/${filename}`));
    let id = `rIdLumeEquation${sequence}`;
    while (relationIds.has(id)) id += 'x';
    relationIds.add(id);
    while (drawingIds.has(String(nextDrawingId))) nextDrawingId++;
    const drawingId = nextDrawingId++; drawingIds.add(String(drawingId));
    zip.file(`word/media/${filename}`, repair.image);
    rels.documentElement.append(element(rels, REL, 'Relationship', { Id: id, Type: `${R}/image`, Target: `media/${filename}` }));
    // Per-part Override avoids changing the interpretation of existing PNG files.
    content.documentElement.append(element(content, CONTENT, 'Override', { PartName: `/word/media/${filename}`, ContentType: 'image/png' }));
    const run = imageRun(xml, repair, id, drawingId, filename);
    const paragraph = paragraphs[firstParagraph(repair)];
    if (repair.kind === 'inline') {
      const targets = inlineTarget(paragraph, repair);
      const props = direct(targets[0].run, 'rPr');
      if (props) run.prepend(props.cloneNode(true));
      if (repair.baselineOffsetPt !== undefined) {
        let runProps = direct(run, 'rPr');
        if (!runProps) { runProps = element(xml, W, 'w:rPr'); run.prepend(runProps); }
        direct(runProps, 'position')?.remove();
        // Explicit positioning replaces inherited superscript/subscript behavior.
        direct(runProps, 'vertAlign')?.remove();
        const position = element(xml, W, 'w:position'); position.setAttributeNS(W, 'w:val', String(Math.round(repair.baselineOffsetPt * 2)));
        runProps.append(position);
      }
      const splitRun = (source: Element, text: string) => {
        const split = source.cloneNode(false) as Element;
        const properties = direct(source, 'rPr');
        if (properties) split.append(properties.cloneNode(true));
        const node = element(xml, W, 'w:t'); node.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); node.textContent = text;
        split.append(node); return split;
      };
      targets.forEach((target, index) => {
        const replacement: Element[] = [];
        if (target.start) replacement.push(splitRun(target.run, target.value.slice(0, target.start)));
        if (index === 0) replacement.push(run);
        if (target.end < target.value.length) replacement.push(splitRun(target.run, target.value.slice(target.end)));
        target.run.replaceWith(...replacement);
      });
      allowImageHeight(paragraph);
    } else {
      const replacement = paragraph.cloneNode(false) as Element;
      const props = direct(paragraph, 'pPr'); if (props) replacement.append(props.cloneNode(true));
      const replacementProps = direct(replacement, 'pPr');
      if (replacementProps) {
        direct(replacementProps, 'tabs')?.remove();
        // Left/right insets locate the equation within its column. Dropping them
        // moves a crop into the gutter; only first-line offsets belong to the
        // fragmented text layout being replaced.
        const indent = direct(replacementProps, 'ind');
        for (const attr of ['firstLine', 'firstLineChars', 'hanging', 'hangingChars']) indent?.removeAttributeNS(W, attr);
        const spacing = direct(replacementProps, 'spacing');
        if (spacing) { spacing.setAttributeNS(W, 'w:lineRule', 'auto'); spacing.setAttributeNS(W, 'w:line', '240'); }
      }
      // Preserve bookmark identities used by equation numbers and cross-references.
      const markers: Element[] = [];
      for (let index = repair.startParagraph; index <= repair.endParagraph; index++) {
        markers.push(...Array.from(paragraphs[index].getElementsByTagNameNS(W, '*')).filter(node => node.localName === 'bookmarkStart' || node.localName === 'bookmarkEnd'));
      }
      const firstEnd = markers.findIndex(marker => marker.localName === 'bookmarkEnd');
      const insertion = firstEnd === -1 ? markers.length : firstEnd;
      markers.forEach((marker, index) => { if (index === insertion) replacement.append(run); replacement.append(marker.cloneNode(true)); });
      if (insertion === markers.length) replacement.append(run);
      allowImageHeight(replacement);
      paragraph.replaceWith(replacement);
      for (let index = repair.startParagraph + 1; index <= repair.endParagraph; index++) paragraphs[index].remove();
    }
  }
  zip.file('word/document.xml', new XMLSerializer().serializeToString(xml));
  zip.file(relPath, new XMLSerializer().serializeToString(rels));
  zip.file('[Content_Types].xml', new XMLSerializer().serializeToString(content));
  return zip.generateAsync({ type: 'blob', mimeType: DOCX_TYPE, compression: 'DEFLATE' });
}
