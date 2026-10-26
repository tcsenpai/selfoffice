/**
 * Seams the shell fills in so the editors can open OpenDocument files for real:
 * a preparer turns an .odt/.ods/.odp path into the OOXML working copy the
 * editor opens (saves are patched back into the ODF), and an aliaser maps a
 * working copy to the file the user thinks they are editing, for display.
 * Standalone editors set neither and keep their import dialogs.
 */

export type OdfPreparer = (odfPath: string) => Promise<string | null>

let preparer: OdfPreparer | null = null
let aliaser: ((path: string) => string) | null = null

export function setOdfPreparer(fn: OdfPreparer | null): void {
  preparer = fn
}

export function getOdfPreparer(): OdfPreparer | null {
  return preparer
}

export function setPathAliaser(fn: ((path: string) => string) | null): void {
  aliaser = fn
}

/** the user-facing path for a working copy (identity for every other file) */
export function aliasPath(path: string): string {
  return aliaser ? aliaser(path) : path
}
