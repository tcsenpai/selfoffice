import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@selfoffice/i18n'
import App from './App'
import { LocaleProvider } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import '@selfoffice/ui/tokens.css'
import '@selfoffice/ui/screentip.css'
import '@selfoffice/ui/ai-model-picker.css'
import '@selfoffice/ui/ai-queue-strip.css'
import '@selfoffice/ui/ai-usage.css'
import '@selfoffice/ui/ai-skills.css'
import '@selfoffice/ui/color-picker.css'
import '@selfoffice/ui/dropdown.css'
import '@selfoffice/ui/ribbon-collapse.css'
import '@selfoffice/ui/markdown.css'
import '@selfoffice/ui/ai-panel-prefs.css'
import '@selfoffice/ui/ai-scope-quote.css'
import './styles.css'
import { applyAiPanelPrefs, installScreenTips } from '@selfoffice/ui'

installScreenTips()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

void (async () => {
  const [lang, theme] = await Promise.all([
    window.pdfApi.getLanguage().catch(() => 'zh' as const),
    window.pdfApi.getTheme().catch(() => 'system' as const),
  ])
  document.documentElement.lang = htmlLang(lang as Lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  window.pdfApi.onThemeChanged(applyTheme)
  await window.pdfApi
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.pdfApi?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
})()
