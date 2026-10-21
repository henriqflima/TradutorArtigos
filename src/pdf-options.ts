/** Standard PDF fonts are served locally so math rendering does not depend on
 * fonts installed on the reader's device. Embedded document fonts still win. */
export function pdfSourceOptions() {
  // Both Vite's dev modules (src/) and built chunks (assets/) are one level
  // below the app root. Keep this a runtime URL for local file-based QA too.
  const fontDirectory = '../pdfjs/standard_fonts/';
  return {
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: new URL(fontDirectory, import.meta.url).href,
  };
}
