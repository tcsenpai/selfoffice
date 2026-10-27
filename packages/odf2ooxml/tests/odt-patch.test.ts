import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx, saveDocx, type SaveBlock } from '../../docx-engine/src/index'
import { scanChildren } from '../src/odt-patch'
import { convertOdtToDocx, patchOdt } from '../src/index'
import { OdfPatchError } from '../src/patch-error'

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
  ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"' +
  ' xmlns:foo="urn:example:foreign"'

/** 1×1 red PNG */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'))

// the things the editor cannot model, kept as exact substrings to assert on
const TRACKED =
  '<text:tracked-changes><text:changed-region text:id="ct1"><text:insertion><office:change-info>' +
  '<dc:creator>Rev</dc:creator><dc:date>2024-01-01T00:00:00</dc:date></office:change-info></text:insertion>' +
  '</text:changed-region></text:tracked-changes>'
const INTRO =
  '<text:p text:style-name="MyBody" foo:tag="keep">Intro with <text:change-start text:change-id="ct1"/>' +
  'tracked<text:change-end text:change-id="ct1"/> text.</text:p>'
const COMMENTED =
  '<text:p text:style-name="P1">A paragraph with a comment<office:annotation><dc:creator>Ann</dc:creator>' +
  '<dc:date>2024-01-02T00:00:00</dc:date><text:p>Check this</text:p></office:annotation> here.</text:p>'
const EDIT_ME = '<text:p text:style-name="MyBody">Edit me please.</text:p>'
const LIST =
  '<text:list text:style-name="L1"><text:list-item><text:p>alpha</text:p></text:list-item>' +
  '<text:list-item><text:p>bravo</text:p></text:list-item><text:list-item><text:p>charlie</text:p></text:list-item></text:list>'
const TABLE =
  '<table:table table:name="Table1"><table:table-column table:number-columns-repeated="2"/>' +
  '<table:table-row><table:table-cell office:value-type="string"><text:p>x1</text:p></table:table-cell>' +
  '<table:table-cell office:value-type="string"><text:p>y1</text:p></table:table-cell></table:table-row>' +
  '<table:table-row><table:table-cell office:value-type="string"><text:p>x2</text:p></table:table-cell>' +
  '<table:table-cell office:value-type="string"><text:p>y2</text:p></table:table-cell></table:table-row></table:table>'
const CHART =
  '<text:p text:style-name="Standard"><draw:frame draw:name="Object1" text:anchor-type="as-char" svg:width="8cm" svg:height="5cm">' +
  '<draw:object xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '<draw:image xlink:href="./ObjectReplacements/Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '</draw:frame></text:p>'
const CLOSING = '<text:p text:style-name="MyBody">Closing words.</text:p>'

const BODY = [
  TRACKED,
  '<text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Table"/></text:sequence-decls>',
  '<text:h text:style-name="Heading_20_1" text:outline-level="1">Report</text:h>',
  INTRO,
  COMMENTED,
  EDIT_ME,
  LIST,
  TABLE,
  CHART,
  CLOSING,
].join('\n    ')

const CONTENT =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS} office:version="1.3">\n  ` +
  '<office:automatic-styles>' +
  '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style>' +
  '<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style>' +
  '</office:automatic-styles>\n  ' +
  `<office:body>\n  <office:text>\n    ${BODY}\n  </office:text>\n  </office:body>\n</office:document-content>`

const STYLES =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS} office:version="1.3">` +
  '<office:styles><style:default-style style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:default-style>' +
  '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
  '<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="1"><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>' +
  '<style:style style:name="MyBody" style:display-name="My Body" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:color="#336699"/></style:style>' +
  '</office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles>' +
  '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">' +
  '<style:header><text:p>Header text</text:p></style:header><style:footer><text:p>Footer text</text:p></style:footer>' +
  '</style:master-page></office:master-styles></office:document-styles>'

