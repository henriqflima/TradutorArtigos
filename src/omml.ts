/** Convert the translated DOCX's Office Math directly: docx-preview drops several
 * constructs and turns ordinary runs into quoted MathML strings (<ms>). */
export const OMML_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!);
const children = (element: Element) => Array.from(element.children);
const child = (element: Element | undefined, name: string) => element && children(element).find(item => item.namespaceURI === OMML_NS && item.localName === name);
const value = (element: Element | undefined, fallback = '') => element?.getAttributeNS(OMML_NS, 'val') ?? element?.getAttribute('m:val') ?? fallback;
const enabled = (element: Element | undefined, fallback = false) => element ? !['0', 'false', 'off'].includes(value(element, '1')) : fallback;
const tag = (name: string, content: string, attrs = '') => `<${name}${attrs}>${content}</${name}>`;
const operator = (text: string, attrs = '') => tag('mo', escape(text), attrs);
const error = (name: string): never => { throw new Error(`A equação usa um recurso ainda não compatível (${name}). Baixe o Word traduzido e exporte como PDF no seu editor para preservá-la.`); };

type Options = { display?: boolean; integralLimits?: string; naryLimits?: string };
const supported = new Set(['oMath', 'oMathPara', 'e', 'num', 'den', 'deg', 'sub', 'sup', 'lim', 'box', 'r', 'fName', 'f', 'rad', 'sSup', 'sSub', 'sSubSup', 'sPre', 'limLow', 'limUpp', 'func', 'acc', 'bar', 'groupChr', 'd', 'nary', 'm', 'mr', 'eqArr']);

// OMML defaults to roman + italic. Only map combinations represented by MathML;
// replacing a script/double-struck alphabet with ordinary italic changes symbols.
const runVariants: Record<string, Partial<Record<string, string>>> = {
  roman: { p: 'normal', b: 'bold', i: 'italic', bi: 'bold-italic' },
  'sans-serif': { p: 'sans-serif', b: 'bold-sans-serif', i: 'sans-serif-italic', bi: 'sans-serif-bold-italic' },
  script: { p: 'script', b: 'bold-script' },
  fraktur: { p: 'fraktur', b: 'bold-fraktur' },
  'double-struck': { p: 'double-struck' },
  monospace: { p: 'monospace' },
};
const superscripts = new Map(Array.from('⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ').map((char, index) => [char, Array.from('0123456789+−=()ni')[index]]));
const subscripts = new Map(Array.from('₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓᵦᵧᵨᵩᵪ').map((char, index) => [char, Array.from('0123456789+−=()aehijklmnoprstuvxβγρφχ')[index]]));

function mathTokens(text: string, variant: string): string {
  type Atom = { base: string; sub?: string; sup?: string; space?: boolean };
  const atoms: Atom[] = [];
  const tokens = text.match(/\p{Nd}+(?:[.,]\p{Nd}+)*|[^\p{Nd}]/gu) || [];
  const token = (text: string) => {
    const name = /^\p{Nd}/u.test(text) ? 'mn' : /^\p{L}/u.test(text) ? 'mi' : 'mo';
    // Mathematical italic has no italic digits or punctuation. MathML applies
    // mathvariant to all tokens, so retain their upright forms explicitly.
    const style = name === 'mi' ? variant : variant === 'italic' ? 'normal' : variant === 'bold-italic' ? 'bold' : variant;
    return tag(name, escape(text), ` mathvariant="${style}"`);
  };
  for (let index = 0; index < tokens.length; index++) {
    const text = tokens[index];
    const script = superscripts.has(text) ? 'sup' : subscripts.has(text) ? 'sub' : null;
    if (script) {
      const atom = atoms.at(-1);
      if (!atom || atom.space) return error('índice Unicode sem base na mesma expressão');
      const map = script === 'sup' ? superscripts : subscripts;
      let group = map.get(text)!;
      while (index + 1 < tokens.length && map.has(tokens[index + 1])) group += map.get(tokens[++index])!;
      atom[script] = (atom[script] || '') + (group.match(/\p{Nd}+|[^\p{Nd}]/gu) || []).map(token).join('');
    } else if (/^\s+$/u.test(text)) atoms.push({ base: '<mspace width="0.25em"/>', space: true });
    else atoms.push({ base: token(text) });
  }
  return atoms.map(atom => {
    const sub = atom.sub ? tag('mrow', atom.sub) : '';
    const sup = atom.sup ? tag('mrow', atom.sup) : '';
    return sub && sup ? tag('msubsup', atom.base + sub + sup) : sub ? tag('msub', atom.base + sub) : sup ? tag('msup', atom.base + sup) : atom.base;
  }).join('');
}

