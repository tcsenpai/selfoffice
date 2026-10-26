export interface DocxToOdtResult {
  odt: Uint8Array
  blocks: number
  /** human-readable list of features that had no ODF form and were dropped */
  dropped: string[]
}

export async function convertDocxToOdt(_docx: Uint8Array): Promise<DocxToOdtResult> {
  throw new Error('not implemented')
}
