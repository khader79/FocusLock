import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAuditLogBaseDir } from './audit-log'
import { signChallengeToken } from './challenge-token'
import {
  addRule,
  evaluateRules,
  loadRules,
  matchesNetwork,
  matchesRule,
  matchesSchedule,
  matchesSequence,
  matchesTimeBased,
  nextRuleId,
  removeRule,
  resetRulesBaseDir,
  resetRulesEngineState,
  rulesFilePath,
  saveRules,
  setRuleContextProvider,
  setRulesBaseDir,
  setRulesEffects,
  startRulesEngine,
  stopRulesEngine,
  updateRule,
  type ActiveAction,
  type Rule,
  type RuleCondition,
  type RuleContext,
  type RuleInput,
} from './rules'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'focuslock-rules-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

type AuditEntry = Record<string, unknown>

async function readAudit(baseDir: string): Promise<AuditEntry[]> {
  const text = await readFile(join(baseDir, 'audit.log'), 'utf8')
  return text
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as AuditEntry)
}

function ruleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    name: 'Test rule',
    condition: { type: 'schedule', days: [0, 1, 2, 3, 4], from: '09:00', to: '17:00' },
    action: { type: 'block_category', category: 'ads' },
    enabled: true,
    ...overrides,
  }
}

/** Context verifying "Monday 10:00" semantics by default. */
function context(overrides: Partial<RuleContext> = {}): RuleContext {
  const now = new Date(2024, 0, 8, 10, 0, 0) // Monday, 10:00 local
  return {
    now,
    network: { ssid: 'home', type: 'wifi' },
    active_app: null,
    session_start: now,
    ...overrides,
  }
}

async function readRulesFile(baseDir: string): Promise<Rule[]> {
  return JSON.parse(await readFile(join(baseDir, 'focus-rules.json'), 'utf8')) as Rule[]
}

describe('persistence', () => {
  let baseDir = ''

  beforeEach(async () => {
    baseDir = await tempDir()
    setRulesBaseDir(baseDir)
  })

  afterEach(() => {
    resetRulesBaseDir()
  })

  it('returns [] for a missing rules file', async () => {
    expect(await loadRules()).toEqual([])
  })

  it('round-trips rules through saveRules/loadRules sorted by priority', async () => {
    await saveRules([
      { id: 2, name: 'low', condition: { type: 'network', ssid: 'x' }, action: { type: 'block_everything' }, priority: 9, enabled: true },
      { id: 1, name: 'high', condition: { type: 'network', ssid: 'x' }, action: { type: 'block_everything' }, priority: 2, enabled: true },
    ])

    const loaded = await loadRules()
    expect(loaded.map((rule) => rule.priority)).toEqual([2, 9])
  })

  it('filters malformed entries on load', async () => {
    await writeFile(
      join(baseDir, 'focus-rules.json'),
      JSON.stringify([
        { id: 1, name: 'ok', condition: { type: 'time_based', afterHours: 18 }, action: { type: 'block_everything' }, priority: 1, enabled: true },
        { id: 'nope', name: '', condition: { type: 'bogus' }, action: { type: 'nope' }, priority: 'x', enabled: true },
        { id: 3, name: 'bad action', condition: { type: 'schedule', days: [99], from: 'nope', to: '02:00' }, action: { type: 'increase_difficulty', level: 9 }, priority: 3, enabled: true },
      ]),
      'utf8',
    )

    expect(await loadRules()).toHaveLength(1)
  })

  it('resolves the rules file path inside the base dir', () => {
    expect(rulesFilePath()).toBe(join(baseDir, 'focus-rules.json'))
  })

  it('computes the next id past the largest existing id', () => {
    expect(nextRuleId([])).toBe(1)
    expect(nextRuleId([{ id: 3 } as Rule, { id: 7 } as Rule])).toBe(8)
  })
})

