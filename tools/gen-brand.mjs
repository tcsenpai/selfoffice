// Regenerates the SelfOffice brand SVGs (icon + outlined wordmark) and the raster
// icons derived from the icon. Run: node tools/gen-brand.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import opentype from 'opentype.js'

const font = opentype.parse(
  readFileSync('apps/docs/src/renderer/fonts/LiberationSans-Bold.ttf').buffer.slice(0),
)

// 240x240 app icon: indigo-to-cyan tile with a soft sheen, a lifted page with a folded
// corner, a heading bar and text lines, and the AI sparkle with a glow
const ICON_BODY = `<defs>
  <linearGradient id="bg" x1="24" y1="0" x2="216" y2="240" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#3B34C8"/><stop offset=".5" stop-color="#5B6CF2"/><stop offset="1" stop-color="#12B8D8"/>
  </linearGradient>
  <radialGradient id="sheen" cx="72" cy="36" r="190" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="page" x1="0" y1="40" x2="0" y2="198" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#E7EBFF"/>
  </linearGradient>
  <linearGradient id="fold" x1="128" y1="40" x2="172" y2="84" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#E0E7FF"/><stop offset="1" stop-color="#A5B4FC"/>
  </linearGradient>
  <linearGradient id="ink" x1="70" y1="0" x2="170" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#4338CA"/><stop offset="1" stop-color="#7C3AED"/>
  </linearGradient>
  <linearGradient id="spark" x1="150" y1="140" x2="206" y2="198" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#67E8F9"/><stop offset="1" stop-color="#22D3EE"/>
  </linearGradient>
  <filter id="lift" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="9" stdDeviation="8" flood-color="#0B0F4A" flood-opacity=".42"/></filter>
  <filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="9"/></filter>
</defs>
<rect width="240" height="240" rx="56" fill="url(#bg)"/>
<rect width="240" height="240" rx="56" fill="url(#sheen)"/>
<path d="M64 40h68l42 42v102a14 14 0 0 1-14 14H64a14 14 0 0 1-14-14V54a14 14 0 0 1 14-14Z" fill="url(#page)" filter="url(#lift)"/>
<path d="M132 40v28a14 14 0 0 0 14 14h28Z" fill="url(#fold)"/>
<rect x="68" y="98" width="62" height="12" rx="6" fill="url(#ink)"/>
<rect x="68" y="122" width="92" height="8" rx="4" fill="#4338CA" opacity=".4"/>
<rect x="68" y="140" width="76" height="8" rx="4" fill="#4338CA" opacity=".4"/>
<rect x="68" y="158" width="48" height="8" rx="4" fill="#4338CA" opacity=".4"/>
<path d="M176 138l8.5 23.5L208 170l-23.5 8.5L176 202l-8.5-23.5L144 170l23.5-8.5Z" fill="#22D3EE" opacity=".75" filter="url(#glow)"/>
<path d="M176 138l8.5 23.5L208 170l-23.5 8.5L176 202l-8.5-23.5L144 170l23.5-8.5Z" fill="url(#spark)" stroke="#fff" stroke-width="5.5" stroke-linejoin="round"/>
<path d="M204 112l3.2 8.8 8.8 3.2-8.8 3.2-3.2 8.8-3.2-8.8-8.8-3.2 8.8-3.2Z" fill="#fff" opacity=".95"/>`
const icon = `<svg width="240" height="240" viewBox="0 0 240 240" fill="none" xmlns="http://www.w3.org/2000/svg">\n${ICON_BODY}\n</svg>\n`
writeFileSync('docs/assets/selfoffice-icon.svg', icon)
writeFileSync('site/assets/icon.svg', icon)

// wordmark: outline "SelfOffice" at cap height ~ 126 (matches the old 62..188 band)
const size = 170
const path = font.getPath('SelfOffice', 324, 188, size)
const bb = path.getBoundingBox()
const w = Math.ceil(bb.x2 + 8)
const logo = `<svg width="${w}" height="240" viewBox="0 0 ${w} 240" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="${path.toPathData(2)}" fill="black"/>
<g>\n${ICON_BODY}\n</g>
</svg>\n`
writeFileSync('apps/shell/src/renderer/src/assets/selfoffice-logo.svg', logo)
console.log('ok', w)

// raster icons (macOS + a host with rsvg-convert, iconutil and ImageMagick)
import { execFileSync } from 'node:child_process'
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
if (have('rsvg-convert') && have('magick') && have('iconutil')) {
  const tmp = mkdtempSync(join(tmpdir(), 'so-icons-'))
  const svg = 'docs/assets/selfoffice-icon.svg'
  const png = (size, out) =>
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', out])
  const full = join(tmp, 'full.png')
  png(1024, full)
  // macOS style: art at 824 inside a 1024 canvas
  const art = join(tmp, 'art.png')
  png(824, art)
  const mac = join(tmp, 'mac.png')
  execFileSync('magick', [
    '-size',
    '1024x1024',
    'xc:none',
    art,
    '-gravity',
    'center',
    '-composite',
    mac,
  ])

  for (const dir of ['apps/shell/build', 'apps/docs/build']) {
    copyFileSync(full, `${dir}/icon.png`)
    copyFileSync(mac, `${dir}/icon-mac.png`)
  }
  for (const dir of ['shell', 'docs', 'sheets', 'slides'])
    copyFileSync(
      full,
      `apps/${dir}/src/renderer${dir === 'shell' ? '/src' : ''}/assets/app-icon.png`,
    )

  mkdirSync('apps/shell/build/icons', { recursive: true })
  for (const n of [16, 32, 48, 64, 128, 256, 512, 1024])
    png(n, `apps/shell/build/icons/${n}x${n}.png`)

  const ico = ['16', '32', '48', '64', '128', '256'].map(
    (n) => `apps/shell/build/icons/${n}x${n}.png`,
  )
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
  console.log('skipped rasters (needs rsvg-convert, magick, iconutil)')
}
