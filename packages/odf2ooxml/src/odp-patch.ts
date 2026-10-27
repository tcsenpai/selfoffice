/**
 * Diff-based .odp save. The Slides editor works on B = convertOdpToPptx(O) and
 * hands back C; instead of exporting C wholesale (which would flatten
 * everything the import filter never modelled), the original package O is
 * patched: slides whose pptx did not change keep their draw:page bytes, and a
 * changed slide keeps every page child the import did not turn into a slide
 * element (charts, groups, shapes, tables, notes, animations whose targets
 * survive) while only its edited frames are re-serialised by the export
 * filter. styles.xml, settings.xml, meta.xml, Pictures/, Object N/ and
 * Thumbnails/ are copied as-is; the manifest is only appended to.
 *
 * content.xml is never parsed and re-serialised as a whole: a tolerant offset
 * scanner finds element spans and the file is rebuilt by splicing raw slices.
 * Any inconsistency throws OdfPatchError so the caller falls back to a full
 * export rather than writing a file that is wrong.
 */

import JSZip from 'jszip'
import { assertZipWithinLimits } from '../../pptx-engine/src/zip'
import { childElements } from './odf'
import { frameKind } from './odp-pptx'
import { OdfPatchError } from './patch-error'
import {
  IDENT,
  IMAGE_MIME,
  NS,
  notesXml,
  openOdpWriter,
  pageStyle,
  renderTree,
  slideRefs,
  slideScope,
  type OdpWriter,
  type Part,
  type SlideScope,
} from './pptx-odp'
import { XNode, attr, firstChild, nodeChildren, nodeName, parseOdfXml } from './xml'

export { OdfPatchError }

export interface OdpPatchResult {
  odp: Uint8Array
  /** slides whose draw:page was copied byte-for-byte */
  kept: number
  /** slides whose draw:page was partly re-serialised */
  rewritten: number
  inserted: number
  removed: number
  /** what the patch could not carry over (export-filter drops, lost animations…) */
  dropped: string[]
}

// ---------- tolerant XML offset scanner ----------

interface Span {
  name: string
  start: number
  /** offset just past the start tag's `>` */
  openEnd: number
  /** offset of the end tag's `<` (=== openEnd when self-closing) */
  innerEnd: number
  end: number
}

/** element children of the range [from, to) — comments, PIs, CDATA and text skipped */
function scanChildren(xml: string, from: number, to: number): Span[] {
  const out: Span[] = []
  let depth = 0
  let open: Omit<Span, 'innerEnd' | 'end'> | null = null
  let i = from
  const fail = (): never => {
    throw new OdfPatchError('scan-failed', `malformed XML near offset ${i}`)
  }
  const skipTo = (marker: string): void => {
    const at = xml.indexOf(marker, i)
    if (at < 0 || at >= to) fail()
    i = at + marker.length
  }
  while (i < to) {
    const lt = xml.indexOf('<', i)
    if (lt < 0 || lt >= to) break
    i = lt
    if (xml.startsWith('<!--', i)) skipTo('-->')
    else if (xml.startsWith('<![CDATA[', i)) skipTo(']]>')
    else if (xml.startsWith('<?', i)) skipTo('?>')
    else if (xml.startsWith('<!', i)) skipTo('>')
    else if (xml.startsWith('</', i)) {
      const tagStart = i
      skipTo('>')
      depth--
      if (depth < 0) fail()
      if (depth === 0 && open) {
        out.push({ ...open, innerEnd: tagStart, end: i })
        open = null
      }
    } else {
      const tagStart = i
      const name = /^<([^\s/>]+)/.exec(xml.slice(i, i + 256))?.[1] ?? fail()
      i += name.length + 1
      // attributes: a quoted value may contain `>`
      let quote = ''
      for (; i < to; i++) {
        const ch = xml[i]
        if (quote) {
          if (ch === quote) quote = ''
        } else if (ch === '"' || ch === "'") quote = ch
        else if (ch === '>') break
      }
      if (i >= to) fail()
      const selfClosing = xml[i - 1] === '/'
      i++
      if (depth === 0) {
        if (selfClosing) out.push({ name, start: tagStart, openEnd: i, innerEnd: i, end: i })
        else open = { name, start: tagStart, openEnd: i }
      }
      if (!selfClosing) depth++
    }
  }
  if (depth !== 0) fail()
  return out
}

