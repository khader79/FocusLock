import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  lockExpiredMessage,
  notifyLockExpired,
  notifyTrustedDecision,
  notifyUnlockRequested,
  sendTelegram,
  trustedDecisionMessage,
  unlockRequestedMessage,
} from './notify'

const TOKEN = '123456:ABC-DEF'
const CHAT_ID = 42

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
}

function okFetch(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(async () => okResponse())
}

function bodyOf(m: Mock<typeof fetch>): Record<string, string | number> {
  const init = m.mock.calls[0]![1]!
  return JSON.parse(String(init.body)) as Record<string, string | number>
}

describe('sendTelegram', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the message to the bot sendMessage endpoint', async () => {
    const m = okFetch()
    vi.stubGlobal('fetch', m)

    await sendTelegram(TOKEN, CHAT_ID, 'hello')

    const [url, init] = m.mock.calls[0]!
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(bodyOf(m)).toEqual({ chat_id: CHAT_ID, text: 'hello' })
  })

  it('resolves when the API returns ok:true', async () => {
    vi.stubGlobal('fetch', okFetch())
    await expect(sendTelegram(TOKEN, CHAT_ID, 'ping')).resolves.toBeUndefined()
  })

  it('rejects when the API reports ok:false', async () => {
    const body = JSON.stringify({ ok: false, description: 'Unauthorized' })
    const m: Mock<typeof fetch> = vi.fn<typeof fetch>(
      async () => new Response(body, { status: 200 }),
    )
    vi.stubGlobal('fetch', m)

    await expect(sendTelegram(TOKEN, CHAT_ID, 'x')).rejects.toThrow(/Unauthorized/)
  })

  it('rejects non-2xx HTTP responses', async () => {
    const m: Mock<typeof fetch> = vi.fn<typeof fetch>(
      async () => new Response('nope', { status: 503 }),
    )
    vi.stubGlobal('fetch', m)

    await expect(sendTelegram(TOKEN, CHAT_ID, 'x')).rejects.toThrow(/503/)
  })

  it('rethrows network failures as an Error', async () => {
    const m: Mock<typeof fetch> = vi.fn<typeof fetch>(async () => {
      throw new Error('ECONNRESET')
    })
    vi.stubGlobal('fetch', m)

    await expect(sendTelegram(TOKEN, CHAT_ID, 'x')).rejects.toThrow(/ECONNRESET/)
  })

  it('rejects empty arguments', async () => {
    await expect(sendTelegram('', CHAT_ID, 'x')).rejects.toThrow(TypeError)
    await expect(sendTelegram(TOKEN, CHAT_ID, '')).rejects.toThrow(TypeError)
  })
})

describe('lock-lifecycle notifications', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('notifies when the user asks to open the lock', async () => {
    const m = okFetch()
    vi.stubGlobal('fetch', m)
    const releaseAt = new Date('2026-09-12T12:00:00.000Z')

    await notifyUnlockRequested('bot-token', 123, 'lock-1', releaseAt)

    expect(bodyOf(m).text).toBe(unlockRequestedMessage('lock-1', releaseAt))
    expect(bodyOf(m).chat_id).toBe(123)
  })

  it('notifies when the time window ended', async () => {
    const m = okFetch()
    vi.stubGlobal('fetch', m)

    await notifyLockExpired('bot-token', 123, 'lock-1')

    expect(bodyOf(m).text).toBe(lockExpiredMessage('lock-1'))
  })

  it('notifies when the trusted contact approves', async () => {
    const m = okFetch()
    vi.stubGlobal('fetch', m)

    await notifyTrustedDecision('bot-token', 123, 'lock-1', 'approved')

    expect(bodyOf(m).text).toBe(trustedDecisionMessage('lock-1', 'approved'))
  })

  it('notifies when the trusted contact denies', async () => {
    const m = okFetch()
    vi.stubGlobal('fetch', m)

    await notifyTrustedDecision('bot-token', 123, 'lock-1', 'denied')

    expect(bodyOf(m).text).toBe(trustedDecisionMessage('lock-1', 'denied'))
  })

  it('builds a distinct message for each decision', () => {
    expect(trustedDecisionMessage('lock-1', 'approved')).toContain('approved')
    expect(trustedDecisionMessage('lock-1', 'denied')).toContain('denied')
    expect(trustedDecisionMessage('lock-1', 'approved')).not.toBe(
      trustedDecisionMessage('lock-1', 'denied'),
    )
  })
})
