import { readFile, writeFile } from 'node:fs/promises'
import { EOL, platform } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

const FOCUSLOCK_START = '# === FOCUSLOCK START ==='
const FOCUSLOCK_END = '# === FOCUSLOCK END ==='

export const REFRESH_INTERVAL_MS = 30_000

export function hostsFilePath(): string {
  if (platform() === 'win32') {
    return 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  }

  return '/etc/hosts'
}

export function parseBlocklist(raw: string): string[] {
  const seen = new Set<string>()
  const domains: string[] = []

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.includes(' ') || line.includes('\t')) {
      continue
    }

    const lower = line.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      domains.push(lower)
    }
  }

  return domains
}

export async function loadBlocklist(basePath = app.getPath('userData')): Promise<string[]> {
  const filePath = join(basePath, 'blocklist.txt')

  // Reading from userData needs no elevated privileges.
  try {
    return parseBlocklist(await readFile(filePath, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return []
    }

    throw new Error(`Failed to read blocklist at "${filePath}": ${String(err)}`)
  }
}

export function removeBlock(content: string): string {
  const lines = content.split(/\r?\n/)

  const startIndex = lines.findIndex((line) => line.trim() === FOCUSLOCK_START)
  if (startIndex === -1) {
    return content
  }

  const endIndex = lines.findIndex((line) => line.trim() === FOCUSLOCK_END)
  if (endIndex === -1 || endIndex < startIndex) {
    return lines.slice(0, startIndex).join(EOL)
  }

  return [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)].join(EOL)
}

export function buildBlock(domains: string[]): string {
  const lines: string[] = [FOCUSLOCK_START]

  for (const domain of domains) {
    lines.push(`0.0.0.0 ${domain}`, `:: ${domain}`)
  }

  lines.push(FOCUSLOCK_END)

  return lines.join(EOL)
}

export async function applyHosts(domains: string[], targetPath = hostsFilePath()): Promise<void> {
  const normalized = new Set<string>()
  for (const domain of domains) {
    const lower = domain.trim().toLowerCase()
    if (lower !== '' && !lower.includes(' ') && !lower.includes('\t') && !lower.includes('#')) {
      normalized.add(lower)
    }
  }

  // Reading the system hosts file needs no elevated privileges.
  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw new Error(`Failed to read hosts file at "${targetPath}": ${String(err)}`)
    }
    content = ''
  }

  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1)
  }

  const withoutBlock = removeBlock(content)
  const separator = withoutBlock.trimEnd() === '' ? '' : EOL
  const nextContents = `${withoutBlock.trimEnd()}${separator}${buildBlock([...normalized])}${EOL}`

  // === ADMIN REQUIRED ===
  // Writing to the system hosts file needs elevated privileges:
  //  - Windows: the app must be started as Administrator (UAC elevation).
  //  - macOS/Linux: the app must be started with sudo.
  // With no elevation this writeFile rejects with EACCES/EPERM, so the
  // app cannot actually block anything.
  try {
    await writeFile(targetPath, nextContents, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `Not enough permissions to write the hosts file at "${targetPath}". ` +
          'Run the app with administrator privileges (Windows) or sudo (macOS/Linux).',
      )
    }

    throw new Error(`Failed to write hosts file at "${targetPath}": ${String(err)}`)
  }
}

export async function installBlocker(): Promise<NodeJS.Timeout> {
  try {
    await applyHosts(await loadBlocklist())
  } catch (err) {
    console.error('[blocker] hosts update failed (check privileges):', err)
  }

  const timer = setInterval(() => {
    void (async () => {
      try {
        await applyHosts(await loadBlocklist())
      } catch (err) {
        console.error('[blocker] hosts refresh failed (check privileges):', err)
      }
    })()
  }, REFRESH_INTERVAL_MS)

  return timer
}
