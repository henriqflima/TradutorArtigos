import { describe, expect, it } from 'vitest';
import { countWords, MAX_TEXT_WORDS, splitPlainText, TEXT_CHUNK_CHARACTERS, validatePlainText } from '../src/plain-text';

describe('plain text input', () => {
  it('counts words across spaces, tabs, line breaks and Unicode whitespace', () => {
    expect(countWords('')).toBe(0);
    expect(countWords(' \n\t ')).toBe(0);
    expect(countWords('  Olá,\tworld!\nこんにちは\u00a0mundo\u3000fim  ')).toBe(5);
  });

  it('accepts exactly 10,000 words and rejects the next word without truncation', () => {
    const text = Array(MAX_TEXT_WORDS).fill('palavra').join(' ');
    expect(validatePlainText(text)).toBeNull();
    expect(validatePlainText(text + '\nmais')).toContain('10.000 palavras');
  });

  it.each([null, 1, true, [], ['text'], { name: 'file.txt' }, new Uint8Array([80, 75])])
    ('rejects non-text input %j', value => expect(validatePlainText(value)).toContain('somente texto'));

  it('rejects empty and binary content while treating typed markup as literal text', () => {
    expect(validatePlainText('\n\t ')).toContain('Digite ou cole');
    expect(validatePlainText('binary\u0000content')).toContain('texto válido');
    expect(validatePlainText('<script>alert("hello")</script> & 2 < 3')).toBeNull();
  });
});

describe('plain text chunks', () => {
  it.each([
    '  Hello.\n\nWorld!\t\n',
    'A sentence with words. '.repeat(600),
    'Um parágrafo.\n\nOutro parágrafo.\n'.repeat(500),
    '漢字😀'.repeat(2000),
    ' '.repeat(6000) + 'Text.\n',
    'a'.repeat(8000),
  ])('preserves every character and bounds provider chunks', text => {
    const chunks = splitPlainText(text);
    expect(chunks.map(chunk => chunk.before + chunk.text + chunk.after).join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(TEXT_CHUNK_CHARACTERS);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
  });
});
