export const QTYPE_A = 1
export const QTYPE_NS = 2
export const QTYPE_CNAME = 5
export const QTYPE_MX = 15
export const QTYPE_TXT = 16
export const QTYPE_AAAA = 28
export const QTYPE_OPT = 41

export const QCLASS_IN = 1

export const RCODE_SUCCESS = 0
export const RCODE_SERVFAIL = 2
export const RCODE_NXDOMAIN = 3

const HEADER_SIZE = 12
const MAX_LABELS = 128

export interface DnsQuestion {
  id: number
  flags: number
  rcode: number
  /** Lower-cased fully-qualified domain (no trailing dot). */
  qname: string
  qtype: number
  qclass: number
}

export interface ResponseStats {
  id: number
  flags: number
  rcode: number
  qdcount: number
  ancount: number
  nscount: number
  arcount: number
  /** Smallest TTL found in the answer/authority/additional records. */
  minTtl: number
}

/**
 * Reads a domain name starting at `start`, following RFC 1035 compression
 * pointers. Returns the decoded name and the offset just past the name as
 * written at `start` (used to continue walking the message).
 */
export function readName(buffer: Buffer, start: number): { name: string; nextOffset: number } {
  const labels: string[] = []
  let offset = start
  let nextOffset = start
  let jumped = false

  for (let guard = 0; guard < MAX_LABELS; guard += 1) {
    const length = buffer[offset]
    if (length === undefined) {
      throw new Error(`DNS name exceeds message bounds at offset ${offset}`)
    }

    if (length === 0) {
      if (!jumped) {
        nextOffset = offset + 1
      }
      break
    }

    if ((length & 0xc0) === 0xc0) {
      const second = buffer[offset + 1]
      if (second === undefined) {
        throw new Error('DNS compression pointer out of bounds')
      }
      const pointer = ((length & 0x3f) << 8) | second
      if (!jumped) {
        nextOffset = offset + 2
        jumped = true
      }
      offset = pointer
      continue
    }

    if ((length & 0xc0) !== 0) {
      throw new Error(`Unsupported DNS label type 0x${(length & 0xc0).toString(16)}`)
    }

    const labelStart = offset + 1
    const labelEnd = labelStart + length
    if (buffer.length < labelEnd) {
      throw new Error('DNS label out of bounds')
    }
    labels.push(buffer.toString('latin1', labelStart, labelEnd).toLowerCase())
    offset = labelEnd
    if (!jumped) {
      nextOffset = labelEnd
    }
  }

  return { name: labels.join('.'), nextOffset }
}

/** Returns the offset just past the name written at `start`. */
export function skipName(buffer: Buffer, start: number): number {
  let offset = start
  for (let guard = 0; guard < MAX_LABELS; guard += 1) {
    const length = buffer[offset]
    if (length === undefined) {
      throw new Error('DNS name out of bounds')
    }
    if (length === 0) {
      return offset + 1
    }
    if ((length & 0xc0) === 0xc0) {
      return offset + 2
    }
    offset += 1 + length
  }
  throw new Error('Too many DNS labels')
}

/** Encodes a domain name as a sequence of length-prefixed labels + root. */
export function encodeName(name: string): Buffer {
  const labels = name.replace(/\.+$/, '').split('.')
  const chunks: Buffer[] = []

  for (const label of labels) {
    if (label === '') {
      continue
    }
    if (label.length > 63) {
      throw new Error(`DNS label too long: "${label}"`)
    }
    const part = Buffer.alloc(1 + label.length)
    part.writeUInt8(label.length, 0)
    part.write(label, 1, 'latin1')
    chunks.push(part)
  }

  return Buffer.concat([...chunks, Buffer.from([0])])
}

/** Parses the header and single question of a DNS message (query or response). */
export function parseQuestion(message: Buffer): DnsQuestion {
  if (message.length < HEADER_SIZE + 5) {
    throw new Error('DNS message too short')
  }

  const id = message.readUInt16BE(0)
  const flags = message.readUInt16BE(2)
  const qdcount = message.readUInt16BE(4)
  if (qdcount === 0) {
    throw new Error('DNS message has no question section')
  }

  const { name, nextOffset } = readName(message, HEADER_SIZE)
  if (nextOffset + 4 > message.length) {
    throw new Error('DNS question truncated')
  }

  return {
    id,
    flags,
    rcode: flags & 0x0f,
    qname: name,
    qtype: message.readUInt16BE(nextOffset),
    qclass: message.readUInt16BE(nextOffset + 2),
  }
}

