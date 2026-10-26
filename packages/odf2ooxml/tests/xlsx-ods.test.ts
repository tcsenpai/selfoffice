import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { convertXlsxToOds, translateFormulaToOds, translateNumberFormat } from '../src/xlsx-ods'

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

interface Fixture {
  sheets: Array<{ name: string; xml: string; state?: string; rels?: string }>
  styles?: string
  shared?: string[]
  names?: string
  date1904?: boolean
}

async function buildXlsx(f: Fixture): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    'xl/workbook.xml',
    `<workbook ${MAIN} ${REL}>${f.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>` +
      f.sheets
        .map(
          (s, i) =>
            `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state ? ` state="${s.state}"` : ''}/>`,
        )
        .join('') +
      `</sheets>${f.names ?? ''}</workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      f.sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      '</Relationships>',
  )
  f.sheets.forEach((s, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<worksheet ${MAIN} ${REL}>${s.xml}</worksheet>`)
    if (s.rels) zip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, s.rels)
  })
  if (f.shared)
    zip.file(
      'xl/sharedStrings.xml',
      `<sst ${MAIN}>${f.shared.map((t) => `<si><t xml:space="preserve">${t}</t></si>`).join('')}</sst>`,
    )
  if (f.styles) zip.file('xl/styles.xml', `<styleSheet ${MAIN}>${f.styles}</styleSheet>`)
  return zip.generateAsync({ type: 'uint8array' })
}

async function content(ods: Uint8Array): Promise<string> {
  return (await (await JSZip.loadAsync(ods)).file('content.xml')!.async('string'))!
}

const STYLES =
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><color rgb="FFFF0000"/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>' +
  '<borders count="2"><border/><border><left style="thin"><color rgb="FF000000"/></left></border></borders>' +
  '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' + // 0 default
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0"/>' + // 1 0.00
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0"/>' + // 2 date
  '<xf numFmtId="9" fontId="0" fillId="0" borderId="0"/>' + // 3 percent
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" wrapText="1"/></xf>' + // 4 styled
  '<xf numFmtId="20" fontId="0" fillId="0" borderId="0"/></cellXfs>' // 5 h:mm

describe('translateFormulaToOds', () => {
  const table: Array<[string, string | null]> = [
    ['SUM(A1:B2)', 'of:=SUM([.A1:.B2])'],
    ['A1+B1*2', 'of:=[.A1]+[.B1]*2'],
    ['$A$1+B$2', 'of:=[.$A$1]+[.B$2]'],
    ['Sheet2!A1', 'of:=[$Sheet2.A1]'],
    ["SUM('My Sheet'!A1:B2)", "of:=SUM([$'My Sheet'.A1:.B2])"],
    ["'It''s'!C3", "of:=[$'It''s'.C3]"],
    ['IF(A1>0,"a,b","c")', 'of:=IF([.A1]>0;"a,b";"c")'],
    ['IF(A1<>1,TRUE,FALSE)', 'of:=IF([.A1]<>1;TRUE();FALSE())'],
    ['sum(a1:a3)', 'of:=SUM([.A1:.A3])'],
    ['LOG10(A1)', 'of:=LOG10([.A1])'],
    ['A1&"x"&B1', 'of:=[.A1]&"x"&[.B1]'],
    ['-A1^2%', 'of:=-[.A1]^2%'],
    ['(A1+B1)*C1', 'of:=([.A1]+[.B1])*[.C1]'],
    ['1.5E3+.5', 'of:=1.5E3+.5'],
    ['SUM(A:A)', null],
    ['SUM(1:1)', null],
    ['(A1,B1)', null],
    ['A1:B2 B2:C3', null],
    ['SUM({1,2})', null],
    ['_xlfn.XLOOKUP(A1,B:B,C:C)', null],
    ['Table1[Col]', null],
    ['Sheet1:Sheet3!A1', null],
    ['[1]Sheet1!A1', null],
    ['#REF!+1', null],
    ['unknownName+1', null],
    ['SUM(A1', null],
    ['XFE1', null],
    ['A1048577', null],
  ]
  for (const [input, expected] of table)
    it(`${input} -> ${expected}`, () => expect(translateFormulaToOds(input)).toBe(expected))

  it('resolves defined names and shifts shared formulas', () => {
    expect(translateFormulaToOds('Tax*A1', { names: new Set(['TAX']) })).toBe('of:=Tax*[.A1]')
    expect(translateFormulaToOds('A1+$B$1', { dRow: 2, dCol: 1 })).toBe('of:=[.B3]+[.$B$1]')
    expect(translateFormulaToOds('A1', { dCol: -1 })).toBeNull()
  })
})

