import { execSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { fileURLToPath } from 'url'
import { ensureLocalTestPostgres, loadRepoEnv } from '../../../scripts/load-repo-env.mjs'

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = path.resolve(SDK_ROOT, '..')
const SERVER_DIR = path.join(REPO_ROOT, 'server')
let stackLifecycleQueue: Promise<void> = Promise.resolve()

loadRepoEnv()

function resolveTestDbEnv(): Record<string, string> {
  return {
    TEST_DB_USER: process.env.TEST_DB_USER ?? 'vesper_sdk',
    TEST_DB_PASS: process.env.TEST_DB_PASS ?? 'vesper_sdk',
    TEST_DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
    TEST_DB_PORT: process.env.TEST_DB_PORT ?? '55432'
  }
}

async function withStackLifecycleLock<T>(operation: () => Promise<T> | T): Promise<T> {
  let releaseQueue: (() => void) | undefined
  const previous = stackLifecycleQueue
  stackLifecycleQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })

  await previous

  try {
    return await operation()
  } finally {
    releaseQueue?.()
  }
}

export interface SdkServerStack {
  apiPort: number
  apiUrl: string
  artifactDir: string
  dbName: string
  logStream: fs.WriteStream
  process: ChildProcess
  runId: string
}

async function waitForProcessExit(process: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (process.exitCode != null || process.signalCode != null) {
    return
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.kill('SIGKILL')
      resolve()
    }, timeoutMs)

    process.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function stopPhoenix(
  phoenix: ChildProcess | null,
  logStream: fs.WriteStream | null
): Promise<void> {
  if (phoenix) {
    if (!phoenix.killed) {
      phoenix.kill('SIGTERM')
    }
    await waitForProcessExit(phoenix)
    if (logStream) {
      phoenix.stdout?.unpipe(logStream)
      phoenix.stderr?.unpipe(logStream)
    }
  }

  if (logStream && !logStream.closed && !logStream.destroyed) {
    await new Promise<void>((resolve) => logStream.end(resolve))
  }
}

async function dropTestDatabase(runId: string, bestEffort = false): Promise<void> {
  await withStackLifecycleLock(async () => {
    try {
      execSync('mix ecto.drop --quiet', {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          ...resolveTestDbEnv(),
          MIX_ENV: 'test',
          MIX_TEST_PARTITION: `_sdk_${runId}`,
          VESPER_E2E: '1'
        },
        stdio: 'pipe'
      })
    } catch (error) {
      if (!bestEffort) {
        throw error
      }
    }
  })
}

function removeArtifacts(artifactDir: string): void {
  if (process.env.VESPER_SDK_KEEP_ARTIFACTS !== '1') {
    fs.rmSync(artifactDir, { recursive: true, force: true })
  }
}

export async function bootServerStack(): Promise<SdkServerStack> {
  ensureLocalTestPostgres()

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const partition = `_sdk_${runId}`
  const apiPort = await getFreePort()
  const apiUrl = `http://127.0.0.1:${apiPort}`
  const dbName = `vesper_test${partition}`
  const artifactDir = path.join(REPO_ROOT, 'packages', 'sdk', 'artifacts', runId)

  fs.mkdirSync(artifactDir, { recursive: true })

  const mixEnv = {
    ...process.env,
    ...resolveTestDbEnv(),
    MIX_ENV: 'test',
    MIX_TEST_PARTITION: partition,
    VESPER_E2E: '1',
    PORT: String(apiPort)
  }

  let logStream: fs.WriteStream | null = null
  let phoenix: ChildProcess | null = null

  try {
    await withStackLifecycleLock(async () => {
      execSync('mix ecto.create --quiet', { cwd: SERVER_DIR, env: mixEnv, stdio: 'pipe' })
      execSync('mix ecto.migrate --quiet', { cwd: SERVER_DIR, env: mixEnv, stdio: 'pipe' })

      const logPath = path.join(artifactDir, 'phoenix.log')
      logStream = fs.createWriteStream(logPath)
      phoenix = spawn('mix', ['phx.server'], {
        cwd: SERVER_DIR,
        env: mixEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      phoenix.stdout?.pipe(logStream)
      phoenix.stderr?.pipe(logStream)

      await waitForHealth(apiUrl, 30_000)
    })

    if (!logStream || !phoenix) {
      throw new Error('Phoenix stack was not initialized')
    }

    return {
      apiPort,
      apiUrl,
      artifactDir,
      dbName,
      logStream,
      process: phoenix,
      runId
    }
  } catch (error) {
    await stopPhoenix(phoenix, logStream)
    await dropTestDatabase(runId, true)
    removeArtifacts(artifactDir)
    throw error
  }
}

export async function teardownServerStack(stack: SdkServerStack): Promise<void> {
  await stopPhoenix(stack.process, stack.logStream)

  try {
    await dropTestDatabase(stack.runId)
  } finally {
    removeArtifacts(stack.artifactDir)
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a free port'))
        return
      }

      server.close(() => resolve(address.port))
    })
    server.on('error', reject)
  })
}

async function waitForHealth(apiUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/health`)
      if (response.ok) {
        return
      }
    } catch {
      // Keep polling.
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for ${apiUrl}/health`)
}
