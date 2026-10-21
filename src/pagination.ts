const LIMIT = 80;
const fail = (detail = '') => new Error('Não foi possível paginar um elemento sem cortar seu conteúdo. Baixe o Word traduzido e exporte pelo seu editor.' + (import.meta.env.DEV && detail ? ` [${detail}]` : ''));
const px = (value: string) => parseFloat(value) || 0;
const view = (el: Element) => el.ownerDocument.defaultView!;
const css = (el: Element) => view(el).getComputedStyle(el);

function keepNext(el: HTMLElement) {
  return /heading|title|titulo/i.test(el.className) || el.dataset.keepNext === 'true';
}
function caption(el: HTMLElement) {
  return /caption|legenda/i.test(el.className) || /^(fig(?:ure|ura)?\.?|gráfico|esquema|figure)\s*\d+[.:\s]/i.test(el.textContent?.trim() || '');
}

// Word floating anchors can have zero-sized wrappers and coordinates tied to an
// earlier layout. Both the drawing and the image must reserve space in the flow.
function normalizeMedia(root: HTMLElement, width: number, height: number) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (css(el).float !== 'none') el.style.float = 'none';
  }
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const equation = img.dataset.equation === 'true';
    const bounds = img.getBoundingClientRect();
    const w = bounds.width || img.width || img.naturalWidth;
    const h = bounds.height || img.height || img.naturalHeight;
    if (!w || !h) throw fail();
    const parent = img.parentElement;
    const wrapper = !equation && parent?.tagName === 'DIV' ? parent : null;
    const cell = img.closest('td,th');
    const availableWidth = Math.min(width, cell ? cell.clientWidth - 8 : width);
    const factor = Math.min(1, availableWidth / w, (height - 48) / h);
    // Do not silently reduce a formula into illegible text.
    if (equation && factor < 0.65) throw fail();
    img.style.width = `${w * factor}px`;
    img.style.height = `${h * factor}px`;
    img.style.maxWidth = 'none';
    img.style.position = 'static';
    img.style.float = 'none';
    img.style.left = img.style.top = 'auto';
    if (wrapper) {
      wrapper.style.cssText += `;position:static;float:none;left:auto;top:auto;width:${w * factor}px;height:${h * factor}px;max-width:100%;vertical-align:middle;`;
      // Large figures get a separate line, preserving their anchor order.
      if (h > 48) wrapper.style.display = 'block';
    }
    const paragraph = img.closest('p');
    if (paragraph) {
      paragraph.style.height = 'auto';
      paragraph.style.minHeight = '0';
      paragraph.style.lineHeight = 'normal';
      paragraph.style.overflow = 'visible';
    }
  }
  for (const cell of Array.from(root.querySelectorAll<HTMLElement>('td,th,tr'))) {
    cell.style.height = 'auto';
    cell.style.minHeight = '0';
  }
}

// Only text-node word boundaries can be split; equations, images, and their
// descendants stay atomic. DOM Range preserves inline formatting and symbols.
function textCuts(el: HTMLElement): { node: Text; offset: number }[] {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const cuts: { node: Text; offset: number }[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[data-equation],math,svg')) continue;
    for (const match of node.textContent!.matchAll(/\s+/g)) {
      cuts.push({ node: node as Text, offset: match.index! + match[0].length });
    }
  }
  return cuts;
}

function splitParagraph(el: HTMLElement, container: HTMLElement, bottom: number): [HTMLElement, HTMLElement] | null {
  const cuts = textCuts(el);
  if (!cuts.length) return null;
  const part = (cut: typeof cuts[number], head: boolean) => {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    if (head) range.setEnd(cut.node, cut.offset); else range.setStart(cut.node, cut.offset);
    const clone = el.cloneNode(false) as HTMLElement;
    clone.append(range.cloneContents());
    if (head) clone.style.marginBottom = '0';
    else {
      clone.style.marginTop = '0'; clone.style.textIndent = '0';
      // Continuation fragments do not repeat numbering markers.
      clone.classList.add('pdf-continuation');
    }
    return clone;
  };
  let low = 0, high = cuts.length - 1, best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const probe = part(cuts[mid], true); container.append(probe);
    const fits = probe.getBoundingClientRect().bottom <= bottom - 2;
    probe.remove();
    if (fits) { best = mid; low = mid + 1; } else high = mid - 1;
  }
  if (best < 0) return null;
  const head = part(cuts[best], true), tail = part(cuts[best], false);
  if (!head.textContent?.trim() || (!tail.textContent?.trim() && !tail.querySelector('img,svg,math'))) return null;
  return [head, tail];
}

