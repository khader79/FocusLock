import { app, dialog, type BrowserWindow } from 'electron'
import { blockApp, unblockApp } from './app-blocker'
import { applyHosts, requestBlockerApply, stopBlocker } from './blocker'
import { setCategoryEnabled } from './categories'
import { addSite, removeSite } from './custom-sites'
import { reloadDnsRules } from './dns-service'
import { exportData, type ExportFormat } from './export'
import { registerProtectedActionExecutor } from './protected-actions'
import { addRule, removeRule, updateRule, type RuleInput } from './rules'
import {
  readBlockedApps,
  readBlockedDomains,
  wipeProtectionData,
  writeBlockedApps,
  writeBlockedDomains,
} from './site-store'
import {
  buildServiceSpec,
  installService,
  isServiceInstalled,
  startService,
  stopService,
  uninstallService,
  type ServiceSpec,
} from './windows-service'

/**
 * Callbacks the executors need from the app (injected by index.ts to avoid a
 * circular dependency).
 */
export interface ProtectedExecutorContext {
  getMainWindow: () => BrowserWindow | null
  beginPause: () => void
  quit: () => void
  startDns: () => Promise<boolean>
  stopDns: () => Promise<void>
  restoreSystemDns: () => Promise<void>
  getSilentMode: () => boolean
  setSilentMode: (enabled: boolean) => Promise<void>
}

