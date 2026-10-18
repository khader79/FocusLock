import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { FocusLockCategory } from '../env'

const THEME = {
  bg: '#0a0a0f',
  panel: '#12121a',
  panelRaised: '#181822',
  border: '#23232e',
  text: '#e8e8ee',
  muted: '#8b8b98',
  accent: '#7c3aed',
  accentSoft: '#241a3f',
  ok: '#3ddc84',
  off: '#4b4b57',
  danger: '#ff5252',
} as const

interface DashboardStats {
  status: 'active' | 'paused'
  blockedToday: number
  lastUpdate: string | null
  unlockAttempts: number
  categories: FocusLockCategory[]
  customSites: number
  customApps: number
}

type BusyAction = 'toggle' | 'pause' | 'settings'

interface CardBusy {
  id: string
  kind: BusyAction
}

function relativeTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') {
    return '—'
  }
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) {
    return 'just now'
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatCount(value: number | undefined): string {
  if (value === undefined) {
    return '—'
  }
  return value.toLocaleString('en-US')
}

const shared = {
  button: {
    border: 'none',
    borderRadius: 8,
    padding: '7px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    backgroundColor: THEME.accentSoft,
    color: THEME.accent,
    fontFamily: 'inherit',
  } as const,
  buttonPrimary: {
    border: 'none',
    borderRadius: 10,
    padding: '8px 18px',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
    backgroundColor: THEME.accent,
    color: '#fff',
    fontFamily: 'inherit',
  } as const,
  buttonDanger: {
    border: 'none',
    borderRadius: 8,
    padding: '7px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    backgroundColor: 'transparent',
    color: THEME.danger,
    fontFamily: 'inherit',
  } as const,
  input: {
    width: '100%',
    backgroundColor: THEME.bg,
    color: THEME.text,
    border: `1px solid ${THEME.border}`,
    borderRadius: 10,
    padding: '9px 12px',
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
  } as const,
  mutedText: {
    color: THEME.muted,
    fontSize: 12,
  } as const,
}

function statCard(
  icon: string,
  label: string,
  value: string,
  color?: string,
): React.ReactElement {
  return (
    <div
      style={{
        backgroundColor: THEME.panel,
        border: `1px solid ${THEME.border}`,
        borderRadius: 14,
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <span style={{ fontSize: 28 }}>{icon}</span>
      <span style={{ color: THEME.muted, fontSize: 12 }}>{label}</span>
      <span style={{ color: color ?? THEME.text, fontSize: 20, fontWeight: 800 }}>{value}</span>
    </div>
  )
}

function CategoryRow({
  category,
  busy,
  onToggle,
}: {
  category: FocusLockCategory
  busy: CardBusy | null
  onToggle: (category: FocusLockCategory) => void
}) {
  const disabled = busy !== null && busy.id === category.id && busy.kind === 'toggle'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        backgroundColor: THEME.panel,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 22 }}>{category.icon}</span>
        <span style={{ color: THEME.text, fontSize: 14, fontWeight: 600 }}>
          {category.name}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ color: THEME.muted, fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
          {formatCount(category.count ?? category.expectedCount)}
        </span>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
          title={category.enabled ? 'Disable' : 'Enable'}
        >
          <input
            type="checkbox"
            checked={category.enabled}
            disabled={disabled}
            onChange={() => onToggle(category)}
            style={{ display: 'none' }}
          />
          <span
            style={{
              width: 40,
              height: 22,
              borderRadius: 11,
              backgroundColor: category.enabled ? THEME.accent : THEME.off,
              position: 'relative',
              transition: 'background-color 150ms ease',
              display: 'inline-block',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 3,
                right: category.enabled ? 3 : 19,
                width: 16,
                height: 16,
                borderRadius: 8,
                backgroundColor: '#fff',
                transition: 'right 150ms ease',
              }}
            />
          </span>
        </label>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    status: 'active',
    blockedToday: 0,
    lastUpdate: null,
    unlockAttempts: 0,
    categories: [],
    customSites: 0,
    customApps: 0,
  })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<CardBusy | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showAddSite, setShowAddSite] = useState(false)
  const [showAddApp, setShowAddApp] = useState(false)
  const [siteInput, setSiteInput] = useState('')
  const [appInput, setAppInput] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pauseLoading, setPauseLoading] = useState(false)
  const wsConnectedRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const categories = await window.api.categoriesList()
      const customSitesResult = (await window.api.listSites?.().catch(() => []) ?? []) as { id: number; domain: string }[]
      setStats((current) => ({ ...current, categories, customSites: customSitesResult.length }))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to load dashboard data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // SSE-based real-time updates from main process
  useEffect(() => {
    let cancelled = false

    function connectSSE(): void {
      if (cancelled) return

      try {
        const evtSource = new EventSource(`${window.location.origin}/api/stream`)
        eventSourceRef.current = evtSource

        evtSource.addEventListener('open', () => {
          wsConnectedRef.current = true
        })

        evtSource.addEventListener('state-change', (event) => {
          try {
            const data = JSON.parse(event.data)
            if (cancelled) return
            setStats((current) => ({
              ...current,
              ...data,
            }))
          } catch {
            // Ignore parse errors
          }
        })

        evtSource.addEventListener('stats-update', (event) => {
          try {
            const data = JSON.parse(event.data)
            if (cancelled) return
            setStats((current) => ({
              ...current,
              ...data,
            }))
          } catch {
            // Ignore parse errors
          }
        })

        evtSource.addEventListener('error', () => {
          wsConnectedRef.current = false
          evtSource.close()
          if (!cancelled) {
            reconnectTimerRef.current = setTimeout(() => {
              connectSSE()
            }, 3000)
          }
        })
      } catch {
        // Fallback to polling if SSE is unavailable
        if (!cancelled) {
          reconnectTimerRef.current = setTimeout(() => {
            void refresh()
            connectSSE()
          }, 5000)
        }
      }
    }

    connectSSE()

    return () => {
      cancelled = true
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [refresh])

  // Also poll as a fallback every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh()
    }, 30000)
    return () => clearInterval(timer)
  }, [refresh])

  const showNotice = useCallback((message: string): void => {
    setNotice(message)
    window.setTimeout(() => setNotice(null), 4000)
  }, [])

  const handleToggleCategory = useCallback(
    (category: FocusLockCategory): void => {
      setBusy({ id: category.id, kind: 'toggle' })
      window.api
        .toggleCategory(category.id)
        .then((ok) => {
          if (ok) {
            void refresh()
            showNotice(
              category.enabled ? 'Category disabled.' : 'Category enabled.',
            )
          }
        })
        .catch((err) => {
          showNotice(err instanceof Error ? err.message : 'Failed to toggle category.')
        })
        .finally(() => setBusy(null))
    },
    [refresh, showNotice],
  )

  const handlePause = useCallback(async (): Promise<void> => {
    setPauseLoading(true)
    try {
      await window.api.toggleSilentMode()
      const enabled = await window.api.getSilentMode()
      setStats((current) => ({ ...current, status: enabled ? 'paused' : 'active' }))
      showNotice(enabled ? 'FocusLock paused.' : 'FocusLock resumed.')
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Failed to toggle pause.')
    } finally {
      setPauseLoading(false)
    }
  }, [showNotice])

  const handleAddSite = useCallback(
    (event: FormEvent): void => {
      event.preventDefault()
      const domain = siteInput.trim()
      if (!domain) return
      const sites = (stats.customSites ?? 0) + 1
      setStats((current) => ({ ...current, customSites: sites }))
      setSiteInput('')
      setShowAddSite(false)
      showNotice(`Site "${domain}" added.`)
    },
    [siteInput, stats.customSites, showNotice],
  )

  const handleAddApp = useCallback(
    (event: FormEvent): void => {
      event.preventDefault()
      const name = appInput.trim()
      if (!name) return
      const apps = (stats.customApps ?? 0) + 1
      setStats((current) => ({ ...current, customApps: apps }))
      setAppInput('')
      setShowAddApp(false)
      showNotice(`App "${name}" added.`)
    },
    [appInput, stats.customApps, showNotice],
  )

  const activeCategories = stats.categories.filter((category) => category.enabled)
  const totalBlocked = activeCategories.reduce(
    (sum, category) => sum + (category.count ?? category.expectedCount ?? 0),
    0,
  )

  if (loading) {
    return (
      <div
        dir="rtl"
        style={{
          minHeight: '100vh',
          backgroundColor: THEME.bg,
          color: THEME.text,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <span style={{ color: THEME.muted, fontSize: 16 }}>جاري التحميل…</span>
      </div>
    )
  }

  return (
    <div
      dir="rtl"
      style={{
        minHeight: '100vh',
        backgroundColor: THEME.bg,
        color: THEME.text,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        padding: '16px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          maxWidth: 900,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            backgroundColor: THEME.panel,
            border: `1px solid ${THEME.border}`,
            borderRadius: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 28 }}>🔒</span>
            <div>
              <h1
                style={{
                  margin: 0,
                  fontSize: 22,
                  fontWeight: 800,
                  color: THEME.text,
                  letterSpacing: '-0.3px',
                }}
              >
                FocusLock
              </h1>
              <span style={{ color: THEME.muted, fontSize: 12 }}>
                Dashboard
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              style={{
                ...shared.button,
                backgroundColor: THEME.panelRaised,
                fontSize: 18,
                padding: '6px 10px',
                cursor: 'pointer',
              }}
              title="Settings"
            >
              ⚙️
            </button>
            <button
              type="button"
              onClick={handlePause}
              disabled={pauseLoading}
              style={{
                ...shared.button,
                backgroundColor: THEME.panelRaised,
                fontSize: 18,
                padding: '6px 10px',
                cursor: pauseLoading ? 'not-allowed' : 'pointer',
                opacity: pauseLoading ? 0.5 : 1,
              }}
              title="Pause / Resume"
            >
              ⏸️
            </button>
          </div>
        </header>

        {/* Notice */}
        {notice !== null && (
          <div
            role="status"
            style={{
              backgroundColor: THEME.panelRaised,
              border: `1px solid ${THEME.accent}`,
              borderRadius: 10,
              padding: '10px 14px',
              color: THEME.accent,
              fontSize: 13,
              fontWeight: 600,
              textAlign: 'center',
            }}
          >
            {notice}
          </div>
        )}

        {/* Status Section */}
        <section>
          <h2
            style={{
              margin: '0 0 10px',
              fontSize: 15,
              fontWeight: 700,
              color: THEME.text,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ color: THEME.ok }}>●</span> Status
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
            }}
          >
            {statCard(
              stats.status === 'active' ? '🟢' : '🔴',
              'Status',
              stats.status === 'active' ? 'Active' : 'Paused',
              THEME.ok,
            )}
            {statCard('🚫', 'Blocked Today', formatCount(totalBlocked) ?? '—')}
            {statCard(
              '⏱️',
              'Last Update',
              relativeTime(stats.lastUpdate ?? undefined),
              THEME.muted,
            )}
            {statCard('📊', 'Unlock Attempts', String(stats.unlockAttempts))}
          </div>
        </section>

        {/* Active Categories */}
        <section>
          <h2
            style={{
              margin: '0 0 10px',
              fontSize: 15,
              fontWeight: 700,
              color: THEME.text,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>📂</span> Active Categories
          </h2>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {stats.categories
              .filter((category) => category.enabled)
              .map((category) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  busy={busy}
                  onToggle={handleToggleCategory}
                />
              ))}
            {stats.categories.filter((category) => category.enabled).length === 0 && (
              <p style={{ color: THEME.muted, textAlign: 'center', padding: '24px 0' }}>
                No active categories.
              </p>
            )}
            {stats.categories
              .filter((category) => !category.enabled)
              .map((category) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  busy={busy}
                  onToggle={handleToggleCategory}
                />
              ))}
          </div>
        </section>

        {/* Custom Sites & Apps */}
        <section>
          <h2
            style={{
              margin: '0 0 10px',
              fontSize: 15,
              fontWeight: 700,
              color: THEME.text,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>📝</span> Custom Content
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 12,
            }}
          >
            <div
              style={{
                backgroundColor: THEME.panel,
                border: `1px solid ${THEME.border}`,
                borderRadius: 14,
                padding: '16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ color: THEME.muted, fontSize: 13 }}>Custom Sites</div>
                <div style={{ color: THEME.text, fontSize: 28, fontWeight: 800 }}>
                  {stats.customSites}
                </div>
              </div>
              <span style={{ fontSize: 24 }}>🌐</span>
            </div>
            <div
              style={{
                backgroundColor: THEME.panel,
                border: `1px solid ${THEME.border}`,
                borderRadius: 14,
                padding: '16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ color: THEME.muted, fontSize: 13 }}>Custom Apps</div>
                <div style={{ color: THEME.text, fontSize: 28, fontWeight: 800 }}>
                  {stats.customApps}
                </div>
              </div>
              <span style={{ fontSize: 24 }}>📱</span>
            </div>
          </div>
        </section>

        {/* Action Buttons */}
        <section
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 20px',
            backgroundColor: THEME.panel,
            border: `1px solid ${THEME.border}`,
            borderRadius: 14,
          }}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setShowAddSite(true)}
              style={shared.buttonPrimary}
            >
              + Add Site
            </button>
            <button
              type="button"
              onClick={() => setShowAddApp(true)}
              style={shared.button}
            >
              + Add App
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              style={{ ...shared.button, backgroundColor: THEME.accent, color: '#fff' }}
            >
              🔒 Settings
            </button>
            <button
              type="button"
              onClick={handlePause}
              disabled={pauseLoading}
              style={{
                ...shared.button,
                backgroundColor: THEME.danger,
                color: '#fff',
                opacity: pauseLoading ? 0.5 : 1,
              }}
            >
              ⏸️ Pause 🔒
            </button>
          </div>
        </section>

        {/* Real-time indicator */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: 8,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: wsConnectedRef.current ? THEME.ok : THEME.off,
              display: 'inline-block',
              transition: 'background-color 300ms ease',
            }}
          />
          <span style={{ color: THEME.muted, fontSize: 12 }}>
            {wsConnectedRef.current ? 'Real-time connected' : 'Reconnecting…'}
          </span>
        </div>
      </div>

      {/* Add Site Modal */}
      {showAddSite && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setShowAddSite(false)}
        >
          <form
            onSubmit={handleAddSite}
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(440px, 92vw)',
              backgroundColor: THEME.panel,
              border: `1px solid ${THEME.border}`,
              borderRadius: 14,
              padding: '20px 22px',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 17, color: THEME.text }}>Add Custom Site</h2>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: THEME.muted }}>
              Domain
              <input
                value={siteInput}
                onChange={(event) => setSiteInput(event.target.value)}
                placeholder="example.com"
                dir="ltr"
                style={shared.input}
                autoFocus
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowAddSite(false)}
                style={{ ...shared.button, backgroundColor: 'transparent', color: THEME.muted }}
              >
                Cancel
              </button>
              <button type="submit" style={shared.buttonPrimary}>
                Add Site
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add App Modal */}
      {showAddApp && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setShowAddApp(false)}
        >
          <form
            onSubmit={handleAddApp}
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(440px, 92vw)',
              backgroundColor: THEME.panel,
              border: `1px solid ${THEME.border}`,
              borderRadius: 14,
              padding: '20px 22px',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 17, color: THEME.text }}>Add Custom App</h2>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: THEME.muted }}>
              Application Name
              <input
                value={appInput}
                onChange={(event) => setAppInput(event.target.value)}
                placeholder="e.g., chrome.exe"
                style={shared.input}
                autoFocus
              />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowAddApp(false)}
                style={{ ...shared.button, backgroundColor: 'transparent', color: THEME.muted }}
              >
                Cancel
              </button>
              <button type="submit" style={shared.buttonPrimary}>
                Add App
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            style={{
              width: 'min(500px, 92vw)',
              backgroundColor: THEME.panel,
              border: `1px solid ${THEME.border}`,
              borderRadius: 14,
              padding: '24px 22px',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: 18, color: THEME.text }}>⚙️ Settings</h2>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                style={{ ...shared.button, backgroundColor: 'transparent', color: THEME.muted }}
              >
                ✕
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: THEME.muted, fontSize: 14 }}>
                <span>Status</span>
                <span style={{ color: stats.status === 'active' ? THEME.ok : THEME.danger, fontWeight: 700 }}>
                  {stats.status === 'active' ? '🟢 Active' : '🔴 Paused'}
                </span>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, color: THEME.muted, fontSize: 14 }}>
                <span>Accent Color</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['#7c3aed', '#3ddc84', '#ff5252', '#f39c12', '#3498db'].map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => {}}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        backgroundColor: color,
                        border: color === THEME.accent ? '3px solid #fff' : '3px solid transparent',
                        cursor: 'pointer',
                      }}
                    />
                  ))}
                </div>
              </label>
            </div>
            <button
              type="button"
              onClick={() => {
                void handlePause()
                setSettingsOpen(false)
              }}
              style={{ ...shared.buttonPrimary, backgroundColor: THEME.danger }}
            >
              ⏸️ Pause / Resume
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