describe('condition matching', () => {
  type ScheduleCondition = Extract<RuleCondition, { type: 'schedule' }>

  it('schedule matches only on configured days', () => {
    const condition: ScheduleCondition = { type: 'schedule', days: [1, 2], from: '09:00', to: '17:00' }
    expect(matchesSchedule(condition, new Date(2024, 0, 8, 10, 0))) // Monday
      .toBe(true)
    expect(matchesSchedule(condition, new Date(2024, 0, 9, 10, 0))) // Tuesday
      .toBe(true)
    expect(matchesSchedule(condition, new Date(2024, 0, 10, 10, 0))) // Wednesday
      .toBe(false)
  })

  it('schedule respects from/to boundaries (start inclusive, end exclusive)', () => {
    const condition: ScheduleCondition = { type: 'schedule', days: [1], from: '09:00', to: '17:00' }
    expect(matchesSchedule(condition, new Date(2024, 0, 8, 9, 0))).toBe(true)
    expect(matchesSchedule(condition, new Date(2024, 0, 8, 16, 59))).toBe(true)
    expect(matchesSchedule(condition, new Date(2024, 0, 8, 17, 0))).toBe(false)
    expect(matchesSchedule(condition, new Date(2024, 0, 8, 8, 59))).toBe(false)
  })

  it('schedule wraps overnight windows', () => {
    const condition: ScheduleCondition = { type: 'schedule', days: [1, 2], from: '22:00', to: '06:00' }
    expect(matchesSchedule(condition, new Date(2024, 0, 8, 23, 0))).toBe(true) // Mon 23:00
    expect(matchesSchedule(condition, new Date(2024, 0, 9, 5, 0))).toBe(true) // Tue 05:00
    expect(matchesSchedule(condition, new Date(2024, 0, 9, 12, 0))).toBe(false) // Tue noon
  })

  it('schedule with from === to matches nothing', () => {
    const condition: ScheduleCondition = { type: 'schedule', days: [1], from: '12:00', to: '12:00' }
    expect(matchesSchedule(condition, new Date(2024, 0, 8, 12, 0))).toBe(false)
  })

  it('network matches on exact SSID', () => {
    expect(matchesNetwork({ type: 'network', ssid: 'home' }, { ssid: 'home', type: 'wifi' })).toBe(true)
    expect(matchesNetwork({ type: 'network', ssid: 'home' }, { ssid: 'office', type: 'wifi' })).toBe(false)
  })

  it('sequence "session-start" fires after the delay from session start', () => {
    const condition = { type: 'sequence' as const, trigger: 'session-start' as const, app: null, delayMinutes: 30 }
    const started = new Date(2024, 0, 8, 10, 0, 0)
    expect(matchesSequence(condition, context({ session_start: started, now: new Date(2024, 0, 8, 10, 29) }))).toBe(false)
    expect(matchesSequence(condition, context({ session_start: started, now: new Date(2024, 0, 8, 10, 30) }))).toBe(true)
    expect(matchesSequence(condition, context({ session_start: started, now: new Date(2024, 0, 8, 10, 45) }))).toBe(true)
  })

  it('sequence "app-launch" needs the specific app in the foreground', () => {
    const condition = { type: 'sequence' as const, trigger: 'app-launch' as const, app: 'Slack', delayMinutes: 15 }
    const started = new Date(2024, 0, 8, 10, 0, 0)
    const base = context({ session_start: started, now: new Date(2024, 0, 8, 10, 20) })
    expect(matchesSequence(condition, { ...base, active_app: 'Slack' })).toBe(true)
    expect(matchesSequence(condition, { ...base, active_app: 'VS Code' })).toBe(false)
    expect(matchesSequence(condition, { ...base, active_app: null })).toBe(false)
  })

  it('time_based matches from afterHours onward', () => {
    const condition = { type: 'time_based' as const, afterHours: 18 }
    expect(matchesTimeBased(condition, new Date(2024, 0, 8, 17, 59))).toBe(false)
    expect(matchesTimeBased(condition, new Date(2024, 0, 8, 18, 0))).toBe(true)
    expect(matchesTimeBased(condition, new Date(2024, 0, 8, 23, 30))).toBe(true)
  })

  it('matchesRule dispatches to the correct condition helper', () => {
    const matching = { ...ruleInput(), id: 1, priority: 1 }
    expect(matchesRule(matching, context())).toBe(true)

    const offNetwork = { ...ruleInput({ condition: { type: 'network', ssid: 'office' } }), id: 1, priority: 1 }
    expect(matchesRule(offNetwork, context())).toBe(false)
  })
})

