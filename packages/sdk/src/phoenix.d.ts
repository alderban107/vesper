declare module 'phoenix' {
  export class Push {
    receive(status: string, callback: (payload?: unknown) => void): Push
  }

  export class Channel {
    join(): Push
    leave(): void
    on(event: string, callback: (payload: unknown) => void): void
    push(event: string, payload: object): Push
  }

  export class Socket {
    constructor(url: string, options?: { params?: () => Record<string, unknown> })
    connect(): void
    disconnect(): void
    isConnected(): boolean
    onOpen(callback: () => void): void
    channel(topic: string, params: object): Channel
  }
}
