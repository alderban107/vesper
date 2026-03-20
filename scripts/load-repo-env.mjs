import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_ENV_FILE = path.join(REPO_ROOT, '.env')
const START_TEST_POSTGRES_SCRIPT = path.join(
  REPO_ROOT,
  'sdk',
  'scripts',
  'start-test-postgres.sh'
)

let repoEnvLoaded = false
let localTestPostgresReady = false

function parseEnvFile(contents) {
  const values = new Map()

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) {
      continue
    }

    let [, key, value] = match
    value = value.trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }

    value = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')

    values.set(key, value)
  }

  return values
}

function setIfMissing(key, value) {
  if (value == null || value === '' || process.env[key] != null) {
    return
  }

  process.env[key] = value
}

function normalizeSdkTestDbEnv() {
  const host = process.env.TEST_DB_HOST ?? process.env.VESPER_SDK_TEST_DB_HOST ?? '127.0.0.1'
  const port = process.env.TEST_DB_PORT ?? process.env.VESPER_SDK_TEST_DB_PORT ?? '55432'
  const user = process.env.TEST_DB_USER ?? process.env.VESPER_SDK_TEST_DB_USER ?? 'vesper_sdk'
  const password = process.env.TEST_DB_PASS ?? process.env.VESPER_SDK_TEST_DB_PASS ?? 'vesper_sdk'

  setIfMissing('TEST_DB_HOST', host)
  setIfMissing('TEST_DB_PORT', port)
  setIfMissing('TEST_DB_USER', user)
  setIfMissing('TEST_DB_PASS', password)
  setIfMissing('VESPER_SDK_TEST_DB_HOST', host)
  setIfMissing('VESPER_SDK_TEST_DB_PORT', port)
  setIfMissing('VESPER_SDK_TEST_DB_USER', user)
  setIfMissing('VESPER_SDK_TEST_DB_PASS', password)
}

export function loadRepoEnv() {
  if (!repoEnvLoaded) {
    const envFile = process.env.VESPER_ENV_FILE ?? DEFAULT_ENV_FILE
    if (fs.existsSync(envFile)) {
      const values = parseEnvFile(fs.readFileSync(envFile, 'utf8'))
      for (const [key, value] of values.entries()) {
        setIfMissing(key, value)
      }
    }

    normalizeSdkTestDbEnv()
    repoEnvLoaded = true
  }

  return {
    envFile: process.env.VESPER_ENV_FILE ?? DEFAULT_ENV_FILE,
    repoRoot: REPO_ROOT
  }
}

export function ensureLocalTestPostgres(options = {}) {
  loadRepoEnv()

  if (localTestPostgresReady) {
    return
  }

  execFileSync('sh', [START_TEST_POSTGRES_SCRIPT], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: options.stdio ?? 'pipe'
  })

  localTestPostgresReady = true
}
