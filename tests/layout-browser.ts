import { paginateDocument } from '../src/pagination';

type Fixture = { name: string; content: string; check: (pages: HTMLElement[], sourceText: string) => void };
const TOLERANCE = 2;
const result = document.querySelector<HTMLElement>('#result')!;
const previews = document.querySelector<HTMLElement>('#previews')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function normalized(value: string | null) { return (value || '').replace(/\s+/g, ' ').trim(); }
function paragraphs(pages: HTMLElement[]) { return pages.flatMap(page => Array.from(page.querySelectorAll('article p'))); }
function pageWith(pages: HTMLElement[], selector: string) { return pages.findIndex(page => Boolean(page.querySelector(selector))); }
function textOf(pages: HTMLElement[]) { return normalized(pages.map(page => page.querySelector('article')?.textContent || '').join('')); }
function svgImage(width: number, height: number, label: string, equation = false) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="#eaf0ec" stroke="#18383e" stroke-width="2"/><text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Arial" font-size="${Math.min(24, height / 3)}" fill="#18383e">${label}</text></svg>`;
  return `<img ${equation ? 'data-equation="true"' : 'data-figure="true"'} alt="${label}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" width="${width}" height="${height}" style="width:${width}px;height:${height}px">`;
}
function filler(height: number, label = 'Espaço de conteúdo anterior') {
  return `<div class="filler" style="height:${height}px;background:linear-gradient(#f5f7f6,#eaf0ec)"><span>${label}</span></div>`;
}
function checkGeometry(pages: HTMLElement[]) {
  for (const [index, page] of pages.entries()) {
    const pageBox = page.getBoundingClientRect();
    const style = getComputedStyle(page);
    const left = pageBox.left + parseFloat(style.paddingLeft);
    const right = pageBox.right - parseFloat(style.paddingRight);
    const top = pageBox.top + parseFloat(style.paddingTop);
    const bottom = pageBox.top + 800 - parseFloat(style.paddingBottom);
    assert(Math.abs(pageBox.width - 600) <= TOLERANCE, `Página ${index + 1}: largura original alterada (${pageBox.width}).`);
    assert(pageBox.height <= 800 + TOLERANCE, `Página ${index + 1}: altura excede a página (${pageBox.height}).`);
    const blocks = Array.from(page.querySelectorAll<HTMLElement>(':scope > article > *'));
    let priorBottom = top;
    for (const block of blocks) {
      const box = block.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      assert(box.top >= top - TOLERANCE && box.bottom <= bottom + TOLERANCE,
        `Página ${index + 1}: bloco ${block.tagName} invade margem vertical (${(box.top - top).toFixed(1)} a ${(box.bottom - top).toFixed(1)}).`);
      assert(box.left >= left - TOLERANCE && box.right <= right + TOLERANCE,
        `Página ${index + 1}: bloco ${block.tagName} invade margem horizontal.`);
      assert(box.top >= priorBottom - TOLERANCE, `Página ${index + 1}: blocos consecutivos se sobrepõem.`);
      priorBottom = box.bottom;
    }
    for (const media of Array.from(page.querySelectorAll<HTMLElement>('article img, article svg'))) {
      const box = media.getBoundingClientRect();
      assert(box.left >= left - TOLERANCE && box.right <= right + TOLERANCE && box.top >= top - TOLERANCE && box.bottom <= bottom + TOLERANCE,
        `Página ${index + 1}: imagem ou equação ultrapassa a área útil.`);
      // Range rectangles expose text outside of parent boxes, including positioned images.
      const walker = document.createTreeWalker(page.querySelector('article')!, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!normalized(node.textContent) || media.contains(node)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const textBox of Array.from(range.getClientRects())) {
          const overlapX = Math.min(box.right, textBox.right) - Math.max(box.left, textBox.left);
          const overlapY = Math.min(box.bottom, textBox.bottom) - Math.max(box.top, textBox.top);
          assert(overlapX <= TOLERANCE || overlapY <= TOLERANCE,
            `Página ${index + 1}: imagem/equação cobre texto (${normalized(node.textContent).slice(0, 35)}).`);
        }
      }
    }
  }
}

