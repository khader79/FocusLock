import { describe, expect, it } from 'vitest'
import { TokenBucket } from './limiter'

function makeBucket(capacity: number, refillPerSecond = capacity): {
  bucket: TokenBucket
  advance: (ms: number) => void
} {
  let now = 0
  const bucket = new TokenBucket({ capacity, refillPerSecond, now: () => now })
  return { bucket, advance: (ms: number) => (now += ms) }
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity', () => {
    const { bucket } = makeBucket(3)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
  })

  it('refills over time at the configured rate', () => {
    const { bucket, advance } = makeBucket(3, 3)
    bucket.tryTake()
    bucket.tryTake()
    bucket.tryTake()
    expect(bucket.tryTake()).toBe(false)

    advance(1000)
    expect(bucket.tryTake()).toBe(true) // exactly 3 tokens refilled
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false) // only 3 per second
  })

  it('never exceeds capacity', () => {
    const { bucket, advance } = makeBucket(5, 5)
    advance(10_000) // 50 tokens would accrue if uncapped
    for (let i = 0; i < 5; i += 1) {
      expect(bucket.tryTake()).toBe(true)
    }
    expect(bucket.tryTake()).toBe(false)
  })

  it('supports taking more than one token when the bucket is empty', () => {
    const { bucket, advance } = makeBucket(4, 4)
    bucket.tryTake()
    bucket.tryTake()
    bucket.tryTake()
    expect(bucket.tryTake(2)).toBe(false)
    advance(1000)
    expect(bucket.tryTake(2)).toBe(true)
  })
})