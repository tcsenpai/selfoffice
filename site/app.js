/* global document, window, IntersectionObserver, requestAnimationFrame */
// SelfOffice site behaviour. Plain script, no dependencies. Every effect is optional:
// without it the page is complete, and prefers-reduced-motion switches the motion off.
const REPO = 'tcsenpai/selfoffice'
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** run `fn` while `el` is on screen (starts when it enters, stops when it leaves) */
function whileVisible(el, fn) {
  let stop = null
  new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !stop) stop = fn()
        else if (!e.isIntersecting && stop) {
          stop()
          stop = null
        }
      }
    },
    { threshold: 0.25 },
  ).observe(el)
}

/* theme: system by default, the button pins light or dark for this browser */
function initTheme() {
  const root = document.documentElement
  $('#theme').addEventListener('click', () => {
    const dark =
      root.dataset.theme === 'dark' ||
      (!root.dataset.theme && !window.matchMedia('(prefers-color-scheme: light)').matches)
    const next = dark ? 'light' : 'dark'
    root.dataset.theme = next
    try {
      localStorage.setItem('so-theme', next)
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
  })
}

/* nav: border after scroll, mobile menu, current section */
function initNav() {
  const nav = $('#nav')
  const menu = $('#menu')
  const burger = $('#burger')
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8)
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
  const setOpen = (open) => {
    menu.classList.toggle('open', open)
    burger.setAttribute('aria-expanded', String(open))
  }
  burger.addEventListener('click', () => setOpen(!menu.classList.contains('open')))
  for (const a of $$('a', menu)) a.addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false))

  const links = new Map($$('a', menu).map((a) => [a.getAttribute('href').slice(1), a]))
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        for (const [id, a] of links) a.classList.toggle('on', id === e.target.id)
      }
    },
    { rootMargin: '-45% 0px -50% 0px' },
  )
  for (const id of links.keys()) {
    const section = document.getElementById(id)
    if (section) spy.observe(section)
  }
}

/* hero: rotating tail of the headline */
function initRotator() {
  const el = $('#rot')
  const phrases = [
    'you run yourself.',
    'on your own model.',
    'that speaks OpenDocument.',
    'with no account, no cloud.',
    'built in the open.',
  ]
  if (reduce) return
  let i = 0
  setInterval(() => {
    el.classList.add('out')
    setTimeout(() => {
      i = (i + 1) % phrases.length
      el.textContent = phrases[i]
      el.classList.remove('out')
    }, 380)
  }, 3400)
}

/* hero screenshot leans toward the pointer */
function initTilt() {
  const stage = $('#stage')
  const card = $('#tilt')
  if (reduce || !window.matchMedia('(hover: hover)').matches) return
  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width - 0.5
    const y = (e.clientY - r.top) / r.height - 0.5
    card.style.setProperty('--ry', `${(x * 7).toFixed(2)}deg`)
    card.style.setProperty('--rx', `${(-y * 5).toFixed(2)}deg`)
  })
  stage.addEventListener('pointerleave', () => {
    card.style.setProperty('--ry', '0deg')
    card.style.setProperty('--rx', '0deg')
  })
}

/* model providers, two rows drifting in opposite directions (content doubled for a seamless loop) */
function initMarquee() {
  const names = [
    'Claude subscription',
    'Claude API',
    'OpenAI',
    'Codex CLI',
    'Gemini',
    'DeepSeek',
    'Kimi',
    'GLM',
    'Qwen',
    'Doubao',
    'MiniMax',
    'Grok',
    'Mistral',
    'OpenRouter',
    'Requesty',
    'Opper',
    'Atlas Cloud',
    'OpenCode Zen',
    'Ollama',
    'LM Studio',
    'vLLM',
    'Any OpenAI-compatible endpoint',
  ]
  const half = Math.ceil(names.length / 2)
  const rows = [
    ['#track-a', names.slice(0, half)],
    ['#track-b', names.slice(half)],
  ]
  for (const [sel, list] of rows) {
    const track = $(sel)
    const once = reduce ? list : [...list, ...list]
    track.replaceChildren(
      ...once.map((n, i) => {
        const chip = document.createElement('span')
        chip.className = 'chip'
        chip.textContent = n
        if (i >= list.length) chip.setAttribute('aria-hidden', 'true')
        return chip
      }),
    )
  }
}

