import { readFileSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.0.0' } }))

import { isEphemeralInstall, launcherFilePath, writeLauncherFile } from '../src/main/cli-link'

describe('selfoffice launcher file', () => {
  it('lives in the selfoffice auth directory, overridable like auth.json', () => {
    expect(launcherFilePath({})).toBe(join(process.env.HOME ?? '', '.selfoffice', 'launcher'))
    expect(launcherFilePath({ SELFOFFICE_AUTH_DIR: '/tmp/x' })).toBe(join('/tmp/x', 'launcher'))
  })

  it('writes one line, creates the directory, and only rewrites on change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selfoffice-launcher-'))
    const file = join(dir, 'nested', 'launcher')
    expect(writeLauncherFile(file, '/Applications/SelfOffice.app/Contents/Resources/cli')).toBe(
      true,
    )
    expect(readFileSync(file, 'utf-8')).toBe(
      '/Applications/SelfOffice.app/Contents/Resources/cli\n',
    )
    const before = statSync(file).mtimeMs
    expect(writeLauncherFile(file, '/Applications/SelfOffice.app/Contents/Resources/cli')).toBe(
      false,
    )
    expect(statSync(file).mtimeMs).toBe(before)
    expect(writeLauncherFile(file, 'C:\\Programs\\SelfOffice\\resources\\selfoffice')).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe('C:\\Programs\\SelfOffice\\resources\\selfoffice\n')
  })

  it('treats dmg and AppImage mounts as temporary', () => {
    expect(isEphemeralInstall('/Volumes/SelfOffice/SelfOffice.app/Contents/Resources', {})).toBe(
      true,
    )
    expect(isEphemeralInstall('/tmp/.mount_GenOfxyz/resources', {})).toBe(true)
    expect(
      isEphemeralInstall('/opt/SelfOffice/resources', { APPIMAGE: '/home/u/G.AppImage' }),
    ).toBe(true)
    expect(isEphemeralInstall('/Applications/SelfOffice.app/Contents/Resources', {})).toBe(false)
  })
})