const childNamed = (xml: string, span: Span | undefined, name: string): Span | undefined =>
  span ? scanChildren(xml, span.openEnd, span.innerEnd).find((s) => s.name === name) : undefined

// ---------- pptx side: canonical slide keys ----------

const SHAPE_NAMES = new Set([
  'p:sp',
  'p:cxnSp',
  'p:pic',
  'p:graphicFrame',
  'p:grpSp',
  'p:contentPart',
  'mc:AlternateContent',
])

interface PElement {
  /** the cNvPr id: the engine keeps it across edits */
  id: string | null
  key: string
  node: XNode
}

interface PSlide {
  id: string
  path: string
  part: Part
  elements: PElement[]
  key: string
  shapesKey: string
  bgKey: string
  notesKey: string
  /** transitions/animations authored on the pptx side (never exported) */
  timingKey: string
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function readSlides(w: OdpWriter): Promise<PSlide[]> {
  const zip = w.pkg.zip
  const text = async (path: string): Promise<string> =>
    (await zip.file(path)?.async('string')) ?? ''
  const out: PSlide[] = []
  for (const ref of slideRefs(w)) {
    const part = ref.path ? await w.pkg.part(ref.path) : null
    if (!ref.path || !part) throw new OdfPatchError('unreadable-pptx', `slide ${ref.id}`)
    const xml = await text(ref.path)

    const relKeys = new Map<string, string>()
    let notesKey = ''
    for (const [rid, rel] of part.rels) {
      let key: string
      if (rel.external) key = `ext:${rel.target}`
      else if (rel.type.endsWith('/notesSlide')) {
        notesKey = await text(rel.target)
        key = 'notes'
      } else if (/\/(slideLayout|slideMaster|slide)$/.test(rel.type)) key = `part:${rel.target}`
      else {
        const bytes = await w.pkg.bytes(rel.target)
        key = bytes ? `sha:${await sha256(bytes)}` : `missing:${rel.target}`
      }
      relKeys.set(rid, `${rel.type}|${key}`)
    }

    const tree = firstChild(firstChild(part.root, 'p:cSld') ?? {}, 'p:spTree')
    const nodes = tree ? nodeChildren(tree).filter((n) => SHAPE_NAMES.has(nodeName(n) ?? '')) : []
    const cSld = childNamed(xml, scanChildren(xml, 0, xml.length)[0], 'p:cSld')
    const treeSpan = childNamed(xml, cSld, 'p:spTree')
    const spans = treeSpan ? scanChildren(xml, treeSpan.openEnd, treeSpan.innerEnd) : []
    const raw = spans.filter((s) => SHAPE_NAMES.has(s.name)).map((s) => xml.slice(s.start, s.end))
    if (raw.length !== nodes.length) throw new OdfPatchError('unreadable-pptx', ref.path)
    const elements = raw.map((r, i): PElement => {
      const rids = [...r.matchAll(/\br:(?:embed|id|link|pict)="([^"]+)"/g)].map((m) => m[1]!)
      return {
        id: /<p:cNvPr\b[^>]*?\sid="(\d+)"/.exec(r)?.[1] ?? null,
        key: r + rids.map((rid) => `|${relKeys.get(rid) ?? ''}`).join(''),
        node: nodes[i]!,
      }
    })
    const shapesKey = elements.map((e) => e.key).join('\n')
    const bgKey =
      (/<p:bg[\s>/][\s\S]*?(?:<\/p:bg>|\/>)/.exec(xml)?.[0] ?? '') +
      (attr(part.root, 'show') === '0' ? '|hidden' : '')
    const timingKey =
      (/<p:transition[\s\S]*?<\/p:transition>|<p:transition\b[^>]*\/>/.exec(xml)?.[0] ?? '') +
      (/<p:timing[\s\S]*<\/p:timing>/.exec(xml)?.[0] ?? '')
    const key = [xml, ...[...relKeys].sort().map(([rid, k]) => `${rid}=${k}`), notesKey].join('\n')
    out.push({
      id: ref.id,
      path: ref.path,
      part,
      elements,
      key,
      shapesKey,
      bgKey,
      notesKey,
      timingKey,
    })
  }
  return out
}

/** C slide index → B slide index (null: inserted). sldIds first, LCS on content otherwise. */
function matchSlides(b: PSlide[], c: PSlide[]): Array<number | null> {
  const byId = new Map(b.map((s, i) => [s.id, i]))
  if (c.some((s) => s.id && byId.has(s.id))) {
    const used = new Set<number>()
    return c.map((s) => {
      const i = byId.get(s.id)
      if (i === undefined || used.has(i)) return null
      used.add(i)
      return i
    })
  }
  // no shared ids (the deck was rebuilt): longest common subsequence of unchanged slides
  const lcs = Array.from({ length: b.length + 1 }, () => new Array<number>(c.length + 1).fill(0))
  for (let i = b.length - 1; i >= 0; i--)
    for (let j = c.length - 1; j >= 0; j--)
      lcs[i]![j] =
        b[i]!.key === c[j]!.key
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out = new Array<number | null>(c.length).fill(null)
  for (let i = 0, j = 0; i < b.length && j < c.length;) {
    if (b[i]!.key === c[j]!.key) out[j++] = i++
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++
    else j++
  }
  return out
}

// ---------- odp side ----------

interface OPage {
  span: Span
  startTag: string
  children: Array<{ span: Span; raw: string; node: XNode }>
  /** indexes into `children` of the frames that became slide elements, in order */
  modeled: number[]
}

const ANIM = (name: string): boolean =>
  name.startsWith('anim:') || name === 'presentation:animations'

function readPage(content: string, span: Span, expectedElements: number): OPage {
  const raw = content.slice(span.start, span.end)
  const node = parseOdfXml(raw)?.find((n) => nodeName(n) === 'draw:page')
  if (!node) throw new OdfPatchError('page-parse-failed')
  const parsed = childElements(node)
  const spans = scanChildren(content, span.openEnd, span.innerEnd)
  if (parsed.length !== spans.length) throw new OdfPatchError('page-parse-failed')
  const children = spans.map((s, i) => ({
    span: s,
    raw: content.slice(s.start, s.end),
    node: parsed[i]!.node,
  }))
  const modeled = children.flatMap((ch, i) => {
    if (ch.span.name !== 'draw:frame') return []
    const kind = frameKind(ch.node)
    return kind === 'text' || kind === 'image' ? [i] : []
  })
  // an image whose bytes failed to load produced no element: the positional map is off
  if (modeled.length !== expectedElements) throw new OdfPatchError('element-map-mismatch')
  return { span, startTag: content.slice(span.start, span.openEnd), children, modeled }
}

const attrOf = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`).exec(tag)?.[2]

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(["'])[^"']*\\2`)
  if (re.test(tag)) return tag.replace(re, (_m, pre: string) => `${pre}"${value}"`)
  return tag.replace(/\s*\/?>$/, (end) => ` ${name}="${value}"${end}`)
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** transition / display props of a drawing-page style, to survive a background change */
function transitionAttrs(xmls: string[], styleName: string | undefined, hidden: boolean): string {
  if (!styleName) return ''
  for (const xml of xmls) {
    const style = new RegExp(
      `<style:style\\b[^>]*\\sstyle:name="${escRe(styleName)}"[\\s\\S]*?</style:style>`,
    ).exec(xml)?.[0]
    const props = style && /<style:drawing-page-properties\b([^>]*?)\/?>/.exec(style)?.[1]
    if (!props) continue
    const keep =
      /\s((?:presentation:(?:transition-[\w-]+|duration|display-[\w-]+|visibility)|smil:[\w-]+)="[^"]*")/g
    return [...props.matchAll(keep)]
      .map((m) => m[1]!)
      .filter((a) => !(hidden && a.startsWith('presentation:visibility')))
      .join(' ')
  }
  return ''
}

