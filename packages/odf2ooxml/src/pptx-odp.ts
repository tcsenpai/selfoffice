/**
 * .pptx → .odp export filter. The deck is parsed straight from the OOXML
 * parts (no engine model) and rebuilt as an ODF 1.3 presentation: one
 * draw:page per slide on a single master page at the real slide size.
 * Placeholder geometry/background/text defaults are resolved through
 * slide → layout → master (+ theme); master/layout decorations are painted onto
 * each slide. Same rule as the import side: anything that cannot be converted
 * provably-correct is reported in `dropped`, never silently approximated.
 */

import JSZip from 'jszip'
import { escapeXmlAttr, escapeXmlText } from '../../pptx-engine/src/index'
import { assertZipWithinLimits, relsPathFor, resolveTarget } from '../../pptx-engine/src/zip'
import { OdfConvertError } from './odf'
import { XNode, attr, firstChild, nodeChildren, nodeName, parseOdfXml, textOfNode } from './xml'

export interface PptxToOdpResult {
  odp: Uint8Array
  slides: number
  dropped: string[]
}

export const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
  ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"' +
  ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
  ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"' +
  ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"' +
  ' xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"' +
  ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
  ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"' +
  ' xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"' +
  ' xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"'

const ODP_MIME = 'application/vnd.oasis.opendocument.presentation'
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
}
const PRST_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
}
const NUM_FORMATS: Record<string, [string, string, string]> = {
  arabicPeriod: ['1', '', '.'],
  arabicParenR: ['1', '', ')'],
  arabicParenBoth: ['1', '(', ')'],
  arabicPlain: ['1', '', ''],
  alphaLcPeriod: ['a', '', '.'],
  alphaUcPeriod: ['A', '', '.'],
  alphaLcParenR: ['a', '', ')'],
  alphaUcParenR: ['A', '', ')'],
  romanLcPeriod: ['i', '', '.'],
  romanUcPeriod: ['I', '', '.'],
}
/** symbol fonts whose bullet glyphs have no portable Unicode equivalent */
const SYMBOL_FONT = /^(wingdings|symbol|webdings)/i

// ---------- XML helpers ----------

const kids = (n: XNode | null | undefined, name?: string): XNode[] =>
  n ? nodeChildren(n).filter((c) => nodeName(c) !== null && (!name || nodeName(c) === name)) : []

function kid(n: XNode | null | undefined, ...names: string[]): XNode | null {
  let cur: XNode | null = n ?? null
  for (const name of names) cur = cur ? firstChild(cur, name) : null
  return cur
}

const val = (n: XNode | null | undefined, name = 'val'): string | undefined =>
  n ? attr(n, name) : undefined

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s === '') return undefined
  const v = Number(s)
  return Number.isFinite(v) ? v : undefined
}

const bool = (s: string | undefined): boolean | undefined =>
  s === undefined ? undefined : s === '1' || s === 'true'

function deepHas(n: XNode, name: string): boolean {
  return kids(n).some((c) => nodeName(c) === name || deepHas(c, name))
}

const cm = (emu: number): string => `${+(emu / 360_000).toFixed(3)}cm`
const pt = (v: number): string => `${+v.toFixed(2)}pt`
const rootOf = (xml: string): XNode | null => {
  const parsed = parseOdfXml(xml)
  return parsed?.find((n) => nodeName(n) !== null) ?? null
}

// ---------- package, rels, theme ----------

interface Rel {
  type: string
  target: string
  external: boolean
}
export interface Part {
  path: string
  root: XNode
  rels: Map<string, Rel>
}
export interface Theme {
  colors: Record<string, string>
  major?: string
  minor?: string
  lnWidths: number[]
  fillKinds: string[]
  bgKinds: string[]
}
interface Env {
  theme: Theme
  clrMap: Record<string, string>
  master: Part | null
  presentation: XNode
  doc: Doc
}

export class Pkg {
  private parts = new Map<string, Part | null>()
  constructor(readonly zip: JSZip) {}

  async part(path: string): Promise<Part | null> {
    if (this.parts.has(path)) return this.parts.get(path) ?? null
    const xml = await this.zip.file(path)?.async('string')
    const root = xml ? rootOf(xml) : null
    let part: Part | null = null
    if (root) {
      const rels = new Map<string, Rel>()
      const relXml = await this.zip.file(relsPathFor(path))?.async('string')
      const relRoot = relXml ? rootOf(relXml) : null
      for (const r of kids(relRoot, 'Relationship')) {
        const external = val(r, 'TargetMode') === 'External'
        const target = val(r, 'Target') ?? ''
        rels.set(val(r, 'Id') ?? '', {
          type: val(r, 'Type') ?? '',
          target: external ? target : resolveTarget(path, target),
          external,
        })
      }
      part = { path, root, rels }
    }
    this.parts.set(path, part)
    return part
  }

  async bytes(path: string): Promise<Uint8Array | null> {
    const entry = this.zip.file(path)
    return entry ? entry.async('uint8array') : null
  }
}

export const relOfType = (part: Part, suffix: string): Rel | undefined =>
  [...part.rels.values()].find((r) => r.type.endsWith(suffix))

function parseTheme(root: XNode | null): Theme {
  const theme: Theme = { colors: {}, lnWidths: [], fillKinds: [], bgKinds: [] }
  const elements = kid(root, 'a:themeElements')
  for (const c of kids(kid(elements, 'a:clrScheme'))) {
    const inner = kids(c)[0]
    const hex = inner ? (val(inner, 'lastClr') ?? val(inner)) : undefined
    if (hex) theme.colors[(nodeName(c) ?? '').replace('a:', '')] = hex.toUpperCase()
  }
  const fonts = kid(elements, 'a:fontScheme')
  theme.major = val(kid(fonts, 'a:majorFont', 'a:latin'), 'typeface')
  theme.minor = val(kid(fonts, 'a:minorFont', 'a:latin'), 'typeface')
  const fmt = kid(elements, 'a:fmtScheme')
  theme.lnWidths = kids(kid(fmt, 'a:lnStyleLst'), 'a:ln').map((l) => num(val(l, 'w')) ?? 12700)
  theme.fillKinds = kids(kid(fmt, 'a:fillStyleLst')).map((f) => nodeName(f) ?? '')
  theme.bgKinds = kids(kid(fmt, 'a:bgFillStyleLst')).map((f) => nodeName(f) ?? '')
  return theme
}

// ---------- ODF output registry ----------

export class Doc {
  readonly auto: string[] = []
  readonly fillImages: string[] = []
  readonly pictures = new Map<string, string>()
  readonly pictureFiles: Array<{ name: string; bytes: Uint8Array; ext: string }> = []
  private names = new Map<string, string>()
  private counters: Record<string, number> = {}
  private drops = new Map<string, number>()

  /** `reserved`: style names / package paths already taken by the file being patched */
  constructor(private readonly reserved: ReadonlySet<string> = new Set()) {}

