/**
 * .ods save-back by diff: patchOds(O, B, C) rewrites the original package O so
 * that its cells match the edited workbook C, where B is the .xlsx the import
 * (apps/sheets/native/xlsx-engine/src/convert.rs) produced from O.
 *
 * B and C are both run through the export filter (xlsx-ods.ts), so they are
 * compared in one ODF dialect with style names resolved to their definitions.
 * Per sheet:
 *  - equal grid and layout → the original table:table bytes are kept;
 *  - a cell-local change → only the changed table:table-cell elements of the
 *    original content.xml are replaced (repeated runs are split around them,
 *    validations, annotations and cell-anchored shapes of the cell survive);
 *  - a structural change (row/column shift, merges, sizes, mass edit) → that
 *    sheet alone is re-serialised from C's export and reported in `dropped`.
 * content.xml is edited as raw text spans located by a tolerant scanner, so
 * every untouched region (charts, conditional formats, validations, unknown
 * namespaces) is copied verbatim; every other zip entry is copied as is.
 *
 * Anything inconsistent throws OdfPatchError so the caller can fall back to a
 * plain export instead of writing a corrupt file.
 */

import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { exceedsCap, inflateCapped } from './odf'
import { OdfPatchError } from './patch-error'
import { convertXlsxToOds } from './xlsx-ods'

export { OdfPatchError }

export interface OdsPatchResult {
  ods: Uint8Array
  cellsChanged: number
  sheetsRewritten: number
  sheetsKept: number
  dropped: string[]
}

/** expanded non-empty cells one grid may hold (repeated runs multiply) */
export const MAX_PATCH_GRID_CELLS = 2_000_000
const MAX_REPEAT = 1 << 24
/** above this share of changed cells a sheet is re-serialised instead of patched */
const LOCAL_CHANGE_RATIO = 0.3

// ───────────────────────── tolerant XML span scanner ─────────────────────────

interface El {
  name: string
  start: number
  /** index just past the open tag's '>' */
  openEnd: number
  /** index just past the element (=== openEnd when self-closing) */
  end: number
  children: El[]
}

const fail = (detail: string): never => {
  throw new OdfPatchError('malformed', detail)
}

/**
 * Element spans of xml[from, to). Top-level elements are always recorded; an
 * element's children only when `container(name)` holds, so cell text and
 * style bodies cost no nodes. Comments, PIs and CDATA are skipped.
 */
function scan(xml: string, from: number, to: number, container: (name: string) => boolean): El[] {
  const top: El[] = []
  const stack: Array<{ name: string; el: El | null }> = []
  let i = from
  for (;;) {
    const lt = xml.indexOf('<', i)
    if (lt < 0 || lt >= to) break
    const skip = (open: string, close: string) => {
      const e = xml.indexOf(close, lt + open.length)
      if (e < 0 || e + close.length > to) fail(`unterminated ${open}`)
      i = e + close.length
    }
    if (xml.startsWith('<!--', lt)) skip('<!--', '-->')
    else if (xml.startsWith('<![CDATA[', lt)) skip('<![CDATA[', ']]>')
    else if (xml.startsWith('<?', lt)) skip('<?', '?>')
    else if (xml[lt + 1] === '!') fail('doctype')
    else if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt)
      if (gt < 0 || gt >= to) fail('unterminated end tag')
      const name = xml.slice(lt + 2, gt).trim()
      const open = stack.pop()
      if (!open || open.name !== name) fail(`unexpected </${name}>`)
      if (open!.el) open!.el.end = gt + 1
      i = gt + 1
    } else {
      let j = lt + 1
      let quote = 0
      for (; j < to; j++) {
        const ch = xml.charCodeAt(j)
        if (quote) {
          if (ch === quote) quote = 0
        } else if (ch === 34 || ch === 39) quote = ch
        else if (ch === 62) break
      }
      if (j >= to) fail('unterminated tag')
      let k = lt + 1
      while (k < j && !/[\s/>]/.test(xml[k])) k++
      const name = xml.slice(lt + 1, k)
      if (!name) fail('empty tag name')
      const parent = stack[stack.length - 1]
      let el: El | null = null
      if (!parent || (parent.el && container(parent.name))) {
        el = { name, start: lt, openEnd: j + 1, end: j + 1, children: [] }
        ;(parent ? parent.el!.children : top).push(el)
      }
      if (xml.charCodeAt(j - 1) !== 47) stack.push({ name, el })
      i = j + 1
    }
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1].name}>`)
  return top
}

const ROW_CONTAINERS = new Set([
  'table:table-row-group',
  'table:table-header-rows',
  'table:table-rows',
])
const CONTENT_CONTAINERS = new Set([
  'office:document-content',
  'office:body',
  'office:spreadsheet',
  'office:automatic-styles',
  'office:font-face-decls',
  'table:table',
  'table:table-row',
  ...ROW_CONTAINERS,
])
const isContentContainer = (n: string) => CONTENT_CONTAINERS.has(n)

const child = (el: El, name: string) => el.children.find((c) => c.name === name)

// ───────────────────────── tag / attribute helpers ─────────────────────────

const attrRes = new Map<string, RegExp>()
function attrRe(name: string): RegExp {
  let re = attrRes.get(name)
  if (!re) {
    re = new RegExp(`\\s${name.replace(/[.]/g, '\\.')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
    attrRes.set(name, re)
  }
  return re
}

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e === 'amp'
      ? '&'
      : e === 'lt'
        ? '<'
        : e === 'gt'
          ? '>'
          : e === 'quot'
            ? '"'
            : e === 'apos'
              ? "'"
              : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  )
