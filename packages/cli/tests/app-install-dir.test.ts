import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appBinaryForResources } from '../src/resources'

describe('appBinaryForResources', () => {
  it('finds the app in a custom Windows install directory', () => {
    expect(appBinaryForResources(join('D:\\Apps\\SelfOffice', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\SelfOffice', 'SelfOffice.exe'),
    )
  })

  it('resolves the same binary for the default Windows install directory', () => {
    const localAppData = 'C:\\Users\\test\\AppData\\Local'
    const resources = join(localAppData, 'Programs', 'SelfOffice', 'resources')
    expect(appBinaryForResources(resources, 'win32')).toBe(
      join(localAppData, 'Programs', 'SelfOffice', 'SelfOffice.exe'),
    )
  })

  it('finds the app in a custom macOS bundle location', () => {
    expect(
      appBinaryForResources(join('/Volumes/Work/SelfOffice.app/Contents/Resources'), 'darwin'),
    ).toBe(join('/Volumes/Work/SelfOffice.app/Contents/MacOS/SelfOffice'))
  })

  it('finds the app in a custom Linux prefix', () => {
    expect(appBinaryForResources(join('/opt/selfoffice-custom/resources'), 'linux')).toBe(
      join('/opt/selfoffice-custom/selfoffice'),
    )
  })
})
