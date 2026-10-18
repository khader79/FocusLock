import { appendFileSync } from 'node:fs'
import { EOL } from 'node:os'
import { join } from 'node:path'

/**
 * Append-only audit log. Electron-free leaf module (like `challenge-token.ts`)
 * so `custom-sites.ts` and `app-blocker.ts` can write audit entries without
 * importing `electron` (which breaks vitest).
 *
 * Production wires a real base dir via {@link setAuditLogBaseDir}; when no dir
 * is configured entries are dropped silently (tests may also point it at a tmp
 * directory to assert contents).
 */

let auditBaseDir: string | null = null

export function setAuditLogBaseDir(baseDir: string | null): void {
  auditBaseDir = baseDir
}

export function auditLog(action: string, ok: boolean, detail?: unknown): void {
  if (auditBaseDir === null) {
    return
  }
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    ok,
    detail: detail ?? null,
  })
  try {
    appendFileSync(join(auditBaseDir, 'audit.log'), `${entry}${EOL}`, 'utf8')
  } catch (err) {
    console.error('[audit-log] failed to write audit log:', err)
  }
}