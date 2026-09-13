import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type CompositionEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import type { FocusLockChallenge } from '../env'

export type ChallengeModalDifficulty = 1 | 2 | 3 | 4 | 5

export type ChallengeModalResult =
  | { status: 'completed'; text: string }
  | { status: 'cancelled' }

export interface ChallengeModalProps {
  difficulty: ChallengeModalDifficulty
  onClose: (result: ChallengeModalResult) => void
}

const T = {
  panel: '#15151d',
  raised: '#1d1d28',
  border: '#30303d',
  text: '#f1f1f5',
  muted: '#9696a5',
  accent: '#7c3aed',
  danger: '#ff5252',
  ok: '#3ddc84',
  warn: '#f7c948',
}
const MONO = "'JetBrains Mono', Consolas, monospace"
const MAX_WPM = 150
const WPM_GRACE_SECONDS = 3
const WPM_GRACE_CHARS = 60
const CONFETTI_COUNT = 42
const SUCCESS_HOLD_MS = 1400
const CONFETTI_COLORS = ['#7c3aed', '#3ddc84', '#f7c948', '#ff5252', '#4aa8ff', '#ff9ff3'] as const

const KEYFRAMES = `
@keyframes ch-fade{from{opacity:0}to{opacity:1}}
@keyframes ch-in{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
@keyframes ch-shake{10%,90%{transform:translateX(-2px)}20%,80%{transform:translateX(4px)}30%,70%{transform:translateX(-6px)}40%,60%{transform:translateX(6px)}50%{transform:translateX(-4px)}}
@keyframes ch-shake-b{10%,90%{transform:translateX(-2px)}20%,80%{transform:translateX(4px)}30%,70%{transform:translateX(-6px)}40%,60%{transform:translateX(6px)}50%{transform:translateX(-4px)}}
@keyframes ch-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes ch-pop{0%{transform:scale(0);opacity:0}60%{transform:scale(1.15);opacity:1}100%{transform:scale(1);opacity:1}}
@keyframes ch-confetti{from{transform:translate3d(0,-14vh,0) rotate(0deg)}to{transform:translate3d(var(--dx),108vh,0) rotate(720deg)}}
`

type ChallengeStatus = 'init' | 'typing' | 'success' | 'rejected' | 'expired'
type WordState = 'correct' | 'current' | 'error' | 'upcoming'

interface ConfettiPiece {
  left: number
  delay: number
  duration: number
  size: number
  color: string
  dx: number
}

function diffIndex(typed: string, target: string): number {
  const max = Math.min(typed.length, target.length)
  for (let i = 0; i < max; i++) {
    if (typed[i] !== target[i]) return i
  }
  if (typed.length === target.length) return -1
  return typed.length > target.length ? target.length : typed.length
}

function shuffle<T>(values: readonly T[]): T[] {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = result[i] as T
    result[i] = result[j] as T
    result[j] = tmp
  }
  return result
}

function computeRanges(words: readonly string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  for (const word of words) {
    ranges.push({ start, end: start + word.length })
    start += word.length + 1
  }
  return ranges
}

function makeConfetti(): ConfettiPiece[] {
  const pieces: ConfettiPiece[] = []
  for (let i = 0; i < CONFETTI_COUNT; i++) {
    pieces.push({
      left: Math.random() * 100,
      delay: Math.random() * 250,
      duration: 850 + Math.random() * 500,
      size: 6 + Math.random() * 7,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] as string,
      dx: -80 + Math.random() * 160,
    })
  }
  return pieces
}

