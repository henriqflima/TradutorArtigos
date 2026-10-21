export const MAX_TEXT_WORDS = 10_000;
export const TEXT_CHUNK_CHARACTERS = 2_500;

/** Words are nonempty groups separated by Unicode whitespace. */
export function countWords(text: string): number {
  return text.match(/\S+/gu)?.length || 0;
}

export function validatePlainText(text: unknown): string | null {
  if (typeof text !== 'string') return 'Envie somente texto. Arquivos, imagens e outros objetos não são aceitos.';
  if (!text.trim()) return 'Digite ou cole o texto que deseja traduzir.';
  if (countWords(text) > MAX_TEXT_WORDS) return 'O texto excede o limite de 10.000 palavras. Reduza o conteúdo para traduzir.';
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(text)) {
    return 'O conteúdo contém dados que não são texto válido. Cole somente texto simples.';
  }
  return null;
}

export type TextChunk = { text: string; before: string; after: string };

/** Keep all separators, preferring paragraph/sentence boundaries over a word split. */
export function splitPlainText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + TEXT_CHUNK_CHARACTERS, text.length);
    if (end < text.length) {
      const window = text.slice(cursor, end);
      const boundaries = [...window.matchAll(/\n\s*\n|[.!?。！？]\s+|\s+/gu)];
      const preferred = boundaries.filter(match => match.index! > TEXT_CHUNK_CHARACTERS / 2);
      const paragraph = preferred.filter(match => match[0].includes('\n'));
      const sentence = preferred.filter(match => /^[.!?。！？]/u.test(match[0]));
      const boundary = paragraph.at(-1) || sentence.at(-1) || boundaries.at(-1);
      if (boundary) end = cursor + boundary.index! + boundary[0].length;
      // Avoid dividing a Unicode surrogate pair in unspaced text.
      else if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    }
    const raw = text.slice(cursor, end);
    const content = raw.match(/^(\s*)([\s\S]*?\S)(\s*)$/u);
    if (content) chunks.push({ before: content[1], text: content[2], after: content[3] });
    else if (chunks.length) chunks[chunks.length - 1].after += raw;
    else chunks.push({ before: raw, text: '', after: '' });
    cursor = end;
  }
  return chunks;
}
