import type { ContentRun, RunStyle } from './structured-document';

export type InlineMathSegment =
  | { type: 'text'; text: string }
  | { type: 'math'; text: string; tex: string; display: boolean };
export type InlineMathRun = ContentRun | (Extract<InlineMathSegment, { type: 'math' }> & { style?: RunStyle });

function escaped(text: string, index: number) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

function dollarCurrency(text: string, end: number, body: string) {
  // Two ordinary prices are not a mathematical region: "$5 and $10", "$5–$10".
  if (/\d/u.test(text[end + 1] || '')) return true;
  if (/\\[([]/u.test(body)) return true;
  if (/[\\_^=+*/<>]|[α-ωΑ-Ω]/u.test(body)) return false;
  // A price followed by prose, or multiple prose words, must not consume the next dollar region.
  return /^\s*[+-]?\d[\s\S]*\p{L}{2}/u.test(body) ||
    /\p{L}{2,}\s+\p{L}{2,}/u.test(body);
}

/** Recognize explicit TeX regions without interpreting HTML, ordinary prices or escaped dollars. */
export function splitInlineMath(text: string): InlineMathSegment[] {
  const result: InlineMathSegment[] = [];
  let position = 0, plainStart = 0;
  while (position < text.length) {
    let open = '', close = '', display = false;
    if (text.startsWith('\\(', position)) { open = '\\('; close = '\\)'; }
    else if (text.startsWith('\\[', position)) { open = '\\['; close = '\\]'; display = true; }
    else if (text.startsWith('$$', position)) { open = close = '$$'; display = true; }
    else if (text[position] === '$') { open = close = '$'; }
    if (!open) { position++; continue; }
    if (escaped(text, position)) { position += open.length; continue; }
    // A currency prefix makes this dollar literal even when later prices or TeX occur on the same line.
    if (open === '$' && /(?:^|[^\p{L}\p{N}_])(?:R|US|CA|AU|NZ|HK)$/u.test(text.slice(Math.max(0, position - 4), position))) {
      position++; continue;
    }
    const bodyStart = position + open.length;
    let end = bodyStart;
    while (end < text.length) {
      if (!display && open === '$' && /[\r\n]/u.test(text[end])) { end = text.length; break; }
      if (text.startsWith(close, end) && !escaped(text, end)) break;
      end++;
    }
    const body = text.slice(bodyStart, end);
    if (end >= text.length || !body.trim() || open === '$' && dollarCurrency(text, end, body)) {
      position += open.length; continue;
    }
    if (plainStart < position) result.push({ type: 'text', text: text.slice(plainStart, position) });
    const finish = end + close.length;
    result.push({ type: 'math', text: text.slice(position, finish), tex: body, display });
    plainStart = position = finish;
  }
  if (plainStart < text.length) result.push({ type: 'text', text: text.slice(plainStart) });
  return result;
}

/** TeX may cross styled text runs, but a preserved source object always ends the current text region. */
export function splitMathRuns(runs: readonly ContentRun[]): InlineMathRun[] {
  const result: InlineMathRun[] = [];
  let group: Extract<ContentRun, { type: 'text' }>[] = [];
  const flush = () => {
    if (!group.length) return;
    const plain = group.map(run => run.text).join('');
    let rangeStart = 0;
    const ranges = group.map(run => {
      const range = { run, start: rangeStart };
      rangeStart += run.text.length;
      return range;
    });
    let offset = 0;
    for (const segment of splitInlineMath(plain)) {
      const end = offset + segment.text.length;
      if (segment.type === 'math') {
        const style = ranges.find(range => range.start <= offset && range.start + range.run.text.length > offset)?.run.style;
        result.push({ ...segment, ...(style ? { style: { ...style } } : {}) });
      } else {
        for (const range of ranges) {
          const start = Math.max(offset, range.start), finish = Math.min(end, range.start + range.run.text.length);
          if (finish > start) result.push({ type: 'text', text: plain.slice(start, finish),
            ...(range.run.style ? { style: { ...range.run.style } } : {}) });
        }
      }
      offset = end;
    }
    group = [];
  };
  for (const run of runs) {
    if (run.type === 'text') group.push(run);
    else { flush(); result.push({ ...run }); }
  }
  flush();
  return result;
}
