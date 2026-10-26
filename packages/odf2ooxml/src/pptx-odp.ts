export interface PptxToOdpResult {
  odp: Uint8Array
  slides: number
  dropped: string[]
}

export async function convertPptxToOdp(_pptx: Uint8Array): Promise<PptxToOdpResult> {
  throw new Error('not implemented')
}
