import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // @selfoffice/i18n and @selfoffice/electron-utils ship as TS source — must be bundled
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ['@selfoffice/i18n', '@selfoffice/electron-utils'] }),
    ],
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({ exclude: ['@selfoffice/i18n', '@selfoffice/electron-utils'] }),
    ],
  },
  renderer: {
    plugins: [react()],
    server: {
      port: Number(process.env.HTML_DEV_PORT) || 5178,
      strictPort: Boolean(process.env.HTML_DEV_PORT),
    },
  },
})
