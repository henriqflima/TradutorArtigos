import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { MathJaxTexFont } from '@mathjax/mathjax-tex-font/js/svg.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';

export type InlineMathImage = { png: Uint8Array; widthPt: number; heightPt: number; baselineOffsetPt: number };
export type InlineMathOptions = { bold?: boolean };
const MAX_TEX_LENGTH = 8_192;
const MAX_PIXELS = 6_000_000;
const PIXELS_PER_POINT = 400 / 72;
const PAD_PT = .4;
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const converter = mathjax.document('', {
  InputJax: new TeX({ packages: ['base', 'ams', 'boldsymbol'], maxBuffer: MAX_TEX_LENGTH + 16, maxMacros: 500,
    maxTemplateSubtitutions: 5_000, formatError: (_jax: unknown, error: Error) => { throw error; } }),
  OutputJax: new SVG({ fontData: MathJaxTexFont, fontCache: 'none', linebreaks: { inline: false } }),
});

function fail(message: string): never { throw new Error(message); }
function validateTex(tex: string) {
  if (!tex.trim() || tex.length > MAX_TEX_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(tex)) {
    fail('A fórmula reconhecida está vazia ou excede os limites de renderização. Confira a expressão ou preserve-a como recorte.');
  }
  // Only self-contained mathematics is accepted. Document/file/link commands and persistent macros are not needed for notation.
  if (/\\(?:def|gdef|edef|xdef|let|futurelet|newcommand|renewcommand|providecommand|require|autoload|includegraphics|input|href|url|html\w*|cssId|class|style|label|ref|eqref|tag)\b/u.test(tex)) {
    fail('A fórmula contém um comando não permitido na renderização matemática local. Preserve-a como recorte do original.');
  }
  let depth = 0;
  for (let index = 0; index < tex.length; index++) {
    if (tex[index] === '\\') { index++; continue; }
    if (tex[index] === '{' && ++depth > 64) fail('A fórmula é complexa demais para renderização local. Preserve-a como recorte do original.');
    if (tex[index] === '}' && --depth < 0) fail('A fórmula contém grupos matemáticos incompletos. Confira a expressão ou preserve-a como recorte.');
  }
  if (depth !== 0) fail('A fórmula contém grupos matemáticos incompletos. Confira a expressão ou preserve-a como recorte.');
}
function points(value: string | null, em: number) {
  if (!value || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:ex|em|px|pt)?$/u.test(value.trim())) return NaN;
  const number = parseFloat(value);
  return number * (value.endsWith('ex') ? em / 2 : value.endsWith('em') ? em : value.endsWith('px') ? .75 : 1);
}

/** Render OCR TeX as local mathematical glyphs; no network or document source bytes are involved. */
export async function rasterizeInlineMath(tex: string, fontSizePt: number, display = false, options: InlineMathOptions = {}): Promise<InlineMathImage> {
  validateTex(tex);
  if (!Number.isFinite(fontSizePt) || fontSizePt < 4 || fontSizePt > 96) fail('O tamanho da fórmula é inválido.');
  if (typeof document === 'undefined') fail('A renderização de fórmulas precisa ser realizada no navegador.');
  let markup: string;
  try {
    const styledTex = options.bold ? `\\boldsymbol{${tex}}` : tex;
    const node = await converter.convertPromise(styledTex, { display, em: fontSizePt, ex: fontSizePt / 2, containerWidth: 1_440 });
    markup = adaptor.outerHTML(node);
  } catch {
    fail('Não foi possível desenhar uma fórmula reconhecida. Confira sua notação ou preserve-a como recorte do original.');
  }
  if (markup.length > 2_000_000) fail('A fórmula é grande demais para renderização local. Preserve-a como recorte.');
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  // Stretchable accents (for example \overline{X}) legitimately contain nested
  // SVGs. Reject separate output fragments without discarding those glyph parts.
  const roots = [...parsed.querySelectorAll('svg')].filter(node => !node.parentElement?.closest('svg'));
  const svg = roots[0];
  if (roots.length !== 1 || parsed.querySelector('[data-mjx-error], [data-mml-node="merror"], parsererror')) {
    fail('Uma fórmula reconhecida contém notação matemática inválida. Confira a expressão ou preserve-a como recorte.');
  }
  if (svg.querySelector('text')) fail('Uma fórmula contém um símbolo sem representação na fonte matemática local. Preserve-a como recorte do original.');
  if (svg.querySelector('script, foreignObject, image, a, iframe, object')) fail('A fórmula contém conteúdo não matemático. Preserve-a como recorte.');
  for (const element of [svg, ...svg.querySelectorAll('*')]) for (const attribute of Array.from(element.attributes)) {
    if (/^on/iu.test(attribute.name) || /url\s*\(/iu.test(attribute.value) ||
        /(?:^|:)href$/iu.test(attribute.name) && !attribute.value.startsWith('#')) fail('A fórmula contém uma referência não permitida.');
  }
  const width = points(svg.getAttribute('width'), fontSizePt), height = points(svg.getAttribute('height'), fontSizePt);
  const baseline = points(svg.style.verticalAlign || '0', fontSizePt);
  if (![width, height, baseline].every(Number.isFinite) || width <= 0 || height <= 0 || width > 1_440 || height > 1_440) {
    fail('A fórmula não possui dimensões adequadas para uma página. Preserve-a como recorte do original.');
  }
  const widthPt = width + PAD_PT * 2, heightPt = height + PAD_PT * 2;
  const pixelWidth = Math.ceil(widthPt * PIXELS_PER_POINT), pixelHeight = Math.ceil(heightPt * PIXELS_PER_POINT);
  if (pixelWidth * pixelHeight > MAX_PIXELS) fail('A fórmula excede o limite de imagem matemática. Preserve-a como recorte.');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // SVG dimensions are raster pixels here; its viewBox retains MathJax's exact glyph geometry.
  svg.setAttribute('width', String(width * PIXELS_PER_POINT)); svg.setAttribute('height', String(height * PIXELS_PER_POINT));
  svg.style.color = '#000';
  const image = new Image(), canvas = document.createElement('canvas');
  try {
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    canvas.width = pixelWidth; canvas.height = pixelHeight;
    const context = canvas.getContext('2d');
    if (!context) fail('O navegador não conseguiu preparar a imagem da fórmula.');
    context.drawImage(image, PAD_PT * PIXELS_PER_POINT, PAD_PT * PIXELS_PER_POINT, width * PIXELS_PER_POINT, height * PIXELS_PER_POINT);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível preparar a fórmula.')), 'image/png'));
    return { png: new Uint8Array(await png.arrayBuffer()), widthPt, heightPt, baselineOffsetPt: baseline - PAD_PT };
  } catch (error) {
    if (error instanceof Error && /fórmula|navegador/u.test(error.message)) throw error;
    fail('O navegador não conseguiu desenhar uma fórmula. Preserve-a como recorte do original.');
  } finally { image.src = ''; canvas.width = canvas.height = 0; }
}
