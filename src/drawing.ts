const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup'
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'

function unsupported(detail: string): never {
  throw new Error(`A figura vetorial contém ${detail} não suportado. Baixe o Word traduzido e exporte pelo seu editor para preservar essa figura.`)
}

function children(element: Element): Element[] { return Array.from(element.children) }
function one(element: Element, name: string, namespace = A): Element | undefined {
  const matches = children(element).filter(child => child.localName === name && child.namespaceURI === namespace)
  if (matches.length > 1) unsupported(`elemento repetido (${name})`)
  return matches[0]
}
function required(element: Element, name: string, namespace = A): Element {
  return one(element, name, namespace) ?? unsupported(`elemento ausente (${name})`)
}
function allowed(element: Element, names: string[], namespace = A) {
  for (const child of children(element)) {
    if (child.namespaceURI !== namespace || !names.includes(child.localName)) unsupported(`elemento ${child.localName}`)
  }
}
function number(value: string | null, label: string, fallback?: number): number {
  if (value === null && fallback !== undefined) return fallback
  if (value === null || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) unsupported(`valor ${label}`)
  const result = Number(value)
  if (!Number.isFinite(result) || Math.abs(result) > 1e12) unsupported(`valor ${label}`)
  return result
}
function positive(value: string | null, label: string): number {
  const result = number(value, label)
  if (result <= 0) unsupported(`dimensão ${label}`)
  return result
}
function boolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return unsupported('valor booleano')
}
function fmt(value: number): string { return String(Number(value.toFixed(6))) }

type Transform = { width: number; height: number; svg: string }
function transform(properties: Element, group: boolean, root: boolean): Transform {
  const xfrm = required(properties, 'xfrm')
  allowed(xfrm, group ? ['off', 'ext', 'chOff', 'chExt'] : ['off', 'ext'])
  // Rotation also changes the drawing's bounding box. Refuse it until we can
  // reconcile wp:extent and rotated clipping without losing part of a figure.
  if (number(xfrm.getAttribute('rot'), 'rotação', 0) !== 0) unsupported('rotação de figura')
  const off = required(xfrm, 'off')
  const ext = required(xfrm, 'ext')
  const width = positive(ext.getAttribute('cx'), 'largura')
  const height = positive(ext.getAttribute('cy'), 'altura')
  const x = number(off.getAttribute('x'), 'x')
  const y = number(off.getAttribute('y'), 'y')
  const flipH = boolean(xfrm.getAttribute('flipH'), false)
  const flipV = boolean(xfrm.getAttribute('flipV'), false)
  let svg = `translate(${fmt(root ? 0 : x)} ${fmt(root ? 0 : y)})`
  if (flipH || flipV) svg += ` translate(${flipH ? fmt(width) : '0'} ${flipV ? fmt(height) : '0'}) scale(${flipH ? '-1' : '1'} ${flipV ? '-1' : '1'})`
  if (group) {
    const childOff = required(xfrm, 'chOff')
    const childExt = required(xfrm, 'chExt')
    const childWidth = positive(childExt.getAttribute('cx'), 'largura interna')
    const childHeight = positive(childExt.getAttribute('cy'), 'altura interna')
    svg += ` scale(${fmt(width / childWidth)} ${fmt(height / childHeight)}) translate(${fmt(-number(childOff.getAttribute('x'), 'x interno'))} ${fmt(-number(childOff.getAttribute('y'), 'y interno'))})`
  }
  return { width, height, svg }
}

type Paint = { color: string; opacity: number }
function fill(properties: Element): Paint {
  const solid = one(properties, 'solidFill')
  const none = one(properties, 'noFill')
  if (solid && none) unsupported('preenchimento conflitante')
  if (!solid) return { color: 'none', opacity: 1 }
  allowed(solid, ['srgbClr'])
  const color = required(solid, 'srgbClr')
  const hex = color.getAttribute('val') ?? ''
  if (!/^[a-fA-F0-9]{6}$/.test(hex)) unsupported('cor')
  allowed(color, ['alpha'])
  const alpha = one(color, 'alpha')
  const opacity = alpha ? number(alpha.getAttribute('val'), 'transparência') / 100000 : 1
  if (opacity < 0 || opacity > 1) unsupported('transparência')
  return { color: `#${hex}`, opacity }
}

