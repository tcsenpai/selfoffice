import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  addElement,
  addPicture,
  deleteSlide,
  insertBlankSlide,
  openPptx,
  savePptx,
} from '../../pptx-engine/src/index'
import { convertOdpToPptx, patchOdp } from '../src/index'
import { OdfPatchError } from '../src/patch-error'

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
  ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"' +
  ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
  ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"' +
  ' xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"' +
  ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
  ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"' +
  ' xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"' +
  ' xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0"' +
  ' xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0"' +
  ' xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"'

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

const text = (id: string, body: string, y = '2cm'): string =>
  `<draw:frame draw:style-name="gr1" draw:id="${id}" xml:id="${id}" draw:layer="layout" svg:x="2cm" svg:y="${y}" svg:width="20cm" svg:height="3cm">` +
  `<draw:text-box><text:p text:style-name="P1">${body}</text:p></draw:text-box></draw:frame>`

const PAGE1 =
  '<draw:page draw:name="Intro" draw:style-name="dp1" draw:master-page-name="M1" presentation:presentation-page-layout-name="AL1T0">' +
  text('id1', 'Title') +
  text('id2', 'Second', '6cm') +
  '<anim:par presentation:node-type="timing-root"><anim:seq presentation:node-type="main-sequence">' +
  '<anim:par smil:begin="next"><anim:par smil:begin="0s"><anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="on-click" presentation:preset-class="entrance" presentation:preset-id="ooo-entrance-appear">' +
  '<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="id1" anim:sub-item="text" smil:attributeName="visibility" smil:to="visible"/>' +
  '</anim:par></anim:par></anim:par></anim:seq></anim:par>' +
  '<presentation:notes draw:style-name="dp1"><draw:page-thumbnail presentation:class="page" svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="7cm"/>' +
  '<draw:frame presentation:class="notes" svg:x="1cm" svg:y="9cm" svg:width="17cm" svg:height="10cm"><draw:text-box><text:p>Speaker note</text:p></draw:text-box></draw:frame></presentation:notes>' +
  '</draw:page>'

const PAGE2 =
  '<draw:page draw:name="Chart" draw:style-name="dp2" draw:master-page-name="M2">' +
  text('id3', 'Revenue') +
  '<draw:frame draw:style-name="gr1" svg:x="2cm" svg:y="6cm" svg:width="12cm" svg:height="8cm">' +
  '<draw:object draw:notify-on-update-of-ranges="" xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '<draw:image xlink:href="./ObjectReplacements/Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>' +
  '</draw:page>'

const PAGE3 =
  '<draw:page draw:name="Shapes" draw:style-name="dp1" draw:master-page-name="M1">' +
  text('id4', 'Third') +
  '<!-- a producer comment --><draw:custom-shape draw:style-name="gr1" svg:x="2cm" svg:y="9cm" svg:width="4cm" svg:height="4cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="star5"/></draw:custom-shape>' +
  '<draw:frame svg:x="8cm" svg:y="9cm" svg:width="3cm" svg:height="3cm"><draw:image xlink:href="Pictures/logo.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>' +
  '</draw:page>'

const CONTENT =
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS} office:version="1.3">` +
  '<office:automatic-styles>' +
  '<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:display-header="false"/></style:style>' +
  '<style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:transition-type="automatic" presentation:duration="PT3S" smil:type="fade" smil:subtype="crossfade" draw:fill="solid" draw:fill-color="#eeeeee"/></style:style>' +
  '<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none"/></style:style>' +
  '<style:style style:name="P1" style:family="paragraph"><style:text-properties fo:font-size="28pt"/></style:style>' +
  '</office:automatic-styles>' +
  '<office:body><office:presentation>' +
  '<presentation:footer-decl presentation:name="ftr1">Footer</presentation:footer-decl>\n' +
  `${PAGE1}\n${PAGE2}\n${PAGE3}\n` +
  '<presentation:settings presentation:mouse-visible="false"/>' +
  '</office:presentation></office:body></office:document-content>'

const STYLES =
  `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3">` +
  '<office:styles><style:style style:name="standard" style:family="graphic"/></office:styles>' +
  '<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout></office:automatic-styles>' +
  '<office:master-styles>' +
  '<style:master-page style:name="M1" style:page-layout-name="PM1"><draw:frame svg:x="1cm" svg:y="14cm" svg:width="5cm" svg:height="1cm"><draw:text-box><text:p>M1 footer</text:p></draw:text-box></draw:frame></style:master-page>' +
  '<style:master-page style:name="M2" style:page-layout-name="PM1"/>' +
  '</office:master-styles></office:document-styles>'

