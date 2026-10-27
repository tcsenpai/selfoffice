// Regenerates the SelfOffice brand SVGs (icon + outlined wordmark) and the raster
// icons derived from the icon. Run: node tools/gen-brand.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import opentype from 'opentype.js'
import { execFileSync } from 'node:child_process'

const font = opentype.parse(
  readFileSync('apps/docs/src/renderer/fonts/LiberationSans-Bold.ttf').buffer.slice(0),
)

// The mark is branding/mark.png (cut from branding/source-lumo.png by tools/cut-brand-art.py).
// The SVGs embed a 256px copy so they stay single files; rasters come from the full-size PNG.
const mark256 = execFileSync('magick', ['branding/mark.png', '-resize', '256x256', 'png:-'], {
  maxBuffer: 16 * 1024 * 1024,
})
const ICON_BODY = `<image xlink:href="data:image/png;base64,${mark256.toString('base64')}" width="240" height="240"/>`
const icon = `<svg width="240" height="240" viewBox="0 0 240 240" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">\n${ICON_BODY}\n</svg>\n`
writeFileSync('docs/assets/selfoffice-icon.svg', icon)
writeFileSync('site/assets/icon.svg', icon)

// wordmark: outline "SelfOffice" at cap height ~ 126 (matches the old 62..188 band)
const size = 170
const path = font.getPath('SelfOffice', 324, 188, size)
const bb = path.getBoundingBox()
const w = Math.ceil(bb.x2 + 8)
const logo = `<svg width="${w}" height="240" viewBox="0 0 ${w} 240" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<path d="${path.toPathData(2)}" fill="black"/>
<g>\n${ICON_BODY}\n</g>
</svg>\n`
writeFileSync('apps/shell/src/renderer/src/assets/selfoffice-logo.svg', logo)
console.log('ok', w)

// raster icons (macOS host with ImageMagick and iconutil)
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const have = (cmd) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
if (have('magick') && have('iconutil')) {
  const tmp = mkdtempSync(join(tmpdir(), 'so-icons-'))
  const fit = (size, out, inner = size) =>
    execFileSync('magick', [
      'branding/mark.png',
      '-resize',
      `${inner}x${inner}`,
      '-background',
      'none',
      '-gravity',
      'center',
      '-extent',
      `${size}x${size}`,
      out,
    ])
  const full = join(tmp, 'full.png')
  fit(1024, full, 968)
  // macOS style: art at 824 inside a 1024 canvas
  const mac = join(tmp, 'mac.png')
  fit(1024, mac, 824)

  for (const dir of ['apps/shell/build', 'apps/docs/build']) {
    copyFileSync(full, `${dir}/icon.png`)
    copyFileSync(mac, `${dir}/icon-mac.png`)
  }
  for (const app of ['shell', 'docs', 'sheets', 'slides'])
    copyFileSync(
      full,
      `apps/${app}/src/renderer${app === 'shell' ? '/src' : ''}/assets/app-icon.png`,
    )

  mkdirSync('apps/shell/build/icons', { recursive: true })
  for (const n of [16, 32, 48, 64, 128, 256, 512, 1024])
    execFileSync('magick', [full, '-resize', `${n}x${n}`, `apps/shell/build/icons/${n}x${n}.png`])

  const ico = [16, 32, 48, 64, 128, 256].map((n) => `apps/shell/build/icons/${n}x${n}.png`)
  for (const dir of ['apps/shell/build', 'apps/docs/build'])
    execFileSync('magick', [...ico, `${dir}/icon.ico`])

  const set = join(tmp, 'icon.iconset')
  mkdirSync(set)
  for (const n of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [
      [1, ''],
      [2, '@2x'],
    ]) {
      const px = n * scale
      execFileSync('magick', [
        mac,
        '-resize',
        `${px}x${px}`,
        join(set, `icon_${n}x${n}${suffix}.png`),
      ])
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(tmp, 'icon.icns')])
  for (const dir of ['apps/shell/build', 'apps/docs/build'])
    copyFileSync(join(tmp, 'icon.icns'), `${dir}/icon.icns`)
  rmSync(tmp, { recursive: true, force: true })
  console.log('rasters ok')
} else {
  console.log('skipped rasters (needs magick and iconutil)')
}
