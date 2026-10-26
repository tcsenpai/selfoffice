/**
 * .docx → .odt export filter. Reads word/document.xml (+ styles, numbering,
 * rels, notes, headers/footers, media) straight from the zip and writes a
 * minimal ODF 1.3 text package. Formatting is emitted through a style registry:
 * every unique combination becomes one automatic style in content.xml (or
 * styles.xml for headers/footers). Like the import filters, a construct with
 * no provable ODF form is counted into `dropped` instead of approximated.
 */

import JSZip from 'jszip'
import { Drops } from './text'
import { sniffImageMime } from './units'
import { XNode, attr as rawAttr, firstChild, nodeChildren, nodeName, parseOdfXml } from './xml'

export interface DocxToOdtResult {
  odt: Uint8Array
  blocks: number
  /** human-readable list of features that had no ODF form and were dropped */
  dropped: string[]
}

type Attrs = Record<string, string>

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
  ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"' +
  ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
  ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"' +
  ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"' +
  ' xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"' +
  ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
  ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
  ' xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"' +
  ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"'

const MIMETYPE = 'application/vnd.oasis.opendocument.text'

// -- small helpers ----------------------------------------------------------

const esc = (s: string): string =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
    )

/** fast-xml-parser leaves numeric character references (&#xF0B7;) undecoded */
const decodeRefs = (s: string): string =>
  s.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (m, code: string) => {
    const n = code[0] === 'x' ? parseInt(code.slice(1), 16) : Number(code)
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
  })
const attr = (node: XNode, name: string): string | undefined => {
  const v = rawAttr(node, name)
  return v === undefined ? v : decodeRefs(v)
}
const els = (node: XNode): XNode[] => nodeChildren(node).filter((c) => nodeName(c) !== null)
const kid = (node: XNode | null | undefined, name: string): XNode | null =>
  node ? firstChild(node, name) : null
const wv = (node: XNode | null | undefined): string | undefined =>
  node ? attr(node, 'w:val') : undefined
/** OOXML toggle: element present and not explicitly off */
const isOn = (node: XNode | null): boolean =>
  !!node && !['0', 'false', 'off'].includes(wv(node) ?? '1')
const num = (s: string | null | undefined): number | null => {
  if (s === undefined || s === null || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
const inch = (twips: number): string => `${+(twips / 1440).toFixed(4)}in`
const cm = (emu: number): string => `${+(emu / 360000).toFixed(3)}cm`

function attrString(attrs: Attrs): string {
  return Object.keys(attrs)
    .sort()
    .map((k) => ` ${k}="${esc(attrs[k])}"`)
    .join('')
}

function propsEl(tag: string, attrs: Attrs, inner = ''): string {
  if (Object.keys(attrs).length === 0 && !inner) return ''
  return inner ? `<${tag}${attrString(attrs)}>${inner}</${tag}>` : `<${tag}${attrString(attrs)}/>`
}

/** literal text → ODF inline content (tabs, line breaks, runs of spaces) */
function textContent(s: string): string {
  let out = ''
  let pendingSpaces = 0
  let prevPlain = false
  const flush = (): void => {
    if (pendingSpaces === 0) return
    out += pendingSpaces === 1 ? '<text:s/>' : `<text:s text:c="${pendingSpaces}"/>`
    pendingSpaces = 0
  }
  let buf = ''
  const flushBuf = (): void => {
    if (buf) out += esc(buf)
    buf = ''
  }
  for (const ch of s) {
    if (ch === ' ') {
      if (prevPlain) {
        buf += ' '
        prevPlain = false
      } else {
        flushBuf()
        pendingSpaces++
      }
      continue
    }
    flushBuf()
    flush()
    if (ch === '\t') out += '<text:tab/>'
    else if (ch === '\n' || ch === '\r') out += '<text:line-break/>'
    else {
      buf += ch
      prevPlain = true
      continue
    }
    prevPlain = false
  }
  flushBuf()
  flush()
  return out
}

// -- style registry ---------------------------------------------------------

class StyleRegistry {
  private byKey = new Map<string, string>()
  private counters = new Map<string, number>()
  readonly xml: string[] = []
  readonly listStyles = new Map<string, string>()

  /** names already taken in the target package (odt-patch seeds it from the original) */
  constructor(private reserved: ReadonlySet<string> = new Set()) {}

  /** one automatic style per unique (family, parent, body) */
  add(family: string, prefix: string, body: string, parent?: string): string {
    const key = `${family}|${parent ?? ''}|${body}`
    const hit = this.byKey.get(key)
    if (hit) return hit
    const name = this.nextName(prefix)
    const p = parent ? ` style:parent-style-name="${esc(parent)}"` : ''
    this.xml.push(
      `<style:style style:name="${name}" style:family="${family}"${p}>${body}</style:style>`,
    )
    this.byKey.set(key, name)
    return name
  }

  nextName(prefix: string): string {
    let n = this.counters.get(prefix) ?? 0
    do n++
    while (this.reserved.has(`${prefix}${n}`))
    this.counters.set(prefix, n)
    return `${prefix}${n}`
  }
}

// -- docx model -------------------------------------------------------------

interface StyleDef {
  id: string
  type: string
  name: string
  basedOn?: string
  isDefault: boolean
  pPr: XNode | null
  rPr: XNode | null
  tblPr: XNode | null
  hasConditional: boolean
}

interface NumLevel {
  fmt: string
  text: string
  start: number
  left: number | null
  hanging: number | null
  firstLine: number | null
}

interface Rel {
  target: string
  external: boolean
}

interface Part {
  reg: StyleRegistry
  rels: Map<string, Rel>
  dir: string
}

interface Seg {
  breakBefore?: 'page' | 'column'
  xml: string
}

interface FieldState {
  instr: string
  phase: 'instr' | 'result'
  suppress: boolean
  close: string
}

const HIGHLIGHT: Record<string, string> = {
  yellow: 'FFFF00',
  green: '00FF00',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  blue: '0000FF',
  red: 'FF0000',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  darkGray: '808080',
  lightGray: 'C0C0C0',
  black: '000000',
  white: 'FFFFFF',
}

const UNDERLINE: Record<string, [string, boolean]> = {
  single: ['solid', false],
  words: ['solid', false],
  double: ['double', false],
  thick: ['solid', true],
  dotted: ['dotted', false],
  dottedHeavy: ['dotted', true],
  dash: ['dash', false],
  dashedHeavy: ['dash', true],
  dashLong: ['long-dash', false],
  dotDash: ['dot-dash', false],
  dotDotDash: ['dot-dot-dash', false],
  wave: ['wave', false],
  wavyHeavy: ['wave', true],
}

const NUM_FMT: Record<string, string> = {
  decimal: '1',
  lowerLetter: 'a',
  upperLetter: 'A',
  lowerRoman: 'i',
  upperRoman: 'I',
  none: '',
}

const MEDIA_MIME: Record<string, string> = {
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  webp: 'image/webp',
}

function normalizePath(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '..') out.pop()
    else if (seg && seg !== '.') out.push(seg)
  }
  return out.join('/')
}

function parseRels(xml: string | null): Map<string, Rel> {
  const map = new Map<string, Rel>()
  const tree = xml ? parseOdfXml(xml) : null
  const root = tree?.find((n) => nodeName(n) === 'Relationships')
  if (!root) return map
  for (const rel of els(root)) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (id && target) map.set(id, { target, external: attr(rel, 'TargetMode') === 'External' })
  }
  return map
}

// -- the converter ----------------------------------------------------------

/** keep an original ODF paragraph's style when only its text was edited (odt-patch) */
export interface ParaOverride {
  styleName: string
  outlineLevel?: string
}