describe('translateNumberFormat', () => {
  it('maps the families', () => {
    expect(translateNumberFormat('0.00')?.kind).toBe('number')
    expect(translateNumberFormat('0%')?.kind).toBe('percent')
    expect(translateNumberFormat('$#,##0.00')?.kind).toBe('currency')
    expect(translateNumberFormat('yyyy-mm-dd')?.kind).toBe('date')
    expect(translateNumberFormat('h:mm:ss')?.kind).toBe('time')
    expect(translateNumberFormat('General')?.kind).toBe('general')
    expect(translateNumberFormat('# ?/?')).toBeNull()
    expect(translateNumberFormat('[>=100]0')).toBeNull()
  })
  it('tells minutes from months', () => {
    expect(translateNumberFormat('h:mm')!.build!('X')).toContain(
      '<number:minutes number:style="long"/>',
    )
    expect(translateNumberFormat('mm/dd')!.build!('X')).toContain(
      '<number:month number:style="long"/>',
    )
  })
})

describe('convertXlsxToOds', () => {
  it('writes a valid package with typed cells, formulas and styles', async () => {
    const xlsx = await buildXlsx({
      styles: STYLES,
      shared: ['hello  world', 'multi\nline'],
      sheets: [
        {
          name: 'Data',
          xml:
            '<sheetData>' +
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>3.14159</v></c><c r="C1" s="2"><v>44927</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#DIV/0!</v></c></row>' +
            '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>A2*2</f><v>4</v></c><c r="C2" s="3"><v>0.25</v></c><c r="D2" s="5"><v>0.5</v></c><c r="E2" t="s"><v>1</v></c></row>' +
            '<row r="4" ht="30" customHeight="1" hidden="1"><c r="A4" s="4" t="inlineStr"><is><t>styled</t></is></c></row>' +
            '<row r="6"><c r="C6"><f>SUM(A2:B2)</f><v>6</v></c><c r="D6"><f>_xlfn.XLOOKUP(1,A2:A3,B2:B3)</f><v>4</v></c><c r="E6"><f t="array" ref="E6">A2:B2</f><v>2</v></c></row>' +
            '</sheetData><mergeCells count="1"><mergeCell ref="A8:B9"/></mergeCells>',
        },
      ],
    })
    const res = await convertXlsxToOds(xlsx)
    expect(res.sheets).toBe(1)
    expect(res.cells).toBe(14)

    const zip = await JSZip.loadAsync(res.ods)
    expect(Object.keys(zip.files)[0]).toBe('mimetype')
    expect(await zip.file('mimetype')!.async('string')).toBe(
      'application/vnd.oasis.opendocument.spreadsheet',
    )
    expect(zip.file('META-INF/manifest.xml')).toBeTruthy()
    expect(zip.file('styles.xml')).toBeTruthy()
    expect(zip.file('meta.xml')).toBeTruthy()

    const c = await content(res.ods)
    expect(c).toContain('<table:table table:name="Data">')
    expect(c).toContain(
      'office:value-type="string"><text:p>hello <text:s text:c="1"/>world</text:p>',
    )
    expect(c).toContain('<text:p>multi</text:p><text:p>line</text:p>')
    expect(c).toContain('office:value-type="float" office:value="3.14159"')
    expect(c).toContain('office:value-type="date" office:date-value="2023-01-01"')
    expect(c).toContain('office:value-type="boolean" office:boolean-value="true"')
    expect(c).toContain('office:value-type="string"') // error as string
    expect(c).toContain('<text:p>#DIV/0!</text:p>')
    expect(c).toContain('table:formula="of:=[.A2]*2"')
    expect(c).toContain('table:formula="of:=SUM([.A2:.B2])"')
    expect(c).toContain('office:value-type="percentage" office:value="0.25"')
    expect(c).toContain('office:value-type="time" office:time-value="PT12H00M00S"')
    expect(c).toContain('fo:font-weight="bold"')
    expect(c).toContain('fo:background-color="#FFFF00"')
    expect(c).toContain('fo:border-left="0.75pt solid #000000"')
    expect(c).toContain('fo:text-align="center"')
    expect(c).toContain('table:visibility="collapse"')
    expect(c).toContain('style:row-height="30.00pt"')
    // empty row 3 and row 5 compressed to single row elements; trailing nothing
    expect(c).not.toContain('XLOOKUP')
    expect(c).toContain('table:number-columns-spanned="2" table:number-rows-spanned="2"')
    expect(c).toContain('<table:covered-table-cell/>')

    expect(res.dropped.some((d) => d.startsWith('formulas without safe ODF translation'))).toBe(
      true,
    )
    expect(res.dropped.some((d) => d.startsWith('array formulas'))).toBe(true)
  })

  it('expands shared formulas and honors 1904 dates', async () => {
    const xlsx = await buildXlsx({
      date1904: true,
      styles: STYLES,
      sheets: [
        {
          name: 'S',
          xml:
            '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1+1</f><v>2</v></c><c r="C1" s="2"><v>0</v></c></row>' +
            '<row r="2"><c r="A2"><v>5</v></c><c r="B2"><f t="shared" si="0"/><v>6</v></c></row></sheetData>',
        },
      ],
    })
    const c = await content((await convertXlsxToOds(xlsx)).ods)
    expect(c).toContain('table:formula="of:=[.A1]+1"')
    expect(c).toContain('table:formula="of:=[.A2]+1"')
    expect(c).toContain('office:date-value="1904-01-01"')
    expect(c).toContain('<table:null-date table:date-value="1904-01-01"/>')
  })

  it('handles sheets, defined names, columns, hyperlinks and dropped kinds', async () => {
    const xlsx = await buildXlsx({
      names:
        '<definedNames><definedName name="Rate">Data!$B$1</definedName><definedName name="Weird">OFFSET(Data!A1,1,1)</definedName></definedNames>',
      sheets: [
        {
          name: 'Data',
          xml:
            '<cols><col min="1" max="2" width="20" customWidth="1"/><col min="4" max="4" width="5" hidden="1"/></cols>' +
            '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>link</t></is></c><c r="B1"><f>Rate*2</f><v>1</v></c></row></sheetData>' +
            '<conditionalFormatting sqref="A1"><cfRule type="cellIs" priority="1"/></conditionalFormatting>' +
            '<dataValidations count="1"><dataValidation sqref="A1"/></dataValidations>' +
            '<hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>',
          rels: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/></Relationships>',
        },
        {
          name: 'My Sheet',
          state: 'hidden',
          xml: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>',
        },
      ],
    })
    const res = await convertXlsxToOds(xlsx)
    const c = await content(res.ods)
    expect(res.sheets).toBe(2)
    expect(c).toContain('<table:table table:name="My Sheet" table:style-name="ta1">')
    expect(c).toContain('table:display="false"')
    expect(c).toContain('table:number-columns-repeated="2"')
    expect(c).toContain('table:visibility="collapse"')
    expect(c).toContain('xlink:href="https://example.com/?a=1&amp;b=2"')
    expect(c).toContain(
      '<table:named-range table:name="Rate" table:base-cell-address="$Data.$B$1" table:cell-range-address="$Data.$B$1"/>',
    )
    expect(c).toContain('table:formula="of:=Rate*2"')
    expect(res.dropped).toEqual(
      expect.arrayContaining([
        'conditional formatting: 1',
        'data validation: 1',
        expect.stringContaining('defined names without safe ODF translation: 1'),
      ]),
    )
  })

  it('compresses sparse sheets and rejects non-xlsx input', async () => {
    const xlsx = await buildXlsx({
      sheets: [
        {
          name: 'Big',
          xml: '<sheetData><row r="1048576"><c r="XFD1048576"><v>1</v></c></row></sheetData>',
        },
      ],
    })
    const c = await content((await convertXlsxToOds(xlsx)).ods)
    expect(c).toContain('<table:table-row table:number-rows-repeated="1048575">')
    expect(c.length).toBeLessThan(3000)
    await expect(convertXlsxToOds(new Uint8Array([1, 2, 3]))).rejects.toThrow()
  })
})