  private nextName(prefix: string, suffix = ''): string {
    let name: string
    do {
      this.counters[prefix] = (this.counters[prefix] ?? 0) + 1
      name = `${prefix}${this.counters[prefix]}${suffix}`
    } while (this.reserved.has(name))
    return name
  }

  /** a fresh `draw:fill-image` name */
  fillImageName(): string {
    return this.nextName('bg')
  }

  drop(kind: string): void {
    this.drops.set(kind, (this.drops.get(kind) ?? 0) + 1)
  }
  dropped(): string[] {
    return [...this.drops].map(([kind, count]) => `${kind} x${count}`)
  }

  /** deduplicated automatic `<style:style>`; returns its name */
  style(prefix: string, family: string, inner: string, extra = ''): string {
    return this.register(
      prefix,
      `${family}|${extra}|${inner}`,
      (name) =>
        `<style:style style:name="${name}" style:family="${family}"${extra}>${inner}</style:style>`,
    )
  }

  /** deduplicated automatic `<text:list-style>` */
  listStyle(inner: string): string {
    return this.register(
      'L',
      inner,
      (name) => `<text:list-style style:name="${name}">${inner}</text:list-style>`,
    )
  }

  private register(prefix: string, key: string, build: (name: string) => string): string {
    const full = prefix + key
    let name = this.names.get(full)
    if (!name) {
      name = this.nextName(prefix)
      this.names.set(full, name)
      this.auto.push(build(name))
    }
    return name
  }

  /** copy an image part into Pictures/ once; returns its ODF href or null */
  async picture(pkg: Pkg, abs: string): Promise<string | null> {
    const known = this.pictures.get(abs)
    if (known) return known
    const ext = (abs.split('.').pop() ?? '').toLowerCase()
    const bytes = await pkg.bytes(abs)
    if (!bytes || bytes.length === 0 || !IMAGE_MIME[ext]) return null
    const name = this.nextName('Pictures/img', `.${ext}`)
    this.pictureFiles.push({ name, bytes, ext })
    this.pictures.set(abs, name)
    return name
  }
}

// ---------- colors ----------

interface Color {
  hex: string
  alpha?: number
}

function lumTransform(hex: string, mod: number, off: number): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  l = Math.min(1, Math.max(0, l * mod + off))
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const chan = (t0: number): number => {
    const t = (t0 + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const rgb = s === 0 ? [l, l, l] : [chan(h + 1 / 3), chan(h), chan(h - 1 / 3)]
  return rgb
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()
}

/** first color child (srgb/scheme/sys/prst) of `parent`, transforms applied */
function colorOf(parent: XNode | null, env: Env): Color | null {
  for (const c of kids(parent)) {
    const name = nodeName(c)
    let hex: string | undefined
    if (name === 'a:srgbClr') hex = val(c)
    else if (name === 'a:schemeClr') {
      const v = val(c) ?? ''
      hex = env.theme.colors[env.clrMap[v] ?? v]
    } else if (name === 'a:sysClr') hex = val(c, 'lastClr')
    else if (name === 'a:prstClr') hex = PRST_COLORS[val(c) ?? '']
    else continue
    if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) {
      env.doc.drop('unresolved-colors')
      return null
    }
    hex = hex.toUpperCase()
    let alpha: number | undefined
    let lumMod = 1
    let lumOff = 0
    for (const t of kids(c)) {
      const v = num(val(t)) ?? 0
      const tn = nodeName(t)
      if (tn === 'a:alpha') alpha = v / 100_000
      else if (tn === 'a:lumMod') lumMod = v / 100_000
      else if (tn === 'a:lumOff') lumOff = v / 100_000
      else env.doc.drop('color-transforms')
    }
    if (lumMod !== 1 || lumOff !== 0) hex = lumTransform(hex, lumMod, lumOff)
    return { hex, alpha }
  }
  return null
}

// ---------- text ----------

interface RPr {
  sz?: number
  b?: boolean
  i?: boolean
  u?: string
  strike?: string
  baseline?: number
  cap?: string
  color?: Color
  font?: string
}
type Bullet =
  { kind: 'none' } | { kind: 'char'; char: string } | { kind: 'num'; type: string; start: number }
interface PProps {
  algn?: string
  marL?: number
  indent?: number
  bullet?: Bullet
  spcBef?: number
  spcAft?: number
  lnSpcPct?: number
}

function themeFont(face: string | undefined, env: Env): string | undefined {
  if (!face) return undefined
  if (face.startsWith('+mj-lt')) return env.theme.major
  if (face.startsWith('+mn-lt')) return env.theme.minor
  return face.startsWith('+') ? undefined : face
}

function rprOf(n: XNode | null, env: Env): RPr {
  const o: RPr = {}
  if (!n) return o
  const sz = num(val(n, 'sz'))
  if (sz !== undefined) o.sz = sz
  const b = bool(val(n, 'b'))
  if (b !== undefined) o.b = b
  const i = bool(val(n, 'i'))
  if (i !== undefined) o.i = i
  const u = val(n, 'u')
  if (u) o.u = u
  const strike = val(n, 'strike')
  if (strike) o.strike = strike
  const baseline = num(val(n, 'baseline'))
  if (baseline !== undefined) o.baseline = baseline
  const cap = val(n, 'cap')
  if (cap) o.cap = cap
  const color = colorOf(kid(n, 'a:solidFill'), env)
  if (color) o.color = color
  const font = themeFont(val(kid(n, 'a:latin'), 'typeface'), env)
  if (font) o.font = font
  return o
}

function pPropsOf(n: XNode | null, env: Env): PProps {
  const o: PProps = {}
  if (!n) return o
  const algn = val(n, 'algn')
  if (algn) o.algn = algn
  const marL = num(val(n, 'marL'))
  if (marL !== undefined) o.marL = marL
  const indent = num(val(n, 'indent'))
  if (indent !== undefined) o.indent = indent
  if (kid(n, 'a:buNone')) o.bullet = { kind: 'none' }
  const char = val(kid(n, 'a:buChar'), 'char')
  if (char) {
    const face = val(kid(n, 'a:buFont'), 'typeface') ?? ''
    if (SYMBOL_FONT.test(face)) env.doc.drop('symbol-font-bullets')
    o.bullet = { kind: 'char', char: SYMBOL_FONT.test(face) ? '•' : char }
  }
  const auto = kid(n, 'a:buAutoNum')
  if (auto)
    o.bullet = {
      kind: 'num',
      type: val(auto, 'type') ?? 'arabicPeriod',
      start: num(val(auto, 'startAt')) ?? 1,
    }
  const spacing = (name: string): number | undefined => {
    const holder = kid(n, name)
    if (!holder) return undefined
    const pts = num(val(kid(holder, 'a:spcPts')))
    if (pts !== undefined) return pts / 100
    if (kid(holder, 'a:spcPct')) env.doc.drop('percent-spacing')
    return undefined
  }
  o.spcBef = spacing('a:spcBef')
  o.spcAft = spacing('a:spcAft')
  const ln = num(val(kid(n, 'a:lnSpc', 'a:spcPct')))
  if (ln !== undefined) o.lnSpcPct = ln / 1000
  return o
}

