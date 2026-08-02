export interface ApplicationHistoryAuthorization {
  generation: string
  authorizedAfterRoomSeq: number
}

export function normalizeApplicationHistoryAuthorization(
  generation: unknown,
  authorizedAfterRoomSeq: unknown
): ApplicationHistoryAuthorization | null {
  if (
    typeof generation !== 'string' ||
    generation.length === 0 ||
    typeof authorizedAfterRoomSeq !== 'number' ||
    !Number.isSafeInteger(authorizedAfterRoomSeq) ||
    authorizedAfterRoomSeq < 0
  ) {
    return null
  }

  return { generation, authorizedAfterRoomSeq }
}

/**
 * Application history fences are exclusive room-sequence boundaries: an item
 * is recoverable only when its server-authenticated room sequence was allocated
 * after the current membership tenure began.
 */
export function applicationHistoryIncludesRoomSeq(
  authorization: ApplicationHistoryAuthorization,
  roomSeq: unknown
): roomSeq is number {
  return (
    typeof roomSeq === 'number' &&
    Number.isSafeInteger(roomSeq) &&
    roomSeq > authorization.authorizedAfterRoomSeq
  )
}