const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function attr(tag: string, name: string): string | undefined {
  const m = attrRe(name).exec(tag)
  return m ? decode(m[1] ?? m[2]) : undefined
}

/** the raw ` name="value"` text of an attribute, for verbatim copies */
const attrRaw = (tag: string, name: string) => attrRe(name).exec(tag)?.[0].trim()

const openTag = (xml: string, el: El) => xml.slice(el.start, el.openEnd)
const inner = (xml: string, el: El) =>
  el.end === el.openEnd ? '' : xml.slice(el.openEnd, xml.lastIndexOf('</', el.end - 1))
const tagHead = (tag: string) => tag.replace(/\s*\/?>$/, '')
/** set (in place when present, appended otherwise) or remove one attribute */
const withAttr = (head: string, name: string, value: string | null) => {
  const set = value === null ? '' : ` ${name}="${escAttr(value)}"`
  return attrRe(name).test(head) ? head.replace(attrRe(name), set) : head + set
}

/** element text with its open tag rewritten by `fn` (works for self-closing ones) */
function retag(raw: string, tagLen: number, fn: (head: string) => string): string {
  const tag = raw.slice(0, tagLen)
  return fn(tagHead(tag)) + (tag.endsWith('/>') ? '/>' : '>') + raw.slice(tagLen)
}

function repeat(tag: string, name: string): number {
  const v = attr(tag, name)
  if (v === undefined) return 1
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT)
    throw new OdfPatchError('limits', `${name}="${v}"`)
  return n
}

/** apply non-overlapping [start, end, text] replacements to xml[from, to) */
function splice(
  xml: string,
  from: number,
  to: number,
  reps: Array<[number, number, string]>,
): string {
  reps.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let out = ''
  let at = from
  for (const [s, e, text] of reps) {
    if (s < at) throw new OdfPatchError('internal', 'overlapping edits')
    out += xml.slice(at, s) + text
    at = e
  }
  return out + xml.slice(at, to)
}

// ───────────────────────── table model ─────────────────────────

interface CellRun {
  el: El
  c0: number
  n: number
}
interface RowRun {
  el: El
  r0: number
  n: number
  cells: CellRun[]
}

const ROW = 'table:table-row'
const CELL = 'table:table-cell'
const COVERED = 'table:covered-table-cell'

function tableRows(xml: string, table: El): RowRun[] {
  const out: RowRun[] = []
  let r = 0
  const walk = (el: El) => {
    for (const ch of el.children) {
      if (ROW_CONTAINERS.has(ch.name)) walk(ch)
      else if (ch.name === ROW) {
        const n = repeat(openTag(xml, ch), 'table:number-rows-repeated')
        const cells: CellRun[] = []
        let c = 0
        for (const cell of ch.children) {
          if (cell.name !== CELL && cell.name !== COVERED) continue
          const m = repeat(openTag(xml, cell), 'table:number-columns-repeated')
          cells.push({ el: cell, c0: c, n: m })
          c += m
        }
        out.push({ el: ch, r0: r, n, cells })
        r += n
      }
    }
  }
  walk(table)
  return out
}

const key = (r: number, c: number) => `${r},${c}`
const VALUE_ATTRS = [
  'table:formula',
  'office:value-type',
  'calcext:value-type',
  'office:value',
  'office:date-value',
  'office:time-value',
  'office:boolean-value',
  'office:string-value',
  'office:currency',
]
const hasValue = (tag: string) =>
  attrRe('office:value-type').test(tag) || attrRe('table:formula').test(tag)
const BARE_CELL = /^<table:table-cell(\s+table:number-columns-repeated="\d+")?\s*\/>$/

