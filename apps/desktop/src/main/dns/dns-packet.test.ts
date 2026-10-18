import { describe, expect, it } from 'vitest'
import {
  buildQuery,
  decrementTtls,
  encodeName,
  isResponse,
  minimalResponse,
  parseQuestion,
  parseResponseStats,
  QTYPE_A,
  QTYPE_OPT,
  RCODE_NXDOMAIN,
  readName,
  replyFromQuery,
  rewriteMessageId,
  RCODE_SERVFAIL,
  skipName,
} from './dns-packet'
import { ipv4, makeQuery, makeResponse } from './test-helpers'

describe('readName', () => {
  it('decodes length-prefixed labels', () => {
    const buffer = encodeName('www.Example.COM')
    const { name, nextOffset } = readName(buffer, 0)
    expect(name).toBe('www.example.com')
    expect(nextOffset).toBe(buffer.length)
  })

  it('follows compression pointers', () => {
    const first = encodeName('example.com')
    const message = Buffer.concat([first, Buffer.from([0xc0, 0x00])])
    const { name, nextOffset } = readName(message, first.length)
    expect(name).toBe('example.com')
    expect(nextOffset).toBe(first.length + 2)
  })

  it('throws on truncated buffers', () => {
    expect(() => readName(Buffer.from([5, 0x61]), 0)).toThrow(/bounds/)
  })
})

describe('skipName', () => {
  it('returns the offset after a plain name', () => {
    const buffer = encodeName('a.b.c.example.com')
    expect(skipName(buffer, 0)).toBe(buffer.length)
  })

  it('returns the offset after a compression pointer', () => {
    const buffer = Buffer.from([0xc0, 0x0c])
    expect(skipName(buffer, 0)).toBe(2)
  })
})

describe('buildQuery / parseQuestion', () => {
  it('round-trips a query', () => {
    const query = buildQuery({ id: 0xabcd, name: 'Example.COM' })
    const parsed = parseQuestion(query)
    expect(parsed.id).toBe(0xabcd)
    expect(parsed.qname).toBe('example.com')
    expect(parsed.qtype).toBe(QTYPE_A)
    expect(parsed.rcode).toBe(0)
    expect(parsed.flags & 0x0100).toBe(0x0100) // RD=1
  })

  it('rejects messages without a question', () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(0x0001, 0)
    const body = Buffer.alloc(5)
    body.writeUInt16BE(1, 0)
    expect(() => parseQuestion(Buffer.concat([header, body]))).toThrow(/no question/)
  })
})

describe('replyFromQuery', () => {
  it('builds an NXDOMAIN response that echoes the question', () => {
    const query = makeQuery('blocked.com')
    const reply = replyFromQuery(query, RCODE_NXDOMAIN)

    const parsed = parseQuestion(reply)
    expect(parsed.id).toBe(0x1234)
    expect(parsed.qname).toBe('blocked.com')
    expect(parsed.rcode).toBe(RCODE_NXDOMAIN)
    expect(reply.readUInt16BE(2) & 0x8000).toBe(0x8000) // QR = 1
    expect(reply.readUInt16BE(6)).toBe(0) // no answers
  })
})

describe('minimalResponse', () => {
  it('builds a bare error response', () => {
    const reply = minimalResponse(0x0007, RCODE_SERVFAIL)
    expect(reply.length).toBe(12)
    expect(reply.readUInt16BE(0)).toBe(0x0007)
    expect(reply.readUInt16BE(2) & 0x8000).toBe(0x8000) // QR = 1
    expect(reply.readUInt16BE(2) & 0x000f).toBe(RCODE_SERVFAIL)
  })
})

describe('isResponse', () => {
  it('detects the QR flag', () => {
    expect(isResponse(makeQuery('a.com'))).toBe(false)
    expect(isResponse(makeResponse(makeQuery('a.com')))).toBe(true)
  })
})

describe('rewriteMessageId', () => {
  it('only changes the transaction id', () => {
    const original = makeResponse(makeQuery('a.com'), {
      answers: [{ name: 'a.com', ttl: 60, data: ipv4('1.2.3.4') }],
    })
    const rewritten = rewriteMessageId(original, 0x9999)
    expect(rewritten.readUInt16BE(0)).toBe(0x9999)
    for (let offset = 2; offset < original.length; offset += 1) {
      expect(rewritten[offset]).toBe(original[offset])
    }
  })
})

