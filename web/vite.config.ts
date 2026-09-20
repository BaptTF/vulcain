import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: {
    include: ['react-pdf', 'pdfjs-dist']
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7331',
        ws: true
      }
    }
  }
})