function requireStringField(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Payload field "${field}" must be a non-empty string.`)
  }
  return value.trim()
}

function requireNumberField(payload: unknown, field: string): number {
  const value = (payload as Record<string, unknown> | null)?.[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`Payload field "${field}" must be an integer.`)
  }
  return value
}

function serviceSpec(): ServiceSpec {
  return buildServiceSpec(app.getPath('exe'), app.getPath('userData'))
}

/** Stops and removes the background enforcement service if it is installed. */
async function stopEnforcementService(spec: ServiceSpec): Promise<void> {
  if (!(await isServiceInstalled(spec))) {
    return
  }
  await stopService(spec)
  await uninstallService(spec)
}

/**
 * Registers the real implementation of every protected action. Each executor
 * runs only after executeProtectedAction() verified its challenge token.
 */
export function registerProtectedExecutors(ctx: ProtectedExecutorContext): void {
  registerProtectedActionExecutor('pause', async () => {
    ctx.beginPause()
  })

  registerProtectedActionExecutor('settings', async () => {
    const win = ctx.getMainWindow()
    win?.show()
    win?.focus()
  })

  registerProtectedActionExecutor('toggle_silent_mode', async () => {
    const next = !ctx.getSilentMode()
    await ctx.setSilentMode(next)
    const win = ctx.getMainWindow()
    const spec = serviceSpec()
    if (next) {
      // Silent mode: hand enforcement to the Windows service so blocking keeps
      // running headlessly, then hid the window. The in-process DNS filter must
      // release port 53 first so the service can bind it.
      await ctx.stopDns()
      if (!(await isServiceInstalled(spec))) {
        await installService(spec)
      }
      await startService(spec)
      win?.hide()
    } else {
      // Normal mode: take enforcement back into this process and stop the
      // background service.
      await stopEnforcementService(spec)
      await ctx.startDns()
      win?.show()
      win?.focus()
    }
  })

  registerProtectedActionExecutor('quit', async (_payload, challengeToken) => {
    // Quitting is the only moment the background blocker is allowed to stop.
    stopBlocker(challengeToken)
    await stopEnforcementService(serviceSpec())
    await ctx.stopDns()
    ctx.quit()
  })

  registerProtectedActionExecutor('add_site', async (payload) => {
    const domain = requireStringField(payload, 'domain').toLowerCase()
    await writeBlockedDomains([...(await readBlockedDomains()), domain])
    // The worker thread re-reads the blocklist and rewrites the hosts file.
    requestBlockerApply()
    await reloadDnsRules()
  })

  registerProtectedActionExecutor('remove_site', async (payload) => {
    const domain = requireStringField(payload, 'domain').toLowerCase()
    await writeBlockedDomains((await readBlockedDomains()).filter((d) => d !== domain))
    requestBlockerApply()
    await reloadDnsRules()
  })

  registerProtectedActionExecutor('add_app', async (payload) => {
    const appName = requireStringField(payload, 'app')
    await writeBlockedApps([...(await readBlockedApps()), appName])
  })

  registerProtectedActionExecutor('remove_app', async (payload) => {
    const appName = requireStringField(payload, 'app')
    await writeBlockedApps((await readBlockedApps()).filter((a) => a !== appName))
  })

  registerProtectedActionExecutor('add_custom_site', async (payload, challengeToken) => {
    const input = requireStringField(payload, 'input')
    await addSite(input, challengeToken)
  })

  registerProtectedActionExecutor('remove_custom_site', async (payload, challengeToken) => {
    const id = requireNumberField(payload, 'id')
    await removeSite(id, challengeToken)
  })

  registerProtectedActionExecutor('block_app', async (payload, challengeToken) => {
    const exePath = requireStringField(payload, 'exePath')
    await blockApp(exePath, challengeToken)
  })

  registerProtectedActionExecutor('unblock_app', async (payload, challengeToken) => {
    const name = requireStringField(payload, 'name')
    await unblockApp(name, challengeToken)
  })

  registerProtectedActionExecutor('add_rule', async (payload, challengeToken) => {
    const rule = (payload as { rule?: unknown }).rule
    await addRule(rule as RuleInput, challengeToken)
  })

  registerProtectedActionExecutor('remove_rule', async (payload, challengeToken) => {
    const id = requireNumberField(payload, 'id')
    await removeRule(id, challengeToken)
  })

  registerProtectedActionExecutor('update_rule', async (payload, challengeToken) => {
    const id = requireNumberField(payload, 'id')
    const rule = (payload as { rule?: unknown }).rule
    await updateRule(id, rule as RuleInput, challengeToken)
  })

  registerProtectedActionExecutor('toggle_category', async (payload, challengeToken) => {
    const id = requireStringField(payload, 'id')
    const target = requireStringField(payload, 'target')
    if (target !== 'enable' && target !== 'disable') {
      throw new TypeError('Payload field "target" must be "enable" or "disable".')
    }
    // Preset or custom category; the token has already had its action claim
    // verified by the protected-action layer before this executor runs.
    await setCategoryEnabled(id, target === 'enable', {
      onRulesChanged: () => reloadDnsRules(),
    })
    void challengeToken
  })

  registerProtectedActionExecutor('export', async (payload, challengeToken) => {
    const body = payload as Record<string, unknown> | null
    const requestedPath = body?.['filePath'] as string | undefined
    const requestedFormat = body?.['format']
    const format: ExportFormat = requestedFormat === 'txt' || requestedFormat === 'csv' || requestedFormat === 'hosts' || requestedFormat === 'json'
      ? requestedFormat
      : 'json'
    let filePath =
      typeof requestedPath === 'string' && requestedPath.trim() !== '' ? requestedPath.trim() : undefined

    if (filePath === undefined) {
      const result = await dialog.showSaveDialog({
        title: 'Export FocusLock data',
        defaultPath: `focuslock-export.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      })
      if (result.canceled || result.filePath === undefined) {
        return
      }
      filePath = result.filePath
    }

    await exportData(format, filePath, challengeToken)
  })

  registerProtectedActionExecutor('uninstall', async (_payload, challengeToken) => {
    // Remove the sites block from the hosts file, delete every persisted rule,
    // stop the background blocker, DNS filter and enforcement service, restore
    // the system DNS, then leave the app for good.
    await applyHosts([])
    await wipeProtectionData()
    stopBlocker(challengeToken)
    await stopEnforcementService(serviceSpec())
    await ctx.stopDns()
    await ctx.restoreSystemDns()
    ctx.quit()
  })
}
