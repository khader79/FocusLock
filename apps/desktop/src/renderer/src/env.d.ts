export interface FocusLockChallenge {
  id: string
  text: string
  wordCount: number
  createdAt: Date
  expiresAt: Date
  difficulty: number
}

export interface FocusLockGiveUpResult {
  ok: boolean
  idleWord: string
}

export interface FocusLockCheckResult {
  ok: boolean
  errorAt: number
  progress: number
}

export interface FocusLockCategory {
  id: string
  kind: 'preset' | 'custom'
  name: string
  name_en?: string
  icon: string
  color: string
  url: string
  expectedCount?: number
  enabled: boolean
  count?: number
  lastUpdatedAt?: string
  lastModified?: string
}

export interface FocusLockPatternSearchResult {
  total: number
  domains: string[]
}

export interface FocusLockAddCustomCategoryInput {
  name: string
  url: string
  color: string
}

export type FocusLockRuleCondition =
  | { type: 'schedule'; days: number[]; from: string; to: string }
  | { type: 'network'; ssid: string }
  | { type: 'sequence'; trigger: 'session-start' | 'app-launch'; app?: string | null; delayMinutes: number }
  | { type: 'time_based'; afterHours: number }

export type FocusLockRuleAction =
  | { type: 'block_category'; category: string }
  | { type: 'increase_difficulty'; level: number }
  | { type: 'block_everything' }
  | { type: 'notify_trusted_contact' }
  | { type: 'extend_time_lock'; minutes: number }

export interface FocusLockRule {
  id: number
  name: string
  condition: FocusLockRuleCondition
  action: FocusLockRuleAction
  priority: number
  enabled: boolean
}

/** Rule payload sent to `rulesAdd`/`rulesUpdate`; id is assigned by main. */
export type FocusLockRuleInput = Omit<FocusLockRule, 'id' | 'priority'> & { priority?: number }

export interface FocusLockSite {
  id: number
  domain: string
  variants: string[]
  addedAt: string
}

export interface FocusLockImportEntry { domain: string; category?: string; source?: string }
export interface FocusLockImportPreview { entries: FocusLockImportEntry[]; warnings: string[]; validation: { valid: FocusLockImportEntry[]; duplicates: string[]; invalid: Array<{ entry: FocusLockImportEntry; reason: string }> } }

export interface FocusLockApi {
  newChallenge(difficulty: number): Promise<FocusLockChallenge>
  check(typed: string): Promise<FocusLockCheckResult>
  giveup(): Promise<FocusLockGiveUpResult>
  getSilentMode(): Promise<boolean>
  toggleSilentMode(): Promise<boolean>
  categoriesList(): Promise<FocusLockCategory[]>
  toggleCategory(id: string): Promise<boolean>
  updateCategory(id: string): Promise<{ status: 'ok' | 'not-modified'; count?: number; bytes?: number; lastModified?: string }>
  searchCategoryPatterns(id: string, query: string): Promise<FocusLockPatternSearchResult>
  addCustomCategory(input: FocusLockAddCustomCategoryInput): Promise<FocusLockCategory>
  removeCustomCategory(id: string): Promise<boolean>
  rulesList(): Promise<FocusLockRule[]>
  rulesAdd(rule: FocusLockRuleInput): Promise<boolean>
  rulesRemove(id: number): Promise<boolean>
  rulesUpdate(id: number, rule: FocusLockRuleInput): Promise<boolean>
  listSites(): Promise<FocusLockSite[]>
  addSite(input: string): Promise<FocusLockSite>
  removeSite(id: number): Promise<void>
  listBlockedApps(): Promise<{ name: string; exePath: string; addedAt: string }[]>
  blockApp(exePath: string): Promise<void>
  unblockApp(name: string): Promise<void>
  onStateChange(callback: (data: unknown) => void): void
  chooseImportFile(): Promise<string | null>
  previewImport(request: unknown): Promise<FocusLockImportPreview>
  commitImport(entries: FocusLockImportEntry[]): Promise<{ added: number; duplicates: number; invalid: number; total: number } | null>
  chooseExportPath(format: string): Promise<string | null>
  createExport(request: unknown): Promise<boolean>
}

declare global {
  interface Window {
    api: FocusLockApi
  }
}

export {}