function tableGroups(table: HTMLTableElement): HTMLTableRowElement[][] {
  const rows = Array.from(table.rows).filter(row => row.parentElement?.tagName !== 'THEAD');
  const groups: HTMLTableRowElement[][] = [];
  for (let i = 0; i < rows.length;) {
    let end = i + 1;
    for (let j = i; j < end && j < rows.length; j++) {
      for (const cell of Array.from(rows[j].cells)) {
        end = Math.max(end, cell.rowSpan === 0 ? rows.length : j + cell.rowSpan);
      }
    }
    groups.push(rows.slice(i, end)); i = end;
  }
  return groups;
}

export function paginateDocument(host: HTMLElement): HTMLElement[] {
  const sources = Array.from(host.querySelectorAll<HTMLElement>('section.docx'));
  if (!sources.length || sources.length > 60) throw fail();
  const output: HTMLElement[] = [];
  for (const source of sources) {
    const style = css(source);
    const width = source.getBoundingClientRect().width;
    const height = px(style.minHeight) || width * Math.SQRT2;
    const top = px(style.paddingTop), bottom = px(style.paddingBottom);
    const innerWidth = width - px(style.paddingLeft) - px(style.paddingRight);
    if (width < 200 || height < 200 || width > 5000 || height > 5000 || innerWidth < 100) throw fail();
    const header = source.querySelector<HTMLElement>(':scope > header');
    const footer = source.querySelector<HTMLElement>(':scope > footer');
    // Header/footer boxes may extend into margins in docx-preview. Reserve their
    // actual non-margin space so they cannot collide with the article.
    const occupied = (el: HTMLElement | null) => el ? Math.max(0, el.getBoundingClientRect().height + px(css(el).marginTop) + px(css(el).marginBottom)) : 0;
    normalizeMedia(source, innerWidth, height - top - bottom);
    const usableHeight = height - top - bottom - occupied(header) - occupied(footer);
    if (usableHeight < 120) throw fail();
    for (const article of source.querySelectorAll<HTMLElement>(':scope > article')) {
      article.style.columnCount = 'auto'; article.style.columnWidth = 'auto';
    }
    normalizeMedia(source, innerWidth, usableHeight);
    // Moving blocks must not shrink a source page above the measured output.
    // Otherwise viewport coordinates change while contentBottom stays stale.
    source.style.position = 'absolute';
    source.style.left = '0'; source.style.top = '0'; source.style.width = `${width}px`;
    let page: HTMLElement, content: HTMLElement, contentBottom: number;
    const newPage = () => {
      if (output.length >= LIMIT) throw new Error('O documento excedeu o limite de 80 páginas. Baixe o Word traduzido.');
      page = source.cloneNode(false) as HTMLElement;
      page.classList.add('pdf-page');
      page.style.cssText += `;position:relative;left:auto;top:auto;box-sizing:border-box;width:${width}px;height:${height}px;min-height:${height}px;max-height:${height}px;display:flex;flex-direction:column;flex-shrink:0;overflow:visible;`;
      if (header) page.append(header.cloneNode(true));
      content = host.ownerDocument.createElement('article');
      content.className = 'pdf-page-content';
      content.style.cssText = `height:${usableHeight}px;min-height:${usableHeight}px;flex:none;display:flow-root;margin:0;position:relative;column-count:auto;column-width:auto;`;
      page.append(content);
      if (footer) page.append(footer.cloneNode(true));
      host.append(page); output.push(page);
      contentBottom = content.getBoundingClientRect().top + usableHeight;
    };
    newPage();
    const fits = (el: HTMLElement) => el.getBoundingClientRect().bottom + Math.max(0, px(css(el).marginBottom)) <= contentBottom + 0.5;
    const placeTable = (table: HTMLTableElement) => {
      // Freeze column widths before rows move to separately measured pages.
      table.style.width = `${Math.min(innerWidth, table.getBoundingClientRect().width || px(table.style.width) || innerWidth)}px`;
      table.style.tableLayout = 'fixed';
      const groups = tableGroups(table);
      const make = () => {
        const clone = table.cloneNode(false) as HTMLTableElement;
        for (const child of Array.from(table.children)) if (['COLGROUP', 'THEAD', 'CAPTION'].includes(child.tagName)) clone.append(child.cloneNode(true));
        const body = host.ownerDocument.createElement('tbody'); clone.append(body); content.append(clone);
        return { clone, body };
      };
      let fragment = make();
      for (const group of groups) {
        fragment.body.append(...group);
        if (fits(fragment.clone)) continue;
        group.forEach(row => row.remove());
        if (!fragment.body.children.length) fragment.clone.remove();
        if (content.children.length) newPage();
        else throw fail();
        fragment = make(); fragment.body.append(...group);
        if (!fits(fragment.clone)) throw fail();
      }
    };
    const blocks = Array.from(source.children).flatMap(el => el.tagName === 'ARTICLE' ? Array.from(el.children) : !['HEADER', 'FOOTER'].includes(el.tagName) ? [el] : []) as HTMLElement[];
    // PDF-to-Word often inserts blank spacer paragraphs before captions.
    // Keep these spacers with the figure so they cannot detach its caption.
    for (let i = 0; i < blocks.length; i++) {
      if (!blocks[i].querySelector('img:not([data-equation]),svg')) continue;
      let next = i + 1;
      while (next < Math.min(blocks.length, i + 4) && blocks[next].tagName === 'P' && !blocks[next].textContent?.trim() && !blocks[next].querySelector('img,svg,math')) next++;
      if (next < blocks.length && caption(blocks[next])) {
        const group = host.ownerDocument.createElement('div');
        group.className = 'pdf-figure-group'; group.style.display = 'flow-root';
        group.append(...blocks.splice(i, next - i + 1)); blocks.splice(i, 0, group);
      }
    }
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      content!.append(block);
      const next = blocks[i + 1];
      // Move a figure together with its caption, or a heading with its next
      // block, whenever that pair fits on a fresh page.
      if (next && (keepNext(block) || (block.querySelector('img:not([data-equation]),svg') && caption(next)))) {
        const probe = next.cloneNode(true) as HTMLElement; content!.append(probe);
        const pairFits = fits(probe); probe.remove();
        if (!pairFits && content!.children.length > 1) {
          block.remove(); newPage(); content!.append(block);
        }
      }
      if (fits(block)) continue;
      const oversized = block.getBoundingClientRect().height > usableHeight;
      block.remove();
      if (!oversized && content!.children.length) newPage();
      content!.append(block);
      if (fits(block)) continue;
      if (block.tagName === 'TABLE') {
        // Measure while attached, then detach before distributing rows.
        const measuredWidth = block.getBoundingClientRect().width;
        block.remove(); block.style.width = `${Math.min(innerWidth, measuredWidth)}px`;
        placeTable(block as HTMLTableElement); continue;
      }
      block.remove();
      if (block.tagName !== 'P') throw fail();
      let remainder = block;
      for (let pieces = 0; ; pieces++) {
        if (pieces >= LIMIT) throw fail();
        content!.append(remainder);
        if (fits(remainder)) break;
        remainder.remove();
        let split = splitParagraph(remainder, content!, contentBottom!);
        if (!split && content!.children.length) {
          newPage(); split = splitParagraph(remainder, content!, contentBottom!);
        }
        if (!split) throw fail();
        content!.append(split[0]); remainder = split[1]; newPage();
      }
    }
    source.remove();
  }
  // Never rasterize a page that still contains clipped or offset content.
  for (const page of output) {
    const area = page.querySelector<HTMLElement>('.pdf-page-content')!;
    const bounds = area.getBoundingClientRect();
    const media = Array.from(area.querySelectorAll('img,svg')).map(el => ({ el, rect: el.getBoundingClientRect() }));
    for (const el of area.querySelectorAll<HTMLElement>('p,table,img,svg')) {
      const rect = el.getBoundingClientRect();
      if (rect.width && (rect.bottom > bounds.bottom + 1 || rect.top < bounds.top - 1 || rect.right > bounds.right + 1 || rect.left < bounds.left - 1)) throw fail(`bounds ${el.tagName}: top ${rect.top - bounds.top}, bottom ${rect.bottom - bounds.bottom}, left ${rect.left - bounds.left}, right ${rect.right - bounds.right}`);
    }
    const text = area.ownerDocument.createTreeWalker(area, NodeFilter.SHOW_TEXT);
    while (text.nextNode()) {
      if (!text.currentNode.textContent?.trim()) continue;
      const range = area.ownerDocument.createRange();
      // pre-wrap can expose an invisible trailing space beyond the right edge;
      // inspect visible words so this does not reject an otherwise valid page.
      for (const word of text.currentNode.textContent.matchAll(/\S+/gu)) {
        range.setStart(text.currentNode, word.index!);
        range.setEnd(text.currentNode, word.index! + word[0].length);
        for (const rect of Array.from(range.getClientRects())) {
        if (rect.bottom > bounds.bottom + 2 || rect.top < bounds.top - 2 || rect.right > bounds.right + 2 || rect.left < bounds.left - 2) throw fail(`text bounds: top ${rect.top - bounds.top}, bottom ${rect.bottom - bounds.bottom}, left ${rect.left - bounds.left}, right ${rect.right - bounds.right}`);
        for (const item of media) {
          if (item.el.contains(text.currentNode)) continue;
          if (Math.min(rect.right, item.rect.right) - Math.max(rect.left, item.rect.left) > 2 &&
              Math.min(rect.bottom, item.rect.bottom) - Math.max(rect.top, item.rect.top) > 2) throw fail('media/text overlap');
        }
        }
      }
    }
    const pageBox = page.getBoundingClientRect();
    for (const region of page.querySelectorAll<HTMLElement>(':scope > header,:scope > footer')) {
      const box = region.getBoundingClientRect();
      if (box.top < pageBox.top - 1 || box.bottom > pageBox.bottom + 1) throw fail();
    }
  }
  return output;
}