/** raw text of every cell (r,c) whose run passes `include`, repeated runs expanded */
function grid(
  xml: string,
  rows: RowRun[],
  include: (raw: string, el: El) => boolean,
  budget: { n: number },
): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of rows) {
    for (const run of row.cells) {
      const raw = xml.slice(run.el.start, run.el.end)
      if (!include(raw, run.el)) continue
      budget.n -= row.n * run.n
      if (budget.n < 0) throw new OdfPatchError('limits', 'too many expanded cells')
      for (let r = row.r0; r < row.r0 + row.n; r++)
        for (let c = run.c0; c < run.c0 + run.n; c++) out.set(key(r, c), raw)
    }
  }
  return out
}

/** raw text of the cell run covering key `r,c`, without expanding anything */
function cellAt(xml: string, rows: RowRun[], k: string): string | undefined {
  const [r, c] = k.split(',').map(Number)
  const run = rows
    .find((x) => r >= x.r0 && r < x.r0 + x.n)
    ?.cells.find((x) => c >= x.c0 && c < x.c0 + x.n)
  return run && xml.slice(run.el.start, run.el.end)
}

/** value attributes + paragraph text: what a cell shows, independent of style and anchors */
function valueSig(raw: string | undefined): string {
  if (!raw) return ''
  const [cell] = scan(raw, 0, raw.length, (n) => n === CELL || n === COVERED)
  const tag = openTag(raw, cell)
  const vals = VALUE_ATTRS.filter((a) => a !== 'calcext:value-type').map((a) => attr(tag, a) ?? '')
  const text = cell.children
    .filter((c) => c.name === 'text:p')
    .map((p) =>
      decode(
        inner(raw, p)
          .replace(/<text:s(?:\s+text:c="(\d+)")?\s*\/>/g, (_, n) => ' '.repeat(Number(n ?? 1)))
          .replace(/<[^>]*>/g, ''),
      ),
    )
    .join('\n')
  return `${vals.join('|')}|${text}`
}

// ───────────────────────── parsed content.xml ─────────────────────────

interface Doc {
  xml: string
  root: El
  autoStyles?: El
  fontDecls?: El
  spreadsheet: El
  tables: El[]
}

function parseDoc(xml: string): Doc {
  const root = scan(xml, 0, xml.length, isContentContainer).find(
    (e) => e.name === 'office:document-content',
  )
  if (!root) fail('no office:document-content')
  const body = child(root!, 'office:body')
  const spreadsheet = body && child(body, 'office:spreadsheet')
  if (!spreadsheet) fail('no office:spreadsheet')
  return {
    xml,
    root: root!,
    autoStyles: child(root!, 'office:automatic-styles'),
    fontDecls: child(root!, 'office:font-face-decls'),
    spreadsheet: spreadsheet!,
    tables: spreadsheet!.children.filter((c) => c.name === 'table:table'),
  }
}

const tableName = (doc: Doc, t: El) => attr(openTag(doc.xml, t), 'table:name') ?? ''

/** xmlns prefix → URI declared on the root element */
function namespaces(doc: Doc): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of openTag(doc.xml, doc.root).matchAll(/\sxmlns:([\w.-]+)\s*=\s*"([^"]*)"/g))
    out.set(m[1], m[2])
  return out
}

// ───────────────────────── export-side (B / C) model ─────────────────────────

const STYLE_REF = /(table:style-name|table:default-cell-style-name)="([^"]*)"/g

interface Exported {
  doc: Doc
  /** automatic style name → raw element */
  styles: Map<string, string>
  /** style name → definition with names resolved (comparison key) */
  sigs: Map<string, string>
  fonts: Map<string, string>
}

async function exportOf(xlsx: Uint8Array, which: string): Promise<Exported> {
  let xml: string
  try {
    const { ods } = await convertXlsxToOds(xlsx)
    xml = await (await JSZip.loadAsync(ods)).file('content.xml')!.async('string')
  } catch (err) {
    if (err instanceof OdfPatchError) throw err
    throw new OdfPatchError('unreadable', `${which} workbook`)
  }
  const doc = parseDoc(xml)
  const styles = new Map<string, string>()
  for (const s of doc.autoStyles?.children ?? [])
    styles.set(attr(openTag(xml, s), 'style:name') ?? '', xml.slice(s.start, s.end))
  const base = new Map([...styles].map(([n, raw]) => [n, raw.replace(attrRe('style:name'), '')]))
  const sigs = new Map(
    [...base].map(([n, raw]) => [
      n,
      raw.replace(/style:data-style-name="([^"]*)"/, (_, d: string) => `data=${base.get(d) ?? d}`),
    ]),
  )
  const fonts = new Map<string, string>()
  for (const f of doc.fontDecls?.children ?? [])
    fonts.set(attr(openTag(xml, f), 'style:name') ?? '', xml.slice(f.start, f.end))
  return { doc, styles, sigs, fonts }
}

