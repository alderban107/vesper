import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    alias: {
      '@vesper/sdk/api': resolve(__dirname, '../packages/sdk/src/api/index.ts'),
      '@vesper/sdk/auth': resolve(__dirname, '../packages/sdk/src/auth/index.ts'),
      '@vesper/sdk/client': resolve(__dirname, '../packages/sdk/src/client/index.ts'),
      '@vesper/sdk/client/file-session-store': resolve(
        __dirname,
        '../packages/sdk/src/client/fileSessionStore.ts'
      ),
      '@vesper/sdk/crypto': resolve(__dirname, '../packages/sdk/src/crypto/index.ts'),
      '@vesper/sdk/storage': resolve(__dirname, '../packages/sdk/src/storage/index.ts'),
      '@vesper/sdk/storage/file': resolve(__dirname, '../packages/sdk/src/storage/file.ts'),
      '@vesper/sdk/testing': resolve(__dirname, '../packages/sdk/src/testing/index.ts'),
      '@vesper/sdk/transport': resolve(__dirname, '../packages/sdk/src/transport/index.ts'),
      '@vesper/sdk/types': resolve(__dirname, '../packages/sdk/src/types/index.ts'),
      '@vesper/sdk/voice': resolve(__dirname, '../packages/sdk/src/voice/index.ts'),
      '@vesper/sdk': resolve(__dirname, '../packages/sdk/src/index.ts'),
      '@': resolve(__dirname, 'src/renderer/src'),
      // music-metadata-browser uses Node.js Buffer internally
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
            id.includes('/ts-mls/') ||
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
