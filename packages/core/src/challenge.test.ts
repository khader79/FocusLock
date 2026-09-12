import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_CONFIG,
  diffIndex,
  generateChallenge,
  isComplete,
  progress,
  type Challenge,
  type Difficulty,
} from './challenge'
import { getRandomWord, getRandomWords, WORDS } from './words'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('WORDS', () => {
  it('contains exactly 2048 BIP39 words', () => {
    expect(WORDS.length).toBe(2048)
  })

  it('contains only unique words', () => {
    expect(new Set(WORDS).size).toBe(WORDS.length)
  })

  it('contains only non-empty lowercase words', () => {
    for (const word of WORDS) {
      expect(word).toMatch(/^[a-z]+$/)
    }
  })

  it('contains only words with at least 3 characters', () => {
    for (const word of WORDS) {
      expect(word.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('starts with "abandon" and ends with "zoo"', () => {
    expect(WORDS[0]).toBe('abandon')
    expect(WORDS[WORDS.length - 1]).toBe('zoo')
  })
})

describe('getRandomWord', () => {
  it('always returns a word from WORDS', () => {
    const wordSet = new Set(WORDS)
    for (let i = 0; i < 200; i++) {
      expect(wordSet.has(getRandomWord())).toBe(true)
    }
  })

  it('returns a non-empty string', () => {
    for (let i = 0; i < 50; i++) {
      expect(getRandomWord()).toBeTruthy()
    }
  })
})

describe('getRandomWords', () => {
  it('returns an array of the requested length', () => {
    expect(getRandomWords(0)).toEqual([])
    expect(getRandomWords(1)).toHaveLength(1)
    expect(getRandomWords(12)).toHaveLength(12)
    expect(getRandomWords(100)).toHaveLength(100)
  })

  it('returns only words from WORDS', () => {
    const wordSet = new Set(WORDS)
    for (const word of getRandomWords(100)) {
      expect(wordSet.has(word)).toBe(true)
    }
  })

  it('throws a RangeError for negative counts', () => {
    expect(() => getRandomWords(-1)).toThrow(RangeError)
  })

  it('uses words from each getRandomWord call', () => {
    const words = getRandomWords(50)
    for (const word of words) {
      expect(WORDS).toContain(word)
    }
  })
})

describe('generateChallenge', () => {
  const difficulties: Difficulty[] = [1, 2, 3, 4, 5]

  it('throws a RangeError for invalid difficulties', () => {
    for (const difficulty of [0, 6, -1, 2.5]) {
      expect(() => (generateChallenge as (d: number) => Challenge)(difficulty)).toThrow(RangeError)
    }
  })

  it.each(difficulties)(
    'generates a challenge with a valid shape for difficulty %i',
    (difficulty) => {
      const challenge = generateChallenge(difficulty)

      expect(challenge.difficulty).toBe(difficulty)
      expect(challenge.id).toMatch(UUID_PATTERN)
      expect(challenge.createdAt).toBeInstanceOf(Date)
      expect(challenge.expiresAt).toBeInstanceOf(Date)
      expect(challenge.expiresAt.getTime()).toBeGreaterThan(challenge.createdAt.getTime())
      expect(challenge.text.split(' ').length).toBe(challenge.wordCount)
    },
  )

  it.each(difficulties)('keeps wordCount within the bounds for difficulty %i', (difficulty) => {
    const { minWords, maxWords } = DIFFICULTY_CONFIG[difficulty]
    for (let i = 0; i < 10; i++) {
      const challenge = generateChallenge(difficulty)
      expect(challenge.wordCount).toBeGreaterThanOrEqual(minWords)
      expect(challenge.wordCount).toBeLessThanOrEqual(maxWords)
    }
  })

  it.each(difficulties)('uses only BIP39 words for difficulty %i', (difficulty) => {
    const wordSet = new Set(WORDS)
    const challenge = generateChallenge(difficulty)
    for (const word of challenge.text.split(' ')) {
      expect(wordSet.has(word)).toBe(true)
    }
  })

  it.each(difficulties)(
    'sets expiresAt to the configured duration for difficulty %i',
    (difficulty) => {
      const { minutes } = DIFFICULTY_CONFIG[difficulty]
      const challenge = generateChallenge(difficulty)
      const durationMs = challenge.expiresAt.getTime() - challenge.createdAt.getTime()
      expect(durationMs).toBe(minutes * 60 * 1000)
    },
  )

  it('generates unique challenge ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateChallenge(1).id))
    expect(ids.size).toBe(50)
  })

  it('generates unique texts across runs', () => {
    const texts = new Set(Array.from({ length: 50 }, () => generateChallenge(1).text))
    expect(texts.size).toBe(50)
  })
})

describe('diffIndex', () => {
  it('returns -1 when both strings are identical', () => {
    expect(diffIndex('typing test', 'typing test')).toBe(-1)
  })

  it('returns -1 when both strings are empty', () => {
    expect(diffIndex('', '')).toBe(-1)
  })

  it('returns 0 when the first character differs', () => {
    expect(diffIndex('abc', 'xbc')).toBe(0)
  })

  it('returns the index of the first mismatching character', () => {
    expect(diffIndex('abxdef', 'abcdef')).toBe(2)
  })

  it('returns typed.length when typed is a shorter matching prefix', () => {
    expect(diffIndex('abc', 'abcdef')).toBe(3)
  })

  it('returns target.length when typed has trailing extra characters', () => {
    expect(diffIndex('abcdef', 'abc')).toBe(3)
  })

  it('returns 0 when typed is empty and target is not', () => {
    expect(diffIndex('', 'abc')).toBe(0)
  })

  it('returns 0 when target is empty and typed is not', () => {
    expect(diffIndex('abc', '')).toBe(0)
  })
})

describe('isComplete', () => {
  it('returns true for identical strings', () => {
    expect(isComplete('abc', 'abc')).toBe(true)
  })

  it('returns true when both are empty', () => {
    expect(isComplete('', '')).toBe(true)
  })

  it('returns false when a character differs', () => {
    expect(isComplete('abx', 'abc')).toBe(false)
  })

  it('returns false when case differs', () => {
    expect(isComplete('ABC', 'abc')).toBe(false)
  })

  it('returns false when typed is longer', () => {
    expect(isComplete('abcd', 'abc')).toBe(false)
  })

  it('returns false when typed is shorter', () => {
    expect(isComplete('ab', 'abc')).toBe(false)
  })
})

describe('progress', () => {
  it('returns 1 for an exact match', () => {
    expect(progress('abcdef', 'abcdef')).toBe(1)
  })

  it('returns 1 for an empty target', () => {
    expect(progress('anything', '')).toBe(1)
  })

  it('returns 0 when nothing has been typed', () => {
    expect(progress('', 'abcdef')).toBe(0)
  })

  it('returns 0 when the first character is wrong', () => {
    expect(progress('wxyz', 'abcd')).toBe(0)
  })

  it('returns the share of the correct prefix', () => {
    expect(progress('ab', 'abcd')).toBe(0.5)
    expect(progress('abc', 'abcd')).toBe(0.75)
  })

  it('uses the correct prefix length even on non-integer ratios', () => {
    expect(progress('ab', 'abc')).toBeCloseTo(2 / 3)
  })

  it('never exceeds 1 when trailing characters are extra', () => {
    expect(progress('abcdefgh', 'abcdef')).toBe(1)
  })
})