function mathRun(element: Element, normal = false): string {
  const props = child(element, 'rPr');
  const normalText = normal || enabled(child(props, 'nor'));
  const plain = normalText || enabled(child(props, 'lit'));
  const explicitStyle = child(props, 'sty');
  let style = value(explicitStyle, normalText ? 'p' : 'i');
  const script = value(child(props, 'scr'), 'roman');
  const wordProps = children(element).find(item => item.namespaceURI === WORD_NS && item.localName === 'rPr');
  const wordFlag = (name: string) => {
    const prop = wordProps && children(wordProps).find(item => item.localName === name);
    return !!prop && !['0', 'false', 'off'].includes(prop.getAttributeNS(WORD_NS, 'val') ?? '1');
  };
  if (!explicitStyle && normalText) style = wordFlag('b') ? (wordFlag('i') ? 'bi' : 'b') : wordFlag('i') ? 'i' : 'p';
  const variant = runVariants[script]?.[style] ?? error(`m:scr=${script}, m:sty=${style}`);
  const attrs = ` mathvariant="${variant}"`;
  let result = '';
  for (const item of children(element)) {
    if (item.localName === 'rPr') continue;
    if (item.namespaceURI !== OMML_NS || item.localName !== 't') error(item.tagName);
    const text = item.textContent || '';
    if (plain) { result += tag('mtext', escape(text), attrs); continue; }
    result += mathTokens(text, variant);
  }
  return result;
}

