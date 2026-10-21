import type JSZip from 'jszip';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

const parent = (node: Element, namespace: string, name: string): Element | null => {
  for (let el: Element | null = node; el; el = el.parentElement) if (el.namespaceURI === namespace && el.localName === name) return el;
  return null;
};

/** Convert supported vector drawings only in the temporary render package.
 * docx-preview ignores wpg groups and chooses incomplete VML fallbacks. */
export async function preserveDrawings(zip: JSZip, xml: Document, part: string) {
  let index = 0;
  for (const graphic of Array.from(xml.getElementsByTagNameNS(A, 'graphicData'))) {
    if (!xml.documentElement.contains(graphic)) continue;
    const drawing = parent(graphic, W, 'drawing');
    if (!drawing) throw new Error('Uma figura não possui estrutura compatível. Baixe o Word traduzido e exporte pelo seu editor.');
    const picture = graphic.children.length === 1 && graphic.children[0].namespaceURI === PIC && graphic.children[0].localName === 'pic';
    if (!picture) {
      const extent = drawing.getElementsByTagNameNS(WP, 'extent')[0];
      const cx = Number(extent?.getAttribute('cx')), cy = Number(extent?.getAttribute('cy'));
      if (!(cx > 0 && cy > 0 && cx <= 50_000_000 && cy <= 50_000_000)) throw new Error('Não foi possível determinar o tamanho de uma figura vetorial. Baixe o Word traduzido.');
      const { drawingToSvg } = await import('./drawing');
      const svg = drawingToSvg(graphic, { width: cx / 9525, height: cy / 9525 });
      const filename = `lume-vector-${part.replace(/[^a-zA-Z0-9]/g, '_')}-${index++}.svg`;
      const mediaPath = `word/media/${filename}`;
      zip.file(mediaPath, svg);
      const relationshipPath = part.replace('word/', 'word/_rels/') + '.rels';
      const relationText = await zip.file(relationshipPath)?.async('string');
      const rels = new DOMParser().parseFromString(relationText || `<Relationships xmlns="${REL}"/>`, 'application/xml');
      const ids = new Set(Array.from(rels.documentElement.children).map(el => el.getAttribute('Id')));
      let id = `rIdLumeVector${index}`; while (ids.has(id)) id += 'x';
      const rel = rels.createElementNS(REL, 'Relationship');
      rel.setAttribute('Id', id); rel.setAttribute('Type', `${OFFICE_REL}/image`); rel.setAttribute('Target', `media/${filename}`);
      rels.documentElement.append(rel);
      zip.file(relationshipPath, new XMLSerializer().serializeToString(rels));
      const types = new DOMParser().parseFromString(await zip.file('[Content_Types].xml')!.async('string'), 'application/xml');
      // docx-preview resolves media paths without the leading slash required by
      // OOXML Overrides. A Default also lets it assign the SVG MIME type.
      const svgType = Array.from(types.documentElement.children).find(el => el.localName === 'Default' && el.getAttribute('Extension') === 'svg');
      if (svgType) svgType.setAttribute('ContentType', 'image/svg+xml');
      else {
        const fallback = types.createElementNS(CONTENT, 'Default');
        fallback.setAttribute('Extension', 'svg'); fallback.setAttribute('ContentType', 'image/svg+xml');
        types.documentElement.append(fallback);
      }
      const override = types.createElementNS(CONTENT, 'Override');
      override.setAttribute('PartName', `/${mediaPath}`); override.setAttribute('ContentType', 'image/svg+xml'); types.documentElement.append(override);
      zip.file('[Content_Types].xml', new XMLSerializer().serializeToString(types));
      const replacement = new DOMParser().parseFromString(`<pic:pic xmlns:pic="${PIC}" xmlns:a="${A}" xmlns:r="${OFFICE_REL}"><pic:nvPicPr><pic:cNvPr id="0" name="Figura vetorial"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`, 'application/xml');
      graphic.setAttribute('uri', PIC); graphic.replaceChildren(xml.importNode(replacement.documentElement, true));
    }
    const alternate = parent(drawing, MC, 'AlternateContent');
    if (alternate) alternate.replaceWith(drawing);
  }
  if (xml.getElementsByTagNameNS(W, 'pict').length || xml.getElementsByTagNameNS(W, 'object').length) {
    throw new Error('O documento contém figuras ou objetos antigos que não podem ser preservados nesta conversão. Baixe o Word traduzido e exporte pelo seu editor.');
  }
}