describe('parseResponseStats', () => {
  it('computes the minimum record TTL', () => {
    const response = makeResponse(makeQuery('example.com'), {
      rcode: 0,
      answers: [
        { name: 'example.com', ttl: 120, data: ipv4('1.2.3.4') },
        { name: 'example.com', ttl: 60, data: ipv4('1.2.3.5') },
      ],
    })
    const stats = parseResponseStats(response)
    expect(stats.rcode).toBe(0)
    expect(stats.ancount).toBe(2)
    expect(stats.minTtl).toBe(60)
  })

  it('ignores the OPT pseudo-record TTL', () => {
    const query = makeQuery('example.com')
    const response = makeResponse(query, {
      answers: [{ name: 'example.com', ttl: 90, data: ipv4('1.2.3.4') }],
    })
    // Append an OPT record with a huge "TTL".
    const optRr = Buffer.alloc(11) // name(1 root) + type(2) + class(2) + ttl(4) + rdlen(2)
    optRr.writeUInt16BE(QTYPE_OPT, 1)
    optRr.writeUInt32BE(0xffffffff >>> 0, 5)
    optRr.writeUInt16BE(0, 9)
    const withOpt = Buffer.concat([response, optRr])

    const stats = parseResponseStats(withOpt)
    expect(stats.minTtl).toBe(90)
  })
})

describe('decrementTtls', () => {
  it('reduces every record TTL but leaves the OPT record alone', () => {
    const query = makeQuery('example.com')
    const response = makeResponse(query, {
      answers: [
        { name: 'example.com', ttl: 300, data: ipv4('1.2.3.4') },
        { name: 'example.com', ttl: 300, data: ipv4('1.2.3.5') },
      ],
    })
    const degraded = decrementTtls(response, 120)
    const stats = parseResponseStats(degraded)
    expect(stats.minTtl).toBe(180)
  })

  it('returns the message untouched for non-positive reductions', () => {
    const response = makeResponse(makeQuery('a.com'))
    expect(decrementTtls(response, 0)).toEqual(response)
    expect(decrementTtls(response, -5)).toEqual(response)
  })

  it('floors TTLs at zero and never underflows', () => {
    const query = makeQuery('a.com')
    const response = makeResponse(query, {
      answers: [{ name: 'a.com', ttl: 10, data: ipv4('1.2.3.4') }],
    })
    const degraded = decrementTtls(response, 9999)
    expect(parseResponseStats(degraded).minTtl).toBe(0)
  })
})

describe('readName anti-cheat / malformed messages', () => {
  it('terminates on a self-referential compression pointer loop (guard)', () => {
    // offset 0 = pointer to offset 0 -> would hang without the label guard.
    const loop = Buffer.from([0xc0, 0x00])
    const { name } = readName(loop, 0)
    expect(name).toBe('')
  })

  it('terminates on a two-node pointer cycle', () => {
    const cycle = Buffer.from([0xc0, 0x02, 0xc0, 0x00])
    const { name } = readName(cycle, 0)
    expect(name).toBe('')
  })

  it('decodes the maximum 63-byte label', () => {
    const label = 'a'.repeat(63)
    const { name, nextOffset } = readName(encodeName(label), 0)
    expect(name).toBe(label)
    expect(nextOffset).toBe(65)
  })

  it('rejects a 64-byte label as an unsupported type', () => {
    const bad = Buffer.from([64, 0x61])
    expect(() => readName(bad, 0)).toThrow(/Unsupported DNS label type/)
  })

  it('throws when a compression pointer targets past the message end', () => {
    const truncated = Buffer.from([0xc0])
    expect(() => readName(truncated, 0)).toThrow(/pointer out of bounds/)
  })

  it('throws on labels that run past the buffer end', () => {
    const dangling = Buffer.from([0x05, 0x61])
    expect(() => readName(dangling, 0)).toThrow(/bounds/)
  })

  it('stops following the compressed name and reports the on-wire offset', () => {
    // 'www' label, then a pointer to an 'example.com' target stored later.
    const target = encodeName('example.com')
    const message = Buffer.concat([
      Buffer.from([0x03, 0x77, 0x77, 0x77]),
      Buffer.from([0xc0, 0x07]), // pointer to offset 7
      Buffer.from([0x00]), // padding so the target starts at offset 7
      target,
    ])
    const { name, nextOffset } = readName(message, 0)
    expect(name).toBe('www.example.com')
    expect(nextOffset).toBe(4 + 2)
  })
})

