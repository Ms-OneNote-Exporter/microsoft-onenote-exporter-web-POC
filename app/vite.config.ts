import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The React build.
 *
 * Output is plain relative-path assets copied into the app image and served by
 * Fastify: no CDN, no third-party JS, no analytics, no remote fonts. `base:
 * './'` matters because the session page lives at `/s/<guid>`, so absolute asset
 * paths would 404 on every route except `/`.
 *
 * The dev server proxies /api to the app so the browser sees one origin, which
 * keeps EventSource and fetch behaving the same in dev and in the image.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
