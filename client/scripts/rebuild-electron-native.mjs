import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronVersion = require('electron/package.json').version
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(
  npmCommand,
  ['rebuild', 'better-sqlite3-multiple-ciphers'],
  {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_disturl: 'https://electronjs.org/headers'
    }
  }
)

if (result.status !== 0) process.exit(result.status ?? 1)