const longText = Array.from({ length: 180 }, (_, index) => `<span${index % 3 === 0 ? ' style="font-weight:bold"' : index % 3 === 1 ? ' style="font-style:italic"' : ''}>Trecho ${index + 1}: ciência e tradução preservam o conteúdo. </span>`).join('');
const fixtures: Fixture[] = [
  {
    name: 'Figura perto do fim da página permanece com a legenda, mesmo com parágrafos vazios',
    content: `${filler(520)}<p>${svgImage(380, 150, 'Figura próxima à quebra')}</p><p> </p><p></p><p class="docx_caption" data-caption="true">Figura 1. Legenda que deve acompanhar a imagem completa.</p><p>Texto depois da legenda.</p>`,
    check(pages, sourceText) {
      assert(pages.length >= 2, 'A figura e legenda deveriam ser movidas para uma nova página.');
      assert(pageWith(pages, '[data-figure]') === pageWith(pages, '[data-caption]'), 'Figura e legenda ficaram em páginas distintas.');
      assert(textOf(pages) === sourceText, 'Texto perdido ou duplicado ao mover figura e legenda.');
    },
  },
  {
    name: 'Equação inline conserva sua unidade e os trechos de texto',
    content: `${filler(590)}<p data-equation-paragraph="true">A relação ${svgImage(150, 54, 'x = (a + b) / 2', true)} descreve a média. A interpretação científica permanece na mesma sequência de leitura e pode continuar na próxima linha.</p><p>Conclusão após a equação.</p>`,
    check(pages, sourceText) {
      assert(pages.flatMap(page => Array.from(page.querySelectorAll('[data-equation]'))).length === 1, 'Equação duplicada ou omitida.');
      assert(textOf(pages) === sourceText, 'Texto ao redor da equação foi perdido ou duplicado.');
      const img = pages.flatMap(page => Array.from(page.querySelectorAll<HTMLImageElement>('[data-equation]')))[0];
      const box = img.getBoundingClientRect();
      assert(Math.abs(box.width / box.height - 150 / 54) < .03, 'Equação teve a proporção alterada.');
    },
  },
  {
    name: 'Parágrafo longo se divide mantendo texto e formatação',
    content: `<p class="docx_heading1">Texto científico extenso</p><p data-long="true">${longText}</p><p>Última frase do documento.</p>`,
    check(pages, sourceText) {
      assert(pages.length >= 3, 'Parágrafo extenso não foi paginado.');
      assert(textOf(pages) === sourceText, 'Parágrafo longo perdeu ou duplicou palavras.');
      const spans = pages.flatMap(page => Array.from(page.querySelectorAll<HTMLElement>('article span')));
      assert(spans.some(span => getComputedStyle(span).fontWeight === '700'), 'Negrito foi perdido na divisão.');
      assert(spans.some(span => getComputedStyle(span).fontStyle === 'italic'), 'Itálico foi perdido na divisão.');
      const headingPage = pages.find(page => page.querySelector('.docx_heading1'))!;
      assert(paragraphs([headingPage]).length >= 2, 'Título ficou isolado na página.');
    },
  },
  {
    name: 'Tabela longa respeita rowspan e repete o cabeçalho',
    content: `<p class="docx_heading1">Tabela de resultados</p><table><colgroup><col style="width:160px"><col style="width:320px"></colgroup><thead><tr><th>Grupo</th><th>Resultado</th></tr></thead><tbody>${Array.from({ length: 54 }, (_, index) => {
      const merged = index === 17 ? '<td rowspan="3" data-merged="true">Grupo conjunto</td>' : index === 18 || index === 19 ? '' : `<td>Grupo ${index + 1}</td>`;
      return `<tr data-row="${index}">${merged}<td>Resultado ${index + 1}: ${index * 7 + 3}</td></tr>`;
    }).join('')}</tbody></table><p>Fim da tabela.</p>`,
    check(pages) {
      assert(pages.length >= 3, 'Tabela longa não foi paginada.');
      const tables = pages.flatMap(page => Array.from(page.querySelectorAll('article table')));
      assert(tables.length >= 3, 'Faltam continuações da tabela.');
      assert(tables.every(table => table.querySelector('thead')?.textContent === 'GrupoResultado'), 'Cabeçalho não foi repetido em cada continuação.');
      for (let index = 0; index < 54; index++) {
        assert(pages.flatMap(page => Array.from(page.querySelectorAll(`[data-row="${index}"]`))).length === 1, `Linha ${index + 1} perdida ou duplicada.`);
      }
      const mergedPage = pageWith(pages, '[data-row="17"]');
      assert(mergedPage === pageWith(pages, '[data-row="18"]') && mergedPage === pageWith(pages, '[data-row="19"]'), 'A quebra atravessou um rowspan.');
      assert(pages.flatMap(page => Array.from(page.querySelectorAll('[data-merged]'))).length === 1, 'Célula mesclada duplicada ou omitida.');
    },
  },
  {
    name: 'Imagem maior que a página é reduzida proporcionalmente',
    content: `<p>${svgImage(1200, 1800, 'Figura vertical grande')}</p><p class="docx_caption" data-caption="true">Figura 2. Legenda da imagem grande.</p><p>Fim da figura grande.</p>`,
    check(pages, sourceText) {
      const images = pages.flatMap(page => Array.from(page.querySelectorAll<HTMLImageElement>('[data-figure]')));
      assert(images.length === 1, 'Imagem grande dividida ou omitida.');
      const box = images[0].getBoundingClientRect();
      assert(Math.abs(box.width / box.height - 2 / 3) < .01, 'Imagem grande perdeu sua proporção.');
      assert(box.width < 1200 && box.height < 1800, 'Imagem grande não foi redimensionada.');
      assert(pageWith(pages, '[data-figure]') === pageWith(pages, '[data-caption]'), 'Imagem grande ficou separada da legenda.');
      assert(textOf(pages) === sourceText, 'Texto perdido após imagem grande.');
    },
  },
  {
    name: 'Título próximo ao rodapé acompanha o primeiro parágrafo',
    content: `${filler(625)}<p class="docx_heading1" data-heading="true">Discussão</p><p data-following="true">Este primeiro parágrafo explica os resultados e deve acompanhar o título, com pelo menos duas linhas visíveis na mesma página.</p>`,
    check(pages, sourceText) {
      assert(pages.length >= 2, 'Título deveria ter sido movido para a próxima página.');
      assert(pageWith(pages, '[data-heading]') === pageWith(pages, '[data-following]'), 'Título ficou órfão no rodapé.');
      assert(textOf(pages) === sourceText, 'Texto perdido ou duplicado ao agrupar título.');
    },
  },
];