// Round trip through LibreOffice when present: values must survive csv export.
const soffice = spawnSync('which', ['soffice']).status === 0 && process.env.SKIP_SOFFICE !== '1'
describe.skipIf(!soffice)('soffice round trip', () => {
  it('renders the same values as the source', async () => {
    const xlsx = await buildXlsx({
      styles: STYLES,
      shared: ['hello', 'a,b'],
      sheets: [
        {
          name: 'Data',
          xml:
            '<sheetData>' +
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>3.14159</v></c><c r="C1" s="2"><v>44927</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="s"><v>1</v></c></row>' +
            '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f>A2*21</f><v>999</v></c><c r="C2" s="3"><v>0.25</v></c><c r="D2" s="5"><v>0.5</v></c></row>' +
            '</sheetData>',
        },
      ],
    })
    const { ods } = await convertXlsxToOds(xlsx)
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-ods-'))
    try {
      writeFileSync(join(dir, 'in.ods'), ods)
      execFileSync(
        'soffice',
        [
          '--headless',
          '--convert-to',
          'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true',
          '--outdir',
          dir,
          join(dir, 'in.ods'),
        ],
        {
          stdio: 'ignore',
          timeout: 120_000,
          env: { ...process.env, HOME: dir },
        },
      )
      const rows = readFileSync(join(dir, 'in.csv'), 'utf8').trim().split('\n')
      // decimal separator follows the machine locale
      expect(rows[0]).toMatch(/^hello,"?3[.,]14"?,2023-01-01,(TRUE|VERO),"a,b"$/)
      // the cached 999 is stale on purpose: the formula must have been understood either way
      expect(rows[1]).toMatch(/^2,(999|42),25%,12:00,?$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)
})
