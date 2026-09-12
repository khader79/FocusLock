import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/*
 * Shamir Secret Sharing over GF(256) (polynomial 0x11B, the AES field) plus
 * AES-GCM sealing of the original secret.
 *
 * Design:
 *  - The original secret is encrypted with a random AES-256-GCM key.
 *  - That key is what actually goes through Shamir: byte 0 of the key is the
 *    constant term of polynomial 0, byte 1 of polynomial 1, ..., so a share
 *    is a set of evaluations of 32 independent degree-(k-1) polynomials.
 *  - Every share also carries one sealed copy of iv || ciphertext || tag, so
 *    any k shares can both rebuild the key and authenticate the payload.
 *
 * Share layout (version 1):
 *   [0]     version (1)
 *   [1]     threshold k
 *   [2]     key length (32)
 *   [3]     share index x (1..n; never 0 so evaluation at 0 stays secret)
 *   [4..5]  payload length (big-endian)
 *   [6..37] 32 polynomial evaluations (one per key byte)
 *   [38..]  iv || ciphertext || gcm-tag
 */

const VERSION = 1
const KEY_BYTES = 32 // AES-256
const IV_BYTES = 12 // GCM recommended IV size
const GCM_TAG_BYTES = 16
const HEADER_BASE_BYTES = 6
const AES_ALGORITHM = 'aes-256-gcm'
const GF_IRREDUCIBLE_POLY = 0x11b // x^8 + x^4 + x^3 + x + 1

/* --------------------------------------------------------------------------
 * GF(256) arithmetic
 * ------------------------------------------------------------------------ */

function gfMul(a: number, b: number): number {
  let result = 0
  while (b > 0) {
    if ((b & 1) === 1) result ^= a
    b >>>= 1
    a <<= 1
    if (a > 0xff) a ^= GF_IRREDUCIBLE_POLY
  }
  return result
}

function gfPow(base: number, exponent: number): number {
  let result = 1
  while (exponent > 0) {
    if ((exponent & 1) === 1) result = gfMul(result, base)
    base = gfMul(base, base)
    exponent >>>= 1
  }
  return result
}

function gfInv(a: number): number {
  if (a === 0) throw new Error('Cannot invert 0 in GF(256)')
  return gfPow(a, 0xfe) // a^(255-1) via Fermat's little theorem
}

/* --------------------------------------------------------------------------
 * Splitting
 * ------------------------------------------------------------------------ */

