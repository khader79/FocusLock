import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { FocusLockChallenge } from './env'

const DIFFICULTY_MINUTES: Record<number, number> = {
  1: 5,
  2: 10,
  3: 20,
  4: 30,
  5: 60,
}

const COLORS = {
  background: '#0b0b0f',
  text: '#eee',
  muted: '#6f6f7a',
  correct: '#3ddc84',
  error: '#ff5252',
  surface: '#15151c',
  border: '#2a2a33',
  accent: '#7c5cff',
}

const styles = {
  page: {
    minHeight: '100vh',
    backgroundColor: COLORS.background,
    color: COLORS.text,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  } as const,
  card: {
    width: 'min(920px, 92vw)',
    backgroundColor: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: '32px 36px',
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  } as const,
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as const,
  slider: {
    width: '100%',
    accentColor: COLORS.accent,
  } as const,
  button: {
    backgroundColor: COLORS.accent,
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '14px 28px',
    fontSize: 18,
    fontWeight: 600,
    cursor: 'pointer',
  } as const,
  ghostButton: {
    backgroundColor: 'transparent',
    color: COLORS.muted,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    padding: '8px 16px',
    fontSize: 14,
    cursor: 'pointer',
  } as const,
  target: {
    fontFamily: "'JetBrains Mono', 'Consolas', monospace",
    fontSize: 26,
    lineHeight: 1.6,
    letterSpacing: '0.5px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    userSelect: 'none',
  } as const,
  input: {
    width: '100%',
    minHeight: 120,
    backgroundColor: COLORS.background,
    color: COLORS.text,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    padding: 14,
    fontSize: 22,
    lineHeight: 1.6,
    fontFamily: "'JetBrains Mono', 'Consolas', monospace",
    resize: 'none',
    caretColor: COLORS.accent,
    outline: 'none',
  } as const,
  title: {
    fontSize: 32,
    fontWeight: 700,
    margin: 0,
  } as const,
  hint: {
    color: COLORS.muted,
    margin: 0,
  } as const,
}

function formatTime(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds)
  const minutes = Math.floor(clamped / 60)
  const seconds = clamped % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function blockEvent(event: { preventDefault: () => void }): void {
  event.preventDefault()
}

function renderColoredTarget(text: string, errorAt: number, typedLength: number): ReactNode {
  const chars: ReactNode[] = []

  for (let i = 0; i < text.length; i++) {
    let color = COLORS.muted

    if (errorAt === -1 && i < typedLength) {
      color = COLORS.correct
    } else if (i < errorAt) {
      color = COLORS.correct
    } else if (i === errorAt && errorAt < text.length) {
      color = COLORS.error
    }

    chars.push(
      <span key={i} style={{ color }}>
        {text[i]}
      </span>,
    )
  }

  return chars
}