/* numbers count up the first time they are seen */
function initCounters() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        io.unobserve(e.target)
        const end = Number(e.target.dataset.count)
        const suffix = e.target.dataset.suffix ?? ''
        if (reduce || end === 0) continue
        const t0 = performance.now()
        const tick = (now) => {
          const p = Math.min(1, (now - t0) / 1100)
          e.target.textContent = `${Math.round(end * (1 - (1 - p) ** 3))}${suffix}`
          if (p < 1) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }
    },
    { threshold: 0.6 },
  )
  for (const el of $$('[data-count]')) io.observe(el)
}

/* cards light up under the pointer */
function initSpotlight() {
  for (const el of $$('.spot')) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect()
      el.style.setProperty('--mx', `${e.clientX - r.left}px`)
      el.style.setProperty('--my', `${e.clientY - r.top}px`)
    })
  }
}

/* apps: tab list, arrow keys, gentle auto-advance until the visitor takes over */
function initTabs() {
  const tabs = $$('.tabs [role=tab]')
  const panels = $$('.showcase .panel')
  let current = 0
  let manual = false
  const show = (i, focus = false) => {
    current = (i + tabs.length) % tabs.length
    tabs.forEach((t, n) => {
      t.setAttribute('aria-selected', String(n === current))
      t.tabIndex = n === current ? 0 : -1
    })
    panels.forEach((p, n) => {
      p.hidden = n !== current
      p.classList.toggle('on', n === current)
    })
    if (focus) tabs[current].focus()
  }
  tabs.forEach((t, n) =>
    t.addEventListener('click', () => {
      manual = true
      show(n)
    }),
  )
  $('.tabs').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
    if (step) {
      manual = true
      show(current + step, true)
      e.preventDefault()
    }
  })
  if (reduce) return
  whileVisible($('.showcase'), () => {
    const id = setInterval(() => !manual && show(current + 1), 5500)
    return () => clearInterval(id)
  })
}

/* the command in the OpenDocument section types itself, one command after the other */
function initTyping() {
  const out = $('#typed')
  if (reduce) return
  const lines = [
    'selfoffice convert report.docx --to odt',
    'selfoffice convert budget.xlsx --to ods',
    'selfoffice convert deck.pptx   --to odp',
  ]
  whileVisible(out, () => {
    let alive = true
    ;(async () => {
      let i = 0
      while (alive) {
        for (const ch of lines[i]) {
          if (!alive) return
          out.textContent += ch
          await sleep(38)
        }
        await sleep(1600)
        while (alive && out.textContent.length) {
          out.textContent = out.textContent.slice(0, -2)
          await sleep(14)
        }
        out.textContent = ''
        i = (i + 1) % lines.length
        await sleep(250)
      }
    })()
    out.textContent = ''
    return () => {
      alive = false
    }
  })
}

/* OpenDocument: untouched parts lock as byte-identical, the edited paragraph is rewritten */
function initDiff() {
  const box = $('#diffviz')
  const status = $('#dv-status')
  const rows = $$('.row', box)
  if (reduce) {
    rows.forEach((r) => r.classList.add('lock'))
    return
  }
  whileVisible(box, () => {
    let alive = true
    ;(async () => {
      while (alive) {
        rows.forEach((r) => r.classList.remove('lock'))
        status.textContent = 'saving…'
        await sleep(700)
        for (const r of rows) {
          if (!alive) return
          r.classList.add('lock')
          await sleep(520)
        }
        status.textContent = 'saved, 1 paragraph rewritten'
        await sleep(4200)
      }
    })()
    return () => {
      alive = false
    }
  })
}

