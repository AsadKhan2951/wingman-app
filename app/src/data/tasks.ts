import { useSyncExternalStore } from 'react'
import { tasks as mockTasks, type TaskItem } from './mock'
import { api } from './api'
import { DEMO } from './demo'

// Sample tasks only in demo mode; real users start empty until theirs load.
const seed = DEMO ? mockTasks : { ...mockTasks, groups: mockTasks.groups.map((g) => ({ ...g, items: [] })), done: [] }

// Local completion overrides (keyed by title) so a tap feels instant even
// before the backend confirms. Persisted so it survives a reload.
type Overrides = Record<string, boolean>
const KEY = 'wingman.tasks'
const read = (): Overrides => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Overrides) : {}
  } catch {
    return {}
  }
}

let overrides: Overrides = read()

// Locally-hidden (deleted) tasks, keyed by title — so a delete disappears at once
// and stays gone across reloads, even before the backend confirms.
const RKEY = 'wingman.tasks.removed'
const readRemoved = (): Set<string> => {
  try {
    const raw = localStorage.getItem(RKEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}
let removed = readRemoved()
const persistRemoved = () => {
  try {
    localStorage.setItem(RKEY, JSON.stringify([...removed]))
  } catch {
    /* ignore */
  }
}

let version = 0
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
const bump = () => {
  version++
  listeners.forEach((fn) => fn())
}
const write = (next: Overrides) => {
  overrides = next
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides))
  } catch {
    /* ignore */
  }
  bump()
}

export type TaskView = {
  groups: { title: string; items: TaskItem[] }[]
  done: TaskItem[]
  openCount: number
  progress: number
}

// ── Real tasks from the backend, mapped onto the TaskItem shape ───────
type ServerTask = { id?: string; title?: string; completed?: boolean | number; due_date?: string | null; source?: string }
let server: ServerTask[] | null = null

const dueLabel = (iso?: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const key = (x: Date) => x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate()
  const diff = key(d) - key(new Date())
  if (diff < 0) return 'Overdue'
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff <= 7) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const toItem = (t: ServerTask): TaskItem => ({
  id: t.id,
  title: t.title || 'Untitled',
  due: dueLabel(t.due_date),
  tone: 'blue',
  icon: 'task',
  source: t.source,
})

const doneServer = (t: ServerTask): boolean => {
  const backend = t.completed === true || t.completed === 1
  return overrides[t.title || ''] ?? backend
}

const projectServer = (list: ServerTask[]): TaskView => {
  const today: TaskItem[] = []
  const week: TaskItem[] = []
  const later: TaskItem[] = []
  const done: TaskItem[] = []
  for (const t of list) {
    if (removed.has(t.title || '')) continue
    if (doneServer(t)) {
      done.push(toItem(t))
      continue
    }
    const lbl = dueLabel(t.due_date)
    const item = toItem(t)
    if (lbl === 'Overdue' || lbl === 'Today') today.push(item)
    else if (lbl === 'Tomorrow' || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(lbl)) week.push(item)
    else later.push(item)
  }
  const groups = [
    { title: 'Today', items: today },
    { title: 'This week', items: week },
    { title: 'Later', items: later },
  ]
  const openCount = today.length + week.length + later.length
  const total = openCount + done.length
  return { groups, done, openCount, progress: total ? done.length / total : 0 }
}

// ── Seed fallback (until the backend loads) — the original behaviour ──
const ALL = [
  ...seed.groups.flatMap((g) => g.items.map((item) => ({ item, group: g.title }))),
  ...seed.done.map((item) => ({ item, group: 'Done' })),
]
const doneSeed = (title: string, group: string) => overrides[title] ?? group === 'Done'
const projectSeed = (): TaskView => {
  const fallback = seed.groups[0]?.title ?? 'Today'
  const open = new Map<string, TaskItem[]>(seed.groups.map((g) => [g.title, []]))
  for (const { item, group } of ALL) {
    if (removed.has(item.title) || doneSeed(item.title, group)) continue
    open.get(open.has(group) ? group : fallback)!.push(item)
  }
  const groups = seed.groups.map((g) => ({ title: g.title, items: open.get(g.title)! }))
  const done = [
    ...seed.done.filter((tk) => doneSeed(tk.title, 'Done')),
    ...seed.groups.flatMap((g) => g.items.filter((tk) => doneSeed(tk.title, g.title))),
  ].filter((tk) => !removed.has(tk.title))
  const openCount = groups.reduce((n, g) => n + g.items.length, 0)
  const total = openCount + done.length
  return { groups, done, openCount, progress: total ? done.length / total : 0 }
}

export const toggleTask = (title: string) => {
  const t = server?.find((x) => x.title === title)
  const wasDone = t ? doneServer(t) : doneSeed(title, ALL.find((e) => e.item.title === title)?.group ?? '')
  write({ ...overrides, [title]: !wasDone })
  // Persist a real completion when we know the backend task id.
  if (!wasDone && t?.id) api.completeTask(t.id).catch(() => {})
}

/** Permanently delete a task: hide it locally at once, then remove it on the
 *  backend (and on Google, server-side). Keyed by title, like everything here. */
export const deleteTask = (title: string) => {
  const t = server?.find((x) => x.title === title)
  removed.add(title)
  persistRemoved()
  if (t?.id) api.deleteTask(t.id).catch(() => {})
  bump()
}

// getSnapshot must return a STABLE reference until something actually changes,
// or useSyncExternalStore loops. Cache on (version, server identity).
let cached: TaskView = projectSeed()
let cachedVersion = -1
let cachedServer: ServerTask[] | null | undefined = undefined
const snapshot = (): TaskView => {
  if (cachedVersion !== version || cachedServer !== server) {
    cached = server ? projectServer(server) : projectSeed()
    cachedVersion = version
    cachedServer = server
  }
  return cached
}

export const useTasks = () => useSyncExternalStore(subscribe, snapshot)
export const taskView = snapshot

/** Load the real tasks from the backend. Best-effort — keeps what it has on error. */
export const hydrateTasks = async (): Promise<void> => {
  try {
    const res = await api.tasks()
    server = (res.tasks as ServerTask[]) || []
    bump()
  } catch {
    /* keep the seed */
  }
}
