import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'
import type { Plugin } from 'vite'
import { sdkSourceAliases } from './vite.sdk-aliases'

const wasmPkgDir = resolve(__dirname, '../sdk/wasm/pkg')
const wasmFileName = 'vesper_openmls_wasm_bg.wasm'

/**
 * Vite plugin to handle OpenMLS WASM binary:
 * - In dev: serves the .wasm file from the SDK package
 * - In build: copies the .wasm file to the output directory
 */
function openmlsWasmPlugin(): Plugin {
  return {
    name: 'openmls-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Serve WASM at the well-known path and any path containing the filename
        if (req.url && (
          req.url === `/assets/${wasmFileName}` ||
          req.url.includes(wasmFileName)
        )) {
          const wasmPath = resolve(wasmPkgDir, wasmFileName)
          res.setHeader('Content-Type', 'application/wasm')
          res.end(readFileSync(wasmPath))
          return
        }
        next()
      })
    },
    generateBundle() {
      const wasmPath = resolve(wasmPkgDir, wasmFileName)
      if (existsSync(wasmPath)) {
        this.emitFile({
          type: 'asset',
          fileName: `assets/${wasmFileName}`,
          source: readFileSync(wasmPath)
        })
      }
    }
  }
}

/**
 * Vite plugin to copy the service worker to the build output.
 * The SW must be served from the root path for push notifications.
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'service-worker-copy',
    generateBundle() {
      const swPath = resolve(__dirname, 'src/renderer/sw.js')
      if (existsSync(swPath)) {
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: readFileSync(swPath, 'utf-8')
        })
      }
    }
  }
}

/**
 * Vite plugin to set immutable cache headers for self-hosted twemoji SVGs.
 * These files never change, so browsers should cache them permanently.
 */
function twemojiCachePlugin(): Plugin {
  return {
    name: 'twemoji-cache-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/twemoji/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
        next()
      })
    }
  }
}

export default defineConfig({
  root: 'src/renderer',
  server: {
    fs: {
      // Allow serving the WASM binary from the SDK package
      allow: ['..', resolve(__dirname, '../sdk')]
    },
    proxy: {
      '/socket': {
        target: 'https://vesper.irrigate.cc',
        changeOrigin: true,
        ws: true
      },
      '/api': {
        target: 'https://vesper.irrigate.cc',
        changeOrigin: true
      },
      '/uploads': {
        target: 'https://vesper.irrigate.cc',
        changeOrigin: true
      }
    }
  },
  plugins: [react(), openmlsWasmPlugin(), serviceWorkerPlugin(), twemojiCachePlugin()],
  resolve: {
    alias: [
      ...sdkSourceAliases(__dirname),
      { find: '@', replacement: resolve(__dirname, 'src/renderer/src') },
      { find: 'buffer', replacement: 'buffer/' }
    ]
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (
            id.includes('/react-markdown/') ||
            id.includes('/remark-gfm/') ||
            id.includes('/remark-math/') ||
            id.includes('/rehype-katex/') ||
            id.includes('/katex/') ||
            id.includes('/highlight.js/')
          ) {
            return 'markdown'
          }

          if (
            id.includes('/vesper-openmls-wasm/') ||
            id.includes('/@noble/') ||
            id.includes('/@hpke/') ||
            id.includes('/hash-wasm/')
          ) {
            return 'crypto-vendor'
          }

          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/zustand/') ||
            id.includes('/lucide-react/')
          ) {
            return 'app-vendor'
          }

          return undefined
        }
      }
    }
  }
})
