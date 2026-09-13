import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { auditLog } from './audit-log'
import { verifyTokenForAction } from './challenge-token'

/**
 * Focus rules engine.
 *
 * Rules map a set of conditions (schedule / network / sequence / time-of-day)
 * to an action (block a category, raise challenge difficulty, block everything,
 * notify a trusted contact, or extend the time lock). Every 30 seconds the
 * engine evaluates the current {@link RuleContext} and emits the set of active
 * actions in priority order, logging each activation/deactivation transition
 * to the audit log (see {@link setAuditLogBaseDir}).
 *
 * Every mutation requires a valid challenge token minted for the matching
 * action (`add_rule` / `remove_rule` / `update_rule`); invalid or mismatched
 * tokens throw.
 *
 * Electron-free: the base directory, the live context provider and the
 * "apply" effects are wired in by `index.ts`, so this module (and its tests)
 * run under plain Node/vitest.
 */

export const RULE_EVALUATION_MS = 30_000

/** 0 = Sunday ... 6 = Saturday (matches `Date#getDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** One rule condition. Every rule has exactly one. */
export type RuleCondition =
  | { type: 'schedule'; days: Weekday[]; from: string; to: string }
  | { type: 'network'; ssid: string }
  | { type: 'sequence'; trigger: 'session-start' | 'app-launch'; app?: string | null; delayMinutes: number }
  | { type: 'time_based'; afterHours: number }

/** What a matching rule does. */
export type RuleAction =
  | { type: 'block_category'; category: string }
  | { type: 'increase_difficulty'; level: number }
  | { type: 'block_everything' }
  | { type: 'notify_trusted_contact' }
  | { type: 'extend_time_lock'; minutes: number }

export interface Rule {
  id: number
  name: string
  condition: RuleCondition
  action: RuleAction
  /** Lower values run first. */
  priority: number
  enabled: boolean
}

/** Input for {@link addRule} / {@link updateRule}; `priority` defaults on add. */
export type RuleInput = Omit<Rule, 'id' | 'priority'> & { priority?: number }

/** A rule that matched the current context, in priority order. */
export interface ActiveAction {
  ruleId: number
  ruleName: string
  priority: number
  action: RuleAction
}

/** Snapshot of the world the engine evaluates against. */
export interface RuleContext {
  now: Date
  network: { ssid: string; type: string }
  /** Package/process name currently in the foreground, or null. */
  active_app: string | null
  session_start: Date
}

export type RuleContextProvider = () => RuleContext | Promise<RuleContext>

/** Side-effect sink called after each evaluation with the resulting actions. */
export interface RuleEffects {
  onActiveActionsChanged: (active: ActiveAction[]) => Promise<void> | void
}

let baseDirOverride: string | null = null
let contextProvider: RuleContextProvider | null = null
let effects: RuleEffects | null = null

/** Maps rule id -> last seen active action (drives transition auditing). */
let lastActiveActions = new Map<number, ActiveAction>()

/** Sets the default data dir used by {@link loadRules} & co. when no baseDir is passed. */
export function setRulesBaseDir(baseDir: string): void {
  baseDirOverride = baseDir
}

export function resetRulesBaseDir(): void {
  baseDirOverride = null
}

function resolveBaseDir(explicit?: string): string {
  const baseDir = explicit ?? baseDirOverride
  if (baseDir === null) {
    throw new Error('Rules base directory is not configured.')
  }
  return baseDir
}

export function rulesFilePath(baseDir?: string): string {
  return join(resolveBaseDir(baseDir), 'focus-rules.json')
}

// --- Validation --------------------------------------------------------------

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value)
}