/** first-defined-wins merge across an inheritance chain (highest priority first) */
function mergeChain<T extends object>(chain: T[]): T {
  const out: Record<string, unknown> = {}
  for (const link of chain) {
    for (const [k, v] of Object.entries(link))
      if (v !== undefined && out[k] === undefined) out[k] = v
  }
  return out as T
}

interface TextCtx {
  /** lstStyle nodes: shape, layout placeholder, master placeholder */
  lst: Array<XNode | null>
  /** master txStyles list (title/body/other style) */
  txStyle: XNode | null
  env: Env
  rels: Map<string, Rel>
  fontColor?: Color | null
}

const lvlNode = (list: XNode | null, lvl: number): XNode | null => kid(list, `a:lvl${lvl + 1}pPr`)

const esc = escapeXmlText
const escA = escapeXmlAttr

function odfText(s: string): string {
  return esc(s)
    .replace(/\t/g, '<text:tab/>')
    .replace(/^ | $| {2,}/g, (m) => `<text:s text:c="${m.length}"/>`)
}

function textStyleXml(r: RPr): string {
  const a: string[] = []
  if (r.sz !== undefined) a.push(`fo:font-size="${pt(r.sz / 100)}"`)
  if (r.font) a.push(`fo:font-family="${escA(r.font)}"`)
  if (r.b !== undefined) a.push(`fo:font-weight="${r.b ? 'bold' : 'normal'}"`)
  if (r.i !== undefined) a.push(`fo:font-style="${r.i ? 'italic' : 'normal'}"`)
  if (r.u === 'sng')
    a.push(
      'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"',
    )
  else if (r.u === 'dbl')
    a.push(
      'style:text-underline-style="solid" style:text-underline-type="double" style:text-underline-width="auto" style:text-underline-color="font-color"',
    )
  if (r.strike === 'sngStrike') a.push('style:text-line-through-style="solid"')
  else if (r.strike === 'dblStrike')
    a.push('style:text-line-through-style="solid" style:text-line-through-type="double"')
  if (r.baseline) a.push(`style:text-position="${r.baseline / 1000}% 58%"`)
  if (r.cap === 'all') a.push('fo:text-transform="uppercase"')
  else if (r.cap === 'small') a.push('fo:font-variant="small-caps"')
  if (r.color) a.push(`fo:color="#${r.color.hex}"`)
  return a.length ? `<style:text-properties ${a.join(' ')}/>` : ''
}

function listLevels(bullet: Bullet, marL: number, indent: number): string {
  // legacy space-before/min-label-width: LibreOffice ignores the newer
  // label-alignment form when the paragraph style sets no margins
  const label = Math.max(0, marL + Math.min(indent, 0))
  const align = `<style:list-level-properties text:space-before="${cm(label)}" text:min-label-width="${cm(Math.max(0, -indent))}"/>`
  let out = ''
  for (let level = 1; level <= 10; level++) {
    if (bullet.kind === 'char') {
      out += `<text:list-level-style-bullet text:level="${level}" text:bullet-char="${escA(bullet.char)}" text:bullet-relative-size="100%">${align}</text:list-level-style-bullet>`
    } else if (bullet.kind === 'num') {
      const [format, prefix, suffix] = NUM_FORMATS[bullet.type] ?? NUM_FORMATS.arabicPeriod!
      out += `<text:list-level-style-number text:level="${level}" style:num-format="${format}"${prefix ? ` style:num-prefix="${prefix}"` : ''}${suffix ? ` style:num-suffix="${suffix}"` : ''} text:start-value="${bullet.start}">${align}</text:list-level-style-number>`
    }
  }
  return out
}

/** `a:p` list of a txBody → ODF paragraphs (bulleted ones wrapped in text:list) */
function paragraphsXml(txBody: XNode | null, t: TextCtx): string {
  const { env } = t
  const doc = env.doc
  let out = ''
  let prevNumKey = ''
  for (const p of kids(txBody, 'a:p')) {
    const pPr = kid(p, 'a:pPr')
    const lvl = Math.min(8, Math.max(0, num(val(pPr, 'lvl')) ?? 0))
    const links: Array<XNode | null> = [
      pPr,
      ...t.lst.map((l) => lvlNode(l, lvl)),
      lvlNode(t.txStyle, lvl),
      lvlNode(kid(env.presentation, 'p:defaultTextStyle'), lvl),
    ]
    const props = mergeChain(links.map((l) => pPropsOf(l, env)))
    const defRprs = links.map((l) => rprOf(kid(l, 'a:defRPr'), env))
    // the shape's p:style fontRef beats layout/master defaults, not its own lstStyle
    if (t.fontColor) defRprs.splice(2, 0, { color: t.fontColor })
    const bullet = props.bullet && props.bullet.kind !== 'none' ? props.bullet : undefined

    // runs
    let inner = ''
    for (const c of kids(p)) {
      const name = nodeName(c)
      if (name === 'a:br') {
        inner += '<text:line-break/>'
        continue
      }
      if (name !== 'a:r' && name !== 'a:fld') continue
      const text = kids(c, 'a:t').map(textOfNode).join('')
      if (!text) continue
      const rpr = mergeChain([rprOf(kid(c, 'a:rPr'), env), ...defRprs])
      const styleXml = textStyleXml(rpr)
      let body =
        name === 'a:fld' && val(c, 'type') === 'slidenum'
          ? `<text:page-number text:select-page="current">${esc(text)}</text:page-number>`
          : odfText(text)
      const link = kid(c, 'a:rPr', 'a:hlinkClick')
      if (link) {
        const rel = t.rels.get(val(link, 'r:id') ?? '')
        if (rel?.external) {
          body = `<text:a xlink:type="simple" xlink:href="${escA(rel.target)}">${body}</text:a>`
        } else doc.drop('internal-hyperlinks')
      }
      if (styleXml) {
        const sn = doc.style('T', 'text', styleXml)
        body = `<text:span text:style-name="${sn}">${body}</text:span>`
      }
      inner += body
    }

    // paragraph style
    const a: string[] = []
    a.push(
      `fo:text-align="${{ ctr: 'center', r: 'end', just: 'justify', l: 'start' }[props.algn ?? 'l'] ?? 'start'}"`,
    )
    if (!bullet) {
      if (props.marL !== undefined) a.push(`fo:margin-left="${cm(props.marL)}"`)
      if (props.indent !== undefined) a.push(`fo:text-indent="${cm(props.indent)}"`)
    } else {
      // margins come from the list level's label alignment
    }
    if (props.spcBef !== undefined) a.push(`fo:margin-top="${pt(props.spcBef)}"`)
    if (props.spcAft !== undefined) a.push(`fo:margin-bottom="${pt(props.spcAft)}"`)
    if (props.lnSpcPct !== undefined) a.push(`fo:line-height="${props.lnSpcPct}%"`)
    // paragraph-level size so list labels and empty paragraphs scale with the text
    const defSz = mergeChain(defRprs).sz
    const ps = doc.style(
      'P',
      'paragraph',
      `<style:paragraph-properties ${a.join(' ')}/>` +
        (defSz !== undefined ? `<style:text-properties fo:font-size="${pt(defSz / 100)}"/>` : ''),
    )
    const para = inner
      ? `<text:p text:style-name="${ps}">${inner}</text:p>`
      : `<text:p text:style-name="${ps}"/>`

    if (!bullet) {
      out += para
      prevNumKey = ''
      continue
    }
    const marL = props.marL ?? 342_900
    const indent = props.indent ?? -342_900
    const ls = doc.listStyle(listLevels(bullet, marL, indent))
    const numKey = bullet.kind === 'num' ? `${ls}` : ''
    const cont = numKey && numKey === prevNumKey ? ' text:continue-numbering="true"' : ''
    prevNumKey = numKey
    let wrapped = `<text:list-item>${para}</text:list-item>`
    for (let i = 0; i < lvl; i++)
      wrapped = `<text:list-item><text:list>${wrapped}</text:list></text:list-item>`
    out += `<text:list text:style-name="${ls}"${cont}>${wrapped}</text:list>`
  }
  return out
}

