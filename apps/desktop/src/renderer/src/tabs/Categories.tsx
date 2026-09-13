import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import type {
  FocusLockAddCustomCategoryInput,
  FocusLockCategory,
  FocusLockPatternSearchResult,
} from '../env'

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

type Filter = 'all' | 'enabled' | 'disabled'
type SortKey = 'name' | 'count' | 'updated'

const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'name', label: 'الاسم' },
  { key: 'count', label: 'عدد النطاقات' },
  { key: 'updated', label: 'آخر تحديث' },
]

const FILTER_OPTIONS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: 'الكل' },
  { key: 'enabled', label: 'مفعّلة' },
  { key: 'disabled', label: 'معطّلة' },
]

function relativeTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') {
    return 'لم يُحدَّث بعد'
  }
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) {
    return 'الآن'
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `قبل ${minutes} دقيقة`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `قبل ${hours} ساعة`
  }
  const days = Math.floor(hours / 24)
  return `قبل ${days} يوم`
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

type BusyAction = 'toggle' | 'update' | 'remove'

interface CardBusy {
  id: string
  kind: BusyAction
}

function CardActions({
  category,
  onToggle,
  onUpdate,
  onViewPatterns,
  busy,
}: {
  category: FocusLockCategory
  onToggle: (category: FocusLockCategory) => void
  onUpdate: (category: FocusLockCategory) => void
  onViewPatterns: (category: FocusLockCategory) => void
  busy: CardBusy | null
}) {
  const toggleDisabled = busy !== null && busy.id === category.id
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: toggleDisabled ? 'not-allowed' : 'pointer',
          fontSize: 13,
          color: THEME.muted,
        }}
        title={category.enabled ? 'إيقاف (يتطلب تحديًا)' : 'تفعيل'}
      >
        <input
          type="checkbox"
          checked={category.enabled}
          disabled={toggleDisabled}
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
            flexShrink: 0,
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
        <span style={{ color: category.enabled ? THEME.ok : THEME.muted, flexShrink: 0 }}>
          {category.enabled ? 'مفعّلة' : 'معطّلة'}
        </span>
      </label>

      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={shared.button} onClick={() => onViewPatterns(category)}>
          عرض النطاقات
        </button>
        <button
          type="button"
          style={shared.button}
          disabled={toggleDisabled}
          onClick={() => onUpdate(category)}
        >
          {busy?.id === category.id && busy.kind === 'update' ? 'جارٍ التحديث…' : 'تحديث'}
        </button>
      </div>
    </div>
  )
}

function CategoryCard({
  category,
  busy,
  onToggle,
  onUpdate,
  onViewPatterns,
  onRemove,
}: {
  category: FocusLockCategory
  busy: CardBusy | null
  onToggle: (category: FocusLockCategory) => void
  onUpdate: (category: FocusLockCategory) => void
  onViewPatterns: (category: FocusLockCategory) => void
  onRemove: (category: FocusLockCategory) => void
}) {
  return (
    <article
      style={{
        backgroundColor: THEME.panel,
        border: `1px solid ${THEME.border}`,
        borderRadius: 14,
        padding: '16px 16px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontSize: 28,
            width: 48,
            height: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: THEME.panelRaised,
            borderRadius: 12,
            flexShrink: 0,
          }}
        >
          {category.icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <h3
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 700,
              color: THEME.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {category.name}
          </h3>
          <span
            style={{
              display: 'inline-block',
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 999,
              marginTop: 4,
              color: category.enabled ? THEME.ok : THEME.muted,
              backgroundColor: category.enabled ? 'rgba(61,220,132,0.12)' : THEME.panelRaised,
            }}
          >
            {category.enabled ? 'مفعّلة' : 'معطّلة'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: THEME.text }}>
            {formatCount(category.count ?? category.expectedCount)}
          </div>
          <div style={shared.mutedText}>نطاق محظور</div>
        </div>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: 13, color: THEME.text }}>{relativeTime(category.lastUpdatedAt)}</div>
          <div style={shared.mutedText}>آخر تحديث</div>
        </div>
      </div>

      <CardActions
        category={category}
        onToggle={onToggle}
        onUpdate={onUpdate}
        onViewPatterns={onViewPatterns}
        busy={busy}
      />

      {category.kind === 'custom' && (
        <button
          type="button"
          style={{ ...shared.buttonDanger, alignSelf: 'flex-start' }}
          onClick={() => onRemove(category)}
        >
          حذف
        </button>
      )}
    </article>
  )
}

