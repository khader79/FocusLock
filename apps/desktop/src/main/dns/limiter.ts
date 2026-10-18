export interface TokenBucketOptions {
  /** Maximum number of tokens the bucket can hold (burst size). */
  capacity: number
  /** Tokens refilled per second (sustained rate). */
  refillPerSecond: number
  /** Clock injection for tests. */
  now?: () => number
}

/**
 * Sliding token bucket rate limiter. Defaults to a burst of 1000 tokens that
 * refills at 1000/second, i.e. 1000 queries per second.
 */
export class TokenBucket {
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly now: () => number
  private tokens: number
  private lastRefill: number

  constructor(options: TokenBucketOptions) {
    this.capacity = Math.max(1, options.capacity)
    this.refillPerSecond = Math.max(0, options.refillPerSecond)
    this.now = options.now ?? Date.now
    this.tokens = this.capacity
    this.lastRefill = this.now()
  }

  /** Attempts to consume `count` tokens; false when the bucket is exhausted. */
  tryTake(count = 1): boolean {
    this.refill()
    if (this.tokens < count) {
      return false
    }
    this.tokens -= count
    return true
  }

  refill(): void {
    const now = this.now()
    const elapsedSeconds = (now - this.lastRefill) / 1000
    if (elapsedSeconds <= 0) {
      return
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond)
    this.lastRefill = now
  }

  reset(): void {
    this.tokens = this.capacity
    this.lastRefill = this.now()
  }
}