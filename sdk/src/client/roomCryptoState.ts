import type { RoomCryptoTopologyResolution } from '../api/roomCrypto.js'

interface RoomScopeIdentity {
  id: string
  channelId?: string | null
}

const MAX_CACHED_ROOM_KEY_EPOCHS = 8

export class RoomCryptoState {
  private readonly topologies = new Map<string, RoomCryptoTopologyResolution>()
  private readonly dataKeys = new Map<string, Map<number, Uint8Array>>()

  roomId(scope: RoomScopeIdentity): string {
    return scope.channelId ?? scope.id
  }

  topology(scope: RoomScopeIdentity): RoomCryptoTopologyResolution | null {
    return this.topologies.get(this.roomId(scope)) ?? null
  }

  rememberTopology(scope: RoomScopeIdentity, topology: RoomCryptoTopologyResolution): void {
    this.topologies.set(this.roomId(scope), topology)
  }

  forgetTopology(roomId: string): void {
    this.topologies.delete(roomId)
  }

  groupId(scope: RoomScopeIdentity): string {
    return this.topology(scope)?.groupId ?? this.roomId(scope)
  }

  dataKey(roomId: string, epoch: number): Uint8Array | null {
    const key = this.dataKeys.get(roomId)?.get(epoch)
    return key ? new Uint8Array(key) : null
  }

  rememberDataKey(roomId: string, epoch: number, key: Uint8Array): void {
    const epochs = this.dataKeys.get(roomId) ?? new Map<number, Uint8Array>()
    epochs.set(epoch, new Uint8Array(key))

    const expiredEpochs = [...epochs.keys()]
      .sort((left, right) => right - left)
      .slice(MAX_CACHED_ROOM_KEY_EPOCHS)
    for (const expiredEpoch of expiredEpochs) {
      epochs.delete(expiredEpoch)
    }

    this.dataKeys.set(roomId, epochs)
  }

  clear(): void {
    this.topologies.clear()
    this.dataKeys.clear()
  }
}
