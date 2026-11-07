type Token = { text: string; start: number; end: number };

function tokens(text: string): Token[] {
  // Preserve case, signs, precision and exponent notation. Whitespace is layout,
  // not a reason to turn a supported quantity into a failed page.
  return Array.from(text.normalize('NFC').replace(/−/g, '-').replace(/µ/g, 'μ')
    .matchAll(/\d+(?:[.,]\d+)*|[.,]\d+|[\p{L}]+|[^\s]/gu), match => ({
      text: match[0], start: match.index!, end: match.index! + match[0].length,
    }));
}
function comparable(text: string) {
  const decimal = /^(\d+)[.,](\d+)$/.exec(text);
  // A three-digit suffix can also be a thousands group: do not guess its locale.
  if (decimal && (decimal[2].length !== 3 || /^0+$/.test(decimal[1]))) return `${decimal[1]}.${decimal[2]}`;
  return text;
}
const isNumber = (text: string) => /^(?:\d|[.,]\d)/.test(text);
const leadingQualifier = new Set(['-', '+', '±', '<', '>', '≤', '≥', '≈', '~']);
const unitContinuation = new Set(['/', '^', '·', '⋅', '*', '%', '⁻', '⁺', '¹', '²', '³', '⁰', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹']);
const unitWords = new Set(['g', 'kg', 'mg', 'μg', 'm', 'cm', 'mm', 'μm', 'L', 'l', 'mL', 'ml', 's', 'h', 'min', 'mol', 'mmol', 'K', 'Pa', 'Hz']);

/** Match whole quantities in one cited region. Never convert units or magnitude. */
export function createSummaryValueMatcher(source: string): (value: string) => boolean {
  const haystack = tokens(source);
  const sourceTokens = haystack.map(token => comparable(token.text));
  return value => {
    if (value.length > 2_000) return false;
    const needle = tokens(value);
    if (!needle.length || needle.length > 128 || !needle.some(token => isNumber(token.text))) return false;
    const wanted = needle.map(token => comparable(token.text));
    for (let index = 0; index <= haystack.length - needle.length; index++) {
      if (!wanted.every((token, offset) => token === sourceTokens[index + offset])) continue;
      const before = haystack[index - 1], after = haystack[index + needle.length];
      const first = needle[0], last = needle[needle.length - 1];
      // Do not accept 25 inside -25, <=25, or an unsigned endpoint of a range.
      if (isNumber(first.text) && before && (leadingQualifier.has(before.text) || unitContinuation.has(before.text))) continue;
      const startsQuantity = isNumber(first.text) || (['-', '+', '±'].includes(first.text) && needle[1] && isNumber(needle[1].text));
      if (startsQuantity && before) {
        const prior = haystack[index - 2];
        if (isNumber(before.text) || unitContinuation.has(before.text) || leadingQualifier.has(before.text)) continue;
        if (/^[eE]$/.test(before.text) && prior && isNumber(prior.text)) continue;
        if (before.text === '=' && prior && ['<', '>'].includes(prior.text)) continue;
      }
      // Do not accept a prefix of a compound unit (mg vs mg/L or cm vs cm²).
      if (after && (unitContinuation.has(after.text) || ['±', '-'].includes(after.text))) continue;
      if (/\p{L}/u.test(last.text) && after && unitWords.has(after.text)) continue;
      if (/\p{L}/u.test(last.text) && after && isNumber(after.text) && after.start === haystack[index + needle.length - 1].end) continue;
      const afterUnit = haystack[index + needle.length + 1];
      if (after && /\p{L}/u.test(after.text) && afterUnit && (unitContinuation.has(afterUnit.text) || afterUnit.text === '-')) continue;
      // Bare mantissas/parts of scientific notation and grouped numbers are not a match.
      if (isNumber(last.text) && after && ((/^[eE]$/.test(after.text) && after.start === haystack[index + needle.length - 1].end) || isNumber(after.text))) continue;
      return true;
    }
    return false;
  };
}

/** Recover the actual original quote after layout-only whitespace changes. */
export function recoverSummaryQuote(quote: string, source: string): string | undefined {
  if (!quote.trim()) return;
  if (source.includes(quote)) return quote;
  const parts = quote.trim().split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join('\\s+'), 'u').exec(source)?.[0];
}
