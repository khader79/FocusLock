import { bench, describe } from 'vitest'
import { buildQuery, parseQuestion, readName, replyFromQuery } from './dns-packet'

/**
 * Wire-format budgets. Handlers must stay comfortably under a millisecond on
 * the hot path; these benches just keep parse/build within an envelope.
 */

const names = Array.from({ length: 1000 }, (_, index) => `host-${index}.deep.sub.example.com`)
const queries = names.map((name) => buildQuery({ id: 0x1234, name }))

describe('dns-packet', () => {
  bench('build 64-byte queries from hostnames', () => {
    for (const name of names) {
      buildQuery({ id: 0x1234, name })
    }
  }, { time: 300, iterations: 15 })

  bench('parse 1000 real query buffers', () => {
    for (const query of queries) {
      parseQuestion(query)
    }
  }, { time: 300, iterations: 15 })

  bench('decode names with compression-free labels', () => {
    const buffer = buildQuery({ id: 1, name: 'a.very.long.example.deep.com' })
    readName(buffer, 12)
  }, { time: 300, iterations: 15 })

  bench('build NXDOMAIN replies from inbound queries', () => {
    for (const query of queries) {
      replyFromQuery(query, 3)
    }
  }, { time: 300, iterations: 15 })
})