/**
 * Deterministic avatar color from a userId string.
 * Used as fallback when no avatar image is set.
 */
export function avatarColor(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 50%, 40%)`
}
