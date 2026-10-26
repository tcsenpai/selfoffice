/**
 * .xlsx → .ods export filter. The workbook is read straight from its OOXML
 * parts (jszip + fast-xml-parser) and rebuilt as an ODF 1.3 spreadsheet.
 *
 * Same "prove it or drop it" rule as the .ods import (apps/sheets/native/
 * xlsx-engine/src/odf.rs): a formula that cannot be translated provably
 * correct keeps only its cached value and is reported in `dropped`; so is
 * every construct with no ODF counterpart here (charts, pivots, images,
 * conditional formats, data validation, comments, rich-text runs, ...).
 *
 * Limits (pathological inputs): at most MAX_CELLS non-empty cells per
 * workbook and MAX_COVERED_CELLS cells hidden under merged ranges; the rest
 * is skipped and counted in `dropped`. Empty runs are always compressed with
 * table:number-columns-repeated / number-rows-repeated, so a sparse sheet
 * that spans a million rows costs a handful of elements.
 */

import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { OdfConvertError } from './odf'

export interface XlsxToOdsResult {
  ods: Uint8Array
  sheets: number
  cells: number
  dropped: string[]
}

export const MAX_CELLS = 5_000_000
export const MAX_COVERED_CELLS = 1_000_000
const MAX_COL = 16384
const MAX_ROW = 1_048_576

// ───────────────────────── formula translation ─────────────────────────

/**
 * Functions whose ODF name and argument semantics equal Excel's. Anything not
 * listed (new `_xlfn.` functions, locale-dependent ones, CEILING/FLOOR with
 * their differing mode argument, ...) makes the formula untranslatable.
 */
const SAME_NAME_FUNCTIONS = new Set(
  (
    'ABS ACOS ACOSH ADDRESS AND ASIN ASINH ATAN ATAN2 ATANH AVERAGE AVERAGEIF AVERAGEIFS CHAR CHOOSE CLEAN ' +
    'CODE COLUMN COLUMNS COMBIN CONCATENATE CORREL COS COSH COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS DATE ' +
    'DATEDIF DATEVALUE DAY DAYS360 DEGREES EDATE EOMONTH EVEN EXACT EXP FACT FALSE FIND FV HLOOKUP HOUR IF ' +
    'IFERROR IFNA INDEX INT INTERCEPT IRR ISBLANK ISERR ISERROR ISEVEN ISLOGICAL ISNA ISNONTEXT ISNUMBER ' +
    'ISODD ISTEXT LARGE LEFT LEN LN LOG LOG10 LOOKUP LOWER MATCH MAX MEDIAN MID MIN MINUTE MOD MODE MONTH N ' +
    'NA NETWORKDAYS NOT NOW NPER NPV ODD OR PERCENTILE PI PMT POWER PRODUCT PROPER PV QUARTILE RADIANS RAND ' +
    'RANDBETWEEN RANK RATE REPLACE REPT RIGHT ROUND ROUNDDOWN ROUNDUP ROW ROWS SEARCH SECOND SIGN SIN SINH ' +
    'SLOPE SMALL SQRT STDEV STDEVP SUBSTITUTE SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT SUMSQ TAN TANH TEXT TIME ' +
    'TIMEVALUE TODAY TRIM TRUE TRUNC UPPER VALUE VAR VARP VLOOKUP WEEKDAY WEEKNUM WORKDAY YEAR'
  ).split(' '),
)

export interface FormulaOptions {
  /** workbook-level defined names that a bare identifier may refer to (upper-cased) */
  names?: ReadonlySet<string>
  /** shift of relative references, used to expand shared formulas */
  dRow?: number
  dCol?: number
}

const CELL_AT = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_.(!])/
const PLAIN_SHEET = /^[A-Za-z_][A-Za-z0-9_]*$/

function colToNumber(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64
  return n
}

function numberToCol(n: number): string {
  let out = ''
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26))
    out = String.fromCharCode(65 + ((v - 1) % 26)) + out
  return out
}

