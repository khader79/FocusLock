import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type {
  FocusLockRule,
  FocusLockRuleAction,
  FocusLockRuleCondition,
  FocusLockRuleInput,
} from '../env'

const C = { bg: '#0a0a0f', panel: '#12121a', raised: '#181822', border: '#292936', text: '#f1f1f5', muted: '#9292a0', accent: '#7c3aed', soft: '#251a41', ok: '#3ddc84', danger: '#ff6470' } as const

// Algorithms: 0 = Sunday ... 6 = Saturday (matches Date#getDay and the engine).
const DAYS = [
  { value: 0, label: 'أ' },
  { value: 1, label: 'إ' },
  { value: 2, label: 'ث' },
  { value: 3, label: 'أر' },
  { value: 4, label: 'خ' },
  { value: 5, label: 'ج' },
  { value: 6, label: 'س' },
] as const
const DAY_NAMES = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']

type ConditionType = FocusLockRuleCondition['type']
type ActionKind =
  | 'block_category'
  | 'increase_difficulty'
  | 'block_everything'
  | 'notify_trusted_contact'
  | 'extend_time_lock'

const CONDITION_TYPES: { value: ConditionType; label: string }[] = [
  { value: 'schedule', label: 'جدول زمني (أيام + وقت)' },
  { value: 'network', label: 'شبكة Wi‑Fi' },
  { value: 'sequence', label: 'تسلسل (جلسة / تشغيل تطبيق)' },
  { value: 'time_based', label: 'بعد ساعة محددة' },
]

const ACTION_TYPES: { value: ActionKind; label: string; param?: string }[] = [
  { value: 'block_category', label: 'حظر فئة', param: 'اسم الفئة' },
  { value: 'increase_difficulty', label: 'زيادة الصعوبة', param: 'المستوى 1-5' },
  { value: 'block_everything', label: 'حظر كل شيء' },
  { value: 'notify_trusted_contact', label: 'إشعار جهة موثوقة' },
  { value: 'extend_time_lock', label: 'تمديد القفل الزمني', param: 'الدقائق' },
]

const input = { width: '100%', boxSizing: 'border-box' as const, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 9, padding: '9px 10px', font: 'inherit', outline: 'none' }
const button = { border: 'none', borderRadius: 9, padding: '8px 12px', font: 'inherit', fontWeight: 700, cursor: 'pointer', background: C.soft, color: '#cbb8ff' }

interface EditorState {
  name: string
  conditionType: ConditionType
  days: number[]
  from: string
  to: string
  ssid: string
  trigger: 'session-start' | 'app-launch'
  app: string
  delayMinutes: string
  afterHours: string
  actionKind: ActionKind
  parameter: string
}

const emptyState: EditorState = {
  name: '',
  conditionType: 'schedule',
  days: [],
  from: '09:00',
  to: '17:00',
  ssid: '',
  trigger: 'session-start',
  app: '',
  delayMinutes: '30',
  afterHours: '18',
  actionKind: 'block_category',
  parameter: '',
}

function stateFromRule(rule: FocusLockRule): EditorState {
  const condition = rule.condition
  const action = rule.action
  return {
    name: rule.name,
    conditionType: condition.type,
    days: condition.type === 'schedule' ? condition.days : [],
    from: condition.type === 'schedule' ? condition.from : '09:00',
    to: condition.type === 'schedule' ? condition.to : '17:00',
    ssid: condition.type === 'network' ? condition.ssid : '',
    trigger: condition.type === 'sequence' ? condition.trigger : 'session-start',
    app: condition.type === 'sequence' && condition.app ? condition.app : '',
    delayMinutes: condition.type === 'sequence' ? String(condition.delayMinutes) : '30',
    afterHours: condition.type === 'time_based' ? String(condition.afterHours) : '18',
    actionKind: action.type as ActionKind,
    parameter:
      action.type === 'block_category'
        ? action.category
        : action.type === 'increase_difficulty'
          ? String(action.level)
          : action.type === 'extend_time_lock'
            ? String(action.minutes)
            : '',
  }
}

