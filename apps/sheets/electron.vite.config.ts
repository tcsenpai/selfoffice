import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // @selfoffice/* workspace packages ship TS source (no build step, no
    // compiled entry point) — externalizing them makes Node's ESM loader try
    // to resolve their relative imports at runtime and fail. Bundle those;
    // externalize everything else (Electron, zod, node builtins).
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@selfoffice/ai-provider',
          '@selfoffice/agent-core',
          '@selfoffice/ai-search',
          '@selfoffice/docx-engine',
          '@selfoffice/file-parse',
          '@selfoffice/electron-utils',
          '@selfoffice/i18n',
          '@selfoffice/pptx-render',
          '@selfoffice/xlsx-gateway',
        ],
      }),
    ],
  },
  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at
    // runtime, so the drop-open bridge must be bundled, not externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['@selfoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react()],
  },
})
