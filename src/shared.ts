export const MAX_FILE_BYTES = 7_000_000;
export const MAX_PDF_PAGES = 50;
export const TRANSLATION_ENGINE = 'translation-v1';
export const TRANSLATION_PROMPT_VERSION = 'scientific-translation-v1';
export const EXTENSIONS = ['pdf'];
export const TARGET_LANGUAGES = [
  ['PT-BR', 'Português (Brasil)'], ['PT-PT', 'Português (Portugal)'],
  ['EN-US', 'Inglês (americano)'], ['EN-GB', 'Inglês (britânico)'],
  ['ES', 'Espanhol'], ['FR', 'Francês'], ['DE', 'Alemão'], ['IT', 'Italiano'],
  ['JA', 'Japonês'], ['ZH-HANS', 'Chinês (simplificado)'], ['KO', 'Coreano'],
  ['NL', 'Holandês'], ['PL', 'Polonês'], ['RU', 'Russo'], ['UK', 'Ucraniano'],
] as const;
export const SOURCE_LANGUAGES = [
  ['EN', 'Inglês'], ['PT', 'Português'], ['ES', 'Espanhol'], ['FR', 'Francês'],
  ['DE', 'Alemão'], ['IT', 'Italiano'], ['JA', 'Japonês'], ['ZH', 'Chinês'],
  ['KO', 'Coreano'], ['NL', 'Holandês'], ['PL', 'Polonês'], ['RU', 'Russo'], ['UK', 'Ucraniano'],
] as const;
export function extension(name: string) { return name.split('.').pop()?.toLowerCase() || ''; }
export function isImage(name: string) { return ['png', 'jpg', 'jpeg'].includes(extension(name)); }
export function formatFileSize(bytes: number) {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000)).toLocaleString('pt-BR')} KB` : `${(bytes / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB`;
}
export function validateFile(file: { name: string; size: number }): string | null {
  if (!EXTENSIONS.includes(extension(file.name))) return 'Formato não aceito. Escolha um arquivo PDF.';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'Este arquivo está vazio ou possui tamanho inválido. Escolha outro PDF.';
  if (file.size > MAX_FILE_BYTES) return `O PDF excede o limite de ${formatFileSize(MAX_FILE_BYTES)}. Escolha um arquivo menor.`;
  return null;
}