export class Converter {
  readonly drops = new Drops()
  blockCount = 0
  countBlocks = true
  private styles = new Map<string, StyleDef>()
  private docDefaults: { pPr: XNode | null; rPr: XNode | null } = { pPr: null, rPr: null }
  private abstracts = new Map<string, Map<number, NumLevel>>()
  private nums = new Map<string, { abstract: string; starts: Map<number, number> }>()
  private themeFonts = { major: '', minor: '' }
  private usedStyles = new Map<string, string>() // docx id → ODF name
  private usedLists = new Set<string>()
  private bookmarkNames = new Map<string, string>()
  private noteCounter = { footnote: 0, endnote: 0 }
  private notes = { footnote: new Map<string, XNode>(), endnote: new Map<string, XNode>() }
  readonly media: Array<{ name: string; mime: string; bytes: Uint8Array }> = []
  private mediaByPath = new Map<string, string>()
  /** paragraphs (by node) that keep their original ODF style instead of a generated one */
  readonly paraOverrides = new Map<XNode, ParaOverride>()
  contentWidthTw = 9360
  part: Part
  readonly contentPart: Part
  readonly stylesPart: Part
  private fields: FieldState[] = []

  constructor(
    private zip: JSZip,
    private mediaBytes: Map<string, Uint8Array>,
    reserved: ReadonlySet<string> = new Set(),
  ) {
    this.contentPart = { reg: new StyleRegistry(reserved), rels: new Map(), dir: 'word' }
    this.stylesPart = { reg: new StyleRegistry(reserved), rels: new Map(), dir: 'word' }
    this.part = this.contentPart
  }

  // ---- loading -----------------------------------------------------------

  async readText(path: string): Promise<string | null> {
    const f = this.zip.file(path)
    return f ? f.async('string') : null
  }