// ---------- main ----------

export async function patchOdp(
  original: Uint8Array,
  baselinePptx: Uint8Array,
  currentPptx: Uint8Array,
): Promise<OdpPatchResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(original, { createFolders: false })
    assertZipWithinLimits(zip)
  } catch {
    throw new OdfPatchError('unreadable-odp')
  }
  const content = await zip.file('content.xml')?.async('string')
  if (!content) throw new OdfPatchError('unreadable-odp', 'content.xml')
  const stylesXml = (await zip.file('styles.xml')?.async('string')) ?? null

  // names already taken in O: new styles, pictures and pages must not collide
  const reserved = new Set<string>(Object.keys(zip.files))
  for (const xml of [content, stylesXml ?? ''])
    for (const m of xml.matchAll(/\s(?:style|draw):name="([^"]*)"/g)) reserved.add(m[1]!)

  let bw: OdpWriter
  let cw: OdpWriter
  try {
    bw = await openOdpWriter(baselinePptx)
    cw = await openOdpWriter(currentPptx, reserved)
  } catch {
    throw new OdfPatchError('unreadable-pptx')
  }
  const bSlides = await readSlides(bw)
  const cSlides = await readSlides(cw)

  // locate office:presentation and its draw:page children by offset
  const root = scanChildren(content, 0, content.length)[0]
  const pres = childNamed(content, childNamed(content, root, 'office:body'), 'office:presentation')
  if (!root || !pres || pres.openEnd === pres.end) throw new OdfPatchError('not-a-presentation')
  const presChildren = scanChildren(content, pres.openEnd, pres.innerEnd)
  const pageSpans = presChildren.filter((s) => s.name === 'draw:page')
  // slides are 1:1 with draw:page, in order (the import's sourceMap)
  if (pageSpans.length !== bSlides.length) throw new OdfPatchError('source-map-mismatch')

  const match = matchSlides(bSlides, cSlides)
  const used = new Set(match.filter((m): m is number => m !== null))
  const removed = bSlides.length - used.size
  const unchanged =
    removed === 0 &&
    match.length === bSlides.length &&
    match.every((m, j) => m === j && bSlides[j]!.key === cSlides[j]!.key)
  if (unchanged)
    return {
      odp: original,
      kept: bSlides.length,
      rewritten: 0,
      inserted: 0,
      removed: 0,
      dropped: [],
    }

  const doc = cw.doc
  const dropped = new Set<string>()
  const pageMaster = (b: number): string | undefined =>
    attrOf(content.slice(pageSpans[b]!.start, pageSpans[b]!.openEnd), 'draw:master-page-name')
  const firstMaster =
    (stylesXml && /<style:master-page\b[^>]*\sstyle:name="([^"]*)"/.exec(stylesXml)?.[1]) ||
    'Default'
  const freshPageName = (): string => {
    let n = 1
    while (reserved.has(`page${n}`)) n++
    reserved.add(`page${n}`)
    return `page${n}`
  }
  const renderElement = async (node: XNode, scope: SlideScope): Promise<string> =>
    renderTree({ 'p:spTree': [node] }, IDENT, scope.rc)

  let kept = 0
  let rewritten = 0
  let inserted = 0
  const pages: string[] = []
  for (const [j, c] of cSlides.entries()) {
    const b = match[j] ?? null
    const scope = await slideScope(cw, c.path)
    if (!scope) throw new OdfPatchError('unreadable-pptx', c.path)
    const base = b === null ? null : bSlides[b]!
    if (c.timingKey && c.timingKey !== base?.timingKey) dropped.add('pptx-transitions')

    if (b === null || !base) {
      // a new slide: its master page is its nearest original neighbour's
      let master: string | undefined
      for (let k = j - 1; k >= 0 && !master; k--)
        if (match[k] != null) master = pageMaster(match[k]!)
      for (let k = j + 1; k < match.length && !master; k++)
        if (match[k] != null) master = pageMaster(match[k]!)
      let shapes = ''
      for (const e of c.elements) shapes += await renderElement(e.node, scope)
      const dp = await pageStyle(
        scope.slide,
        null,
        scope.rc,
        attr(scope.slide.root, 'show') === '0',
        false,
      )
      pages.push(
        `<draw:page draw:name="${freshPageName()}" draw:style-name="${dp}" draw:master-page-name="${master ?? firstMaster}">` +
          `${shapes}${await notesXml(scope.slide, scope.rc)}</draw:page>`,
      )
      inserted++
      continue
    }

    const span = pageSpans[b]!
    if (base.key === c.key) {
      pages.push(content.slice(span.start, span.end))
      kept++
      continue
    }

    // a changed slide: patch the original page child by child
    rewritten++
    const page = readPage(content, span, base.elements.length)
    const parts: string[] = page.children.map((ch) => ch.raw)

    if (base.shapesKey !== c.shapesKey) {
      // C element → B element by cNvPr id
      const bIndexById = new Map<string, number>()
      base.elements.forEach((e, i) => e.id && !bIndexById.has(e.id) && bIndexById.set(e.id, i))
      const taken = new Set<number>()
      const rendered: Array<{ b: number | null; xml: string }> = []
      for (const e of c.elements) {
        let bi = e.id ? bIndexById.get(e.id) : undefined
        if (bi !== undefined && taken.has(bi)) bi = undefined
        if (bi !== undefined) taken.add(bi)
        const orig = bi === undefined ? null : page.children[page.modeled[bi]!]!
        if (orig && base.elements[bi!]!.key === e.key) {
          rendered.push({ b: bi!, xml: orig.raw })
          continue
        }
        let xml = await renderElement(e.node, scope)
        if (orig) {
          if (/<draw:(?:object|object-ole|plugin|applet)\b/.test(orig.raw))
            dropped.add('objects-flattened')
          // keep the frame's identity so animations and links that target it survive
          const tag = orig.raw.slice(0, orig.span.openEnd - orig.span.start)
          const ids = ['xml:id', 'draw:id', 'draw:layer']
            .map((n) => [n, attrOf(tag, n)] as const)
            .filter(([n, v]) => v !== undefined && !new RegExp(`^<[^>]*\\s${n}=`).test(xml))
            .map(([n, v]) => ` ${n}="${v}"`)
            .join('')
          if (ids) xml = xml.replace(/^<[\w:.-]+/, (m) => m + ids)
        }
        rendered.push({ b: bi ?? null, xml })
      }
      const order = rendered.flatMap((r) => (r.b === null ? [] : [r.b]))
      const monotonic = order.every((v, i) => i === 0 || v > order[i - 1]!)
      for (const k of page.modeled) parts[k] = ''
      if (monotonic && order.length > 0) {
        // in place: each surviving frame's slot gets it plus the new elements that follow it
        let slot = -1
        let lead = ''
        for (const r of rendered) {
          if (r.b !== null) slot = r.b
          if (slot < 0) lead += r.xml
          else parts[page.modeled[slot]!] += r.xml
        }
        parts[page.modeled[order[0]!]!] = lead + parts[page.modeled[order[0]!]!]
      } else {
        // z-order changed: one block where the first modelled frame was
        const at =
          page.modeled[0] ??
          page.children.findIndex(
            (ch) => ANIM(ch.span.name) || ch.span.name === 'presentation:notes',
          )
        const block = rendered.map((r) => r.xml).join('')
        if (at >= 0) parts[at] = block + parts[at]
        else parts.push(block)
      }
    }

    if (base.notesKey !== c.notesKey) {
      const notes = await notesXml(scope.slide, scope.rc)
      const at = page.children.findIndex((ch) => ch.span.name === 'presentation:notes')
      if (at >= 0) parts[at] = notes
      else parts.push(notes)
    }

    // animations whose target frames are gone cannot be kept
    const ids = new Set<string>()
    page.children.forEach((ch, i) => {
      if (ANIM(ch.span.name)) return
      for (const m of (parts[i] ?? '').matchAll(/\s(?:xml|draw):id="([^"]+)"/g)) ids.add(m[1]!)
    })
    for (const m of parts
      .slice(page.children.length)
      .join('')
      .matchAll(/\s(?:xml|draw):id="([^"]+)"/g))
      ids.add(m[1]!)
    page.children.forEach((ch, i) => {
      if (!ANIM(ch.span.name)) return
      const targets = [
        ...ch.raw.matchAll(
          /\s(?:smil:targetElement|presentation:shape-id|draw:shape-id)="([^"]+)"/g,
        ),
      ].map((m) => m[1]!)
      if (targets.some((t) => !ids.has(t))) {
        parts[i] = ''
        dropped.add(`animations-lost:${b + 1}`)
      }
    })

    let startTag = page.startTag
    if (base.bgKey !== c.bgKey) {
      const hidden = attr(scope.slide.root, 'show') === '0'
      const extra = transitionAttrs(
        [content, stylesXml ?? ''],
        attrOf(startTag, 'draw:style-name'),
        hidden,
      )
      const dp = await pageStyle(scope.slide, null, scope.rc, hidden, false, extra)
      startTag = setAttr(startTag, 'draw:style-name', dp)
    }
    pages.push(`${startTag}${parts.join('')}</draw:page>`)
  }

  // splice the new page sequence over the original page run
  const regionStart = pageSpans[0]?.start ?? pres.innerEnd
  const regionEnd = pageSpans[pageSpans.length - 1]?.end ?? pres.innerEnd
  const stray = presChildren
    .filter((s) => s.name !== 'draw:page' && s.start >= regionStart && s.end <= regionEnd)
    .map((s) => content.slice(s.start, s.end))
  let next =
    content.slice(0, regionStart) + pages.join('') + stray.join('') + content.slice(regionEnd)

  if (doc.auto.length > 0) {
    const styles = doc.auto.join('')
    if (next.includes('</office:automatic-styles>'))
      next = next.replace('</office:automatic-styles>', () => `${styles}</office:automatic-styles>`)
    else if (/<office:automatic-styles\s*\/>/.test(next))
      next = next.replace(
        /<office:automatic-styles\s*\/>/,
        () => `<office:automatic-styles>${styles}</office:automatic-styles>`,
      )
    else
      next = next.replace(
        '<office:body',
        () => `<office:automatic-styles>${styles}</office:automatic-styles><office:body`,
      )
  }
  // declare any namespace the serialiser uses that O's root does not
  const rootTag = next.slice(root.start, root.openEnd)
  const missing = [...NS.matchAll(/xmlns:([\w-]+)="[^"]*"/g)]
    .filter((m) => !rootTag.includes(`xmlns:${m[1]}=`))
    .map((m) => ` ${m[0]}`)
    .join('')
  if (missing) {
    const nameEnd = root.start + 1 + root.name.length
    next = next.slice(0, nameEnd) + missing + next.slice(nameEnd)
  }

  // never hand back a file we cannot read ourselves
  const check = parseOdfXml(next)
  const checkPres = check
    ?.map((n) => firstChild(firstChild(n, 'office:body') ?? {}, 'office:presentation'))
    .find((n) => n)
  const pageCount = checkPres
    ? childElements(checkPres).filter((e) => e.name === 'draw:page').length
    : -1
  if (pageCount !== cSlides.length) throw new OdfPatchError('invalid-output', `pages ${pageCount}`)

  zip.file('content.xml', next)
  if (doc.fillImages.length > 0) {
    const images = doc.fillImages.join('')
    let styles = stylesXml ?? ''
    if (styles.includes('</office:styles>'))
      styles = styles.replace('</office:styles>', () => `${images}</office:styles>`)
    else if (/<office:styles\s*\/>/.test(styles))
      styles = styles.replace(
        /<office:styles\s*\/>/,
        () => `<office:styles>${images}</office:styles>`,
      )
    else throw new OdfPatchError('styles-unpatchable')
    if (!parseOdfXml(styles)) throw new OdfPatchError('invalid-output', 'styles.xml')
    zip.file('styles.xml', styles)
  }
  if (doc.pictureFiles.length > 0) {
    for (const p of doc.pictureFiles) zip.file(p.name, p.bytes, { createFolders: false })
    const manifest = await zip.file('META-INF/manifest.xml')?.async('string')
    if (manifest?.includes('</manifest:manifest>')) {
      const entries = doc.pictureFiles
        .map(
          (p) =>
            `<manifest:file-entry manifest:full-path="${p.name}" manifest:media-type="${IMAGE_MIME[p.ext]}"/>`,
        )
        .join('')
      zip.file(
        'META-INF/manifest.xml',
        manifest.replace('</manifest:manifest>', () => `${entries}</manifest:manifest>`),
      )
    } else if (manifest !== undefined) throw new OdfPatchError('manifest-unpatchable')
  }
  // the mimetype entry stays first (insertion order) and must be stored, not deflated
  const mimetype = await zip.file('mimetype')?.async('string')
  if (mimetype !== undefined) zip.file('mimetype', mimetype, { compression: 'STORE' })

  for (const d of doc.dropped()) dropped.add(d)
  if ((rewritten + inserted) * 2 > cSlides.length) dropped.add('mostly-rewritten')
  const odp = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { odp, kept, rewritten, inserted, removed, dropped: [...dropped] }
}
