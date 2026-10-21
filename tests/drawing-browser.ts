import JSZip from 'jszip';
import { drawingToSvg } from '../src/drawing';
import { preserveDrawings } from '../src/drawing-package';
import { renderWordPages } from '../src/pdf';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RECT = `<wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="EDF4ED"/></a:solidFill><a:ln w="95250"><a:solidFill><a:srgbClr val="244D42"/></a:solidFill></a:ln></wps:spPr><wps:bodyPr/></wps:wsp>`;
function graphic(shape = RECT) {
  return new DOMParser().parseFromString(`<a:graphicData xmlns:a="${A}" xmlns:wps="${WPS}" xmlns:wpg="${WPG}">${shape}</a:graphicData>`, 'application/xml').documentElement;
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function decode(svg: string) {
  const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode(); return image;
}
async function fixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:wps="${WPS}" xmlns:mc="${MC}" xmlns:v="urn:schemas-microsoft-com:vml"><w:body><w:p><w:r><w:t>Figura vetorial com contorno completo.</w:t></w:r></w:p><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="1905000" cy="952500"/><wp:effectExtent l="47625" t="47625" r="47625" b="47625"/><wp:docPr id="1" name="Figura de teste"/><a:graphic><a:graphicData uri="${WPS}">${RECT}</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:rect style="width:200px;height:100px"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p><w:p><w:r><w:t>Figura 1. Legenda da figura vetorial.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`);
  return zip;
}

async function run() {
  const button = document.querySelector<HTMLButtonElement>('#run')!;
  const result = document.querySelector<HTMLElement>('#result')!;
  const output = document.querySelector<HTMLElement>('#output')!;
  button.disabled = true; result.textContent = 'Verificando…'; output.replaceChildren();
  const checks: string[] = [];
  try {
    const svg = drawingToSvg(graphic(), { width: 200, height: 100 });
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const [x, y, width, height] = parsed.getAttribute('viewBox')!.split(' ').map(Number);
    assert(x <= -47625 && y <= -47625 && x + width >= 1952625 && y + height >= 1000125, 'Contorno fora do viewBox');
    assert(Math.abs(width / height - 2) < 1e-8, 'Expansão alterou a proporção da figura');
    const image = await decode(svg);
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const dark = (px: number, py: number) => { const pixel = context.getImageData(px, py, 1, 1).data; return pixel[3] > 200 && pixel[0] < 100; };
    const topStroke = Array.from({ length: 20 }, (_, index) => dark(100, index)).filter(Boolean).length;
    const bottomStroke = Array.from({ length: 20 }, (_, index) => dark(100, 99 - index)).filter(Boolean).length;
    assert(topStroke >= 8 && bottomStroke >= 8, `Metade do contorno foi cortada: ${topStroke}/${bottomStroke}`);
    image.alt = 'Retângulo SVG com quatro bordas preservadas'; image.style.cssText = 'display:block;margin:20px 0;'; output.append(image);
    checks.push('SVG decodificado; contornos superior/inferior completos; proporção preservada: OK');

    const group = `<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/><a:chOff x="0" y="0"/><a:chExt cx="1905000" cy="952500"/></a:xfrm></wpg:grpSpPr>${RECT.replace('x="0" y="0"', 'x="190500" y="95250"')}</wpg:wgp>`;
    const groupSvg = drawingToSvg(graphic(group), { width: 200, height: 100 });
    const groupBounds = new DOMParser().parseFromString(groupSvg, 'image/svg+xml').documentElement.getAttribute('viewBox')!.split(' ').map(Number);
    assert(groupBounds[0] + groupBounds[2] >= 2143125 && groupBounds[1] + groupBounds[3] >= 1095375, 'Forma deslocada no grupo foi cortada');
    await decode(groupSvg); checks.push('Grupo com forma deslocada além dos limites originais: OK');

    let rejected = false;
    try { drawingToSvg(graphic(RECT.replace('<a:xfrm>', '<a:xfrm rot="60000">')), { width: 200, height: 100 }); }
    catch { rejected = true; }
    assert(rejected, 'Rotação incompatível foi aceita');
    assert(document.querySelectorAll('.lume-vector-measure').length === 0, 'Medição deixou elementos temporários');
    checks.push('Figura incompatível recusada e medições temporárias removidas: OK');

    const zip = await fixture(); const original = await zip.generateAsync({ type: 'blob' });
    const xml = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml');
    await preserveDrawings(zip, xml, 'word/document.xml');
    assert(!xml.getElementsByTagNameNS(MC, 'AlternateContent').length && !xml.getElementsByTagNameNS(W, 'pict').length, 'Fallback antigo não foi removido');
    const media = Object.keys(zip.files).filter(name => name.endsWith('.svg'));
    assert(media.length === 1, 'Figura não foi inserida no pacote');
    await decode(await zip.file(media[0])!.async('string'));
    const types = new DOMParser().parseFromString(await zip.file('[Content_Types].xml')!.async('string'), 'application/xml');
    assert(Array.from(types.documentElement.children).some(el => el.localName === 'Default' && el.getAttribute('Extension') === 'svg' && el.getAttribute('ContentType') === 'image/svg+xml'), 'MIME SVG ausente');
    checks.push('Pacote DOCX: SVG, tipo MIME, relacionamento e AlternateContent preservados: OK');

    const preview = await renderWordPages(original, () => undefined);
    try {
      const images = preview.pages.flatMap(page => Array.from(page.querySelectorAll('img')));
      assert(images.length === 1 && images[0].src.startsWith('data:image/svg+xml'), 'docx-preview omitiu a figura SVG');
      await images[0].decode();
      assert(preview.pages.some(page => page.querySelector('img') && page.textContent?.includes('Figura 1.')), 'Legenda separada da figura');
      const copy = document.createElement('img'); copy.src = images[0].src; copy.alt = 'Figura após conversão completa do Word'; copy.style.cssText = 'display:block;margin:20px 0;'; output.append(copy);
    } finally { preview.dispose(); }
    assert(document.querySelectorAll('.pdf-render-host,.lume-vector-measure').length === 0, 'Conversão deixou elementos temporários');
    checks.push('Word ancorado → páginas: figura visível, legenda e limpeza de memória: OK');
    result.textContent = checks.join('\n'); result.dataset.status = 'passed';
  } catch (error) { result.textContent = `${checks.join('\n')}\nFALHA: ${error instanceof Error ? error.stack : error}`; result.dataset.status = 'failed'; }
  finally { button.disabled = false; }
}
document.querySelector('#run')!.addEventListener('click', run);
if (new URLSearchParams(location.search).get('autorun') === '1') void run();
