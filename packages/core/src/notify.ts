const TELEGRAM_API_BASE = 'https://api.telegram.org'
const REQUEST_TIMEOUT_MS = 10_000

export type TrustedDecision = 'approved' | 'denied'

export interface TelegramResponse {
  ok: boolean
  description?: string
  error_code?: number
  result?: unknown
}

export function sendMessageUrl(botToken: string): string {
  return `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`
}

/**
 * Sends a plain-text message to a chat via the Telegram Bot API.
 * Rejects if the token is rejected, the API is unreachable, or the response
 * does not carry `ok:true`.
 */
export async function sendTelegram(
  botToken: string,
  chatId: string | number,
  message: string,
): Promise<void> {
  if (botToken.trim() === '') throw new TypeError('botToken must not be empty')
  if (String(chatId).trim() === '') throw new TypeError('chatId must not be empty')
  if (message.trim() === '') throw new TypeError('message must not be empty')

  let response: Response
  try {
    response = await fetch(sendMessageUrl(botToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new Error(`Telegram sendMessage failed: ${String(cause)}`, { cause })
  }

  const payload = (await response.json().catch(() => null)) as TelegramResponse | null
  if (!response.ok || payload === null || payload.ok !== true) {
    throw new Error(
      `Telegram sendMessage failed (HTTP ${response.status}): ${
        payload?.description ?? 'empty or non-JSON response'
      }`,
    )
  }
}

/* --------------------------------------------------------------------------
 * Lock-lifecycle notifications
 * ------------------------------------------------------------------------ */

export function unlockRequestedMessage(lockId: string, releaseAt: Date): string {
  return `Unlock requested for lock ${lockId}; release is scheduled for ${releaseAt.toISOString()}.`
}

export function lockExpiredMessage(lockId: string): string {
  return `Lock ${lockId} has expired; the secret may now be revealed.`
}

export function trustedDecisionMessage(lockId: string, decision: TrustedDecision): string {
  const outcome = decision === 'approved' ? 'approved' : 'denied'
  return `A trusted contact ${outcome} the unlock for lock ${lockId}.`
}

/** The user asked to unlock a still-locked entry. */
export async function notifyUnlockRequested(
  botToken: string,
  chatId: string | number,
  lockId: string,
  releaseAt: Date,
): Promise<void> {
  await sendTelegram(botToken, chatId, unlockRequestedMessage(lockId, releaseAt))
}

/** The configured time window ended and the secret can now be revealed. */
export async function notifyLockExpired(
  botToken: string,
  chatId: string | number,
  lockId: string,
): Promise<void> {
  await sendTelegram(botToken, chatId, lockExpiredMessage(lockId))
}

/** A trusted contact approved or denied the unlock request. */
export async function notifyTrustedDecision(
  botToken: string,
  chatId: string | number,
  lockId: string,
  decision: TrustedDecision,
): Promise<void> {
  await sendTelegram(botToken, chatId, trustedDecisionMessage(lockId, decision))
}