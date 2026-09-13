import { useState, type ReactNode } from 'react'
import Sidebar, { type SidebarTab } from './components/Sidebar'
import Dashboard from './tabs/Dashboard'
import Websites from './tabs/Websites'
import Categories from './tabs/Categories'
import Rules from './tabs/Rules'

type AppTab = SidebarTab

const CONTENT_PADDING = {
  right: 236, // sidebar width (220) + gap
  left: 16,
} as const

const CONTENT_PADDING_COLLAPSED = {
  right: 76, // sidebar collapsed (60) + gap
  left: 16,
} as const

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ padding: '40px', textAlign: 'center' }}>
      <h1 style={{ margin: '0 0 8px', fontSize: 24, color: '#e8e8ee' }}>{title}</h1>
      <p style={{ margin: 0, color: '#8b8b98', fontSize: 14 }}>{hint}</p>
    </div>
  )
}

function renderTabContent(tab: AppTab): ReactNode {
  switch (tab) {
    case 'dashboard':
      return <Dashboard />
    case 'websites':
      return <Websites />
    case 'categories':
      return <Categories />
    case 'rules':
      return <Rules />
    case 'exceptions':
      return <Placeholder title="Exceptions" hint="Manage allowlist exceptions." />
    case 'apps':
      return <Placeholder title="Apps" hint="Block and manage applications." />
    case 'stats':
      return <Placeholder title="Stats" hint="Browse blocking statistics." />
  }
}

export default function App() {
  const [tab, setTab] = useState<AppTab>('dashboard')
  const [collapsed, setCollapsed] = useState(false)

  const contentPadding = collapsed ? CONTENT_PADDING_COLLAPSED : CONTENT_PADDING

  return (
    <div
      dir="rtl"
      style={{
        minHeight: '100vh',
        backgroundColor: '#0a0a0f',
        color: '#e8e8ee',
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      }}
    >
      <Sidebar
        active={tab}
        onChange={setTab}
        collapsed={collapsed}
        onCollapseChange={setCollapsed}
      />

      <main
        style={{
          minHeight: '100vh',
          paddingTop: 16,
          paddingBottom: 40,
          paddingRight: contentPadding.right,
          paddingLeft: contentPadding.left,
          boxSizing: 'border-box',
        }}
      >
        {renderTabContent(tab)}
      </main>
    </div>
  )
}