function odfSheet(name: string): string {
  return PLAIN_SHEET.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/**
 * Excel formula (no leading `=`) → ODF `of:=` formula, or null when it cannot
 * be translated provably-correct: unknown functions, union/intersection,
 * whole-column/row refs, 3D refs, structured/external refs, array constants,
 * error literals, unknown names.
 */
export function translateFormulaToOds(formula: string, opts: FormulaOptions = {}): string | null {
  const src = formula.startsWith('=') ? formula.slice(1) : formula
  const dRow = opts.dRow ?? 0
  const dCol = opts.dCol ?? 0
  let out = ''
  let i = 0
  let lastOperand = false
  const parens: boolean[] = [] // true = function-call paren
  let pendingFn = false

  const readCell = (at: number) => {
    const m = CELL_AT.exec(src.slice(at))
    if (!m) return null
    let col = colToNumber(m[2])
    let row = Number(m[4])
    if (!m[1]) col += dCol
    if (!m[3]) row += dRow
    if (col < 1 || col > MAX_COL || row < 1 || row > MAX_ROW) return null
    return { text: `${m[1]}${numberToCol(col)}${m[3]}${row}`, len: m[0].length }
  }

  // reference (optionally sheet-qualified) starting at i; appends to out
  const readRef = (sheet: string | null): boolean => {
    const first = readCell(i)
    if (!first) return false
    i += first.len
    const prefix = sheet === null ? '.' : `$${odfSheet(sheet)}.`
    if (src[i] === ':') {
      const second = readCell(i + 1)
      if (!second) return false
      i += 1 + second.len
      out += `[${prefix}${first.text}:.${second.text}]`
    } else {
      out += `[${prefix}${first.text}]`
    }
    lastOperand = true
    return true
  }

  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      let j = i
      while (j < src.length && /\s/.test(src[j])) j++
      // a space between two operands is Excel's intersection operator
      if (lastOperand && j < src.length && /[A-Za-z0-9_$'"({\\]/.test(src[j])) return null
      out += src.slice(i, j)
      i = j
      continue
    }
    if (ch === '"') {
      let j = i + 1
      for (;;) {
        if (j >= src.length) return null
        if (src[j] === '"') {
          if (src[j + 1] === '"') j += 2
          else break
        } else j++
      }
      out += src.slice(i, j + 1)
      i = j + 1
      lastOperand = true
      continue
    }
    if (ch === "'") {
      let j = i + 1
      let name = ''
      for (;;) {
        if (j >= src.length) return null
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            name += "'"
            j += 2
          } else break
        } else name += src[j++]
      }
      if (src[j + 1] !== '!' || !name) return null
      i = j + 2
      if (!readRef(name)) return null
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!
      if (/[A-Za-z_:$]/.test(src[i + m[0].length] ?? '')) return null // 1:1 row refs, 1A
      out += m[0]
      i += m[0].length
      lastOperand = true
      continue
    }
    if (ch === '$' || /[A-Za-z_\\]/.test(ch)) {
      if (readCell(i) && readRef(null)) continue
      if (ch === '$') return null
      const m = /^[A-Za-z_\\][A-Za-z0-9_.]*/.exec(src.slice(i))![0]
      const next = src[i + m.length]
      if (next === '(') {
        const upper = m.toUpperCase()
        if (!SAME_NAME_FUNCTIONS.has(upper)) return null
        out += upper
        i += m.length
        lastOperand = false
        pendingFn = true
        continue
      }
      if (next === '!') {
        i += m.length + 1
        if (!readRef(m)) return null
        continue
      }
      const upper = m.toUpperCase()
      if (upper === 'TRUE' || upper === 'FALSE') out += `${upper}()`
      else if (opts.names?.has(upper)) out += m
      else return null
      i += m.length
      lastOperand = true
      continue
    }
    switch (ch) {
      case '(': {
        parens.push(pendingFn)
        pendingFn = false
        out += '('
        lastOperand = false
        break
      }
      case ')':
        if (!parens.length) return null
        parens.pop()
        out += ')'
        lastOperand = true
        break
      case ',':
        // a comma inside a grouping paren / at top level is the union operator
        if (!parens.length || !parens[parens.length - 1]) return null
        out += ';'
        lastOperand = false
        break
      case '%':
        out += '%'
        lastOperand = true
        break
      case '+':
      case '-':
      case '*':
      case '/':
      case '^':
      case '&':
      case '=':
        out += ch
        lastOperand = false
        break
      case '<':
      case '>': {
        const two = src.slice(i, i + 2)
        if (two === '<>' || two === '<=' || two === '>=') {
          out += two
          i += 2
          lastOperand = false
          continue
        }
        out += ch
        lastOperand = false
        break
      }
      default:
        return null
    }
    i++
  }
  if (parens.length || !out.trim()) return null
  return `of:=${out}`
}

// ───────────────────────── number formats ─────────────────────────

const CURRENCY: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' }

const BUILTIN_FORMATS: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '$#,##0',
  6: '$#,##0',
  7: '$#,##0.00',
  8: '$#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0',
  38: '#,##0',
  39: '#,##0.00',
  40: '#,##0.00',
  41: '#,##0',
  42: '$#,##0',
  43: '#,##0.00',
  44: '$#,##0.00',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  49: '@',
}

type FmtKind = 'number' | 'percent' | 'currency' | 'date' | 'time' | 'text' | 'general'

interface Fmt {
  kind: FmtKind
  /** ODF number style element (without the style:name attribute inserted) */
  build?: (name: string) => string
  currency?: string
  hasTime?: boolean
  styleName?: string
  /** negative / zero / text sections were ignored */
  lossy?: boolean
}

