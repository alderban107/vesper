export function loadRepoEnv(): {
  envFile: string
  repoRoot: string
}

export function ensureLocalTestPostgres(options?: {
  stdio?: 'ignore' | 'inherit' | 'pipe'
}): void