  async loadStyles(): Promise<void> {
    const tree = parseOdfXml((await this.readText('word/styles.xml')) ?? '')
    const root = tree?.find((n) => nodeName(n) === 'w:styles')
    if (root) {
      const dd = kid(root, 'w:docDefaults')
      this.docDefaults = {
        pPr: kid(kid(dd, 'w:pPrDefault'), 'w:pPr'),
        rPr: kid(kid(dd, 'w:rPrDefault'), 'w:rPr'),
      }
      for (const s of els(root)) {
        if (nodeName(s) !== 'w:style') continue
        const id = attr(s, 'w:styleId')
        if (!id) continue
        this.styles.set(id, {
          id,
          type: attr(s, 'w:type') ?? 'paragraph',
          name: wv(kid(s, 'w:name')) ?? id,
          basedOn: wv(kid(s, 'w:basedOn')),
          isDefault: attr(s, 'w:default') === '1' || attr(s, 'w:default') === 'true',
          pPr: kid(s, 'w:pPr'),
          rPr: kid(s, 'w:rPr'),
          tblPr: kid(s, 'w:tblPr'),
          hasConditional: !!kid(s, 'w:tblStylePr'),
        })
      }
    }
    const theme = (await this.readText('word/theme/theme1.xml')) ?? ''
    this.themeFonts.major = /<a:majorFont>\s*<a:latin typeface="([^"]*)"/.exec(theme)?.[1] ?? ''
    this.themeFonts.minor = /<a:minorFont>\s*<a:latin typeface="([^"]*)"/.exec(theme)?.[1] ?? ''
  }

  async loadNumbering(): Promise<void> {
    const tree = parseOdfXml((await this.readText('word/numbering.xml')) ?? '')
    const root = tree?.find((n) => nodeName(n) === 'w:numbering')
    if (!root) return
    for (const el of els(root)) {
      if (nodeName(el) === 'w:abstractNum') {
        const levels = new Map<number, NumLevel>()
        for (const lvl of els(el)) {
          if (nodeName(lvl) !== 'w:lvl') continue
          const ilvl = num(attr(lvl, 'w:ilvl')) ?? 0
          const ind = kid(kid(lvl, 'w:pPr'), 'w:ind')
          levels.set(ilvl, {
            fmt: wv(kid(lvl, 'w:numFmt')) ?? 'decimal',
            text: wv(kid(lvl, 'w:lvlText')) ?? '',
            start: num(wv(kid(lvl, 'w:start'))) ?? 1,
            left: num(ind && (attr(ind, 'w:left') ?? attr(ind, 'w:start'))),
            hanging: num(ind && attr(ind, 'w:hanging')),
            firstLine: num(ind && attr(ind, 'w:firstLine')),
          })
        }
        this.abstracts.set(attr(el, 'w:abstractNumId') ?? '', levels)
      }
    }
    for (const el of els(root)) {
      if (nodeName(el) !== 'w:num') continue
      const starts = new Map<number, number>()
      for (const o of els(el)) {
        if (nodeName(o) !== 'w:lvlOverride') continue
        const s = num(wv(kid(o, 'w:startOverride')))
        if (s !== null) starts.set(num(attr(o, 'w:ilvl')) ?? 0, s)
        else if (kid(o, 'w:lvl')) this.drops.add('numbering level overrides')
      }
      this.nums.set(attr(el, 'w:numId') ?? '', {
        abstract: wv(kid(el, 'w:abstractNumId')) ?? '',
        starts,
      })
    }
  }

  async loadNotes(): Promise<void> {
    for (const kind of ['footnote', 'endnote'] as const) {
      const tree = parseOdfXml((await this.readText(`word/${kind}s.xml`)) ?? '')
      const root = tree?.find((n) => nodeName(n) === `w:${kind}s`)
      if (!root) continue
      for (const n of els(root)) {
        if (nodeName(n) !== `w:${kind}`) continue
        const type = attr(n, 'w:type')
        if (type === 'separator' || type === 'continuationSeparator') continue
        this.notes[kind].set(attr(n, 'w:id') ?? '', n)
      }
    }
  }

  // ---- style resolution --------------------------------------------------

  /** derived-first style chain */
  private chain(id: string | undefined): StyleDef[] {
    const out: StyleDef[] = []
    const seen = new Set<string>()
    let cur = id ? this.styles.get(id) : undefined
    while (cur && !seen.has(cur.id)) {
      out.push(cur)
      seen.add(cur.id)
      cur = cur.basedOn ? this.styles.get(cur.basedOn) : undefined
    }
    return out
  }

  private odfStyleName(def: StyleDef): string {
    if (def.type === 'paragraph' && def.isDefault) return 'Standard'
    const heading = /^Heading([1-9])$/.exec(def.id) ?? /^heading ([1-9])$/i.exec(def.name)
    if (heading) return `Heading_20_${heading[1]}`
    let name = def.id.replace(/[^A-Za-z0-9_.-]/g, '_')
    if (!/^[A-Za-z_]/.test(name) || /^[A-Z]{1,5}\d+$/.test(name)) name = `S_${name}`
    return name
  }

  /** mark a docx style used (and its ancestors); returns its ODF name */
  private useStyle(id: string | undefined, type: 'paragraph' | 'character'): string | undefined {
    const def = id ? this.styles.get(id) : undefined
    if (!def || def.type !== type) return undefined
    for (const d of this.chain(def.id)) this.usedStyles.set(d.id, this.odfStyleName(d))
    return this.odfStyleName(def)
  }

  private defaultParaStyleName(): string {
    return 'Standard'
  }

  // ---- property translation ---------------------------------------------

  private fontName(rf: XNode | null): string | undefined {
    if (!rf) return undefined
    const direct = attr(rf, 'w:ascii') ?? attr(rf, 'w:hAnsi')
    if (direct) return direct
    const theme = attr(rf, 'w:asciiTheme') ?? attr(rf, 'w:hAnsiTheme')
    if (theme) return /^major/i.test(theme) ? this.themeFonts.major : this.themeFonts.minor
    return undefined
  }

  textAttrs(rPr: XNode | null): Attrs {
    const a: Attrs = {}
    if (!rPr) return a
    for (const p of els(rPr)) {
      const n = nodeName(p)
      switch (n) {
        case 'w:b':
          a['fo:font-weight'] = isOn(p) ? 'bold' : 'normal'
          break
        case 'w:i':
          a['fo:font-style'] = isOn(p) ? 'italic' : 'normal'
          break
        case 'w:u': {
          const v = wv(p) ?? 'single'
          if (v === 'none') a['style:text-underline-style'] = 'none'
          else {
            const m = UNDERLINE[v]
            if (!m) this.drops.add(`underline style "${v}"`)
            a['style:text-underline-style'] = m?.[0] ?? 'solid'
            a['style:text-underline-width'] = m?.[1] ? 'bold' : 'auto'
            const c = attr(p, 'w:color')
            a['style:text-underline-color'] = c && c !== 'auto' ? `#${c}` : 'font-color'
          }
          break
        }
        case 'w:strike':
          a['style:text-line-through-style'] = isOn(p) ? 'solid' : 'none'
          break
        case 'w:dstrike':
          a['style:text-line-through-style'] = isOn(p) ? 'solid' : 'none'
          if (isOn(p)) a['style:text-line-through-type'] = 'double'
          break
        case 'w:vertAlign': {
          const v = wv(p)
          if (v === 'superscript') a['style:text-position'] = 'super 58%'
          else if (v === 'subscript') a['style:text-position'] = 'sub 58%'
          else a['style:text-position'] = '0% 100%'
          break
        }
        case 'w:rFonts': {
          const f = this.fontName(p)
          if (f) a['fo:font-family'] = f
          break
        }
        case 'w:sz': {
          const v = num(wv(p))
          if (v !== null) a['fo:font-size'] = `${v / 2}pt`
          break
        }
        case 'w:color': {
          const v = wv(p)
          if (v && /^[0-9A-Fa-f]{6}$/.test(v)) a['fo:color'] = `#${v.toUpperCase()}`
          break
        }
        case 'w:highlight': {
          const v = wv(p) ?? ''
          if (v === 'none') a['fo:background-color'] = 'transparent'
          else if (HIGHLIGHT[v]) a['fo:background-color'] = `#${HIGHLIGHT[v]}`
          else this.drops.add(`highlight color "${v}"`)
          break
        }
        case 'w:shd': {
          const fill = attr(p, 'w:fill')
          if (fill && /^[0-9A-Fa-f]{6}$/.test(fill) && !a['fo:background-color'])
            a['fo:background-color'] = `#${fill.toUpperCase()}`
          break
        }
        case 'w:caps':
          a['fo:text-transform'] = isOn(p) ? 'uppercase' : 'none'
          break
        case 'w:smallCaps':
          a['fo:font-variant'] = isOn(p) ? 'small-caps' : 'normal'
          break
        case 'w:vanish':
          if (isOn(p)) a['text:display'] = 'none'
          break
        case 'w:spacing': {
          const v = num(wv(p))
          if (v !== null) a['fo:letter-spacing'] = inch(v)
          break
        }
        case 'w:w': {
          const v = num(wv(p))
          if (v !== null) a['style:text-scale'] = `${v}%`
          break
        }
        case 'w:shadow':
          if (isOn(p)) a['fo:text-shadow'] = '1pt 1pt'
          break
        case 'w:emboss':
          if (isOn(p)) a['style:font-relief'] = 'embossed'
          break
        case 'w:imprint':
          if (isOn(p)) a['style:font-relief'] = 'engraved'
          break
        case 'w:outline':
          if (isOn(p)) a['style:text-outline'] = 'true'
          break
        case 'w:lang': {
          const [lang, country] = (wv(p) ?? '').split('-')
          if (lang) a['fo:language'] = lang
          if (country) a['fo:country'] = country
          break
        }
        case 'w:effect':
        case 'w:em':
        case 'w:bdr':
        case 'w:fitText':
          this.drops.add(`character effect ${n?.slice(2)}`)
          break
        default:
          break
      }
    }
    return a
  }

  private border(el: XNode | null): string | null {
    if (!el) return null
    const v = wv(el)
    if (!v) return null
    if (v === 'none' || v === 'nil') return 'none'
    const sz = num(attr(el, 'w:sz')) ?? 4
    const color = attr(el, 'w:color')
    let style = 'solid'
    if (v === 'double') style = 'double'
    else if (v === 'dotted') style = 'dotted'
    else if (v === 'dashed') style = 'dashed'
    else if (v !== 'single' && v !== 'thick') this.drops.add(`border style "${v}" (drawn solid)`)
    const c = color && /^[0-9A-Fa-f]{6}$/.test(color) ? color.toUpperCase() : '000000'
    return `${Math.max(sz / 8, 0.25)}pt ${style} #${c}`
  }

  /** returns paragraph-properties attrs + inner (tab stops) */
  paraProps(pPr: XNode | null): { attrs: Attrs; inner: string } {
    const a: Attrs = {}
    let inner = ''
    if (!pPr) return { attrs: a, inner }
    for (const p of els(pPr)) {
      switch (nodeName(p)) {
        case 'w:jc': {
          const v = wv(p)
          const m: Record<string, string> = {
            left: 'start',
            start: 'start',
            right: 'end',
            end: 'end',
            center: 'center',
            both: 'justify',
            distribute: 'justify',
          }
          if (v && m[v]) a['fo:text-align'] = m[v]
          break
        }
        case 'w:spacing': {
          const before = num(attr(p, 'w:before'))
          const after = num(attr(p, 'w:after'))
          if (before !== null) a['fo:margin-top'] = inch(before)
          if (after !== null) a['fo:margin-bottom'] = inch(after)
          const line = num(attr(p, 'w:line'))
          if (line !== null) {
            const rule = attr(p, 'w:lineRule') ?? 'auto'
            if (rule === 'auto') a['fo:line-height'] = `${+((line / 240) * 100).toFixed(1)}%`
            else if (rule === 'exact') a['fo:line-height'] = inch(line)
            else a['style:line-height-at-least'] = inch(line)
          }
          break
        }
        case 'w:ind': {
          const left = num(attr(p, 'w:left') ?? attr(p, 'w:start'))
          const right = num(attr(p, 'w:right') ?? attr(p, 'w:end'))
          const hanging = num(attr(p, 'w:hanging'))
          const first = num(attr(p, 'w:firstLine'))
          if (left !== null) a['fo:margin-left'] = inch(left)
          if (right !== null) a['fo:margin-right'] = inch(right)
          if (hanging !== null) a['fo:text-indent'] = inch(-hanging)
          else if (first !== null) a['fo:text-indent'] = inch(first)
          break
        }
        case 'w:keepNext':
          a['fo:keep-with-next'] = isOn(p) ? 'always' : 'auto'
          break
        case 'w:keepLines':
          a['fo:keep-together'] = isOn(p) ? 'always' : 'auto'
          break
        case 'w:pageBreakBefore':
          if (isOn(p)) a['fo:break-before'] = 'page'
          break
        case 'w:widowControl':
          a['fo:widows'] = isOn(p) ? '2' : '0'
          a['fo:orphans'] = isOn(p) ? '2' : '0'
          break
        case 'w:contextualSpacing':
          a['style:contextual-spacing'] = isOn(p) ? 'true' : 'false'
          break
        case 'w:bidi':
          if (isOn(p)) a['style:writing-mode'] = 'rl-tb'
          break
        case 'w:shd': {
          const fill = attr(p, 'w:fill')
          if (fill && /^[0-9A-Fa-f]{6}$/.test(fill))
            a['fo:background-color'] = `#${fill.toUpperCase()}`
          break
        }
        case 'w:pBdr': {
          for (const side of ['top', 'bottom', 'left', 'right']) {
            const b = this.border(kid(p, `w:${side}`))
            if (b) a[`fo:border-${side}`] = b
          }
          break
        }
        case 'w:tabs': {
          let stops = ''
          for (const t of els(p)) {
            const type = attr(t, 'w:val') ?? 'left'
            const pos = num(attr(t, 'w:pos'))
            if (pos === null || type === 'clear') continue
            const map: Record<string, string> = {
              left: 'left',
              start: 'left',
              center: 'center',
              right: 'right',
              end: 'right',
              decimal: 'char',
            }
            if (!map[type]) this.drops.add(`tab stop type "${type}"`)
            const extra =
              (map[type] === 'char' ? ' style:char="."' : '') +
              (attr(t, 'w:leader') === 'dot'
                ? ' style:leader-style="dotted" style:leader-text="."'
                : '')
            stops += `<style:tab-stop style:position="${inch(pos)}" style:type="${map[type] ?? 'left'}"${extra}/>`
          }
          if (stops) inner += `<style:tab-stops>${stops}</style:tab-stops>`
          break
        }
        case 'w:framePr':
          this.drops.add('paragraph frames')
          break
        default:
          break
      }
    }
    return { attrs: a, inner }
  }

  private paraStyleBody(pPr: XNode | null, extra: Attrs = {}): string {
    const { attrs, inner } = this.paraProps(pPr)
    return propsEl('style:paragraph-properties', { ...attrs, ...extra }, inner)
  }

  private textStyleName(rPr: XNode | null): string | undefined {
    const parent = this.useStyle(wv(kid(rPr, 'w:rStyle')), 'character')
    const attrs = this.textAttrs(rPr)
    if (Object.keys(attrs).length === 0) return parent
    return this.part.reg.add('text', 'T', propsEl('style:text-properties', attrs), parent)
  }

  // ---- numbering ----------------------------------------------------------

  private levelOf(numId: string, ilvl: number): NumLevel | undefined {
    const n = this.nums.get(numId)
    return n ? this.abstracts.get(n.abstract)?.get(ilvl) : undefined
  }

  private listStyle(numId: string): string {
    const reg = this.part.reg
    const hit = reg.listStyles.get(numId)
    if (hit) return hit
    const name = reg.nextName('L')
    reg.listStyles.set(numId, name)
    const n = this.nums.get(numId)
    let levels = ''
    for (let i = 0; i < 9; i++) {
      const lvl = this.levelOf(numId, i)
      const left = lvl?.left ?? 720 * (i + 1)
      const indent =
        lvl?.hanging !== null && lvl?.hanging !== undefined
          ? -lvl.hanging
          : (lvl?.firstLine ?? -360)
      const props =
        '<style:list-level-properties text:list-level-position-and-space-mode="label-alignment">' +
        `<style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${inch(left)}" fo:text-indent="${inch(indent)}" fo:margin-left="${inch(left)}"/>` +
        '</style:list-level-properties>'
      const level = i + 1
      if (!lvl || lvl.fmt === 'bullet') {
        let ch = lvl?.text ?? '•'
        const code = ch.codePointAt(0) ?? 0
        if (code >= 0xf000 && code <= 0xf0ff) ch = '•'
        else if (ch === 'o') ch = '◦'
        else if (ch === '§') ch = '▪'
        levels += `<text:list-level-style-bullet text:level="${level}" text:bullet-char="${esc(ch || '•')}">${props}</text:list-level-style-bullet>`
      } else {
        let fmt = NUM_FMT[lvl.fmt]
        if (fmt === undefined) {
          this.drops.add(`numbering format "${lvl.fmt}" (decimal used)`)
          fmt = '1'
        }
        const first = lvl.text.indexOf('%')
        const marks = [...lvl.text.matchAll(/%(\d)/g)]
        const last = marks[marks.length - 1]
        const prefix = first > 0 ? lvl.text.slice(0, first) : ''
        const suffix = last ? lvl.text.slice(last.index + 2) : ''
        const start = n?.starts.get(i) ?? lvl.start
        levels +=
          `<text:list-level-style-number text:level="${level}" style:num-format="${fmt}"` +
          `${prefix ? ` style:num-prefix="${esc(prefix)}"` : ''}${suffix ? ` style:num-suffix="${esc(suffix)}"` : ''}` +
          ` text:start-value="${start}" text:display-levels="${Math.min(Math.max(marks.length, 1), level)}">${props}</text:list-level-style-number>`
      }
    }
    reg.xml.push(`<text:list-style style:name="${name}">${levels}</text:list-style>`)
    return name
  }

  // ---- blocks -------------------------------------------------------------

  blocks(nodes: XNode[]): string {
    let out = ''
    let depth = 0
    let curNum = ''
    const closeAll = (): void => {
      while (depth > 0) {
        out += '</text:list-item></text:list>'
        depth--
      }
      curNum = ''
    }
    const walk = (list: XNode[]): void => {
      for (const node of list) {
        const name = nodeName(node)
        if (name === 'w:p') {
          const info = this.paraNumbering(node)
          const xml = this.paragraph(node, info)
          if (!info) {
            closeAll()
            out += xml
            continue
          }
          const target = info.ilvl + 1
          if (curNum !== info.numId) {
            closeAll()
            curNum = info.numId
          }
          if (depth > target) {
            while (depth > target) {
              out += '</text:list-item></text:list>'
              depth--
            }
            out += '</text:list-item><text:list-item>'
          } else if (depth === target) {
            out += '</text:list-item><text:list-item>'
          } else {
            while (depth < target) {
              if (depth === 0) {
                const cont = this.usedLists.has(info.numId)
                this.usedLists.add(info.numId)
                out += `<text:list text:style-name="${this.listStyle(info.numId)}"${cont ? ' text:continue-numbering="true"' : ''}>`
              } else out += '<text:list>'
              out += '<text:list-item>'
              depth++
            }
          }
          out += xml
        } else if (name === 'w:tbl') {
          closeAll()
          out += this.table(node)
        } else if (name === 'w:sdt') {
          const content = kid(node, 'w:sdtContent')
          if (content) walk(els(content))
        } else if (name === 'mc:AlternateContent') {
          const choice = kid(node, 'mc:Choice') ?? kid(node, 'mc:Fallback')
          if (choice) walk(els(choice))
        } else if (
          name === 'w:sectPr' ||
          name === 'w:tcPr' ||
          name === 'w:bookmarkStart' ||
          name === 'w:bookmarkEnd'
        ) {
          // layout handled separately; body-level bookmarks have no anchor paragraph
        } else if (
          name &&
          !name.startsWith('w:proofErr') &&
          name !== 'w:permStart' &&
          name !== 'w:permEnd'
        ) {
          this.drops.add(`block element ${name}`)
        }
      }
    }
    walk(nodes)
    closeAll()
    return out
  }

  private paraNumbering(p: XNode): { numId: string; ilvl: number } | null {
    const pPr = kid(p, 'w:pPr')
    const direct = kid(pPr, 'w:numPr')
    let numId = wv(kid(direct, 'w:numId'))
    let ilvl = num(wv(kid(direct, 'w:ilvl')))
    if (numId === undefined || ilvl === null) {
      for (const s of this.chain(wv(kid(pPr, 'w:pStyle')))) {
        const np = kid(s.pPr, 'w:numPr')
        if (!np) continue
        numId ??= wv(kid(np, 'w:numId'))
        ilvl ??= num(wv(kid(np, 'w:ilvl')))
      }
    }
    if (!numId || numId === '0' || !this.nums.has(numId)) return null
    return { numId, ilvl: Math.min(Math.max(ilvl ?? 0, 0), 8) }
  }

  private headingLevel(pPr: XNode | null): number | null {
    const direct = num(wv(kid(pPr, 'w:outlineLvl')))
    if (direct !== null) return direct <= 8 ? direct + 1 : null
    for (const s of this.chain(wv(kid(pPr, 'w:pStyle')))) {
      const m = /^heading ([1-9])$/i.exec(s.name)
      const lvl = num(wv(kid(s.pPr, 'w:outlineLvl')))
      if (lvl !== null) return lvl <= 8 ? lvl + 1 : null
      if (m) return Number(m[1])
    }
    return null
  }

  private paragraph(p: XNode, numbering: { numId: string; ilvl: number } | null): string {
    if (this.countBlocks) this.blockCount++
    const pPr = kid(p, 'w:pPr')
    const styleId = wv(kid(pPr, 'w:pStyle'))
    const parent = this.useStyle(styleId, 'paragraph') ?? this.defaultParaStyleName()
    const level = this.headingLevel(pPr)
    const extra: Attrs = {}
    if (numbering && !kid(pPr, 'w:ind')) {
      const lvl = this.levelOf(numbering.numId, numbering.ilvl)
      if (lvl?.left != null) extra['fo:margin-left'] = inch(lvl.left)
      if (lvl?.hanging != null) extra['fo:text-indent'] = inch(-lvl.hanging)
      else if (lvl?.firstLine != null) extra['fo:text-indent'] = inch(lvl.firstLine)
    }
    const styleFor = (brk?: 'page' | 'column'): string => {
      const e = brk ? { ...extra, 'fo:break-before': brk } : extra
      const body = this.paraStyleBody(pPr, e)
      return body ? this.part.reg.add('paragraph', 'P', body, parent) : parent
    }
    const segs: Seg[] = [{ xml: '' }]
    this.inline(els(p), segs)
    // a leading page break makes the (empty) first segment redundant
    if (segs.length > 1 && segs[0].xml === '') segs.shift()
    const keep = this.paraOverrides.get(p)
    if (keep && segs.length === 1 && !segs[0].breakBefore) {
      const tag = keep.outlineLevel ? 'text:h' : 'text:p'
      const level = keep.outlineLevel ? ` text:outline-level="${esc(keep.outlineLevel)}"` : ''
      return `<${tag} text:style-name="${esc(keep.styleName)}"${level}>${segs[0].xml}</${tag}>`
    }
    return segs
      .map((s) => {
        const style = styleFor(s.breakBefore)
        const tag = level
          ? `text:h text:style-name="${esc(style)}" text:outline-level="${level}"`
          : `text:p text:style-name="${esc(style)}"`
        return `<${tag}>${s.xml}</${level ? 'text:h' : 'text:p'}>`
      })
      .join('')
  }

  // ---- inline content -------------------------------------------------------

  private add(segs: Seg[], xml: string): void {
    segs[segs.length - 1].xml += xml
  }

  private inline(nodes: XNode[], segs: Seg[]): void {
    for (const n of nodes) {
      const name = nodeName(n)
      switch (name) {
        case 'w:r':
          this.run(n, segs)
          break
        case 'w:hyperlink': {
          const rid = attr(n, 'r:id')
          const anchor = attr(n, 'w:anchor')
          const rel = rid ? this.part.rels.get(rid) : undefined
          const href = rel ? rel.target : anchor ? `#${anchor}` : null
          const start = segs.length - 1
          const before = segs[start].xml
          segs[start].xml = ''
          this.inline(els(n), segs)
          if (href && segs.length - 1 === start) {
            segs[start].xml =
              `${before}<text:a xlink:type="simple" xlink:href="${esc(href)}">${segs[start].xml}</text:a>`
          } else {
            if (href) this.drops.add('hyperlinks spanning page breaks')
            // unlinked, or the link straddles a split: keep the text
            segs[start].xml = before + segs[start].xml
          }
          break
        }
        case 'w:bookmarkStart': {
          const id = attr(n, 'w:id') ?? ''
          const nm = attr(n, 'w:name') ?? ''
          if (nm && nm !== '_GoBack') {
            this.bookmarkNames.set(id, nm)
            this.add(segs, `<text:bookmark-start text:name="${esc(nm)}"/>`)
          }
          break
        }
        case 'w:bookmarkEnd': {
          const nm = this.bookmarkNames.get(attr(n, 'w:id') ?? '')
          if (nm) this.add(segs, `<text:bookmark-end text:name="${esc(nm)}"/>`)
          break
        }
        case 'w:fldSimple': {
          const instr = (attr(n, 'w:instr') ?? '').trim()
          if (/^PAGE\b/i.test(instr))
            this.add(segs, '<text:page-number text:select-page="current">1</text:page-number>')
          else if (/^NUMPAGES\b/i.test(instr))
            this.add(segs, '<text:page-count>1</text:page-count>')
          else {
            this.drops.add('field codes (cached result kept)')
            this.inline(els(n), segs)
          }
          break
        }
        case 'w:ins':
          this.drops.add('tracked changes (insertions accepted, deletions removed)')
          this.inline(els(n), segs)
          break
        case 'w:moveTo':
          this.drops.add('tracked changes (insertions accepted, deletions removed)')
          this.inline(els(n), segs)
          break
        case 'w:del':
        case 'w:moveFrom':
          this.drops.add('tracked changes (insertions accepted, deletions removed)')
          break
        case 'w:sdt': {
          const content = kid(n, 'w:sdtContent')
          if (content) this.inline(els(content), segs)
          break
        }
        case 'w:smartTag':
        case 'w:customXml':
          this.inline(els(n), segs)
          break
        case 'mc:AlternateContent': {
          const choice = kid(n, 'mc:Choice') ?? kid(n, 'mc:Fallback')
          if (choice) this.inline(els(choice), segs)
          break
        }
        case 'w:commentRangeStart':
        case 'w:commentRangeEnd':
          break
        case 'w:pPr':
        case 'w:proofErr':
        case 'w:permStart':
        case 'w:permEnd':
        case null:
          break
        default:
          this.drops.add(`inline element ${name}`)
      }
    }
  }

  private run(r: XNode, segs: Seg[]): void {
    const style = this.textStyleName(kid(r, 'w:rPr'))
    let pending = ''
    const flush = (): void => {
      if (!pending) return
      this.add(
        segs,
        style ? `<text:span text:style-name="${esc(style)}">${pending}</text:span>` : pending,
      )
      pending = ''
    }
    const walk = (nodes: XNode[]): void => {
      for (const c of nodes) {
        const name = nodeName(c)
        if (name === 'mc:AlternateContent') {
          const choice = kid(c, 'mc:Choice') ?? kid(c, 'mc:Fallback')
          if (choice) walk(els(choice))
          continue
        }
        if (name === 'w:fldChar') {
          flush()
          this.fieldChar(attr(c, 'w:fldCharType'), segs)
          continue
        }
        if (name === 'w:instrText') {
          const field = this.fields[this.fields.length - 1]
          if (field && field.phase === 'instr')
            field.instr += nodeChildren(c)
              .map((t) => (t['#text'] as string) ?? '')
              .join('')
          continue
        }
        const f = this.fields[this.fields.length - 1]
        if (f && (f.phase === 'instr' || f.suppress)) continue
        switch (name) {
          case 'w:t': {
            const txt = nodeChildren(c)
              .map((t) => (typeof t['#text'] === 'string' ? decodeRefs(t['#text'] as string) : ''))
              .join('')
            pending += textContent(txt)
            break
          }
          case 'w:tab':
          case 'w:ptab':
            pending += '<text:tab/>'
            break
          case 'w:br':
          case 'w:cr': {
            const type = attr(c, 'w:type')
            if (type === 'page' || type === 'column') {
              flush()
              segs.push({ breakBefore: type, xml: '' })
            } else pending += '<text:line-break/>'
            break
          }
          case 'w:noBreakHyphen':
            pending += '‑'
            break
          case 'w:softHyphen':
            pending += '<text:soft-hyphen/>'
            break
          case 'w:drawing':
            pending += this.drawing(c)
            break
          case 'w:footnoteReference':
          case 'w:endnoteReference': {
            const kind = name === 'w:footnoteReference' ? 'footnote' : 'endnote'
            pending += this.note(kind, attr(c, 'w:id') ?? '')
            break
          }
          case 'w:commentReference':
            this.drops.add('comments')
            break
          case 'w:pict':
          case 'w:object':
            this.drops.add('VML pictures and embedded objects')
            break
          case 'w:sym':
            this.drops.add('symbol characters')
            break
          default:
            break
        }
      }
    }
    walk(els(r))
    flush()
  }

  private fieldChar(type: string | undefined, segs: Seg[]): void {
    if (type === 'begin') {
      this.fields.push({ instr: '', phase: 'instr', suppress: false, close: '' })
    } else if (type === 'separate') {
      const f = this.fields[this.fields.length - 1]
      if (!f) return
      f.phase = 'result'
      const instr = f.instr.trim()
      if (/^PAGE\b/i.test(instr)) {
        this.add(segs, '<text:page-number text:select-page="current">1</text:page-number>')
        f.suppress = true
      } else if (/^NUMPAGES\b/i.test(instr)) {
        this.add(segs, '<text:page-count>1</text:page-count>')
        f.suppress = true
      } else {
        const link = /^HYPERLINK\s+(?:\\l\s+)?"([^"]*)"/i.exec(instr)
        if (link) {
          const href = /\\l\s/i.test(instr) ? `#${link[1]}` : link[1]
          this.add(segs, `<text:a xlink:type="simple" xlink:href="${esc(href)}">`)
          f.close = '</text:a>'
        } else this.drops.add('field codes (cached result kept)')
      }
    } else if (type === 'end') {
      const f = this.fields.pop()
      if (f?.close) this.add(segs, f.close)
    }
  }

  private note(kind: 'footnote' | 'endnote', id: string): string {
    const n = this.notes[kind].get(id)
    if (!n) return ''
    const num = ++this.noteCounter[kind]
    const saved = this.countBlocks
    this.countBlocks = false
    const savedFields = this.fields
    this.fields = []
    const body = this.blocks(els(n)) || '<text:p/>'
    this.fields = savedFields
    this.countBlocks = saved
    return (
      `<text:note text:id="${kind === 'footnote' ? 'ftn' : 'edn'}${num}" text:note-class="${kind}">` +
      `<text:note-citation>${num}</text:note-citation><text:note-body>${body}</text:note-body></text:note>`
    )
  }

  // ---- images -----------------------------------------------------------------

  private findDesc(node: XNode, name: string): XNode | null {
    for (const c of els(node)) {
      if (nodeName(c) === name) return c
      const hit = this.findDesc(c, name)
      if (hit) return hit
    }
    return null
  }

  private drawing(d: XNode): string {
    const holder = kid(d, 'wp:inline') ?? kid(d, 'wp:anchor')
    const blip = this.findDesc(d, 'a:blip')
    if (!holder || !blip) {
      this.drops.add('drawings other than pictures (shapes, charts, text boxes)')
      return ''
    }
    const rid = attr(blip, 'r:embed')
    const rel = rid ? this.part.rels.get(rid) : undefined
    if (!rel || rel.external) {
      this.drops.add('linked or missing images')
      return ''
    }
    const path = normalizePath(
      rel.target.startsWith('/') ? rel.target : `${this.part.dir}/${rel.target}`,
    )
    const bytes = this.mediaBytes.get(path)
    if (!bytes) {
      this.drops.add('linked or missing images')
      return ''
    }
    const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? 'bin').toLowerCase()
    let name = this.mediaByPath.get(path)
    if (!name) {
      name = `${this.contentPart.reg.nextName('Pictures/image')}.${ext}`
      this.mediaByPath.set(path, name)
      this.media.push({
        name,
        mime: sniffImageMime(bytes, path) ?? MEDIA_MIME[ext] ?? 'application/octet-stream',
        bytes,
      })
    }
    if (nodeName(holder) === 'wp:anchor') this.drops.add('floating images (placed inline)')
    const crop = this.findDesc(d, 'a:srcRect')
    if (crop && ['l', 't', 'r', 'b'].some((k) => (num(attr(crop, k)) ?? 0) !== 0))
      this.drops.add('image cropping')
    const ext2 = kid(holder, 'wp:extent')
    const cx = num(ext2 && attr(ext2, 'cx'))
    const cy = num(ext2 && attr(ext2, 'cy'))
    if (cx === null || cy === null) {
      this.drops.add('images without a size')
      return ''
    }
    const docPr = kid(holder, 'wp:docPr')
    const alt = docPr ? attr(docPr, 'descr') : undefined
    const style = this.part.reg.add(
      'graphic',
      'fr',
      '<style:graphic-properties style:wrap="none" style:vertical-pos="top" style:vertical-rel="baseline"/>',
    )
    return (
      `<draw:frame draw:style-name="${style}" draw:name="${this.contentPart.reg.nextName('Image')}" text:anchor-type="as-char" svg:width="${cm(cx)}" svg:height="${cm(cy)}">` +
      `<draw:image xlink:href="${name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>` +
      (alt ? `<svg:desc>${esc(alt)}</svg:desc>` : '') +
      '</draw:frame>'
    )
  }

  // ---- tables ----------------------------------------------------------------------

  private tableBorders(tblPr: XNode | null, styleId: string | undefined): Record<string, string> {
    const out: Record<string, string> = {}
    const sources: Array<XNode | null> = [
      ...this.chain(styleId)
        .reverse()
        .map((s) => kid(s.tblPr, 'w:tblBorders')),
      kid(tblPr, 'w:tblBorders'),
    ]
    for (const src of sources) {
      if (!src) continue
      for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
        const b = this.border(kid(src, `w:${side}`))
        if (b) out[side] = b
      }
    }
    return out
  }

  private table(tbl: XNode): string {
    if (this.countBlocks) this.blockCount++
    const reg = this.part.reg
    const tblPr = kid(tbl, 'w:tblPr')
    const styleId = wv(kid(tblPr, 'w:tblStyle'))
    if (this.chain(styleId).some((s) => s.hasConditional))
      this.drops.add('table style conditional formatting')
    const borders = this.tableBorders(tblPr, styleId)

    const trs = els(tbl).filter((c) => nodeName(c) === 'w:tr')
    const grid: number[] = []
    for (const g of els(kid(tbl, 'w:tblGrid') ?? tbl)) {
      if (nodeName(g) === 'w:gridCol') grid.push(num(attr(g, 'w:w')) ?? 0)
    }
    type Cell = { tc: XNode; col: number; span: number; vm: 'restart' | 'continue' | null }
    const rows: Cell[][] = trs.map((tr) => {
      let col = num(wv(kid(kid(tr, 'w:trPr'), 'w:gridBefore'))) ?? 0
      const cells: Cell[] = []
      for (const tc of els(tr)) {
        if (nodeName(tc) !== 'w:tc') continue
        const tcPr = kid(tc, 'w:tcPr')
        const span = Math.max(num(wv(kid(tcPr, 'w:gridSpan'))) ?? 1, 1)
        const vmEl = kid(tcPr, 'w:vMerge')
        const vm = vmEl ? (wv(vmEl) === 'restart' ? 'restart' : 'continue') : null
        cells.push({ tc, col, span, vm })
        col += span
      }
      return cells
    })
    const cols = Math.max(
      grid.length,
      ...rows.map((r) => (r.length ? r[r.length - 1].col + r[r.length - 1].span : 0)),
      1,
    )
    while (grid.length < cols) grid.push(Math.round(this.contentWidthTw / cols))
    const gridSum = grid.reduce((a, b) => a + b, 0)

    const tblW = kid(tblPr, 'w:tblW')
    let width = gridSum
    if (tblW && attr(tblW, 'w:type') === 'pct') {
      const pct = num(attr(tblW, 'w:w'))
      if (pct !== null) width = Math.round((this.contentWidthTw * pct) / 5000)
    } else if (tblW && attr(tblW, 'w:type') === 'dxa') {
      width = num(attr(tblW, 'w:w')) ?? gridSum
    }
    const jc = wv(kid(tblPr, 'w:jc'))
    const ind = num(attr(kid(tblPr, 'w:tblInd') ?? ({} as XNode), 'w:w')) ?? 0
    const tableStyle = reg.add(
      'table',
      'Tbl',
      propsEl('style:table-properties', {
        'style:width': inch(width),
        'table:align':
          jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left',
        ...(jc === 'center' || jc === 'right' || jc === 'end'
          ? {}
          : { 'fo:margin-left': inch(ind) }),
      }),
    )
    const name = this.contentPart.reg.nextName('Table')
    let out = `<table:table table:name="${name}" table:style-name="${tableStyle}">`
    grid.forEach((w) => {
      const cs = reg.add(
        'table-column',
        'Col',
        propsEl('style:table-column-properties', { 'style:column-width': inch(w) }),
      )
      out += `<table:table-column table:style-name="${cs}"/>`
    })

    const mar = kid(tblPr, 'w:tblCellMar')
    const pad = (side: string, dflt: number): string =>
      inch(num(attr(kid(mar, `w:${side}`) ?? ({} as XNode), 'w:w')) ?? dflt)
    let headerOpen = false
    rows.forEach((cells, ri) => {
      const trPr = kid(trs[ri], 'w:trPr')
      const isHeader = !!kid(trPr, 'w:tblHeader')
      if (isHeader && !headerOpen && ri === 0) {
        out += '<table:table-header-rows>'
        headerOpen = true
      }
      if (!isHeader && headerOpen) {
        out += '</table:table-header-rows>'
        headerOpen = false
      }
      const trH = kid(trPr, 'w:trHeight')
      const h = num(trH && attr(trH, 'w:val'))
      const rowStyle =
        h !== null
          ? reg.add(
              'table-row',
              'Row',
              propsEl('style:table-row-properties', {
                [attr(trH!, 'w:hRule') === 'exact' ? 'style:row-height' : 'style:min-row-height']:
                  inch(h),
              }),
            )
          : null
      out += `<table:table-row${rowStyle ? ` table:style-name="${rowStyle}"` : ''}>`
      const before = num(wv(kid(trPr, 'w:gridBefore'))) ?? 0
      for (let i = 0; i < before; i++)
        out += '<table:table-cell office:value-type="string"><text:p/></table:table-cell>'
      for (const c of cells) {
        if (c.vm === 'continue') {
          for (let i = 0; i < c.span; i++) out += '<table:covered-table-cell/>'
          continue
        }
        let rowSpan = 1
        if (c.vm === 'restart') {
          for (let r2 = ri + 1; r2 < rows.length; r2++) {
            const below = rows[r2].find((x) => x.col === c.col)
            if (below?.vm !== 'continue') break
            rowSpan++
          }
        }
        const tcPr = kid(c.tc, 'w:tcPr')
        const cellAttrs: Attrs = {
          'fo:padding-left': pad('left', 108),
          'fo:padding-right': pad('right', 108),
          'fo:padding-top': pad('top', 0),
          'fo:padding-bottom': pad('bottom', 0),
        }
        const cb = kid(tcPr, 'w:tcBorders')
        const lastCol = c.col + c.span >= cols
        const edge: Record<string, boolean> = {
          top: ri === 0,
          bottom: ri === rows.length - 1,
          left: c.col === 0,
          right: lastCol,
        }
        for (const side of ['top', 'bottom', 'left', 'right']) {
          const own = this.border(kid(cb, `w:${side}`))
          const inherited = borders[side] && edge[side] ? borders[side] : undefined
          const inside = side === 'top' || side === 'bottom' ? borders.insideH : borders.insideV
          const b = own ?? (edge[side] ? inherited : inside)
          if (b) cellAttrs[`fo:border-${side}`] = b
        }
        const fill = attr(kid(tcPr, 'w:shd') ?? ({} as XNode), 'w:fill')
        if (fill && /^[0-9A-Fa-f]{6}$/.test(fill))
          cellAttrs['fo:background-color'] = `#${fill.toUpperCase()}`
        const va = wv(kid(tcPr, 'w:vAlign'))
        if (va)
          cellAttrs['style:vertical-align'] =
            va === 'center' ? 'middle' : va === 'bottom' ? 'bottom' : 'top'
        const cellStyle = reg.add(
          'table-cell',
          'Cell',
          propsEl('style:table-cell-properties', cellAttrs),
        )
        const inner = this.blocks(els(c.tc)) || '<text:p/>'
        out +=
          `<table:table-cell table:style-name="${cellStyle}" office:value-type="string"` +
          `${c.span > 1 ? ` table:number-columns-spanned="${c.span}"` : ''}${rowSpan > 1 ? ` table:number-rows-spanned="${rowSpan}"` : ''}>` +
          `${inner}</table:table-cell>`
        for (let i = 1; i < c.span; i++) out += '<table:covered-table-cell/>'
      }
      out += '</table:table-row>'
    })
    if (headerOpen) out += '</table:table-header-rows>'
    return `${out}</table:table>`
  }

  // ---- named styles / page layout ----------------------------------------------------

  namedStylesXml(): string {
    let out = ''
    const dd = this.docDefaults
    const ddP = this.paraStyleBody(dd.pPr)
    const ddT = propsEl('style:text-properties', this.textAttrs(dd.rPr))
    out += `<style:default-style style:family="paragraph">${ddP}${ddT}</style:default-style>`
    // Standard always exists: it is where paragraphs without a style land
    const stdDef = [...this.styles.values()].find((s) => s.type === 'paragraph' && s.isDefault)
    if (stdDef) this.usedStyles.set(stdDef.id, 'Standard')
    else out += '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>'
    return out + this.usedNamedStylesXml(new Set())
  }

  /** the used docx styles as ODF common styles, minus the names in `existing` */
  usedNamedStylesXml(existing: ReadonlySet<string>): string {
    let out = ''
    // emitting a style may use further styles (via rStyle in nothing — safe), so snapshot
    for (const [id, name] of [...this.usedStyles]) {
      const def = this.styles.get(id)
      if (!def || existing.has(name)) continue
      const family = def.type === 'character' ? 'text' : 'paragraph'
      const parent = def.basedOn ? this.usedStyles.get(def.basedOn) : undefined
      const level = /^Heading_20_(\d)$/.exec(name)?.[1]
      const display = name === 'Standard' ? '' : ` style:display-name="${esc(def.name)}"`
      const body =
        (family === 'paragraph' ? this.paraStyleBody(def.pPr) : '') +
        propsEl('style:text-properties', this.textAttrs(def.rPr))
      out +=
        `<style:style style:name="${esc(name)}" style:family="${family}"${display}` +
        `${parent && parent !== name ? ` style:parent-style-name="${esc(parent)}"` : ''}` +
        `${level && family === 'paragraph' ? ` style:default-outline-level="${level}"` : ''}` +
        `${family === 'paragraph' ? ' style:class="text"' : ''}>${body}</style:style>`
    }
    return out
  }
}