const hasText = (txBody: XNode | null): boolean =>
  kids(txBody, 'a:p').some((p) =>
    kids(p).some((c) => {
      const n = nodeName(c)
      return (
        n === 'a:br' ||
        ((n === 'a:r' || n === 'a:fld') && kids(c, 'a:t').some((x) => textOfNode(x) !== ''))
      )
    }),
  )

// ---------- geometry ----------

interface Xfrm {
  x: number
  y: number
  cx: number
  cy: number
  rot: number
  flipH: boolean
  flipV: boolean
}
export interface Tx {
  ox: number
  oy: number
  sx: number
  sy: number
}
interface Box {
  x: number
  y: number
  cx: number
  cy: number
}

function xfrmOf(n: XNode | null): Xfrm | null {
  const off = kid(n, 'a:off')
  const ext = kid(n, 'a:ext')
  if (!n || !off || !ext) return null
  return {
    x: num(val(off, 'x')) ?? 0,
    y: num(val(off, 'y')) ?? 0,
    cx: num(val(ext, 'cx')) ?? 0,
    cy: num(val(ext, 'cy')) ?? 0,
    rot: num(val(n, 'rot')) ?? 0,
    flipH: bool(val(n, 'flipH')) ?? false,
    flipV: bool(val(n, 'flipV')) ?? false,
  }
}

const place = (f: { x: number; y: number; cx: number; cy: number }, tx: Tx): Box => ({
  x: Math.round(tx.ox + f.x * tx.sx),
  y: Math.round(tx.oy + f.y * tx.sy),
  cx: Math.round(f.cx * tx.sx),
  cy: Math.round(f.cy * tx.sy),
})

const boxAttrs = (b: Box): string =>
  `svg:x="${cm(b.x)}" svg:y="${cm(b.y)}" svg:width="${cm(b.cx)}" svg:height="${cm(b.cy)}"`

// ---------- shapes ----------

export interface RenderCtx {
  pkg: Pkg
  env: Env
  part: Part
  layout: Part | null
  /** only slide-level trees paint placeholders; layout/master ones are prompts */
  slide: boolean
  counter: { n: number }
}

const normPhType = (t: string | undefined): string =>
  t === 'ctrTitle'
    ? 'title'
    : t === 'dt' || t === 'ftr' || t === 'sldNum' || t === 'title'
      ? t
      : 'body'

function findPh(root: XNode | null, ph: XNode): XNode | null {
  const idx = val(ph, 'idx')
  const type = normPhType(val(ph, 'type'))
  const sps = kids(kid(root, 'p:cSld', 'p:spTree'), 'p:sp')
  const phOf = (sp: XNode): XNode | null => kid(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph')
  if (idx !== undefined) {
    const byIdx = sps.find((sp) => val(phOf(sp), 'idx') === idx)
    if (byIdx) return byIdx
  }
  return (
    sps.find((sp) => {
      const p = phOf(sp)
      return p && normPhType(val(p, 'type')) === type
    }) ?? null
  )
}

function fillAttrs(spPr: XNode | null, style: XNode | null, env: Env): string {
  const own = kids(spPr).find((c) =>
    ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'].includes(
      nodeName(c) ?? '',
    ),
  )
  if (own) {
    const n = nodeName(own)
    if (n === 'a:noFill') return 'draw:fill="none"'
    if (n === 'a:solidFill') {
      const c = colorOf(own, env)
      if (!c) return 'draw:fill="none"'
      return `draw:fill="solid" draw:fill-color="#${c.hex}"${c.alpha !== undefined && c.alpha < 1 ? ` draw:opacity="${+(c.alpha * 100).toFixed(1)}%"` : ''}`
    }
    env.doc.drop(
      n === 'a:gradFill'
        ? 'gradient-fills'
        : n === 'a:blipFill'
          ? 'picture-fills'
          : 'pattern-fills',
    )
    return 'draw:fill="none"'
  }
  const ref = kid(style, 'a:fillRef')
  const idx = num(val(ref, 'idx')) ?? 0
  if (!ref || idx === 0) return 'draw:fill="none"'
  const kind = env.theme.fillKinds[idx - 1]
  const c = colorOf(ref, env)
  if (kind === 'a:solidFill' && c) return `draw:fill="solid" draw:fill-color="#${c.hex}"`
  env.doc.drop('gradient-fills')
  return 'draw:fill="none"'
}

function strokeAttrs(spPr: XNode | null, style: XNode | null, env: Env): string {
  const ln = kid(spPr, 'a:ln')
  if (kid(ln, 'a:noFill')) return 'draw:stroke="none"'
  let color = colorOf(kid(ln, 'a:solidFill'), env)
  let width = num(val(ln, 'w'))
  const ref = kid(style, 'a:lnRef')
  const idx = num(val(ref, 'idx')) ?? 0
  if (!color && !kid(ln, 'a:solidFill')) {
    if (!ref || idx === 0) return 'draw:stroke="none"'
    color = colorOf(ref, env)
    width ??= env.theme.lnWidths[idx - 1]
  }
  if (!color) return 'draw:stroke="none"'
  if (kid(ln, 'a:prstDash') && val(kid(ln, 'a:prstDash')) !== 'solid') env.doc.drop('dashed-lines')
  if (kid(ln, 'a:headEnd') && val(kid(ln, 'a:headEnd'), 'type') !== 'none')
    env.doc.drop('line-ends')
  if (kid(ln, 'a:tailEnd') && val(kid(ln, 'a:tailEnd'), 'type') !== 'none')
    env.doc.drop('line-ends')
  return `draw:stroke="solid" svg:stroke-width="${cm(width ?? 12700)}" svg:stroke-color="#${color.hex}"`
}