const resolve = (ex: Exported, s: string) =>
  s.replace(STYLE_REF, (_, a: string, n: string) => `${a}="${ex.sigs.get(n) ?? n}"`)

const styleSig = (ex: Exported, raw: string | undefined) => {
  const n = raw && attr(raw.slice(0, raw.indexOf('>') + 1), 'table:style-name')
  return n ? (ex.sigs.get(n) ?? n) : ''
}

interface SheetView {
  name: string
  table: El
  cells: Map<string, string>
  norm: Map<string, string>
  layout: string
  values: number
}

function sheetView(ex: Exported, table: El, budget: { n: number }): SheetView {
  const xml = ex.doc.xml
  const rows = tableRows(xml, table)
  const cells = grid(xml, rows, (raw) => !BARE_CELL.test(raw), budget)
  const norm = new Map<string, string>()
  let values = 0
  for (const [k, raw] of cells) {
    const n = resolve(ex, raw.replace(attrRe('table:number-columns-repeated'), ''))
    norm.set(k, n)
    if (hasValue(raw.slice(0, raw.indexOf('>') + 1))) values++
  }
  const layout = [resolve(ex, withAttr(tagHead(openTag(xml, table)), 'table:name', null))]
  for (const c of table.children)
    if (c.name === 'table:table-column') layout.push(resolve(ex, xml.slice(c.start, c.end)))
  for (const r of rows) {
    const h = withAttr(tagHead(openTag(xml, r.el)), 'table:number-rows-repeated', null)
    if (h !== '<table:table-row') layout.push(`${r.r0}+${r.n}:${resolve(ex, h)}`)
  }
  return { name: tableName(ex.doc, table), table, cells, norm, layout: layout.join('\n'), values }
}

// ───────────────────────── style import into O ─────────────────────────

/** copies C-export automatic styles into O under fresh, collision-free names */
class StyleImporter {
  added: string[] = []
  fontsAdded: string[] = []
  private map = new Map<string, string>()
  constructor(
    private ex: Exported,
    private taken: Set<string>,
    private oFonts: Set<string>,
  ) {}

  take(name: string): string {
    const known = this.map.get(name)
    if (known) return known
    const raw = this.ex.styles.get(name)
    if (raw === undefined) throw new OdfPatchError('internal', `export style ${name} missing`)
    let fresh = `so${name}`
    for (let k = 2; this.taken.has(fresh); k++) fresh = `so${name}_${k}`
    this.taken.add(fresh)
    this.map.set(name, fresh)
    let out = raw.replace(attrRe('style:name'), ` style:name="${escAttr(fresh)}"`)
    out = out.replace(
      /style:data-style-name="([^"]*)"/,
      (_, d: string) => `style:data-style-name="${escAttr(this.take(decode(d)))}"`,
    )
    const font = attr(out, 'style:font-name')
    if (font && !this.oFonts.has(font)) {
      this.oFonts.add(font)
      const decl = this.ex.fonts.get(font)
      if (decl) this.fontsAdded.push(decl)
    }
    this.added.push(out)
    return fresh
  }

  /** export table/row/column/cell XML with every style reference moved to O names */
  remap(xml: string): string {
    return xml.replace(
      STYLE_REF,
      (_, a: string, n: string) => `${a}="${escAttr(this.take(decode(n)))}"`,
    )
  }
}

// ───────────────────────── in-place cell patch ─────────────────────────

/** a change that cannot be applied cell-locally; the sheet is re-serialised instead */
class NotLocal extends Error {}

const TEXT_CONTENT = new Set(['text:p', 'text:h', 'text:list'])

/**
 * The cell O had at this position with its value replaced by C's: every other
 * attribute (validation, spans, protection) and every non-text child
 * (annotation, cell-anchored shape) of the original survives.
 */