// -- package assembly ---------------------------------------------------------------------

/**
 * A docx loaded into a Converter (styles, numbering, notes, body rels, media),
 * plus its parsed w:body. `reserved` names (style, frame, table names and
 * package paths) are never handed out — odt-patch passes the original
 * package's so generated names cannot collide with ones already there.
 */
export async function loadDocxConverter(
  docx: Uint8Array,
  reserved?: ReadonlySet<string>,
): Promise<{ c: Converter; body: XNode }> {
  const zip = await JSZip.loadAsync(docx)
  const docXml = await zip.file('word/document.xml')?.async('string')
  if (!docXml) throw new Error('not a docx: word/document.xml is missing')
  const tree = parseOdfXml(docXml)
  const body = kid(tree?.find((n) => nodeName(n) === 'w:document') ?? null, 'w:body')
  if (!body) throw new Error('not a docx: word/document.xml has no body')

  const mediaBytes = new Map<string, Uint8Array>()
  for (const path of Object.keys(zip.files)) {
    if (/^word\/media\/[^/]+$/.test(path))
      mediaBytes.set(path, await zip.files[path].async('uint8array'))
  }
  const c = new Converter(zip, mediaBytes, reserved)
  await c.loadStyles()
  await c.loadNumbering()
  await c.loadNotes()
  c.contentPart.rels = parseRels(await c.readText('word/_rels/document.xml.rels'))
  return { c, body }
}

