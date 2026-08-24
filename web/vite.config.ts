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
        // API URL-i otse brauseris avades peab serveri JSON nähtavaks jääma.
        // Muidu käsitleb Workbox seda SPA navigatsioonina ja näitab index.html-i.
        navigateFallbackDenylist: [/^\/api\//],
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
            // Jaamad ja punktivaade sisaldavad hetkemõõtmisi. Online'is
            // ootame värske serverivastuse ära; vana vastus on ainult aeglase
            // võrgu ja offline-režiimi varu. StaleWhileRevalidate andis Reactile
            // alati vana vastuse ning uuendas cache'i alles järgmise korra jaoks.
            urlPattern: /\/api\/(point|stations)(?:\?|$)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'seapro-observations',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 12 * 3600 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Prognoosiväli võib avaneda kohe viimase kaadriga: tunni aja
            // prognoos ei ole sama ajatundlik kui jaama hetkemõõtmine.
            urlPattern: /\/api\/(grid|providers)(?:\?|$)/,
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
  // MapLibre'i tööprotsess on ES-moodul (`import ./maplibre-gl-shared.mjs`),
  // seega peab ka Vite selle ES-formaadis pakendama.
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/maplibre-gl/')) return 'maplibre';
          if (/\/node_modules\/(react|react-dom)\//.test(id)) return 'react';
        },
      },
    },
  },
});