/** Builds a single-question query with RD=1. */
export function buildQuery(options: {
  id: number
  name: string
  qtype?: number
  qclass?: number
}): Buffer {
  const qtype = options.qtype ?? QTYPE_A
  const qclass = options.qclass ?? QCLASS_IN

  const header = Buffer.alloc(HEADER_SIZE)
  header.writeUInt16BE(options.id, 0)
  header.writeUInt16BE(0x0100, 2) // RD = 1
  header.writeUInt16BE(1, 4) // QDCOUNT = 1

  const typeClass = Buffer.alloc(4)
  typeClass.writeUInt16BE(qtype, 0)
  typeClass.writeUInt16BE(qclass, 2)

  return Buffer.concat([header, encodeName(options.name), typeClass])
}

/** Walks every section and returns message metadata plus the minimum RR TTL. */
export function parseResponseStats(message: Buffer): ResponseStats {
  if (message.length < HEADER_SIZE) {
    throw new Error('DNS message too short')
  }

  const id = message.readUInt16BE(0)
  const flags = message.readUInt16BE(2)
  const qdcount = message.readUInt16BE(4)
  const ancount = message.readUInt16BE(6)
  const nscount = message.readUInt16BE(8)
  const arcount = message.readUInt16BE(10)

  let offset = HEADER_SIZE
  for (let i = 0; i < qdcount; i += 1) {
    offset = skipName(message, offset)
    if (offset + 4 > message.length) {
      throw new Error('DNS question section truncated')
    }
    offset += 4
  }

  let minTtl = Number.POSITIVE_INFINITY
  const walk = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      offset = skipName(message, offset)
      if (offset + 10 > message.length) {
        throw new Error('DNS resource record truncated')
      }
      const type = message.readUInt16BE(offset)
      const ttl = message.readUInt32BE(offset + 4)
      const rdlength = message.readUInt16BE(offset + 8)
      if (type !== QTYPE_OPT) {
        minTtl = Math.min(minTtl, ttl)
      }
      offset += 10 + rdlength
      if (offset > message.length) {
        throw new Error('DNS resource data truncated')
      }
    }
  }

  walk(ancount + nscount)
  walk(arcount)

  return {
    id,
    flags,
    rcode: flags & 0x0f,
    qdcount,
    ancount,
    nscount,
    arcount,
    minTtl: Number.isFinite(minTtl) ? minTtl : 0,
  }
}

/** Returns a copy of a message with a new (client) transaction ID. */
export function rewriteMessageId(message: Buffer, id: number): Buffer {
  const out = Buffer.from(message)
  out.writeUInt16BE(id, 0)
  return out
}

/** Returns a copy of a message with every record TTL reduced by `seconds`. */
export function decrementTtls(message: Buffer, seconds: number): Buffer {
  const out = Buffer.from(message)
  if (seconds <= 0) {
    return out
  }

  let offset = HEADER_SIZE
  const qdcount = out.readUInt16BE(4)
  const ancount = out.readUInt16BE(6)
  const nscount = out.readUInt16BE(8)
  const arcount = out.readUInt16BE(10)

  for (let i = 0; i < qdcount; i += 1) {
    offset = skipName(out, offset)
    offset += 4
  }

  const walk = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      offset = skipName(out, offset)
      const type = out.readUInt16BE(offset)
      const ttl = out.readUInt32BE(offset + 4)
      const rdlength = out.readUInt16BE(offset + 8)
      if (type !== QTYPE_OPT) {
        out.writeUInt32BE(Math.max(0, ttl - seconds), offset + 4)
      }
      offset += 10 + rdlength
    }
  }

  walk(ancount + nscount)
  walk(arcount)

  return out
}

/**
 * Turns a valid query into an error response (NXDOMAIN / SERVFAIL / ...) that
 * echoes the question back. Requires `query` to be a well-formed single
 * question; otherwise use `minimalResponse`.
 */
export function replyFromQuery(query: Buffer, rcode: number): Buffer {
  const out = Buffer.from(query)
  out[2] = (out[2] ?? 0) | 0x80 // QR = 1
  out[3] = (rcode & 0x0f) | 0x80 // RA = 1, RCODE = rcode
  out.writeUInt16BE(0, 6) // ANCOUNT = 0
  out.writeUInt16BE(0, 8) // NSCOUNT = 0
  out.writeUInt16BE(0, 10) // ARCOUNT = 0
  return out
}

/** Builds a bare error response (no question section) from just an ID. */
export function minimalResponse(id: number, rcode: number): Buffer {
  const out = Buffer.alloc(HEADER_SIZE)
  out.writeUInt16BE(id, 0)
  out.writeUInt16BE(0x8080 | (rcode & 0x0f), 2) // QR = 1, RA = 1
  return out
}

/** True if the buffer looks like a DNS response (length + QR flag set). */
export function isResponse(message: Buffer): boolean {
  return message.length >= HEADER_SIZE && (message.readUInt16BE(2) & 0x8000) !== 0
}