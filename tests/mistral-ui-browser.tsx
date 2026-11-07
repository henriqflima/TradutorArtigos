import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PDFDocument } from 'pdf-lib';
import StructuredTranslation from '../src/StructuredTranslation';
import type { OcrResult } from '../src/ocr-contract';
import type { SourceRect } from '../src/structured-document';
import '../src/styles.css';

const originalPrice = 'The recorded price is $5 and $10 for the two samples.';
const correctedPrice = 'The recorded price is 5 USD and 10 USD for the two samples.';
const recognized: OcrResult = { model: 'mistral-ocr-4-1', usage: { pages: 1 }, page: {
  width: 1200, height: 1600, confidence: 98, blocks: [
    { type: 'text', x: 80, y: 160, width: 1040, height: 180,
      content: 'First occurrence $x$ is measured before the second occurrence $x$ in the same paragraph.', confidence: 98 },
    { type: 'text', x: 80, y: 430, width: 1040, height: 100, content: originalPrice, confidence: 98 },
    { type: 'text', x: 80, y: 650, width: 1040, height: 100,
      content: 'Ordinary observations retain all experimental evidence and source context.', confidence: 98 },
  ],
} };

declare global {
  interface Window {
    mistralUiReady: Promise<void>;
    mistralUiData: { calls: number; crops: SourceRect[]; correctedPrice: string; originalPrice: string };
  }
}
window.mistralUiData = { calls: 0, crops: [], correctedPrice, originalPrice };
const output = document.querySelector<HTMLElement>('#result')!;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (target.origin !== location.origin) throw new Error('O teste tentou acessar um serviço externo.');
  if (String(input) !== '/api/ocr' && target.pathname !== '/api/ocr') return originalFetch(input, init);
  window.mistralUiData.calls++;
  const headers = new Headers(init?.headers);
  if (init?.method !== 'POST' || headers.get('Content-Type') !== 'application/pdf' ||
      headers.get('X-Access-Code') !== 'fixture-access' || !(init.body instanceof ArrayBuffer)) {
    throw new Error('O teste não recebeu PDF binário com código de acesso.');
  }
  if ((await PDFDocument.load(init.body)).getPageCount() !== 1) throw new Error('A chamada OCR não contém exatamente uma página.');
  return Response.json(structuredClone(recognized), { headers: { 'Cache-Control': 'no-store' } });
};

async function fixture(): Promise<File> {
  const scan = document.createElement('canvas'); scan.width = 1200; scan.height = 1600;
  const ctx = scan.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, scan.width, scan.height);
  ctx.fillStyle = '#111'; ctx.font = '32px Arial';
  ctx.fillText('First occurrence x is measured before', 80, 220);
  ctx.fillText('the second occurrence x in the same paragraph.', 80, 285);
  const first = { x: (80 + ctx.measureText('First occurrence ').width - 3) / 2, y: 187 / 2, width: 30 / 2, height: 40 / 2 };
  const second = { x: (80 + ctx.measureText('the second occurrence ').width - 3) / 2, y: 252 / 2, width: 30 / 2, height: 40 / 2 };
  window.mistralUiData.crops = [first, second];
  ctx.fillText(originalPrice, 80, 480);
  ctx.fillText('Ordinary observations retain all experimental evidence', 80, 690);
  ctx.fillText('and source context.', 80, 735);
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(scan.toDataURL('image/png'));
  pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  return new File([new Uint8Array(await pdf.save()).buffer], 'mistral-review-fixture.pdf', { type: 'application/pdf' });
}

function Review({ file }: { file: File }) {
  const [code, setCode] = useState('fixture-access');
  return <StructuredTranslation file={file} source="EN" target="PT-BR" code={code} onCodeChange={setCode}
    configured ocrConfigured ocrModel="mistral-ocr-latest" accessRequired onClose={() => {}}/>;
}

window.mistralUiReady = fixture().then(file => {
  createRoot(document.getElementById('root')!).render(<StrictMode><Review file={file}/></StrictMode>);
  output.textContent = 'Revisão simulada pronta para os controles de navegador.';
}).catch(error => {
  output.textContent = error instanceof Error ? error.stack || error.message : String(error);
  output.dataset.status = 'failed'; document.body.dataset.result = 'fail';
  throw error;
});