function stroke(properties: Element): string {
  const line = one(properties, 'ln')
  if (!line) return 'stroke="none"'
  allowed(line, ['solidFill', 'noFill', 'prstDash', 'round', 'bevel', 'miter', 'headEnd', 'tailEnd'])
  if (line.hasAttribute('cmpd') && line.getAttribute('cmpd') !== 'sng') unsupported('traço composto')
  if (line.hasAttribute('algn') && line.getAttribute('algn') !== 'ctr') unsupported('alinhamento do traço')
  for (const name of ['headEnd', 'tailEnd']) {
    const end = one(line, name)
    if (end && end.getAttribute('type') !== 'none') unsupported('seta')
  }
  const paint = fill(line)
  const width = number(line.getAttribute('w'), 'espessura', 12700)
  if (width < 0) unsupported('espessura negativa')
  const cap = line.getAttribute('cap') ?? 'flat'
  const caps: Record<string, string> = { flat: 'butt', rnd: 'round', sq: 'square' }
  if (!caps[cap]) unsupported('terminação do traço')
  const joins = ['round', 'bevel', 'miter'].filter(name => one(line, name))
  if (joins.length > 1) unsupported('junção de traço conflitante')
  const join = joins[0] ?? 'miter'
  const miter = one(line, 'miter')
  const limit = miter ? number(miter.getAttribute('lim'), 'limite de junção', 800000) / 100000 : 8
  if (limit < 1) unsupported('limite de junção')
  const dash = one(line, 'prstDash')?.getAttribute('val') ?? 'solid'
  const dashes: Record<string, number[]> = {
    solid: [], dot: [1, 3], dash: [4, 3], lgDash: [8, 3],
    dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3],
    sysDash: [3, 1], sysDot: [1, 1], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1],
  }
  if (!Object.hasOwn(dashes, dash)) unsupported('padrão de traço')
  const dashAttribute = dashes[dash].length ? ` stroke-dasharray="${dashes[dash].map(n => fmt(n * width)).join(' ')}"` : ''
  return `stroke="${paint.color}" stroke-opacity="${fmt(paint.opacity)}" stroke-width="${fmt(width)}" stroke-linecap="${caps[cap]}" stroke-linejoin="${join}" stroke-miterlimit="${fmt(limit)}"${dashAttribute}`
}

