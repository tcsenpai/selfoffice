import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { OdfPatchError, patchOds } from '../src/ods-patch'

// ───────────── original .ods: a LibreOffice-shaped package ─────────────

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" ' +
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" ' +
  'xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" ' +
  'xmlns:foo="urn:example:unknown"'

const str = (s: string, attrs = '') =>
  `<table:table-cell${attrs} office:value-type="string" calcext:value-type="string"><text:p>${s}</text:p></table:table-cell>`
const num = (n: number, attrs = '') =>
  `<table:table-cell${attrs} office:value-type="float" office:value="${n}" calcext:value-type="float"><text:p>${n}</text:p></table:table-cell>`
const empty = (n = 1) =>
  `<table:table-cell${n > 1 ? ` table:number-columns-repeated="${n}"` : ''}/>`

const SHAPES =
  '<table:shapes><draw:frame draw:z-index="0" draw:name="Chart 1" svg:width="3in" svg:height="2in" svg:x="2in" svg:y="0.2in">' +
  '<draw:object draw:notify-on-update-of-ranges="Data.A1:Data.B5" xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '</draw:frame></table:shapes>'
const COND =
  '<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="Data.B2:Data.B5">' +
  '<calcext:condition calcext:apply-style-name="Accent" calcext:value="&gt;4" calcext:base-cell-address="Data.B2"/>' +
  '</calcext:conditional-format></calcext:conditional-formats>'
const ANNOTATION =
  '<office:annotation><dc:creator>me</dc:creator><text:p>keep this note</text:p></office:annotation>'

const DATA_TABLE =
  '<table:table table:name="Data" table:style-name="ta1">' +
  SHAPES +
  '<table:table-column table:style-name="co1" table:number-columns-repeated="4" table:default-cell-style-name="Default"/>' +
  `<table:table-row table:style-name="ro1">${str('Name', ' table:style-name="ce1"')}${str('Qty')}${str('When')}${empty()}</table:table-row>` +
  `<table:table-row table:style-name="ro1">${str('apple')}${num(3, ' table:content-validation-name="val1"')}` +
  '<table:table-cell table:style-name="ce2" office:value-type="date" office:date-value="2026-03-05" calcext:value-type="date"><text:p>2026-03-05</text:p></table:table-cell>' +
  `${empty()}</table:table-row>` +
  `<table:table-row table:style-name="ro1" table:number-rows-repeated="2">${str('pear')}${num(5)}${empty(2)}</table:table-row>` +
  `<table:table-row table:style-name="ro1">${str('total')}` +
  '<table:table-cell table:formula="of:=SUM([.B2:.B4])" office:value-type="float" office:value="13" calcext:value-type="float"><text:p>13</text:p></table:table-cell>' +
  `${empty(2)}</table:table-row>` +
  `<table:table-row table:style-name="ro1" table:number-rows-repeated="1048571">${empty(4)}</table:table-row>` +
  COND +
  '</table:table>'

const NOTES_TABLE =
  '<table:table table:name="Notes" table:style-name="ta1">' +
  '<table:table-column table:number-columns-repeated="2" table:default-cell-style-name="Default"/>' +
  `<table:table-row><table:table-cell office:value-type="string" calcext:value-type="string">${ANNOTATION}<text:p>hello</text:p></table:table-cell>${empty()}</table:table-row>` +
  `<table:table-row>${empty()}${num(42)}</table:table-row>` +
  '</table:table>'

