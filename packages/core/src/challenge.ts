import { randomInt, randomUUID } from 'node:crypto'
import { WORDS } from './words.js'

export type Difficulty = 1 | 2 | 3 | 4 | 5

export interface Challenge {
  id: string
  text: string
  wordCount: number
  createdAt: Date
  expiresAt: Date
  difficulty: Difficulty
}

const SECONDS_PER_MINUTE = 60
const MILLISECONDS_PER_SECOND = 1000

interface DifficultyConfig {
  minWords: number
  maxWords: number
  minutes: number
}

export const DIFFICULTY_CONFIG: Readonly<Record<Difficulty, DifficultyConfig>> = {
  1: { minWords: 30, maxWords: 60, minutes: 5 },
  2: { minWords: 60, maxWords: 120, minutes: 10 },
  3: { minWords: 120, maxWords: 250, minutes: 20 },
  4: { minWords: 250, maxWords: 400, minutes: 30 },
  5: { minWords: 400, maxWords: 700, minutes: 60 },
}

export function generateChallenge(difficulty: Difficulty): Challenge {
  const config = DIFFICULTY_CONFIG[difficulty]
  if (config === undefined) {
    throw new RangeError(`Invalid difficulty: ${difficulty}. Expected a value between 1 and 5.`)
  }

  const wordCount = randomInt(config.minWords, config.maxWords + 1)

  const words: string[] = new Array(wordCount)
  for (let i = 0; i < wordCount; i++) {
    words[i] = WORDS[randomInt(WORDS.length)]!
  }

  const createdAt = new Date()
  const expiresAt = new Date(
    createdAt.getTime() + config.minutes * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
  )

  return {
    id: randomUUID(),
    text: words.join(' '),
    wordCount,
    createdAt,
    expiresAt,
    difficulty,
  }
}

export function diffIndex(typed: string, target: string): number {
  const maxLength = Math.min(typed.length, target.length)
  for (let i = 0; i < maxLength; i++) {
    if (typed[i] !== target[i]) return i
  }
  if (typed.length === target.length) return -1
  return typed.length > target.length ? target.length : typed.length
}

export function isComplete(typed: string, target: string): boolean {
  return typed === target
}

export function progress(typed: string, target: string): number {
  if (target.length === 0) return 1
  const firstError = diffIndex(typed, target)
  if (firstError === -1) return 1
  return firstError / target.length
}
