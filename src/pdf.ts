import { extension, isImage } from './shared';
import { paginateDocument } from './pagination';
import { applyWordStructure, prepareWordStructure, type WordStructure } from './word-structure';
import { preserveDrawings } from './drawing-package';

export async function renderWordPages(blob: Blob, progress: (message: string) => void) {
  progress('Organizando o texto, as figuras e as equações…');
  const [{ renderAsync }, { default: JSZip }, { prepareOmmlPart }] = await Promise.all([
    import('docx-preview'), import('jszip'), import('./omml'),
  ]);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const entries = Object.values(zip.files);
  const expandedBytes = entries.reduce((sum, entry) => sum + ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0), 0);
  if (entries.length > 3000 || expandedBytes > 40_000_000) throw new Error('Este Word é complexo demais para a conversão local. Baixe o Word traduzido e exporte como PDF no seu editor.');
  const equations = new Map<string, string>();
  // Source crops carry the PDF's actual glyph shapes, independently of its
  // unreliable text encoding. Identify by package media, never by text guesses.
  const sourceCrops = new Set(await Promise.all(entries
    .filter(item => /^word\/media\/lume-equation-crop-[^/]+\.png$/.test(item.name))
    .map(item => item.async('base64'))));
  const structure: WordStructure[] = [];
  for (const entry of entries.filter(item => item.name.endsWith('.rels') || /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(item.name))) {
    const xml = new DOMParser().parseFromString(await zip.file(entry.name)!.async('string'), 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('O documento contém XML inválido. Baixe o Word traduzido para revisão.');
    if (xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'sym').length) throw new Error('Este documento usa símbolos de uma fonte legada. Para não substituir símbolos científicos, baixe o Word traduzido e exporte pelo seu editor.');
    for (const relationship of Array.from(xml.getElementsByTagName('Relationship'))) {
      if (relationship.getAttribute('TargetMode') === 'External') relationship.remove();
    }
    await preserveDrawings(zip, xml, entry.name);
    // Fixed anchors belong to the source text geometry. Inline drawings reserve
    // their real dimensions as translation changes paragraph length.
    const drawingNS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
    for (const anchor of Array.from(xml.getElementsByTagNameNS(drawingNS, 'anchor'))) {
      const inline = xml.createElementNS(drawingNS, 'wp:inline');
      for (const child of Array.from(anchor.children)) {
        if (['extent', 'effectExtent', 'docPr', 'cNvGraphicFramePr', 'graphic'].includes(child.localName)) inline.append(child);
      }
      anchor.replaceWith(inline);
    }
    for (const [id, math] of prepareOmmlPart(xml, entry.name)) equations.set(id, math);
    structure.push(prepareWordStructure(xml, entry.name));
    zip.file(entry.name, new XMLSerializer().serializeToString(xml));
  }
  const safeDocument = await zip.generateAsync({ type: 'arraybuffer' });
  // Isolate document styles from the application (especially p/footer/table).
  const frame = document.createElement('iframe');
  frame.className = 'pdf-render-host'; frame.title = 'Conversão temporária do documento';
  frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
  frame.style.cssText = 'position:absolute;left:-20000px;top:0;width:1200px;height:1200px;border:0;pointer-events:none;';
  document.body.append(frame);
  const dispose = () => frame.remove();
  try {
    const doc = frame.contentDocument!;
    doc.body.style.cssText = 'margin:0;background:white;';
    const host = doc.createElement('div'); doc.body.append(host);
    await renderAsync(safeDocument, host, host, {
      inWrapper: false, ignoreLastRenderedPageBreak: true, useBase64URL: true,
      renderAltChunks: false, renderComments: false, breakPages: true,
    });
    applyWordStructure(host, structure);
    for (const img of host.querySelectorAll<HTMLImageElement>('img')) {
      if (sourceCrops.has(img.src.split(',')[1])) {
        img.dataset.equation = 'true'; img.dataset.sourceEquation = 'true';
      }
    }
    for (const article of host.querySelectorAll<HTMLElement>('section.docx > article')) {
      article.style.columnCount = 'auto'; article.style.columnWidth = 'auto';
    }
    const style = doc.createElement('style');
    style.textContent = 'section.docx{margin:0;box-shadow:none} .pdf-continuation:before{content:none!important} .docx p{overflow:visible} .docx p,.docx span{overflow-wrap:anywhere}';
    doc.head.append(style);
    await doc.fonts.ready;
    if (host.querySelector('math')) {
      progress('Renderizando símbolos e equações com precisão…');
      const { preserveEquations } = await import('./math');
      await preserveEquations(host, equations);
    }
    try { await Promise.all(Array.from(host.querySelectorAll('img')).map(img => img.decode())); }
    catch { throw new Error('Uma figura não pôde ser renderizada. Baixe o Word traduzido e exporte pelo seu editor para preservar as imagens.'); }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    progress('Ajustando quebras de página e posição das figuras…');
    const pages = paginateDocument(host);
    return { pages, dispose };
  } catch (error) { dispose(); throw error; }
}

export async function createPdf(blob: Blob, originalName: string, progress: (message: string) => void): Promise<Blob> {
  const ext = extension(originalName);
  if (ext === 'pdf') {
    const signature = await blob.slice(0, 5).text();
    if (signature !== '%PDF-') throw new Error('O serviço não retornou um PDF válido.');
    return new Blob([blob], { type: 'application/pdf' });
  }
  if (isImage(originalName)) {
    progress('Preparando o PDF da digitalização…');
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const bytes = await blob.arrayBuffer();
    const signature = new Uint8Array(bytes);
    const img = signature[0] === 137 ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const scale = Math.min(1, 842 / Math.max(img.width, img.height));
    const page = pdf.addPage([img.width * scale, img.height * scale]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
  }
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
  const { pages, dispose } = await renderWordPages(blob, progress);
  try {
    let pdf: InstanceType<typeof jsPDF> | undefined;
    for (let index = 0; index < pages.length; index++) {
      progress(`Gerando PDF: página ${index + 1} de ${pages.length}…`);
      const page = pages[index];
      const width = page.offsetWidth;
      const height = page.offsetHeight;
      if (!width || !height || width * height > 16_000_000 || width > 5000 || height > 14000) throw new Error('Uma página ultrapassou o limite da conversão local. Baixe o Word traduzido para exportar no seu editor.');
      const canvas = await html2canvas(page, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: false, allowTaint: false });
      const w = width * 0.75, h = height * 0.75;
      const orientation = w > h ? 'landscape' : 'portrait';
      if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true });
      else pdf.addPage([w, h], orientation);
      // Lossless pages retain fine fraction bars, Greek glyphs and subscripts.
      pdf.addImage(canvas, 'PNG', 0, 0, w, h, undefined, 'FAST');
      // Reinsert original PNG samples at their final bounds. Otherwise the page
      // screenshot would downsample 400 dpi source crops to about 192 dpi.
      const pageBounds = page.getBoundingClientRect();
      for (const crop of page.querySelectorAll<HTMLImageElement>('img[data-source-equation]')) {
        const bounds = crop.getBoundingClientRect();
        pdf.addImage(crop.src, 'PNG', (bounds.left - pageBounds.left) * 0.75,
          (bounds.top - pageBounds.top) * 0.75, bounds.width * 0.75, bounds.height * 0.75, undefined, 'FAST');
      }
      canvas.width = canvas.height = 0;
    }
    if (!pdf) throw new Error('Nenhuma página foi encontrada.');
    return pdf.output('blob');
  } finally { dispose(); }
}