export function splitSecret(secret: Uint8Array, n: number, k: number): Uint8Array[] {
  if (!Number.isInteger(n) || !Number.isInteger(k)) {
    throw new RangeError('n and k must be integers')
  }
  if (n < 1 || n > 255) throw new RangeError('n must be between 1 and 255')
  if (k < 1 || k > n) throw new RangeError('k must be between 1 and n')
  if (secret.byteLength === 0) throw new RangeError('secret must not be empty')

  const key = randomBytes(KEY_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(AES_ALGORITHM, key, iv)
  const sealedSecret = Buffer.concat([
    cipher.update(secret),
    cipher.final(),
    cipher.getAuthTag(),
  ])

  const payloadLen = IV_BYTES + sealedSecret.byteLength
  const shareLen = HEADER_BASE_BYTES + KEY_BYTES + payloadLen

  // coeffColumns[d][b] = coefficient of x^d in polynomial for key byte b.
  // Degree 0 holds the key itself; higher degrees are fresh randomness.
  const coeffColumns: Uint8Array[] = [
    key,
    ...Array.from({ length: k - 1 }, () => randomBytes(KEY_BYTES)),
  ]

  const shares: Uint8Array[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const x = i + 1
    const share = new Uint8Array(shareLen)
    share[0] = VERSION
    share[1] = k
    share[2] = KEY_BYTES
    share[3] = x
    share[4] = (payloadLen >> 8) & 0xff
    share[5] = payloadLen & 0xff

    const pointsStart = HEADER_BASE_BYTES
    for (let b = 0; b < KEY_BYTES; b++) {
      let value = 0
      for (let d = k - 1; d >= 0; d--) {
        value = gfMul(value, x) ^ (coeffColumns[d]![b] ?? 0)
      }
      share[pointsStart + b] = value
    }

    share.set(iv, pointsStart + KEY_BYTES)
    share.set(sealedSecret, pointsStart + KEY_BYTES + IV_BYTES)

    shares[i] = share
  }

  return shares
}

/* --------------------------------------------------------------------------
 * Combining
 * ------------------------------------------------------------------------ */

export function combineShares(shares: Uint8Array[]): Uint8Array {
  if (shares.length === 0) throw new RangeError('At least one share is required')

  const first = shares[0]!
  const version = first[0]!
  if (version !== VERSION) throw new Error(`Unsupported share format version ${version}`)

  const k = first[1]!
  const keyLen = first[2]!
  const payloadLen = (first[4]! << 8) | first[5]!
  if (keyLen !== KEY_BYTES) throw new Error(`Unsupported key length ${keyLen}`)
  if (payloadLen < IV_BYTES + GCM_TAG_BYTES) throw new Error('Invalid share: payload too short')
  if (shares.length < k) {
    throw new RangeError(`Need at least ${k} shares (threshold), got ${shares.length}`)
  }

  const expectedLen = HEADER_BASE_BYTES + keyLen + payloadLen

  const indices: number[] = []
  const pointsByShare: Uint8Array[] = []
  let payload: Uint8Array | null = null

  for (const share of shares) {
    if (share.byteLength !== expectedLen) {
      throw new Error('Share length mismatch: shares are not from the same split')
    }
    if (
      share[0] !== version ||
      share[1] !== k ||
      share[2] !== keyLen ||
      share[4] !== first[4] ||
      share[5] !== first[5]
    ) {
      throw new Error('Share headers differ: shares are not from the same split')
    }

    const index = share[3]!
    if (index === 0) throw new Error('Invalid share: index must not be zero')
    if (indices.includes(index)) throw new Error(`Duplicate share index ${index}`)

    indices.push(index)
    pointsByShare.push(share.subarray(HEADER_BASE_BYTES, HEADER_BASE_BYTES + keyLen))
    payload = payload ?? share.subarray(HEADER_BASE_BYTES + keyLen)
  }

  // Rebuild the key byte by byte with Lagrange interpolation evaluated at 0.
  // Using every provided share is safe: all shares lie on the same
  // degree-(k-1) polynomials, so the unique interpolant through >= k points
  // equals them (any corrupted share is caught by the GCM tag below).
  const key = new Uint8Array(keyLen)
  for (let b = 0; b < keyLen; b++) {
    let acc = 0
    for (let i = 0; i < indices.length; i++) {
      let basis = 1 // l_i(0) = prod_{j!=i} x_j / (x_j - x_i)
      for (let j = 0; j < indices.length; j++) {
        if (i === j) continue
        const denominator = indices[i]! ^ indices[j]!
        basis = gfMul(basis, gfMul(indices[j]!, gfInv(denominator)))
      }
      acc ^= gfMul(pointsByShare[i]![b] ?? 0, basis)
    }
    key[b] = acc
  }

  const sealedPayload = payload!
  const iv = sealedPayload.subarray(0, IV_BYTES)
  const ciphertext = sealedPayload.subarray(IV_BYTES, payloadLen - GCM_TAG_BYTES)
  const tag = sealedPayload.subarray(payloadLen - GCM_TAG_BYTES)

  // Authentication: a wrong key (e.g. combining fewer than k shares, or a
  // corrupted share) makes final() throw.
  const decipher = createDecipheriv(AES_ALGORITHM, Buffer.from(key), Buffer.from(iv))
  decipher.setAuthTag(Buffer.from(tag))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext)),
    decipher.final(),
  ])
  return new Uint8Array(plaintext)
}