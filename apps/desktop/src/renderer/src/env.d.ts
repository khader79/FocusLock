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

export interface FocusLockApi {
  newChallenge(difficulty: number): Promise<FocusLockChallenge>
  check(typed: string): Promise<FocusLockCheckResult>
  giveup(): Promise<FocusLockGiveUpResult>
}

declare global {
  interface Window {
    api: FocusLockApi
  }
}

export {}
