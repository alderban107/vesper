import { resolve } from 'node:path'

export function sdkSourceAliases(clientDir: string) {
  return [
    {
      find: '@vesper/sdk/client/file-session-store',
      replacement: resolve(clientDir, '../sdk/src/client/fileSessionStore.ts')
    },
    {
      find: '@vesper/sdk/storage/file',
      replacement: resolve(clientDir, '../sdk/src/storage/file.ts')
    },
    { find: '@vesper/sdk/api', replacement: resolve(clientDir, '../sdk/src/api/index.ts') },
    { find: '@vesper/sdk/auth', replacement: resolve(clientDir, '../sdk/src/auth/index.ts') },
    {
      find: '@vesper/sdk/client',
      replacement: resolve(clientDir, '../sdk/src/client/index.ts')
    },
    {
      find: '@vesper/sdk/crypto',
      replacement: resolve(clientDir, '../sdk/src/crypto/index.ts')
    },
    {
      find: '@vesper/sdk/storage',
      replacement: resolve(clientDir, '../sdk/src/storage/index.ts')
    },
    {
      find: '@vesper/sdk/testing',
      replacement: resolve(clientDir, '../sdk/src/testing/index.ts')
    },
    {
      find: '@vesper/sdk/transport',
      replacement: resolve(clientDir, '../sdk/src/transport/index.ts')
    },
    { find: '@vesper/sdk/types', replacement: resolve(clientDir, '../sdk/src/types/index.ts') },
    { find: '@vesper/sdk/voice', replacement: resolve(clientDir, '../sdk/src/voice/index.ts') },
    // Regex keeps the package-root alias from consuming subpath imports.
    { find: /^@vesper\/sdk$/, replacement: resolve(clientDir, '../sdk/src/index.ts') },
    {
      find: 'vesper-openmls-wasm',
      replacement: resolve(clientDir, '../sdk/wasm/pkg/vesper_openmls_wasm.js')
    }
  ]
}
