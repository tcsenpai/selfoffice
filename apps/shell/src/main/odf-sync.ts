/**
 * Real OpenDocument support: an .odt/.ods/.odp opens as an OOXML working copy
 * (docx/xlsx/pptx) that the editors already know how to edit, and every save of
 * that copy is patched back into the ORIGINAL ODF file — only what the user
 * touched is rewritten, the rest of the package stays byte-identical (comments,
 * tracked changes, charts, animations, styles ...). When a patch is impossible
 * the original is backed up and a full export is written instead, never a
 * corrupt file.
 *
 * Layout per document: <workRoot>/<sha1(odfPath)[0:12]>/
 *   <stem>.docx|xlsx|pptx   working copy the editor opens and saves
 *   baseline.docx|xlsx|pptx fresh import of the ODF as last written by us
 *   meta.json               { odfPath, odfSha, kind }
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import {
  convertDocxToOdt,
  convertOdpToPptx,
  convertOdtToDocx,
  convertPptxToOdp,
  convertXlsxToOds,
  patchOdp,
  patchOds,
  patchOdt,
} from '@selfoffice/odf2ooxml'
import { atomicWriteFile } from './atomic-write'

export type OdfKind = 'odt' | 'ods' | 'odp'

const KIND_BY_EXT: Record<string, OdfKind> = {
  '.odt': 'odt',
  '.ott': 'odt',
  '.ods': 'ods',
  '.ots': 'ods',
  '.odp': 'odp',
  '.otp': 'odp',
}
const OOXML_EXT: Record<OdfKind, string> = { odt: '.docx', ods: '.xlsx', odp: '.pptx' }

export function odfKindOf(path: string): OdfKind | null {
  return KIND_BY_EXT[extname(path).toLowerCase()] ?? null
}

export interface OdfSyncDeps {
  /** where working copies live (userData/odf-work) */
  workRoot: string
  /** ODS -> XLSX through the Rust sidecar (the import is not available in TS) */
  importOds(odsPath: string, xlsxPath: string): Promise<void>
  /** a save could not be patched; the original was backed up and a full export written */
  onFallback?(info: { odfPath: string; reason: string; backup: string }): void
  /** the ODF changed on disk behind our back; the save was NOT written */
  onConflict?(info: { odfPath: string; workPath: string }): void
  log?(message: string): void
}

interface Binding {
  workPath: string
  odfPath: string
  kind: OdfKind
  dir: string
  baselinePath: string
  odfSha: string
  /** mtime+size of the working copy when it was last synced */
  sig: string
  blocked: boolean
  chain: Promise<void>
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function signature(path: string): Promise<string> {
  const s = await stat(path)
  return `${s.mtimeMs}:${s.size}`
}

export class OdfSync {
  private readonly bindings = new Map<string, Binding>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: OdfSyncDeps) {}