function formatTime(millis: number): string {
  const total = Math.max(0, Math.ceil(millis / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

const btnBase: CSSProperties = {
  border: 'none',
  borderRadius: 9,
  padding: '9px 13px',
  background: '#29203f',
  color: '#d5c7ff',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 700,
}
const btnGhost: CSSProperties = { ...btnBase, background: 'transparent', color: T.muted }
const btnPrimary: CSSProperties = { ...btnBase, background: T.accent, color: '#fff' }

const wordColors: Record<WordState, string> = {
  correct: T.ok,
  current: '#ffffff',
  error: T.danger,
  upcoming: T.muted,
}

export default function ChallengeModal({ difficulty, onClose }: ChallengeModalProps) {
  const [status, setStatus] = useState<ChallengeStatus>('init')
  const [challenge, setChallenge] = useState<FocusLockChallenge | null>(null)
  const [target, setTarget] = useState('')
  const [typed, setTyped] = useState('')
  const [errorAt, setErrorAt] = useState(0)
  const [mistake, setMistake] = useState(false)
  const [shakeKey, setShakeKey] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [rejectReason, setRejectReason] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState<string | null>(null)

  const dialogRef = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const wordRefs = useRef<Array<HTMLSpanElement | null>>([])
  const statusRef = useRef<ChallengeStatus>('init')
  const targetRef = useRef('')
  const typedRef = useRef('')
  const errorAtRef = useRef(0)
  const startedAtRef = useRef<number | null>(null)
  const composingRef = useRef(false)
  const rejectRef = useRef<(reason: string) => void>(() => {})

  const reject = useCallback((reason: string) => {
    setStatus('rejected')
    setRejectReason(reason)
  }, [])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    rejectRef.current = reject
  }, [reject])

  useEffect(() => {
    errorAtRef.current = errorAt
  }, [errorAt])

  const startChallenge = useCallback(async () => {
    setStatus('init')
    setLoadError(null)
    setRejectReason(null)
    setAnnounce(null)
    setTyped('')
    setErrorAt(0)
    setMistake(false)
    setShakeKey((k) => k + 1)
    typedRef.current = ''
    errorAtRef.current = 0
    startedAtRef.current = null
    composingRef.current = false
    try {
      const next = await window.api.newChallenge(difficulty)
      const sessionTarget = shuffle(next.text.split(' ')).join(' ')
      setChallenge(next)
      setTarget(sessionTarget)
      targetRef.current = sessionTarget
      setNow(Date.now())
      setStatus('typing')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'تعذّر إنشاء التحدي.')
    }
  }, [difficulty])

  useEffect(() => {
    void startChallenge()
  }, [startChallenge])

  useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    const onBeforeInput = (event: Event) => {
      const inputEvent = event as InputEvent
      const kind = inputEvent.inputType
      if (kind === 'insertFromPaste' || kind === 'insertFromDrop' || kind === 'insertReplacementText') {
        event.preventDefault()
        rejectRef.current('تم منع اللصق — يجب كتابة النص حرفًا بحرف.')
      }
    }
    el.addEventListener('beforeinput', onBeforeInput)
    return () => el.removeEventListener('beforeinput', onBeforeInput)
  }, [])

  const cancel = useCallback(() => {
    void window.api.giveup()
    onClose({ status: 'cancelled' })
  }, [onClose])

  const expiresAt = challenge?.expiresAt.getTime() ?? 0
  const remaining = Math.max(0, expiresAt - now)
  const lowTime = status === 'typing' && remaining > 0 && remaining < 60000

  useEffect(() => {
    if (status !== 'typing' || challenge === null) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [status, challenge])

  useEffect(() => {
    if (status === 'typing' && challenge !== null && remaining <= 0) {
      setStatus('expired')
    }
  }, [status, challenge, remaining])

  useEffect(() => {
    if (status !== 'success') return
    const id = window.setTimeout(() => onClose({ status: 'completed', text: target }), SUCCESS_HOLD_MS)
    return () => window.clearTimeout(id)
  }, [status, target, onClose])

  useEffect(() => {
    if (status === 'typing') {
      inputRef.current?.focus()
    }
  }, [status])

  const words = useMemo(() => target.split(' '), [target])
  const ranges = useMemo(() => computeRanges(words), [words])

  const wordStates: WordState[] = words.map((_word, index) => {
    const range = ranges[index] as { start: number; end: number }
    if (errorAt === -1) return 'correct'
    if (range.end <= errorAt) return 'correct'
    if (range.start <= errorAt) return mistake ? 'error' : 'current'
    return 'upcoming'
  })

  const activeIndex = wordStates.findIndex((state) => state === 'current' || state === 'error')

  useEffect(() => {
    const el = wordRefs.current[activeIndex]
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const progressPct = target.length === 0 ? 100 : errorAt === -1 ? 100 : Math.round((errorAt / target.length) * 100)

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (statusRef.current !== 'typing') return
    const value = event.target.value
    if (value.includes('\n') || value.includes('\r')) {
      setTyped(value.replace(/[\r\n]/g, ''))
      return
    }
    const delta = value.length - typedRef.current.length
    if (!composingRef.current && delta > 2) {
      rejectRef.current('تم رصد إدخال متعدد الأحرف في خطوة واحدة (تعبئة تلقائية أو لصق) — يجب الكتابة يدويًا.')
      return
    }
    const currentTarget = targetRef.current
    const currentErrorAt = diffIndex(value, currentTarget)
    const completed = currentErrorAt === -1
    const currentMistake = !completed && currentErrorAt < value.length

    if (currentMistake && errorAtRef.current !== currentErrorAt) {
      setShakeKey((k) => k + 1)
    }

    const correctChars = completed ? currentTarget.length : currentErrorAt
    if (startedAtRef.current === null && correctChars > 0) {
      startedAtRef.current = Date.now()
    }
    const startedAt = startedAtRef.current
    if (startedAt !== null) {
      const elapsed = (Date.now() - startedAt) / 1000
      if (elapsed >= WPM_GRACE_SECONDS && correctChars >= WPM_GRACE_CHARS) {
        const wpm = correctChars / 5 / (elapsed / 60)
        if (wpm > MAX_WPM) {
          rejectRef.current('تم اكتشاف سرعة كتابة تفوق 150 كلمة في الدقيقة — هذا غير ممكن إنسانيا. أعد المحاولة ببطء.')
          return
        }
      }
    }

    typedRef.current = value
    errorAtRef.current = currentErrorAt
    setTyped(value)
    setErrorAt(currentErrorAt)
    setMistake(currentMistake)
    if (completed) {
      setStatus('success')
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setAnnounce('الإغلاق بمفتاح Escape معطّل — أكمل التحدي أو اضغط زر إلغاء.')
      return
    }
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      return
    }
    if ((event.ctrlKey || event.metaKey) && 'vcxaz'.includes(event.key.toLowerCase())) {
      event.preventDefault()
    }
  }

  const handleCompositionStart = () => {
    composingRef.current = true
  }

  const handleCompositionUpdate = (event: CompositionEvent<HTMLTextAreaElement>) => {
    if (event.data !== '' && /[^\x20-\x7E]/.test(event.data)) {
      rejectRef.current('تم رصد إدخال بلوحة مفاتيح بحروف غير لاتينية — يقبل التحدي الإنجليزية فقط. أعد المحاولة.')
    }
  }

  const handleCompositionEnd = () => {
    composingRef.current = false
  }

  const blockEvent = (event: { preventDefault(): void }) => {
    event.preventDefault()
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    blockEvent(event)
    rejectRef.current('تم منع اللصق — يجب كتابة النص حرفًا بحرف.')
  }

  const handleDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    blockEvent(event)
    rejectRef.current('تم منع إسقاط النص — يجب كتابة النص يدويًا.')
  }

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key !== 'Tab') return
    const dialogEl = dialogRef.current
    if (dialogEl === null) return
    const focusable = Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    )
    if (focusable.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusable[0] as HTMLElement
    const last = focusable[focusable.length - 1] as HTMLElement
    const active = document.activeElement
    const inside = dialogEl.contains(active)
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const timeoutStyle: CSSProperties = {
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    background: T.raised,
    border: `1px solid ${T.border}`,
    fontSize: 14,
  }
  const timerColor = lowTime ? T.danger : T.muted

  return (
    <div
      className="ch-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: 'rgba(0,0,0,0.66)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        animation: 'ch-fade 180ms ease-out',
      }}
    >
      <style>{KEYFRAMES}</style>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ch-title"
        aria-describedby="ch-desc"
        dir="rtl"
        onKeyDown={handleDialogKeyDown}
        style={{
          position: 'relative',
          width: 'min(760px, 100%)',
          maxHeight: '92vh',
          overflowY: 'auto',
          boxSizing: 'border-box',
          background: T.panel,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          padding: 20,
          color: T.text,
          animation: 'ch-in 240ms ease-out',
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span
            role="timer"
            aria-label="الوقت المتبقي"
            style={{
              fontVariantNumeric: 'tabular-nums',
              color: timerColor,
              animation: lowTime ? 'ch-pulse 900ms ease-in-out infinite' : undefined,
              fontSize: 14,
            }}
          >
            {formatTime(remaining)}
          </span>
          <h2 id="ch-title" style={{ margin: 0, fontSize: 18 }}>
            أكمل التحدي 🔒
          </h2>
          <button type="button" onClick={cancel} style={btnGhost} aria-label="إلغاء التحدي">
            إلغاء
          </button>
        </header>

        <p id="ch-desc" style={{ margin: '10px 0 0', color: T.muted, fontSize: 13, lineHeight: 1.6 }}>
          اكتب النصوص أدناه حرفًا بحرف بالترتيب المعروض. اللصق والتعويض والكتابة الآلية ممنوعة.
        </p>

        {status !== 'init' && (
          <div
            role="progressbar"
            aria-label="تقدم التحدي"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPct}
            style={{ height: 6, borderRadius: 6, background: T.raised, overflow: 'hidden', marginTop: 16 }}
          >
            <div
              style={{
                height: '100%',
                width: `${progressPct}%`,
                borderRadius: 6,
                background: 'linear-gradient(90deg, #7c3aed, #3ddc84)',
                transition: 'width 220ms ease',
              }}
            />
          </div>
        )}

        <div
          dir="ltr"
          className="ch-words"
          style={{
            marginTop: 14,
            maxHeight: 280,
            overflowY: 'auto',
            padding: '4px 2px',
            fontSize: 19,
            lineHeight: 1.8,
            userSelect: 'none',
          }}
        >
          {words.map((word, index) => {
            const state = wordStates[index] as WordState
            const isActive = state === 'current' || state === 'error'
            return (
              <span
                key={index}
                ref={(el) => {
                  wordRefs.current[index] = el
                }}
                style={{
                  display: 'inline-block',
                  margin: '2px 6px 2px 0',
                  fontFamily: MONO,
                  whiteSpace: 'nowrap',
                  color: wordColors[state],
                  transition: 'color 200ms ease, text-shadow 200ms ease, border-color 200ms ease',
                  textShadow: isActive ? '0 0 12px rgba(124,92,255,0.55)' : undefined,
                  borderBottom: isActive ? `2px solid ${T.accent}` : '2px solid transparent',
                }}
              >
                {word}
              </span>
            )
          })}
        </div>

        <div
          style={{
            marginTop: 12,
            animation:
              mistake && status === 'typing'
                ? shakeKey % 2 === 0
                  ? 'ch-shake 360ms ease'
                  : 'ch-shake-b 360ms ease'
                : undefined,
          }}
        >
          <textarea
            ref={inputRef}
            value={typed}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onCopy={blockEvent}
            onCut={blockEvent}
            onContextMenu={blockEvent}
            onCompositionStart={handleCompositionStart}
            onCompositionUpdate={handleCompositionUpdate}
            onCompositionEnd={handleCompositionEnd}
            disabled={status !== 'typing'}
            maxLength={target.length || undefined}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="اكتب النص المطلوب"
            aria-invalid={mistake}
            aria-describedby="ch-hint"
            placeholder={status === 'typing' ? 'ابدأ الكتابة هنا…' : ''}
            style={{
              width: '100%',
              minHeight: 110,
              resize: 'none',
              boxSizing: 'border-box',
              background: '#0d0d13',
              color: T.text,
              border: `1px solid ${mistake ? T.danger : T.border}`,
              borderRadius: 10,
              padding: '12px 14px',
              fontFamily: MONO,
              fontSize: 17,
              lineHeight: 1.6,
              caretColor: T.accent,
              outline: 'none',
              transition: 'border-color 200ms ease',
              opacity: status === 'typing' ? 1 : 0.55,
            }}
          />
        </div>

        <p
          id="ch-hint"
          role="status"
          aria-live="polite"
          style={{ margin: '8px 0 0', color: mistake ? T.danger : T.muted, fontSize: 13 }}
        >
          {status === 'typing'
            ? mistake
              ? 'يوجد خطأ — أول حرف خاطئ يُحتسب كملكية للتحدي.'
              : 'ابدأ الكتابة — أي خطأ يؤكد جدية الالتزام.'
            : ''}
        </p>

        {announce !== null && status === 'typing' && (
          <p role="status" aria-live="polite" style={{ margin: '8px 0 0', color: T.warn, fontSize: 13 }}>
            {announce}
          </p>
        )}

        {status === 'expired' && (
          <div role="alert" style={timeoutStyle}>
            <p style={{ margin: '0 0 12px', color: T.danger, fontWeight: 700 }}>انتهى وقت التحدي.</p>
            <button type="button" onClick={cancel} style={btnPrimary}>
              إغلاق
            </button>
          </div>
        )}

        {status === 'rejected' && (
          <div role="alert" style={timeoutStyle}>
            <p style={{ margin: '0 0 4px', color: T.danger, fontWeight: 700 }}>تم إجهاض التحدي.</p>
            {rejectReason !== null && <p style={{ margin: '0 0 12px', color: T.text, fontSize: 13 }}>{rejectReason}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => void startChallenge()} style={btnPrimary}>
                إعادة المحاولة بتحدي جديد
              </button>
              <button type="button" onClick={cancel} style={btnGhost}>
                إلغاء
              </button>
            </div>
          </div>
        )}

        {status === 'init' && (
          <div role="status" aria-live="polite" style={timeoutStyle}>
            {loadError !== null ? (
              <>
                <p style={{ margin: '0 0 12px' }}>{loadError}</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => void startChallenge()} style={btnPrimary}>
                    إعادة المحاولة
                  </button>
                  <button type="button" onClick={cancel} style={btnGhost}>
                    إلغاء
                  </button>
                </div>
              </>
            ) : (
              <p style={{ margin: 0 }}>جارٍ تجهيز التحدي…</p>
            )}
          </div>
        )}

        {status === 'success' && (
          <div role="status" aria-live="assertive" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(21,21,29,0.9)',
                borderRadius: 16,
                gap: 10,
              }}
            >
              <svg
                width={72}
                height={72}
                viewBox="0 0 52 52"
                aria-hidden="true"
                style={{ animation: 'ch-pop 420ms cubic-bezier(0.34,1.56,0.64,1)' }}
              >
                <circle cx={26} cy={26} r={24} fill="none" stroke={T.ok} strokeWidth={3} />
                <path
                  d="M14 27l8 8 16-16"
                  fill="none"
                  stroke={T.ok}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <p style={{ margin: 0, color: T.ok, fontWeight: 700, fontSize: 17 }}>تم إكمال التحدي بنجاح!</p>
            </div>
            <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 16 }}>
              {makeConfetti().map((confetti, index) => (
                <span
                  key={index}
                  style={
                    {
                      position: 'absolute',
                      top: -16,
                      left: `${confetti.left}%`,
                      width: confetti.size,
                      height: confetti.size * 0.5,
                      background: confetti.color,
                      borderRadius: 2,
                      animation: `ch-confetti ${confetti.duration}ms ${confetti.delay}ms cubic-bezier(0.25,0.46,0.45,0.94) forwards`,
                      '--dx': `${confetti.dx}px`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}