function isCondition(value: unknown): value is RuleCondition {
  if (typeof value !== 'object' || value === null) return false
  const condition = value as Partial<RuleCondition> & { type?: unknown }
  if (condition.type === 'schedule') {
    const next = value as { days?: unknown; from?: unknown; to?: unknown }
    return (
      Array.isArray(next.days) &&
      next.days.every(isWeekday) &&
      isTime(next.from) &&
      isTime(next.to)
    )
  }
  if (condition.type === 'network') {
    const next = value as { ssid?: unknown }
    return typeof next.ssid === 'string'
  }
  if (condition.type === 'sequence') {
    const next = value as { trigger?: unknown; delayMinutes?: unknown; app?: unknown }
    return (
      (next.trigger === 'session-start' || next.trigger === 'app-launch') &&
      typeof next.delayMinutes === 'number' &&
      Number.isFinite(next.delayMinutes) &&
      next.delayMinutes >= 0 &&
      (next.app === undefined || next.app === null || typeof next.app === 'string')
    )
  }
  if (condition.type === 'time_based') {
    const next = value as { afterHours?: unknown }
    return (
      typeof next.afterHours === 'number' &&
      Number.isFinite(next.afterHours) &&
      next.afterHours >= 0 &&
      next.afterHours <= 23
    )
  }
  return false
}

function isAction(value: unknown): value is RuleAction {
  if (typeof value !== 'object' || value === null) return false
  const action = value as Partial<RuleAction> & { type?: unknown }
  if (action.type === 'block_category') {
    return typeof (value as { category?: unknown }).category === 'string'
  }
  if (action.type === 'increase_difficulty') {
    const next = value as { level?: unknown }
    return typeof next.level === 'number' && Number.isInteger(next.level) && next.level >= 1 && next.level <= 5
  }
  if (action.type === 'block_everything' || action.type === 'notify_trusted_contact') {
    return true
  }
  if (action.type === 'extend_time_lock') {
    const next = value as { minutes?: unknown }
    return typeof next.minutes === 'number' && Number.isFinite(next.minutes) && next.minutes > 0
  }
  return false
}

export function isRule(value: unknown): value is Rule {
  if (typeof value !== 'object' || value === null) return false
  const rule = value as Partial<Rule>
  return (
    typeof rule.id === 'number' &&
    Number.isInteger(rule.id) &&
    typeof rule.name === 'string' &&
    rule.name.trim() !== '' &&
    isCondition(rule.condition) &&
    isAction(rule.action) &&
    typeof rule.priority === 'number' &&
    Number.isFinite(rule.priority) &&
    typeof rule.enabled === 'boolean'
  )
}

/**
 * Stricter variant used by the mutating functions: throws instead of filtering.
 * Sequence rules make extra demands (`app-launch` requires an app name).
 */
function assertValidRuleInput(next: RuleInput): void {
  if (typeof next.name !== 'string' || next.name.trim() === '') {
    throw new Error('Rule "name" must be a non-empty string.')
  }
  if (typeof next.enabled !== 'boolean') {
    throw new Error('Rule "enabled" must be a boolean.')
  }
  if (next.priority !== undefined && (typeof next.priority !== 'number' || !Number.isFinite(next.priority) || next.priority < 0)) {
    throw new Error('Rule "priority" must be a non-negative number.')
  }
  if (!isCondition(next.condition)) {
    throw new Error('Rule has an invalid condition.')
  }
  if (next.condition.type === 'sequence' && next.condition.trigger === 'app-launch') {
    if (typeof next.condition.app !== 'string' || next.condition.app.trim() === '') {
      throw new Error('A "sequence" rule with trigger "app-launch" requires a non-empty "app".')
    }
  }
  if (next.condition.type === 'sequence' && next.condition.trigger === 'session-start' && next.condition.app != null) {
    throw new Error('A "sequence" rule with trigger "session-start" must not set "app".')
  }
  if (!isAction(next.action)) {
    throw new Error('Rule has an invalid action.')
  }
}

/** Coerces optional sequence fields to their persisted shape. */
function normalizeRuleInput(next: RuleInput): RuleInput {
  if (next.condition.type !== 'sequence') {
    return next
  }
  return { ...next, condition: { ...next.condition, app: next.condition.app ?? null } }
}

// --- Persistence -------------------------------------------------------------

