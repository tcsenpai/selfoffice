export interface XlsxToOdsResult {
  ods: Uint8Array
  sheets: number
  cells: number
  dropped: string[]
}

export async function convertXlsxToOds(_xlsx: Uint8Array): Promise<XlsxToOdsResult> {
  throw new Error('not implemented')
}
