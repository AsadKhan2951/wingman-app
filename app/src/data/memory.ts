import { useSyncExternalStore } from 'react'
import { brain, memory as mockMemory } from './mock'
import { DEMO } from './demo'

// Sample memory notes only in demo mode.
const memory = DEMO ? mockMemory : { ...mockMemory, notes: [] as typeof mockMemory.notes }

type State = {
  forgotten: string[]
  facts: Record<string, string>
}

const KEY = 'wingman.memory'
const EMPTY: State = { forgotten: [], facts: {} }

const read = (): State => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY
  } catch {
    return EMPTY
  }
}

let current = read()
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

const write = (next: State) => {
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
  }
  listeners.forEach((fn) => fn())
}

const useMemoryState = () => useSyncExternalStore(subscribe, () => current)


export const useNotes = () => {
  const { forgotten } = useMemoryState()
  return memory.notes.filter((n) => !forgotten.includes(n.id))
}

export const useNoteCount = () => useNotes().length

export const forget = (id: string) =>
  write({ ...current, forgotten: current.forgotten.includes(id) ? current.forgotten : [...current.forgotten, id] })

export const forgetAll = () => write({ ...current, forgotten: memory.notes.map((n) => n.id) })


export const useBrainFacts = () => {
  const { facts } = useMemoryState()
  return brain.facts.map((f) => ({ ...f, value: facts[f.id] ?? f.value, yours: !!facts[f.id] }))
}

export const setFact = (id: string, value: string) =>
  write({ ...current, facts: { ...current.facts, [id]: value } })
