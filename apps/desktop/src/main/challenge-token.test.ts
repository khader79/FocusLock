import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertValidChallengeToken,
  signChallengeToken,
  verifyTokenForAction,
} from './challenge-token'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('signChallengeToken', () => {
  it('produces a well-formed 3-segment base64url JWT', () => {
    const token = signChallengeToken('pause')
    const parts = token.split('.')

    expect(parts).toHaveLength(3)

    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'))
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' })

    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    expect(claims).toEqual({ action: 'pause', iat: 1767225600000, exp: 1767225900000 })
  })

  it('mints the same signature for identical payloads (deterministic HMAC)', () => {
    const a = signChallengeToken('pause').split('.')[2]
    const b = signChallengeToken('pause').split('.')[2]
    expect(a).toBe(b)
  })
})

describe('assertValidChallengeToken', () => {
  it('round-trips a freshly minted token', () => {
    const claims = assertValidChallengeToken(signChallengeToken('toggle_category'))
    expect(claims.action).toBe('toggle_category')
    expect(claims.exp).toBeGreaterThan(claims.iat)
  })

  it('rejects tokens that are not three segments', () => {
    expect(() => assertValidChallengeToken('a.b')).toThrow(/3 segments/)
    expect(() => assertValidChallengeToken('a.b.c.d')).toThrow(/3 segments/)
    expect(() => assertValidChallengeToken('')).toThrow(/3 segments/)
  })

  it('rejects a tampered signature', () => {
    const token = signChallengeToken('pause')
    const parts = token.split('.')
    const corrupted = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -1)}${parts[2]!.endsWith('a') ? 'b' : 'a'}`
    expect(() => assertValidChallengeToken(corrupted)).toThrow(/signature mismatch/)
  })

  it('rejects a tampered payload', () => {
    const token = signChallengeToken('pause')
    const [header, payload, signature] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { action: string }
    claims.action = 'quit'
    const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const corrupted = `${header}.${tamperedPayload}.${signature}`
    expect(() => assertValidChallengeToken(corrupted)).toThrow(/signature mismatch/)
  })

  it('rejects malformed base64url payloads', () => {
    const token = signChallengeToken('pause')
    const [header, , signature] = token.split('.')
    expect(() => assertValidChallengeToken(`${header}.not!base64.${signature}`)).toThrow()
  })

  it('validates the signature before touching the payload (defense in depth)', () => {
    // No attacker can craft a payload that passes the HMAC, whatever it decodes to.
    const token = signChallengeToken('pause')
    const [header, , signature] = token.split('.')
    const garbagePayload = Buffer.from('not-json').toString('base64url')
    expect(() => assertValidChallengeToken(`${header}.${garbagePayload}.${signature}`)).toThrow(
      /signature mismatch/,
    )

    const badClaims = Buffer.from(
      JSON.stringify({ action: 'pause', iat: 1, exp: 'soon' }),
    ).toString('base64url')
    expect(() => assertValidChallengeToken(`${header}.${badClaims}.${signature}`)).toThrow(
      /signature mismatch/,
    )
  })

  it('rejects expired tokens', () => {
    const token = signChallengeToken('pause')
    expect(assertValidChallengeToken(token)).toBeTruthy()

    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'))
    expect(() => assertValidChallengeToken(token)).toThrow(/expired/)
  })

  it('rejects tokens within the TTL boundary as soon as exp passes', () => {
    const token = signChallengeToken('pause')
    vi.setSystemTime(new Date('2026-01-01T00:04:59.999Z'))
    expect(assertValidChallengeToken(token)).toBeTruthy()
    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'))
    expect(() => assertValidChallengeToken(token)).toThrow(/expired/)
  })
})

describe('verifyTokenForAction', () => {
  it('accepts a token minted for the expected action', () => {
    const claims = verifyTokenForAction(signChallengeToken('remove_site'), 'remove_site')
    expect(claims.action).toBe('remove_site')
  })

  it('rejects a token minted for a different action', () => {
    const token = signChallengeToken('remove_site')
    expect(() => verifyTokenForAction(token, 'remove_app')).toThrow(
      /minted for "remove_site" but used for "remove_app"/,
    )
  })

  it('still enforces expiry and signature before the action check', () => {
    const token = signChallengeToken('quit')
    vi.setSystemTime(new Date('2026-01-01T00:10:00Z'))
    expect(() => verifyTokenForAction(token, 'quit')).toThrow(/expired/)
  })
})