const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export type WordStructure = {
  keepNextMarkers: string[];
  tableHeaderMarkers: string[];
};

const children = (element: Element, name: string) => Array.from(element.children)
  .filter(child => child.namespaceURI === WORD_NS && child.localName === name);
const enabled = (element: Element | undefined) => Boolean(element) &&
  !['0', 'false', 'off'].includes(element!.getAttributeNS(WORD_NS, 'val') ?? '1');

/** Empty bookmarks survive docx-preview's renderer without adding visible text.
 * Only the temporary rendering package is changed. */
export function prepareWordStructure(xml: Document, partId: string): WordStructure {
  const result: WordStructure = { keepNextMarkers: [], tableHeaderMarkers: [] };
  const bookmarks = Array.from(xml.getElementsByTagNameNS(WORD_NS, 'bookmarkStart'));
  const ids = new Set(bookmarks.map(bookmark => bookmark.getAttributeNS(WORD_NS, 'id')));
  const names = new Set(bookmarks.map(bookmark => bookmark.getAttributeNS(WORD_NS, 'name')));
  let nextId = 0;
  let index = 0;
  const mark = (paragraph: Element, kind: string) => {
    while (ids.has(String(nextId))) nextId++;
    const id = String(nextId++); ids.add(id);
    let name: string;
    do { name = `LUME_STRUCTURE_${encodeURIComponent(partId)}_${kind}_${index++}`; } while (names.has(name));
    names.add(name);
    const start = xml.createElementNS(WORD_NS, 'w:bookmarkStart');
    start.setAttributeNS(WORD_NS, 'w:id', id);
    start.setAttributeNS(WORD_NS, 'w:name', name);
    const end = xml.createElementNS(WORD_NS, 'w:bookmarkEnd');
    end.setAttributeNS(WORD_NS, 'w:id', id);
    // pPr must remain the first child of a Word paragraph.
    const firstContent = Array.from(paragraph.children).find(child => child.localName !== 'pPr');
    paragraph.insertBefore(start, firstContent ?? null);
    paragraph.insertBefore(end, start.nextSibling);
    return name;
  };

  for (const paragraph of Array.from(xml.getElementsByTagNameNS(WORD_NS, 'p'))) {
    const props = children(paragraph, 'pPr')[0];
    if (props && enabled(children(props, 'keepNext')[0])) result.keepNextMarkers.push(mark(paragraph, 'keep'));
  }
  for (const table of Array.from(xml.getElementsByTagNameNS(WORD_NS, 'tbl'))) {
    // Word only repeats consecutive header rows starting at the first row.
    for (const row of children(table, 'tr')) {
      const props = children(row, 'trPr')[0];
      if (!props || !enabled(children(props, 'tblHeader')[0])) break;
      const paragraph = children(row, 'tc').flatMap(cell => children(cell, 'p'))[0];
      if (!paragraph) throw new Error('Não foi possível preservar o cabeçalho de uma tabela. Baixe o Word traduzido e exporte pelo seu editor.');
      result.tableHeaderMarkers.push(mark(paragraph, 'header'));
    }
  }
  return result;
}

/** Restore structural properties that docx-preview parses but does not emit. */
export function applyWordStructure(host: HTMLElement, metadata: readonly WordStructure[]) {
  const keep = new Set(metadata.flatMap(part => part.keepNextMarkers));
  const headers = new Set(metadata.flatMap(part => part.tableHeaderMarkers));
  const tableRows = new Map<HTMLTableElement, Set<HTMLTableRowElement>>();
  for (const marker of Array.from(host.querySelectorAll<HTMLElement>('[id]'))) {
    if (keep.has(marker.id)) {
      const paragraph = marker.closest('p');
      if (paragraph) paragraph.dataset.keepNext = 'true';
      marker.remove();
    } else if (headers.has(marker.id)) {
      const row = marker.closest('tr');
      const table = row?.closest('table');
      if (row && table) {
        if (!tableRows.has(table)) tableRows.set(table, new Set());
        tableRows.get(table)!.add(row);
      }
      marker.remove();
    }
  }
  for (const [table, marked] of tableRows) {
    const rows = Array.from(table.rows);
    let count = 0;
    while (count < rows.length && marked.has(rows[count])) count++;
    if (count !== marked.size || rows.slice(0, count).some((row, index) =>
      Array.from(row.cells).some(cell => cell.rowSpan === 0 || index + cell.rowSpan > count))) {
      throw new Error('O cabeçalho da tabela possui células mescladas com o corpo. Baixe o Word traduzido e exporte pelo seu editor.');
    }
    const head = table.tHead ?? table.createTHead();
    for (const row of rows.slice(0, count)) head.append(row);
    for (const body of Array.from(table.tBodies)) if (!body.rows.length) body.remove();
  }
}
