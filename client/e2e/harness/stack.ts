/**
 * Boots and tears down the local Phoenix + Vite stack for E2E.
 * Covers: R-HARNESS-1 (fresh stack on unique ports)
 *         R-HARNESS-2 (runtime state isolated per run)
 */

import { spawn, type ChildProcess, execFileSync, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getFreePort } from './ports'
import { waitForHealth, waitForVite } from './readiness'
import { type RunState, generateRunId, readRunState, writeRunState } from './state'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SERVER_DIR = path.join(ROOT, 'server')
const CLIENT_DIR = path.join(ROOT, 'client')
const SDK_TEST_DB_START_SCRIPT = path.join(ROOT, 'sdk', 'scripts', 'start-test-postgres.sh')

let phoenixProcess: ChildProcess | null = null
let viteProcess: ChildProcess | null = null

function loadRepoEnv(): void {
  const envFile = process.env.VESPER_ENV_FILE ?? path.join(ROOT, '.env')

  if (fs.existsSync(envFile)) {
    for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
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

      if (process.env[key] == null) {
        process.env[key] = value
      }
    }
  }

  process.env.TEST_DB_HOST ??= process.env.VESPER_SDK_TEST_DB_HOST ?? '127.0.0.1'
  process.env.TEST_DB_PORT ??= process.env.VESPER_SDK_TEST_DB_PORT ?? '55432'
  process.env.TEST_DB_USER ??= process.env.VESPER_SDK_TEST_DB_USER ?? 'vesper_sdk'
  process.env.TEST_DB_PASS ??= process.env.VESPER_SDK_TEST_DB_PASS ?? 'vesper_sdk'
}

loadRepoEnv()

export async function bootStack(): Promise<RunState> {
  try {
    const existing = readRunState()
    if (existing.ownerPid === process.ppid) {
      await waitForHealth(existing.apiUrl, 1_000)
      await waitForVite(existing.clientUrl, 1_000)
      console.log(`[e2e] Reusing stack ${existing.runId}...`)
      return existing
    }
  } catch {
    // No active stack to reuse.
  }

  const runId = generateRunId()
  const apiPort = await getFreePort()
  const clientPort = await getFreePort()
  const dbName = `vesper_test_e2e_${runId}`
  const apiUrl = `http://127.0.0.1:${apiPort}`
  const clientUrl = `http://127.0.0.1:${clientPort}`

  const artifactDir = path.join(CLIENT_DIR, 'e2e', 'artifacts', runId)
  const profileDir = path.join(CLIENT_DIR, 'e2e', 'profiles', runId)

  fs.mkdirSync(artifactDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })

  const state: RunState = {
    runId,
    ownerPid: process.ppid,
    apiPort,
    apiUrl,
    clientPort,
    clientUrl,
    dbName,
    artifactDir,
    profileDir,
  }

  execFileSync('bash', [SDK_TEST_DB_START_SCRIPT], {
    cwd: ROOT,
    env: process.env,
    stdio: 'pipe',
  })

  // --- Database setup ---
  const mixEnv = {
    ...process.env,
    MIX_ENV: 'test',
    MIX_TEST_PARTITION: `_e2e_${runId}`,
    VESPER_E2E: '1',
    PORT: String(apiPort),
  }

  console.log(`[e2e] Creating database ${dbName}...`)
  execSync('mix ecto.create --quiet', { cwd: SERVER_DIR, env: mixEnv, stdio: 'pipe' })
  execSync('mix ecto.migrate --quiet', { cwd: SERVER_DIR, env: mixEnv, stdio: 'pipe' })

  // --- Start Phoenix ---
  console.log(`[e2e] Starting Phoenix on port ${apiPort}...`)
  const phxLogPath = path.join(artifactDir, 'phoenix.log')
  const phxLogStream = fs.createWriteStream(phxLogPath)

  phoenixProcess = spawn('mix', ['phx.server'], {
    cwd: SERVER_DIR,
    env: mixEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  phoenixProcess.stdout?.pipe(phxLogStream)
  phoenixProcess.stderr?.pipe(phxLogStream)
  state.phoenixPid = phoenixProcess.pid

  phoenixProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[e2e] Phoenix exited with code ${code}`)
    }
  })

  await waitForHealth(apiUrl, 30_000)
  console.log(`[e2e] Phoenix ready at ${apiUrl}`)

  // --- Start Vite dev server ---
  console.log(`[e2e] Starting Vite on port ${clientPort}...`)
  const viteLogPath = path.join(artifactDir, 'vite.log')
  const viteLogStream = fs.createWriteStream(viteLogPath)

  viteProcess = spawn(
    'npx',
    ['vite', '--config', 'vite.web.config.ts', '--host', '127.0.0.1', '--port', String(clientPort), '--strictPort'],
    {
      cwd: CLIENT_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  viteProcess.stdout?.pipe(viteLogStream)
  viteProcess.stderr?.pipe(viteLogStream)
  state.vitePid = viteProcess.pid

  viteProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[e2e] Vite exited with code ${code}`)
    }
  })

  // Write state early so teardown can clean up even if Vite readiness fails
  writeRunState(state)

  await waitForVite(clientUrl, 15_000)
  console.log(`[e2e] Vite ready at ${clientUrl}`)

  return state
}

export function teardownStack(state: RunState): void {
  // Kill processes
  if (phoenixProcess && !phoenixProcess.killed) {
    console.log('[e2e] Stopping Phoenix...')
    phoenixProcess.kill('SIGTERM')
    phoenixProcess = null
  } else if (state.phoenixPid) {
    try {
      console.log('[e2e] Stopping Phoenix...')
      process.kill(state.phoenixPid, 'SIGTERM')
    } catch {
      // already stopped
    }
  }

  if (viteProcess && !viteProcess.killed) {
    console.log('[e2e] Stopping Vite...')
    viteProcess.kill('SIGTERM')
    viteProcess = null
  } else if (state.vitePid) {
    try {
      console.log('[e2e] Stopping Vite...')
      process.kill(state.vitePid, 'SIGTERM')
    } catch {
      // already stopped
    }
  }

  // Drop the E2E database
  try {
    console.log(`[e2e] Dropping database ${state.dbName}...`)
    execSync('mix ecto.drop --quiet', {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        MIX_ENV: 'test',
        MIX_TEST_PARTITION: `_e2e_${state.runId}`,
        VESPER_E2E: '1',
      },
      stdio: 'pipe',
    })
  } catch {
    console.warn(`[e2e] Could not drop database ${state.dbName} (may already be gone)`)
  }

  // Clean up profile directories
  try {
    fs.rmSync(state.profileDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}
