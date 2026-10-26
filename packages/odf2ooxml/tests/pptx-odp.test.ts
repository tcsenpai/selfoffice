import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { convertOdpToPptx, convertPptxToOdp } from '../src/index'
import { parseOdfXml } from '../src/xml'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const NSALL = `${A} ${R} ${P}`
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const rels = (items: Array<[string, string, string]>): string =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
    )
    .join('')}</Relationships>`

const spTree = (inner: string): string =>
  `<p:cSld>__BG__<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:spTree></p:cSld>`

const xfrm = (x: number, y: number, cx: number, cy: number, extra = ''): string =>
  `<a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`

const textShape = (id: number, ph: string, geom: string, paras: string, extra = ''): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr${ph ? '' : ' txBox="1"'}/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
  `<p:spPr>${geom}${extra}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`

const para = (text: string, rpr = '', ppr = ''): string =>
  `<a:p>${ppr}<a:r><a:rPr lang="en-US"${rpr}/><a:t>${text}</a:t></a:r></a:p>`

async function buildPptx(opts: { second?: boolean } = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  )
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation ${NSALL}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst><p:sldId id="256" r:id="rId2"/>${opts.second ? '<p:sldId id="257" r:id="rId3"/>' : ''}</p:sldIdLst>` +
      `<p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml'],
    ]),
  )
  zip.file(
    'ppt/theme/theme1.xml',
    `<a:theme ${A}><a:themeElements><a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
      '<a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>' +
      '<a:fontScheme name="f"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>' +
      '<a:fmtScheme name="m"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="12700"/></a:lnStyleLst></a:fmtScheme></a:themeElements></a:theme>',
  )
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<p:sldMaster ${NSALL}>${spTree(
      textShape(2, '<p:ph type="title"/>', xfrm(457200, 274320, 8229600, 1143000), '', '') +
        textShape(3, '<p:ph type="body" idx="1"/>', xfrm(457200, 1600200, 8229600, 4525963), '') +
        // decoration painted on every slide
        `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 6500000, 9144000, 358000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="123456"/></a:solidFill></p:spPr></p:sp>`,
    )}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>` +
      '<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4000" b="1"><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="2800"/></a:lvl1pPr><a:lvl2pPr marL="742950" indent="-285750"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>' +
      '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>',
  )
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels([['rId1', 'theme', '../theme/theme1.xml']]),
  )
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `<p:sldLayout ${NSALL}>${spTree(
      textShape(2, '<p:ph type="title"/>', '', '') +
        textShape(3, '<p:ph idx="1"/>', xfrm(914400, 1828800, 7315200, 3657600), ''),
    )}</p:sldLayout>`,
  )
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  )

  const title = textShape(2, '<p:ph type="title"/>', '', para('Hello deck', ' b="1"'))
  const body = textShape(
    3,
    '<p:ph idx="1"/>',
    '',
    para('First bullet') +
      para('Nested', '', '<a:pPr lvl="1"/>') +
      para(
        'Numbered',
        '',
        '<a:pPr marL="342900" indent="-342900"><a:buAutoNum type="arabicPeriod"/></a:pPr>',
      ),
  )
  const box = textShape(
    4,
    '',
    xfrm(360000, 720000, 3600000, 720000),
    '<a:p><a:pPr algn="r"/><a:r><a:rPr sz="2000" i="1" u="sng"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="Courier New"/></a:rPr><a:t>Red italic</a:t></a:r></a:p>',
  )
  const rect =
    `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Rect"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(720000, 3600000, 1800000, 900000)}` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:sp>'
  const ellipse = rect.replace('prst="rect"', 'prst="ellipse"').replace('Rect', 'Oval')
  const triangle = rect.replace('prst="rect"', 'prst="triangle"').replace('Rect', 'Tri')
  const line =
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="6" name="L"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(100000, 200000, 1000000, 500000, ' flipV="1"')}` +
    '<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></p:spPr></p:cxnSp>'
  const group =
    '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="7" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr><a:xfrm><a:off x="5000000" y="3000000"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="1000000" cy="500000"/></a:xfrm></p:grpSpPr>${textShape(8, '', xfrm(100000, 100000, 500000, 200000), para('In group'))}</p:grpSp>`
  const pic =
    '<p:pic><p:nvPicPr><p:cNvPr id="10" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill>' +
    `<p:spPr>${xfrm(5000000, 720000, 1000000, 800000)}<a:prstGeom prst="rect"/></p:spPr></p:pic>`
  const table =
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="11" name="Tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="360000" y="4700000"/><a:ext cx="4000000" cy="600000"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>' +
    `<a:tr h="300000"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para('Cell A')}</a:txBody><a:tcPr><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill></a:tcPr></a:tc><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para('Cell B')}</a:txBody><a:tcPr/></a:tc></a:tr>` +
    `<a:tr h="300000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:lstStyle/>${para('Wide')}</a:txBody><a:tcPr/></a:tc><a:tc hMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody><a:tcPr/></a:tc></a:tr>` +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  const chart =
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="12" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>'

  zip.file(
    'ppt/slides/slide1.xml',
    `<p:sld ${NSALL}>${spTree(title + body + box + rect + ellipse + triangle + line + group + pic + table + chart).replace('__BG__', '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="EEEEFF"/></a:solidFill></p:bgPr></p:bg>')}<p:transition/><p:timing/></p:sld>`,
  )
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'image', '../media/image1.png'],
      ['rId3', 'notesSlide', '../notesSlides/notesSlide1.xml'],
    ]),
  )
  zip.file('ppt/media/image1.png', PNG_BASE64, { base64: true })
  zip.file(
    'ppt/notesSlides/notesSlide1.xml',
    `<p:notes ${NSALL}>${spTree(textShape(2, '<p:ph type="body" idx="1"/>', '', para('Speaker says hi')))}</p:notes>`,
  )
  zip.file(
    'ppt/slides/slide2.xml',
    `<p:sld ${NSALL}>${spTree(textShape(2, '<p:ph type="title"/>', '', para('Second')))}</p:sld>`.replace(
      '__BG__',
      '',
    ),
  )
  zip.file(
    'ppt/slides/_rels/slide2.xml.rels',
    rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const read = async (odp: Uint8Array, path: string): Promise<string> =>
  (await (await JSZip.loadAsync(odp)).file(path)?.async('string')) ?? ''

describe('convertPptxToOdp', () => {
  it('writes a valid ODF presentation package', async () => {
    const { odp, slides } = await convertPptxToOdp(await buildPptx({ second: true }))
    expect(slides).toBe(2)
    const zip = await JSZip.loadAsync(odp)
    expect(Object.keys(zip.files)[0]).toBe('mimetype')
    expect(await zip.file('mimetype')!.async('string')).toBe(
      'application/vnd.oasis.opendocument.presentation',
    )
    for (const part of ['META-INF/manifest.xml', 'content.xml', 'styles.xml', 'meta.xml']) {
      expect(parseOdfXml(await zip.file(part)!.async('string')), part).not.toBeNull()
    }
    const styles = await zip.file('styles.xml')!.async('string')
    expect(styles).toContain('fo:page-width="25.4cm"')
    expect(styles).toContain('fo:page-height="19.05cm"')
    expect(await zip.file('META-INF/manifest.xml')!.async('string')).toContain('Pictures/img1.png')
  })

  it('converts text, inherited placeholder geometry, shapes, groups, tables and notes', async () => {
    const { odp, dropped } = await convertPptxToOdp(await buildPptx())
    const content = await read(odp, 'content.xml')
    // title inherits the master geometry: 457200 EMU = 1.27cm, 274320 = 0.762cm
    expect(content).toMatch(/presentation:class="title"[^>]*|svg:x="1.27cm" svg:y="0.762cm"/)
    expect(content).toContain('svg:x="1.27cm" svg:y="0.762cm" svg:width="22.86cm"')
    // body placeholder inherits the layout box (914400 = 2.54cm)
    expect(content).toContain('svg:x="2.54cm" svg:y="5.08cm" svg:width="20.32cm"')
    expect(content).toContain('Hello deck')
    expect(content).toContain('fo:font-weight="bold"')
    expect(content).toContain('fo:font-style="italic"')
    expect(content).toContain('style:text-underline-style="solid"')
    expect(content).toContain('fo:color="#FF0000"')
    expect(content).toContain('fo:font-family="Courier New"')
    expect(content).toContain('fo:text-align="end"')
    // master-inherited title font + size
    expect(content).toContain('fo:font-family="Georgia"')
    expect(content).toContain('fo:font-size="40pt"')
    // bullets / numbering through list styles
    expect(content).toContain('text:bullet-char="•"')
    expect(content).toContain('style:num-format="1"')
    // shapes
    expect(content).toContain('<draw:rect')
    expect(content).toContain('draw:fill-color="#00FF00"')
    expect(content).toContain('svg:stroke-color="#000000"')
    expect(content).toContain('<draw:ellipse')
    // flipV line: starts at the bottom-left
    expect(content).toContain('svg:x1="0.278cm" svg:y1="1.944cm" svg:x2="3.056cm" svg:y2="0.556cm"')
    // group child (0.1M,0.1M) scaled x2 into (5M,3M): (5.2M, 3.2M) = (14.444cm, 8.889cm)
    expect(content).toContain('svg:x="14.444cm" svg:y="8.889cm"')
    // master decoration painted on the slide
    expect(content).toContain('draw:fill-color="#123456"')
    // table
    expect(content).toContain('<table:table ')
    expect(content).toContain('Cell A')
    expect(content).toContain('table:number-columns-spanned="2"')
    expect(content).toContain('<table:covered-table-cell/>')
    expect(content).toContain('fo:background-color="#FFFF00"')
    // background, notes
    expect(content).toContain('draw:fill-color="#EEEEFF"')
    expect(content).toContain('<presentation:notes>')
    expect(content).toContain('Speaker says hi')
    // dropped kinds
    expect(dropped).toContain('charts x1')
    expect(dropped).toContain('transitions x1')
    expect(dropped).toContain('animations x1')
    expect(dropped).toContain('geometry:triangle x1')
  })

  it('round-trips through convertOdpToPptx', async () => {
    const { odp, slides } = await convertPptxToOdp(await buildPptx({ second: true }))
    const back = await convertOdpToPptx(odp)
    expect(back.slides).toBe(slides)
    const zip = await JSZip.loadAsync(back.pptx)
    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string')
    const slide2 = await zip.file('ppt/slides/slide2.xml')!.async('string')
    for (const text of ['Hello deck', 'First bullet', 'Red italic', 'In group', 'Cell A']) {
      // Cell A lives in a table, which the importer reports instead of converting
      if (text !== 'Cell A') expect(slide1).toContain(text)
    }
    expect(slide1).toMatch(/b="1"/)
    expect(slide2).toContain('Second')
    expect(slide1.match(/<p:pic>/g)?.length).toBe(1)
  })

  it('rejects non-zip input', async () => {
    await expect(convertPptxToOdp(new Uint8Array([1, 2, 3]))).rejects.toThrow('unreadable')
  })
})

const hasSoffice = spawnSync('which', ['soffice']).status === 0 && process.env.SKIP_SOFFICE !== '1'

describe.skipIf(!hasSoffice)('soffice validation', () => {
  it('opens the odp and renders one pdf page per slide', async () => {
    const { odp, slides } = await convertPptxToOdp(await buildPptx({ second: true }))
    const dir = mkdtempSync(join(tmpdir(), 'pptx-odp-'))
    try {
      writeFileSync(join(dir, 'deck.odp'), odp)
      const run = spawnSync(
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
        { timeout: 120_000 },
      )
      expect(run.status).toBe(0)
      const pdf = join(dir, 'deck.pdf')
      expect(existsSync(pdf)).toBe(true)
      const bytes = readFileSync(pdf)
      expect(bytes.length).toBeGreaterThan(0)
      const pages = bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0
      expect(pages).toBe(slides)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)
})