function freshCell(
  oRaw: string | null,
  cRaw: string | undefined,
  style: { keep: boolean; name: string | null },
): string {
  let head = '<table:table-cell'
  let kept = ''
  if (oRaw) {
    const [cell] = scan(oRaw, 0, oRaw.length, (n) => n === CELL || n === COVERED)
    if (cell.name === COVERED) throw new NotLocal()
    head = withAttr(tagHead(openTag(oRaw, cell)), 'table:number-columns-repeated', null)
    for (const ch of cell.children)
      if (!TEXT_CONTENT.has(ch.name)) kept += oRaw.slice(ch.start, ch.end)
  }
  for (const a of VALUE_ATTRS) head = withAttr(head, a, null)
  if (!style.keep || !oRaw) head = withAttr(head, 'table:style-name', style.name)
  let body = kept
  if (cRaw) {
    const [cell] = scan(cRaw, 0, cRaw.length, () => false)
    const tag = openTag(cRaw, cell)
    for (const a of VALUE_ATTRS) {
      const raw = attrRaw(tag, a)
      if (raw) head += ` ${raw}`
    }
    body += inner(cRaw, cell)
  }
  return body ? `${head}>${body}</table:table-cell>` : `${head}/>`
}

type CellEdit = (oRaw: string | null) => string

const filler = (tag: string, attrName: string, n: number, close: string) =>
  n < 1 ? '' : `<${tag}${n > 1 ? ` ${attrName}="${n}"` : ''}${close}`

/** the original table:table text with the edited cells replaced */
function patchTable(
  xml: string,
  table: El,
  rows: RowRun[],
  edits: Map<number, Map<number, CellEdit>>,
): string {
  const reps: Array<[number, number, string]> = []
  const runOf = (r: number) => rows.find((run) => r >= run.r0 && r < run.r0 + run.n)
  const byRun = new Map<RowRun, number[]>()
  const beyond: number[] = []
  for (const r of [...edits.keys()].sort((a, b) => a - b)) {
    const run = runOf(r)
    if (run) byRun.set(run, [...(byRun.get(run) ?? []), r])
    else beyond.push(r)
  }

  const editRow = (run: RowRun | null, cols: Map<number, CellEdit>): string => {
    const raw = run ? xml.slice(run.el.start, run.el.end) : '<table:table-row>'
    const tagLen = run ? run.el.openEnd - run.el.start : raw.length
    let head = withAttr(tagHead(raw.slice(0, tagLen)), 'table:number-rows-repeated', null)
    const cellReps: Array<[number, number, string]> = []
    const off = run ? run.el.start : 0
    const cellsEnd =
      run && run.el.end !== run.el.openEnd ? xml.lastIndexOf('</', run.el.end - 1) : -1
    const runs = run?.cells ?? []
    const byCell = new Map<CellRun, number[]>()
    const tail: number[] = []
    for (const c of [...cols.keys()].sort((a, b) => a - b)) {
      const cr = runs.find((x) => c >= x.c0 && c < x.c0 + x.n)
      if (cr) byCell.set(cr, [...(byCell.get(cr) ?? []), c])
      else tail.push(c)
    }
    for (const [cr, cs] of byCell) {
      const cellRaw = xml.slice(cr.el.start, cr.el.end)
      const len = cr.el.openEnd - cr.el.start
      const copy = (k: number) =>
        k < 1
          ? ''
          : retag(cellRaw, len, (h) =>
              withAttr(h, 'table:number-columns-repeated', k > 1 ? String(k) : null),
            )
      let text = ''
      let cur = cr.c0
      const single = retag(cellRaw, len, (h) => withAttr(h, 'table:number-columns-repeated', null))
      for (const c of cs) {
        text += copy(c - cur) + cols.get(c)!(single)
        cur = c + 1
      }
      text += copy(cr.c0 + cr.n - cur)
      cellReps.push([cr.el.start - off, cr.el.end - off, text])
    }
    let tailText = ''
    let next = runs.length ? runs[runs.length - 1].c0 + runs[runs.length - 1].n : 0
    for (const c of tail) {
      tailText += filler(CELL, 'table:number-columns-repeated', c - next, '/>') + cols.get(c)!(null)
      next = c + 1
    }
    const body = run && cellsEnd >= 0 ? splice(raw, tagLen, cellsEnd - off, cellReps) : ''
    head += '>'
    return `${head}${body}${tailText}</table:table-row>`
  }

  for (const [run, rs] of byRun) {
    const raw = xml.slice(run.el.start, run.el.end)
    const len = run.el.openEnd - run.el.start
    const copy = (k: number) =>
      k < 1
        ? ''
        : retag(raw, len, (h) =>
            withAttr(h, 'table:number-rows-repeated', k > 1 ? String(k) : null),
          )
    let text = ''
    let cur = run.r0
    for (const r of rs) {
      text += copy(r - cur) + editRow(run, edits.get(r)!)
      cur = r + 1
    }
    text += copy(run.r0 + run.n - cur)
    reps.push([run.el.start, run.el.end, text])
  }
  if (beyond.length) {
    const last = rows[rows.length - 1]
    if (!last && table.end === table.openEnd) throw new NotLocal()
    const at = last ? last.el.end : xml.lastIndexOf('</', table.end - 1)
    let next = last ? last.r0 + last.n : 0
    let text = ''
    for (const r of beyond) {
      text +=
        filler(
          ROW,
          'table:number-rows-repeated',
          r - next,
          '><table:table-cell/></table:table-row>',
        ) + editRow(null, edits.get(r)!)
      next = r + 1
    }
    reps.push([at, at, text])
  }
  return splice(xml, table.start, table.end, reps)
}

