import { createRoot } from 'react-dom/client';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist';
import StructuredTranslation from '../src/StructuredTranslation';
import { pdfSourceOptions } from '../src/pdf-options';
import { OCR_ENGINE, type OcrBlock, type OcrResult } from '../src/ocr-contract';

declare global {
  interface Window { structuredUiReady: Promise<void> }
}

const revokedUrls: string[] = [];
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = url => { revokedUrls.push(url); revoke(url); };
Object.assign(window, { structuredRevokedUrls: revokedUrls });

// These native-text pages also use the OCR contract. Preserve any translation
// mock installed by the browser runner, and never call a paid OCR service.
const previousFetch = window.fetch.bind(window);
const ocrRequests: { sourcePage: number; pages: number }[] = [];
Object.assign(window, { structuredOcrRequests: ocrRequests });
function recognizedText(content: string, x: number, baseline: number, width: number,
  size = 12, type = 'text'): OcrBlock {
  return { type, x, y: 792 - baseline - size, width, height: size * 1.2, content, confidence: 99 };
}
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (String(input) !== '/api/ocr' && url.pathname !== '/api/ocr') return previousFetch(input, init);
  if (init?.method !== 'POST' || !(init.body instanceof ArrayBuffer)) throw new Error('A fixture exige PDF binário para OCR.');
  const source = await PDFDocument.load(init.body);
  if (source.getPageCount() !== 1) throw new Error('Cada chamada OCR precisa conter exatamente uma página.');
  const pdf = await getDocument({ data: new Uint8Array(init.body.slice(0)), ...pdfSourceOptions() }).promise;
  let originalText = '';
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    originalText = content.items.filter(item => 'str' in item).map(item => item.str).join(' ');
  } finally { await pdf.destroy(); }
  const first = originalText.includes('Plastic shear strain');
  ocrRequests.push({ sourcePage: first ? 1 : 2, pages: source.getPageCount() });
  const blocks: OcrBlock[] = first ? [
    recognizedText('Plastic shear strain', 70, 710, 250, 17, 'title'),
    recognizedText('The plastic strain was 1.9 at room temperature.', 70, 670, 315),
    recognizedText('The sample was extruded under back pressure.', 70, 643, 320),
    ...Array.from({ length: 10 }, (_, index) => recognizedText(`Method note ${index + 1}. The extrusion velocity was controlled.`, 70, 590 - index * 39, 390, 11)),
    recognizedText('The final observation continues on the', 70, 135, 300, 11),
  ] : [
    recognizedText('following page and remains one paragraph.', 70, 755, 330, 11),
    recognizedText('Results and equations', 70, 710, 280, 17, 'title'),
    recognizedText('The predicted relation is shown below.', 70, 670, 310),
    { type: 'equation', x: 74, y: 249, width: 315, height: 53, content: '$\\gamma = 2 \\cot(\\Phi/2 + \\Psi/2)$', confidence: 98 },
    recognizedText('Fig. 1. Preserved mathematical expression.', 74, 466, 300, 10, 'caption'),
    { type: 'image', x: 74, y: 417, width: 230, height: 75, content: '', confidence: null },
    recognizedText('Figure 2. Experimental trend.', 74, 283, 230, 10, 'caption'),
  ];
  const result: OcrResult = { model: OCR_ENGINE, usage: { pages: 1 },
    page: { width: 612, height: 792, confidence: 99, blocks } };
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
};

async function fixture(): Promise<File> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([612, 792]);
  first.drawText('Plastic shear strain', { x: 70, y: 710, size: 17, font });
  first.drawText('The plastic strain was 1.9 at room temperature.', { x: 70, y: 670, size: 12, font });
  first.drawText('The sample was extruded under back pressure.', { x: 70, y: 643, size: 12, font });
  for (let index = 0; index < 10; index++) {
    first.drawText(`Method note ${index + 1}. The extrusion velocity was controlled.`,
      { x: 70, y: 590 - index * 39, size: 11, font });
  }
  first.drawText('The final observation continues on the', { x: 70, y: 135, size: 11, font });
  const second = pdf.addPage([612, 792]);
  second.drawText('following page and remains one paragraph.', { x: 70, y: 755, size: 11, font });
  second.drawText('Results and equations', { x: 70, y: 710, size: 17, font });
  second.drawText('The predicted relation is shown below.', { x: 70, y: 670, size: 12, font });

  const equation = document.createElement('canvas'); equation.width = 780; equation.height = 130;
  const ctx = equation.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, equation.width, equation.height);
  ctx.fillStyle = '#111'; ctx.font = '47px Cambria, Times New Roman, serif';
  ctx.fillText('γ = 2 cot(Φ/2 + Ψ/2)', 16, 85);
  const eqPng = await pdf.embedPng(equation.toDataURL('image/png'));
  second.drawImage(eqPng, { x: 74, y: 490, width: 315, height: 53 });
  second.drawText('Fig. 1. Preserved mathematical expression.', { x: 74, y: 466, size: 10, font });

  const figure = document.createElement('canvas'); figure.width = 460; figure.height = 150;
  const figureCtx = figure.getContext('2d')!;
  figureCtx.fillStyle = '#fff'; figureCtx.fillRect(0, 0, figure.width, figure.height);
  figureCtx.strokeStyle = '#222'; figureCtx.lineWidth = 4;
  figureCtx.strokeRect(8, 8, 444, 134);
  figureCtx.beginPath(); figureCtx.moveTo(30, 115); figureCtx.lineTo(150, 80); figureCtx.lineTo(280, 90); figureCtx.lineTo(420, 30); figureCtx.stroke();
  const figPng = await pdf.embedPng(figure.toDataURL('image/png'));
  second.drawImage(figPng, { x: 74, y: 300, width: 230, height: 75 });
  second.drawText('Figure 2. Experimental trend.', { x: 74, y: 283, size: 10, font });

  const bytes = await pdf.save();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new File([buffer], 'synthetic-equations.pdf', { type: 'application/pdf' });
}

window.structuredUiReady = fixture().then(file => {
  const root = createRoot(document.getElementById('root')!);
  Object.assign(window, { structuredUiUnmount: () => root.unmount() });
  root.render(
    <StructuredTranslation file={file} source="EN" target="PT-BR" code="" configured ocrConfigured onClose={() => {}} />,
  );
});