const SETTINGS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.3"><office:settings><config:config-item-set config:name="ooo:view-settings"><config:config-item config:name="ViewAreaTop" config:type="long">0</config:config-item></config:config-item-set></office:settings></office:document-settings>'
const META = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${NS} office:version="1.3"><office:meta><meta:generator>Test/1.0</meta:generator><dc:title>Fixture</dc:title></office:meta></office:document-meta>`
const CHART_CONTENT =
  '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" office:version="1.3"><office:body><office:chart><chart:chart chart:class="chart:bar"/></office:chart></office:body></office:document-content>'
const MANIFEST =
  '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
  '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
  '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="Object 1/content.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="Object 1/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.chart"/>' +
  '<manifest:file-entry manifest:full-path="ObjectReplacements/Object 1" manifest:media-type="image/png"/>' +
  '<manifest:file-entry manifest:full-path="Pictures/image1.png" manifest:media-type="image/png"/>' +
  '</manifest:manifest>'

async function buildFixture(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' })
  zip.file('content.xml', CONTENT)
  zip.file('styles.xml', STYLES)
  zip.file('settings.xml', SETTINGS)
  zip.file('meta.xml', META)
  zip.file('Object 1/content.xml', CHART_CONTENT)
  zip.file('ObjectReplacements/Object 1', PNG)
  // a picture name the patch must not reuse for a new image
  zip.file('Pictures/image1.png', PNG)
  zip.file('META-INF/manifest.xml', MANIFEST)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function entries(odt: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(odt)
  const out = new Map<string, Uint8Array>()
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir) out.set(entry.name, await entry.async('uint8array'))
  }
  return out
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes)

/** the editor's save: docx-engine's own saveDocx over the baseline with some blocks replaced */
async function edit(
  baseline: Uint8Array,
  mutate: (blocks: SaveBlock[], bodyXml: string[]) => SaveBlock[],
): Promise<Uint8Array> {
  const parsed = await parseDocx(baseline)
  const blocks: SaveBlock[] = parsed.blocks
    .filter((block) => !block.hidden)
    .map((block) => ({ kind: 'original', docxIndex: block.docxIndex as number }))
  const documentXml = text((await entries(baseline)).get('word/document.xml'))
  const bodyXml = scanChildren(documentXml, 'w:body')
    .children.filter((span) => span.name !== 'w:sectPr')
    .map((span) => documentXml.slice(span.start, span.end))
  return saveDocx(parsed as never, mutate(blocks, bodyXml))
}

const indexOfText = (bodyXml: string[], snippet: string): number => {
  const index = bodyXml.findIndex((xml) => xml.includes(snippet))
  if (index < 0) throw new Error(`no block with ${snippet}`)
  return index
}

async function setup(): Promise<{ odt: Uint8Array; baseline: Uint8Array }> {
  const odt = await buildFixture()
  return { odt, baseline: (await convertOdtToDocx(odt)).docx }
}

/** every entry of `patched` except `changed` holds exactly the original bytes */
async function expectUntouched(
  original: Uint8Array,
  patched: Uint8Array,
  changed: string[],
): Promise<Map<string, Uint8Array>> {
  const before = await entries(original)
  const after = await entries(patched)
  for (const [name, bytes] of before) {
    if (changed.includes(name)) continue
    expect(after.get(name), name).toEqual(bytes)
  }
  expect(Object.keys((await JSZip.loadAsync(patched)).files)[0]).toBe('mimetype')
  return after
}

/** the ODF constructs the editor never sees, all still there byte-for-byte */
function expectPreserved(content: string, except: string[] = []): void {
  for (const piece of [TRACKED, INTRO, COMMENTED, EDIT_ME, LIST, TABLE, CHART, CLOSING]) {
    if (!except.includes(piece)) expect(content).toContain(piece)
  }
}

describe('patchOdt', () => {
  it('records which office:text child every docx block came from', async () => {
    const { sourceMap } = await convertOdtToDocx(await buildFixture())
    // children: 0 tracked-changes, 1 sequence-decls (no blocks), 2 heading, 3 intro,
    // 4 commented, 5 edit-me, 6 list (3 items), 7 table, 8 chart paragraph(s), 9 closing
    expect(sourceMap.slice(0, 7)).toEqual([2, 3, 4, 5, 6, 6, 6])
    expect(sourceMap).toContain(7)
    expect(sourceMap[sourceMap.length - 1]).toBe(9)
  })

  it('returns the original package unchanged when nothing was edited', async () => {
    const { odt, baseline } = await setup()
    const result = await patchOdt(odt, baseline, baseline)
    expect(result.odt).toEqual(odt)
    expect(result.rewritten + result.inserted + result.removed).toBe(0)
    // a save through docx-engine with no edit must also be a no-op
    const resaved = await edit(baseline, (blocks) => blocks)
    expect((await patchOdt(odt, baseline, resaved)).odt).toEqual(odt)
  })

  it('rewrites only the edited paragraph and keeps its ODF style', async () => {
    const { odt, baseline } = await setup()
    const current = await edit(baseline, (blocks, body) => {
      const index = indexOfText(body, 'Edit me please.')
      blocks[index] = {
        kind: 'generated',
        block: { type: 'paragraph', runs: [{ text: 'Edited text.' }] },
        docxIndex: index,
      }
      return blocks
    })
    const result = await patchOdt(odt, baseline, current)
    expect(result).toMatchObject({ rewritten: 1, inserted: 1, removed: 1 })
    const after = await expectUntouched(odt, result.odt, ['content.xml'])
    const content = text(after.get('content.xml'))
    expect(content).toBe(
      CONTENT.replace(EDIT_ME, '<text:p text:style-name="MyBody">Edited text.</text:p>'),
    )
    expectPreserved(content, [EDIT_ME])
  })

  it('keeps the original folder entries and adds none (strict ODF consumers dislike them)', async () => {
    const { odt, baseline } = await setup()
    const current = await edit(baseline, (blocks, body) => {
      const index = indexOfText(body, 'Edit me please.')
      blocks[index] = {
        kind: 'generated',
        block: { type: 'paragraph', runs: [{ text: 'Edited text.' }] },
        docxIndex: index,
      }
      return blocks
    })
    const dirs = async (bytes: Uint8Array) =>
      Object.keys((await JSZip.loadAsync(bytes, { createFolders: false })).files)
        .filter((n) => n.endsWith('/'))
        .sort()
    expect(await dirs((await patchOdt(odt, baseline, current)).odt)).toEqual(await dirs(odt))
  })

  it('inserts a new paragraph between kept children', async () => {
    const { odt, baseline } = await setup()
    const current = await edit(baseline, (blocks, body) => {
      const at = indexOfText(body, 'Report') + 1
      blocks.splice(at, 0, {
        kind: 'generated',
        block: { type: 'paragraph', runs: [{ text: 'Brand new', bold: true }] },
      })
      return blocks
    })
    const result = await patchOdt(odt, baseline, current)
    expect(result).toMatchObject({ inserted: 1, removed: 0, rewritten: 1 })
    const content = text(
      (await expectUntouched(odt, result.odt, ['content.xml'])).get('content.xml'),
    )
    expectPreserved(content)
    const heading = content.indexOf('Report</text:h>')
    const fresh = content.indexOf('Brand new')
    expect(fresh).toBeGreaterThan(heading)
    expect(fresh).toBeLessThan(content.indexOf(INTRO))
    // its bold span style is a new automatic style that does not collide with P1/L1
    const span = /<text:span text:style-name="([^"]+)">Brand new/.exec(content)
    expect(span).not.toBeNull()
    expect(content).toContain(`<style:style style:name="${span![1]}" style:family="text">`)
    expect(span![1]).not.toBe('P1')
  })

  it('deletes an item inside a list and rewrites only that list', async () => {
    const { odt, baseline } = await setup()
    const current = await edit(baseline, (blocks, body) => {
      blocks.splice(indexOfText(body, 'bravo'), 1)
      return blocks
    })
    const result = await patchOdt(odt, baseline, current)
    expect(result).toMatchObject({ removed: 1, inserted: 0, rewritten: 2 })
    const content = text(
      (await expectUntouched(odt, result.odt, ['content.xml', 'styles.xml'])).get('content.xml'),
    )
    expectPreserved(content, [LIST])
    expect(content).not.toContain('bravo')
    const list = /<text:list text:style-name="(L\d+)">[\s\S]*?<\/text:list>/.exec(content)
    expect(list?.[0]).toContain('alpha')
    expect(list?.[0]).toContain('charlie')
    expect(list?.[1]).not.toBe('L1') // the original list style name is taken
    expect(content).toContain(`<text:list-style style:name="${list?.[1]}">`)
    // the docx ListParagraph style the items now reference is added; O's own styles stay put
    const styles = text((await entries(result.odt)).get('styles.xml'))
    expect(styles).toContain('style:name="ListParagraph"')
    expect(
      styles.replace(/<style:style style:name="ListParagraph"[\s\S]*?<\/style:style>/, ''),
    ).toBe(STYLES)
  })

  it('edits a table cell and keeps everything around the table', async () => {
    const { odt, baseline } = await setup()
    const current = await edit(baseline, (blocks, body) => {
      const index = indexOfText(body, '<w:tbl>')
      blocks[index] = {
        kind: 'xml',
        xml: body[index].replace('>y2<', '>changed<'),
        docxIndex: index,
      }
      return blocks
    })
    const result = await patchOdt(odt, baseline, current)
    expect(result.removed).toBe(1)
    const after = await expectUntouched(odt, result.odt, ['content.xml', 'styles.xml'])
    const content = text(after.get('content.xml'))
    expectPreserved(content, [TABLE])
    expect(content).toMatch(/<table:table [^>]*>[\s\S]*x1[\s\S]*changed[\s\S]*<\/table:table>/)
    expect(content).not.toContain('Table1"') // the new table got a free name
  })

  it('adds an inserted image to Pictures/ and the manifest', async () => {
    const { odt, baseline } = await setup()
    const current = await edit(baseline, (blocks, body) => {
      blocks.splice(indexOfText(body, 'Closing words.'), 0, {
        kind: 'image',
        image: { base64: PNG_BASE64, mime: 'image/png', widthPx: 40, heightPx: 30 },
      })
      return blocks
    })
    const result = await patchOdt(odt, baseline, current)
    expect(result.inserted).toBe(1)
    const after = await expectUntouched(odt, result.odt, ['content.xml', 'META-INF/manifest.xml'])
    const content = text(after.get('content.xml'))
    expectPreserved(content)
    const href = /<draw:image xlink:href="(Pictures\/[^"]+)"/.exec(content)?.[1]
    expect(href).toBeDefined()
    expect(href).not.toBe('Pictures/image1.png')
    expect(after.get(href!)).toEqual(PNG)
    const manifest = text(after.get('META-INF/manifest.xml'))
    expect(manifest).toContain(`manifest:full-path="${href}" manifest:media-type="image/png"`)
    expect(manifest.startsWith(MANIFEST.replace('</manifest:manifest>', ''))).toBe(true)
  })

  it('refuses a baseline that is not the import of the original', async () => {
    const { odt, baseline } = await setup()
    const other = await edit(baseline, (blocks) => blocks.slice(1))
    await expect(patchOdt(odt, other, baseline)).rejects.toBeInstanceOf(OdfPatchError)
  })

  const soffice =
    process.env.SKIP_SOFFICE === '1'
      ? null
      : (() => {
          try {
            return execFileSync('which', ['soffice'], { encoding: 'utf8' }).trim() || null
          } catch {
            return null
          }
        })()

  it.skipIf(!soffice)(
    'produces a file LibreOffice converts to PDF',
    async () => {
      const { odt, baseline } = await setup()
      const current = await edit(baseline, (blocks, body) => {
        blocks.splice(indexOfText(body, 'bravo'), 1)
        blocks.splice(indexOfText(body, 'Report') + 1, 0, {
          kind: 'generated',
          block: { type: 'paragraph', runs: [{ text: 'Brand new', italic: true }] },
        })
        return blocks
      })
      const { odt: patched } = await patchOdt(odt, baseline, current)
      const dir = mkdtempSync(join(tmpdir(), 'odt-patch-'))
      try {
        const file = join(dir, 'patched.odt')
        writeFileSync(file, patched)
        const run = spawnSync(
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
          { timeout: 120_000 },
        )
        expect(run.status).toBe(0)
        expect(existsSync(join(dir, 'patched.pdf'))).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    150_000,
  )
})
