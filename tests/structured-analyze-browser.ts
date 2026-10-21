import { PDFDocument, StandardFonts } from 'pdf-lib';
import { analyzePdf } from '../src/structured-analyze';
import { blockText, type DocumentBlock } from '../src/structured-document';
import { validateStructuredSource } from '../src/structured-export';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function fixture(): Promise<File> {
  const pdf = await PDFDocument.create();
  const roman = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const symbol = await pdf.embedFont(StandardFonts.Symbol);
  const plot = document.createElement('canvas'); plot.width = 240; plot.height = 200;
  const context = plot.getContext('2d')!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, 240, 200);
  context.strokeStyle = '#111'; context.lineWidth = 2;
  context.beginPath(); context.moveTo(25, 10); context.lineTo(25, 180); context.lineTo(225, 180);
  context.moveTo(25, 165); context.lineTo(70, 140); context.lineTo(125, 110); context.lineTo(180, 80);
  context.stroke();
  const plotBytes = Uint8Array.from(atob(plot.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
  const image = await pdf.embedPng(plotBytes);
  const page1 = pdf.addPage([600, 780]);
  page1.drawText('A full-width scientific title', { x: 40, y: 710, size: 15, font: bold });
  for (let index = 0; index < 18; index++) {
    page1.drawText(`Single-column observation ${String(index + 1).padStart(2, '0')} describes the material response.`,
      { x: 40, y: 670 - index * 15, size: 9, font: roman });
  }
  page1.drawText('The numerical simu-', { x: 40, y: 385, size: 9, font: roman });
  page1.drawText('lations predict a stable flow.', { x: 40, y: 370, size: 9, font: roman });
  page1.drawText('The ECAE-', { x: 40, y: 340, size: 9, font: roman });
  page1.drawText('processed specimen retains its shape.', { x: 40, y: 325, size: 9, font: roman });
  page1.drawText('The deformation of a sample extruded at', { x: 40, y: 290, size: 9, font: roman });
  page1.drawText('0.45 mm/min without back-pressure resembles the original.', { x: 40, y: 275, size: 9, font: roman });
  const page2 = pdf.addPage([600, 780]);
  for (let index = 0; index < 19; index++) {
    const top = 690 - index * 20;
    page2.drawText(`Left sequence ${String(index + 1).padStart(2, '0')} describes the sample.`,
      { x: 40, y: top, size: 9, font: roman });
    page2.drawText(`Right sequence ${String(index + 1).padStart(2, '0')} describes the test.`,
      { x: 320, y: top, size: 9, font: roman });
  }
  const baseline = 255, prefix = 'nominal strain rate of 10';
  page2.drawText(prefix, { x: 320, y: baseline, size: 9, font: roman });
  let x = 320 + roman.widthOfTextAtSize(prefix, 9);
  page2.drawText('-', { x, y: baseline + 4.2, size: 6, font: roman });
  x += roman.widthOfTextAtSize('-', 6);
  page2.drawText('3', { x, y: baseline + 4.2, size: 6, font: roman });
  x += roman.widthOfTextAtSize('3', 6);
  page2.drawText(' s', { x, y: baseline, size: 9, font: roman });
  x += roman.widthOfTextAtSize(' s', 9);
  page2.drawText('-', { x, y: baseline + 4.2, size: 6, font: roman });
  x += roman.widthOfTextAtSize('-', 6);
  page2.drawText('1', { x, y: baseline + 4.2, size: 6, font: roman });
  const expressionY = 225;
  page2.drawText('plastic strain ', { x: 320, y: expressionY, size: 9, font: roman });
  x = 320 + roman.widthOfTextAtSize('plastic strain ', 9);
  // A rare one-character font mimics legacy math PDFs that expose γ as "g".
  page2.drawText('g', { x, y: expressionY, size: 10, font: bold });
  x += bold.widthOfTextAtSize('g', 10) + 1;
  page2.drawText('=', { x, y: expressionY, size: 9, font: sans });
  x += sans.widthOfTextAtSize('=', 9) + 1;
  page2.drawText('1.9. The specimen', { x, y: expressionY, size: 9, font: roman });
  const indexedY = 195, indexedPrefix = 'cross-head displacement ';
  page2.drawText(indexedPrefix, { x: 320, y: indexedY, size: 9, font: roman });
  x = 320 + roman.widthOfTextAtSize(indexedPrefix, 9);
  // Both glyphs deliberately use the common body font; font rarity must not
  // decide whether the lowered y remains attached to its base variable.
  page2.drawText('u', { x, y: indexedY, size: 9, font: roman });
  x += roman.widthOfTextAtSize('u', 9);
  page2.drawText('y: 2.5 mm.', { x, y: indexedY - 3, size: 7, font: roman });
  const page3 = pdf.addPage([600, 780]);
  page3.drawImage(image, { x: 40, y: 470, width: 235, height: 220 });
  page3.drawImage(image, { x: 325, y: 470, width: 235, height: 220 });
  page3.drawText('Fig. 1. Left plot of measured response at a ram speed of', { x: 40, y: 455, size: 7, font: roman });
  page3.drawText('45 mm/min and without back-pressure.', { x: 40, y: 445, size: 7, font: roman });
  page3.drawText('Fig. 2. Right plot of measured response.', { x: 325, y: 455, size: 7, font: roman });
  page3.drawText('The left plot records deformation during loading and recovery.', { x: 40, y: 425, size: 8, font: roman });
  page3.drawText('The right plot records deformation during unloading.', { x: 325, y: 425, size: 8, font: roman });
  page3.drawText('Additional body evidence describes the recovery mechanism.', { x: 40, y: 405, size: 8, font: roman });
  page3.drawText('Independent evidence describes the unloading mechanism.', { x: 325, y: 405, size: 8, font: roman });
  const page4 = pdf.addPage([600, 780]);
  page4.drawText('A mixed-column scientific front page', { x: 40, y: 720, size: 14, font: bold });
  for (let index = 0; index < 6; index++) {
    page4.drawText(`Metadata item ${String(index + 1).padStart(2, '0')}.`, { x: 40, y: 650 - index * 15, size: 8, font: roman });
    page4.drawText(`Abstract evidence line ${String(index + 1).padStart(2, '0')} explains how deformation and microstructure change during the extrusion process.`,
      { x: 200, y: 650 - index * 15, size: 8.3, font: roman });
  }
  for (let index = 0; index < 16; index++) {
    page4.drawText(`Lower left body ${String(index + 1).padStart(2, '0')} follows the abstract.`,
      { x: 40, y: 425 - index * 17, size: 8, font: roman });
    page4.drawText(`Lower right body ${String(index + 1).padStart(2, '0')} follows the left.`,
      { x: 320, y: 425 - index * 17, size: 8, font: roman });
  }
  const page5 = pdf.addPage([600, 780]);
  page5.drawText('Non-embedded Symbol font metrics', { x: 40, y: 710, size: 14, font: bold });
  page5.drawText('The sample was extruded under back pressure and retains its original shape.',
    { x: 40, y: 670, size: 10, font: roman });
  const symbolPrefix = 'The plastic strain was ';
  page5.drawText(symbolPrefix, { x: 40, y: 640, size: 10, font: roman });
  x = 40 + roman.widthOfTextAtSize(symbolPrefix, 10);
  page5.drawText('γ', { x, y: 640, size: 10, font: symbol });
  x += symbol.widthOfTextAtSize('γ', 10) + 1;
  page5.drawText('= 1.9. The specimen remains homogeneous.', { x, y: 640, size: 10, font: roman });
  const anglePrefix = 'The first die angle ';
  page5.drawText(anglePrefix, { x: 40, y: 610, size: 10, font: roman });
  x = 40 + roman.widthOfTextAtSize(anglePrefix, 10);
  page5.drawText('Φ', { x, y: 610, size: 10, font: symbol });
  x += symbol.widthOfTextAtSize('Φ', 10) + 1;
  page5.drawText('describes the extrusion geometry.', { x, y: 610, size: 10, font: roman });
  const bytes = await pdf.save();
  return new File([bytes as BlobPart], 'regression.pdf', { type: 'application/pdf' });
}

function text(blocks: readonly DocumentBlock[]) {
  return blocks.map(blockText).join('\n');
}

async function validateInputLimits() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 20; index++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Scientific article page ${index + 1}. Experimental methods and observations.`, { x: 50, y: 700, size: 10, font });
    page.drawText('The specimen was measured under controlled pressure and temperature.', { x: 50, y: 675, size: 10, font });
  }
  const accepted = await analyzePdf(new File([await pdf.save() as BlobPart], 'twenty-pages.pdf'), () => {});
  assert(accepted.pages.length === 20, 'O limite exato de 20 páginas deve ser aceito.');
  pdf.addPage([612, 792]);
  const rejected: [File, RegExp][] = [
    [new File([await pdf.save() as BlobPart], 'twenty-one-pages.pdf'), /20 páginas/],
    [new File([new Uint8Array(4_000_001)], 'too-large.pdf'), /4 MB/],
    [new File(['not a PDF'], 'disguised.pdf'), /PDF válido/],
  ];
  for (const [file, message] of rejected) {
    let failure: unknown;
    try { await analyzePdf(file, () => {}); } catch (error) { failure = error; }
    assert(failure instanceof Error && message.test(failure.message),
      `${file.name}: esperada recusa antes da tradução (${message}), obtido ${String(failure)}`);
  }
}

async function run() {
  const result = document.querySelector<HTMLElement>('#result')!;
  try {
    await validateInputLimits();
    const source = await fixture();
    const analyzed = await analyzePdf(source, () => undefined);
    const blocking = analyzed.issues.filter(issue => issue.severity === 'blocking');
    assert(blocking.length === 0, `Regiões bloqueadas: ${blocking.map(issue => issue.message).join('; ')}`);
    for (const block of analyzed.blocks) {
      assert([block.rect.x, block.rect.y, block.rect.width, block.rect.height, block.fontSize].every(Number.isFinite),
        `Geometria não finita no bloco ${block.id}`);
    }
    for (const asset of analyzed.assets) {
      const page = analyzed.pages[asset.page - 1];
      assert([asset.rect.x, asset.rect.y, asset.rect.width, asset.rect.height].every(Number.isFinite) &&
        asset.rect.width >= 1 && asset.rect.height >= 1 && asset.rect.x >= 0 && asset.rect.y >= 0 &&
        asset.rect.x + asset.rect.width <= page.width + 0.5 && asset.rect.y + asset.rect.height <= page.height + 0.5 && asset.png.length > 8,
      `Recorte inválido ${asset.id}`);
    }
    await validateStructuredSource(analyzed);
    const first = analyzed.blocks.filter(block => block.page === 1);
    assert(text(first).includes('A full-width scientific title'), 'Título da página de uma coluna ausente');
    assert(text(first).includes('Single-column observation 18'), 'Fim da coluna única ausente');
    assert(text(first).includes('numerical simulations predict'), 'Hifenização física não foi removida');
    assert(text(first).includes('ECAE-processed'), 'Hífen lexical foi removido');
    assert(first.some(block => block.kind === 'paragraph' && blockText(block).includes('extruded at 0.45 mm/min')),
      `Medida decimal foi classificada como título e separou a frase: ${JSON.stringify(first.map(block => ({ kind: block.kind, text: blockText(block) })))}`);
    const second = analyzed.blocks.filter(block => block.page === 2);
    const secondText = text(second);
    assert(secondText.indexOf('Left sequence 01') < secondText.indexOf('Left sequence 19') &&
      secondText.indexOf('Left sequence 19') < secondText.indexOf('Right sequence 01'),
    `Ordem de leitura de duas colunas incorreta: ${JSON.stringify(second.map(block => ({ x: block.rect.x, width: block.rect.width, text: blockText(block).slice(0, 95) })))}`);
    const exponent = second.find(block => block.runs.some(run => run.type === 'text' && run.text.includes('nominal strain rate')));
    assert(exponent, 'Expressão com expoentes ausente');
    const exponentAssets = exponent.runs.filter(run => run.type === 'asset');
    assert(exponentAssets.length === 1 && !blockText(exponent).includes('10-3'),
      `Expoentes não preservados como uma expressão única: ${JSON.stringify(exponent.runs)}`);
    assert(exponentAssets[0].type === 'asset' && analyzed.assets.find(asset => asset.id === exponentAssets[0].assetId)?.rect.width! > 20,
      'Recorte dos expoentes não cobre a expressão inteira');
    const strain = second.find(block => block.runs.some(run => run.type === 'text' && run.text.includes('plastic strain')));
    assert(strain, 'Deformação plástica ausente');
    const strainAssets = strain.runs.filter(run => run.type === 'asset');
    assert(strainAssets.length === 1 && !blockText(strain).includes('=1.9') &&
      strain.runs.some(run => run.type === 'text' && run.text.includes('The specimen')),
    `Símbolo, operador e valor não preservados juntos: ${JSON.stringify(strain.runs)}`);
    assert(strainAssets[0].type === 'asset' && analyzed.assets.find(asset => asset.id === strainAssets[0].assetId)?.rect.width! > 15,
      `Recorte de γ = 1.9 não cobre símbolo, operador e valor: ${JSON.stringify({ runs: strain.runs,
        rect: strainAssets[0].type === 'asset' ? analyzed.assets.find(asset => asset.id === strainAssets[0].assetId)?.rect : undefined })}`);
    const indexed = second.find(block => block.runs.some(run => run.type === 'text' && run.text.includes('cross-head displacement')));
    assert(indexed, 'Variável com índice ausente');
    const indexedAssets = indexed.runs.filter(run => run.type === 'asset');
    assert(indexedAssets.length === 1 && !blockText(indexed).includes('y:') && blockText(indexed).includes(': 2.5 mm.'),
      `Índice em fonte comum não preservado junto à variável ou prosa incluída: ${JSON.stringify(indexed.runs)}`);
    const third = analyzed.blocks.filter(block => block.page === 3);
    const figures = third.filter(block => block.kind === 'figure');
    const captions = third.filter(block => block.kind === 'caption');
    assert(figures.length === 2 && captions.length === 2, `Esperadas duas figuras e legendas: ${figures.length}/${captions.length}`);
    assert(new Set(figures.map(figure => figure.captionId)).size === 2 &&
      figures.every(figure => captions.some(caption => caption.id === figure.captionId)), 'Legendas repetidas ou não associadas');
    assert(captions.some(caption => blockText(caption).startsWith('Fig. 1. Left plot')) &&
      captions.some(caption => blockText(caption).startsWith('Fig. 2. Right plot')),
    'Legendas de colunas paralelas foram mescladas');
    assert(captions.some(caption => blockText(caption).startsWith('Fig. 1.') &&
      blockText(caption).includes('45 mm/min and without back-pressure.')),
    'Continuação numérica da legenda foi separada da figura');
    const fourth = text(analyzed.blocks.filter(block => block.page === 4));
    assert(fourth.indexOf('Metadata item 06') < fourth.indexOf('Abstract evidence line 01') &&
      fourth.indexOf('Abstract evidence line 06') < fourth.indexOf('Lower left body 01') &&
      fourth.indexOf('Lower left body 16') < fourth.indexOf('Lower right body 01'),
    `Faixas de colunas com divisórias diferentes foram intercaladas: ${fourth.slice(0, 700)}`);
    const fifth = analyzed.blocks.filter(block => block.page === 5);
    assert(text(fifth).includes('The sample was extruded under back pressure') &&
      text(fifth).includes('The specimen remains homogeneous.') && text(fifth).includes('describes the extrusion geometry.'),
    'A prosa junto à fonte Symbol foi omitida');
    const symbolAssets = analyzed.assets.filter(asset => asset.page === 5 && asset.kind === 'equation-inline');
    assert(symbolAssets.length === 2, `Símbolos γ e Φ não preservados: ${symbolAssets.length} recortes`);
    for (const asset of symbolAssets) {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(asset.png).buffer], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 180) ink++;
      assert(ink > 30, `Símbolo sem traços no recorte ${asset.id}`);
    }
    assert(analyzed.issues.some(issue => issue.id === 'approximate-font-metrics-5' && issue.severity === 'warning'),
      'Métricas aproximadas de Symbol não foram sinalizadas para revisão');
    result.dataset.status = 'passed';
    result.textContent = `OK: limites de entrada (4 MB/20 páginas), 1 coluna, 2 colunas, divisórias variáveis, expoentes, figuras/legendas e fonte Symbol sem métricas; ${analyzed.blocks.length} blocos.`;
  } catch (error) {
    result.dataset.status = 'failed';
    result.textContent = error instanceof Error ? error.stack || error.message : String(error);
  }
}

void run();
