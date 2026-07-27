import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'SeaPro — mereilm',
        short_name: 'SeaPro',
        description: 'Mereilm Läänemerel: tuul, lained, jaamad ja laevad ühel kaardil',
        lang: 'et',
        theme_color: '#0b3550',
        background_color: '#0b3550',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Kaardipaanid on suured ja muutumatud — hoia neid kaua, aga piira mahtu.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/tile\.openstreetmap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 1500, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/tiles\.openseamap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'seamark-tiles',
              expiration: { maxEntries: 1000, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Prognoosid: näita kohe vana, tõmba uus taustal.
            // Nii on kaatris ilma levita viimane tõmmatud prognoos alati olemas.
            urlPattern: /\/api\/(point|grid|stations|providers)/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'seapro-api',
              expiration: { maxEntries: 300, maxAgeSeconds: 12 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // AIS on reaalajas — vananenud laevapositsioon on halvem kui puuduv.
            urlPattern: /\/api\/ais/,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@seapro/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
