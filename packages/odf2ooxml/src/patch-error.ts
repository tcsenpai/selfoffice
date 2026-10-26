/** a diff-based ODF patch refused to write; the caller falls back to a full export */
export class OdfPatchError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'OdfPatchError'
  }
}
