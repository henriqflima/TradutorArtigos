import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { createPdf, renderWordPages } from '../src/pdf';
import '../src/styles.css';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorker;

async function fixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>Artigo de teste — dados sintéticos</w:t></w:r></w:p><w:p><w:r><w:t>Um parágrafo em português com acentuação: ciência, tradução e compreensão.</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8"/><w:bottom w:val="single" w:sz="8"/><w:insideV w:val="single" w:sz="8"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Grupo</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Resultado</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><m:oMath><m:f><m:num><m:r><m:t>x+1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Segunda página: referências preservadas no teste.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`);
  const drawing = '<w:p xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="952500"/><wp:docPr id="1" name="Figura"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Figura"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  zip.file('word/document.xml', (await zip.file('word/document.xml')!.async('string')).replace('<w:sectPr>', drawing + '<w:sectPr>'));
  const figure = document.createElement('canvas'); figure.width = 400; figure.height = 200;
  const brush = figure.getContext('2d')!; brush.fillStyle = '#eaf0ec'; brush.fillRect(0, 0, 400, 200); brush.fillStyle = '#18383e'; brush.font = '22px Arial'; brush.fillText('Figura sintética de teste', 20, 100);
  zip.file('word/media/test.png', figure.toDataURL('image/png').split(',')[1], { base64: true });
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/test.png"/></Relationships>');
  const r = (value: string) => `<m:r><m:t>${value}</m:t></m:r>`;
  const equations = [
    `<m:sSubSup><m:e>${r('x')}</m:e><m:sub>${r('i')}</m:sub><m:sup>${r('2')}</m:sup></m:sSubSup>${r(' + α ≤ β')}`,
    `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r('a²+b²')}</m:e></m:rad>`,
    `<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub>${r('i=1')}</m:sub><m:sup>${r('n')}</m:sup><m:e>${r('xᵢ')}</m:e></m:nary>`,
    `<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr><m:e>${r('v')}</m:e></m:acc>${r(' = 0')}`,
    `<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e><m:m><m:mr><m:e>${r('a')}</m:e><m:e>${r('b')}</m:e></m:mr><m:mr><m:e>${r('c')}</m:e><m:e>${r('d')}</m:e></m:mr></m:m></m:e></m:d>`,
  ].map(math => `<w:p><m:oMathPara><m:oMath>${math}</m:oMath></m:oMathPara></w:p>`).join('');
  const paragraphs = Array.from({ length: 12 }, (_, index) => `<w:p><w:pPr><w:spacing w:after="180"/></w:pPr><w:r><w:t>Parágrafo ${index + 1}. A tradução científica precisa preservar o significado dos símbolos e a sequência de leitura. Este texto sintético ocupa espaço para testar a figura ancorada perto de uma quebra de página.</w:t></w:r></w:p>`).join('');
  const anchored = drawing.replace('<wp:inline>', '<wp:anchor simplePos="0"><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>-1000000</wp:posOffset></wp:positionV><wp:wrapNone/>').replace('</wp:inline>', '</wp:anchor>');
  const table = `<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Cabeçalho repetido</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Resultado</w:t></w:r></w:p></w:tc></w:tr>${Array.from({ length: 70 }, (_, index) => `<w:tr><w:tc><w:p><w:r><w:t>Linha ${index + 1}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Dado científico ${index + 1}</w:t></w:r></w:p></w:tc></w:tr>`).join('')}</w:tbl>`;
  zip.file('word/document.xml', (await zip.file('word/document.xml')!.async('string')).replace('<w:sectPr>', `${equations}${paragraphs}${anchored}<w:p><w:r><w:t>Figura 2. Esta legenda acompanha a figura ancorada.</w:t></w:r></w:p>${table}<w:sectPr>`));
  return zip.generateAsync({ type: 'blob' });
}

document.querySelector('#run')!.addEventListener('click', async () => {
  const result = document.querySelector('#result')!;
  const button = document.querySelector<HTMLButtonElement>('#run')!;
  button.disabled = true;
  try {
    const source = await PDFDocument.create(); source.addPage();
    const basic = await createPdf(new Blob([new Uint8Array(await source.save())]), 'test.pdf', () => undefined);
    if ((await PDFDocument.load(await basic.arrayBuffer())).getPageCount() !== 1) throw new Error('PDF inválido');
    result.textContent = 'PDF direto: OK\n';
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 200); ctx.fillStyle = 'black'; ctx.font = '20px Arial'; ctx.fillText('Digitalização de teste', 20, 50);
    const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    const image = await createPdf(png, 'scan.png', () => undefined);
    if ((await PDFDocument.load(await image.arrayBuffer())).getPageCount() !== 1) throw new Error('Imagem inválida');
    result.textContent += 'Imagem → PDF: OK\n';
    const docx = await fixture();
    const preview = await renderWordPages(docx, message => { result.textContent = message; });
    try {
      const count = preview.pages.flatMap(page => Array.from(page.querySelectorAll('[data-equation="true"]'))).length;
      if (count !== 6) throw new Error(`Equações omitidas: ${count}/6`);
      const tables = preview.pages.flatMap(page => Array.from(page.querySelectorAll('table'))).filter(table => table.textContent?.includes('Dado científico'));
      if (tables.length < 2 || tables.some(table => !table.querySelector('thead')?.textContent?.includes('Cabeçalho repetido'))) throw new Error('Cabeçalho da tabela Word não foi repetido');
      const captions = preview.pages.filter(page => page.textContent?.includes('Figura 2.'));
      if (captions.length !== 1 || !captions[0].querySelector('img:not([data-equation])')) throw new Error('Figura ancorada separada da legenda');
    } finally { preview.dispose(); }
    const word = await createPdf(docx, 'article.docx', message => { result.textContent = `PDF direto: OK\nImagem → PDF: OK\n${message}`; });
    const pages = (await PDFDocument.load(await word.arrayBuffer())).getPageCount();
    if (pages < 2) throw new Error('Perda de página no Word');
    result.textContent = `PDF direto: OK\nImagem → PDF: OK\nWord com tabela e equação → PDF: OK (${pages} páginas)\nHosts temporários restantes: ${document.querySelectorAll('.pdf-render-host').length}`;
    const link = document.createElement('a'); link.textContent = 'Abrir PDF do teste'; link.href = URL.createObjectURL(word); link.target = '_blank';
    const download = document.createElement('a'); download.textContent = 'Baixar PDF do teste'; download.href = link.href; download.download = 'lume-scientific-test.pdf';
    const output = document.querySelector('#output')!;
    output.replaceChildren(link, download);
    const finalPdf = await getDocument({ data: new Uint8Array(await word.arrayBuffer()) }).promise;
    for (let pageIndex = 1; pageIndex <= finalPdf.numPages; pageIndex++) {
      const page = await finalPdf.getPage(pageIndex);
      const viewport = page.getViewport({ scale: 1.4 });
      const raster = document.createElement('canvas'); raster.width = Math.ceil(viewport.width); raster.height = Math.ceil(viewport.height);
      await page.render({ canvas: raster, viewport }).promise;
      const image = document.createElement('img'); image.src = raster.toDataURL('image/png'); image.alt = `Página ${pageIndex} do PDF final`; image.style.cssText = 'display:block;width:650px;max-width:100%;height:auto;margin:20px 0;border:1px solid #ccd;';
      output.append(image); raster.width = raster.height = 0;
    }
    await finalPdf.destroy();
    result.textContent += '\nPDF final renderizado para inspeção: OK';
  } catch (error) { result.textContent = `FALHA: ${error instanceof Error ? error.stack : error}`; }
  finally { button.disabled = false; }
});