const MANIFEST =
  '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
  '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>' +
  ['content.xml', 'styles.xml', 'meta.xml', 'settings.xml']
    .map((p) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="text/xml"/>`)
    .join('') +
  '<manifest:file-entry manifest:full-path="Object 1/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.chart"/>' +
  '<manifest:file-entry manifest:full-path="Object 1/content.xml" manifest:media-type="text/xml"/>' +
  '<manifest:file-entry manifest:full-path="ObjectReplacements/Object 1" manifest:media-type="image/png"/>' +
  '<manifest:file-entry manifest:full-path="Pictures/logo.png" manifest:media-type="image/png"/>' +
  '<manifest:file-entry manifest:full-path="Thumbnails/thumbnail.png" manifest:media-type="image/png"/>' +
  '</manifest:manifest>'

const CHART =
  '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" office:version="1.3"><office:body><office:chart><chart:chart chart:class="chart:bar"/></office:chart></office:body></office:document-content>'

async function fixture(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation', { compression: 'STORE' })
  zip.file('content.xml', CONTENT)
  zip.file('styles.xml', STYLES)
  zip.file('meta.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS}/>`)
  zip.file(
    'settings.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-settings ${NS}/>`,
  )
  zip.file('Object 1/content.xml', CHART)
  zip.file('ObjectReplacements/Object 1', PNG)
  zip.file('Pictures/logo.png', PNG)
  zip.file('Thumbnails/thumbnail.png', PNG)
  zip.file('META-INF/manifest.xml', MANIFEST)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function entries(bytes: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, string>()
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    out.set(name, Buffer.from(await file.async('uint8array')).toString('base64'))
  }
  return out
}

async function content(bytes: Uint8Array): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file('content.xml')!.async('string')
}

const pages = (xml: string): string[] => xml.match(/<draw:page\b[\s\S]*?<\/draw:page>/g) ?? []

async function editEntry(
  pptx: Uint8Array,
  path: string,
  edit: (xml: string) => string,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(pptx)
  const xml = await zip.file(path)!.async('string')
  const next = edit(xml)
  expect(next).not.toBe(xml)
  zip.file(path, next)
  return zip.generateAsync({ type: 'uint8array' })
}

/** every entry except `except` is byte-identical between the two packages */
async function expectUntouched(a: Uint8Array, b: Uint8Array, except: string[]): Promise<void> {
  const ea = await entries(a)
  const eb = await entries(b)
  for (const [name, value] of ea) if (!except.includes(name)) expect(eb.get(name), name).toBe(value)
}

describe('convertOdpToPptx sourceMap', () => {
  it('maps every slide to its draw:page index among office:presentation children', async () => {
    const result = await convertOdpToPptx(await fixture())
    expect(result.slides).toBe(3)
    // the footer-decl is child 0
    expect(result.sourceMap).toEqual([1, 2, 3])
  })
})