describe('mutations', () => {
  let baseDir = ''
  let token = ''

  beforeEach(async () => {
    resetRulesEngineState()
    baseDir = await tempDir()
    setRulesBaseDir(baseDir)
    setAuditLogBaseDir(baseDir)
  })

  afterEach(async () => {
    resetRulesEngineState()
    resetRulesBaseDir()
    setAuditLogBaseDir(null)
  })

  it('adds rules with sequential ids and default priorities', async () => {
    token = signChallengeToken('add_rule')
    const first = await addRule(ruleInput(), token)
    const second = await addRule(ruleInput({ name: 'Second' }), token)

    expect(first.id).toBe(1)
    expect(first.priority).toBe(1)
    expect(second.id).toBe(2)
    expect(second.priority).toBe(2)
    expect(await loadRules()).toHaveLength(2)
  })

  it('honors an explicit priority on add', async () => {
    token = signChallengeToken('add_rule')
    await addRule(ruleInput({ name: 'first' }), token)
    const second = await addRule(ruleInput({ name: 'second', priority: 0 }), token)
    expect(second.priority).toBe(0)
    const loaded = await loadRules()
    expect(loaded.map((rule) => rule.priority)).toEqual([0, 1])
    expect(loaded[0]!.name).toBe('second')
  })

  it('persists and audits addRule', async () => {
    token = signChallengeToken('add_rule')
    const rule = await addRule(ruleInput(), token)

    expect((await readRulesFile(baseDir)).map((entry) => entry.id)).toContain(rule.id)
    const audit = await readAudit(baseDir)
    expect(audit.some((entry) => entry.action === 'add_rule' && entry.ok === true)).toBe(true)
  })

  it('rejects mutation with a missing or mismatched token', async () => {
    await expect(addRule(ruleInput(), 'not-a-token')).rejects.toThrow('challenge token')
    token = signChallengeToken('remove_rule')
    await expect(addRule(ruleInput(), token)).rejects.toThrow(
      'minted for "remove_rule" but used for "add_rule"',
    )
    expect(await loadRules()).toEqual([])
  })

  it('rejects invalid rule input without persisting anything', async () => {
    token = signChallengeToken('add_rule')
    await expect(addRule(ruleInput({ name: ' ' }), token)).rejects.toThrow('name')
    await expect(
      addRule(ruleInput({ condition: { type: 'sequence', trigger: 'app-launch', app: null, delayMinutes: 5 } }), token),
    ).rejects.toThrow('app')
    await expect(
      addRule(ruleInput({ condition: { type: 'time_based', afterHours: 24 } }), token),
    ).rejects.toThrow('invalid condition')
    expect(await loadRules()).toEqual([])
  })

  it('normalizes sequence app to null on save', async () => {
    token = signChallengeToken('add_rule')
    const rule = await addRule(
      ruleInput({
        condition: { type: 'sequence', trigger: 'session-start', app: undefined, delayMinutes: 10 },
        action: { type: 'extend_time_lock', minutes: 15 },
      }),
      token,
    )
    expect((rule.condition as { app: unknown }).app).toBe(null)
    expect((await loadRules())[0]).toEqual(expect.objectContaining(rule))
  })

  it('removes a rule by id', async () => {
    token = signChallengeToken('add_rule')
    const rule = await addRule(ruleInput(), token)
    await removeRule(rule.id, signChallengeToken('remove_rule'))

    expect(await loadRules()).toEqual([])
    const audit = await readAudit(baseDir)
    expect(audit.some((entry) => entry.action === 'remove_rule')).toBe(true)
  })

  it('throws when removing an unknown id', async () => {
    await expect(removeRule(42, signChallengeToken('remove_rule'))).rejects.toThrow('Rule not found')
  })

  it('updates a rule preserving id and omitted priority', async () => {
    token = signChallengeToken('add_rule')
    const rule = await addRule(ruleInput(), token)
    const updated = await updateRule(
      rule.id,
      ruleInput({ name: 'Renamed', action: { type: 'block_everything' } }),
      signChallengeToken('update_rule'),
    )

    expect(updated.id).toBe(rule.id)
    expect(updated.name).toBe('Renamed')
    expect(updated.priority).toBe(rule.priority)
    expect(updated.action).toEqual({ type: 'block_everything' })
    expect(await loadRules()).toHaveLength(1)
    const audit = await readAudit(baseDir)
    expect(audit.some((entry) => entry.action === 'update_rule')).toBe(true)
  })

  it('throws when updating an unknown id', async () => {
    await expect(
      updateRule(9, ruleInput(), signChallengeToken('update_rule')),
    ).rejects.toThrow('Rule not found')
  })
})

