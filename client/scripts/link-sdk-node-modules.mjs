import { existsSync, lstatSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const clientNodeModules = resolve(scriptDir, '../node_modules')
const sdkNodeModules = resolve(scriptDir, '../../sdk/node_modules')
const requiredPackages = [
  '@hpke/core',
  '@noble/ciphers',
  '@noble/curves',
  '@noble/hashes',
  'hash-wasm',
  'phoenix'
]

if (!existsSync(clientNodeModules)) {
  throw new Error(`Client dependencies are not installed at ${clientNodeModules}`)
}

for (const packageName of requiredPackages) {
  if (!existsSync(join(clientNodeModules, packageName))) {
    throw new Error(`Client dependency tree does not contain SDK runtime package ${packageName}`)
  }
}

let sdkPathExists = false
try {
  lstatSync(sdkNodeModules)
  sdkPathExists = true
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

if (sdkPathExists) {
  for (const packageName of requiredPackages) {
    if (!existsSync(join(sdkNodeModules, packageName))) {
      throw new Error(
        `Existing SDK dependency path ${sdkNodeModules} cannot resolve ${packageName}`
      )
    }
  }
  console.log(`SDK dependency path already available at ${sdkNodeModules}`)
  process.exit(0)
}

// Vite intentionally compiles SDK source from ../sdk. A client-only install
// otherwise places its dependencies where Node resolution from that source
// cannot reach them. Use a directory junction on Windows and a symlink
// elsewhere; Docker uses the same dependency topology.
symlinkSync(clientNodeModules, sdkNodeModules, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`Linked ${sdkNodeModules} -> ${clientNodeModules}`)
