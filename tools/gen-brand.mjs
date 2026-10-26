// Regenerates the SelfOffice brand SVGs (icon + outlined wordmark) and the raster
// icons derived from the icon. Run: node tools/gen-brand.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import opentype from 'opentype.js'

const font = opentype.parse(
  readFileSync('apps/docs/src/renderer/fonts/LiberationSans-Bold.ttf').buffer.slice(0),
)

// 240x240 app icon: gradient tile, folded-corner page, text lines, AI sparkle
const ICON_BODY = `<defs>
  <linearGradient id="g" x1="0" y1="0" x2="240" y2="240" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#4338CA"/><stop offset="1" stop-color="#0891B2"/>
  </linearGradient>
</defs>
<rect width="240" height="240" rx="54" fill="url(#g)"/>
<path d="M66 44h66l42 42v100a14 14 0 0 1-14 14H66a14 14 0 0 1-14-14V58a14 14 0 0 1 14-14Z" fill="#fff"/>
<path d="M132 44v28a14 14 0 0 0 14 14h28Z" fill="#C7D2FE"/>
<rect x="72" y="108" width="76" height="9" rx="4.5" fill="#4338CA" opacity=".85"/>
<rect x="72" y="130" width="96" height="9" rx="4.5" fill="#4338CA" opacity=".55"/>
<rect x="72" y="152" width="54" height="9" rx="4.5" fill="#4338CA" opacity=".35"/>
<path d="M170 148l6.5 17.5L194 172l-17.5 6.5L170 196l-6.5-17.5L146 172l17.5-6.5Z" fill="#06B6D4" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>`
const icon = `<svg width="240" height="240" viewBox="0 0 240 240" fill="none" xmlns="http://www.w3.org/2000/svg">\n${ICON_BODY}\n</svg>\n`
writeFileSync('docs/assets/selfoffice-icon.svg', icon)

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