function contentXml(tables = DATA_TABLE + NOTES_TABLE): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS} office:version="1.3">` +
    '<office:scripts/>' +
    '<office:font-face-decls><style:font-face style:name="Liberation Sans" svg:font-family="&apos;Liberation Sans&apos;"/></office:font-face-decls>' +
    '<office:automatic-styles>' +
    '<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="0.889in"/></style:style>' +
    '<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.178in"/></style:style>' +
    '<style:style style:name="ta1" style:family="table" style:master-page-name="Default"><style:table-properties table:display="true"/></style:style>' +
    '<number:date-style style:name="N36"><number:year number:style="long"/><number:text>-</number:text><number:month number:style="long"/><number:text>-</number:text><number:day number:style="long"/></number:date-style>' +
    '<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Accent"/>' +
    '<style:style style:name="ce2" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N36"/>' +
    '</office:automatic-styles>' +
    '<office:body><office:spreadsheet>' +
    '<table:calculation-settings table:automatic-find-labels="false"/>' +
    '<table:content-validations><table:content-validation table:name="val1" table:condition="of:cell-content-is-whole-number()" table:allow-empty-cell="true" table:base-cell-address="Data.B2"/></table:content-validations>' +
    tables +
    '<table:named-expressions><table:named-range table:name="Qty" table:base-cell-address="$Data.$B$2" table:cell-range-address="$Data.$B$2:.$B$5"/></table:named-expressions>' +
    '<foo:extension foo:keep="yes"><foo:payload>opaque</foo:payload></foo:extension>' +
    '</office:spreadsheet></office:body></office:document-content>'
  )
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles>` +
  '<style:style style:name="Default" style:family="table-cell"/>' +
  '<style:style style:name="Accent" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>' +
  '</office:styles></office:document-styles>'
const SETTINGS_XML =
  '<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><office:settings>' +
  '<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>' +
  '<config:config-item-map-named config:name="Tables"><config:config-item-map-entry config:name="Data">' +
  '<config:config-item config:name="HorizontalSplitMode" config:type="short">2</config:config-item>' +
  '<config:config-item config:name="VerticalSplitPosition" config:type="int">1</config:config-item>' +
  '</config:config-item-map-entry></config:config-item-map-named></config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set>' +
  '</office:settings></office:document-settings>'
const CHART_XML =
  '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" office:version="1.3"><office:body><office:chart><chart:chart chart:class="chart:bar"/></office:chart></office:body></office:document-content>'
const MANIFEST =
  '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
  '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>' +
  '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="Object 1/content.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="Object 1/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.chart"/>' +
  '<manifest:file-entry manifest:full-path="Pictures/dot.png" manifest:media-type="image/png"/>' +
  '<manifest:file-entry manifest:full-path="Thumbnails/thumbnail.png" manifest:media-type="image/png"/>' +
  '</manifest:manifest>'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 250, 251])

async function buildOds(content = contentXml()): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' })
  zip.file('META-INF/manifest.xml', MANIFEST)
  zip.file('content.xml', content)
  zip.file('styles.xml', STYLES_XML)
  zip.file(
    'meta.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS}><office:meta/></office:document-meta>`,
  )
  zip.file('settings.xml', SETTINGS_XML)
  zip.file('Object 1/content.xml', CHART_XML)
  zip.file('Pictures/dot.png', PNG)
  zip.file('Thumbnails/thumbnail.png', PNG)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

// ───────────── B / C: .xlsx in the import's shape (inline strings, s=1 dates) ─────────────

type V = number | string | boolean | { f: string; v?: number } | { date: number } | { bold: number }
interface Sheet {
  name: string
  rows: Array<Array<V | null>>
}

const col = (i: number) => String.fromCharCode(65 + i)
function cellXml(ref: string, v: V): string {
  if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
  if (typeof v === 'string')
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${v}</t></is></c>`
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
  if ('f' in v) return `<c r="${ref}"><f>${v.f}</f>${v.v !== undefined ? `<v>${v.v}</v>` : ''}</c>`
  if ('date' in v) return `<c r="${ref}" s="1"><v>${v.date}</v></c>`
  return `<c r="${ref}" s="2"><v>${v.bold}</v></c>`
}

async function xlsx(sheets: Sheet[]): Promise<Uint8Array> {
  const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
  const REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const zip = new JSZip()
  zip.file(
    'xl/workbook.xml',
    `<workbook ${MAIN} ${REL}><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      '</Relationships>',
  )
  zip.file(
    'xl/styles.xml',
    `<styleSheet ${MAIN}><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/></cellXfs></styleSheet>',
  )
  sheets.forEach((s, i) => {
    const rows = s.rows
      .map((cells, r) => {
        const cs = cells.map((v, c) => (v === null ? '' : cellXml(`${col(c)}${r + 1}`, v))).join('')
        return cs ? `<row r="${r + 1}">${cs}</row>` : ''
      })
      .join('')
    zip.file(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<worksheet ${MAIN}><sheetData>${rows}</sheetData></worksheet>`,
    )
  })
  return zip.generateAsync({ type: 'uint8array' })
}

