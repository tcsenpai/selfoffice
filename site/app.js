/* global document */
// Download section: built from the latest GitHub release at load time, so a new
// tag shows up here without touching the site. Without the API (offline, rate
// limit) the static buttons keep pointing at the releases page.
const REPO = 'tcsenpai/selfoffice'
const OS_OF = (name) => {
  if (
    /\.(dmg|zip)$/.test(name) &&
    /mac|arm64|x64|universal/i.test(name) &&
    !/win|linux/i.test(name)
  )
    return 'mac'
  if (/\.exe$/.test(name)) return 'win'
  if (/\.(AppImage|deb|rpm)$/.test(name)) return 'linux'
  return null
}
const NAMES = { mac: 'macOS', win: 'Windows', linux: 'Linux' }
const MAIN = { mac: /\.dmg$/, win: /\.exe$/, linux: /\.AppImage$/ }

function detectOs() {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'win'
  if (/Mac/i.test(ua)) return 'mac'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}

function size(bytes) {
  return bytes >= 1e8 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e6).toFixed(1)} MB`
}

function arch(name) {
  if (/arm64|aarch64/i.test(name)) return 'arm64'
  if (/x64|x86_64|amd64/i.test(name)) return 'x64'
  return ''
}

// one API call per ten minutes per browser: the anonymous limit is 60 an hour per IP
async function latestRelease() {
  try {
    const hit = JSON.parse(sessionStorage.getItem('so-release') || 'null')
    if (hit && Date.now() - hit.at < 600_000) return hit.rel
  } catch {
    /* storage unavailable */
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  if (!res.ok) throw new Error(String(res.status))
  const rel = await res.json()
  try {
    sessionStorage.setItem('so-release', JSON.stringify({ at: Date.now(), rel }))
  } catch {
    /* storage unavailable */
  }
  return rel
}

async function wireDownloads() {
  const me = detectOs()
  if (me) document.querySelector(`.dl-card[data-os="${me}"]`)?.classList.add('me')
  try {
    const rel = await latestRelease()
    const date = rel.published_at ? new Date(rel.published_at).toLocaleDateString() : ''
    const label = document.getElementById('dl-version')
    if (label) label.textContent = `Latest release: ${rel.tag_name}${date ? `, ${date}` : ''}`
    for (const os of Object.keys(NAMES)) {
      const card = document.querySelector(`.dl-card[data-os="${os}"]`)
      const assets = rel.assets
        .filter((a) => OS_OF(a.name) === os)
        .sort((a, b) => Number(MAIN[os].test(b.name)) - Number(MAIN[os].test(a.name)))
      if (!card || assets.length === 0) continue
      const list = card.querySelector('.files')
      list.replaceChildren(
        ...assets.map((a) => {
          const li = document.createElement('li')
          const link = document.createElement('a')
          link.href = a.browser_download_url
          const ext = a.name.slice(a.name.lastIndexOf('.'))
          link.textContent = [ext, arch(a.name)].filter(Boolean).join(' ')
          const small = document.createElement('small')
          small.textContent = size(a.size)
          link.append(small)
          li.append(link)
          return li
        }),
      )
      card.querySelector('.what').textContent =
        [...new Set(assets.map((a) => arch(a.name)).filter(Boolean))].join(', ') || NAMES[os]
      const main = assets.find((a) => MAIN[os].test(a.name)) ?? assets[0]
      card.querySelector('.dl-btn').href = main.browser_download_url
      if (os === me) {
        const hero = document.getElementById('dl-main')
        hero.href = main.browser_download_url
        hero.textContent = `Download for ${NAMES[os]}`
      }
    }
  } catch {
    /* keep the static links */
  }
}

wireDownloads()