describe('patchOdp', () => {
  it('returns the original bytes when nothing changed', async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const result = await patchOdp(odp, pptx, pptx)
    expect(result.odp).toBe(odp)
    expect(result).toMatchObject({ kept: 3, rewritten: 0, inserted: 0, removed: 0, dropped: [] })
    // an editor round trip with no edits is still a no-op
    const resaved = await savePptx(await openPptx(pptx))
    const again = await patchOdp(odp, pptx, resaved)
    expect(await entries(again.odp)).toEqual(await entries(odp))
  })

  it('rewrites only the edited slide and keeps its animations, notes and identity', async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const edited = await editEntry(pptx, 'ppt/slides/slide1.xml', (x) =>
      x.replace('<a:t>Title</a:t>', '<a:t>Edited title</a:t>'),
    )
    const result = await patchOdp(odp, pptx, edited)
    expect(result).toMatchObject({ kept: 2, rewritten: 1, inserted: 0, removed: 0 })
    expect(result.dropped.filter((d) => d.startsWith('animations-lost'))).toEqual([])

    const before = pages(CONTENT)
    const after = pages(await content(result.odp))
    expect(after).toHaveLength(3)
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
    const page = after[0]!
    // original page attributes (master, layout, transition style) survive
    expect(page.startsWith(before[0]!.slice(0, before[0]!.indexOf('>') + 1))).toBe(true)
    expect(page).toContain('Edited title')
    expect(page).not.toContain('>Title<')
    // the untouched frame and the animation/notes blocks are the original bytes
    expect(page).toContain(text('id2', 'Second', '6cm'))
    expect(page).toContain('smil:targetElement="id1"')
    expect(page).toContain('Speaker note')
    // the re-serialised frame kept the id the animation targets
    expect(page).toMatch(/<draw:frame [^>]*draw:id="id1"/)
    // its new styles were appended without clobbering O's
    const xml = await content(result.odp)
    expect(xml).toContain('<style:style style:name="dp2"')
    const names = [...xml.matchAll(/style:name="([^"]+)"/g)].map((m) => m[1])
    expect(new Set(names).size).toBe(names.length)
    await expectUntouched(odp, result.odp, ['content.xml'])
  })

  it('keeps a chart and the transition of a slide whose text changed', async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const edited = await editEntry(pptx, 'ppt/slides/slide2.xml', (x) =>
      x.replace('<a:t>Revenue</a:t>', '<a:t>Revenue 2026</a:t>'),
    )
    const result = await patchOdp(odp, pptx, edited)
    const page = pages(await content(result.odp))[1]!
    expect(page).toContain('Revenue 2026')
    expect(page).toContain(
      '<draw:object draw:notify-on-update-of-ranges="" xlink:href="./Object 1"',
    )
    expect(page).toMatch(
      /^<draw:page draw:name="Chart" draw:style-name="dp2" draw:master-page-name="M2">/,
    )
    expect(result.dropped).not.toContain('objects-flattened')
    await expectUntouched(odp, result.odp, ['content.xml'])
  })

  it('reports lost animations when their target frame is deleted', async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const edited = await editEntry(pptx, 'ppt/slides/slide1.xml', (x) =>
      x.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<a:t>Title<\/a:t>[\s\S]*?<\/p:sp>/, ''),
    )
    const result = await patchOdp(odp, pptx, edited)
    expect(result.dropped).toContain('animations-lost:1')
    const page = pages(await content(result.odp))[0]!
    expect(page).not.toContain('anim:par')
    expect(page).toContain('Second')
    expect(page).toContain('Speaker note')
  })

  it('adds a slide on the neighbour master with new pictures in the manifest', async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const opened = await openPptx(pptx)
    const slide = insertBlankSlide(opened, 1)!
    addElement(slide, {
      kind: 'textbox',
      offset: { x: 360_000, y: 360_000, cx: 3_600_000, cy: 720_000 },
      paragraphs: [{ runs: [{ text: 'Brand new' }] }],
    })
    addPicture(opened, slide, {
      bytes: PNG,
      ext: 'png',
      offset: { x: 360_000, y: 1_800_000, cx: 720_000, cy: 720_000 },
    })
    const result = await patchOdp(odp, pptx, await savePptx(opened))
    expect(result).toMatchObject({ kept: 3, rewritten: 0, inserted: 1, removed: 0 })
    const after = pages(await content(result.odp))
    const before = pages(CONTENT)
    expect(after).toHaveLength(4)
    expect([after[0], after[1], after[3]]).toEqual(before)
    expect(after[2]).toContain('Brand new')
    expect(after[2]).toContain('draw:master-page-name="M2"')
    const href = /<draw:image xlink:href="(Pictures\/[^"]+)"/.exec(after[2]!)?.[1]
    expect(href).toBeDefined()
    const zip = await JSZip.loadAsync(result.odp)
    expect(await zip.file(href!)!.async('uint8array')).toEqual(PNG)
    const manifest = await zip.file('META-INF/manifest.xml')!.async('string')
    expect(manifest.startsWith(MANIFEST.replace('</manifest:manifest>', ''))).toBe(true)
    expect(manifest).toContain(`manifest:full-path="${href}" manifest:media-type="image/png"`)
    await expectUntouched(odp, result.odp, ['content.xml', 'META-INF/manifest.xml'])
  })

  it('removes a deleted slide and leaves the others byte-identical', async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const opened = await openPptx(pptx)
    expect(deleteSlide(opened, 1)).toBe(true)
    const result = await patchOdp(odp, pptx, await savePptx(opened))
    expect(result).toMatchObject({ kept: 2, rewritten: 0, inserted: 0, removed: 1 })
    const before = pages(CONTENT)
    expect(pages(await content(result.odp))).toEqual([before[0], before[2]])
    const xml = await content(result.odp)
    expect(xml).toContain('<presentation:settings presentation:mouse-visible="false"/>')
    expect(xml).toContain('<presentation:footer-decl')
  })

  it('reorders raw page spans', async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const reordered = await editEntry(pptx, 'ppt/presentation.xml', (x) =>
      x.replace(/(<p:sldId [^>]*\/>)(<p:sldId [^>]*\/>)(<p:sldId [^>]*\/>)/, '$3$1$2'),
    )
    const result = await patchOdp(odp, pptx, reordered)
    expect(result).toMatchObject({ kept: 3, rewritten: 0, inserted: 0, removed: 0 })
    const before = pages(CONTENT)
    expect(pages(await content(result.odp))).toEqual([before[2], before[0], before[1]])
  })

  it('writes mimetype first and stored', async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const opened = await openPptx(pptx)
    deleteSlide(opened, 0)
    const { odp: out } = await patchOdp(odp, pptx, await savePptx(opened))
    const view = new DataView(out.buffer, out.byteOffset)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint16(8, true)).toBe(0) // STORE
    expect(new TextDecoder().decode(out.slice(30, 38))).toBe('mimetype')
  })

  it('refuses a baseline that does not belong to the original', async () => {
    const odp = await fixture()
    const other = await JSZip.loadAsync(odp)
    other.file('content.xml', CONTENT.replace(PAGE3, ''))
    const { pptx } = await convertOdpToPptx(await other.generateAsync({ type: 'uint8array' }))
    await expect(patchOdp(odp, pptx, pptx)).rejects.toBeInstanceOf(OdfPatchError)
    await expect(patchOdp(odp, pptx, pptx)).rejects.toMatchObject({ code: 'source-map-mismatch' })
    await expect(patchOdp(new Uint8Array([1, 2, 3]), pptx, pptx)).rejects.toMatchObject({
      code: 'unreadable-odp',
    })
  })
})

