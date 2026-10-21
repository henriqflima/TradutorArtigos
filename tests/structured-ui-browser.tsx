import { createRoot } from 'react-dom/client';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import StructuredTranslation from '../src/StructuredTranslation';

declare global {
  interface Window { structuredUiReady: Promise<void> }
}

const revokedUrls: string[] = [];
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = url => { revokedUrls.push(url); revoke(url); };
Object.assign(window, { structuredRevokedUrls: revokedUrls });

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
    <StructuredTranslation file={file} source="EN" target="PT-BR" code="" configured onClose={() => {}} />,
  );
});
