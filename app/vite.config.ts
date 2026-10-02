import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The React build.
 *
 * Output is copied into the app image and served by Fastify: no CDN, no
 * third-party JS, no analytics, no remote fonts.
 *
 * `base: '/'`, not `'./'`. The session page is served at `/s/<guid>`, and a
 * relative asset URL resolves against `/s/`, so the browser asks for
 * `/s/assets/index.js` and gets a 404 - a blank page with a 200 status, which is
 * about as confusing a failure as there is. Absolute URLs are right for every
 * route: there is one bundle and it lives at the root.
 *
 * The dev server proxies /api to the app so the browser sees one origin, which
 * keeps EventSource and fetch behaving the same in dev and in the image.
 */
export default defineConfig({
  plugins: [react()],
  base: '/',
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
