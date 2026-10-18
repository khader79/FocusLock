import { useCallback, useEffect, useState } from 'react'
import ExportDialog from '../components/ExportDialog'
import ImportDialog from '../components/ImportDialog'

const C = { bg: '#0a0a0f', panel: '#15151d', border: '#30303d', text: '#f1f1f5', muted: '#9696a5', accent: '#7c3aed' }
type Site = { id: number; domain: string; addedAt?: string }
const button = { border: 'none', borderRadius: 9, padding: '9px 13px', background: '#29203f', color: '#d5c7ff', cursor: 'pointer', font: 'inherit', fontWeight: 700 }

export default function Websites() {
  const [showImport, setShowImport] = useState(false); const [showExport, setShowExport] = useState(false); const [sites, setSites] = useState<Site[]>([])
  const refresh = useCallback(async () => { try { setSites((await window.api.listSites?.()) as Site[] ?? []) } catch { setSites([]) } }, [])
  useEffect(() => { void refresh() }, [refresh])
  return <main dir="rtl" style={{ minHeight: '100vh', background: C.bg, color: C.text, padding: '76px clamp(16px, 4vw, 40px) 60px', boxSizing: 'border-box' }}><div style={{ maxWidth: 1000, margin: '0 auto' }}><header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', flexWrap: 'wrap', gap: 12 }}><div><h1 style={{ margin: 0, fontSize: 25 }}>المواقع</h1><p style={{ margin: '5px 0 0', color: C.muted, fontSize: 13 }}>استورد قوائم الحجب أو صدّر إعداداتك إلى جهاز آخر.</p></div><div style={{ display: 'flex', gap: 8 }}><button type="button" onClick={() => setShowImport(true)} style={{ ...button, background: C.accent, color: '#fff' }}>استيراد ▼</button><button type="button" onClick={() => setShowExport(true)} style={button}>تصدير ▼</button></div></header><section style={{ marginTop: 20, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' }}>{sites.length === 0 ? <p style={{ padding: 28, color: C.muted, textAlign: 'center' }}>لا توجد مواقع مخصّصة بعد.</p> : sites.map((site) => <div key={site.id} dir="ltr" style={{ padding: '12px 15px', borderBottom: `1px solid ${C.border}` }}>{site.domain}</div>)}</section></div>{showImport && <ImportDialog onClose={() => setShowImport(false)} onImported={() => void refresh()} />}{showExport && <ExportDialog onClose={() => setShowExport(false)} />}</main>
}
