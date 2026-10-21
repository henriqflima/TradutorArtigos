import { mathjax } from '@mathjax/src/js/mathjax.js';
import { MathML } from '@mathjax/src/js/input/mathml.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { MathJaxTexFont } from '@mathjax/mathjax-tex-font/js/svg.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const converter = mathjax.document('', {
  InputJax: new MathML({ allowHtmlInTokenNodes: false }),
  OutputJax: new SVG({ fontData: MathJaxTexFont, fontCache: 'none' }),
});

function availableWidth(equation: Element): number {
  const container = equation.closest('td, article, section.docx') || equation.parentElement;
  if (!container) return 600;
  const style = getComputedStyle(container);
  let width = container.getBoundingClientRect().width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  const columns = parseInt(style.columnCount) || 1;
  if (columns > 1) width = (width - (parseFloat(style.columnGap) || 0) * (columns - 1)) / columns;
  return width > 0 ? width : 600;
}

/** equations must come from prepareOmmlPart on the translated rendering package. */
export async function preserveEquations(host: HTMLElement, equations?: ReadonlyMap<string, string>) {
  for (const equation of Array.from(host.querySelectorAll('math'))) {
    const mathml = equations?.get(equation.textContent?.trim() || '');
    if (!mathml) throw new Error('Não foi possível associar uma equação ao Word traduzido. Baixe o Word e exporte como PDF no seu editor.');
    const style = getComputedStyle(equation);
    const fontSize = parseFloat(style.fontSize) || 16;
    const containerWidth = availableWidth(equation);
    const display = /display="block"/.test(mathml);
    const node = await converter.convertPromise(mathml, { display, em: fontSize, ex: fontSize / 2, containerWidth });
    const parsed = new DOMParser().parseFromString(adaptor.outerHTML(node), 'text/html');
    const svg = parsed.querySelector('svg');
    if (!svg || parsed.querySelector('[data-mjx-error], [data-mml-node="merror"]')) throw new Error('Não foi possível preservar uma equação deste Word. Baixe o Word traduzido e exporte como PDF no seu editor.');
    // MathJax emits <text> for glyphs absent from the bundled font. The browser
    // may otherwise replace an unknown scientific symbol with an empty box.
    if (svg.querySelector('text')) {
      const glyph = svg.querySelector('text')?.textContent?.codePointAt(0)?.toString(16).toUpperCase();
      throw new Error(`Uma equação contém um símbolo sem representação na fonte matemática local${glyph ? ` (U+${glyph})` : ''}. Baixe o Word traduzido para preservar esse símbolo no seu editor.`);
    }
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.style.color = style.color || '#000';
    const pixels = (value: string | null) => {
      if (!value || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:ex|em|px)?$/.test(value.trim())) return NaN;
      return parseFloat(value) * (value.endsWith('ex') ? fontSize / 2 : value.endsWith('em') ? fontSize : 1);
    };
    const width = pixels(svg.getAttribute('width'));
    const height = pixels(svg.getAttribute('height'));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Não foi possível determinar o tamanho de uma equação. Baixe o Word traduzido.');
    const scale = Math.min(1, containerWidth / width);
    if (scale < 0.6 || height * scale > 2000) throw new Error('Uma equação é grande demais para caber com legibilidade nesta página. Baixe o Word traduzido e ajuste o layout no seu editor.');
    const baseline = pixels(svg.style.verticalAlign || '0');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const img = document.createElement('img');
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    img.style.width = `${width * scale}px`; img.style.height = `${height * scale}px`;
    img.style.verticalAlign = `${Number.isFinite(baseline) ? baseline * scale : 0}px`;
    img.style.maxWidth = '100%';
    if (display) { img.style.display = 'block'; img.style.marginLeft = 'auto'; img.style.marginRight = 'auto'; }
    img.dataset.equation = 'true';
    img.alt = 'Equação matemática';
    await img.decode();
    equation.replaceWith(img);
  }
}