function convert(element: Element, options: Options, depth = 0): string {
  if (depth > 80) error('profundidade da fórmula');
  if (element.namespaceURI !== OMML_NS) error(element.tagName);
  const name = element.localName;
  if (name !== 'r') for (const item of children(element)) {
    if (!item.localName.endsWith('Pr') && (item.namespaceURI !== OMML_NS || !supported.has(item.localName))) error(item.tagName);
  }
  const props = child(element, `${name}Pr`);
  const prop = (key: string, fallback = '') => value(child(props, key), fallback);
  const parts = (key: string) => children(element).filter(item => item.namespaceURI === OMML_NS && item.localName === key);
  const next = (item: Element) => convert(item, options, depth + 1);
  const base = (key: string, required = true) => {
    const item = child(element, key);
    if (!item) { if (required) error(`${name}/${key}`); return '<mrow/>'; }
    return next(item);
  };
  const row = () => tag('mrow', children(element).filter(item => !item.localName.endsWith('Pr')).map(next).join(''));
  switch (name) {
    case 'oMath': case 'oMathPara': case 'e': case 'num': case 'den': case 'deg': case 'sub': case 'sup': case 'lim': case 'box': return row();
    case 'r': return mathRun(element);
    case 'fName': return tag('mrow', children(element).filter(item => !item.localName.endsWith('Pr')).map(item => item.localName === 'r' ? mathRun(item, true) : next(item)).join(''));
    case 'f': {
      const numerator = base('num'); const denominator = base('den');
      const type = prop('type', 'bar');
      if (type === 'lin') return tag('mrow', numerator + operator('/') + denominator);
      if (!['bar', 'noBar', 'skw'].includes(type)) error(`m:f/type=${type}`);
      return tag('mfrac', numerator + denominator, type === 'noBar' ? ' linethickness="0"' : type === 'skw' ? ' bevelled="true"' : '');
    }
    case 'rad': {
      const degree = child(element, 'deg');
      return enabled(child(props, 'degHide')) || !degree || !degree.textContent?.trim()
        ? tag('msqrt', base('e')) : tag('mroot', base('e') + next(degree));
    }
    case 'sSup': return tag('msup', base('e') + base('sup'));
    case 'sSub': return tag('msub', base('e') + base('sub'));
    case 'sSubSup': return tag('msubsup', base('e') + base('sub') + base('sup'));
    case 'sPre': return tag('mmultiscripts', base('e') + '<mprescripts/>' + base('sub', false) + base('sup', false));
    case 'limLow': return tag('munder', base('e') + base('lim'));
    case 'limUpp': return tag('mover', base('e') + base('lim'));
    case 'func': return tag('mrow', base('fName') + operator('\u2061') + base('e'));
    case 'acc': return tag('mover', base('e') + operator(prop('chr', '\u0302'), ' stretchy="true"'), ' accent="true"');
    case 'bar': {
      const position = prop('pos', 'bot');
      if (!['top', 'bot'].includes(position)) error(`m:bar/pos=${position}`);
      return tag(position === 'top' ? 'mover' : 'munder', base('e') + operator(position === 'top' ? '\u00AF' : '_', ' stretchy="true"'), position === 'top' ? ' accent="true"' : ' accentunder="true"');
    }
    case 'groupChr': {
      const position = prop('pos', 'bot');
      if (!['top', 'bot'].includes(position)) error(`m:groupChr/pos=${position}`);
      return tag(position === 'top' ? 'mover' : 'munder', base('e') + operator(prop('chr', '\u23DF'), ' stretchy="true"'));
    }
    case 'd': {
      const expressions = parts('e');
      if (!expressions.length) error('m:d/e');
      const grow = enabled(child(props, 'grow'), true);
      const fence = (text: string) => text ? operator(text, ` fence="true" stretchy="${grow}"`) : '';
      return tag('mrow', fence(prop('begChr', '(')) + expressions.map(next).join(operator(prop('sepChr', '|'), ' separator="true"')) + fence(prop('endChr', ')')));
    }
    case 'nary': {
      const symbol = prop('chr', '\u222B');
      const integral = /^[\u222B-\u2233]$/u.test(symbol);
      const location = prop('limLoc', (integral ? options.integralLimits : options.naryLimits) || (options.display ? 'undOvr' : 'subSup'));
      if (!['undOvr', 'subSup'].includes(location)) error(`m:nary/limLoc=${location}`);
      const lower = !enabled(child(props, 'subHide')) && child(element, 'sub');
      const upper = !enabled(child(props, 'supHide')) && child(element, 'sup');
      let op = operator(symbol, ' largeop="true" movablelimits="false"');
      if (lower && upper) op = tag(location === 'undOvr' ? 'munderover' : 'msubsup', op + next(lower) + next(upper));
      else if (lower) op = tag(location === 'undOvr' ? 'munder' : 'msub', op + next(lower));
      else if (upper) op = tag(location === 'undOvr' ? 'mover' : 'msup', op + next(upper));
      return tag('mrow', op + base('e'));
    }
    case 'm': {
      const rows = parts('mr');
      if (!rows.length || rows.length > 100) error('linhas da matriz');
      const alignments: string[] = [];
      for (const column of child(props, 'mcs') ? children(child(props, 'mcs')!) : []) {
        const columnProps = child(column, 'mcPr');
        const count = Number(value(child(columnProps, 'count'), '1'));
        const alignment = value(child(columnProps, 'mcJc'), 'center');
        if (!Number.isInteger(count) || count < 1 || count > 100 || !['left', 'center', 'right'].includes(alignment)) error('colunas da matriz');
        alignments.push(...Array<string>(count).fill(alignment));
      }
      return tag('mtable', rows.map(next).join(''), alignments.length ? ` columnalign="${alignments.join(' ')}"` : '');
    }
    case 'mr': return tag('mtr', parts('e').map(item => tag('mtd', next(item))).join(''));
    case 'eqArr': return tag('mtable', parts('e').map(item => tag('mtr', tag('mtd', next(item)))).join(''), ' columnalign="left"');
    default: return error(element.tagName);
  }
}

/** Accept one oMath from the translated package, never an equation from the source file. */
export function ommlToMathML(equation: Element, options: Options = {}): string {
  if (equation.localName !== 'oMath' || equation.namespaceURI !== OMML_NS) error(equation.tagName);
  if (equation.getElementsByTagName('*').length > 10000) error('tamanho da fórmula');
  const display = options.display ?? equation.parentElement?.localName === 'oMathPara';
  return `<math xmlns="${MATHML_NS}" display="${display ? 'block' : 'inline'}">${convert(equation, { ...options, display })}</math>`;
}

/** Replace equations only in the temporary rendering XML, preserving surrounding
 * layout. Stable markers also work when a header/footer is rendered repeatedly. */
export function prepareOmmlPart(xml: Document, partId: string, options: Options = {}): Map<string, string> {
  if (xml.getElementsByTagName('parsererror').length) error('XML inválido');
  const equations = Array.from(xml.getElementsByTagNameNS(OMML_NS, 'oMath'));
  if (equations.length > 2000) error('quantidade de equações');
  const result = new Map<string, string>();
  equations.forEach((equation, index) => {
    const key = `LUME_MATH_${encodeURIComponent(partId)}_${index}_END`;
    result.set(key, ommlToMathML(equation, options));
    const run = xml.createElementNS(OMML_NS, 'm:r');
    const text = xml.createElementNS(OMML_NS, 'm:t');
    text.textContent = key; run.append(text);
    equation.replaceChildren(run);
  });
  return result;
}