  /** Convert (or reuse) the working copy for an ODF file and start syncing it; returns the copy's path. */
  async prepare(odfPath: string): Promise<string> {
    const kind = odfKindOf(odfPath)
    if (!kind) throw new Error(`not an OpenDocument file: ${odfPath}`)
    const dir = join(
      this.deps.workRoot,
      createHash('sha1').update(odfPath).digest('hex').slice(0, 12),
    )
    await mkdir(dir, { recursive: true })
    const ext = OOXML_EXT[kind]
    const stem = basename(odfPath, extname(odfPath))
    const workPath = join(dir, `${stem}${ext}`)
    const baselinePath = join(dir, `baseline${ext}`)
    const metaPath = join(dir, 'meta.json')

    const original = new Uint8Array(await readFile(odfPath))
    const odfSha = sha(original)
    const existing = this.bindings.get(workPath)
    if (existing) return workPath

    let reuse: boolean
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { odfSha?: string }
      reuse =
        meta.odfSha === odfSha &&
        (await stat(workPath).then(
          () => true,
          () => false,
        )) &&
        (await stat(baselinePath).then(
          () => true,
          () => false,
        ))
    } catch {
      reuse = false
    }
    if (!reuse) {
      // keep unsaved leftovers of a previous session instead of overwriting them
      if (
        await stat(workPath).then(
          () => true,
          () => false,
        )
      ) {
        await rename(workPath, join(dir, `${stem}.previous-${Date.now()}${ext}`)).catch(() => {})
      }
      await this.importTo(kind, odfPath, original, baselinePath)
      await copyFile(baselinePath, workPath)
      await writeFile(metaPath, JSON.stringify({ odfPath, odfSha, kind }))
    }
    this.bindings.set(workPath, {
      workPath,
      odfPath,
      kind,
      dir,
      baselinePath,
      odfSha,
      sig: await signature(workPath),
      blocked: false,
      chain: Promise.resolve(),
    })
    return workPath
  }

  /** the ODF file behind a working copy, or the path itself when it is not one */
  displayPath(path: string): string {
    return this.bindings.get(path)?.odfPath ?? path
  }

  isBound(path: string): boolean {
    return this.bindings.has(path)
  }

  start(intervalMs = 1500): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Sync one working copy now (tab close), or every changed one (quit, timer). */
  async flush(workPath?: string): Promise<void> {
    const targets = workPath ? [this.bindings.get(workPath)] : [...this.bindings.values()]
    await Promise.all(targets.map((b) => (b ? this.enqueue(b) : undefined)))
  }

  private enqueue(binding: Binding): Promise<void> {
    binding.chain = binding.chain
      .then(() => this.syncOne(binding))
      .catch((error) => {
        this.deps.log?.(`odf-sync ${binding.odfPath}: ${String(error)}`)
      })
    return binding.chain
  }

  private async syncOne(b: Binding): Promise<void> {
    let sig: string
    try {
      sig = await signature(b.workPath)
    } catch {
      return
    }
    if (sig === b.sig) return
    // an editor that is mid-write leaves a moving mtime: wait for it to settle
    await new Promise((resolve) => setTimeout(resolve, 250))
    if ((await signature(b.workPath).catch(() => '')) !== sig) return
    const current = new Uint8Array(await readFile(b.workPath))
    const original = new Uint8Array(await readFile(b.odfPath))
    if (sha(original) !== b.odfSha) {
      b.blocked = true
      this.deps.onConflict?.({ odfPath: b.odfPath, workPath: b.workPath })
      b.sig = sig
      return
    }
    const baseline = new Uint8Array(await readFile(b.baselinePath))
    let written: Uint8Array
    try {
      written = await this.patch(b.kind, original, baseline, current)
    } catch (error) {
      const backup = join(b.dir, `backup-${Date.now()}${extname(b.odfPath)}`)
      await copyFile(b.odfPath, backup)
      written = await this.exportFull(b.kind, current)
      this.deps.onFallback?.({ odfPath: b.odfPath, reason: String(error), backup })
    }
    await atomicWriteFile(b.odfPath, written)
    b.odfSha = sha(written)
    await this.importTo(b.kind, b.odfPath, written, b.baselinePath)
    await writeFile(
      join(b.dir, 'meta.json'),
      JSON.stringify({ odfPath: b.odfPath, odfSha: b.odfSha, kind: b.kind }),
    )
    b.sig = await signature(b.workPath).catch(() => sig)
  }

  private async patch(
    kind: OdfKind,
    original: Uint8Array,
    baseline: Uint8Array,
    current: Uint8Array,
  ): Promise<Uint8Array> {
    if (kind === 'odt') return (await patchOdt(original, baseline, current)).odt
    if (kind === 'ods') return (await patchOds(original, baseline, current)).ods
    return (await patchOdp(original, baseline, current)).odp
  }

  private async exportFull(kind: OdfKind, current: Uint8Array): Promise<Uint8Array> {
    if (kind === 'odt') return (await convertDocxToOdt(current)).odt
    if (kind === 'ods') return (await convertXlsxToOds(current)).ods
    return (await convertPptxToOdp(current)).odp
  }

  private async importTo(
    kind: OdfKind,
    odfPath: string,
    bytes: Uint8Array,
    target: string,
  ): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    if (kind === 'odt') await writeFile(target, (await convertOdtToDocx(bytes)).docx)
    else if (kind === 'odp') await writeFile(target, (await convertOdpToPptx(bytes)).pptx)
    else await this.deps.importOds(odfPath, target)
  }
}
