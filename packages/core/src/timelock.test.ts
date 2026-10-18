import { describe, expect, it } from 'vitest'
import { combineShares, splitSecret } from './timelock'

function randomSecret(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  const results: T[][] = []
  const acc: T[] = []
  const walk = (start: number): void => {
    if (acc.length === size) {
      results.push([...acc])
      return
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]!)
      walk(i + 1)
      acc.pop()
    }
  }
  walk(0)
  return results
}

describe('splitSecret', () => {
  it('returns exactly n shares', () => {
    const shares = splitSecret(randomSecret(32), 5, 3)
    expect(shares).toHaveLength(5)
  })

  it('rejects invalid parameters', () => {
    const secret = randomSecret(8)
    expect(() => splitSecret(secret, 0, 3)).toThrow(RangeError)
    expect(() => splitSecret(secret, 256, 3)).toThrow(RangeError)
    expect(() => splitSecret(secret, 5, 6)).toThrow(RangeError)
    expect(() => splitSecret(secret, 5, 0)).toThrow(RangeError)
    expect(() => splitSecret(new Uint8Array(0), 5, 3)).toThrow(RangeError)
    expect(() => splitSecret(secret, 5.5, 3)).toThrow(RangeError)
  })
})

describe('splitSecret + combineShares (3-of-5)', () => {
  it('reconstructs the original secret from ANY 3 shares', () => {
    const secret = randomSecret(48)
    const shares = splitSecret(secret, 5, 3)

    for (const combo of combinations(shares, 3)) {
      expect(Buffer.from(combineShares(combo))).toEqual(Buffer.from(secret))
    }
  })

  it('reconstructs the original secret from 4 or 5 shares as well', () => {
    const secret = randomSecret(32)
    const shares = splitSecret(secret, 5, 3)

    for (const combo of combinations(shares, 4)) {
      expect(Buffer.from(combineShares(combo))).toEqual(Buffer.from(secret))
    }
    expect(Buffer.from(combineShares(shares))).toEqual(Buffer.from(secret))
  })

  it('cannot recover the secret from ANY 2 shares (below the threshold)', () => {
    const secret = randomSecret(32)
    const shares = splitSecret(secret, 5, 3)

    for (const combo of combinations(shares, 2)) {
      expect(() => combineShares(combo)).toThrow(/threshold/)
    }
  })

  it('rejects a corrupted share via AES-GCM authentication', () => {
    const secret = randomSecret(32)
    const shares = splitSecret(secret, 5, 3)

    const corrupted = shares.map((s) => Uint8Array.from(s))
    const payloadStart = 6 + 32
    corrupted[0]![payloadStart + 20]! ^= 0xff // flip a ciphertext byte

    expect(() => combineShares([corrupted[0]!, corrupted[1]!, corrupted[2]!])).toThrow()
  })

  it('rejects shares coming from different splits', () => {
    const secret = randomSecret(32)
    const a = splitSecret(secret, 5, 3)
    const b = splitSecret(secret, 5, 3)

    expect(() => combineShares([a[0]!, a[1]!, b[2]!])).toThrow()
  })

  it('rejects duplicate share indices', () => {
    const secret = randomSecret(32)
    const shares = splitSecret(secret, 5, 3)

    const duplicated = Uint8Array.from(shares[1]!)
    duplicated[3] = shares[0]![3]!
    expect(() => combineShares([shares[0]!, shares[1]!, duplicated])).toThrow(/duplicate/i)
  })
})

describe('other thresholds', () => {
  it('round-trips a 2-of-3 split', () => {
    const secret = randomSecret(16)
    const shares = splitSecret(secret, 3, 2)

    expect(Buffer.from(combineShares([shares[0]!, shares[2]!]))).toEqual(Buffer.from(secret))
    expect(() => combineShares([shares[0]!])).toThrow(/threshold/)
  })

  it('round-trips a 5-of-5 split', () => {
    const secret = randomSecret(64)
    const shares = splitSecret(secret, 5, 5)

    expect(Buffer.from(combineShares(shares))).toEqual(Buffer.from(secret))
    for (const combo of combinations(shares, 4)) {
      expect(() => combineShares(combo)).toThrow(/threshold/)
    }
  })
})