/* sections ease in as they scroll into view; nothing is hidden unless this script runs */
function initReveal() {
  if (reduce) return
  const targets = $$(
    '.block h2, .block .sub, .card, .model, .dl-card, .pipe li, .faq details, .diffviz, .window.panel.on',
  )
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in')
          io.unobserve(e.target)
          // done: hand the element back to its own hover transitions
          setTimeout(() => e.target.classList.remove('reveal', 'in'), 800)
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
  )
  for (const el of targets) {
    el.classList.add('reveal')
    io.observe(el)
  }
}

/* live data from GitHub: one cached call per two minutes, quiet failure */
async function github(path) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(`so-${path}`) || 'null')
    if (hit && Date.now() - hit.at < 120_000) return hit.data
  } catch {
    /* storage unavailable */
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`)
  if (!res.ok) throw new Error(String(res.status))
  const data = await res.json()
  try {
    sessionStorage.setItem(`so-${path}`, JSON.stringify({ at: Date.now(), data }))
  } catch {
    /* storage unavailable */
  }
  return data
}

const OS_OF = (name) => {
  if (/\.(dmg|zip)$/.test(name) && !/win|linux/i.test(name)) return 'mac'
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

const size = (bytes) =>
  bytes >= 1e8 ? `${Math.round(bytes / 1e6)} MB` : `${(bytes / 1e6).toFixed(1)} MB`

function arch(name) {
  if (/arm64|aarch64/i.test(name)) return 'arm64'
  if (/x64|x86_64|amd64/i.test(name)) return 'x64'
  return ''
}

async function initDownloads() {
  const me = detectOs()
  if (me) $(`.dl-card[data-os="${me}"]`)?.classList.add('me')
  try {
    const rel = await github('releases/latest')
    const date = rel.published_at ? new Date(rel.published_at).toLocaleDateString() : ''
    $('#dl-version').textContent = `Latest release: ${rel.tag_name}${date ? `, ${date}` : ''}`
    $('#pill-text').textContent = `${rel.tag_name} is out, open source (Apache-2.0)`
    for (const os of Object.keys(NAMES)) {
      const card = $(`.dl-card[data-os="${os}"]`)
      const assets = rel.assets
        .filter((a) => OS_OF(a.name) === os)
        .sort((a, b) => Number(MAIN[os].test(b.name)) - Number(MAIN[os].test(a.name)))
      if (!card || assets.length === 0) continue
      $('.files', card).replaceChildren(
        ...assets.map((a) => {
          const li = document.createElement('li')
          const link = document.createElement('a')
          link.href = a.browser_download_url
          link.textContent = [a.name.slice(a.name.lastIndexOf('.')), arch(a.name)]
            .filter(Boolean)
            .join(' ')
          const small = document.createElement('small')
          small.textContent = size(a.size)
          link.append(small)
          li.append(link)
          return li
        }),
      )
      const archs = [...new Set(assets.map((a) => arch(a.name)).filter(Boolean))].join(', ')
      $('.what', card).textContent = archs || NAMES[os]
      const main = assets[0]
      $('.dl-btn', card).href = main.browser_download_url
      if (os === me) {
        $('#dl-main').href = main.browser_download_url
        $('#dl-main-text').textContent = `Download for ${NAMES[os]}`
      }
    }
  } catch {
    /* keep the static links */
  }
}

async function initStars() {
  try {
    const repo = await github('')
    const n = repo.stargazers_count
    if (typeof n === 'number' && n > 0)
      $('#star-count').textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  } catch {
    /* no count */
  }
}

initTheme()
initNav()
initRotator()
initTilt()
initMarquee()
initCounters()
initSpotlight()
initTabs()
initTyping()
initDiff()
initReveal()
initDownloads()
initStars()
