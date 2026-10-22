import { defineConfig } from 'vite'

// In development the API server runs on 8787 and Vite proxies to it.
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
})
