import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { scrRealtimePlugin } from './scripts/realtime/vite-plugin.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), scrRealtimePlugin()],
  server: {
    watch: {
      // Chrome holds locks inside the real-time session profile; watching it
      // crashes the dev server (EBUSY) and it's not source anyway.
      ignored: ['**/.scr-session/**'],
    },
  },
})
