import { execSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { fileURLToPath } from 'url'

const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = path.resolve(SDK_ROOT, '..', '..')
const SERVER_DIR = path.join(REPO_ROOT, 'server')
let stackLifecycleQueue: Promise<void> = Promise.resolve()

function resolveTestDbEnv(): Record<string, string> {
  return {
    TEST_DB_USER: process.env.TEST_DB_USER ?? process.env.VESPER_SDK_TEST_DB_USER ?? 'vesper_sdk',
    TEST_DB_PASS: process.env.TEST_DB_PASS ?? process.env.VESPER_SDK_TEST_DB_PASS ?? 'vesper_sdk',
    TEST_DB_HOST: process.env.TEST_DB_HOST ?? process.env.VESPER_SDK_TEST_DB_HOST ?? '127.0.0.1',
    TEST_DB_PORT: process.env.TEST_DB_PORT ?? process.env.VESPER_SDK_TEST_DB_PORT ?? '55432'
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
  process: ChildProcess
  runId: string
}

export async function bootServerStack(): Promise<SdkServerStack> {
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

  const phoenix = await withStackLifecycleLock(async () => {
    execSync('mix ecto.create --quiet', { cwd: SERVER_DIR, env: mixEnv, stdio: 'pipe' })
    execSync('mix ecto.migrate --quiet', { cwd: SERVER_DIR, env: mixEnv, stdio: 'pipe' })

    const logPath = path.join(artifactDir, 'phoenix.log')
    const logStream = fs.createWriteStream(logPath)
    const nextPhoenix = spawn('mix', ['phx.server'], {
      cwd: SERVER_DIR,
      env: mixEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    nextPhoenix.stdout?.pipe(logStream)
    nextPhoenix.stderr?.pipe(logStream)

    await waitForHealth(apiUrl, 30_000)
    return nextPhoenix
  })

  return {
    apiPort,
    apiUrl,
    artifactDir,
    dbName,
    process: phoenix,
    runId
  }
}

export function teardownServerStack(stack: SdkServerStack): void {
  if (!stack.process.killed) {
    stack.process.kill('SIGTERM')
  }

  void withStackLifecycleLock(async () => {
    try {
      execSync('mix ecto.drop --quiet', {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          ...resolveTestDbEnv(),
          MIX_ENV: 'test',
          MIX_TEST_PARTITION: `_sdk_${stack.runId}`,
          VESPER_E2E: '1'
        },
        stdio: 'pipe'
      })
    } catch {
      // Best-effort cleanup.
    }
  })
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
