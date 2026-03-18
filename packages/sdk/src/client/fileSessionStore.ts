import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { SessionNotice, SessionStore } from '../api/client.js'

interface FileSessionState {
  serverUrl: string | null
  accessToken: string | null
  refreshToken: string | null
  notice: SessionNotice | null
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

function safeReadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) {
      return fallback
    }

    const raw = readFileSync(filePath, 'utf8')
    return raw.trim() ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export class FileSessionStore implements SessionStore {
  private readonly filePath: string
  private state: FileSessionState

  constructor(filePath: string, serverUrl?: string | null) {
    this.filePath = filePath
    this.state = safeReadJson<FileSessionState>(filePath, {
      serverUrl: serverUrl ?? null,
      accessToken: null,
      refreshToken: null,
      notice: null
    })

    if (typeof serverUrl === 'string' && serverUrl.trim()) {
      this.state.serverUrl = serverUrl.trim().replace(/\/+$/, '')
      this.persist()
    }
  }

  getServerUrl(): string {
    const serverUrl = String(this.state.serverUrl ?? '').trim()
    if (!serverUrl) {
      throw new Error(
        'Vesper base URL is not configured. Set a server URL in FileSessionStore or provide baseUrl to createVesperClient().'
      )
    }

    return serverUrl
  }

  setServerUrl(serverUrl: string): void {
    this.state.serverUrl = serverUrl.trim().replace(/\/+$/, '')
    this.persist()
  }

  getAccessToken(): string | null {
    return this.state.accessToken
  }

  getRefreshToken(): string | null {
    return this.state.refreshToken
  }

  setTokens(accessToken: string, refreshToken: string): void {
    this.state.accessToken = accessToken
    this.state.refreshToken = refreshToken
    this.persist()
  }

  clearTokens(): void {
    this.state.accessToken = null
    this.state.refreshToken = null
    this.persist()
  }

  setSessionNotice(notice: SessionNotice): void {
    this.state.notice = notice
    this.persist()
  }

  clearSessionNotice(): void {
    this.state.notice = null
    this.persist()
  }

  getSessionNotice(): SessionNotice | null {
    return this.state.notice
  }

  emitSessionNotice(): void {}

  private persist(): void {
    writeJson(this.filePath, this.state)
  }
}

export function createFileSessionStore(
  filePath: string,
  serverUrl?: string | null
): FileSessionStore {
  return new FileSessionStore(filePath, serverUrl)
}