function sofficeAvailable(): boolean {
  if (process.env.SKIP_SOFFICE === '1') return false
  try {
    execFileSync('which', ['soffice'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!sofficeAvailable())('patched .odp opens in LibreOffice', () => {
  it('renders every page to PDF', { timeout: 120_000 }, async () => {
    const odp = await fixture()
    const { pptx } = await convertOdpToPptx(odp)
    const opened = await openPptx(pptx)
    const slide = insertBlankSlide(opened, 0)!
    addElement(slide, {
      kind: 'textbox',
      offset: { x: 360_000, y: 360_000, cx: 3_600_000, cy: 720_000 },
      paragraphs: [{ runs: [{ text: 'Inserted' }] }],
    })
    let current = await savePptx(opened)
    current = await editEntry(current, 'ppt/slides/slide1.xml', (x) =>
      x.replace('<a:t>Title</a:t>', '<a:t>Edited</a:t>'),
    )
    const result = await patchOdp(odp, pptx, current)
    expect(result).toMatchObject({ kept: 2, rewritten: 1, inserted: 1 })

    const dir = mkdtempSync(join(tmpdir(), 'odp-patch-'))
    try {
      writeFileSync(join(dir, 'deck.odp'), result.odp)
      execFileSync(
        'soffice',
        [
          `-env:UserInstallation=file://${dir}/profile`,
          '--headless',
          '--convert-to',
          'pdf',
          '--outdir',
          dir,
          join(dir, 'deck.odp'),
        ],
        { stdio: 'ignore', timeout: 110_000 },
      )
      expect(readdirSync(dir)).toContain('deck.pdf')
      const pdf = readFileSync(join(dir, 'deck.pdf')).toString('latin1')
      expect(pdf.match(/\/Type\s*\/Page\b/g)?.length).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
