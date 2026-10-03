import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import { RAINFALL_SEED_RECORDS } from './rainfall-seed'
import {
  RAINFALL_STORAGE_VERSION,
  applyDerivations,
  bootstrapRainfallState,
  recordToEntryRow,
  type RainfallState,
} from './rainfall-domain'

/**
 * 本地持久化（单文档）：所有模块的记录与雨量事务状态共用一份文档，
 * 一次 setItem 完成落库——事务要么整体生效，要么浏览器抛错整体不落。
 */
const STORAGE_KEY = 'hydrology-monitor-station:entries'
const RAINFALL_KEY = 'rainfall'

export type StoredDocument = {
  schemaVersion: number
  /** 通用模块记录（雨量模块的视图也由其结构化状态同步而来） */
  entries: Record<string, EntryRow[]>
  rainfall: RainfallState
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedEntries(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

/** 兼容旧版存储：旧文档直接是 Record<模块, EntryRow[]>。 */
type LegacyDocument = Record<string, EntryRow[]>

function buildFallbackDocument(): StoredDocument {
  const entries = seedEntries()
  const { state } = bootstrapRainfallState(null, RAINFALL_SEED_RECORDS)
  entries[RAINFALL_KEY] = syncRainfallRows(state)
  return { schemaVersion: RAINFALL_STORAGE_VERSION, entries, rainfall: state }
}

/** 由雨量结构化状态同步通用 EntryRow，保证运营概览/导出读到的也是同一份口径。 */
export function syncRainfallRows(state: RainfallState): EntryRow[] {
  const amountByKey = new Map(state.summaries.map((summary) => [`${summary.stationNo}|${summary.date}`, summary.dailyAmount]))
  return state.records.map((record) =>
    recordToEntryRow(record, amountByKey.get(`${record.stationNo}|${record.date}`)),
  )
}

function persist(raw: string): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, raw)
  }
}

function normalizeDocument(parsed: unknown): { doc: StoredDocument; changed: boolean } | null {
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const candidate = parsed as Record<string, unknown>

  // 新版单文档
  if (candidate.schemaVersion === RAINFALL_STORAGE_VERSION && candidate.rainfall) {
    const fallback = seedEntries()
    const entries: Record<string, EntryRow[]> = { ...fallback, ...(candidate.entries as Record<string, EntryRow[]>) }
    const boot = bootstrapRainfallState(candidate.rainfall, RAINFALL_SEED_RECORDS)
    entries[RAINFALL_KEY] = syncRainfallRows(boot.state)
    return {
      doc: { schemaVersion: RAINFALL_STORAGE_VERSION, entries, rainfall: boot.state },
      changed: boot.changed,
    }
  }

  // 旧版扁平结构：整份迁移，雨量旧字符串种子不可用，丢弃后由新种子引导
  const legacy = parsed as LegacyDocument
  const entries: Record<string, EntryRow[]> = { ...seedEntries(), ...clone(legacy) }
  delete entries[RAINFALL_KEY]
  const boot = bootstrapRainfallState(null, RAINFALL_SEED_RECORDS)
  entries[RAINFALL_KEY] = syncRainfallRows(boot.state)
  return {
    doc: { schemaVersion: RAINFALL_STORAGE_VERSION, entries, rainfall: boot.state },
    changed: true,
  }
}

let cache: StoredDocument | null = null

/**
 * 读取当前文档。每次都先尝试从磁盘重读，确保事务能看到另一终端刚落库的版本；
 * 磁盘不可用（测试/SSR）时退回内存缓存。首次或损坏数据会回落到种子并立刻持久化。
 */
export function readDoc(): StoredDocument {
  if (typeof window === 'undefined' || !window.localStorage) {
    if (!cache) {
      cache = buildFallbackDocument()
    }
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = buildFallbackDocument()
    persist(JSON.stringify(fallback))
    cache = fallback
    return fallback
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const fallback = buildFallbackDocument()
    persist(JSON.stringify(fallback))
    cache = fallback
    return fallback
  }
  const normalized = normalizeDocument(parsed)
  if (!normalized) {
    const fallback = buildFallbackDocument()
    persist(JSON.stringify(fallback))
    cache = fallback
    return fallback
  }
  if (normalized.changed) {
    persist(JSON.stringify(normalized.doc))
  }
  cache = normalized.doc
  return normalized.doc
}

export function allRows(): Record<string, EntryRow[]> {
  return readDoc().entries
}

export function listRows(key: string): EntryRow[] {
  return readDoc().entries[key] ?? []
}

/** 通用保存（状态流转等）：雨量模块的事务写操作走 commitRainfallTransaction。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  const doc = readDoc()
  commitDoc({
    ...doc,
    entries: { ...doc.entries, [key]: rows },
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 事务提交：重新读取磁盘上的最新版本，版本号不一致说明另一终端已经落库，
 * 当前事务基于旧数据，整体丢弃并报错（列表、汇总、待办都不会被半写入）。
 */
export function commitRainfallTransaction(
  baseVersion: number,
  mutate: (state: RainfallState) => void,
  now: string,
): RainfallState {
  const onDisk = readDoc()
  if (onDisk.rainfall.version !== baseVersion) {
    throw new Error('另一终端刚刚更新了雨量数据，本次登记未保存，请刷新后重试')
  }
  const draft: RainfallState = clone(onDisk.rainfall)
  mutate(draft)
  applyDerivations(draft, now)
  draft.version += 1
  const nextEntries = { ...onDisk.entries, [RAINFALL_KEY]: syncRainfallRows(draft) }
  commitDoc({ ...onDisk, entries: nextEntries, rainfall: draft })
  return draft
}

/** 单点写入入口：一次 setItem，失败时浏览器抛错、缓存保持旧文档不动。 */
function commitDoc(doc: StoredDocument): void {
  const raw = JSON.stringify(doc)
  persist(raw)
  cache = doc
}

export function getRainfallState(): RainfallState {
  return readDoc().rainfall
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 跨终端同步：另一个标签页落库后，本页缓存立即失效，重进/操作时强制读盘。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
      window.dispatchEvent(new CustomEvent('rainfall:storage-changed'))
    }
  })
}
