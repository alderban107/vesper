export type AuthRefreshResult =
  | { status: 'ok'; accessToken: string }
  | { status: 'invalid' }
  | { status: 'retryable' }

export function classifyRefreshHttpFailure(status: number): 'invalid' | 'retryable' {
  return status === 401 ? 'invalid' : 'retryable'
}