type Budget = { shapes: number; commands: number }
function shape(element: Element, root: boolean, budget: Budget): { svg: string; width: number; height: number } {
  if (++budget.shapes > 500) unsupported('quantidade de formas')
  allowed(element, ['cNvPr', 'cNvSpPr', 'spPr', 'bodyPr'], WPS)
  const properties = required(element, 'spPr', WPS)
  allowed(properties, ['xfrm', 'custGeom', 'prstGeom', 'solidFill', 'noFill', 'ln'])
  const t = transform(properties, false, root)
  const paint = fill(properties)
  const line = stroke(properties)
  const custom = one(properties, 'custGeom')
  const preset = one(properties, 'prstGeom')
  if (Boolean(custom) === Boolean(preset)) unsupported('geometria ausente ou conflitante')
  let svg = ''
  if (custom) {
    allowed(custom, ['avLst', 'gdLst', 'ahLst', 'cxnLst', 'rect', 'pathLst'])
    for (const name of ['avLst', 'gdLst', 'ahLst']) {
      if (children(one(custom, name) ?? custom.ownerDocument.createElement('empty')).length) unsupported('fórmula geométrica')
    }
    const paths = required(custom, 'pathLst')
    allowed(paths, ['path'])
    if (!children(paths).length) unsupported('geometria vazia')
    for (const path of children(paths)) {
      const pathWidth = positive(path.getAttribute('w'), 'largura do caminho')
      const pathHeight = positive(path.getAttribute('h'), 'altura do caminho')
      const sx = t.width / pathWidth
      const sy = t.height / pathHeight
      const pathFill = path.getAttribute('fill') ?? 'norm'
      if (pathFill !== 'norm' && pathFill !== 'none') unsupported('preenchimento do caminho')
      const pathStroke = boolean(path.getAttribute('stroke'), true)
      const commands = children(path)
      if (!commands.length || commands[0].localName !== 'moveTo') unsupported('caminho sem início')
      let d = ''
      for (const command of commands) {
        if (++budget.commands > 50000) unsupported('quantidade de segmentos')
        if (command.namespaceURI !== A) unsupported('namespace de geometria')
        const counts: Record<string, number> = { moveTo: 1, lnTo: 1, cubicBezTo: 3, quadBezTo: 2, close: 0 }
        const operators: Record<string, string> = { moveTo: 'M', lnTo: 'L', cubicBezTo: 'C', quadBezTo: 'Q', close: 'Z' }
        if (!Object.hasOwn(counts, command.localName)) unsupported(`segmento ${command.localName}`)
        allowed(command, ['pt'])
        const points = children(command)
        if (points.length !== counts[command.localName]) unsupported('número de pontos')
        d += operators[command.localName] + points.map(point => `${fmt(number(point.getAttribute('x'), 'ponto x') * sx)} ${fmt(number(point.getAttribute('y'), 'ponto y') * sy)}`).join(' ')
      }
      svg += `<path d="${d}" fill="${pathFill === 'none' ? 'none' : paint.color}" fill-opacity="${fmt(paint.opacity)}" ${pathStroke ? line : 'stroke="none"'}/>`
    }
  } else if (preset) {
    allowed(preset, ['avLst'])
    const adjustments = one(preset, 'avLst')
    if (adjustments && children(adjustments).length) unsupported('ajuste de geometria')
    const style = `fill="${paint.color}" fill-opacity="${fmt(paint.opacity)}" ${line}`
    if (preset.getAttribute('prst') === 'rect') svg = `<rect width="${fmt(t.width)}" height="${fmt(t.height)}" ${style}/>`
    else if (preset.getAttribute('prst') === 'ellipse') svg = `<ellipse cx="${fmt(t.width / 2)}" cy="${fmt(t.height / 2)}" rx="${fmt(t.width / 2)}" ry="${fmt(t.height / 2)}" ${style}/>`
    else unsupported('forma predefinida')
  }
  return { svg: `<g transform="${t.svg}">${svg}</g>`, width: t.width, height: t.height }
}

function group(element: Element, root: boolean, budget: Budget, depth = 0): { svg: string; width: number; height: number } {
  if (depth > 12) unsupported('profundidade de grupos')
  const properties = required(element, 'grpSpPr', WPG)
  allowed(properties, ['xfrm'])
  const t = transform(properties, true, root)
  let svg = ''
  for (const child of children(element)) {
    if (child.namespaceURI === WPG && ['cNvPr', 'cNvGrpSpPr', 'grpSpPr'].includes(child.localName)) continue
    if (child.namespaceURI === WPS && child.localName === 'wsp') svg += shape(child, false, budget).svg
    else if (child.namespaceURI === WPG && ['wgp', 'grpSp'].includes(child.localName)) svg += group(child, false, budget, depth + 1).svg
    else unsupported(`elemento de grupo ${child.localName}`)
  }
  if (!svg) unsupported('grupo vazio')
  return { svg: `<g transform="${t.svg}">${svg}</g>`, width: t.width, height: t.height }
}