export async function convertDocxToOdt(docx: Uint8Array): Promise<DocxToOdtResult> {
  const { c, body } = await loadDocxConverter(docx)

  // -- page layout from the final section -------------------------------------
  const sectPr = [...els(body)].reverse().find((n) => nodeName(n) === 'w:sectPr') ?? null
  let pgW = 11906
  let pgH = 16838
  let landscape = false
  const mar = { top: 1440, bottom: 1440, left: 1440, right: 1440, header: 720, footer: 720 }
  if (sectPr) {
    const sz = kid(sectPr, 'w:pgSz')
    if (sz) {
      pgW = num(attr(sz, 'w:w')) ?? pgW
      pgH = num(attr(sz, 'w:h')) ?? pgH
      landscape = attr(sz, 'w:orient') === 'landscape'
    }
    const m = kid(sectPr, 'w:pgMar')
    if (m) {
      for (const k of Object.keys(mar) as Array<keyof typeof mar>)
        mar[k] = num(attr(m, `w:${k}`)) ?? mar[k]
    }
    if ((num(attr(kid(sectPr, 'w:cols') ?? ({} as XNode), 'w:num')) ?? 1) > 1)
      c.drops.add('multi-column sections')
    if (kid(sectPr, 'w:pgBorders')) c.drops.add('page borders')
    if (kid(sectPr, 'w:titlePg')) c.drops.add('different first-page header/footer')
  }
  const midSections = els(body).filter(
    (n) => nodeName(n) === 'w:p' && kid(kid(n, 'w:pPr'), 'w:sectPr'),
  ).length
  for (let i = 0; i < midSections; i++)
    c.drops.add('section breaks (final section layout applied to all)')
  c.contentWidthTw = Math.max(pgW - mar.left - mar.right, 720)

  // -- body ---------------------------------------------------------------------
  const bodyXml = c.blocks(els(body))
  const contentReg = c.contentPart.reg

  // -- headers / footers (default type only) ----------------------------------------
  const hf: Record<'header' | 'footer', string> = { header: '', footer: '' }
  if (sectPr) {
    for (const kind of ['header', 'footer'] as const) {
      const refs = els(sectPr).filter((n) => nodeName(n) === `w:${kind}Reference`)
      for (const ref of refs) {
        const type = attr(ref, 'w:type') ?? 'default'
        if (type !== 'default') {
          if (type === 'even') c.drops.add('even-page headers/footers')
          continue
        }
        const rel = c.contentPart.rels.get(attr(ref, 'r:id') ?? '')
        if (!rel) continue
        const path = normalizePath(`word/${rel.target}`)
        const partTree = parseOdfXml((await c.readText(path)) ?? '')
        const root = partTree?.find((n) => nodeName(n) === (kind === 'header' ? 'w:hdr' : 'w:ftr'))
        if (!root) continue
        const relsPath = `word/_rels/${path.split('/').pop()}.rels`
        c.part = {
          reg: c.stylesPart.reg,
          rels: parseRels(await c.readText(relsPath)),
          dir: 'word',
        }
        c.countBlocks = false
        hf[kind] = c.blocks(els(root))
        c.countBlocks = true
        c.part = c.contentPart
      }
    }
  }

  // -- page layout / master page -----------------------------------------------------------
  const hasH = !!hf.header
  const hasF = !!hf.footer
  const layoutAttrs: Attrs = {
    'fo:page-width': inch(landscape && pgW < pgH ? pgH : pgW),
    'fo:page-height': inch(landscape && pgW < pgH ? pgW : pgH),
    'style:print-orientation': landscape ? 'landscape' : 'portrait',
    'fo:margin-left': inch(mar.left),
    'fo:margin-right': inch(mar.right),
    'fo:margin-top': inch(hasH ? mar.header : mar.top),
    'fo:margin-bottom': inch(hasF ? mar.footer : mar.bottom),
  }
  const hfStyle = (tag: string, h: number, edge: number): string =>
    `<style:${tag}><style:header-footer-properties fo:min-height="${inch(Math.max(h - edge, 0))}" fo:margin-${tag === 'header-style' ? 'bottom' : 'top'}="0in"/></style:${tag}>`
  const pageLayout =
    `<style:page-layout style:name="pm1"><style:page-layout-properties${attrString(layoutAttrs)}/>` +
    (hasH ? hfStyle('header-style', mar.top, mar.header) : '<style:header-style/>') +
    (hasF ? hfStyle('footer-style', mar.bottom, mar.footer) : '<style:footer-style/>') +
    '</style:page-layout>'
  const master =
    '<style:master-page style:name="Standard" style:page-layout-name="pm1">' +
    (hasH ? `<style:header>${hf.header}</style:header>` : '') +
    (hasF ? `<style:footer>${hf.footer}</style:footer>` : '') +
    '</style:master-page>'

  const header = '<?xml version="1.0" encoding="UTF-8"?>\n'
  const contentXml =
    `${header}<office:document-content ${NS} office:version="1.3">` +
    `<office:automatic-styles>${contentReg.xml.join('')}</office:automatic-styles>` +
    `<office:body><office:text>${bodyXml}</office:text></office:body></office:document-content>`
  const stylesXml =
    `${header}<office:document-styles ${NS} office:version="1.3">` +
    `<office:styles>${c.namedStylesXml()}</office:styles>` +
    `<office:automatic-styles>${pageLayout}${c.stylesPart.reg.xml.join('')}</office:automatic-styles>` +
    `<office:master-styles>${master}</office:master-styles></office:document-styles>`

  const core = (await c.readText('docProps/core.xml')) ?? ''
  const title = /<dc:title>([^<]*)<\/dc:title>/.exec(core)?.[1]
  const creator = /<dc:creator>([^<]*)<\/dc:creator>/.exec(core)?.[1]
  const metaXml =
    `${header}<office:document-meta ${NS} office:version="1.3"><office:meta>` +
    '<meta:generator>SelfOffice odf2ooxml</meta:generator>' +
    (title ? `<dc:title>${title}</dc:title>` : '') +
    (creator ? `<meta:initial-creator>${creator}</meta:initial-creator>` : '') +
    '</office:meta></office:document-meta>'

  const manifest =
    `${header}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIMETYPE}"/>` +
    ['content.xml', 'styles.xml', 'meta.xml']
      .map((p) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="text/xml"/>`)
      .join('') +
    c.media
      .map(
        (m) =>
          `<manifest:file-entry manifest:full-path="${m.name}" manifest:media-type="${m.mime}"/>`,
      )
      .join('') +
    '</manifest:manifest>'

  const out = new JSZip()
  // the mimetype entry must come first and stay uncompressed
  out.file('mimetype', MIMETYPE, { compression: 'STORE' })
  out.file('META-INF/manifest.xml', manifest)
  out.file('content.xml', contentXml)
  out.file('styles.xml', stylesXml)
  out.file('meta.xml', metaXml)
  for (const m of c.media) out.file(m.name, m.bytes, { binary: true })
  const odt = await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { odt, blocks: c.blockCount, dropped: c.drops.list().map((d) => `${d.what} (${d.count})`) }
}
