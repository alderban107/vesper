import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function missingNativePackage(error) {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/Cannot find module ['"]?(@rollup\/rollup-[a-z0-9-]+)/i)
  return match ? match[1] : null
}

function rollupVersion() {
  const pkg = require('rollup/package.json')
  if (!pkg?.version) {
    throw new Error('Could not determine installed rollup version')
  }

  return pkg.version
}

try {
  require('rollup')
  console.log('Rollup native package is available')
} catch (error) {
  const nativePackage = missingNativePackage(error)
  if (!nativePackage) {
    throw error
  }

  const version = rollupVersion()
  console.warn(`Installing missing Rollup native package: ${nativePackage}@${version}`)
  execFileSync(
    'npm',
    [
      'install',
      '--workspaces=false',
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      `${nativePackage}@${version}`
    ],
    {
      stdio: 'inherit'
    }
  )

  require('rollup')
  console.log(`Installed ${nativePackage}@${version}`)
}
