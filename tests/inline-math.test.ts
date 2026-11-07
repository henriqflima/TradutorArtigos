import { describe, expect, it } from 'vitest';
import { splitInlineMath, splitMathRuns } from '../src/inline-math';
import { parseTranslationMarkup, readSourceMarkup, type Marker } from '../src/translation-markup';
import type { ContentRun } from '../src/structured-document';

describe('inline TeX segmentation', () => {
  it('preserves the exact original delimiters and content of the symbols from the reported PDF', () => {
    const source = String.raw`where \(\dot{\gamma}=1/s\), \( \eta_{0} \), \(\lambda\), \(T_{\mathrm{ref}}\), \(E_a\) and \(\tau : \nabla \mathbf{v}\) are used.`;
    const segments = splitInlineMath(source);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
    const math = segments.filter(segment => segment.type === 'math');
    expect(math.map(segment => segment.tex)).toEqual([
      String.raw`\dot{\gamma}=1/s`, String.raw` \eta_{0} `, String.raw`\lambda`,
      String.raw`T_{\mathrm{ref}}`, 'E_a', String.raw`\tau : \nabla \mathbf{v}`,
    ]);
    expect(math.every(segment => !segment.display)).toBe(true);
  });

  it('supports adjacent inline formulas and both display delimiters', () => {
    const source = String.raw`A $x$$y$ B $$\frac{a}{b}$$ C \[ \rho C_p \] D.`;
    expect(splitInlineMath(source)).toEqual([
      { type: 'text', text: 'A ' },
      { type: 'math', text: '$x$', tex: 'x', display: false },
      { type: 'math', text: '$y$', tex: 'y', display: false },
      { type: 'text', text: ' B ' },
      { type: 'math', text: String.raw`$$\frac{a}{b}$$`, tex: String.raw`\frac{a}{b}`, display: true },
      { type: 'text', text: ' C ' },
      { type: 'math', text: String.raw`\[ \rho C_p \]`, tex: String.raw` \rho C_p `, display: true },
      { type: 'text', text: ' D.' },
    ]);
  });

  it.each([
    'The costs are $5 and $10 per sample.', 'Costs range from $5–$10.',
    'Preço: R$ 10,00 e R$ 20,00.', 'Preço: R$10,00 e R$20,00.',
    'Cost: US$ 10 and US$ 20.',
    String.raw`Cost \$5 and \$10.`, String.raw`Literal \\(text\\).`,
    'The result is $unclosed.', String.raw`The result is \(unclosed.`,
    '$first\nsecond$', 'Ordinary prose and HTML-like <data> stay literal.',
  ])('retains ordinary text without inventing formulas: %s', source => {
    expect(splitInlineMath(source)).toEqual([{ type: 'text', text: source }]);
  });

  it('recognizes math after prices and escaped dollars without consuming their prose', () => {
    const source = String.raw`Cost $5 and $10 per sample; viscosity \(\eta_0\), rate $1/s$.`;
    expect(splitInlineMath(source).filter(segment => segment.type === 'math').map(segment => segment.tex))
      .toEqual([String.raw`\eta_0`, '1/s']);
    expect(splitInlineMath(source).map(segment => segment.text).join('')).toBe(source);
    const escaped = String.raw`Cost \$5; viscosity \(\eta_0\), rate $1/s$.`;
    expect(splitInlineMath(escaped).filter(segment => segment.type === 'math').map(segment => segment.tex))
      .toEqual([String.raw`\eta_0`, '1/s']);
    const brazilian = String.raw`Preço R$ 10,00 e R$ 20,00; taxa $1/s$ e \(\eta_0\).`;
    expect(splitInlineMath(brazilian).filter(segment => segment.type === 'math').map(segment => segment.tex))
      .toEqual(['1/s', String.raw`\eta_0`]);
    const followingMath = String.raw`Costs $5 and $10, with \(\eta_0\) or $x$.`;
    expect(splitInlineMath(followingMath).filter(segment => segment.type === 'math').map(segment => segment.tex))
      .toEqual([String.raw`\eta_0`, 'x']);
  });

  it('joins a formula across styles, while retaining the prose styles and source immutability', () => {
    const runs: ContentRun[] = [
      { type: 'text', text: String.raw`where \( \eta_`, style: { bold: true } },
      { type: 'text', text: '0', style: { superscript: true } },
      { type: 'text', text: String.raw` \) is viscosity`, style: { italic: true } },
    ];
    const original = structuredClone(runs);
    expect(splitMathRuns(runs)).toEqual([
      { type: 'text', text: 'where ', style: { bold: true } },
      { type: 'math', text: String.raw`\( \eta_0 \)`, tex: String.raw` \eta_0 `, display: false, style: { bold: true } },
      { type: 'text', text: ' is viscosity', style: { italic: true } },
    ]);
    expect(runs).toEqual(original);
  });

  it('never joins a mathematical delimiter across a preserved source asset', () => {
    const runs: ContentRun[] = [
      { type: 'text', text: String.raw`\(a` }, { type: 'asset', assetId: 'eq1' },
      { type: 'text', text: String.raw`b\)` },
    ];
    expect(splitMathRuns(runs)).toEqual(runs);
  });
});

describe('opaque mathematical translation markers', () => {
  const exact = String.raw`\( \eta_{0} < \eta_{\mathrm{ref}} & \alpha \)`;
  const marker: Marker = { id: 'm1', tag: 'eq', token: 'LUME_M1_PROTECTED', mathText: exact };
  const protectedXml = '<p id="b1">A <i><eq id="m1">LUME_M1_PROTECTED</eq></i> B</p>';

  it('restores local TeX as exact text without parsing its XML-like content', () => {
    expect(parseTranslationMarkup(protectedXml, 'b1', new Map([['m1', marker]]))).toEqual([
      { type: 'text', text: 'A ' }, { type: 'text', text: exact, style: { italic: true } },
      { type: 'text', text: ' B' },
    ]);
    expect(readSourceMarkup(protectedXml).markers.get('m1')).toEqual({
      id: 'm1', tag: 'eq', token: 'LUME_M1_PROTECTED', assetId: 'm1',
    });
  });

  it.each([
    protectedXml.replace('<eq id="m1">LUME_M1_PROTECTED</eq>', ''),
    protectedXml.replace('</eq>', '</eq><eq id="m1">LUME_M1_PROTECTED</eq>'),
    protectedXml.replace('LUME_M1_PROTECTED', 'LUME_M1_CHANGED'),
    protectedXml.replace('<eq id="m1">LUME_M1_PROTECTED</eq>', 'eta_0'),
  ])('rejects omitted, duplicated and changed mathematical markers', xml => {
    expect(() => parseTranslationMarkup(xml, 'b1', new Map([['m1', marker]]))).toThrow();
  });
});