function includePaintBounds(source: string, width: number, height: number): string {
  // Measure only our generated, resource-free SVG in a shadow root so application
  // styles cannot change its geometry. getBBox excludes strokes in Chromium;
  // account conservatively for their joins/caps after each group transform.
  const host = document.createElement('div')
  host.className = 'lume-vector-measure'
  host.style.cssText = 'all:initial;position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) unsupported('SVG inválido')
  const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement
  shadow.append(svg)
  document.body.append(host)
  try {
    const rootMatrix = svg.getCTM()
    if (!rootMatrix) unsupported('medição da figura')
    const inverse = rootMatrix.inverse()
    let left = 0, top = 0, right = width, bottom = height
    for (const element of svg.querySelectorAll<SVGGraphicsElement>('path,rect,ellipse')) {
      const box = element.getBBox()
      const elementMatrix = element.getCTM()
      if (!elementMatrix) unsupported('medição da forma')
      const matrix = inverse.multiply(elementMatrix)
      const painted = element.getAttribute('stroke') !== 'none'
      const strokeWidth = painted ? Number(element.getAttribute('stroke-width')) : 0
      const join = element.getAttribute('stroke-linejoin')
      const joinLimit = element.localName === 'path' && join === 'miter' ? Number(element.getAttribute('stroke-miterlimit')) : 1
      const capLimit = element.localName === 'path' && element.getAttribute('stroke-linecap') === 'square' ? Math.SQRT2 : 1
      const margin = strokeWidth / 2 * Math.max(joinLimit, capLimit)
      for (const x of [box.x - margin, box.x + box.width + margin]) {
        for (const y of [box.y - margin, box.y + box.height + margin]) {
          const point = new DOMPoint(x, y).matrixTransform(matrix)
          if (![point.x, point.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1e12)) unsupported('limites da figura')
          left = Math.min(left, point.x); top = Math.min(top, point.y)
          right = Math.max(right, point.x); bottom = Math.max(bottom, point.y)
        }
      }
    }
    const factor = Math.max((right - left) / width, (bottom - top) / height)
    if (!Number.isFinite(factor) || factor < 1 || factor > 4) unsupported('limites da figura')
    const expandedWidth = width * factor, expandedHeight = height * factor
    left -= (expandedWidth - (right - left)) / 2
    top -= (expandedHeight - (bottom - top)) / 2
    // Keep the physical image extent reserved by the Word layout. Expanding its
    // viewBox slightly reduces the whole drawing in reflow mode, preserving all
    // paint instead of clipping centered strokes or children at the group edge.
    // Expand both axes by the same factor to retain the original aspect ratio.
    svg.setAttribute('viewBox', `${fmt(left)} ${fmt(top)} ${fmt(expandedWidth)} ${fmt(expandedHeight)}`)
    return new XMLSerializer().serializeToString(svg)
  } finally { host.remove() }
}

/**
 * Convert the deliberately limited, verified subset of Word DrawingML vectors
 * into a self-contained SVG. `extent` is the final image size in CSS pixels;
 * internal transforms, geometry and stroke widths remain in DrawingML EMUs.
 * Unsupported drawing content throws rather than silently dropping a figure.
 */
export function drawingToSvg(graphicData: Element, extent: { width: number; height: number }): string {
  if (![extent.width, extent.height].every(value => Number.isFinite(value) && value > 0 && value <= 20000)) unsupported('dimensão da figura')
  if (graphicData.namespaceURI !== A || graphicData.localName !== 'graphicData') unsupported('tipo de figura')
  const contents = children(graphicData)
  if (contents.length !== 1) unsupported('conteúdo composto de figura')
  const root = contents[0]
  const budget: Budget = { shapes: 0, commands: 0 }
  const drawing = root.namespaceURI === WPG && root.localName === 'wgp'
    ? group(root, true, budget)
    : root.namespaceURI === WPS && root.localName === 'wsp'
      ? shape(root, true, budget)
      : unsupported(`tipo ${root.localName}`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(extent.width)}" height="${fmt(extent.height)}" viewBox="0 0 ${fmt(drawing.width)} ${fmt(drawing.height)}" preserveAspectRatio="none">${drawing.svg}</svg>`
  if (svg.length > 2_000_000) unsupported('tamanho da figura')
  return includePaintBounds(svg, drawing.width, drawing.height)
}
