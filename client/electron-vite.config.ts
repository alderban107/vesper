import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@vesper/sdk/api': resolve(__dirname, '../sdk/src/api/index.ts'),
        '@vesper/sdk/auth': resolve(__dirname, '../sdk/src/auth/index.ts'),
        '@vesper/sdk/crypto': resolve(__dirname, '../sdk/src/crypto/index.ts'),
        '@vesper/sdk/storage': resolve(__dirname, '../sdk/src/storage/index.ts'),
        '@vesper/sdk/testing': resolve(__dirname, '../sdk/src/testing/index.ts'),
        '@vesper/sdk/transport': resolve(__dirname, '../sdk/src/transport/index.ts'),
        '@vesper/sdk/types': resolve(__dirname, '../sdk/src/types/index.ts'),
        '@vesper/sdk/voice': resolve(__dirname, '../sdk/src/voice/index.ts'),
        '@vesper/sdk': resolve(__dirname, '../sdk/src/index.ts')
      }
    }
  }
})
