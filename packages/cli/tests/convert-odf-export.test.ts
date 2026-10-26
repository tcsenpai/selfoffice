import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function entry(path: string, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  return (await zip.file(name)?.async('string')) ?? ''
}

describe('selfoffice convert ODF export filters', () => {
  it('converts .docx to .odt and back with the text intact', async () => {
    const dir = tempDir()
    const md = join(dir, 'note.md')
    await writeFile(md, '# Exported heading\n\nplain **bold** text\n\n- one\n- two\n')
    const docx = join(dir, 'note.docx')
    expect((await run(['convert', md, '--to', 'docx', '--out', docx, '--json'])).code).toBe(0)

    const odt = join(dir, 'note.odt')
    const r = await run(['convert', docx, '--to', 'odt', '--out', odt, '--json'])
    expect(r.code).toBe(0)
    expect(existsSync(odt)).toBe(true)
    const zip = await JSZip.loadAsync(await readFile(odt))
    expect(await zip.file('mimetype')!.async('string')).toBe(
      'application/vnd.oasis.opendocument.text',
    )
    const content = await entry(odt, 'content.xml')
    expect(content).toContain('Exported heading')

    const back = join(dir, 'back.docx')
    expect((await run(['convert', odt, '--to', 'docx', '--out', back, '--json'])).code).toBe(0)
    expect(await entry(back, 'word/document.xml')).toContain('Exported heading')
  })

  it('converts .xlsx to .ods', async () => {
    const dir = tempDir()
    const csv = join(dir, 'data.csv')
    await writeFile(csv, 'name,qty\napple,3\npear,5\n')
    const xlsx = join(dir, 'data.xlsx')
    expect((await run(['convert', csv, '--to', 'xlsx', '--out', xlsx, '--json'])).code).toBe(0)

    const ods = join(dir, 'data.ods')
    const r = await run(['convert', xlsx, '--to', 'ods', '--out', ods, '--json'])
    expect(r.code).toBe(0)
    const content = await entry(ods, 'content.xml')
    expect(content).toContain('apple')
    expect(content).toContain('office:value="5"')
    expect(r.json().detail.sheets).toBe(1)
  })
})
