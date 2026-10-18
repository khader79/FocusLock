import { buildQuery, encodeName, parseQuestion } from './dns-packet'

export interface MakeQueryOptions {
  id?: number
  qtype?: number
  qclass?: number
}

export interface AnswerSpec {
  name: string
  type?: number
  qclass?: number
  ttl: number
  data: Buffer
}

export interface MakeResponseOptions {
  rcode?: number
  answers?: AnswerSpec[]
}

export function makeQuery(domain: string, options: MakeQueryOptions = {}): Buffer {
  return buildQuery({
    id: options.id ?? 0x1234,
    name: domain,
    qtype: options.qtype,
    qclass: options.qclass,
  })
}

function qtypeClass(qtype: number, qclass: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt16BE(qtype, 0)
  buffer.writeUInt16BE(qclass, 2)
  return buffer
}

/** Builds a plausible DNS response echoing the query's question. */
export function makeResponse(query: Buffer, options: MakeResponseOptions = {}): Buffer {
  const question = parseQuestion(query)
  const rcode = options.rcode ?? 0
  const rdFlag = question.flags & 0x0100

  const header = Buffer.alloc(12)
  header.writeUInt16BE(question.id, 0)
  header.writeUInt16BE(0x8000 | rdFlag | 0x0080 | rcode, 2) // QR + RD(echoed) + RA + RCODE
  header.writeUInt16BE(1, 4) // QDCOUNT
  header.writeUInt16BE(options.answers?.length ?? 0, 6) // ANCOUNT

  const questionSection = Buffer.concat([
    encodeName(question.qname),
    qtypeClass(question.qtype, question.qclass),
  ])

  const parts: Buffer[] = [header, questionSection]
  for (const answer of options.answers ?? []) {
    const data = answer.data ?? Buffer.alloc(1)
    const rr = Buffer.alloc(10)
    rr.writeUInt16BE(answer.type ?? 1, 0)
    rr.writeUInt16BE(answer.qclass ?? 1, 2)
    rr.writeUInt32BE(answer.ttl, 4)
    rr.writeUInt16BE(data.length, 8)
    parts.push(encodeName(answer.name), rr, data)
  }

  return Buffer.concat(parts)
}

export function ipv4(value: string): Buffer {
  return Buffer.from(value.split('.').map((part) => Number.parseInt(part, 10)))
}