type Tok =
  | { t: 'text'; v: string }
  | { t: 'sym'; v: string }
  | { t: 'num'; xml: string }
  | { t: 'pct' }
  | {
      t: 'dt'
      unit: 'y' | 'm' | 'd' | 'h' | 's' | 'ampm'
      n: number
      dec?: number
      elapsed?: boolean
      minute?: boolean
    }

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function splitSections(code: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '"') quoted = !quoted
    if (c === '\\') {
      cur += c + (code[++i] ?? '')
      continue
    }
    if (c === ';' && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

/** Excel number-format code → ODF number style, or null when it has no safe ODF spelling. */
export function translateNumberFormat(code: string): Fmt | null {
  const sections = splitSections(code)
  const section = sections[0]
  const lossy = sections.length > 1
  if (/^\s*general\s*$/i.test(section)) return { kind: 'general', lossy }
  if (section.trim() === '@') return { kind: 'text', lossy }

  const toks: Tok[] = []
  let hasNum = false
  let i = 0
  while (i < section.length) {
    const c = section[i]
    const rest = section.slice(i)
    if (c === '"') {
      const end = section.indexOf('"', i + 1)
      if (end < 0) return null
      toks.push({ t: 'text', v: section.slice(i + 1, end) })
      i = end + 1
    } else if (c === '\\') {
      toks.push({ t: 'text', v: section[i + 1] ?? '' })
      i += 2
    } else if (c === '_') {
      toks.push({ t: 'text', v: ' ' })
      i += 2
    } else if (c === '*') {
      i += 2
    } else if (c === '[') {
      const end = section.indexOf(']', i)
      if (end < 0) return null
      const inner = section.slice(i + 1, end)
      if (inner.startsWith('$')) {
        const sym = inner.slice(1).split('-')[0]
        if (sym) toks.push(CURRENCY[sym] ? { t: 'sym', v: sym } : { t: 'text', v: sym })
      } else if (/^(h+|m+|s+)$/i.test(inner)) {
        toks.push({
          t: 'dt',
          unit: inner[0].toLowerCase() as 'h' | 'm' | 's',
          n: inner.length,
          elapsed: true,
        })
      } else if (!/^(black|blue|cyan|green|magenta|red|white|yellow|color\s*\d+)$/i.test(inner))
        return null
      i = end + 1
    } else if (/^(AM\/PM|A\/P)/i.test(rest)) {
      toks.push({ t: 'dt', unit: 'ampm', n: 1 })
      i += /^AM\/PM/i.test(rest) ? 5 : 3
    } else if (/^([0#?,]+(\.[0#?]*)?|\.[0#?]+)/.test(rest)) {
      if (hasNum) return null
      hasNum = true
      const m = /^([0#?,]+(\.[0#?]*)?|\.[0#?]+)/.exec(rest)![0]
      i += m.length
      const [intPart, decPart = ''] = m.split('.')
      if (/,$/.test(intPart) && intPart.replace(/,/g, '').length) return null // thousands scaling
      const grouping = intPart.includes(',')
      const minInt = (intPart.match(/0/g) ?? []).length
      const decimals = decPart.length
      const minDec = (decPart.match(/0/g) ?? []).length
      const sci = /^[eE]([+-])(0+)/.exec(section.slice(i))
      const dec =
        `number:decimal-places="${decimals}"` +
        (minDec !== decimals ? ` number:min-decimal-places="${minDec}"` : '')
      if (sci) {
        i += sci[0].length
        toks.push({
          t: 'num',
          xml: `<number:scientific-number ${dec} number:min-integer-digits="${Math.max(minInt, 1)}" number:min-exponent-digits="${sci[2].length}"/>`,
        })
      } else {
        toks.push({
          t: 'num',
          xml: `<number:number ${dec} number:min-integer-digits="${minInt}"${grouping ? ' number:grouping="true"' : ''}/>`,
        })
      }
    } else if (c === '%') {
      toks.push({ t: 'pct' })
      i++
    } else if (/[ymdhs]/i.test(c)) {
      const lc = c.toLowerCase() as 'y' | 'm' | 'd' | 'h' | 's'
      let j = i
      while (j < section.length && section[j].toLowerCase() === lc) j++
      const tok: Tok = { t: 'dt', unit: lc, n: j - i }
      if (lc === 's') {
        const frac = /^\.(0+)/.exec(section.slice(j))
        if (frac) {
          tok.dec = frac[1].length
          j += frac[0].length
        }
      }
      toks.push(tok)
      i = j
    } else if (CURRENCY[c]) {
      toks.push({ t: 'sym', v: c })
      i++
    } else if (c === '/' && hasNum) {
      return null // fraction
    } else if (/[ \-+():/,.!&~{}<>=^'`]/.test(c) || c.charCodeAt(0) > 127) {
      toks.push({ t: 'text', v: c })
      i++
    } else return null
  }

  // resolve m: minutes right after hours or right before seconds, month otherwise
  const timeToks = toks.filter(
    (t): t is Extract<Tok, { t: 'dt' }> => t.t === 'dt' && t.unit !== 'ampm',
  )
  timeToks.forEach((t, k) => {
    if (t.unit === 'm')
      t.minute = !!t.elapsed || timeToks[k - 1]?.unit === 'h' || timeToks[k + 1]?.unit === 's'
  })
  const isMonth = (t: Tok) => t.t === 'dt' && t.unit === 'm' && !t.minute
  const hasDate = toks.some((t) => t.t === 'dt' && (t.unit === 'y' || t.unit === 'd' || isMonth(t)))
  const hasTime = toks.some(
    (t) =>
      t.t === 'dt' &&
      (t.unit === 'h' || t.unit === 's' || t.unit === 'ampm' || (t.unit === 'm' && !isMonth(t))),
  )
  const pct = toks.some((t) => t.t === 'pct')
  const sym = toks.find((t): t is Extract<Tok, { t: 'sym' }> => t.t === 'sym')
  const elapsed = toks.some((t) => t.t === 'dt' && t.elapsed)
  if (!hasDate && !hasTime && !hasNum) return null
  if ((hasDate || hasTime) && (hasNum || pct)) return null

  const body = toks
    .map((t): string => {
      switch (t.t) {
        case 'text':
          return `<number:text>${esc(t.v)}</number:text>`
        case 'sym':
          return `<number:currency-symbol>${esc(t.v)}</number:currency-symbol>`
        case 'num':
          return t.xml
        case 'pct':
          return '<number:text>%</number:text>'
        case 'dt': {
          const long = t.n >= 2 ? ' number:style="long"' : ''
          switch (t.unit) {
            case 'y':
              return `<number:year${t.n >= 3 ? ' number:style="long"' : ''}/>`
            case 'd':
              return t.n >= 3
                ? `<number:day-of-week${t.n === 4 ? ' number:style="long"' : ''}/>`
                : `<number:day${long}/>`
            case 'h':
              return `<number:hours${long}/>`
            case 's':
              return `<number:seconds${long}${t.dec ? ` number:decimal-places="${t.dec}"` : ''}/>`
            case 'ampm':
              return '<number:am-pm/>'
            default:
              return isMonth(t)
                ? `<number:month${t.n >= 3 ? ' number:textual="true"' : ''}${t.n === 2 || t.n === 4 ? ' number:style="long"' : ''}/>`
                : `<number:minutes${long}/>`
          }
        }
      }
    })
    .join('')

  if (hasDate || hasTime) {
    const tag = hasDate ? 'date-style' : 'time-style'
    return {
      kind: hasDate ? 'date' : 'time',
      hasTime,
      lossy,
      build: (name) =>
        `<number:${tag} style:name="${name}"${elapsed ? ' number:truncate-on-overflow="false"' : ''}>${body}</number:${tag}>`,
    }
  }
  if (pct) {
    return {
      kind: 'percent',
      lossy,
      build: (name) =>
        `<number:percentage-style style:name="${name}">${body}</number:percentage-style>`,
    }
  }
  if (sym) {
    return {
      kind: 'currency',
      currency: CURRENCY[sym.v],
      lossy,
      build: (name) =>
        `<number:currency-style style:name="${name}">${body}</number:currency-style>`,
    }
  }
  return {
    kind: 'number',
    lossy,
    build: (name) => `<number:number-style style:name="${name}">${body}</number:number-style>`,
  }
}

// ───────────────────────── xlsx parsing helpers ─────────────────────────

const ARRAY_TAGS = new Set([
  'row',
  'c',
  'col',
  'si',
  'r',
  't',
  'mergeCell',
  'sheet',
  'definedName',
  'hyperlink',
  'Relationship',
  'xf',
  'numFmt',
  'font',
  'fill',
  'border',
])

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => ARRAY_TAGS.has(name),
})

type X = any // fast-xml-parser's untyped tree; every access below is guarded

const arr = (v: X): X[] => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v])
const txt = (v: X): string =>
  typeof v === 'string' ? v : v && typeof v === 'object' ? String(v['#text'] ?? '') : ''
const flag = (v: X): boolean =>
  v !== undefined && !(typeof v === 'object' && (v['@_val'] === '0' || v['@_val'] === 'false'))

const decodeXmlEscapes = (s: string) =>
  s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

function stringItem(si: X): { text: string; rich: boolean } {
  const direct = arr(si.t)
  if (direct.length) return { text: direct.map(txt).join(''), rich: false }
  const runs = arr(si.r)
  return { text: runs.map((r) => arr(r.t).map(txt).join('')).join(''), rich: runs.length > 0 }
}

function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref)
  return m ? { col: colToNumber(m[1]), row: Number(m[2]) } : null
}

