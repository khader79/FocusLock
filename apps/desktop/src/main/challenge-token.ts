import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Self-contained HS256 challenge tokens. Electron-free leaf module so both
 * `protected-actions.ts` and the Electron-free `custom-sites.ts` / `app-blocker.ts`
 * can verify tokens without pulling in `electron` under vitest.
 */

const JWT_ALGORITHM = 'HS256'
const TOKEN_TTL_MILLIS = 5 * 60 * 1000
const jwtSecret = randomBytes(32)

export interface TokenClaims {
  action: string
  iat: number
  exp: number
}

function base64url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return buffer.toString('base64url')
}

/** Mints a challenge token for the given action (5-minute lifetime). */
export function signChallengeToken(action: string): string {
  const now = Date.now()
  const header = base64url(JSON.stringify({ alg: JWT_ALGORITHM, typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ action, iat: now, exp: now + TOKEN_TTL_MILLIS } satisfies TokenClaims))
  const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

/**
 * Verifies the JWT structure, signature and expiry of a challenge token.
 * Throws if any check fails; the action claim is NOT compared (callers decide
 * which actions a token is acceptable for).
 */
export function assertValidChallengeToken(token: string): TokenClaims {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid challenge token: expected a JWT with 3 segments.')
  }

  const [header, payload, signature] = parts as [string, string, string]
  const expectedSignature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url')

  const signatureBuffer = Buffer.from(signature)
  if (
    signatureBuffer.length !== expectedSignature.length ||
    !timingSafeEqual(signatureBuffer, Buffer.from(expectedSignature))
  ) {
    throw new Error('Invalid challenge token: signature mismatch.')
  }

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims

  if (typeof claims.exp !== 'number' || claims.exp <= Date.now()) {
    throw new Error('Challenge token has expired.')
  }

  return claims
}

/**
 * Verifies the token and additionally requires it was minted for exactly
 * `expectedAction`.
 */
export function verifyTokenForAction(token: string, expectedAction: string): TokenClaims {
  const claims = assertValidChallengeToken(token)
  if (claims.action !== expectedAction) {
    throw new Error(
      `Challenge token was minted for "${claims.action}" but used for "${expectedAction}".`,
    )
  }
  return claims
}