/** Loads all rules (valid entries only) sorted by priority. Empty file/missing => []. */
export async function loadRules(options: { baseDir?: string } = {}): Promise<Rule[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(rulesFilePath(options.baseDir), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isRule).sort((a, b) => a.priority - b.priority) : []
  } catch {
    return []
  }
}

/** Persists rules (sorted by priority) to `focus-rules.json`. */
export async function saveRules(rules: Rule[], options: { baseDir?: string } = {}): Promise<void> {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority)
  await writeFile(rulesFilePath(options.baseDir), JSON.stringify(sorted, null, 2), 'utf8')
}

export function nextRuleId(rules: Rule[]): number {
  return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1
}

function requireToken(token: string, expectedAction: 'add_rule' | 'remove_rule' | 'update_rule'): void {
  verifyTokenForAction(token, expectedAction)
}

/** Adds a rule. Assigns the next id; `priority` defaults to after the last rule. */
export async function addRule(
  next: RuleInput,
  token: string,
  options: { baseDir?: string } = {},
): Promise<Rule> {
  requireToken(token, 'add_rule')
  assertValidRuleInput(next)

  const baseDir = resolveBaseDir(options.baseDir)
  const existing = await loadRules({ baseDir })
  const normalized = normalizeRuleInput(next)
  const priority = normalized.priority ?? existing.length + 1
  const rule: Rule = { id: nextRuleId(existing), ...normalized, priority }

  await saveRules([...existing, rule], { baseDir })
  auditLog('add_rule', true, { id: rule.id, name: rule.name, priority })

  return rule
}

/** Removes a rule by id. Throws if the id does not exist. */
export async function removeRule(
  id: number,
  token: string,
  options: { baseDir?: string } = {},
): Promise<void> {
  requireToken(token, 'remove_rule')

  const baseDir = resolveBaseDir(options.baseDir)
  const existing = await loadRules({ baseDir })
  const remaining = existing.filter((rule) => rule.id !== id)
  if (remaining.length === existing.length) {
    throw new Error(`Rule not found: id ${id}.`)
  }

  await saveRules(remaining, { baseDir })
  auditLog('remove_rule', true, { id })
}

/** Updates a rule by id (keeps its id; `priority`/other omitted fields stay). */
export async function updateRule(
  id: number,
  next: RuleInput,
  token: string,
  options: { baseDir?: string } = {},
): Promise<Rule> {
  requireToken(token, 'update_rule')
  assertValidRuleInput(next)

  const baseDir = resolveBaseDir(options.baseDir)
  const existing = await loadRules({ baseDir })
  const index = existing.findIndex((rule) => rule.id === id)
  if (index === -1) {
    throw new Error(`Rule not found: id ${id}.`)
  }

  const current = existing[index]!
  const normalized = normalizeRuleInput(next)
  const merged: Rule = { ...current, ...normalized, id }
  merged.priority = normalized.priority ?? current.priority

  existing[index] = merged
  await saveRules(existing, { baseDir })
  auditLog('update_rule', true, { id, name: merged.name })

  return merged
}

// --- Context --------------------------------------------------------------

/** Wires the live context source. Pass null to clear (tests). */
export function setRuleContextProvider(provider: RuleContextProvider | null): void {
  contextProvider = provider
}

// --- Matching ---------------------------------------------------------------

export function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(':')
  return Number(hour) * 60 + Number(minute)
}

/** True when `now` falls inside a `schedule` window (overnight windows wrap). */
export function matchesSchedule(
  condition: Extract<RuleCondition, { type: 'schedule' }>,
  now: Date,
): boolean {
  if (!condition.days.includes(now.getDay() as Weekday)) {
    return false
  }
  const from = timeToMinutes(condition.from)
  const to = timeToMinutes(condition.to)
  const current = now.getHours() * 60 + now.getMinutes()
  if (from === to) {
    return false
  }
  if (from < to) {
    return current >= from && current < to
  }
  return current >= from || current < to
}

export function matchesNetwork(
  condition: Extract<RuleCondition, { type: 'network' }>,
  network: RuleContext['network'],
): boolean {
  return network.ssid === condition.ssid
}

