import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'
import type { Plugin } from 'vite'

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
        if (req.url?.endsWith(wasmFileName)) {
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

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), openmlsWasmPlugin()],
  resolve: {
    alias: {
      '@vesper/sdk/api': resolve(__dirname, '../sdk/src/api/index.ts'),
      '@vesper/sdk/auth': resolve(__dirname, '../sdk/src/auth/index.ts'),
      '@vesper/sdk/client': resolve(__dirname, '../sdk/src/client/index.ts'),
      '@vesper/sdk/client/file-session-store': resolve(
        __dirname,
        '../sdk/src/client/fileSessionStore.ts'
      ),
      '@vesper/sdk/crypto': resolve(__dirname, '../sdk/src/crypto/index.ts'),
      '@vesper/sdk/storage': resolve(__dirname, '../sdk/src/storage/index.ts'),
      '@vesper/sdk/storage/file': resolve(__dirname, '../sdk/src/storage/file.ts'),
      '@vesper/sdk/testing': resolve(__dirname, '../sdk/src/testing/index.ts'),
      '@vesper/sdk/transport': resolve(__dirname, '../sdk/src/transport/index.ts'),
      '@vesper/sdk/types': resolve(__dirname, '../sdk/src/types/index.ts'),
      '@vesper/sdk/voice': resolve(__dirname, '../sdk/src/voice/index.ts'),
      '@vesper/sdk': resolve(__dirname, '../sdk/src/index.ts'),
      'vesper-openmls-wasm': resolve(__dirname, '../sdk/wasm/pkg/vesper_openmls_wasm.js'),
      '@': resolve(__dirname, 'src/renderer/src'),
      buffer: 'buffer/'
    }
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