async function renderSp(sp: XNode, tx: Tx, rc: RenderCtx, cxn: boolean): Promise<string> {
  const { env } = rc
  const doc = env.doc
  const nvPr = kid(sp, cxn ? 'p:nvCxnSpPr' : 'p:nvSpPr', 'p:nvPr')
  const ph = kid(nvPr, 'p:ph')
  if (ph && !rc.slide) return ''
  if (kid(nvPr, 'a:videoFile') || kid(nvPr, 'a:audioFile') || kid(nvPr, 'a:wavAudioFile')) {
    doc.drop('media')
    return ''
  }
  const spPr = kid(sp, 'p:spPr')
  const layoutSp = ph && rc.layout ? findPh(rc.layout.root, ph) : null
  const masterSp = ph && env.master ? findPh(env.master.root, ph) : null
  const xf =
    xfrmOf(kid(spPr, 'a:xfrm')) ??
    xfrmOf(kid(layoutSp, 'p:spPr', 'a:xfrm')) ??
    xfrmOf(kid(masterSp, 'p:spPr', 'a:xfrm'))
  if (!xf) {
    doc.drop('shapes-without-geometry')
    return ''
  }
  if (xf.rot) doc.drop('rotated-shapes')
  if (kid(spPr, 'a:effectLst') && kids(kid(spPr, 'a:effectLst')).length > 0)
    doc.drop('shape-effects')
  if (kid(spPr, 'a:scene3d') || kid(spPr, 'a:sp3d')) doc.drop('3d-effects')

  const box = place(xf, tx)
  const style = kid(sp, 'p:style')
  const name = val(kid(sp, cxn ? 'p:nvCxnSpPr' : 'p:nvSpPr', 'p:cNvPr'), 'name') ?? 'shape'
  const prst = val(kid(spPr, 'a:prstGeom'), 'prst')
  const custom = !!kid(spPr, 'a:custGeom')
  const txBody = kid(sp, 'p:txBody')
  const withText = hasText(txBody)

  // straight lines and connectors
  if (prst === 'line' || prst === 'straightConnector1' || (cxn && !custom && !prst)) {
    const x1 = xf.flipH ? box.x + box.cx : box.x
    const x2 = xf.flipH ? box.x : box.x + box.cx
    const y1 = xf.flipV ? box.y + box.cy : box.y
    const y2 = xf.flipV ? box.y : box.y + box.cy
    const gs = doc.style(
      'gr',
      'graphic',
      `<style:graphic-properties ${strokeAttrs(spPr, style, env)} draw:fill="none"/>`,
    )
    return `<draw:line draw:style-name="${gs}" draw:name="${escA(name)}" svg:x1="${cm(x1)}" svg:y1="${cm(y1)}" svg:x2="${cm(x2)}" svg:y2="${cm(y2)}"/>`
  }

  const isBox = !!ph || val(kid(sp, 'p:nvSpPr', 'p:cNvSpPr'), 'txBox') === '1' || (!prst && !custom)
  const known = prst === 'rect' || prst === 'ellipse' || prst === 'roundRect'
  if (!isBox && !known) doc.drop(`geometry:${custom ? 'custom' : prst}`)
  const shapeLike = !isBox && known

  // text frame defaults: inheritance chain + body properties
  const bodyPrs = [
    kid(txBody, 'a:bodyPr'),
    kid(layoutSp, 'p:txBody', 'a:bodyPr'),
    kid(masterSp, 'p:txBody', 'a:bodyPr'),
  ]
  const bodyAttr = (n: string): string | undefined =>
    bodyPrs.map((b) => val(b, n)).find((v) => v !== undefined)
  if ((bodyAttr('vert') ?? 'horz') !== 'horz') doc.drop('vertical-text')
  const pad = (n: string, d: number): string => cm(num(bodyAttr(n)) ?? d)
  const anchor = { ctr: 'middle', b: 'bottom' }[bodyAttr('anchor') ?? 't'] ?? 'top'
  const frameAttrs =
    `draw:textarea-vertical-align="${anchor}" fo:padding-left="${pad('lIns', 91_440)}" fo:padding-right="${pad('rIns', 91_440)}"` +
    ` fo:padding-top="${pad('tIns', 45_720)}" fo:padding-bottom="${pad('bIns', 45_720)}" draw:auto-grow-height="false" draw:auto-grow-width="false"` +
    ` fo:wrap-option="${bodyAttr('wrap') === 'none' ? 'no-wrap' : 'wrap'}"`

  const kind = !ph
    ? 'other'
    : normPhType(val(ph, 'type')) === 'title'
      ? 'title'
      : normPhType(val(ph, 'type')) === 'body'
        ? 'body'
        : 'other'
  const txStyle = kid(
    env.master?.root ?? null,
    'p:txStyles',
    { title: 'p:titleStyle', body: 'p:bodyStyle', other: 'p:otherStyle' }[kind],
  )
  const paint = shapeLike || (!ph && !prst) || isBox
  const fill =
    paint &&
    (shapeLike ||
      !isBox ||
      kid(spPr, 'a:solidFill') ||
      kids(spPr).some((c) => /Fill$/.test(nodeName(c) ?? '')))
      ? fillAttrs(spPr, shapeLike ? style : null, env)
      : 'draw:fill="none"'
  const stroke =
    paint && (shapeLike || kid(spPr, 'a:ln'))
      ? strokeAttrs(spPr, shapeLike ? style : null, env)
      : 'draw:stroke="none"'

  // the shape's own p:style fontRef color is the lowest-priority text color
  const fontColor = colorOf(kid(style, 'a:fontRef'), env)
  const ctx: TextCtx = {
    lst: [
      kid(txBody, 'a:lstStyle'),
      kid(layoutSp, 'p:txBody', 'a:lstStyle'),
      kid(masterSp, 'p:txBody', 'a:lstStyle'),
    ],
    txStyle,
    env,
    rels: rc.part.rels,
    fontColor,
  }
  const paragraphs = paragraphsXml(txBody, ctx)

  if (ph && !withText && fill === 'draw:fill="none"' && stroke === 'draw:stroke="none"') return ''
  if (!isBox && !shapeLike && !withText) return ''
  const gs = doc.style(
    'gr',
    'graphic',
    `<style:graphic-properties ${stroke} ${fill} ${frameAttrs}/>`,
  )
  const common = `draw:style-name="${gs}" draw:name="${escA(name)}" ${boxAttrs(box)}`

  if (isBox || !shapeLike) {
    const cls = ph
      ? ((
          { title: ' presentation:class="title"', body: ' presentation:class="outline"' } as Record<
            string,
            string
          >
        )[kind] ?? '')
      : ''
    const klass = ph && val(ph, 'type') === 'subTitle' ? ' presentation:class="subtitle"' : cls
    return `<draw:frame ${common}${klass}><draw:text-box>${paragraphs}</draw:text-box></draw:frame>`
  }
  if (prst === 'ellipse') return `<draw:ellipse ${common}>${paragraphs}</draw:ellipse>`
  if (prst === 'roundRect') {
    const adj =
      num(
        (val(kids(kid(spPr, 'a:prstGeom', 'a:avLst'), 'a:gd')[0], 'fmla') ?? '').replace(
          /^val /,
          '',
        ),
      ) ?? 16_667
    const mod = Math.round(adj * 0.216)
    return (
      `<draw:custom-shape ${common}><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="round-rectangle" draw:modifiers="${mod}"` +
      ` draw:enhanced-path="M ${mod} 0 X 0 ${mod} L 0 ${21600 - mod} Y ${mod} 21600 L ${21600 - mod} 21600 X 21600 ${21600 - mod} L 21600 ${mod} Y ${21600 - mod} 0 Z N"/>${paragraphs}</draw:custom-shape>`
    )
  }
  return `<draw:rect ${common}>${paragraphs}</draw:rect>`
}

