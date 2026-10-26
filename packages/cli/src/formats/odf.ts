import {
  convertDocxToOdt,
  convertOdpToPptx,
  convertOdtToDocx,
  convertPptxToOdp,
  convertXlsxToOds,
} from '@selfoffice/odf2ooxml'

/** .odt → .docx through the local import filter (same engine as the app's open route). */
export async function convertOdt(input: Uint8Array): Promise<{
  bytes: Uint8Array
  detail: Record<string, unknown>
}> {
  const result = await convertOdtToDocx(input)
  return {
    bytes: result.docx,
    detail: { blocks: result.blocks, dropped: result.dropped },
  }
}

/** .odp → .pptx through the local import filter. */
export async function convertOdp(input: Uint8Array): Promise<{
  bytes: Uint8Array
  detail: Record<string, unknown>
}> {
  const result = await convertOdpToPptx(input)
  return {
    bytes: result.pptx,
    detail: { slides: result.slides, dropped: result.dropped },
  }
}

/** .docx → .odt through the local export filter. */
export async function convertDocxToOdf(input: Uint8Array): Promise<{
  bytes: Uint8Array
  detail: Record<string, unknown>
}> {
  const result = await convertDocxToOdt(input)
  return { bytes: result.odt, detail: { blocks: result.blocks, dropped: result.dropped } }
}

/** .xlsx → .ods through the local export filter. */
export async function convertXlsxToOdf(input: Uint8Array): Promise<{
  bytes: Uint8Array
  detail: Record<string, unknown>
}> {
  const result = await convertXlsxToOds(input)
  return {
    bytes: result.ods,
    detail: { sheets: result.sheets, cells: result.cells, dropped: result.dropped },
  }
}

/** .pptx → .odp through the local export filter. */
export async function convertPptxToOdf(input: Uint8Array): Promise<{
  bytes: Uint8Array
  detail: Record<string, unknown>
}> {
  const result = await convertPptxToOdp(input)
  return { bytes: result.odp, detail: { slides: result.slides, dropped: result.dropped } }
}