function argb(c: X): string | null {
  const rgb = c?.['@_rgb']
  return typeof rgb === 'string' && /^[0-9A-Fa-f]{8}$/.test(rgb)
    ? `#${rgb.slice(2).toUpperCase()}`
    : null
}

const BORDER_WIDTH: Record<string, string> = {
  hair: '0.25pt solid',
  thin: '0.75pt solid',
  dotted: '0.75pt dotted',
  dashed: '0.75pt dashed',
  medium: '1.5pt solid',
  thick: '2.25pt solid',
  double: '2.25pt double',
}

interface Xf {
  numFmtId: number
  font: X
  fill: X
  border: X
  align: X
}

class Dropped {
  private map = new Map<string, { n: number; example?: string }>()
  add(kind: string, n = 1, example?: string) {
    const e = this.map.get(kind) ?? { n: 0, example }
    e.n += n
    this.map.set(kind, e)
  }
  list(): string[] {
    return [...this.map].map(([k, v]) => `${k}: ${v.n}${v.example ? ` (e.g. ${v.example})` : ''}`)
  }
}

/** Resolves xf indexes into deduped ODF automatic styles. */
class StyleBook {
  fmts = new Map<string, Fmt | null>()
  dataStyles: string[] = []
  cellStyles: string[] = []
  private cellNames = new Map<string, string>()
  fonts = new Set<string>()
  colStyles: string[] = []
  private colNames = new Map<string, string>()
  rowStyles: string[] = []
  private rowNames = new Map<string, string>()

  constructor(
    private xfs: Xf[],
    private numFmts: Map<number, string>,
    private baseFont: X,
    private dropped: Dropped,
  ) {}

  fmtOf(xfIndex: number): Fmt | null {
    const id = this.xfs[xfIndex]?.numFmtId ?? 0
    if (id === 0) return null
    const code = this.numFmts.get(id) ?? BUILTIN_FORMATS[id]
    if (!code) {
      if (id === 12 || id === 13)
        this.dropped.add('number formats without ODF equivalent (fractions)')
      return null
    }
    if (!this.fmts.has(code)) {
      const f = translateNumberFormat(code)
      if (!f) this.dropped.add('number formats without ODF equivalent', 1, code)
      else if (f.lossy) this.dropped.add('number format negative/zero/text sections', 1, code)
      this.fmts.set(code, f)
      if (f?.build) {
        f.styleName = `N${this.dataStyles.length + 1}`
        this.dataStyles.push(f.build(f.styleName))
      }
    }
    return this.fmts.get(code) ?? null
  }

  /** boolean cells without their own style: LibreOffice shows 1/0 unless the cell has a boolean format */
  boolStyle(): string {
    if (!this.dataStyles.some((d) => d.includes('boolean-style'))) {
      this.dataStyles.push(
        '<number:boolean-style style:name="NB"><number:boolean/></number:boolean-style>',
      )
      this.cellStyles.push(
        '<style:style style:name="ceB" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="NB"/>',
      )
    }
    return 'ceB'
  }

  cellStyle(xfIndex: number): string | null {
    const xf = this.xfs[xfIndex]
    if (!xf) return null
    const dataName = this.fmtOf(xfIndex)?.styleName

    const text: string[] = []
    const f = xf.font ?? {}
    const bf = this.baseFont ?? {}
    if (flag(f.b)) text.push('fo:font-weight="bold"')
    if (flag(f.i)) text.push('fo:font-style="italic"')
    if (flag(f.u))
      text.push(
        'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"',
      )
    if (flag(f.strike)) text.push('style:text-line-through-style="solid"')
    const color = argb(f.color)
    if (color) text.push(`fo:color="${color}"`)
    else if (f.color && !f.color['@_auto']) this.dropped.add('theme/indexed colors')
    const name = f.name?.['@_val']
    if (name && name !== bf.name?.['@_val']) {
      this.fonts.add(name)
      text.push(`style:font-name="${esc(name)}"`)
    }
    const sz = f.sz?.['@_val']
    if (sz && sz !== bf.sz?.['@_val']) text.push(`fo:font-size="${esc(sz)}pt"`)

    const cell: string[] = []
    const pf = xf.fill?.patternFill
    if (pf?.['@_patternType'] === 'solid') {
      const bg = argb(pf.fgColor)
      if (bg) cell.push(`fo:background-color="${bg}"`)
      else this.dropped.add('theme/indexed colors')
    }
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const b = xf.border?.[side]
      const style = b?.['@_style']
      if (style)
        cell.push(
          `fo:border-${side}="${BORDER_WIDTH[style] ?? '0.75pt solid'} ${argb(b.color) ?? '#000000'}"`,
        )
    }
    if (xf.align?.['@_wrapText'] === '1') cell.push('fo:wrap-option="wrap"')
    const va = xf.align?.['@_vertical']
    if (va === 'top' || va === 'bottom' || va === 'center')
      cell.push(`style:vertical-align="${va === 'center' ? 'middle' : va}"`)

    const para: string[] = []
    const ha = xf.align?.['@_horizontal']
    if (ha === 'left') para.push('fo:text-align="start"')
    else if (ha === 'right') para.push('fo:text-align="end"')
    else if (ha === 'center') para.push('fo:text-align="center"')
    else if (ha === 'justify') para.push('fo:text-align="justify"')
    const indent = Number(xf.align?.['@_indent'] ?? 0)
    if (indent > 0) para.push(`fo:margin-left="${(indent * 3).toFixed(0)}mm"`)

