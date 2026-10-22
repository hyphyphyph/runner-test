import { defineConfig } from 'vite'

// In development the API server runs on PORT (default 8787) and Vite proxies
// /api to it, so the page and the API share one origin. The typed client in
// shared/client.ts therefore needs no base URL in the browser.
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? '8787'}`,
        changeOrigin: false,
      },
    },
  },
})
