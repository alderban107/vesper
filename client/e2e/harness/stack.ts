/**
 * Boots and tears down the local Phoenix + Vite stack for E2E.
 * Covers: R-HARNESS-1 (fresh stack on unique ports)
 *         R-HARNESS-2 (runtime state isolated per run)
 */

import { spawn, type ChildProcess, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getFreePort } from './ports'
import { waitForHealth, waitForVite } from './readiness'
import { type RunState, generateRunId, writeRunState } from './state'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const SERVER_DIR = path.join(ROOT, 'server')
const CLIENT_DIR = path.join(ROOT, 'client')

let phoenixProcess: ChildProcess | null = null
let viteProcess: ChildProcess | null = null

export async function bootStack(): Promise<RunState> {
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
    apiPort,
    apiUrl,
    clientPort,
    clientUrl,
    dbName,
    artifactDir,
    profileDir,
  }

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
  }

  if (viteProcess && !viteProcess.killed) {
    console.log('[e2e] Stopping Vite...')
    viteProcess.kill('SIGTERM')
    viteProcess = null
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