async function renderPic(pic: XNode, tx: Tx, rc: RenderCtx): Promise<string> {
  const { env } = rc
  const doc = env.doc
  const nvPr = kid(pic, 'p:nvPicPr', 'p:nvPr')
  if (kid(nvPr, 'a:videoFile') || kid(nvPr, 'a:audioFile') || kid(nvPr, 'a:wavAudioFile')) {
    doc.drop('media')
    return ''
  }
  const blip = kid(pic, 'p:blipFill', 'a:blip')
  const rel = rc.part.rels.get(val(blip, 'r:embed') ?? '')
  const xf = xfrmOf(kid(pic, 'p:spPr', 'a:xfrm'))
  if (!rel || rel.external || !xf) {
    doc.drop('pictures')
    return ''
  }
  const href = await doc.picture(rc.pkg, rel.target)
  if (!href) {
    doc.drop('pictures')
    return ''
  }
  const crop = kid(pic, 'p:blipFill', 'a:srcRect')
  if (crop && ['l', 't', 'r', 'b'].some((k) => (num(val(crop, k)) ?? 0) !== 0))
    doc.drop('picture-crops')
  if (xf.rot) doc.drop('rotated-shapes')
  if (xf.flipH || xf.flipV) doc.drop('flipped-pictures')
  const gs = doc.style(
    'gr',
    'graphic',
    '<style:graphic-properties draw:stroke="none" draw:fill="none"/>',
  )
  const name = val(kid(pic, 'p:nvPicPr', 'p:cNvPr'), 'name') ?? 'Picture'
  return (
    `<draw:frame draw:style-name="${gs}" draw:name="${escA(name)}" ${boxAttrs(place(xf, tx))}>` +
    `<draw:image xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`
  )
}

function cellBorder(tcPr: XNode | null, tag: string, env: Env): string {
  const ln = kid(tcPr, tag)
  const c = colorOf(kid(ln, 'a:solidFill'), env)
  if (!ln || kid(ln, 'a:noFill') || !c) return 'none'
  return `${pt((num(val(ln, 'w')) ?? 12700) / 12700)} solid #${c.hex}`
}

async function renderTable(gf: XNode, tx: Tx, rc: RenderCtx): Promise<string> {
  const { env } = rc
  const doc = env.doc
  const tbl = kid(gf, 'a:graphic', 'a:graphicData', 'a:tbl')
  const f = xfrmOf(kid(gf, 'p:xfrm'))
  if (!tbl || !f) {
    doc.drop('tables')
    return ''
  }
  if (kid(tbl, 'a:tblPr', 'a:tableStyleId')) doc.drop('table-styles')
  const ctx: TextCtx = {
    lst: [],
    txStyle: kid(env.master?.root ?? null, 'p:txStyles', 'p:otherStyle'),
    env,
    rels: rc.part.rels,
  }
  const cols = kids(kid(tbl, 'a:tblGrid'), 'a:gridCol').map((c) =>
    Math.round((num(val(c, 'w')) ?? 0) * tx.sx),
  )
  let xml = cols
    .map(
      (w) =>
        `<table:table-column table:style-name="${doc.style('co', 'table-column', `<style:table-column-properties style:column-width="${cm(w)}"/>`)}"/>`,
    )
    .join('')
  for (const tr of kids(tbl, 'a:tr')) {
    const h = Math.round((num(val(tr, 'h')) ?? 0) * tx.sy)
    const rs = doc.style(
      'ro',
      'table-row',
      `<style:table-row-properties style:min-row-height="${cm(h)}"/>`,
    )
    xml += `<table:table-row table:style-name="${rs}">`
    for (const tc of kids(tr, 'a:tc')) {
      if (bool(val(tc, 'hMerge')) || bool(val(tc, 'vMerge'))) {
        xml += '<table:covered-table-cell/>'
        continue
      }
      const tcPr = kid(tc, 'a:tcPr')
      // an unset fill must be explicit: the ODF default cell fill is not transparent
      const a: string[] = ['fo:background-color="transparent"']
      const fill = kids(tcPr).find((c) => /Fill$/.test(nodeName(c) ?? ''))
      if (fill) {
        if (nodeName(fill) === 'a:solidFill') {
          const c = colorOf(fill, env)
          if (c) a[0] = `fo:background-color="#${c.hex}"`
        } else if (nodeName(fill) !== 'a:noFill') doc.drop('gradient-fills')
      }
      for (const [side, tag] of [
        ['left', 'a:lnL'],
        ['right', 'a:lnR'],
        ['top', 'a:lnT'],
        ['bottom', 'a:lnB'],
      ] as const) {
        a.push(`fo:border-${side}="${cellBorder(tcPr, tag, env)}"`)
      }
      const m = (n: string, d: number): string => cm(num(val(tcPr, n)) ?? d)
      a.push(
        `fo:padding-left="${m('marL', 91_440)}" fo:padding-right="${m('marR', 91_440)}" fo:padding-top="${m('marT', 45_720)}" fo:padding-bottom="${m('marB', 45_720)}"`,
      )
      a.push(
        `style:vertical-align="${{ ctr: 'middle', b: 'bottom' }[val(tcPr, 'anchor') ?? 't'] ?? 'top'}"`,
      )
      const cs = doc.style('ce', 'table-cell', `<style:table-cell-properties ${a.join(' ')}/>`)
      const span = (n: string, odf: string): string =>
        (num(val(tc, n)) ?? 1) > 1 ? ` ${odf}="${num(val(tc, n))}"` : ''
      xml += `<table:table-cell table:style-name="${cs}" office:value-type="string"${span('gridSpan', 'table:number-columns-spanned')}${span('rowSpan', 'table:number-rows-spanned')}>${paragraphsXml(kid(tc, 'a:txBody'), ctx)}</table:table-cell>`
    }
    xml += '</table:table-row>'
  }
  const gs = doc.style(
    'gr',
    'graphic',
    '<style:graphic-properties draw:stroke="none" draw:fill="none"/>',
  )
  const name = val(kid(gf, 'p:nvGraphicFramePr', 'p:cNvPr'), 'name') ?? 'Table'
  rc.counter.n++
  return `<draw:frame draw:style-name="${gs}" draw:name="${escA(name)}" ${boxAttrs(place(f, tx))}><table:table table:name="Table${rc.counter.n}">${xml}</table:table></draw:frame>`
}