    if (!dataName && !text.length && !cell.length && !para.length) return null
    const key = [dataName, text.join(' '), cell.join(' '), para.join(' ')].join('|')
    let out = this.cellNames.get(key)
    if (!out) {
      out = `ce${this.cellNames.size + 1}`
      this.cellNames.set(key, out)
      this.cellStyles.push(
        `<style:style style:name="${out}" style:family="table-cell" style:parent-style-name="Default"` +
          `${dataName ? ` style:data-style-name="${dataName}"` : ''}>` +
          (para.length ? `<style:paragraph-properties ${para.join(' ')}/>` : '') +
          (text.length ? `<style:text-properties ${text.join(' ')}/>` : '') +
          (cell.length ? `<style:table-cell-properties ${cell.join(' ')}/>` : '') +
          '</style:style>',
      )
    }
    return out
  }

  colStyle(widthChars: number): string {
    const inches = ((widthChars * 7) / 96).toFixed(4)
    let name = this.colNames.get(inches)
    if (!name) {
      name = `co${this.colNames.size + 1}`
      this.colNames.set(inches, name)
      this.colStyles.push(
        `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${inches}in" fo:break-before="auto"/></style:style>`,
      )
    }
    return name
  }

  rowStyle(heightPt: number): string {
    const h = heightPt.toFixed(2)
    let name = this.rowNames.get(h)
    if (!name) {
      name = `ro${this.rowNames.size + 1}`
      this.rowNames.set(h, name)
      this.rowStyles.push(
        `<style:style style:name="${name}" style:family="table-row"><style:table-row-properties style:row-height="${h}pt" style:use-optimal-row-height="false" fo:break-before="auto"/></style:style>`,
      )
    }
    return name
  }
}

// ───────────────────────── value / text emission ─────────────────────────

// eslint-disable-next-line no-control-regex
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

function paragraphs(text: string, href?: string): string {
  const clean = text.replace(XML_BAD, '')
  return clean
    .split(/\r\n|\r|\n/)
    .map((line, idx) => {
      const body = esc(line)
        .replace(/\t/g, '<text:tab/>')
        .replace(/^ +| {2,}/g, (run, offset: number) =>
          offset === 0
            ? `<text:s text:c="${run.length}"/>`
            : ` <text:s text:c="${run.length - 1}"/>`,
        )
      const linked =
        href && idx === 0
          ? `<text:a xlink:type="simple" xlink:href="${esc(href)}">${body}</text:a>`
          : body
      return `<text:p>${linked}</text:p>`
    })
    .join('')
}

function serialToIso(serial: number, date1904: boolean, withTime: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null
  let epoch: number
  if (date1904) epoch = Date.UTC(1904, 0, 1)
  else if (serial < 1 || serial === 60 || (serial > 60 && serial < 61)) return null
  else epoch = serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)
  const sec = Math.round(serial * 86400)
  const iso = new Date(epoch + sec * 1000).toISOString()
  return withTime || sec % 86400 !== 0 ? iso.slice(0, 19) : iso.slice(0, 10)
}

function timeValue(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null
  const sec = Math.round(serial * 86400)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `PT${h}H${String(m).padStart(2, '0')}M${String(sec % 60).padStart(2, '0')}S`
}

interface RawCell {
  col: number
  xf: number
  t: string
  v: string
  formula: string | null // already ODF
  href?: string
  covered?: boolean
  spanCols?: number
  spanRows?: number
}

interface RowData {
  ht?: number
  hidden: boolean
  cells: RawCell[]
}

// ───────────────────────── main ─────────────────────────