describe('evaluation', () => {
  let baseDir = ''

  beforeEach(async () => {
    resetRulesEngineState()
    baseDir = await tempDir()
    setRulesBaseDir(baseDir)
    setAuditLogBaseDir(baseDir)
    await addRule(
      ruleInput({ name: 'morning', priority: 1, action: { type: 'block_everything' } }),
      signChallengeToken('add_rule'),
    )
    await addRule(
      ruleInput({ name: 'afternoon', priority: 2, action: { type: 'extend_time_lock', minutes: 30 } }),
      signChallengeToken('add_rule'),
    )
  })

  afterEach(async () => {
    resetRulesEngineState()
    resetRulesBaseDir()
    setAuditLogBaseDir(null)
  })

  it('returns matching rules in priority order', async () => {
    const active = await evaluateRules(context())

    expect(active.map((entry) => entry.ruleName)).toEqual(['morning', 'afternoon'])
    expect(active).toMatchObject<Partial<ActiveAction>[]>([
      { ruleId: 1, action: { type: 'block_everything' } },
      { ruleId: 2, action: { type: 'extend_time_lock', minutes: 30 } },
    ])
  })

  it('excludes disabled rules', async () => {
    await updateRule(2, ruleInput({ name: 'afternoon', priority: 2, enabled: false }), signChallengeToken('update_rule'))
    const active = await evaluateRules(context())
    expect(active.map((entry) => entry.ruleName)).toEqual(['morning'])
  })

  it('uses the injected context provider when context is omitted', async () => {
    setRuleContextProvider(() => context())
    const active = await evaluateRules()
    expect(active).toHaveLength(2)
  })

  it('throws when neither a context nor a provider is available', async () => {
    await expect(evaluateRules()).rejects.toThrow('context provider')
  })

  it('logs activation/deactivation transitions to audit', async () => {
    await evaluateRules(context()) // both activate
    let audit = await readAudit(baseDir)
    expect(audit.filter((entry) => entry.action === 'rule:activated')).toHaveLength(2)

    await evaluateRules(context()) // no change -> no extra entries
    expect(await readAudit(baseDir)).toHaveLength(audit.length)

    // Evening context: both rules stop matching.
    const evening = context({ now: new Date(2024, 0, 8, 20, 0, 0) })
    await evaluateRules(evening)
    audit = await readAudit(baseDir)
    expect(audit.filter((entry) => entry.action === 'rule:deactivated')).toHaveLength(2)
  })

  it('re-activates a rule after it was deactivated', async () => {
    const morning = context({ now: new Date(2024, 0, 8, 20, 0, 0) })
    await evaluateRules(morning) // none active
    await evaluateRules(context()) // both activate
    const audit = await readAudit(baseDir)
    expect(audit.filter((entry) => entry.action === 'rule:activated')).toHaveLength(2)
  })

it('forwards the active set to the wired effects', async () => {
    const onActiveActionsChanged = vi.fn()
    setRulesEffects({ onActiveActionsChanged })

    await evaluateRules(context())
    expect(onActiveActionsChanged).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 1, ruleName: 'morning' }),
        expect.objectContaining({ ruleId: 2, ruleName: 'afternoon' }),
      ]),
    )

    await evaluateRules(context({ now: new Date(2024, 0, 8, 20, 0, 0) }))
    expect(onActiveActionsChanged).toHaveBeenLastCalledWith([])
  })
})

describe('engine loop', () => {
  let baseDir = ''

  beforeEach(async () => {
    resetRulesEngineState()
    baseDir = await tempDir()
    setRulesBaseDir(baseDir)
    setAuditLogBaseDir(baseDir)
  })

  afterEach(async () => {
    stopRulesEngine()
    resetRulesEngineState()
    resetRulesBaseDir()
    setAuditLogBaseDir(null)
  })

  it('evaluates on the configured interval', async () => {
    await addRule(
      ruleInput({ name: 'loop', condition: { type: 'time_based', afterHours: 0 }, action: { type: 'block_everything' } }),
      signChallengeToken('add_rule'),
    )
    setRuleContextProvider(() => context())
    const onActiveActionsChanged = vi.fn()
    setRulesEffects({ onActiveActionsChanged })

    startRulesEngine({ intervalMs: 30 })
    try {
      await new Promise((resolve) => setTimeout(resolve, 120))
    } finally {
      stopRulesEngine()
    }

    expect(onActiveActionsChanged).toHaveBeenCalled()
    const activeSets = onActiveActionsChanged.mock.calls.map((call) => call[0] as ActiveAction[])
    expect(activeSets.every((set) => set.length === 1)).toBe(true)
    expect(activeSets.length).toBeGreaterThanOrEqual(2)
  })
})