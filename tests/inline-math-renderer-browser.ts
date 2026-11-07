import { rasterizeInlineMath, type InlineMathImage } from '../src/inline-math-renderer';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const formulas = [String.raw`\dot{\gamma} = 1/s`, String.raw`\eta_{0}`, String.raw`\lambda`, String.raw`m_{\mathrm{ref}}`,
  String.raw`\eta_{0,\mathrm{ref}}`, String.raw`T_{\mathrm{ref}}`, String.raw`E_a`, String.raw`C_p`, String.raw`\rho`,
  String.raw`\tau`, String.raw`\tau:\nabla\mathbf{v}`, String.raw`\eta(II_D)`, String.raw`\frac{\eta_0(T)}{1+(\lambda\dot{\gamma})^{1-n}}`,
  String.raw`\mathrm{Re}=\frac{\rho v D}{\eta}`, String.raw`x^{2}+y_{1}`, String.raw`\operatorname{exp}\left[-b(T-T_{\mathrm{ref}})\right]`,
  // Stretching accents and delimiters may contain nested SVG viewports in MathJax.
  String.raw`\overline{X}`, String.raw`\bar X`, String.raw`\underline{X}`, String.raw`\widehat{abc}`,
  String.raw`\overrightarrow{AB}`, String.raw`\sqrt{x}`, String.raw`\left(\frac{a}{b}\right)`,
  String.raw`\begin{pmatrix}\frac{a}{b}&x\\y&\sqrt{z}\end{pmatrix}`, String.raw`\overline{X+Y}`];