function resolveTarget(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" ' +
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"'

export async function convertXlsxToOds(xlsx: Uint8Array): Promise<XlsxToOdsResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(xlsx)
  } catch {
    throw new OdfConvertError('unreadable')
  }
  const read = async (path: string): Promise<string | null> =>
    (await zip.file(path)?.async('string')) ?? null
  const parse = (xml: string | null): X => {
    if (xml === null) return {}
    try {
      return xmlParser.parse(xml)
    } catch {
      return {}
    }
  }
  const dropped = new Dropped()

  const wbXml = await read('xl/workbook.xml')
  if (wbXml === null) throw new OdfConvertError('unreadable')
  const wb = parse(wbXml).workbook
  if (!wb) throw new OdfConvertError('unreadable')
  const date1904 = flag(wb.workbookPr) && ['1', 'true'].includes(wb.workbookPr?.['@_date1904'])
  const rels = new Map<string, { target: string; type: string; external: boolean }>()
  for (const r of arr(parse(await read('xl/_rels/workbook.xml.rels')).Relationships?.Relationship))
    rels.set(r['@_Id'], {
      target: r['@_Target'],
      type: r['@_Type'] ?? '',
      external: r['@_TargetMode'] === 'External',
    })

  // shared strings
  const shared: Array<{ text: string; rich: boolean }> = arr(
    parse(await read('xl/sharedStrings.xml')).sst?.si,
  ).map(stringItem)

  // styles
  const st = parse(await read('xl/styles.xml')).styleSheet ?? {}
  const numFmts = new Map<number, string>()
  for (const n of arr(st.numFmts?.numFmt)) numFmts.set(Number(n['@_numFmtId']), n['@_formatCode'])
  const fonts = arr(st.fonts?.font)
  const fills = arr(st.fills?.fill)
  const borders = arr(st.borders?.border)
  const xfs: Xf[] = arr(st.cellXfs?.xf).map((x) => ({
    numFmtId: Number(x['@_numFmtId'] ?? 0),
    font: Number(x['@_fontId'] ?? 0) ? fonts[Number(x['@_fontId'])] : undefined,
    fill: Number(x['@_fillId'] ?? 0) > 1 ? fills[Number(x['@_fillId'])] : undefined,
    border: Number(x['@_borderId'] ?? 0) ? borders[Number(x['@_borderId'])] : undefined,
    align: x.alignment,
  }))
  const book = new StyleBook(xfs, numFmts, fonts[0], dropped)

  // defined names
  const nameSet = new Set<string>()
  const definedRaw: Array<{ name: string; text: string }> = []
  for (const d of arr(wb.definedNames?.definedName)) {
    const name = d['@_name'] as string
    if (name.startsWith('_xlnm.')) {
      dropped.add(`built-in names (${name.slice(6)})`)
      continue
    }
    if (d['@_localSheetId'] !== undefined) {
      dropped.add('sheet-scoped defined names')
      continue
    }
    nameSet.add(name.toUpperCase())
    definedRaw.push({ name, text: txt(d) })
  }

  const sheetEntries = arr(wb.sheets?.sheet)
  const sheetNames = sheetEntries.map((s) => s['@_name'] as string)
  const hiddenSheetStyles: string[] = []
  const sheetXml: string[] = []
  let totalCells = 0
  let coveredBudget = MAX_COVERED_CELLS
  let budget = MAX_CELLS
  let sheetsOut = 0
  const cellStyleOf = (xf: number) => book.cellStyle(xf)

  for (const entry of sheetEntries) {
    const rel = rels.get(entry['@_r:id'])
    const name = entry['@_name'] as string
    if (!rel || rel.external) {
      dropped.add('sheets with missing part')
      continue
    }
    if (/chartsheet$/.test(rel.type)) {
      dropped.add('chartsheets')
      continue
    }
    const path = resolveTarget('xl/workbook.xml', rel.target)
    const raw = await read(path)
    if (raw === null) {
      dropped.add('sheets with missing part')
      continue
    }
    const ws = parse(raw).worksheet ?? {}
    sheetsOut++

    // sheet-level constructs with no ODF counterpart here
    if (ws.conditionalFormatting)
      dropped.add('conditional formatting', arr(ws.conditionalFormatting).length)
    if (ws.dataValidations)
      dropped.add('data validation', arr(ws.dataValidations.dataValidation).length || 1)
    if (ws.autoFilter) dropped.add('autofilter')
    if (ws.sheetViews?.sheetView?.pane || arr(ws.sheetViews?.sheetView)[0]?.pane)
      dropped.add('frozen panes')
    const relsPath = path.replace(/([^/]+)$/, '_rels/$1.rels')
    const sheetRels = new Map<string, { target: string; type: string; external: boolean }>()
    for (const r of arr(parse(await read(relsPath)).Relationships?.Relationship)) {
      const info = {
        target: r['@_Target'],
        type: r['@_Type'] ?? '',
        external: r['@_TargetMode'] === 'External',
      }
      sheetRels.set(r['@_Id'], info)
      if (/\/comments$/.test(info.type)) dropped.add('comments')
      else if (/\/pivotTable$/.test(info.type)) dropped.add('pivot tables')
      else if (/\/table$/.test(info.type)) dropped.add('table objects')
      else if (/\/drawing$/.test(info.type) && !info.external) {
        const d = (await read(resolveTarget(path, info.target))) ?? ''
        const charts = (d.match(/<c:chart[\s>]/g) ?? []).length
        const pics = (d.match(/<(?:xdr:)?pic[\s>]/g) ?? []).length
        const shapes = (d.match(/<(?:xdr:)?sp[\s>]/g) ?? []).length
        if (charts) dropped.add('charts', charts)
        if (pics) dropped.add('images', pics)
        if (shapes) dropped.add('shapes', shapes)
      }
    }

    // hyperlinks by cell
    const links = new Map<string, string>()
    for (const h of arr(ws.hyperlinks?.hyperlink)) {
      let href: string | null = null
      const rid = h['@_r:id']
      if (rid && sheetRels.get(rid)?.external) href = sheetRels.get(rid)!.target
      else if (h['@_location']) {
        const loc = String(h['@_location']).replace(/!/g, '.')
        href = /^[^'"]*$/.test(loc) ? `#${loc}` : null
      }
      const ref = String(h['@_ref'] ?? '')
      const [a, b] = ref.split(':')
      const pa = parseRef(a)
      const pb = b ? parseRef(b) : pa
      if (!href || !pa || !pb || (pb.col - pa.col + 1) * (pb.row - pa.row + 1) > 1000) {
        dropped.add('hyperlinks')
        continue
      }
      for (let r = pa.row; r <= pb.row; r++)
        for (let c = pa.col; c <= pb.col; c++) links.set(`${c},${r}`, href)
    }

    // rows / cells
    const rows = new Map<number, RowData>()
    const getRow = (n: number) => {
      let r = rows.get(n)
      if (!r) rows.set(n, (r = { hidden: false, cells: [] }))
      return r
    }
    const sharedFormulas = new Map<string, { text: string; col: number; row: number }>()
    const names = nameSet
    let rowCursor = 0
    let skipped = 0
    for (const row of arr(ws.sheetData?.row)) {
      const rn = row['@_r'] ? Number(row['@_r']) : rowCursor + 1
      rowCursor = rn
      const rd = getRow(rn)
      if (row['@_ht'] !== undefined && row['@_customHeight'] !== '0') rd.ht = Number(row['@_ht'])
      if (row['@_hidden'] === '1' || row['@_hidden'] === 'true') rd.hidden = true
      let colCursor = 0
      for (const c of arr(row.c)) {
        const pos = c['@_r'] ? parseRef(c['@_r']) : null
        const col = pos ? pos.col : colCursor + 1
        colCursor = col
        const t = c['@_t'] ?? 'n'
        let v: string
        let rich = false
        if (t === 's') {
          const s = shared[Number(txt(c.v))]
          v = s ? s.text : ''
          rich = !!s?.rich
        } else if (t === 'inlineStr') {
          const s = stringItem(c.is ?? {})
          v = s.text
          rich = s.rich
        } else v = txt(c.v)
        if (rich) dropped.add('rich-text formatting (plain text kept)')
        if (t === 's' || t === 'inlineStr' || t === 'str') v = decodeXmlEscapes(v)

        let formula: string | null = null
        const f = c.f
        if (f !== undefined) {
          const ftype = typeof f === 'object' ? f['@_t'] : undefined
          let text = txt(f)
          let dR = 0
          let dC = 0
          if (ftype === 'shared') {
            const si = String(f['@_si'])
            if (text) sharedFormulas.set(si, { text, col, row: rn })
            else {
              const m = sharedFormulas.get(si)
              if (m) {
                text = m.text
                dR = rn - m.row
                dC = col - m.col
              }
            }
          }
          if (ftype === 'array' || ftype === 'dataTable') {
            dropped.add(
              `${ftype === 'array' ? 'array' : 'data-table'} formulas (cached value kept)`,
            )
          } else if (text) {
            formula = translateFormulaToOds(text, { names, dRow: dR, dCol: dC })
            if (!formula)
              dropped.add(
                'formulas without safe ODF translation (cached value kept)',
                1,
                `${name}!${numberToCol(col)}${rn} =${text}`,
              )
          }
        }
        if (v === '' && formula === null && c.v === undefined && !Number(c['@_s'] ?? 0)) continue
        const nonEmpty = v !== '' || formula !== null
        if (nonEmpty && budget <= 0) {
          skipped++
          continue
        }
        if (nonEmpty) budget--
        rd.cells.push({
          col,
          xf: Number(c['@_s'] ?? 0),
          t,
          v,
          formula,
          href: links.get(`${col},${rn}`),
        })
      }
    }
    if (skipped) dropped.add(`cells beyond the ${MAX_CELLS} cell limit`, skipped)

    // merged cells
    for (const m of arr(ws.mergeCells?.mergeCell)) {
      const [a, b] = String(m['@_ref']).split(':')
      const pa = parseRef(a)
      const pb = b ? parseRef(b) : null
      if (!pa || !pb) continue
      const area = (pb.col - pa.col + 1) * (pb.row - pa.row + 1)
      if (area > coveredBudget) {
        dropped.add('merged ranges beyond the covered-cell limit')
        continue
      }
      coveredBudget -= area
      const topRow = getRow(pa.row)
      let anchor = topRow.cells.find((c) => c.col === pa.col)
      if (!anchor)
        topRow.cells.push((anchor = { col: pa.col, xf: 0, t: 'n', v: '', formula: null }))
      anchor.spanCols = pb.col - pa.col + 1
      anchor.spanRows = pb.row - pa.row + 1
      for (let r = pa.row; r <= pb.row; r++) {
        const rd = getRow(r)
        for (let c = pa.col; c <= pb.col; c++) {
          if (r === pa.row && c === pa.col) continue
          const existing = rd.cells.find((x) => x.col === c)
          if (existing) {
            existing.covered = true
            existing.v = ''
            existing.formula = null
          } else rd.cells.push({ col: c, xf: 0, t: 'n', v: '', formula: null, covered: true })
        }
      }
    }

    // columns
    const colDefs = arr(ws.cols?.col)
      .map((c) => ({
        min: Number(c['@_min']),
        max: Math.min(Number(c['@_max']), MAX_COL),
        width: c['@_width'] !== undefined ? Number(c['@_width']) : null,
        hidden: c['@_hidden'] === '1' || c['@_hidden'] === 'true',
        xf: Number(c['@_style'] ?? 0),
      }))
      .filter((c) => c.min >= 1 && c.max >= c.min)
      .sort((a, b) => a.min - b.min)

    let cellsHere = 0
    const out: string[] = []
    const tableStyle = entry['@_state'] === 'hidden' || entry['@_state'] === 'veryHidden'
    let tName = ''
    if (tableStyle) {
      tName = `ta${hiddenSheetStyles.length + 1}`
      hiddenSheetStyles.push(
        `<style:style style:name="${tName}" style:family="table"><style:table-properties table:display="false"/></style:style>`,
      )
    }
    out.push(
      `<table:table table:name="${esc(name)}"${tName ? ` table:style-name="${tName}"` : ''}>`,
    )
    let nextCol = 1
    const emptyCol = (n: number) =>
      `<table:table-column${n > 1 ? ` table:number-columns-repeated="${n}"` : ''}/>`
    for (const c of colDefs) {
      if (c.min < nextCol) continue
      if (c.min > nextCol) out.push(emptyCol(c.min - nextCol))
      const n = c.max - c.min + 1
      const dflt = c.xf ? cellStyleOf(c.xf) : null
      out.push(
        `<table:table-column${c.width !== null ? ` table:style-name="${book.colStyle(c.width)}"` : ''}` +
          `${n > 1 ? ` table:number-columns-repeated="${n}"` : ''}${c.hidden ? ' table:visibility="collapse"' : ''}` +
          `${dflt ? ` table:default-cell-style-name="${dflt}"` : ''}/>`,
      )
      nextCol = c.max + 1
    }
    if (!colDefs.length) out.push(emptyCol(1))

    let nextRow = 1
    for (const rn of [...rows.keys()].sort((a, b) => a - b)) {
      const rd = rows.get(rn)!
      if (rn > MAX_ROW) continue
      if (rn > nextRow) {
        const gap = rn - nextRow
        out.push(
          `<table:table-row${gap > 1 ? ` table:number-rows-repeated="${gap}"` : ''}><table:table-cell/></table:table-row>`,
        )
      }
      nextRow = rn + 1
      rd.cells.sort((a, b) => a.col - b.col)
      const cellsXml: string[] = []
      let cursor = 1
      let pending: { style: string | null; n: number } | null = null
      const flush = () => {
        if (!pending) return
        cellsXml.push(
          `<table:table-cell${pending.style ? ` table:style-name="${pending.style}"` : ''}${pending.n > 1 ? ` table:number-columns-repeated="${pending.n}"` : ''}/>`,
        )
        pending = null
      }
      const addEmpty = (style: string | null, n: number) => {
        if (pending && pending.style === style) pending.n += n
        else {
          flush()
          pending = { style, n }
        }
      }
      for (const c of rd.cells) {
        if (c.col < cursor) continue // duplicate column in malformed input
        if (c.col > cursor) addEmpty(null, c.col - cursor)
        cursor = c.col + 1
        if (c.covered) {
          flush()
          cellsXml.push('<table:covered-table-cell/>')
          continue
        }
        const fmt = book.fmtOf(c.xf)
        const style = cellStyleOf(c.xf) ?? (c.t === 'b' && c.v !== '' ? book.boolStyle() : null)
        const body = cellBody(c, fmt, date1904)
        if (!body) {
          if (c.spanCols || c.spanRows) {
            flush()
            cellsXml.push(
              `<table:table-cell${style ? ` table:style-name="${style}"` : ''}${spanAttrs(c)}/>`,
            )
          } else addEmpty(style, 1)
          continue
        }
        flush()
        cellsXml.push(
          `<table:table-cell${style ? ` table:style-name="${style}"` : ''}${spanAttrs(c)}${body}</table:table-cell>`,
        )
        cellsHere++
      }
      flush()
      const rowAttrs =
        (rd.ht ? ` table:style-name="${book.rowStyle(rd.ht)}"` : '') +
        (rd.hidden ? ' table:visibility="collapse"' : '')
      out.push(
        `<table:table-row${rowAttrs}>${cellsXml.join('') || '<table:table-cell/>'}</table:table-row>`,
      )
    }
    out.push('</table:table>')
    totalCells += cellsHere
    sheetXml.push(out.join(''))
  }

  // defined names → table:named-expressions
  const named: string[] = []
  for (const d of definedRaw) {
    const m =
      /^(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?$/.exec(
        d.text.trim(),
      )
    const sheet = m?.[1] ? m[1].replace(/^'|'$/g, '').replace(/''/g, "'") : null
    if (m && sheet && sheetNames.includes(sheet)) {
      const addr = `$${odfSheet(sheet)}.${m[2]}${m[3] ? `:.${m[3]}` : ''}`
      named.push(
        `<table:named-range table:name="${esc(d.name)}" table:base-cell-address="$${odfSheet(sheet)}.${m[2]}" table:cell-range-address="${esc(addr)}"/>`,
      )
      continue
    }
    const expr = translateFormulaToOds(d.text.trim(), { names: nameSet })
    if (expr)
      named.push(
        `<table:named-expression table:name="${esc(d.name)}" table:expression="${esc(expr.slice(4))}"/>`,
      )
    else dropped.add('defined names without safe ODF translation', 1, d.name)
  }
  if (arr(wb.pivotCaches?.pivotCache).length)
    dropped.add('pivot caches', arr(wb.pivotCaches.pivotCache).length)

  const fontDecls = [...book.fonts]
    .map((f) => `<style:font-face style:name="${esc(f)}" svg:font-family="${esc(f)}"/>`)
    .join('')
  const content =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3">` +
    `<office:font-face-decls>${fontDecls}</office:font-face-decls>` +
    `<office:automatic-styles>${book.dataStyles.join('')}${book.cellStyles.join('')}${book.colStyles.join('')}${book.rowStyles.join('')}${hiddenSheetStyles.join('')}</office:automatic-styles>` +
    `<office:body><office:spreadsheet>` +
    `<table:calculation-settings><table:null-date table:date-value="${date1904 ? '1904-01-01' : '1899-12-30'}"/></table:calculation-settings>` +
    sheetXml.join('') +
    (named.length ? `<table:named-expressions>${named.join('')}</table:named-expressions>` : '') +
    `</office:spreadsheet></office:body></office:document-content>`

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3">` +
    `<office:styles><style:default-style style:family="table-cell"/><style:style style:name="Default" style:family="table-cell"/></office:styles>` +
    `<office:automatic-styles/><office:master-styles/></office:document-styles>`
  const metaXml =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS} office:version="1.3"><office:meta>` +
    `<meta:generator>SelfOffice odf2ooxml</meta:generator></office:meta></office:document-meta>`
  const manifest =
    `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">` +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>` +
    `<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>` +
    `<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>` +
    `<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>` +
    `</manifest:manifest>`

  const out = new JSZip()
  out.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' })
  out.file('META-INF/manifest.xml', manifest)
  out.file('content.xml', content)
  out.file('styles.xml', stylesXml)
  out.file('meta.xml', metaXml)
  const ods = await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { ods, sheets: sheetsOut, cells: totalCells, dropped: dropped.list() }
}

