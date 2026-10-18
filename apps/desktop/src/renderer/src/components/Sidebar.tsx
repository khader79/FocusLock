import { useCallback, useEffect, useRef, useState } from 'react'

const THEME = {
  bg: '#12121a',
  border: '#1f1f2e',
  hover: '#1a1a24',
  accent: '#7c3aed',
  text: '#e8e8ee',
  muted: '#6b6b78',
  collapsedWidth: 60,
  expandedWidth: 220,
} as const

export type SidebarTab =
  | 'dashboard'
  | 'websites'
  | 'exceptions'
  | 'apps'
  | 'categories'
  | 'rules'
  | 'stats'

interface SidebarItem {
  id: SidebarTab
  icon: string
  label: string
}

const ITEMS: ReadonlyArray<SidebarItem> = [
  { id: 'dashboard', icon: '🏠', label: 'Dashboard' },
  { id: 'websites', icon: '🌐', label: 'Websites' },
  { id: 'exceptions', icon: '✅', label: 'Exceptions' },
  { id: 'apps', icon: '📱', label: 'Apps' },
  { id: 'categories', icon: '📂', label: 'Categories' },
  { id: 'rules', icon: '⚙️', label: 'Rules' },
  { id: 'stats', icon: '📊', label: 'Stats' },
]

function NavItem({
  item,
  active,
  collapsed,
  onClick,
  shortcutKey,
}: {
  item: SidebarItem
  active: boolean
  collapsed: boolean
  onClick: () => void
  shortcutKey: number
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={collapsed ? `${item.label} (Ctrl+${shortcutKey})` : `${item.label} (Ctrl+${shortcutKey})`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: collapsed ? '10px 0' : '10px 14px',
        border: 'none',
        borderRadius: 10,
        backgroundColor: active
          ? 'rgba(124, 58, 237, 0.10)'
          : hovered
            ? THEME.hover
            : 'transparent',
        color: active ? THEME.accent : THEME.muted,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 14,
        fontWeight: active ? 700 : 500,
        textAlign: 'right',
        transition: 'background-color 120ms ease, color 120ms ease',
        position: 'relative',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderLeft: active ? `3px solid ${THEME.accent}` : '3px solid transparent',
        minHeight: 42,
      }}
    >
      <span
        style={{
          fontSize: 20,
          lineHeight: 1,
          flexShrink: 0,
          width: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {item.icon}
      </span>
      {!collapsed && (
        <span
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: active ? THEME.accent : THEME.text,
          }}
        >
          {item.label}
        </span>
      )}
      {!collapsed && (
        <span
          style={{
            marginRight: 'auto',
            marginLeft: 4,
            fontSize: 11,
            color: THEME.muted,
            opacity: 0.5,
            flexShrink: 0,
          }}
        >
          {shortcutKey}
        </span>
      )}
    </button>
  )
}

export default function Sidebar({
  active,
  onChange,
  collapsed,
  onCollapseChange,
}: {
  active: SidebarTab
  onChange: (tab: SidebarTab) => void
  collapsed: boolean
  onCollapseChange: (collapsed: boolean) => void
}) {
  const collapsedRef = useRef(collapsed)

  useEffect(() => {
    collapsedRef.current = collapsed
  }, [collapsed])

  const toggleCollapse = useCallback(() => {
    onCollapseChange(!collapsedRef.current)
  }, [onCollapseChange])

  // Keyboard shortcuts: Ctrl+1..7
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey) {
        const num = parseInt(event.key, 10)
        if (num >= 1 && num <= 7 && !event.shiftKey && !event.altKey) {
          const item = ITEMS[num - 1]
          if (item) {
            event.preventDefault()
            onChange(item.id)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onChange])

  const width = collapsed ? THEME.collapsedWidth : THEME.expandedWidth

  return (
    <aside
      dir="rtl"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width,
        minWidth: width,
        backgroundColor: THEME.bg,
        borderLeft: `1px solid ${THEME.border}`,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 80,
        transition: 'width 200ms ease, min-width 200ms ease',
        overflow: 'hidden',
      }}
    >
      {/* Logo */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          padding: collapsed ? '16px 0' : '16px 16px',
          borderBottom: `1px solid ${THEME.border}`,
          minHeight: 56,
          gap: 8,
        }}
      >
        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 22 }}>🔒</span>
            <span style={{ fontSize: 16, fontWeight: 800, color: THEME.text, whiteSpace: 'nowrap' }}>
              FocusLock
            </span>
          </div>
        )}
        {collapsed && <span style={{ fontSize: 22 }}>🔒</span>}
        <button
          type="button"
          onClick={toggleCollapse}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 6,
            border: 'none',
            backgroundColor: 'transparent',
            color: THEME.muted,
            cursor: 'pointer',
            fontSize: 14,
            transition: 'color 120ms ease, background-color 120ms ease',
            flexShrink: 0,
          }}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '◀' : '▶'}
        </button>
      </div>

      {/* Nav items */}
      <nav
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: collapsed ? '10px 6px' : '10px 10px',
          flex: 1,
          overflowY: 'auto',
        }}
      >
        {ITEMS.map((item, index) => (
          <NavItem
            key={item.id}
            item={item}
            active={active === item.id}
            collapsed={collapsed}
            onClick={() => onChange(item.id)}
            shortcutKey={index + 1}
          />
        ))}
      </nav>

      {/* Footer */}
      <div
        style={{
          padding: collapsed ? '12px 0 16px' : '12px 14px 16px',
          borderTop: `1px solid ${THEME.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {!collapsed && (
          <span style={{ fontSize: 11, color: THEME.muted, opacity: 0.6, textAlign: 'center' }}>
            v1.0
          </span>
        )}
      </div>
    </aside>
  )
}