export default function App() {
  const [challenge, setChallenge] = useState<FocusLockChallenge | null>(null)
  const [typed, setTyped] = useState('')
  const [errorAt, setErrorAt] = useState(0)
  const [progress, setProgress] = useState(0)
  const [difficulty, setDifficulty] = useState(1)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [unlocked, setUnlocked] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resetAll = useCallback((): void => {
    setChallenge(null)
    setTyped('')
    setErrorAt(0)
    setProgress(0)
    setSecondsLeft(0)
    setUnlocked(false)
    setDifficulty(1)
  }, [])

  const handleGiveUp = useCallback((): void => {
    window.api
      .giveup()
      .catch(() => undefined)
      .finally(() => {
        resetAll()
      })
  }, [resetAll])

  useEffect(() => {
    if (challenge === null || unlocked) {
      return
    }

    const updateSecondsLeft = (): void => {
      const remaining = Math.max(0, Math.ceil((challenge.expiresAt.getTime() - Date.now()) / 1000))
      setSecondsLeft(remaining)
    }

    updateSecondsLeft()
    const timer = setInterval(updateSecondsLeft, 1000)
    return () => clearInterval(timer)
  }, [challenge, unlocked])

  useEffect(() => {
    if (challenge !== null && !unlocked && secondsLeft === 0) {
      handleGiveUp()
    }
  }, [secondsLeft, challenge, unlocked, handleGiveUp])

  useEffect(() => {
    if (challenge !== null && !unlocked) {
      textareaRef.current?.focus()
    }
  }, [challenge, unlocked])

  function handleCloseUnlocked(): void {
    resetAll()
  }

  function startChallenge(): void {
    window.api
      .newChallenge(difficulty)
      .then((next) => {
        setChallenge(next)
        setTyped('')
        setErrorAt(0)
        setProgress(0)
        setUnlocked(false)
        setSecondsLeft(Math.ceil((next.expiresAt.getTime() - Date.now()) / 1000))
        textareaRef.current?.focus()
      })
      .catch((err) => {
        console.error('failed to start challenge:', err)
      })
  }

  function handleTypedChange(value: string): void {
    if (challenge === null) {
      return
    }

    const next = value
    setTyped(next)

    window.api
      .check(next)
      .then((result) => {
        setErrorAt(result.ok ? -1 : result.errorAt)
        setProgress(result.progress)
        if (result.ok) {
          setUnlocked(true)
        }
      })
      .catch((err) => {
        console.error('failed to check challenge:', err)
      })
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase()
      if ('vcxazy'.includes(key)) {
        event.preventDefault()
      }
    }
  }

  if (unlocked && challenge !== null) {
    return (
      <div style={styles.page} dir="rtl">
        <div style={styles.card}>
          <div style={{ fontSize: 96, textAlign: 'center' }}>✅</div>
          <h1 style={styles.title}>انفتح</h1>
          <p style={styles.hint}>أنهيت التحدي في الوقت المحدد. أنت حر الآن.</p>
          <button style={styles.button} onClick={handleCloseUnlocked}>
            العودة للبداية
          </button>
        </div>
      </div>
    )
  }

  if (challenge === null) {
    return (
      <div style={styles.page} dir="rtl">
        <div style={styles.card}>
          <h1 style={styles.title}>FocusLock</h1>
          <p style={styles.hint}>اغلق شاشاتك واكتب النص خلال المهلة. خروجٌ واحد = فشل.</p>

          <label style={{ color: COLORS.muted }}>
            المستوى: <strong style={{ color: COLORS.text }}>{difficulty}</strong>
          </label>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={difficulty}
            onChange={(event) => setDifficulty(Number(event.target.value))}
            style={styles.slider}
          />

          <p style={styles.hint}>
            الوقت المتوقع:{' '}
            <strong style={{ color: COLORS.text }}>
              {formatTime((DIFFICULTY_MINUTES[difficulty] ?? 0) * 60)}
            </strong>
          </p>

          <button style={styles.button} onClick={startChallenge}>
            ابدأ
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page} dir="rtl">
      <div style={styles.card}>
        <div style={styles.topBar}>
          <div style={styles.hint}>⏱ {formatTime(secondsLeft)}</div>
          <div style={styles.hint}>
            الإنجاز: <strong style={{ color: COLORS.text }}>{Math.round(progress * 100)}%</strong>
          </div>
          <button style={styles.ghostButton} onClick={handleGiveUp}>
            استسلام
          </button>
        </div>

        <div style={styles.target}>
          {renderColoredTarget(challenge.text, errorAt, typed.length)}
        </div>

        <textarea
          ref={textareaRef}
          value={typed}
          maxLength={challenge.text.length}
          onChange={(event) => handleTypedChange(event.target.value)}
          onKeyDown={handleTextareaKeyDown}
          onPaste={blockEvent}
          onCopy={blockEvent}
          onCut={blockEvent}
          onContextMenu={blockEvent}
          onDrop={blockEvent}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          style={styles.input}
        />
      </div>
    </div>
  )
}
