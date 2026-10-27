/**
 * Byte-preserving .odt save. The editor works on B = convertOdtToDocx(O).docx
 * and hands back C; this module writes C's edits into O without touching what
 * the editor never modelled. Body blocks of B and C are diffed (LCS on their
 * XML, which docx-engine keeps verbatim for untouched blocks); every
 * top-level office:text child whose blocks all survived unchanged and
 * contiguous is copied from O's content.xml as the exact original substring.
 * Only dirty children and new blocks go through the docx → ODF serializer, and
 * their new automatic styles are appended next to O's own. All other parts
 * (styles, settings, meta, pictures, objects) are copied as they are.
 *
 * Anything that does not add up throws OdfPatchError: the caller then falls
 * back to a full export instead of writing a corrupt or lossy file.
 */

import JSZip from 'jszip'
import { loadDocxConverter, type ParaOverride } from './docx-odt'
import { convertOdtToDocx } from './odt-docx'
import { OdfPatchError } from './patch-error'
import { XNode, nodeChildren, nodeName, parseOdfXml, firstChild } from './xml'

/**
 * Why patchOdt refused: 'unreadable' | 'baseline-mismatch' | 'parse-failure' |
 * 'degenerate-diff' | 'unsupported' (OdfPatchError.code).
 */
export type OdtPatchErrorCode =
  'unreadable' | 'baseline-mismatch' | 'parse-failure' | 'degenerate-diff' | 'unsupported'

export interface OdtPatchResult {
  odt: Uint8Array
  /** office:text children holding body blocks that were copied byte-for-byte from the original */
  kept: number
  /** current blocks written through the serializer (edited, inserted, or riding along in a dirty child) */
  rewritten: number
  /** current blocks with no counterpart in the baseline */
  inserted: number
  /** baseline blocks with no counterpart in the current document */
  removed: number
  /** constructs lost because the child holding them was rewritten */
  dropped: string[]
}

// -- tolerant positional XML scanner -----------------------------------------

interface Span {
  name: string
  start: number
  end: number
}

/** end index (exclusive) of the tag opening at `lt`, skipping quoted attribute values */
function tagEnd(xml: string, lt: number): number {
  let quote = ''
  for (let i = lt + 1; i < xml.length; i++) {
    const ch = xml[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i + 1
  }
  throw new OdfPatchError('parse-failure', 'unterminated tag')
}

function skipTo(xml: string, from: number, marker: string): number {
  const at = xml.indexOf(marker, from)
  if (at < 0) throw new OdfPatchError('parse-failure', `missing ${marker}`)
  return at + marker.length
}

/**
 * The element children of the first `parent` element, with their exact
 * source spans, plus where the parent's content starts and ends. Comments,
 * CDATA and processing instructions are skipped, as fast-xml-parser does, so
 * child indices line up with the parsed tree.
 */
export function scanChildren(
  xml: string,
  parent: string,
): { open: number; close: number; children: Span[] } {
  let i = 0
  let depth = 0
  let parentDepth = -1
  let open = -1
  const children: Span[] = []
  let child: Span | null = null
  for (;;) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    if (xml.startsWith('<!--', lt)) {
      i = skipTo(xml, lt, '-->')
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      i = skipTo(xml, lt, ']]>')
      continue
    }
    if (xml.startsWith('<?', lt)) {
      i = skipTo(xml, lt, '?>')
      continue
    }
    if (xml.startsWith('<!', lt)) {
      i = tagEnd(xml, lt)
      continue
    }
    const gt = tagEnd(xml, lt)
    i = gt
    if (xml[lt + 1] === '/') {
      depth--
      if (open >= 0) {
        if (depth === parentDepth) return { open, close: lt, children }
        if (depth === parentDepth + 1 && child) {
          child.end = gt
          children.push(child)
          child = null
        }
      }
      continue
    }
    const name = /^[^\s/>]+/.exec(xml.slice(lt + 1, lt + 200))?.[0] ?? ''
    const selfClosing = xml[gt - 2] === '/'
    if (open < 0) {
      if (name === parent) {
        if (selfClosing) throw new OdfPatchError('unsupported', `empty <${parent}/>`)
        parentDepth = depth
        open = gt
      }
    } else if (depth === parentDepth + 1) {
      if (selfClosing) children.push({ name, start: lt, end: gt })
      else child = { name, start: lt, end: -1 }
    }
    if (!selfClosing) depth++
  }
  throw new OdfPatchError('parse-failure', `no closed <${parent}>`)
}

