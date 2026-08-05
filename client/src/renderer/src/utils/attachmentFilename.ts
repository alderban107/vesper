interface StagedFilenameInput {
  file: { name: string }
  anonymous?: boolean
  anonymousName?: string
  spoiler?: boolean
}

export function createAnonymousFilename(originalName: string): string {
  const extension = originalName.includes('.')
    ? originalName.slice(originalName.lastIndexOf('.'))
    : ''
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  return `${token}${extension}`
}

export function resolveStagedFilename(entry: StagedFilenameInput): string {
  let name = entry.anonymous
    ? entry.anonymousName ?? createAnonymousFilename(entry.file.name)
    : entry.file.name

  if (entry.spoiler && !name.startsWith('SPOILER_')) {
    name = `SPOILER_${name}`
  }

  return name
}
