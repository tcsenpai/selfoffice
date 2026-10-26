import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { convertDocxToOdt, convertOdtToDocx } from '../src/index'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const DRAW =
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
  ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

/** 1x1 red PNG */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const run = (text: string, rPr = ''): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const para = (inner: string, pPr = ''): string =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`
const listP = (text: string, numId: number, ilvl: number): string =>
  para(run(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`)

const image =
  `<w:r><w:drawing><wp:inline ${DRAW}><wp:extent cx="720000" cy="360000"/>` +
  '<wp:docPr id="1" name="Picture 1" descr="a red dot"/><a:graphic><a:graphicData>' +
  '<pic:pic><pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill></pic:pic>' +
  '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'

const cell = (text: string, tcPr = ''): string =>
  `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${para(run(text))}</w:tc>`

const BODY =
  para(run('Quarterly Report'), '<w:pStyle w:val="Heading1"/>') +
  para(
    run('plain ') +
      run('bold', '<w:b/>') +
      run(' and ') +
      run('italic', '<w:i/><w:color w:val="FF0000"/><w:sz w:val="28"/>') +
      '<w:r><w:tab/></w:r>' +
      run('x', '<w:vertAlign w:val="superscript"/>') +
      `<w:hyperlink r:id="rId5">${run('the site')}</w:hyperlink>` +
      '<w:bookmarkStart w:id="1" w:name="mark1"/><w:bookmarkEnd w:id="1"/>' +
      '<w:r><w:footnoteReference w:id="2"/></w:r>',
    '<w:jc w:val="center"/><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:ind w:left="720"/><w:keepNext/>',
  ) +
  listP('bullet one', 1, 0) +
  listP('bullet two', 1, 0) +
  listP('nested number', 2, 1) +
  para(run('after list')) +
  para(image) +
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
  `<w:tr>${cell('merged header', '<w:gridSpan w:val="2"/><w:shd w:val="clear" w:fill="DDDDDD"/>')}</w:tr>` +
  `<w:tr>${cell('left', '<w:vMerge w:val="restart"/>')}${cell('cell B')}</w:tr>` +
  `<w:tr>${cell('', '<w:vMerge/>')}${cell('cell D')}</w:tr></w:tbl>` +
  para(run('before break') + '<w:r><w:br w:type="page"/></w:r>' + run('after break')) +
  '<w:sectPr><w:headerReference w:type="default" r:id="rId7"/><w:footerReference w:type="default" r:id="rId8"/>' +
  '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>' +
  '<w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="720" w:footer="720"/></w:sectPr>'

function note(id: number, text: string): string {
  return `<w:footnote w:id="${id}">${para(run(text))}</w:footnote>`
}