const DATE = { date: 46086 } // 2026-03-05
const dataRows = (): Array<Array<V | null>> => [
  ['Name', 'Qty', 'When'],
  ['apple', 3, DATE],
  ['pear', 5],
  ['pear', 5],
  ['total', { f: 'SUM(B2:B4)', v: 13 }],
]
const notesRows = (): Array<Array<V | null>> => [['hello'], [null, 42]]
const baseline = () =>
  xlsx([
    { name: 'Data', rows: dataRows() },
    { name: 'Notes', rows: notesRows() },
  ])

// ───────────── independent oracle: fast-xml-parser reading of the result ─────────────

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
})
type N = Record<string, any>
const tag = (n: N) => Object.keys(n).find((k) => k !== ':@')!
const kids = (n: N): N[] => n[tag(n)] ?? []
const text = (n: N): string =>
  kids(n)
    .map((k) =>
      tag(k) === '#text' ? String(k['#text']) : tag(k) === 'office:annotation' ? '' : text(k),
    )
    .join('')

/** sheet name → displayed text grid (trailing blanks trimmed, repeats capped) */
function odsValues(xml: string): Record<string, string[][]> {
  const out: Record<string, string[][]> = {}
  const walk = (nodes: N[], fn: (n: N) => void) =>
    nodes.forEach((n) => {
      if (tag(n) === '#text') return
      fn(n)
      if (tag(n) !== 'table:table-cell') walk(kids(n), fn)
    })
  walk(parser.parse(xml), (t) => {
    if (tag(t) !== 'table:table') return
    const grid: string[][] = []
    const rowsOf = (nodes: N[]): N[] =>
      nodes.flatMap((n) =>
        tag(n) === 'table:table-row'
          ? [n]
          : ['table:table-row-group', 'table:table-header-rows', 'table:table-rows'].includes(
                tag(n),
              )
            ? rowsOf(kids(n))
            : [],
      )
    for (const row of rowsOf(kids(t))) {
      const cells: string[] = []
      for (const c of kids(row)) {
        const n = Math.min(Number(c[':@']?.['table:number-columns-repeated'] ?? 1), 30)
        for (let i = 0; i < n; i++) cells.push(text(c))
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop()
      const reps = Math.min(Number(row[':@']?.['table:number-rows-repeated'] ?? 1), 30)
      for (let i = 0; i < reps; i++) grid.push([...cells])
    }
    while (grid.length && !grid[grid.length - 1].length) grid.pop()
    out[t[':@']['table:name']] = grid
  })
  return out
}

const contentOf = async (ods: Uint8Array) =>
  (await JSZip.loadAsync(ods)).file('content.xml')!.async('string')

async function entries(ods: Uint8Array): Promise<Array<[string, Uint8Array]>> {
  const zip = await JSZip.loadAsync(ods)
  const out: Array<[string, Uint8Array]> = []
  for (const f of Object.values(zip.files))
    if (!f.dir) out.push([f.name, await f.async('uint8array')])
  return out
}

/** every entry except content.xml is byte-identical and in the same order */
async function expectOthersVerbatim(original: Uint8Array, patched: Uint8Array) {
  const a = (await entries(original)).filter(([n]) => n !== 'content.xml')
  const b = (await entries(patched)).filter(([n]) => n !== 'content.xml')
  expect(b.map(([n]) => n)).toEqual(a.map(([n]) => n))
  a.forEach(([, bytes], i) => expect(Buffer.from(b[i][1]).equals(Buffer.from(bytes))).toBe(true))
}

// ───────────── tests ─────────────

describe('patchOds', () => {
  it('returns an entry-wise identical package for an unchanged workbook', async () => {
    const o = await buildOds()
    const b = await baseline()
    const res = await patchOds(o, b, b)
    expect(res).toMatchObject({ cellsChanged: 0, sheetsRewritten: 0, sheetsKept: 2, dropped: [] })
    const [x, y] = [await entries(o), await entries(res.ods)]
    expect(y.map(([n]) => n)).toEqual(x.map(([n]) => n))
    x.forEach(([, bytes], i) => expect(Buffer.from(y[i][1]).equals(Buffer.from(bytes))).toBe(true))
    // mimetype is the first local entry and stored
    expect(new TextDecoder().decode(res.ods.slice(30, 38))).toBe('mimetype')
    expect(res.ods[8] | (res.ods[9] << 8)).toBe(0)
  })

  it('edits one numeric cell in place, keeping its validation and the rest of the sheet', async () => {
    const o = await buildOds()
    const rows = dataRows()
    rows[1][1] = 7
    rows[4][1] = { f: 'SUM(B2:B4)', v: 17 }
    const c = await xlsx([
      { name: 'Data', rows },
      { name: 'Notes', rows: notesRows() },
    ])
    const res = await patchOds(o, await baseline(), c)
    expect(res).toMatchObject({ cellsChanged: 2, sheetsRewritten: 0, sheetsKept: 1, dropped: [] })
    const xml = await contentOf(res.ods)
    expect(xml).toContain(
      '<table:table-cell table:content-validation-name="val1" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>',
    )
    expect(xml).toContain(
      'table:formula="of:=SUM([.B2:.B4])" office:value-type="float" office:value="17"',
    )
    for (const verbatim of [
      SHAPES,
      COND,
      NOTES_TABLE,
      '<foo:extension foo:keep="yes">',
      'office:date-value="2026-03-05"',
    ])
      expect(xml).toContain(verbatim)
    expect(odsValues(xml).Data).toEqual([
      ['Name', 'Qty', 'When'],
      ['apple', '7', '2026-03-05'],
      ['pear', '5'],
      ['pear', '5'],
      ['total', '17'],
    ])
    await expectOthersVerbatim(o, res.ods)
  })

  it('edits a formula cell and gives a restyled cell a fresh automatic style', async () => {
    const o = await buildOds()
    const rows = dataRows()
    rows[4][1] = { f: 'MAX(B2:B4)', v: 5 }
    rows[0][0] = 'Item' // keeps its Accent-based style
    const c = await xlsx([
      { name: 'Data', rows },
      { name: 'Notes', rows: notesRows() },
    ])
    const plain = await patchOds(o, await baseline(), c)
    let xml = await contentOf(plain.ods)
    expect(xml).toContain(
      'table:formula="of:=MAX([.B2:.B4])" office:value-type="float" office:value="5"',
    )
    expect(xml).toContain(
      '<table:table-cell table:style-name="ce1" office:value-type="string"><text:p>Item</text:p>',
    )

    rows[2][1] = { bold: 5 }
    const bold = await patchOds(
      o,
      await baseline(),
      await xlsx([
        { name: 'Data', rows },
        { name: 'Notes', rows: notesRows() },
      ]),
    )
    xml = await contentOf(bold.ods)
    const fresh =
      /<style:style style:name="(so[^"]+)" style:family="table-cell"[^>]*><style:text-properties fo:font-weight="bold"\/>/.exec(
        xml,
      )
    expect(fresh).not.toBeNull()
    expect(['ce1', 'ce2', 'co1', 'ro1', 'ta1', 'Accent', 'Default']).not.toContain(fresh![1])
    expect(xml).toContain(
      `<table:table-cell table:style-name="${fresh![1]}" office:value-type="float" office:value="5">`,
    )
    expect(xml).toContain(
      '<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Accent"/>',
    )
    await expectOthersVerbatim(o, bold.ods)
  })

  it('splits a repeated row run to set a cell inside it', async () => {
    const o = await buildOds()
    const rows = dataRows()
    rows[2][1] = 9
    rows[4][1] = { f: 'SUM(B2:B4)', v: 17 }
    const res = await patchOds(
      o,
      await baseline(),
      await xlsx([
        { name: 'Data', rows },
        { name: 'Notes', rows: notesRows() },
      ]),
    )
    expect(res.sheetsRewritten).toBe(0)
    const xml = await contentOf(res.ods)
    expect(xml).not.toContain('table:number-rows-repeated="2"')
    expect(odsValues(xml).Data.slice(2, 5)).toEqual([
      ['pear', '9'],
      ['pear', '5'],
      ['total', '17'],
    ])
    // the trailing run still covers the rest of the sheet
    expect(xml).toContain('table:number-rows-repeated="1048571"')
  })

  it('adds a string cell in an empty region, inside and beyond the stored grid', async () => {
    const o = await buildOds()
    const rows = dataRows()
    rows[2] = ['pear', 5, null, 'note']
    const notes = notesRows()
    notes[3] = [null, null, 'far']
    const res = await patchOds(
      o,
      await baseline(),
      await xlsx([
        { name: 'Data', rows },
        { name: 'Notes', rows: notes },
      ]),
    )
    expect(res).toMatchObject({ cellsChanged: 2, sheetsRewritten: 0, sheetsKept: 0 })
    const v = odsValues(await contentOf(res.ods))
    expect(v.Data.slice(2, 4)).toEqual([
      ['pear', '5', '', 'note'],
      ['pear', '5'],
    ])
    expect(v.Notes).toEqual([['hello'], ['', '42'], [], ['', '', 'far']])
    expect(await contentOf(res.ods)).toContain(ANNOTATION)
  })

  it('appends a new sheet in position and keeps the others byte-identical', async () => {
    const o = await buildOds()
    const c = await xlsx([
      { name: 'Data', rows: dataRows() },
      { name: 'New', rows: [['fresh', 1]] },
      { name: 'Notes', rows: notesRows() },
    ])
    const res = await patchOds(o, await baseline(), c)
    expect(res).toMatchObject({ sheetsRewritten: 1, sheetsKept: 2, dropped: [] })
    const xml = await contentOf(res.ods)
    expect(xml).toContain(DATA_TABLE + '<table:table table:name="New">')
    expect(xml).toContain('</table:table>' + NOTES_TABLE)
    expect(Object.keys(odsValues(xml))).toEqual(['Data', 'New', 'Notes'])
    expect(odsValues(xml).New).toEqual([['fresh', '1']])
  })

  it('deletes a sheet and renames another without touching its cells', async () => {
    const o = await buildOds()
    const del = await patchOds(
      o,
      await baseline(),
      await xlsx([{ name: 'Data', rows: dataRows() }]),
    )
    expect(del).toMatchObject({ sheetsKept: 1, sheetsRewritten: 0 })
    let xml = await contentOf(del.ods)
    expect(xml).toContain(DATA_TABLE)
    expect(xml).not.toContain('table:name="Notes"')

    const ren = await patchOds(
      o,
      await baseline(),
      await xlsx([
        { name: 'Data', rows: dataRows() },
        { name: 'Memo', rows: notesRows() },
      ]),
    )
    expect(ren.sheetsKept).toBe(2)
    expect(ren.dropped).toEqual([expect.stringMatching(/^sheet-renamed:Notes->Memo/)])
    xml = await contentOf(ren.ods)
    expect(xml).toContain(NOTES_TABLE.replace('table:name="Notes"', 'table:name="Memo"'))
  })

  it('re-serialises only the sheet whose rows were inserted, and says what it may lose', async () => {
    const o = await buildOds()
    const rows = dataRows()
    rows.splice(1, 0, ['kiwi', 1])
    rows[5][1] = { f: 'SUM(B2:B5)', v: 14 }
    const res = await patchOds(
      o,
      await baseline(),
      await xlsx([
        { name: 'Data', rows },
        { name: 'Notes', rows: notesRows() },
      ]),
    )
    expect(res).toMatchObject({ sheetsRewritten: 1, sheetsKept: 1 })
    expect(res.dropped).toEqual([
      expect.stringMatching(
        /^sheet-rewritten:Data \(may lose: .*charts.*conditional formats.*data validation/,
      ),
    ])
    const xml = await contentOf(res.ods)
    expect(xml).toContain(NOTES_TABLE)
    expect(xml).toContain('<table:table table:name="Data" table:style-name="ta1">') // O's own table attributes
    expect(odsValues(xml).Data).toEqual([
      ['Name', 'Qty', 'When'],
      ['kiwi', '1'],
      ['apple', '3', '2026-03-05'],
      ['pear', '5'],
      ['pear', '5'],
      ['total', '14'],
    ])
    expect(xml).toContain('of:=SUM([.B2:.B5])')
    await expectOthersVerbatim(o, res.ods)
  })

  it('refuses inconsistent or pathological input with OdfPatchError', async () => {
    const o = await buildOds()
    const b = await baseline()
    await expect(patchOds(new Uint8Array([1, 2, 3]), b, b)).rejects.toBeInstanceOf(OdfPatchError)
    // a baseline that is not the import of this file
    const shifted = await xlsx([
      { name: 'Data', rows: dataRows().map((r) => [null, ...r]) },
      { name: 'Notes', rows: notesRows() },
    ])
    await expect(patchOds(o, shifted, shifted)).rejects.toMatchObject({ code: 'mismatch' })
    await expect(
      patchOds(o, await xlsx([{ name: 'Data', rows: dataRows() }]), b),
    ).rejects.toMatchObject({ code: 'mismatch' })
    // a non-empty run expanding past the grid budget
    const giant = await buildOds(
      contentXml(
        `<table:table table:name="Data"><table:table-row table:number-rows-repeated="100000">${num(1, ' table:number-columns-repeated="100"')}</table:table-row></table:table>` +
          NOTES_TABLE,
      ),
    )
    await expect(patchOds(giant, b, b)).rejects.toMatchObject({ code: 'limits' })
    // malformed content.xml
    const broken = await buildOds(contentXml().replace('</table:table-row>', ''))
    await expect(patchOds(broken, b, b)).rejects.toMatchObject({ code: 'malformed' })
  })
})