async function run() {
  button.disabled = true;
  previews.replaceChildren();
  const messages: string[] = [];
  let passed = 0;
  try {
    for (const fixture of fixtures) {
      result.textContent = [...messages, `Executando: ${fixture.name}…`].join('\n');
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = fixture.name;
      const host = document.createElement('div');
      host.className = 'fixture-host';
      host.innerHTML = `<section class="docx" style="width:600px;min-height:800px;padding:60px"><article>${fixture.content}</article></section>`;
      details.append(summary, host);
      previews.append(details);
      try {
        await Promise.all(Array.from(host.querySelectorAll('img')).map(image => image.decode()));
        await document.fonts.ready;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const sourceText = normalized(host.querySelector('article')!.textContent);
        const pages = await paginateDocument(host);
        assert(Array.isArray(pages) && pages.length > 0, 'Nenhuma página retornada.');
        host.replaceChildren(...pages);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        checkGeometry(pages);
        fixture.check(pages, sourceText);
        passed++;
        summary.textContent = `OK — ${fixture.name} (${pages.length} páginas)`;
        messages.push(summary.textContent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.textContent = `FALHA — ${fixture.name}`;
        const failure = document.createElement('p');
        failure.className = 'case-error';
        failure.textContent = error instanceof Error ? error.stack || message : message;
        details.insertBefore(failure, host);
        messages.push(`FALHA — ${fixture.name}: ${message}`);
      }
    }
    result.textContent = `${passed}/${fixtures.length} casos aprovados.\n${messages.join('\n')}`;
    result.dataset.complete = 'true';
    result.dataset.passed = String(passed);
    result.dataset.total = String(fixtures.length);
  } finally { button.disabled = false; }
}

button.addEventListener('click', () => { void run(); });
if (new URLSearchParams(location.search).get('autorun') === '1') void run();

