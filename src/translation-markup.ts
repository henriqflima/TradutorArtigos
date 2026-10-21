import type { ContentRun } from './structured-document';

export type Marker = { id: string; tag: 'eq' | 'obj'; token: string; assetId: string };

/** Inspect our restricted source markup without accepting arbitrary XML/HTML. */
export function readSourceMarkup(xml: string) {
  const root = xml.match(/^\s*<p\s+id=(['"])([A-Za-z][A-Za-z0-9_:-]{0,79})\1\s*>/);
  if (!root) throw new Error('O trecho precisa de um parágrafo com ID válido.');
  const markers = new Map<string, Marker>();
  for (const match of xml.matchAll(/<(eq|obj)\s+id=(['"])([A-Za-z0-9_-]+)\2\s*>([^<]*)<\/(eq|obj)\s*>/g)) {
    if (match[1] !== match[5] || markers.has(match[3]) || !/^LUME_[A-Z0-9_]+_PROTECTED$/.test(match[4])) {
      throw new Error('O trecho contém um marcador protegido inválido.');
    }
    markers.set(match[3], { id: match[3], tag: match[1] as 'eq' | 'obj', token: match[4], assetId: match[3] });
  }
  const runs = parseTranslationMarkup(xml, root[2], markers);
  if (!runs.some(run => run.type === 'text' && run.text.trim())) throw new Error('O trecho não contém texto para traduzir.');
  return { id: root[2], markers };
}
function fail(message: string): never { throw new Error(message); }
function decodeXml(value: string) {
  const entity = /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g;
  if (value.replace(entity, '').includes('&')) fail('A tradução contém uma entidade XML inválida.');
  return value.replace(entity, token => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[token]) return named[token];
    const code = token.startsWith('&#x') ? parseInt(token.slice(3, -1), 16) : parseInt(token.slice(2, -1), 10);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ||
        (code <= 0x1f && ![0x9, 0xa, 0xd].includes(code)) || code === 0xfffe || code === 0xffff) {
      fail('A tradução contém uma referência XML inválida.');
    }
    return String.fromCodePoint(code);
  });
}
function styleKey(style: { bold?: boolean; italic?: boolean; superscript?: boolean } | undefined) {
  return `${style?.bold ? 1 : 0}${style?.italic ? 1 : 0}${style?.superscript ? 1 : 0}`;
}
/** Deliberately accepts only the small XML vocabulary that we send to the translation provider. */
export function parseTranslationMarkup(xml: string, rootId: string, markers: Map<string, Marker>): ContentRun[] {
  if (xml.length > 200_000) fail('A resposta traduzida é excessivamente longa.');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(xml)) fail('A tradução contém caracteres incompatíveis com XML.');
  const runs: ContentRun[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  let rootOpened = false, rootClosed = false, assetBody = '';
  let currentAsset: Marker | undefined;
  const appendText = (raw: string) => {
    if (!raw) return;
    if (raw.includes('<') || raw.includes(']]>')) fail('A tradução devolveu XML malformado.');
    const content = decodeXml(raw);
    if (currentAsset) { assetBody += content; return; }
    if (!stack.length) {
      if (content.trim()) fail('A resposta da tradução contém texto fora do parágrafo.');
      return;
    }
    const style = {
      ...(stack.includes('b') ? { bold: true } : {}),
      ...(stack.includes('i') ? { italic: true } : {}),
      ...(stack.includes('sup') ? { superscript: true } : {}),
    };
    const styled = Object.keys(style).length ? style : undefined;
    const last = runs[runs.length - 1];
    if (last?.type === 'text' && styleKey(last.style) === styleKey(styled)) last.text += content;
    else runs.push({ type: 'text', text: content, ...(styled ? { style: styled } : {}) });
  };
  let position = 0;
  while (position < xml.length) {
    const start = xml.indexOf('<', position);
    if (start < 0) { appendText(xml.slice(position)); position = xml.length; break; }
    appendText(xml.slice(position, start));
    const end = xml.indexOf('>', start + 1);
    if (end < 0) fail('A tradução devolveu XML incompleto.');
    const tag = xml.slice(start, end + 1);
    if (/^<p\s+id=(['"])([^'"]+)\1\s*>$/.test(tag)) {
      const id = tag.match(/^<p\s+id=(['"])([^'"]+)\1\s*>$/)![2];
      if (rootOpened || rootClosed || stack.length || id !== rootId) fail('A tradução alterou o ID do parágrafo.');
      rootOpened = true; stack.push('p');
    } else if (/^<\/p\s*>$/.test(tag)) {
      if (stack.length !== 1 || stack[0] !== 'p') fail('A tradução alterou a estrutura do parágrafo.');
      stack.pop(); rootClosed = true;
    } else if (/^<(b|i|sup)\s*>$/.test(tag)) {
      if (!stack.length || stack[0] !== 'p' || currentAsset) fail('A tradução alterou a marcação de estilo.');
      stack.push(tag.match(/^<(b|i|sup)/)![1]);
    } else if (/^<\/(b|i|sup)\s*>$/.test(tag)) {
      const name = tag.match(/^<\/(b|i|sup)/)![1];
      if (stack[stack.length - 1] !== name) fail('A tradução devolveu estilos malformados.');
      stack.pop();
    } else if (/^<(eq|obj)\s+id=(['"])([A-Za-z0-9_-]+)\2\s*>$/.test(tag)) {
      const match = tag.match(/^<(eq|obj)\s+id=(['"])([A-Za-z0-9_-]+)\2\s*>$/)!;
      const marker = markers.get(match[3]);
      if (!stack.length || stack[0] !== 'p' || currentAsset || !marker || marker.tag !== match[1] || seen.has(marker.id)) {
        fail('A tradução omitiu, duplicou ou alterou um marcador protegido.');
      }
      currentAsset = marker; assetBody = ''; stack.push(marker.tag);
    } else if (/^<\/(eq|obj)\s*>$/.test(tag)) {
      const name = tag.match(/^<\/(eq|obj)/)![1];
      if (!currentAsset || stack[stack.length - 1] !== name || assetBody !== currentAsset.token) {
        fail('A tradução alterou o conteúdo de uma equação ou figura protegida.');
      }
      stack.pop(); seen.add(currentAsset.id);
      runs.push({ type: 'asset', assetId: currentAsset.assetId });
      currentAsset = undefined; assetBody = '';
    } else {
      fail('A tradução devolveu uma marcação XML inesperada.');
    }
    position = end + 1;
  }
  if (!rootOpened || !rootClosed || stack.length || currentAsset || seen.size !== markers.size) {
    fail('A tradução omitiu ou duplicou parte da estrutura protegida.');
  }
  return runs;
}