// ───────────────────────── main ─────────────────────────

/** what a re-serialised sheet loses, read off the original table */
function lossesOf(raw: string): string {
  const found = [
    ['table:shapes', 'charts/images/shapes'],
    ['calcext:conditional-formats', 'conditional formats'],
    ['table:content-validation-name', 'data validation'],
    ['office:annotation', 'comments'],
    ['table:table-row-group', 'row groups'],
  ]
    .filter(([needle]) => raw.includes(needle))
    .map(([, what]) => what)
  return ['original cell styles', ...found].join(', ')
}

export async function patchOds(
  original: Uint8Array,
  baselineXlsx: Uint8Array,
  currentXlsx: Uint8Array,
): Promise<OdsPatchResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(original, { createFolders: false })
  } catch {
    throw new OdfPatchError('unreadable', 'original package')
  }
  const entries = Object.values(zip.files)
  for (const e of entries) if (!e.dir && exceedsCap(e)) throw new OdfPatchError('limits', e.name)
  const contentEntry = zip.file('content.xml')
  if (!contentEntry) throw new OdfPatchError('unreadable', 'no content.xml')
  let contentBytes: Uint8Array
  try {
    contentBytes = await inflateCapped(contentEntry)
  } catch {
    throw new OdfPatchError('limits', 'content.xml')
  }
  const xml = new TextDecoder().decode(contentBytes)
  const o = parseDoc(xml)
  const [b, c] = [await exportOf(baselineXlsx, 'baseline'), await exportOf(currentXlsx, 'current')]

  // ── O ↔ B consistency: the baseline must be the import of this very file
  if (o.tables.length !== b.doc.tables.length) throw new OdfPatchError('mismatch', 'sheet count')
  const budget = { n: MAX_PATCH_GRID_CELLS }
  const oRows = o.tables.map((t) => tableRows(xml, t))
  const bViews = b.doc.tables.map((t) => sheetView(b, t, budget))
  const cViews = c.doc.tables.map((t) => sheetView(c, t, budget))
  if (!cViews.length) throw new OdfPatchError('mismatch', 'current workbook has no sheet')
  o.tables.forEach((t, i) => {
    if (tableName(o, t) !== bViews[i].name)
      throw new OdfPatchError('mismatch', `sheet ${i + 1} name`)
    const oCells = grid(
      xml,
      oRows[i],
      (raw) => hasValue(raw.slice(0, raw.indexOf('>') + 1)),
      budget,
    )
    const bCells = bViews[i].cells
    let bad = 0
    for (const [k, raw] of oCells) {
      const other = bCells.get(k)
      const tag = (s: string) => s.slice(0, s.indexOf('>') + 1)
      if (!other || !hasValue(tag(other))) bad++
      else if (
        attr(tag(raw), 'office:value-type') === 'float' &&
        attr(tag(other), 'office:value-type') === 'float'
      ) {
        const x = Number(attr(tag(raw), 'office:value'))
        const y = Number(attr(tag(other), 'office:value'))
        if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x))) bad++
      }
    }
    for (const [k, raw] of bCells)
      if (hasValue(raw.slice(0, raw.indexOf('>') + 1)) && !oCells.has(k)) bad++
    if (bad > Math.max(2, oCells.size * 0.01))
      throw new OdfPatchError(
        'mismatch',
        `sheet "${bViews[i].name}": ${bad} cells differ from the baseline`,
      )
  })

  // ── sheet matching: by name, then same index for a rename
  const cToB = cViews.map((v) => bViews.findIndex((bv) => bv.name === v.name))
  cViews.forEach((v, i) => {
    if (
      cToB[i] < 0 &&
      i < bViews.length &&
      !cToB.includes(i) &&
      !cViews.some((cv) => cv.name === bViews[i].name)
    )
      cToB[i] = i
  })

  const taken = new Set<string>()
  const stylesEntry = zip.file('styles.xml')
  const stylesXml = stylesEntry ? await stylesEntry.async('string') : ''
  for (const s of [xml, stylesXml])
    for (const m of s.matchAll(/style:name="([^"]*)"/g)) taken.add(decode(m[1]))
  const oFonts = new Set(
    (o.fontDecls?.children ?? []).map((f) => attr(openTag(xml, f), 'style:name') ?? ''),
  )
  const importer = new StyleImporter(c, taken, oFonts)

  const dropped: string[] = []
  let cellsChanged = 0
  let sheetsRewritten = 0
  let sheetsKept = 0
  const patchedChecks: Array<{ name: string; keys: string[]; cv: SheetView }> = []
  const tableText = new Map<number, string>() // O index → final text
  const newText = new Map<number, string>() // C index → text of an added sheet

  const rewrite = (oi: number | null, cv: SheetView) => {
    const raw = c.doc.xml.slice(cv.table.start, cv.table.end)
    const remapped = importer.remap(raw)
    if (oi === null) return remapped
    // keep O's own table attributes (style, protection, print ranges), C's name
    const oTag = withAttr(tagHead(openTag(xml, o.tables[oi])), 'table:name', cv.name) + '>'
    const tagLen = remapped.indexOf('>') + 1
    const body = remapped.endsWith('/>') ? '</table:table>' : remapped.slice(tagLen)
    return oTag + body
  }

  cViews.forEach((cv, ci) => {
    const bi = cToB[ci]
    if (bi < 0) {
      newText.set(ci, rewrite(null, cv))
      sheetsRewritten++
      cellsChanged += cv.values
      return
    }
    const bv = bViews[bi]
    const oTable = o.tables[bi]
    const oRaw = xml.slice(oTable.start, oTable.end)
    const renamed = cv.name !== bv.name
    if (renamed)
      dropped.push(
        `sheet-renamed:${bv.name}->${cv.name} (references outside cells keep the old name)`,
      )
    const named = (raw: string) =>
      renamed
        ? retag(raw, oTable.openEnd - oTable.start, (h) => withAttr(h, 'table:name', cv.name))
        : raw

    const changed = [...new Set([...bv.norm.keys(), ...cv.norm.keys()])].filter(
      (k) => bv.norm.get(k) !== cv.norm.get(k),
    )
    if (!changed.length && bv.layout === cv.layout) {
      tableText.set(bi, named(oRaw))
      sheetsKept++
      return
    }

    // structural? layout, merges, shifted content or a mass edit
    let structural =
      bv.layout !== cv.layout || changed.length > Math.max(1, LOCAL_CHANGE_RATIO * bv.values)
    let shifted = 0
    for (const k of changed) {
      const [r, col] = k.split(',').map(Number)
      const bRaw = bv.cells.get(k)
      const cRaw = cv.cells.get(k)
      const span = (s?: string) => {
        const tag = s ? s.slice(0, s.indexOf('>') + 1) : ''
        return `${attr(tag, 'table:number-columns-spanned') ?? ''}/${attr(tag, 'table:number-rows-spanned') ?? ''}`
      }
      if (
        bRaw?.startsWith(`<${COVERED}`) ||
        cRaw?.startsWith(`<${COVERED}`) ||
        span(bRaw) !== span(cRaw)
      )
        structural = true
      const n = cv.norm.get(k)
      if (
        n &&
        [key(r - 1, col), key(r + 1, col), key(r, col - 1), key(r, col + 1)].some(
          (x) => bv.norm.get(x) === n,
        )
      )
        shifted++
    }
    if (shifted >= 2 && shifted * 2 >= changed.length) structural = true

    if (!structural) {
      const edits = new Map<number, Map<number, CellEdit>>()
      for (const k of changed) {
        const [r, col] = k.split(',').map(Number)
        const cRaw = cv.cells.get(k)
        const keep = styleSig(b, bv.cells.get(k)) === styleSig(c, cRaw)
        const cStyle = cRaw && attr(cRaw.slice(0, cRaw.indexOf('>') + 1), 'table:style-name')
        const edit: CellEdit = (oCell) =>
          freshCell(oCell, cRaw, {
            keep,
            name: keep && oCell ? null : cStyle ? importer.take(cStyle) : null,
          })
        if (!edits.has(r)) edits.set(r, new Map())
        edits.get(r)!.set(col, edit)
      }
      try {
        tableText.set(bi, named(patchTable(xml, oTable, oRows[bi], edits)))
        cellsChanged += changed.length
        patchedChecks.push({ name: cv.name, keys: changed, cv })
        return
      } catch (err) {
        if (!(err instanceof NotLocal)) throw err
      }
    }
    tableText.set(bi, rewrite(bi, cv))
    sheetsRewritten++
    cellsChanged += changed.length
    dropped.push(`sheet-rewritten:${cv.name} (may lose: ${lossesOf(oRaw)})`)
  })

  // ── assemble the table region in C's sheet order
  const first = o.tables[0]
  const last = o.tables[o.tables.length - 1]
  const gaps = o.tables.slice(1).map((t, i) => xml.slice(o.tables[i].end, t.start))
  const order = cToB.filter((x) => x >= 0)
  const inOrder = order.every((x, i) => i === 0 || x > order[i - 1])
  let region = ''
  if (inOrder) {
    const newAfter = new Map<number, string[]>() // O index (-1 = front) → added sheets
    let prev = -1
    cToB.forEach((bi, ci) => {
      if (bi >= 0) prev = bi
      else newAfter.set(prev, [...(newAfter.get(prev) ?? []), newText.get(ci)!])
    })
    region += (newAfter.get(-1) ?? []).join('')
    o.tables.forEach((_, i) => {
      if (i > 0) region += gaps[i - 1]
      region += (tableText.get(i) ?? '') + (newAfter.get(i) ?? []).join('')
    })
  } else {
    region =
      cToB.map((bi, ci) => (bi >= 0 ? tableText.get(bi)! : newText.get(ci)!)).join('') +
      gaps.join('')
  }

  const reps: Array<[number, number, string]> = [[first.start, last.end, region]]
  if (importer.added.length || importer.fontsAdded.length || sheetsRewritten) {
    // declare whatever namespace the export's markup may use and O lacks
    const oNs = namespaces(o)
    let rootHead = tagHead(openTag(xml, o.root))
    for (const [p, uri] of namespaces(c.doc)) {
      const have = oNs.get(p)
      if (have === undefined) rootHead += ` xmlns:${p}="${uri}"`
      else if (have !== uri) throw new OdfPatchError('mismatch', `namespace prefix ${p}`)
    }
    reps.push([o.root.start, o.root.openEnd, rootHead + '>'])
  }
  if (importer.fontsAdded.length) {
    const decls = importer.fontsAdded.join('')
    const fd = o.fontDecls
    if (!fd) {
      const at = (o.autoStyles ?? child(o.root, 'office:body')!).start
      reps.push([at, at, `<office:font-face-decls>${decls}</office:font-face-decls>`])
    } else if (fd.end === fd.openEnd)
      reps.push([fd.start, fd.end, `<office:font-face-decls>${decls}</office:font-face-decls>`])
    else {
      const at = xml.lastIndexOf('</', fd.end - 1)
      reps.push([at, at, decls])
    }
  }
  if (importer.added.length) {
    const styles = importer.added.join('')
    const as = o.autoStyles
    if (!as) {
      const at = child(o.root, 'office:body')!.start
      reps.push([at, at, `<office:automatic-styles>${styles}</office:automatic-styles>`])
    } else if (as.end === as.openEnd)
      reps.push([as.start, as.end, `<office:automatic-styles>${styles}</office:automatic-styles>`])
    else {
      const at = xml.lastIndexOf('</', as.end - 1)
      reps.push([at, at, styles])
    }
  }
  const out = splice(xml, 0, xml.length, reps)

  // ── self-check: well-formed, and every patched cell now reads as C's
  let newContent = contentBytes
  if (out !== xml) {
    if (XMLValidator.validate(out) !== true)
      throw new OdfPatchError('internal', 'patched content.xml is not well-formed')
    const doc = parseDoc(out)
    for (const chk of patchedChecks) {
      const t = doc.tables.find((x) => tableName(doc, x) === chk.name)
      if (!t) throw new OdfPatchError('internal', `patched sheet ${chk.name} lost`)
      const rows = tableRows(out, t)
      for (const k of chk.keys)
        if (valueSig(cellAt(out, rows, k)) !== valueSig(chk.cv.cells.get(k)))
          throw new OdfPatchError('internal', `cell ${k} of ${chk.name} did not take its new value`)
    }
    newContent = new TextEncoder().encode(out)
  }

  // ── repackage: mimetype first and stored, every other entry as it was
  const pkg = new JSZip()
  const mimetype = zip.file('mimetype')
  if (mimetype)
    pkg.file('mimetype', await mimetype.async('uint8array'), {
      compression: 'STORE',
      date: mimetype.date,
    })
  for (const e of entries) {
    if (e.name === 'mimetype') continue
    if (e.dir) {
      pkg.file(e.name, null, { dir: true, date: e.date })
      continue
    }
    const data = e.name === 'content.xml' ? newContent : await inflateCapped(e)
    pkg.file(e.name, data, { date: e.date, compression: 'DEFLATE' })
  }
  const ods = await pkg.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { ods, cellsChanged, sheetsRewritten, sheetsKept, dropped }
}
