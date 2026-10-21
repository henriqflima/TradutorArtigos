import { PDFDocument } from 'pdf-lib';
import { analyzePdf } from '../src/structured-analyze';
import { blockText } from '../src/structured-document';

const output = document.querySelector('#result')!;
const messages: string[] = [];
function report(message: string) { messages.push(message); output.textContent = messages.join('\n'); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function scannedFixture(pages: number) {
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1600;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000'; context.font = '32px Arial';
  ['Scientific translation preserves every source image.',
    'The experiment measures pressure and temperature.',
    'These results require careful review before publication.',
    'Local recognition keeps article images in this browser.'].forEach((text, index) => context.fillText(text, 80, 120 + index * 55));
  context.lineWidth = 4; context.beginPath(); context.moveTo(140, 470); context.lineTo(140, 800); context.lineTo(850, 800); context.stroke();
  context.beginPath(); context.moveTo(145, 770); context.lineTo(350, 720); context.lineTo(570, 590); context.lineTo(810, 500); context.stroke();
  context.fillText('Figure 1. Experimental measurements.', 80, 900);
  context.fillText('E = mc²', 300, 1100);
  const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
  const pdf = await PDFDocument.create(), image = await pdf.embedPng(await png.arrayBuffer());
  for (let index = 0; index < pages; index++) pdf.addPage([600, 800]).drawImage(image, { x: 0, y: 0, width: 600, height: 800 });
  return new File([new Uint8Array(await pdf.save())], 'digitalizado.pdf', { type: 'application/pdf' });
}

try {
  const oversized = new File([new Uint8Array(4_000_001)], 'grande.pdf', { type: 'application/pdf' });
  await analyzePdf(oversized, () => {}).then(() => { throw new Error('Arquivo acima de 4 MB foi aceito.'); }, error => assert(/4 MB/.test(error.message), error.message));
  report('PASS: arquivo acima de 4.000.000 bytes recusado.');
  const tooMany = await scannedFixture(21);
  const progress: string[] = [];
  await analyzePdf(tooMany, message => progress.push(message)).then(() => { throw new Error('PDF de 21 páginas foi aceito.'); }, error => assert(/20 páginas/.test(error.message), error.message));
  assert(!progress.some(message => /OCR|reconhecendo/i.test(message)), 'OCR iniciou antes de verificar o limite de páginas.');
  report('PASS: PDF de 21 páginas recusado antes do OCR.');
  const pageCount = new URLSearchParams(location.search).get('pages') === '20' ? 20 : 1;
  const scanned = await scannedFixture(pageCount);
  const start = performance.now();
  const manifest = await analyzePdf(scanned, message => { output.textContent = `${messages.join('\n')}\n${message}`; });
  const text = manifest.blocks.map(blockText).join(' ');
  assert(manifest.pages.length === pageCount, 'Contagem de páginas incorreta.');
  assert(text.includes('Scientific translation'), `OCR não recuperou a prosa: ${text}`);
  assert(manifest.assets.some(asset => asset.kind === 'figure'), 'Gráfico não foi preservado como recorte.');
  assert(manifest.assets.some(asset => asset.kind.startsWith('equation')), 'Equação não foi preservada como recorte.');
  assert(manifest.issues.filter(issue => issue.id.startsWith('ocr-review-')).length === pageCount, 'Faltou revisão assistida em página OCR.');
  assert(!manifest.issues.some(issue => issue.severity === 'blocking'), `Bloqueio inesperado: ${JSON.stringify(manifest.issues)}`);
  report(`PASS: ${pageCount} página(s) digitalizada(s), ${manifest.blocks.length} blocos, ${manifest.assets.length} recortes; ${Math.round((performance.now() - start) / 1000)} s.`);
  report('PASS: OCR local completo; nenhuma tradução foi solicitada.');
} catch (error) {
  report(`FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  document.body.dataset.result = 'fail';
  throw error;
}
document.body.dataset.result = 'pass';
