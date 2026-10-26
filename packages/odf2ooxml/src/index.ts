/**
 * @selfoffice/odf2ooxml — local ODF import filters: .odt → .docx and
 * .odp → .pptx. Pure-function package: bytes in, bytes out; nothing here
 * touches Electron or the filesystem. Both filters follow the .ods import
 * rule — a construct that cannot be converted provably-correct is counted in
 * `dropped` instead of approximated into wrong markup.
 */

export { convertOdtToDocx, OdfConvertError, type OdtToDocxResult } from './odt-docx'
export { convertOdpToPptx, type OdpToPptxResult } from './odp-pptx'
export { MAX_ODF_PART_BYTES } from './odf'
export { convertDocxToOdt, type DocxToOdtResult } from './docx-odt'
export { convertXlsxToOds, type XlsxToOdsResult } from './xlsx-ods'
export { convertPptxToOdp, type PptxToOdpResult } from './pptx-odp'
export { patchOdt, type OdtPatchResult, type OdtPatchErrorCode } from './odt-patch'
export { OdfPatchError } from './patch-error'
export { patchOds, type OdsPatchResult } from './ods-patch'
export { patchOdp, type OdpPatchResult } from './odp-patch'
