/* global document */
// Download buttons: point each card at the real asset of the latest release.
// Without the API (offline, rate limit) the links keep falling back to the releases page.
const REPO = 'tcsenpai/selfoffice'
const PICK = {
  mac: (n) => n.endsWith('.dmg'),
  win: (n) => n.endsWith('.exe'),
  linux: (n) => n.endsWith('.AppImage'),
}

function detectOs() {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'win'
  if (/Mac/i.test(ua)) return 'mac'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}

async function wireDownloads() {
  const me = detectOs()
  if (me) document.querySelector(`.dl-card[data-os="${me}"]`)?.classList.add('me')
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!res.ok) return
    const rel = await res.json()
    const label = document.getElementById('dl-version')
    if (label) label.textContent = `Latest release: ${rel.tag_name}`
    for (const [os, test] of Object.entries(PICK)) {
      const asset = rel.assets.find((a) => test(a.name))
      if (!asset) continue
      const card = document.querySelector(`.dl-card[data-os="${os}"]`)
      if (card) card.href = asset.browser_download_url
      if (os === me) {
        const main = document.getElementById('dl-main')
        const names = { mac: 'macOS', win: 'Windows', linux: 'Linux' }
        main.href = asset.browser_download_url
        main.textContent = `Download for ${names[os]}`
      }
    }
  } catch {
    /* keep the fallback links */
  }
}

wireDownloads()