async function image(result: InlineMathImage, zoom = 1) {
  const src = URL.createObjectURL(new Blob([new Uint8Array(result.png).buffer], { type: 'image/png' }));
  const img = new Image(); img.src = src;
  await img.decode();
  img.style.width = `${result.widthPt * 4 / 3 * zoom}px`; img.style.height = `${result.heightPt * 4 / 3 * zoom}px`;
  img.style.verticalAlign = `${result.baselineOffsetPt * 4 / 3 * zoom}px`;
  URL.revokeObjectURL(src);
  return img;
}
async function inspect(result: InlineMathImage) {
  const img = await image(result), canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
  const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0, edge = 0;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const alpha = bytes[(y * canvas.width + x) * 4 + 3];
    if (alpha > 60) ink++;
    if ((x === 0 || y === 0 || x === canvas.width - 1 || y === canvas.height - 1) && alpha > 60) edge++;
  }
  assert(ink > 5, 'A fórmula foi produzida sem glifos visíveis.');
  assert(edge === 0, 'Uma fórmula atingiu a borda e pode ter sido cortada.');
  canvas.width = canvas.height = 0;
  return { pixels: [img.naturalWidth, img.naturalHeight], ink, baseline: result.baselineOffsetPt, width: result.widthPt, height: result.heightPt };
}
async function run() {
  const status = document.querySelector<HTMLElement>('#result')!, failures: string[] = [];
  window.addEventListener('error', event => failures.push(event.message));
  window.addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
  try {
    const rendered = new Map<string, InlineMathImage>(), measurements = [];
    for (const tex of formulas) {
      const result = await rasterizeInlineMath(tex, 10);
      assert(result.widthPt > 0 && result.heightPt > 0 && result.baselineOffsetPt <= 0, `Dimensões/baseline inválidas: ${tex}`);
      measurements.push({ tex, ...await inspect(result) }); rendered.set(tex, result);
      const card = document.createElement('div'), label = document.createElement('code'); card.className = 'sample'; label.textContent = tex;
      card.append(label, await image(result, 2)); document.querySelector('#samples')!.append(card);
    }
    const paragraphs: (string | number)[][] = [
      ['onde m é o índice de consistência (o valor da viscosidade em ', 0, '), n é o expoente da lei de potência, ', 1, ' é a viscosidade em cisalhamento zero, e a e ', 2, ' são parâmetros de ajuste.'],
      ['onde ', 3, ' e ', 4, ' são medidos em uma temperatura de referência ', 5, ', ', 6, ' é a energia de ativação e R é a constante dos gases.'],
      ['A condutividade térmica k e o calor específico ', 7, ' também são importantes. A densidade do polímero fundido ', 8, ' é geralmente cerca de 15% menor.'],
      ['onde v é o vetor velocidade, p é a pressão, ', 9, ' é o tensor de tensões e o termo ', 10, ' representa a dissipação viscosa. A viscosidade é ', 11, '.'],
      ['onde X é a variável sem escala, ', 16, ' é a média da variável e σ é o desvio padrão. A média conjunta também pode ser indicada por ', 24, '.'],
    ];
    for (const parts of paragraphs) {
      const p = document.createElement('p'); p.className = 'line';
      for (const part of parts) p.append(typeof part === 'number' ? await image(rendered.get(formulas[part])!) : document.createTextNode(part));
      document.querySelector('#paragraphs')!.append(p);
    }
    const small = await rasterizeInlineMath(String.raw`\eta_0`, 8), large = await rasterizeInlineMath(String.raw`\eta_0`, 16);
    assert(Math.abs((large.widthPt - .8) / (small.widthPt - .8) - 2) < .01, 'A escala da fonte não foi preservada.');
    const baseline = rendered.get(formulas[1])!;
    assert(baseline.baselineOffsetPt < -.4 && baseline.heightPt + baseline.baselineOffsetPt > 0, 'O subscrito perdeu a profundidade abaixo da linha de base.');
    const gammaOnly = await rasterizeInlineMath(String.raw`\dot{\gamma}`, 10), tauOnly = rendered.get(formulas[9])!, xOnly = await rasterizeInlineMath(String.raw`x^2`, 10);
    assert(rendered.get(formulas[0])!.widthPt > gammaOnly.widthPt * 2 && rendered.get(formulas[10])!.widthPt > tauOnly.widthPt * 3 && rendered.get(formulas[14])!.widthPt > xOnly.widthPt * 1.8, 'Uma expressão foi cortada depois do primeiro operador.');
    const display = await rasterizeInlineMath(String.raw`\frac{1}{1+x^2}`, 10, true);
    assert(display.heightPt > 10, 'Fração em modo destacado não aumentou a altura.');
    const xPlain = await rasterizeInlineMath('X', 10), xBar = rendered.get(String.raw`\overline{X}`)!;
    const xInk = await inspect(xPlain), xBarInk = await inspect(xBar);
    assert(xBar.heightPt > xPlain.heightPt && xBarInk.ink > xInk.ink, 'A barra de média sobre X não foi desenhada.');
    const boldBar = await rasterizeInlineMath(String.raw`\overline{X}`, 10, false, { bold: true });
    await inspect(boldBar);
    const boldTex = String.raw`\eta_0+T_{\mathrm{ref}}+E_a+\rho`;
    const regularMath = await rasterizeInlineMath(boldTex, 10), boldMath = await rasterizeInlineMath(boldTex, 10, false, { bold: true });
    const regularInk = await inspect(regularMath), boldInk = await inspect(boldMath);
    assert(regularMath.png.length !== boldMath.png.length || regularMath.png.some((byte, index) => byte !== boldMath.png[index]), 'O negrito reutilizou a mesma imagem da fórmula normal.');
    assert(boldInk.ink > regularInk.ink * 1.1, 'Os glifos em negrito não têm peso visual superior ao normal.');
    for (const [labelText, result] of [['Peso normal', regularMath], ['Negrito matemático', boldMath]] as const) {
      const card = document.createElement('div'), label = document.createElement('code'); card.className = 'sample'; label.textContent = labelText;
      card.append(label, await image(result, 2)); document.querySelector('#samples')!.append(card);
    }
    for (const unsafe of [String.raw`\unknownCommand{x}`, String.raw`\href{https://example.invalid}{x}`, String.raw`\require{html}`, String.raw`\def\x{a}\x`, '{'.repeat(65) + 'x' + '}'.repeat(65), 'x'.repeat(8193)]) {
      let rejected = false;
      try { await rasterizeInlineMath(unsafe, 10); } catch { rejected = true; }
      assert(rejected, `A fórmula inválida/não permitida foi aceita: ${unsafe.slice(0, 45)}`);
    }
    assert(failures.length === 0, failures.join('; '));
    Object.assign(window, { inlineMathRendererSummary: { formulas: measurements, rejectedCases: 6, noClipping: true, baselinePreserved: true, meanBarPreserved: true,
      bold: { regularInk: regularInk.ink, boldInk: boldInk.ink, ratio: boldInk.ink / regularInk.ink } } });
    status.textContent = `OK: ${formulas.length} fórmulas, glifos visíveis e sem cortes; subscritos, sobrescritos, frações, negrito e linha de base preservados; seis casos inválidos recusados.`;
    status.dataset.status = 'passed';
  } catch (error) { status.textContent = error instanceof Error ? error.stack || error.message : String(error); status.dataset.status = 'failed'; }
}
void run();