async function renderGraphicFrame(gf: XNode, tx: Tx, rc: RenderCtx): Promise<string> {
  const uri = val(kid(gf, 'a:graphic', 'a:graphicData'), 'uri') ?? ''
  if (kid(gf, 'a:graphic', 'a:graphicData', 'a:tbl')) return renderTable(gf, tx, rc)
  rc.env.doc.drop(
    uri.endsWith('/chart')
      ? 'charts'
      : uri.includes('diagram')
        ? 'smartart'
        : kid(gf, 'a:graphic', 'a:graphicData', 'p:oleObj')
          ? 'ole-objects'
          : 'graphic-frames',
  )
  return ''
}

export async function renderTree(tree: XNode | null, tx: Tx, rc: RenderCtx): Promise<string> {
  let out = ''
  for (const n of kids(tree)) {
    switch (nodeName(n)) {
      case 'p:sp':
        out += await renderSp(n, tx, rc, false)
        break
      case 'p:cxnSp':
        out += await renderSp(n, tx, rc, true)
        break
      case 'p:pic':
        out += await renderPic(n, tx, rc)
        break
      case 'p:graphicFrame':
        out += await renderGraphicFrame(n, tx, rc)
        break
      case 'p:contentPart':
        rc.env.doc.drop('content-parts')
        break
      case 'p:grpSp': {
        const g = kid(n, 'p:grpSpPr', 'a:xfrm')
        const f = xfrmOf(g)
        const ch = kid(g, 'a:chOff')
        const cs = kid(g, 'a:chExt')
        if (!f) break
        if (f.rot) rc.env.doc.drop('rotated-shapes')
        const gx = (num(val(cs, 'cx')) ?? 0) > 0 ? f.cx / (num(val(cs, 'cx')) ?? 1) : 1
        const gy = (num(val(cs, 'cy')) ?? 0) > 0 ? f.cy / (num(val(cs, 'cy')) ?? 1) : 1
        out += await renderTree(
          n,
          {
            ox: tx.ox + (f.x - (num(val(ch, 'x')) ?? 0) * gx) * tx.sx,
            oy: tx.oy + (f.y - (num(val(ch, 'y')) ?? 0) * gy) * tx.sy,
            sx: gx * tx.sx,
            sy: gy * tx.sy,
          },
          rc,
        )
        break
      }
      case 'mc:AlternateContent': {
        const pick = kid(n, 'mc:Fallback') ?? kid(n, 'mc:Choice')
        out += await renderTree(pick, tx, rc)
        break
      }
    }
  }
  return out
}

// ---------- backgrounds, notes ----------

/**
 * drawing-page style for a slide: first background found slide → layout → master
 * (`inherit` false: the slide's own background only — a patched file's ODF master
 * paints the rest). `extra` is appended to the drawing-page properties verbatim.
 */
export async function pageStyle(
  slide: Part,
  layout: Part | null,
  rc: RenderCtx,
  hidden: boolean,
  inherit = true,
  extra = '',
): Promise<string> {
  const { env, pkg } = rc
  const doc = env.doc
  const chain: Part[] = inherit
    ? [slide, ...(layout ? [layout] : []), ...(env.master ? [env.master] : [])]
    : [slide]
  let props = ''
  for (const part of chain) {
    const bg = kid(part.root, 'p:cSld', 'p:bg')
    if (!bg) continue
    const pr = kid(bg, 'p:bgPr')
    const fill = kids(pr).find((c) => /Fill$/.test(nodeName(c) ?? ''))
    if (fill && nodeName(fill) === 'a:solidFill') {
      const c = colorOf(fill, env)
      if (c) props = `draw:fill="solid" draw:fill-color="#${c.hex}"`
    } else if (fill && nodeName(fill) === 'a:blipFill') {
      const rel = part.rels.get(val(kid(fill, 'a:blip'), 'r:embed') ?? '')
      const href = rel && !rel.external ? await doc.picture(pkg, rel.target) : null
      if (href && !kid(fill, 'a:tile')) {
        const fname = doc.fillImageName()
        doc.fillImages.push(
          `<draw:fill-image draw:name="${fname}" xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`,
        )
        props = `draw:fill="bitmap" draw:fill-image-name="${fname}" style:repeat="stretch"`
      } else doc.drop('background-images')
    } else if (fill && nodeName(fill) !== 'a:noFill') {
      doc.drop('background-gradients')
    } else if (!fill && kid(bg, 'p:bgRef')) {
      const ref = kid(bg, 'p:bgRef')
      const idx = num(val(ref, 'idx')) ?? 0
      const c = colorOf(ref, env)
      if (idx >= 1001 && env.theme.bgKinds[idx - 1001] === 'a:solidFill' && c)
        props = `draw:fill="solid" draw:fill-color="#${c.hex}"`
      else doc.drop('background-gradients')
    }
    break
  }
  if (hidden) props += ' presentation:visibility="hidden"'
  if (!props && !inherit) props = 'draw:background-size="border"'
  else props = `draw:background-size="border" ${props || 'draw:fill="none"'}`
  const inner = `<style:drawing-page-properties ${props}${extra ? ` ${extra}` : ''}/>`
  return doc.style('dp', 'drawing-page', inner)
}

