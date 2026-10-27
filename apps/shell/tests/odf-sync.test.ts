import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import { OdfSync, odfKindOf } from '../src/main/odf-sync'

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
  ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
  ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
  ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"' +
  ' xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"'

async function makeOdt(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' })
  zip.file(
    'META-INF/manifest.xml',
    '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
      '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
      '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
  )
  zip.file(
    'content.xml',
    `<?xml version="1.0"?><office:document-content ${NS} office:version="1.3"><office:body><office:text>` +
      '<text:p>first paragraph</text:p>' +
      '<text:p>second<office:annotation><dc:creator>Ann</dc:creator><text:p>keep this comment</text:p></office:annotation> paragraph</text:p>' +
      '</office:text></office:body></office:document-content>',
  )
  await writeFile(path, await zip.generateAsync({ type: 'uint8array' }))
}

describe('OdfSync', () => {
  it('maps extensions to kinds', () => {
    expect(odfKindOf('/a/b.ODT')).toBe('odt')
    expect(odfKindOf('/a/b.ots')).toBe('ods')
    expect(odfKindOf('/a/b.docx')).toBeNull()
  })

  it('patches an edit back into the original odt and keeps what the editor does not model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'selfoffice-odf-sync-'))
    const odf = join(dir, 'note.odt')
    await makeOdt(odf)
    const sync = new OdfSync({
      workRoot: join(dir, 'work'),
      importOds: async () => {
        throw new Error('unused')
      },
    })
    const work = await sync.prepare(odf)
    expect(work.endsWith('.docx')).toBe(true)
    expect(sync.displayPath(work)).toBe(odf)

    // the editor saves the working copy with the first paragraph changed
    const docx = await JSZip.loadAsync(await readFile(work))
    const xml = (await docx.file('word/document.xml')!.async('string')).replace(
      'first paragraph',
      'edited paragraph',
    )
    docx.file('word/document.xml', xml)
    await writeFile(work, await docx.generateAsync({ type: 'uint8array' }))

    await sync.flush()
    const out = await JSZip.loadAsync(await readFile(odf))
    const content = await out.file('content.xml')!.async('string')
    expect(content).toContain('edited paragraph')
    expect(content).not.toContain('first paragraph')
    expect(content).toContain('<text:p>keep this comment</text:p>')
    expect(await out.file('mimetype')!.async('string')).toBe(
      'application/vnd.oasis.opendocument.text',
    )
  })

  it('does not overwrite an odt that changed on disk behind its back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'selfoffice-odf-sync-'))
    const odf = join(dir, 'note.odt')
    await makeOdt(odf)
    const conflicts: string[] = []
    const sync = new OdfSync({
      workRoot: join(dir, 'work'),
      importOds: async () => undefined,
      onConflict: (info) => conflicts.push(info.odfPath),
    })
    const work = await sync.prepare(odf)
    await writeFile(odf, 'changed by another program')
    const docx = await JSZip.loadAsync(await readFile(work))
    docx.file(
      'word/document.xml',
      (await docx.file('word/document.xml')!.async('string')).replace('first', 'FIRST'),
    )
    await writeFile(work, await docx.generateAsync({ type: 'uint8array' }))
    await sync.flush()
    expect(conflicts).toEqual([odf])
    expect(await readFile(odf, 'utf8')).toBe('changed by another program')
  })

  async function editWork(work: string, from: string, to: string): Promise<void> {
    const docx = await JSZip.loadAsync(await readFile(work))
    docx.file(
      'word/document.xml',
      (await docx.file('word/document.xml')!.async('string')).replace(from, to),
    )
    await writeFile(work, await docx.generateAsync({ type: 'uint8array' }))
  }

  it('after a failed re-import the next save is rewritten from the editor copy, never re-patched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'selfoffice-odf-sync-'))
    const odf = join(dir, 'note.odt')
    await makeOdt(odf)
    const fallbacks: string[] = []
    const logs: string[] = []
    const sync = new OdfSync({
      workRoot: join(dir, 'work'),
      importOds: async () => undefined,
      onFallback: ({ reason }) => fallbacks.push(reason),
      log: (m) => logs.push(m),
    })
    const work = await sync.prepare(odf)
    const importTo = vi
      .spyOn(sync as unknown as { importTo: () => Promise<void> }, 'importTo')
      .mockRejectedValueOnce(new Error('sidecar down'))

    await editWork(work, 'first paragraph', 'edited once')
    await sync.flush()
    expect(
      await (await JSZip.loadAsync(await readFile(odf))).file('content.xml')!.async('string'),
    ).toContain('edited once')
    expect(logs.join()).toContain('re-import failed')
    // the failed save is not processed again on the next tick
    const calls = importTo.mock.calls.length
    await sync.flush()
    expect(importTo.mock.calls.length).toBe(calls)

    importTo.mockRestore()
    await editWork(work, 'edited once', 'edited twice')
    await sync.flush()
    const content = await (
      await JSZip.loadAsync(await readFile(odf))
    )
      .file('content.xml')!
      .async('string')
    expect(content).toContain('edited twice')
    expect(content.match(/edited/g)).toHaveLength(1)
    expect(fallbacks.join()).toContain('out of date')
  })

  it('prune drops old unused work dirs and keeps recent ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'selfoffice-odf-sync-'))
    const root = join(dir, 'work')
    const old = join(root, 'old')
    const fresh = join(root, 'fresh')
    for (const d of [old, fresh]) {
      await mkdir(d, { recursive: true })
      await writeFile(join(d, 'meta.json'), '{}')
    }
    const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000)
    await utimes(join(old, 'meta.json'), longAgo, longAgo)
    const sync = new OdfSync({ workRoot: root, importOds: async () => undefined })
    await sync.prune()
    await expect(stat(old)).rejects.toThrow()
    await expect(stat(fresh)).resolves.toBeTruthy()
  })

  it('warns when an open odt is opened again after it changed on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'selfoffice-odf-sync-'))
    const odf = join(dir, 'note.odt')
    await makeOdt(odf)
    const stale: string[] = []
    const sync = new OdfSync({
      workRoot: join(dir, 'work'),
      importOds: async () => undefined,
      onStaleOpen: ({ odfPath }) => stale.push(odfPath),
    })
    const work = await sync.prepare(odf)
    expect(await sync.prepare(odf)).toBe(work)
    expect(stale).toEqual([])
    await writeFile(odf, Buffer.concat([await readFile(odf), Buffer.from(' ')]))
    expect(await sync.prepare(odf)).toBe(work)
    expect(stale).toEqual([odf])
  })
})
