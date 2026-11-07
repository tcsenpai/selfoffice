import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@selfoffice/i18n'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import type { DocTheme, UiTheme } from '../shared/ipc'
import '@selfoffice/ui/tokens.css'
import '@selfoffice/ui/screentip.css'
import '@selfoffice/ui/ai-model-picker.css'
import '@selfoffice/ui/ai-queue-strip.css'
import '@selfoffice/ui/ai-usage.css'
import '@selfoffice/ui/ai-skills.css'
import '@selfoffice/ui/dropdown.css'
import '@selfoffice/ui/find-panel.css'
import '@selfoffice/ui/ribbon-collapse.css'
import '@selfoffice/ui/markdown.css'
import '@selfoffice/ui/ai-panel-prefs.css'
import '@selfoffice/ui/ai-scope-quote.css'
import '@selfoffice/ui/image-viewer.css'
import 'katex/dist/katex.min.css'
import './styles.css'
import './markdown-themes.css'
import { applyAiPanelPrefs, installScreenTips } from '@selfoffice/ui'
import type { MarkdownTheme } from '../shared/markdown-theme'

installScreenTips()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function applyMarkdownTheme(theme: MarkdownTheme): void {
  // a picked paper theme overrides the light/dark document theme for the paper
  if (theme === 'default') document.documentElement.removeAttribute('data-markdown-theme')
  else document.documentElement.setAttribute('data-markdown-theme', theme)
}

function applyDocumentTheme(theme: DocTheme): void {
  // data-doc-theme drives the preview paper (selfoffice#1811); absent means 'follow' the UI theme
  if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme')
  else document.documentElement.setAttribute('data-doc-theme', theme)
}

void (async () => {
  const [lang, theme, docTheme, mdTheme] = await Promise.all([
    window.markdownApi.getLanguage().catch(() => 'zh' as const),
    window.markdownApi.getTheme().catch(() => 'system' as const),
    window.markdownApi.getDocumentTheme?.().catch(() => 'follow' as const),
    window.markdownApi.getMarkdownTheme?.().catch(() => 'default' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  applyDocumentTheme(docTheme ?? 'follow')
  applyMarkdownTheme(mdTheme)
  window.markdownApi.onThemeChanged(applyTheme)
  window.markdownApi.onDocumentThemeChanged?.(applyDocumentTheme)
  await window.markdownApi
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.markdownApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