export async function notesXml(slide: Part, rc: RenderCtx): Promise<string> {
  const rel = relOfType(slide, '/notesSlide')
  const notes = rel ? await rc.pkg.part(rel.target) : null
  if (!notes) return ''
  const body = kids(kid(notes.root, 'p:cSld', 'p:spTree'), 'p:sp').find(
    (sp) => val(kid(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph'), 'type') === 'body',
  )
  const txBody = kid(body, 'p:txBody')
  if (!hasText(txBody)) return ''
  const ctx: TextCtx = { lst: [], txStyle: null, env: rc.env, rels: notes.rels }
  const gs = rc.env.doc.style(
    'gr',
    'graphic',
    '<style:graphic-properties draw:stroke="none" draw:fill="none"/>',
  )
  return (
    `<presentation:notes><draw:frame draw:style-name="${gs}" presentation:class="notes" svg:x="2.1cm" svg:y="14.8cm" svg:width="16.8cm" svg:height="11.2cm">` +
    `<draw:text-box>${paragraphsXml(txBody, ctx)}</draw:text-box></draw:frame></presentation:notes>`
  )
}

// ---------- main ----------

/** an opened pptx plus the ODF output registry its slides serialise into */
export interface OdpWriter {
  pkg: Pkg
  presentation: Part
  doc: Doc
  themeCache: Map<string, Theme>
  counter: { n: number }
}

export async function openOdpWriter(
  pptx: Uint8Array,
  reserved?: ReadonlySet<string>,
): Promise<OdpWriter> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(pptx)
    assertZipWithinLimits(zip)
  } catch {
    throw new OdfConvertError('unreadable')
  }
  const pkg = new Pkg(zip)
  const presentation = await pkg.part('ppt/presentation.xml')
  if (!presentation) throw new OdfConvertError('unreadable')
  return { pkg, presentation, doc: new Doc(reserved), themeCache: new Map(), counter: { n: 0 } }
}

/** slides in deck order: the sldId's id and the slide part path (null: dangling rel) */
export function slideRefs(w: OdpWriter): Array<{ id: string; path: string | null }> {
  return kids(kid(w.presentation.root, 'p:sldIdLst'), 'p:sldId').map((id) => ({
    id: val(id, 'id') ?? '',
    path: w.presentation.rels.get(val(id, 'r:id') ?? '')?.target ?? null,
  }))
}

export const IDENT: Tx = { ox: 0, oy: 0, sx: 1, sy: 1 }

/** everything one slide needs to serialise: its part, layout, and a slide render context */
export interface SlideScope {
  slide: Part
  layout: Part | null
  master: Part | null
  rc: RenderCtx
}

export async function slideScope(w: OdpWriter, path: string): Promise<SlideScope | null> {
  const { pkg, doc, themeCache } = w
  const slide = await pkg.part(path)
  if (!slide) return null
  const layoutRel = relOfType(slide, '/slideLayout')
  const layout = layoutRel ? await pkg.part(layoutRel.target) : null
  const masterRel = layout ? relOfType(layout, '/slideMaster') : undefined
  const master = masterRel ? await pkg.part(masterRel.target) : null
  const themeRel = master ? relOfType(master, '/theme') : undefined
  let theme = themeRel ? themeCache.get(themeRel.target) : undefined
  if (themeRel && !theme) {
    theme = parseTheme((await pkg.part(themeRel.target))?.root ?? null)
    themeCache.set(themeRel.target, theme)
  }
  const map = kid(master?.root ?? null, 'p:clrMap')
  const clrMap = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' } as Record<string, string>
  for (const [k, v] of Object.entries((map?.[':@'] as Record<string, string> | undefined) ?? {}))
    clrMap[k] = v
  const env: Env = {
    theme: theme ?? { colors: {}, lnWidths: [], fillKinds: [], bgKinds: [] },
    clrMap,
    master,
    presentation: w.presentation.root,
    doc,
  }
  const rc: RenderCtx = { pkg, env, part: slide, layout, slide: true, counter: w.counter }
  return { slide, layout, master, rc }
}

/** master + layout decorations painted onto a slide (showMasterSp rules) */
async function decorations(scope: SlideScope): Promise<string> {
  const { slide, layout, master, rc } = scope
  let shapes = ''
  // slide hides layout+master with showMasterSp=0, layout hides master
  if (val(slide.root, 'showMasterSp') === '0') return shapes
  if (master && layout && val(layout.root, 'showMasterSp') !== '0') {
    const tree = kid(master.root, 'p:cSld', 'p:spTree')
    shapes += await renderTree(tree, IDENT, { ...rc, part: master, slide: false })
  }
  if (layout) {
    const tree = kid(layout.root, 'p:cSld', 'p:spTree')
    shapes += await renderTree(tree, IDENT, { ...rc, part: layout, slide: false })
  }
  return shapes
}

export async function convertPptxToOdp(pptx: Uint8Array): Promise<PptxToOdpResult> {
  const w = await openOdpWriter(pptx)
  const { presentation, doc } = w
  const size = kid(presentation.root, 'p:sldSz')
  const width = num(val(size, 'cx')) ?? 9_144_000
  const height = num(val(size, 'cy')) ?? 6_858_000

  const pages: string[] = []
  for (const ref of slideRefs(w)) {
    const scope = ref.path ? await slideScope(w, ref.path) : null
    if (!scope) {
      doc.drop('unreadable-slides')
      continue
    }
    const { slide, layout, rc } = scope
    let shapes = await decorations(scope)
    shapes += await renderTree(kid(slide.root, 'p:cSld', 'p:spTree'), IDENT, rc)
    if (deepHas(slide.root, 'p:transition')) doc.drop('transitions')
    if (kid(slide.root, 'p:timing')) doc.drop('animations')

    const dp = await pageStyle(slide, layout, rc, val(slide.root, 'show') === '0')
    const n = pages.length + 1
    pages.push(
      `<draw:page draw:name="page${n}" draw:style-name="${dp}" draw:master-page-name="Default">${shapes}${await notesXml(slide, rc)}</draw:page>`,
    )
  }

  const content =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3">` +
    `<office:automatic-styles>${doc.auto.join('')}</office:automatic-styles>` +
    `<office:body><office:presentation>${pages.join('')}</office:presentation></office:body></office:document-content>`
  const styles =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3">` +
    `<office:styles>${doc.fillImages.join('')}</office:styles>` +
    `<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="${cm(width)}" fo:page-height="${cm(height)}"` +
    ` fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" style:print-orientation="${width >= height ? 'landscape' : 'portrait'}"/></style:page-layout></office:automatic-styles>` +
    `<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`
  const meta =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS} office:version="1.3"><office:meta>` +
    `<meta:generator>SelfOffice</meta:generator><meta:document-statistic meta:page-count="${pages.length}"/></office:meta></office:document-meta>`
  const entries = ['content.xml', 'styles.xml', 'meta.xml']
  const manifest =
    `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODP_MIME}"/>` +
    entries
      .map((e) => `<manifest:file-entry manifest:full-path="${e}" manifest:media-type="text/xml"/>`)
      .join('') +
    doc.pictureFiles
      .map(
        (p) =>
          `<manifest:file-entry manifest:full-path="${p.name}" manifest:media-type="${IMAGE_MIME[p.ext]}"/>`,
      )
      .join('') +
    `</manifest:manifest>`

  const out = new JSZip()
  out.file('mimetype', ODP_MIME, { compression: 'STORE' })
  out.file('META-INF/manifest.xml', manifest)
  out.file('content.xml', content)
  out.file('styles.xml', styles)
  out.file('meta.xml', meta)
  for (const p of doc.pictureFiles) out.file(p.name, p.bytes)
  const odp = await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { odp, slides: pages.length, dropped: doc.dropped() }
}
