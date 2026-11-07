import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { sha256, type DocumentAsset, type DocumentBlock, type SourceRect, type TranslatedDocument } from '../src/structured-document';

export const DENSE_PAGE = { width: 595, height: 842 };
export const DENSE_LEFT = 40, DENSE_RIGHT = 310, DENSE_COLUMN = 245, DENSE_FULL = 515;
const SOURCE = 'The sample was measured under steady conditions to compare the response of each material. Results show a consistent relation between the applied load and the observed strain. The same method was repeated to confirm that local changes did not alter the general trend.';
const TARGET = 'A amostra foi medida em condições estáveis para comparar a resposta de cada material. Os resultados mostram uma relação consistente entre a carga aplicada e a deformação observada. O mesmo método foi repetido para confirmar que mudanças locais não alteraram a tendência geral e a interpretação dos resultados.';
const words = (value: string, count: number) => Array.from({ length: count }, (_, index) => value.split(/\s+/u)[index % value.split(/\s+/u).length]).join(' ');
const hardWrap = (value: string, length: number) => value.split(/\s+/u).reduce<string[]>((lines, word, index) => {
  if (index % length === 0) lines.push(word); else lines[lines.length - 1] += ' ' + word;
  return lines;
}, []).join('\n');

export function sourceLines(value: string, width: number, font: PDFFont, size: number) {
  const lines: string[] = []; let line = '';
  for (const word of value.replace(/\s+/gu, ' ').split(' ')) {
    const next = line ? line + ' ' + word : word;
    if (line && font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length); bytes.set(new TextEncoder().encode(type), 4); bytes.set(data, 8);
  view.setUint32(bytes.length - 4, crc(bytes.subarray(4, bytes.length - 4))); return bytes;
}
/** Small deterministic graph PNG, usable in Node and browsers without any service or canvas dependency. */
async function graphPng() {
  const width = 490, height = 210, stride = width * 3 + 1, raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * stride + x * 3 + 1;
    const grid = x > 30 && x < width - 15 && (y === 35 || y === 75 || y === 115 || y === 155);
    const axis = (Math.abs(x - 30) < 2 && y >= 20 && y <= 180) || (Math.abs(y - 180) < 2 && x >= 30 && x < width - 15);
    const curve = x >= 31 && x < width - 16 && Math.abs(y - (170 - Math.sin((x - 30) / 310) * 118)) < 2;
    raw.set(curve ? [29, 111, 96] : axis ? [65, 79, 75] : grid ? [203, 214, 208] : [245, 248, 245], offset);
  }
  const ihdr = new Uint8Array(13), header = new DataView(ihdr.buffer); header.setUint32(0, width); header.setUint32(4, height); ihdr[8] = 8; ihdr[9] = 2;
  const compressed = new Uint8Array(await new Response(new Blob([raw.buffer]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export async function denseFixture(options: { hardBreaks?: boolean; noisyHeader?: boolean } = {}) {
  const source = await PDFDocument.create(), regular = await source.embedFont(StandardFonts.TimesRoman), bold = await source.embedFont(StandardFonts.TimesRomanBold);
  const page = source.addPage([DENSE_PAGE.width, DENSE_PAGE.height]);
  const blocks: DocumentBlock[] = [], translated: TranslatedDocument['blocks'] = {};
  const put = (id: string, value: string, target: string, rect: SourceRect, size: number, leading: number, kind: DocumentBlock['kind'] = 'paragraph') => {
    const block: DocumentBlock = { id, page: 1, kind, rect, fontSize: size, geometry: 'block',
      runs: [{ type: 'text', text: value }], appearance: { fontSize: size, lineHeight: leading, fontFamily: 'serif', alignment: kind === 'heading' ? 'left' : 'justify', confidence: 'native' } };
    blocks.push(block); translated[id] = [{ type: 'text', text: target }];
    const lines = sourceLines(value, rect.width, kind === 'heading' ? bold : regular, size);
    for (let index = 0; index < lines.length; index++) page.drawText(lines[index], { x: rect.x, y: DENSE_PAGE.height - rect.y - size * .84 - index * leading, font: kind === 'heading' ? bold : regular, size });
    return block;
  };
  put('dense-title', 'Text distribution in a dense scientific article', 'Distribuição do texto em um artigo científico denso', { x: DENSE_LEFT, y: 38, width: DENSE_FULL, height: 24 }, 17, 21, 'heading');
  put('dense-authors', 'Lume Research Group - synthetic layout and spacing benchmark', 'Grupo de Pesquisa Lume - ensaio sintético de organização e espaçamento', { x: DENSE_LEFT, y: 70, width: DENSE_FULL, height: 13 }, 9, 11);
  const abstract = 'Abstract. ' + words(SOURCE, 60), targetAbstract = 'Resumo. ' + words(TARGET, 68);
  const abstractLines = sourceLines(abstract, DENSE_FULL, regular, 8.8);
  put('dense-abstract', abstract, targetAbstract, { x: DENSE_LEFT, y: 98, width: DENSE_FULL, height: abstractLines.length * 11.2 }, 8.8, 11.2);
  const bodyTop = 163;
  const section = (id: string, label: string, target: string, x: number, y: number) => put(id, label, target, { x, y, width: DENSE_COLUMN, height: 15 }, 10, 12, 'heading');
  const paragraph = (id: string, x: number, y: number) => {
    const marker = id.toUpperCase().replaceAll('-', '_'), original = marker + '_BEGIN ' + words(SOURCE, 76) + ' ' + marker + '_END';
    const target = marker + '_BEGIN ' + words(TARGET, 86) + ' ' + marker + '_END';
    const lines = sourceLines(original, DENSE_COLUMN, regular, 9.5);
    put(id, original, options.hardBreaks === false ? target : hardWrap(target, 11), { x, y, width: DENSE_COLUMN, height: lines.length * 12 }, 9.5, 12);
    return y + lines.length * 12 + 4;
  };
  section('dense-left-heading', '1. Experimental procedure', '1. Procedimento experimental', DENSE_LEFT, bodyTop);
  let leftY = bodyTop + 20;
  for (let index = 0; index < 5; index++) leftY = paragraph(`dense-left-${index + 1}`, DENSE_LEFT, leftY);
  section('dense-right-heading', '2. Results and discussion', '2. Resultados e discussão', DENSE_RIGHT, bodyTop);
  let rightY = bodyTop + 20;
  for (let index = 0; index < 2; index++) rightY = paragraph(`dense-right-${index + 1}`, DENSE_RIGHT, rightY);
  const figureRect = { x: DENSE_RIGHT, y: rightY + 5, width: DENSE_COLUMN, height: 105 }, png = await graphPng();
  const asset: DocumentAsset = { id: 'dense-graph', kind: 'figure', page: 1, rect: figureRect, widthPt: DENSE_COLUMN, heightPt: figureRect.height, png,
    dataUrl: '', sha256: await sha256(png), alt: 'Experimental response under an increasing load' };
  const image = await source.embedPng(png); page.drawImage(image, { x: figureRect.x, y: DENSE_PAGE.height - figureRect.y - figureRect.height, width: figureRect.width, height: figureRect.height });
  blocks.push({ id: 'dense-figure', page: 1, kind: 'figure', rect: figureRect, fontSize: 9.5, runs: [], assetId: asset.id, captionId: 'dense-caption' });
  const captionY = figureRect.y + figureRect.height + 4;
  put('dense-caption', 'Figure 1. Measured response for all repeated experiments.', 'Figura 1. Resposta medida em todos os experimentos repetidos.', { x: DENSE_RIGHT, y: captionY, width: DENSE_COLUMN, height: 20 }, 8.2, 10, 'caption');
  rightY = captionY + 25;
  for (let index = 2; index < 4; index++) rightY = paragraph(`dense-right-${index + 1}`, DENSE_RIGHT, rightY);
  if (options.noisyHeader) {
    const header = put('dense-running-header', 'RESEARCH NOTE', 'NOTA DE PESQUISA', { x: 4, y: 8, width: 160, height: 12 }, 7, 9);
    header.sourceRole = 'header'; blocks.unshift(blocks.pop()!);
  }
  if (Math.max(leftY, rightY) > 800) throw new Error(`Dense source fixture does not fit: ${leftY}/${rightY}`);
  source.setTitle('Dense scientific source fixture');
  const input: TranslatedDocument = { document: { version: 1, sourceName: 'dense-academic-layout.pdf', sourceHash: 'dense-layout-fixture', sourceKind: 'pdf', pages: [DENSE_PAGE], blocks, assets: [asset], issues: [] },
    blocks: translated, sourceLanguage: 'EN', targetLanguage: 'PT-BR' };
  return { input, original: new Blob([new Uint8Array(await source.save()).buffer], { type: 'application/pdf' }), bodyTop, bottom: Math.max(leftY, rightY),
    sourceWords: blocks.flatMap(block => block.runs.flatMap(run => run.type === 'text' ? run.text.split(/\s+/u) : [])).length,
    translatedWords: Object.values(translated).flatMap(runs => runs.flatMap(run => run.type === 'text' ? run.text.split(/\s+/u) : [])).length };
}