function daysLabel(days: number[]): string {
  return days.length === 0 ? '' : days.length === 7 ? 'كل الأيام' : days.map((day) => DAY_NAMES[day]).join('، ')
}

function conditionSummary(condition: FocusLockRuleCondition): string {
  switch (condition.type) {
    case 'schedule':
      return [daysLabel(condition.days), condition.from && condition.to ? `${condition.from}–${condition.to}` : ''].filter(Boolean).join(' و ') || 'جدول زمني'
    case 'network':
      return `شبكة ${condition.ssid}`
    case 'sequence':
      return condition.trigger === 'app-launch' ? `تشغيل ${condition.app ?? ''} لمدة ${condition.delayMinutes} دقيقة` : `جلسة بـ${condition.delayMinutes} دقيقة`
    case 'time_based':
      return `بعد الساعة ${String(condition.afterHours).padStart(2, '0')}:00`
  }
}

function actionSummary(action: FocusLockRuleAction): string {
  switch (action.type) {
    case 'block_category': return `حظر فئة: ${action.category}`
    case 'increase_difficulty': return `زيادة الصعوبة إلى ${action.level}`
    case 'block_everything': return 'حظر كل شيء'
    case 'notify_trusted_contact': return 'إشعار جهة موثوقة'
    case 'extend_time_lock': return `تمديد القفل ${action.minutes} دقيقة`
  }
}

function buildCondition(state: EditorState): FocusLockRuleCondition {
  switch (state.conditionType) {
    case 'schedule': return { type: 'schedule', days: state.days, from: state.from, to: state.to }
    case 'network': return { type: 'network', ssid: state.ssid.trim() }
    case 'sequence':
      return {
        type: 'sequence',
        trigger: state.trigger,
        app: state.trigger === 'app-launch' ? state.app.trim() : null,
        delayMinutes: Number(state.delayMinutes),
      }
    case 'time_based': return { type: 'time_based', afterHours: Number(state.afterHours) }
  }
}

function buildAction(kind: ActionKind, parameter: string): FocusLockRuleAction {
  switch (kind) {
    case 'block_category': return { type: 'block_category', category: parameter.trim() }
    case 'increase_difficulty': return { type: 'increase_difficulty', level: Number(parameter) }
    case 'block_everything': return { type: 'block_everything' }
    case 'notify_trusted_contact': return { type: 'notify_trusted_contact' }
    case 'extend_time_lock': return { type: 'extend_time_lock', minutes: Number(parameter) }
  }
}

function validate(state: EditorState): string | null {
  if (!state.name.trim()) return 'أدخل اسمًا للقاعدة.'
  const condition = buildCondition(state)
  if (condition.type === 'schedule' && condition.days.length === 0) return 'اختر يومًا واحدًا على الأقل.'
  if (condition.type === 'network' && condition.ssid === '') return 'أدخل اسم شبكة Wi‑Fi.'
  if (condition.type === 'sequence') {
    if (!(condition.delayMinutes >= 1)) return 'أدخل مدة التسلسل بالدقائق.'
    if (condition.trigger === 'app-launch' && condition.app === '') return 'أدخل اسم التطبيق.'
  }
  if (condition.type === 'time_based' && !(condition.afterHours >= 0 && condition.afterHours <= 23)) return 'أدخل ساعة من 0 إلى 23.'
  const action = buildAction(state.actionKind, state.parameter)
  if (action.type === 'block_category' && action.category === '') return 'أدخل اسم الفئة.'
  if (action.type === 'increase_difficulty' && !(action.level >= 1 && action.level <= 5)) return 'صعوبة التحدي من 1 إلى 5.'
  if (action.type === 'extend_time_lock' && !(action.minutes >= 1)) return 'أدخل عدد الدقائق.'
  return null
}