// -- docx body blocks ---------------------------------------------------------

interface DocxBlock {
  name: string
  canon: string
}

// attributes Word/engines regenerate without meaning a content change
const VOLATILE_ATTR = /\s(?:w:rsid\w*|w14:paraId|w14:textId)="[^"]*"/g

async function docxBodyBlocks(docx: Uint8Array): Promise<DocxBlock[]> {
  let xml: string | undefined
  try {
    xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')?.async('string')
  } catch {
    throw new OdfPatchError('unreadable', 'docx')
  }
  if (!xml) throw new OdfPatchError('unreadable', 'word/document.xml')
  const source = xml
  return scanChildren(source, 'w:body')
    .children.filter((span) => span.name !== 'w:sectPr')
    .map((span) => ({
      name: span.name,
      canon: source.slice(span.start, span.end).replace(VOLATILE_ATTR, ''),
    }))
}

// -- diff -----------------------------------------------------------------------

/** cells the LCS table may hold; beyond it the edit is too large to patch safely */
const MAX_LCS_CELLS = 16_000_000

/** matched index pairs [a, b] of a longest common subsequence, ascending */
export function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const n = a.length - head - tail
  const m = b.length - head - tail
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) throw new OdfPatchError('degenerate-diff', 'too large')
  const w = m + 1
  const table = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        a[head + i] === b[head + j]
          ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
    }
  }
  const out: Array<[number, number]> = []
  for (let k = 0; k < head; k++) out.push([k, k])
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) {
      out.push([head + i, head + j])
      i++
      j++
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++
    else j++
  }
  for (let k = tail; k > 0; k--) out.push([a.length - k, b.length - k])
  return out
}

// -- helpers ----------------------------------------------------------------------

const NAME_ATTR = /\b(?:style:name|draw:name|table:name)="([^"]*)"/g

function namesIn(xml: string, into: Set<string>): void {
  for (const m of xml.matchAll(NAME_ATTR)) into.add(m[1])
}

const PPR = /<w:pPr>[\s\S]*?<\/w:pPr>|<w:pPr\/>/
const NUM_ID = /<w:numId w:val="([^"]*)"/

const startTagAttr = (raw: string, name: string): string | undefined =>
  new RegExp(`^<[^>]*\\s${name}="([^"]*)"`).exec(raw)?.[1]

/** what a rewritten ODF child loses, by the unmodelled elements it holds */
const LOSSY: Array<[RegExp, string]> = [
  [/<office:annotation\b/, 'comments in rewritten blocks'],
  [/<text:change(?:-start|-end)?\b/, 'tracked-change marks in rewritten blocks'],
  [/<draw:object\b/, 'embedded objects in rewritten blocks'],
  [/<text:note\b/, 'notes in rewritten blocks'],
  [/<text:bookmark/, 'bookmarks in rewritten blocks'],
  [/<draw:(?:custom-shape|rect|line|ellipse|circle|connector|g)\b/, 'shapes in rewritten blocks'],
]

/** insert `xml` at the end of the `name` container in `part` (creating it from a self-closed tag) */
function appendInto(part: string, name: string, xml: string): string | null {
  const close = part.indexOf(`</${name}>`)
  if (close >= 0) return part.slice(0, close) + xml + part.slice(close)
  const empty = new RegExp(`<${name}(\\s[^>]*)?/>`).exec(part)
  if (!empty) return null
  return (
    part.slice(0, empty.index) +
    `<${name}${empty[1] ?? ''}>${xml}</${name}>` +
    part.slice(empty.index + empty[0].length)
  )
}