async function buildDocx(
  body = BODY,
  extra: Record<string, string | Buffer> = {},
): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document ${W} ${R}><w:body>${body}</w:body></w:document>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId5" Type="x" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/>' +
      '<Relationship Id="rId7" Type="x" Target="header1.xml"/><Relationship Id="rId8" Type="x" Target="footer1.xml"/>' +
      '<Relationship Id="rId9" Type="x" Target="media/image1.png"/></Relationships>',
  )
  zip.file(
    'word/styles.xml',
    `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
      '<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>',
  )
  zip.file(
    'word/numbering.xml',
    `<w:numbering ${W}>` +
      '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#xF0B7;"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
      '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>' +
      '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
  )
  zip.file('word/footnotes.xml', `<w:footnotes ${W}>${note(2, 'the footnote text')}</w:footnotes>`)
  zip.file('word/header1.xml', `<w:hdr ${W}>${para(run('Header text'))}</w:hdr>`)
  zip.file(
    'word/footer1.xml',
    `<w:ftr ${W}>${para(run('Page ') + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>')}</w:ftr>`,
  )
  zip.file('word/media/image1.png', PNG)
  for (const [path, content] of Object.entries(extra)) zip.file(path, content)
  return zip.generateAsync({ type: 'uint8array' })
}

async function entry(odt: Uint8Array, path: string): Promise<string> {
  const f = (await JSZip.loadAsync(odt)).file(path)
  return f ? f.async('string') : ''
}

describe('convertDocxToOdt', () => {
  it('writes a valid package skeleton with a stored, first mimetype', async () => {
    const { odt, blocks } = await convertDocxToOdt(await buildDocx())
    const zip = await JSZip.loadAsync(odt)
    expect(Object.keys(zip.files)[0]).toBe('mimetype')
    expect(await zip.file('mimetype')!.async('string')).toBe(
      'application/vnd.oasis.opendocument.text',
    )
    // STORED: local header method field (offset 8) is 0
    expect(new DataView(odt.buffer, odt.byteOffset).getUint16(8, true)).toBe(0)
    for (const p of [
      'META-INF/manifest.xml',
      'content.xml',
      'styles.xml',
      'meta.xml',
      'Pictures/image1.png',
    ]) {
      expect(zip.file(p), p).toBeTruthy()
    }
    expect(await entry(odt, 'META-INF/manifest.xml')).toContain('Pictures/image1.png')
    expect(blocks).toBeGreaterThan(8)
  })

  it('maps headings, formatting, links, bookmarks, tabs, notes, images, page breaks', async () => {
    const { odt, dropped } = await convertDocxToOdt(await buildDocx())
    const content = await entry(odt, 'content.xml')
    const styles = await entry(odt, 'styles.xml')
    expect(content).toMatch(/<text:h [^>]*text:outline-level="1"[^>]*>Quarterly Report<\/text:h>/)
    expect(content).toContain('fo:font-weight="bold"')
    expect(content).toContain('fo:font-style="italic"')
    expect(content).toContain('fo:color="#FF0000"')
    expect(content).toContain('fo:font-size="14pt"')
    expect(content).toContain('style:text-position="super 58%"')
    expect(content).toContain('fo:text-align="center"')
    expect(content).toContain('fo:keep-with-next="always"')
    expect(content).toContain('fo:line-height="150%"')
    expect(content).toContain('<text:tab/>')
    expect(content).toContain('xlink:href="https://example.com/a?b=1&amp;c=2"')
    expect(content).toContain('<text:bookmark-start text:name="mark1"/>')
    expect(content).toContain('<text:note text:id="ftn1" text:note-class="footnote">')
    expect(content).toContain('the footnote text')
    expect(content).toContain('<draw:image xlink:href="Pictures/image1.png"')
    expect(content).toContain('svg:width="2cm"')
    expect(content).toContain('<svg:desc>a red dot</svg:desc>')
    expect(content).toContain('fo:break-before="page"')
    // page layout, header and footer
    expect(styles).toContain('style:print-orientation="landscape"')
    expect(styles).toContain('fo:page-width="11in"')
    expect(styles).toContain('<style:header>')
    expect(styles).toContain('Header text')
    expect(styles).toContain('<text:page-number')
    expect(styles).toContain('style:default-outline-level="1"')
    expect(dropped).toEqual([])
  })

  it('emits lists with bullet and number level styles and nesting', async () => {
    const { odt } = await convertDocxToOdt(await buildDocx())
    const content = await entry(odt, 'content.xml')
    expect(content).toContain('<text:list-level-style-bullet text:level="1" text:bullet-char="•">')
    expect(content).toContain('style:num-format="a"')
    expect(content).toContain('style:num-suffix=")"')
    expect(content).toMatch(
      /<text:list text:style-name="L1"><text:list-item><text:p[^>]*>bullet one<\/text:p><\/text:list-item><text:list-item><text:p[^>]*>bullet two<\/text:p><\/text:list-item><\/text:list>/,
    )
    // level-1 paragraph opens a nested list inside the first list's item
    expect(content).toMatch(/<text:list-item><text:list><text:list-item><text:p[^>]*>nested number/)
  })

  it('maps tables: columns, spans, merges, borders and shading', async () => {
    const { odt } = await convertDocxToOdt(await buildDocx())
    const content = await entry(odt, 'content.xml')
    expect(content.match(/<table:table-column /g)).toHaveLength(2)
    expect(content).toContain('table:number-columns-spanned="2"')
    expect(content).toContain('table:number-rows-spanned="2"')
    expect(content).toContain('fo:background-color="#DDDDDD"')
    expect(content).toContain('style:column-width="2.0833in"')
    expect(content.match(/<table:covered-table-cell\/>/g)).toHaveLength(2)
    for (const t of ['merged header', 'left', 'cell B', 'cell D']) expect(content).toContain(t)
  })

  it('reports unsupported constructs once per kind with a count', async () => {
    const body =
      para(run('a') + '<w:r><w:pict/></w:r><w:r><w:pict/></w:r>') +
      para('<w:del><w:r><w:delText>gone</w:delText></w:r></w:del>' + run('kept')) +
      '<w:sectPr><w:cols w:num="2"/></w:sectPr>'
    const { odt, dropped } = await convertDocxToOdt(await buildDocx(body))
    expect(dropped).toContain('VML pictures and embedded objects (2)')
    expect(dropped).toContain('multi-column sections (1)')
    expect(dropped.some((d) => d.startsWith('tracked changes'))).toBe(true)
    const content = await entry(odt, 'content.xml')
    expect(content).toContain('kept')
    expect(content).not.toContain('gone')
  })

  it('escapes text and preserves runs of spaces', async () => {
    const { odt } = await convertDocxToOdt(await buildDocx(para(run('a  b &amp; &lt;c&gt;'))))
    const content = await entry(odt, 'content.xml')
    expect(content).toContain('a <text:s/>b &amp; &lt;c&gt;')
  })

  it('rejects non-docx input', async () => {
    const zip = new JSZip()
    zip.file('x.txt', 'nope')
    await expect(
      convertDocxToOdt(await zip.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow()
  })

  it('round-trips through convertOdtToDocx', async () => {
    const { odt } = await convertDocxToOdt(await buildDocx())
    const back = await convertOdtToDocx(odt)
    const doc = await entry(back.docx, 'word/document.xml')
    expect(doc).toContain('Quarterly Report')
    expect(doc).toContain('w:pStyle w:val="Heading1"')
    expect(doc).toContain('<w:b/>')
    expect(doc).toContain('<w:i/>')
    for (const t of ['bullet one', 'bullet two', 'nested number', 'after list'])
      expect(doc).toContain(t)
    for (const t of ['merged header', 'cell B', 'cell D']) expect(doc).toContain(t)
    expect(doc).toContain('w:numPr')
    const rels = await entry(back.docx, 'word/_rels/document.xml.rels')
    expect(rels).toContain('https://example.com/a?b=1&amp;c=2')
  })

  const soffice = process.env.SKIP_SOFFICE === '1' ? null : which('soffice')
  it.skipIf(!soffice)(
    'opens in LibreOffice and renders a PDF',
    async () => {
      const { odt } = await convertDocxToOdt(await buildDocx())
      const dir = mkdtempSync(join(tmpdir(), 'docx-odt-'))
      try {
        const file = join(dir, 'out.odt')
        writeFileSync(file, odt)
        const res = spawnSync(
          soffice!,
          [
            `-env:UserInstallation=file://${join(dir, 'profile')}`,
            '--headless',
            '--convert-to',
            'pdf',
            '--outdir',
            dir,
            file,
          ],
          { timeout: 120_000, encoding: 'utf8' },
        )
        expect(res.status, res.stderr).toBe(0)
        const pdf = join(dir, 'out.pdf')
        expect(statSync(pdf).size).toBeGreaterThan(1000)
        expect(readFileSync(pdf).subarray(0, 4).toString()).toBe('%PDF')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    150_000,
  )
})

function which(bin: string): string | null {
  const res = spawnSync('which', [bin], { encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : null
}
