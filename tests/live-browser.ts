import { createPdf } from '../src/pdf';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = worker;
async function verify() {
  const status = document.querySelector('#result')!;
  try {
    const response = await fetch('/test-results/scientific-smoke-translated.docx');
    if (!response.ok) throw new Error('Execute primeiro o teste de integração com dados sintéticos.');
    const pdf = await createPdf(await response.blob(), 'synthetic.docx', message => { status.textContent = message; });
    const doc = await getDocument({ data: new Uint8Array(await pdf.arrayBuffer()) }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvas, viewport }).promise;
      const img = document.createElement('img'); img.src = canvas.toDataURL(); img.alt = `Página ${i} traduzida`;
      document.querySelector('#output')!.append(img);
    }
    status.textContent = `Word de validação → PDF local: OK (${doc.numPages} páginas). Hosts temporários: ${document.querySelectorAll('.pdf-render-host').length}.`;
    await doc.destroy();
  } catch (error) { status.textContent = `FALHA: ${error instanceof Error ? error.stack : error}`; }
}
void verify();