function PatternsModal({
  category,
  onClose,
}: {
  category: FocusLockCategory
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<FocusLockPatternSearchResult>({ total: 0, domains: [] })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      window.api
        .searchCategoryPatterns(category.id, query)
        .then((res) => {
          if (cancelled) {
            return
          }
          setResult(res)
          setLoading(false)
        })
        .catch(() => {
          if (cancelled) {
            return
          }
          setResult({ total: 0, domains: [] })
          setLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [category.id, query])

  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(720px, 92vw)',
          maxHeight: '80vh',
          backgroundColor: THEME.panel,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: `1px solid ${THEME.border}` }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20 }}>{category.icon}</span>
            <strong style={{ color: THEME.text, fontSize: 15 }}>نطاقات: {category.name}</strong>
          </div>
          <button type="button" onClick={onClose} style={{ ...shared.button, backgroundColor: 'transparent', color: THEME.muted }}>
            إغلاق
          </button>
        </div>

        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${THEME.border}` }}>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ابحث في النطاقات…"
            style={shared.input}
          />
        </div>

        <div style={{ padding: '6px 16px', ...shared.mutedText }}>
          {loading ? 'جارٍ البحث…' : `${result.total.toLocaleString('en-US')} نتيجة`}
        </div>

        <div style={{ overflowY: 'auto', padding: '0 16px 16px' }}>
          {result.domains.length === 0 ? (
            <p style={{ ...shared.mutedText, textAlign: 'center', padding: '24px 0' }}>
              لا توجد نتائج
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {result.domains.map((domain) => (
                <li
                  key={domain}
                  dir="ltr"
                  style={{
                    textAlign: 'left',
                    fontFamily: "'JetBrains Mono', 'Consolas', monospace",
                    fontSize: 13,
                    color: THEME.text,
                    padding: '6px 8px',
                    borderRadius: 6,
                  }}
                >
                  {domain}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function AddCategoryDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => void
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState<string>(THEME.accent)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const validate = useCallback((input: FocusLockAddCustomCategoryInput): string | null => {
    if (input.name.trim() === '') {
      return 'أدخل اسمًا للفئة.'
    }
    let parsed: URL
    try {
      parsed = new URL(input.url.trim())
    } catch {
      return 'الرابط غير صالح.'
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'يجب أن يكون الرابط http أو https.'
    }
    return null
  }, [])

  const handleSubmit = useCallback(
    async (event: FormEvent): Promise<void> => {
      event.preventDefault()
      const validationError = validate({ name, url, color })
      if (validationError !== null) {
        setError(validationError)
        return
      }
      setBusy(true)
      setError(null)
      try {
        await window.api.addCustomCategory({ name, url, color })
        onAdded()
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'تعذّرت إضافة الفئة.')
        setBusy(false)
      }
    },
    [name, url, color, validate, onAdded, onClose],
  )

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
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
        onClick={(event) => event.stopPropagation()}
      >
        <h2 style={{ margin: 0, fontSize: 17, color: THEME.text }}>فئة مخصّصة جديدة</h2>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: THEME.muted }}>
          الاسم
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="مثال: أخبار الرياضة"
            style={shared.input}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: THEME.muted }}>
          رابط القائمة
          <input
            dir="ltr"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/list.txt"
            style={{ ...shared.input, textAlign: 'left' }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: THEME.muted }}>
          اللون
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            style={{
              width: '56px',
              height: 34,
              padding: 0,
              border: `1px solid ${THEME.border}`,
              borderRadius: 8,
              backgroundColor: THEME.bg,
              cursor: 'pointer',
            }}
          />
        </label>

        {error !== null && <p style={{ margin: 0, color: THEME.danger, fontSize: 13 }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button type="button" style={{ ...shared.button, backgroundColor: 'transparent', color: THEME.muted }} onClick={onClose}>
            إلغاء
          </button>
          <button type="submit" style={shared.buttonPrimary} disabled={busy}>
            {busy ? 'جارٍ التنزيل…' : 'إضافة وتفعيل'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function Categories() {
  const [categories, setCategories] = useState<FocusLockCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [busy, setBusy] = useState<CardBusy | null>(null)
  const [patternsCategory, setPatternsCategory] = useState<FocusLockCategory | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setCategories(await window.api.categoriesList())
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'فشل تحميل الفئات.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const showNotice = useCallback((message: string): void => {
    setNotice(message)
    window.setTimeout(() => setNotice(null), 4000)
  }, [])

  const handleToggle = useCallback(
    (category: FocusLockCategory): void => {
      setBusy({ id: category.id, kind: 'toggle' })
      window.api
        .toggleCategory(category.id)
        .then((ok) => {
          if (ok) {
            void refresh()
          }
        })
        .catch((err) => {
          showNotice(err instanceof Error ? err.message : 'تعذّر تبديل الحالة.')
        })
        .finally(() => setBusy(null))
    },
    [refresh, showNotice],
  )

  const handleUpdate = useCallback(
    (category: FocusLockCategory): void => {
      setBusy({ id: category.id, kind: 'update' })
      window.api
        .updateCategory(category.id)
        .then((result) => {
          if (result.status === 'not-modified') {
            showNotice('القائمة محدّثة بالفعل.')
          }
          void refresh()
        })
        .catch((err) => {
          showNotice(err instanceof Error ? err.message : 'تعذّر تحديث الفئة.')
        })
        .finally(() => setBusy(null))
    },
    [refresh, showNotice],
  )

  const handleRemove = useCallback(
    (category: FocusLockCategory): void => {
      setBusy({ id: category.id, kind: 'remove' })
      window.api
        .removeCustomCategory(category.id)
        .then(() => void refresh())
        .catch((err) => {
          showNotice(err instanceof Error ? err.message : 'تعذّر حذف الفئة.')
        })
        .finally(() => setBusy(null))
    },
    [refresh, showNotice],
  )

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const filtered = categories.filter((category) => {
      if (filter === 'enabled' && !category.enabled) {
        return false
      }
      if (filter === 'disabled' && category.enabled) {
        return false
      }
      if (needle !== '' && !category.name.toLowerCase().includes(needle) && !category.name_en?.toLowerCase().includes(needle)) {
        return false
      }
      return true
    })

    const sorted = [...filtered]
    switch (sortKey) {
      case 'count':
        sorted.sort((a, b) => (b.count ?? b.expectedCount ?? 0) - (a.count ?? a.expectedCount ?? 0))
        break
      case 'updated':
        sorted.sort((a, b) => {
          const at = a.lastUpdatedAt === undefined ? 0 : new Date(a.lastUpdatedAt).getTime()
          const bt = b.lastUpdatedAt === undefined ? 0 : new Date(b.lastUpdatedAt).getTime()
          return bt - at
        })
        break
      case 'name':
      default:
        sorted.sort((a, b) => a.name.localeCompare(b.name, 'ar'))
        break
    }
    return sorted
  }, [categories, search, filter, sortKey])

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: THEME.muted }}>جارٍ التحميل…</div>
    )
  }

  return (
    <div style={{ padding: '76px clamp(16px, 4vw, 40px) 60px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: THEME.text }}>الفئات</h1>
          <p style={{ margin: '4px 0 0', color: THEME.muted, fontSize: 13 }}>
            إدارة قوائم الحجب الجاهزة والمخصّصة.
          </p>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="بحث عن فئة…"
            style={{ ...shared.input, maxWidth: 280, flexGrow: 1 }}
          />

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div
              style={{
                display: 'flex',
                backgroundColor: THEME.panel,
                border: `1px solid ${THEME.border}`,
                borderRadius: 10,
                padding: 4,
              }}
            >
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setFilter(option.key)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    borderRadius: 8,
                    padding: '6px 14px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    color: filter === option.key ? '#fff' : THEME.muted,
                    backgroundColor: filter === option.key ? THEME.accent : 'transparent',
                    fontFamily: 'inherit',
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <select
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as SortKey)}
              style={{ ...shared.input, width: 'auto', cursor: 'pointer' }}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  ترتيب: {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {notice !== null && (
          <div
            style={{
              backgroundColor: THEME.panel,
              border: `1px solid ${THEME.border}`,
              borderRadius: 10,
              padding: '10px 14px',
              color: THEME.text,
              fontSize: 13,
            }}
          >
            {notice}
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 14,
          }}
        >
          {visible.map((category) => (
            <CategoryCard
              key={category.id}
              category={category}
              busy={busy}
              onToggle={handleToggle}
              onUpdate={handleUpdate}
              onViewPatterns={setPatternsCategory}
              onRemove={handleRemove}
            />
          ))}
        </div>

        {visible.length === 0 && (
          <p style={{ color: THEME.muted, textAlign: 'center', padding: '40px 0' }}>
            لا توجد فئات مطابقة.
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 6 }}>
          <button type="button" style={shared.buttonPrimary} onClick={() => setShowAddDialog(true)}>
            + إضافة فئة مخصّصة
          </button>
        </div>
      </div>

      {patternsCategory !== null && (
        <PatternsModal category={patternsCategory} onClose={() => setPatternsCategory(null)} />
      )}
      {showAddDialog && (
        <AddCategoryDialog onClose={() => setShowAddDialog(false)} onAdded={() => void refresh()} />
      )}
    </div>
  )
}