// -- the patch ------------------------------------------------------------------

export async function patchOdt(
  original: Uint8Array,
  baselineDocx: Uint8Array,
  currentDocx: Uint8Array,
): Promise<OdtPatchResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(original, { createFolders: false })
  } catch {
    throw new OdfPatchError('unreadable', 'odt')
  }
  const contentEntry = zip.file('content.xml')
  if (!contentEntry) throw new OdfPatchError('unreadable', 'content.xml')
  // keep a BOM if there is one: everything outside the edits stays as it was
  const content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    await contentEntry.async('uint8array'),
  )

  // -- the baseline must be exactly what the import filter makes of O
  let conversion: Awaited<ReturnType<typeof convertOdtToDocx>>
  try {
    conversion = await convertOdtToDocx(original)
  } catch (err) {
    throw new OdfPatchError('unreadable', String(err))
  }
  const { sourceMap } = conversion
  const base = await docxBodyBlocks(baselineDocx)
  const fresh = await docxBodyBlocks(conversion.docx)
  if (
    sourceMap.length !== base.length ||
    fresh.length !== base.length ||
    fresh.some((block, index) => block.canon !== base[index].canon)
  )
    throw new OdfPatchError('baseline-mismatch')
  const current = await docxBodyBlocks(currentDocx)

  const pairs = lcsPairs(
    base.map((block) => block.canon),
    current.map((block) => block.canon),
  )
  if (pairs.length === base.length && pairs.length === current.length) {
    // nothing changed: the original package is the answer, to the byte
    const sources = new Set(sourceMap.filter((s) => s >= 0)).size
    return { odt: original, kept: sources, rewritten: 0, inserted: 0, removed: 0, dropped: [] }
  }

  // -- ODF side: top-level children of office:text, cross-checked with the parser
  const text = scanChildren(content, 'office:text')
  const children = text.children
  const parsedBody = (() => {
    const roots = parseOdfXml(content)
    for (const root of roots ?? []) {
      const body = firstChild(root, 'office:body')
      const officeText = body && firstChild(body, 'office:text')
      if (officeText) return officeText
    }
    return null
  })()
  const parsedCount = parsedBody
    ? nodeChildren(parsedBody).filter((node) => nodeName(node) !== null).length
    : -1
  if (parsedCount !== children.length || sourceMap.some((s) => s >= children.length))
    throw new OdfPatchError('parse-failure', 'office:text children disagree')

  const bToC = new Array<number>(base.length).fill(-1)
  const cToB = new Array<number>(current.length).fill(-1)
  for (const [b, c] of pairs) {
    bToC[b] = c
    cToB[c] = b
  }

  const blocksOf = new Map<number, number[]>()
  sourceMap.forEach((source, b) => {
    if (source < 0) return
    const list = blocksOf.get(source) ?? []
    list.push(b)
    blocksOf.set(source, list)
  })

  // a child is clean when its blocks all survived, unchanged and still adjacent
  const dirty = new Set<number>()
  for (const [source, list] of blocksOf) {
    const cs = list.map((b) => bToC[b])
    if (cs.some((c, k) => c < 0 || (k > 0 && c !== cs[k - 1] + 1))) dirty.add(source)
  }
  // a new list item next to a kept list must join it, not start a list of its own
  current.forEach((block, c) => {
    if (cToB[c] >= 0) return
    const numId = NUM_ID.exec(block.canon)?.[1]
    if (!numId) return
    for (const near of [c - 1, c + 1]) {
      const b = cToB[near] ?? -1
      if (b >= 0 && sourceMap[b] >= 0 && NUM_ID.exec(base[b].canon)?.[1] === numId)
        dirty.add(sourceMap[b])
    }
  })
  if (blocksOf.size >= 4 && dirty.size * 2 > blocksOf.size)
    throw new OdfPatchError('degenerate-diff', `${dirty.size}/${blocksOf.size} children dirty`)

  // -- pair replaced blocks inside each hunk: they anchor the edit to its old place
  const anchorOfC = new Array<number>(current.length).fill(-1)
  const replacedB = new Array<number>(current.length).fill(-1)
  {
    let pb = 0
    let pc = 0
    for (const [b, c] of [...pairs, [base.length, current.length] as [number, number]]) {
      const span = Math.min(b - pb, c - pc)
      for (let k = 0; k < span; k++) replacedB[pc + k] = pb + k
      pb = b + 1
      pc = c + 1
    }
  }
  current.forEach((_, c) => {
    const b = cToB[c] >= 0 ? cToB[c] : replacedB[c]
    if (b >= 0) anchorOfC[c] = sourceMap[b]
  })

  // -- serializer over C, never reusing a name already present in O
  const stylesEntry = zip.file('styles.xml')
  const stylesXml = stylesEntry ? await stylesEntry.async('string') : null
  const reserved = new Set<string>()
  namesIn(content, reserved)
  if (stylesXml) namesIn(stylesXml, reserved)
  for (const path of Object.keys(zip.files)) reserved.add(path.replace(/\.[^./]*$/, ''))
  let loaded: Awaited<ReturnType<typeof loadDocxConverter>>
  try {
    loaded = await loadDocxConverter(currentDocx, reserved)
  } catch (err) {
    throw new OdfPatchError('unreadable', String(err))
  }
  const { c: converter } = loaded
  const currentNodes = nodeChildren(loaded.body).filter((node) => {
    const name = nodeName(node)
    return name !== null && name !== 'w:sectPr'
  })
  if (currentNodes.length !== current.length)
    throw new OdfPatchError('parse-failure', 'current body blocks disagree')

  // an edited lone paragraph whose paragraph properties did not change keeps its ODF style
  current.forEach((block, c) => {
    const b = replacedB[c]
    if (b < 0 || block.name !== 'w:p') return
    const source = sourceMap[b]
    if (source < 0 || blocksOf.get(source)?.length !== 1) return
    const child = children[source]
    if (child.name !== 'text:p' && child.name !== 'text:h') return
    if ((PPR.exec(base[b].canon)?.[0] ?? '') !== (PPR.exec(block.canon)?.[0] ?? '')) return
    const raw = content.slice(child.start, child.end)
    const styleName = startTagAttr(raw, 'text:style-name')
    if (!styleName) return
    const override: ParaOverride = { styleName }
    if (child.name === 'text:h')
      override.outlineLevel = startTagAttr(raw, 'text:outline-level') ?? '1'
    converter.paraOverrides.set(currentNodes[c], override)
  })

  // -- emit office:text in C order
  const out: string[] = []
  const gap = (k: number): string =>
    content.slice(k > 0 ? children[k - 1].end : text.open, children[k].start)
  const raw = (k: number): string => content.slice(children[k].start, children[k].end)
  let nextSrc = 0
  let run: XNode[] = []
  let runGap = ''
  let kept = 0
  let rewritten = 0
  const lost = new Set<string>()

  const endRun = (): void => {
    if (run.length === 0) return
    out.push(runGap + converter.blocks(run))
    rewritten += run.length
    run = []
    runGap = ''
  }
  const hasBlockless = (upTo: number): boolean => {
    for (let k = nextSrc; k < upTo; k++) if (!blocksOf.has(k)) return true
    return false
  }
  const flushBlockless = (upTo: number): void => {
    for (let k = nextSrc; k < upTo; k++) if (!blocksOf.has(k)) out.push(gap(k) + raw(k))
    nextSrc = Math.max(nextSrc, upTo)
  }

  current.forEach((_, c) => {
    const source = anchorOfC[c]
    const matched = cToB[c] >= 0
    if (matched && source === -1) return // the filter's synthetic trailing paragraph
    if (source >= 0 && !dirty.has(source)) {
      if (source < nextSrc) return // a later block of a child already copied
      endRun()
      flushBlockless(source)
      out.push(gap(source) + raw(source))
      kept++
      nextSrc = source + 1
      return
    }
    if (source >= nextSrc) {
      if (hasBlockless(source)) {
        endRun()
        flushBlockless(source)
      }
      if (run.length === 0) runGap = gap(source)
      nextSrc = source + 1
    }
    run.push(currentNodes[c])
  })
  endRun()
  flushBlockless(children.length)

  for (const source of dirty) {
    const xml = raw(source)
    for (const [pattern, what] of LOSSY) if (pattern.test(xml)) lost.add(what)
  }

  const lastEnd = children.length > 0 ? children[children.length - 1].end : text.open
  let head = content.slice(0, text.open)
  const newAutomatic = converter.contentPart.reg.xml.join('')
  if (newAutomatic) {
    const withStyles =
      appendInto(head, 'office:automatic-styles', newAutomatic) ??
      (head.includes('<office:body')
        ? head.replace(
            '<office:body',
            `<office:automatic-styles>${newAutomatic}</office:automatic-styles><office:body`,
          )
        : null)
    if (withStyles === null) throw new OdfPatchError('unsupported', 'no place for automatic styles')
    head = withStyles
  }
  const newContent = head + out.join('') + content.slice(lastEnd)

  // -- named styles the rewritten blocks reference but O does not define
  const replaced = new Map<string, string | Uint8Array>([['content.xml', newContent]])
  const existingNamed = new Set<string>()
  const officeStyles = stylesXml ? /<office:styles[\s\S]*?<\/office:styles>/.exec(stylesXml) : null
  if (officeStyles) namesIn(officeStyles[0], existingNamed)
  const missingNamed = converter.usedNamedStylesXml(existingNamed)
  if (missingNamed) {
    const patched = stylesXml ? appendInto(stylesXml, 'office:styles', missingNamed) : null
    if (patched === null) throw new OdfPatchError('unsupported', 'no office:styles to extend')
    replaced.set('styles.xml', patched)
  }

  // -- new pictures: package entries plus manifest lines
  if (converter.media.length > 0) {
    const manifestEntry = zip.file('META-INF/manifest.xml')
    if (manifestEntry) {
      const manifest = await manifestEntry.async('string')
      const lines = converter.media
        .map(
          (m) =>
            `<manifest:file-entry manifest:full-path="${m.name}" manifest:media-type="${m.mime}"/>`,
        )
        .join('')
      const patched = appendInto(manifest, 'manifest:manifest', lines)
      if (patched === null) throw new OdfPatchError('unsupported', 'unreadable manifest')
      replaced.set('META-INF/manifest.xml', patched)
    }
    for (const m of converter.media) replaced.set(m.name, m.bytes)
  }

  // -- repackage: original entry order, mimetype first and stored
  const pkg = new JSZip()
  const mimetype = zip.file('mimetype')
  if (mimetype) pkg.file('mimetype', await mimetype.async('uint8array'), { compression: 'STORE' })
  for (const entry of Object.values(zip.files)) {
    if (entry.name === 'mimetype') continue
    if (entry.dir) {
      pkg.folder(entry.name)
      continue
    }
    const swap = replaced.get(entry.name)
    replaced.delete(entry.name)
    pkg.file(entry.name, swap ?? (await entry.async('uint8array')), {
      date: entry.date,
      createFolders: false,
    })
  }
  for (const [name, data] of replaced) pkg.file(name, data, { createFolders: false })
  const odt = await pkg.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })

  const inserted = cToB.filter((b) => b < 0).length
  const removed = bToC.filter((c) => c < 0).length
  const dropped = [...lost, ...converter.drops.list().map((d) => `${d.what} (${d.count})`)]
  return { odt, kept, rewritten, inserted, removed, dropped }
}