export function matchesSequence(
  condition: Extract<RuleCondition, { type: 'sequence' }>,
  context: RuleContext,
): boolean {
  const elapsedMinutes = Math.floor(Math.max(0, context.now.getTime() - context.session_start.getTime()) / 60_000)
  if (elapsedMinutes < condition.delayMinutes) {
    return false
  }
  if (condition.trigger === 'session-start') {
    return true
  }
  return context.active_app !== null && context.active_app === condition.app
}

export function matchesTimeBased(
  condition: Extract<RuleCondition, { type: 'time_based' }>,
  now: Date,
): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  return currentMinutes >= condition.afterHours * 60
}

/** True when the rule's condition matches the given context. */
export function matchesRule(rule: Rule, context: RuleContext): boolean {
  switch (rule.condition.type) {
    case 'schedule':
      return matchesSchedule(rule.condition, context.now)
    case 'network':
      return matchesNetwork(rule.condition, context.network)
    case 'sequence':
      return matchesSequence(rule.condition, context)
    case 'time_based':
      return matchesTimeBased(rule.condition, context.now)
  }
}

// --- Evaluation --------------------------------------------------------------

function auditTransition(
  action: 'rule:activated' | 'rule:deactivated',
  active: { ruleId: number; ruleName: string; action: RuleAction },
): void {
  auditLog(action, true, {
    ruleId: active.ruleId,
    ruleName: active.ruleName,
    action: active.action,
  })
}

/**
 * Evaluates every enabled rule against the current context (or the injected
 * {@link RuleContextProvider}) and returns the active actions in priority
 * order. Logs each activation/deactivation as a transition to the audit log
 * and forwards the resulting set to the configured {@link RuleEffects}.
 */
export async function evaluateRules(
  context?: RuleContext,
  options: { baseDir?: string } = {},
): Promise<ActiveAction[]> {
  const ctx = context ?? (contextProvider === null ? null : await contextProvider())
  if (ctx === null) {
    throw new Error('Rule context provider is not configured.')
  }

  const candidates = (await loadRules(options))
    .filter((rule) => rule.enabled)
    .sort((a, b) => a.priority - b.priority)

  const next = new Map<number, ActiveAction>()
  for (const rule of candidates) {
    if (matchesRule(rule, ctx)) {
      next.set(rule.id, {
        ruleId: rule.id,
        ruleName: rule.name,
        priority: rule.priority,
        action: rule.action,
      })
    }
  }

  for (const [id, active] of next) {
    if (!lastActiveActions.has(id)) {
      auditTransition('rule:activated', active)
    }
  }
  for (const [id, active] of lastActiveActions) {
    if (!next.has(id)) {
      auditTransition('rule:deactivated', active)
    }
  }
  lastActiveActions = next

  const active = [...next.values()]
  if (effects !== null) {
    try {
      await effects.onActiveActionsChanged(active)
    } catch (err) {
      console.error('[rules] effects callback failed:', err)
    }
  }
  return active
}

// --- 30-second loop ----------------------------------------------------------

let engineTimer: ReturnType<typeof setInterval> | null = null

/** Starts the periodic evaluation loop (default: every 30 seconds). */
export function startRulesEngine(options: { intervalMs?: number } = {}): void {
  stopRulesEngine()
  engineTimer = setInterval(() => {
    evaluateRules().catch((err) => console.error('[rules] evaluation failed:', err))
  }, options.intervalMs ?? RULE_EVALUATION_MS)
}

export function stopRulesEngine(): void {
  if (engineTimer !== null) {
    clearInterval(engineTimer)
    engineTimer = null
  }
}

/** Clears loop, provider, effects and transition state (used by tests). */
export function resetRulesEngineState(): void {
  stopRulesEngine()
  contextProvider = null
  effects = null
  lastActiveActions = new Map()
}

/** Wires the side effects that apply the active actions. Pass null to clear. */
export function setRulesEffects(value: RuleEffects | null): void {
  effects = value
}