const soffice = spawnSync('which', ['soffice']).status === 0 && process.env.SKIP_SOFFICE !== '1'
describe.skipIf(!soffice)('patchOds soffice round trip', () => {
  it('LibreOffice reads the patched values', async () => {
    const o = await buildOds()
    const rows = dataRows()
    rows[1][1] = 7
    rows[2] = ['pear', 9, null, 'note']
    rows[4][1] = { f: 'SUM(B2:B4)', v: 21 }
    const res = await patchOds(
      o,
      await baseline(),
      await xlsx([
        { name: 'Data', rows },
        { name: 'Notes', rows: notesRows() },
      ]),
    )
    const dir = mkdtempSync(join(tmpdir(), 'ods-patch-'))
    try {
      writeFileSync(join(dir, 'in.ods'), res.ods)
      execFileSync(
        'soffice',
        [
          '--headless',
          '--convert-to',
          'csv:Text - txt - csv (StarCalc):44,34,76,1',
          '--outdir',
          dir,
          join(dir, 'in.ods'),
        ],
        { stdio: 'ignore', timeout: 120_000, env: { ...process.env, HOME: dir } },
      )
      const csv = readFileSync(join(dir, 'in.csv'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => l.replace(/"/g, '').replace(/,+$/, ''))
      expect(csv).toEqual([
        'Name,Qty,When',
        'apple,7,2026-03-05',
        'pear,9,,note',
        'pear,5',
        'total,21',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)
})