function RuleEditor({ initial, onClose, onSaved }: { initial: FocusLockRule | null; onClose: () => void; onSaved: () => void }) {
  const [state, setState] = useState<EditorState>(() => (initial ? stateFromRule(initial) : emptyState))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) => setState((current) => ({ ...current, [key]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const problem = validate(state)
    if (problem !== null) { setError(problem); return }
    setBusy(true); setError(null)
    const input: FocusLockRuleInput = {
      name: state.name.trim(),
      condition: buildCondition(state),
      action: buildAction(state.actionKind, state.parameter),
      priority: initial?.priority,
      enabled: initial?.enabled ?? true,
    }
    try {
      const ok = initial ? await window.api.rulesUpdate(initial.id, input) : await window.api.rulesAdd(input)
      if (!ok) { setError('لم يكتمل التحدي، لذلك لم تتغيّر القاعدة.'); return }
      onSaved(); onClose()
    } catch { setError('تعذّر حفظ القاعدة.') } finally { setBusy(false) }
  }

  const kind = ACTION_TYPES.find((item) => item.value === state.actionKind)!

  return <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.72)', display: 'grid', placeItems: 'center', padding: 16 }} onMouseDown={onClose}>
    <form onSubmit={submit} onMouseDown={(event) => event.stopPropagation()} style={{ width: 'min(720px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div><h2 style={{ margin: 0, fontSize: 20 }}>{initial ? 'تعديل قاعدة' : 'قاعدة جديدة'}</h2><p style={{ margin: '4px 0 0', color: C.muted, fontSize: 13 }}>يتطلب الحفظ إكمال تحدٍ.</p></div><button type="button" onClick={onClose} style={{ ...button, background: 'transparent', color: C.muted }}>إغلاق</button></div>
      <label style={{ color: C.muted, fontSize: 13 }}>اسم القاعدة<input autoFocus value={state.name} onChange={(e) => set('name', e.target.value)} placeholder="مثال: تركيز المساء" style={{ ...input, marginTop: 6 }} /></label>
      <section style={{ borderTop: `1px solid ${C.border}`, paddingTop: 15 }}><strong>إذا (IF)</strong><div style={{ display: 'grid', gap: 13, marginTop: 12 }}>
        <label style={{ color: C.muted, fontSize: 13 }}>الشرط<select value={state.conditionType} onChange={(e) => set('conditionType', e.target.value as ConditionType)} style={{ ...input, marginTop: 6 }}>{CONDITION_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        {state.conditionType === 'schedule' && <>
          <div><span style={{ color: C.muted, fontSize: 13 }}>الأيام</span><div style={{ display: 'flex', gap: 7, marginTop: 7, flexWrap: 'wrap' }}>{DAYS.map((day) => <button key={day.value} type="button" aria-pressed={state.days.includes(day.value)} onClick={() => set('days', state.days.includes(day.value) ? state.days.filter((value) => value !== day.value) : [...state.days, day.value])} style={{ ...button, minWidth: 37, padding: '7px 9px', background: state.days.includes(day.value) ? C.accent : C.raised, color: state.days.includes(day.value) ? '#fff' : C.muted }}>{day.label}</button>)}</div></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}><label style={{ color: C.muted, fontSize: 13 }}>من<input dir="ltr" type="time" value={state.from} onChange={(e) => set('from', e.target.value)} style={{ ...input, marginTop: 6 }} /></label><label style={{ color: C.muted, fontSize: 13 }}>إلى<input dir="ltr" type="time" value={state.to} onChange={(e) => set('to', e.target.value)} style={{ ...input, marginTop: 6 }} /></label></div>
        </>}
        {state.conditionType === 'network' && <label style={{ color: C.muted, fontSize: 13 }}>اسم شبكة Wi‑Fi (SSID)<input dir="ltr" value={state.ssid} onChange={(e) => set('ssid', e.target.value)} placeholder="HomeWiFi" style={{ ...input, marginTop: 6 }} /></label>}
        {state.conditionType === 'sequence' && <>
          <label style={{ color: C.muted, fontSize: 13 }}>الحدث<select value={state.trigger} onChange={(e) => set('trigger', e.target.value as EditorState['trigger'])} style={{ ...input, marginTop: 6 }}><option value="session-start">مرور مدة على بدء الجلسة</option><option value="app-launch">تشغيل تطبيق معيّن</option></select></label>
          {state.trigger === 'app-launch' && <label style={{ color: C.muted, fontSize: 13 }}>التطبيق<input value={state.app} onChange={(e) => set('app', e.target.value)} placeholder="مثال: Chrome" style={{ ...input, marginTop: 6 }} /></label>}
          <label style={{ color: C.muted, fontSize: 13 }}>المدة (بالدقائق)<input dir="ltr" type="number" min="1" value={state.delayMinutes} onChange={(e) => set('delayMinutes', e.target.value)} style={{ ...input, marginTop: 6 }} /></label>
        </>}
        {state.conditionType === 'time_based' && <label style={{ color: C.muted, fontSize: 13 }}>بعد الساعة<input dir="ltr" type="number" min="0" max="23" value={state.afterHours} onChange={(e) => set('afterHours', e.target.value)} placeholder="مثال: 18" style={{ ...input, marginTop: 6 }} /></label>}
      </div></section>
      <section style={{ borderTop: `1px solid ${C.border}`, paddingTop: 15 }}><strong>فإن (THEN)</strong><div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, .8fr) 1.2fr', gap: 10, marginTop: 12 }}><select value={state.actionKind} onChange={(e) => set('actionKind', e.target.value as ActionKind)} style={input}>{ACTION_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{kind.param ? <input value={state.parameter} onChange={(e) => set('parameter', e.target.value)} placeholder={kind.param} style={input} /> : <span style={{ color: C.muted, alignSelf: 'center', fontSize: 13 }}>لا يحتاج معاملًا.</span>}</div></section>
      {error && <p role="alert" style={{ margin: 0, color: C.danger, fontSize: 13 }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-start', gap: 8 }}><button type="submit" disabled={busy} style={{ ...button, background: C.accent, color: '#fff', padding: '10px 18px' }}>{busy ? 'بانتظار التحدي…' : 'حفظ القاعدة'}</button><button type="button" onClick={onClose} style={{ ...button, background: 'transparent', color: C.muted }}>إلغاء</button></div>
    </form></div>
}

export default function Rules() {
  const [rules, setRules] = useState<FocusLockRule[]>([]); const [loading, setLoading] = useState(true); const [editing, setEditing] = useState<FocusLockRule | null | 'new'>(null); const [notice, setNotice] = useState<string | null>(null)
  const refresh = useCallback(async () => { try { setRules((await window.api.rulesList()).sort((a, b) => a.priority - b.priority)) } catch { setNotice('تعذّر تحميل القواعد.') } finally { setLoading(false) } }, [])
  useEffect(() => { void refresh() }, [refresh])
  const presets: FocusLockRuleInput[] = [
    { name: 'الوضع الليلي', condition: { type: 'schedule', days: [0, 1, 2, 3, 4, 5, 6], from: '22:00', to: '06:00' }, action: { type: 'increase_difficulty', level: 5 }, enabled: true },
    { name: 'ساعات العمل', condition: { type: 'schedule', days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }, action: { type: 'block_category', category: 'وسائل التواصل' }, enabled: true },
    { name: 'صرامة المنزل', condition: { type: 'network', ssid: 'HomeWiFi' }, action: { type: 'increase_difficulty', level: 4 }, enabled: true },
  ]
  const guard = async (attempt: () => Promise<boolean>): Promise<boolean> => {
    try {
      const ok = await attempt()
      if (ok) await refresh(); else setNotice('لم يكتمل التحدي، لذلك لم يتغير شيء.')
      return ok
    } catch { setNotice('تعذّرت العملية.'); return false }
  }
  const addPreset = async (preset: FocusLockRuleInput) => { await guard(() => window.api.rulesAdd(preset)) }
  const toggleEnabled = async (rule: FocusLockRule) => { await guard(() => window.api.rulesUpdate(rule.id, { ...rule, enabled: !rule.enabled })) }
  const duplicate = async (rule: FocusLockRule) => { await guard(() => window.api.rulesAdd({ ...rule, name: `${rule.name} (نسخة)` })) }
  const remove = async (rule: FocusLockRule) => { await guard(() => window.api.rulesRemove(rule.id)) }
  if (loading) return <div style={{ padding: 80, color: C.muted, textAlign: 'center' }}>جارٍ تحميل القواعد…</div>
  return <main dir="rtl" style={{ minHeight: '100vh', background: C.bg, color: C.text, padding: '76px clamp(16px, 4vw, 40px) 60px', boxSizing: 'border-box' }}><div style={{ maxWidth: 1000, margin: '0 auto', display: 'grid', gap: 20 }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 12, flexWrap: 'wrap' }}><div><h1 style={{ margin: 0, fontSize: 25 }}>القواعد</h1><p style={{ margin: '5px 0 0', color: C.muted, fontSize: 13 }}>أنشئ أتمتة تركيزك بصيغة: إذا حدث هذا، فافعل ذلك. تُقيَّم كل 30 ثانية.</p></div><button type="button" onClick={() => setEditing('new')} style={{ ...button, background: C.accent, color: '#fff' }}>+ قاعدة جديدة</button></header>
    {notice && <div role="status" style={{ padding: '10px 13px', borderRadius: 9, background: C.raised, color: C.muted, fontSize: 13 }}>{notice}</div>}
    <section style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 }}><strong>قواعد جاهزة</strong><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginTop: 12 }}>{presets.map((preset) => <article key={preset.name} style={{ background: C.raised, padding: 12, borderRadius: 10 }}><h3 style={{ margin: 0, fontSize: 14 }}>{preset.name}</h3><p style={{ margin: '6px 0 10px', color: C.muted, fontSize: 12 }}>{preset.condition ? `إذا ${conditionSummary(preset.condition)}` : ''}</p><button type="button" onClick={() => void addPreset(preset)} style={button}>استخدام القاعدة</button></article>)}</div></section>
    <section><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><strong>قواعدي</strong><span style={{ color: C.muted, fontSize: 12 }}>تُطبَّق حسب الأولوية</span></div><div style={{ display: 'grid', gap: 10 }}>{rules.map((rule, index) => <article key={rule.id} style={{ opacity: rule.enabled ? 1 : .55, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 13, padding: 15, display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 13, alignItems: 'center' }}><div style={{ color: C.muted, textAlign: 'center' }}><small>#{index + 1}</small></div><div><h2 style={{ margin: 0, fontSize: 16 }}>{rule.name}</h2><p style={{ margin: '5px 0 0', color: C.muted, fontSize: 13 }}>إذا {conditionSummary(rule.condition)}، فـ {actionSummary(rule.action)}</p></div><div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', justifyContent: 'end' }}><label title="يتطلب تحديًا" style={{ display: 'flex', alignItems: 'center', gap: 5, color: rule.enabled ? C.ok : C.muted, fontSize: 12, cursor: 'pointer' }}><input type="checkbox" checked={rule.enabled} onChange={() => void toggleEnabled(rule)} />{rule.enabled ? 'مفعّلة' : 'معطّلة'}</label><button type="button" onClick={() => setEditing(rule)} style={button}>تعديل</button><button type="button" onClick={() => void duplicate(rule)} style={button}>نسخ</button><button type="button" onClick={() => void remove(rule)} style={{ ...button, background: 'transparent', color: C.danger }}>حذف</button></div></article>)}</div>{rules.length === 0 && <div style={{ padding: 34, border: `1px dashed ${C.border}`, borderRadius: 13, color: C.muted, textAlign: 'center' }}>لا توجد قواعد بعد. أنشئ أول قاعدة لك.</div>}</section>
  </div>{editing !== null && <RuleEditor initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void refresh()} />}</main>
}