describe('skipName bounds', () => {
  it('throws when the name exceeds the message buffer', () => {
    const dangling = Buffer.from([0x03, 0x77, 0x77])
    expect(() => skipName(dangling, 0)).toThrow(/out of bounds/)
  })

  it('throws on more than the allowed number of labels', () => {
    const tooLong = encodeName(Array.from({ length: 129 }, () => 'a').join('.'))
    expect(() => skipName(tooLong, 0)).toThrow(/Too many DNS labels/)
  })
})

describe('encodeName edge cases', () => {
  it('encodes the root as a single zero byte', () => {
    expect(encodeName('')).toEqual(Buffer.from([0]))
    expect(encodeName('.')).toEqual(Buffer.from([0]))
  })

  it('rejects labels longer than 63 bytes', () => {
    expect(() => encodeName('a'.repeat(64))).toThrow(/label too long/)
  })

  it('skips empty labels between repeated dots', () => {
    expect(encodeName('a..b.com')).toEqual(
      Buffer.concat([Buffer.from([1, 0x61]), Buffer.from([1, 0x62]), Buffer.from([3, 0x63, 0x6f, 0x6d]), Buffer.from([0])]),
    )
  })

  it('round-trips unusual but valid hostnames', () => {
    for (const name of ['xn--p1ai.example', 'sub-x.example.com', 'UPPER.case']) {
      const { name: decoded } = readName(encodeName(name), 0)
      expect(decoded).toBe(name.toLowerCase())
    }
  })
})

describe('parseQuestion malformed input', () => {
  it('rejects buffers shorter than header + minimal question', () => {
    for (const length of [0, 4, 11, 12, 13, 16]) {
      expect(() => parseQuestion(Buffer.alloc(length))).toThrow(/too short/)
    }
  })

  it('rejects a zero question count even with a full header', () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(0x1234, 0)
    header.writeUInt16BE(0, 4) // QDCOUNT = 0
    expect(() => parseQuestion(Buffer.concat([header, Buffer.alloc(5)]))).toThrow(/no question/)
  })

  it('rejects a truncated question (missing qtype/qclass)', () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(1, 4) // QDCOUNT = 1
    const body = Buffer.concat([encodeName('a.com'), Buffer.from([0x00])]) // 1 byte of type
    expect(() => parseQuestion(Buffer.concat([header, body]))).toThrow(/question truncated/)
  })
})

describe('parseResponseStats malformed input', () => {
  it('rejects messages shorter than the header', () => {
    for (const length of [0, 5, 11]) {
      expect(() => parseResponseStats(Buffer.alloc(length))).toThrow(/too short/)
    }
  })

  it('rejects a truncated question section', () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(1, 4) // QDCOUNT = 1, question body absent
    expect(() => parseResponseStats(header)).toThrow(/out of bounds|question section truncated/)
  })

  it('rejects resource records whose rdata runs past the buffer', () => {
    // Header: QDCOUNT=1, ANCOUNT=1.
    const header = Buffer.alloc(12)
    header.writeUInt16BE(0x1234, 0)
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(1, 6)
    // Question: name + A type + IN class.
    const question = Buffer.concat([encodeName('a.com'), Buffer.from([0x00, 0x01, 0x00, 0x01])])
    // Answer RR: name root, A, IN, TTL, RDLENGTH=4, but only 2 bytes of rdata.
    const answer = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from([0x00, 0x01, 0x00, 0x01]),
      Buffer.from([0x00, 0x00, 0x00, 0x3c]),
      Buffer.from([0x00, 0x04]),
      Buffer.from([0xc0, 0xa8]),
    ])
    const truncated = Buffer.concat([header, question, answer])
    expect(() => parseResponseStats(truncated)).toThrow(/resource data truncated|resource record truncated/)
  })

  it('returns a zero TTL when no records are present', () => {
    const response = makeResponse(makeQuery('a.com'))
    expect(parseResponseStats(response).minTtl).toBe(0)
  })
})

describe('query type and class plumbing', () => {
  it('round-trips AAAA queries', () => {
    const query = buildQuery({ id: 1, name: 'ipv6.example', qtype: 28 })
    const parsed = parseQuestion(query)
    expect(parsed.qtype).toBe(28)
    expect(parsed.qclass).toBe(1)
  })

  it('round-trips a custom class', () => {
    const query = buildQuery({ id: 2, name: 'chaos.example', qclass: 3 })
    expect(parseQuestion(query).qclass).toBe(3)
  })
})