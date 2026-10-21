import { createRequire } from 'node:module';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep all recognition code/models on the application's own origin. This runs
// before dev/build; no CDN or document upload is needed when OCR is used.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public', 'ocr');
const tesseract = path.dirname(require.resolve('tesseract.js/package.json'));
const core = path.dirname(createRequire(path.join(tesseract, 'package.json')).resolve('tesseract.js-core/package.json'));
await Promise.all(['core', 'lang'].map(name => mkdir(path.join(output, name), { recursive: true })));
await copyFile(path.join(tesseract, 'dist', 'worker.min.js'), path.join(output, 'worker.min.js'));
await copyFile(path.join(tesseract, 'dist', 'worker.min.js.LICENSE.txt'), path.join(output, 'worker.min.js.LICENSE.txt'));
await copyFile(path.join(core, 'LICENSE'), path.join(output, 'core', 'LICENSE'));
await Promise.all((await readdir(core)).filter(name => /\.wasm(?:\.js)?$/.test(name))
  .map(name => copyFile(path.join(core, name), path.join(output, 'core', name))));
for (const language of ['eng', 'por']) {
  const directory = path.dirname(require.resolve(`@tesseract.js-data/${language}/package.json`));
  await copyFile(path.join(directory, '4.0.0_best_int', `${language}.traineddata.gz`),
    path.join(output, 'lang', `${language}.traineddata.gz`));
}
