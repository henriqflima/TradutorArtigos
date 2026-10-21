import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import EquationRepair from '../src/EquationRepair';
import '../src/styles.css';

// Browser fixture: apply eleven repairs, undo ten, then verify the remaining
// repaired Word is downloadable although its bounded undo history is empty.
declare global {
  interface Window { historyRepairFixture: { original: Blob; current: Blob; changes: number } }
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const zip = new JSZip();
zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file('word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Equacao fragmentada</w:t></w:r></w:p><w:p><w:r><w:t>Texto preservado.</w:t></w:r></w:p></w:body></w:document>`);
const original = await zip.generateAsync({ type: 'blob' });
const pdf = await PDFDocument.create();
const page = pdf.addPage([200, 100]);
const font = await pdf.embedFont(StandardFonts.TimesRoman);
page.drawText('x = 2', { x: 10, y: 50, font, size: 12 });
const source = new File([new Uint8Array(await pdf.save())], 'original.pdf', { type: 'application/pdf' });
window.historyRepairFixture = { original, current: original, changes: 0 };
createRoot(document.getElementById('root')!).render(<EquationRepair initialSource={source} initialWord={original} originalName="fixture.docx" onClose={() => undefined} onRepaired={current => {
  window.historyRepairFixture.current = current;
  window.historyRepairFixture.changes++;
}}/>);