function spanAttrs(c: RawCell): string {
  return (
    (c.spanCols && c.spanCols > 1 ? ` table:number-columns-spanned="${c.spanCols}"` : '') +
    (c.spanRows && c.spanRows > 1 ? ` table:number-rows-spanned="${c.spanRows}"` : '')
  )
}

/** Value attributes + text:p for one cell, starting inside the open tag (returns `>...` or '' when empty). */
function cellBody(c: RawCell, fmt: Fmt | null, date1904: boolean): string {
  const formulaAttr = c.formula ? ` table:formula="${esc(c.formula)}"` : ''
  const hasValue = c.v !== ''
  if (!hasValue && !c.formula) return ''
  const str = (s: string, display = s) =>
    `${formulaAttr} office:value-type="string"${c.formula ? ` office:string-value="${esc(s.replace(XML_BAD, ''))}"` : ''}>${paragraphs(display, c.href)}`

  if (c.t === 'b') {
    const b = c.v === '1' || c.v === 'true'
    return `${formulaAttr} office:value-type="boolean" office:boolean-value="${b}"><text:p>${b ? 'TRUE' : 'FALSE'}</text:p>`
  }
  if (c.t === 'e') return str(c.v) // ODF has no error cell type: the error text is kept as a string
  if (c.t === 's' || c.t === 'inlineStr' || c.t === 'str' || c.t === 'd') {
    if (c.t === 'd' && /^\d{4}-\d{2}-\d{2}/.test(c.v))
      return `${formulaAttr} office:value-type="date" office:date-value="${esc(c.v)}"><text:p>${esc(c.v)}</text:p>`
    return str(c.v)
  }
  if (!hasValue) return `${formulaAttr}>` // formula without cached value: let the consumer calculate
  const num = Number(c.v)
  if (!Number.isFinite(num)) return str(c.v)
  const shown = `<text:p>${esc(c.v)}</text:p>`
  switch (fmt?.kind) {
    case 'date': {
      const iso = serialToIso(num, date1904, !!fmt.hasTime)
      // the paragraph is the cached display text: the ISO date, not the serial
      if (iso)
        return `${formulaAttr} office:value-type="date" office:date-value="${iso}"><text:p>${iso.replace('T', ' ')}</text:p>`
      break
    }
    case 'time': {
      const tv = timeValue(num)
      if (tv) return `${formulaAttr} office:value-type="time" office:time-value="${tv}">${shown}`
      break
    }
    case 'percent':
      return `${formulaAttr} office:value-type="percentage" office:value="${esc(c.v)}">${shown}`
    case 'currency':
      return `${formulaAttr} office:value-type="currency" office:currency="${fmt.currency}" office:value="${esc(c.v)}">${shown}`
  }
  return `${formulaAttr} office:value-type="float" office:value="${esc(c.v)}">${shown}`
}
