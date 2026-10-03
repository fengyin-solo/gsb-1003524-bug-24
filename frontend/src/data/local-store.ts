import { SEED_ROWS } from './seed'
import {
  buildRainfallTodos,
  hydrateRainfall,
  RAIN_MODULE_KEY,
} from './rainfall/domain'
import type { EntryRow } from './types'
import type { RainfallTodo } from './rainfall/domain'

/**
 * 本地持久化：整份业务状态（各模块记录 + 雨量暴雨预警待办 + 版本号）存在 localStorage 的同一个 key 里。
 * 每次写操作都是一次整体序列化 + 单次 setItem——这就是纯前端版的「同次落库」：
 * 修正记录、时段汇总、预警待办要么一起生效，要么保持原状，不会出现只改了一半。
 *
 * 多终端（浏览器多标签页）并发靠 Web Locks 串行化：同一时刻只有一个标签页在事务里读写，
 * 事务内从存储重读最新状态，两个终端同时补录同站点同时段时第二个必然撞唯一键、整笔回退。
 */

const STORAGE_KEY = 'hydrology-monitor-station:entries'
const LOCK_NAME = 'hydrology-monitor-station:write-lock'

export type AppState = {
  revision: number
  modules: Record<string, EntryRow[]>
  rainfallTodos: RainfallTodo[]
}

type Unsubscribe = () => void

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 落库前的统一收口：雨量记录补水合并 + 暴雨预警待办随记录重算，保证列表/汇总/待办同口径。 */
export function commitState(modules: Record<string, EntryRow[]>, revision: number): AppState {
  const nextModules = clone(modules)
  nextModules[RAIN_MODULE_KEY] = hydrateRainfall(nextModules[RAIN_MODULE_KEY] ?? [])
  return {
    revision,
    modules: nextModules,
    rainfallTodos: buildRainfallTodos(nextModules[RAIN_MODULE_KEY]),
  }
}

function seedState(): AppState {
  return commitState(clone(SEED_ROWS), 1)
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

/** 直接从存储读最新状态（事务里用，避免拿到本标签页的陈旧缓存）。 */
function readFromStorage(): AppState {
  if (!hasStorage()) {
    return seedState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const state = seedState()
    writeRaw(state)
    return state
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AppState> & Record<string, unknown>
    // 旧版本落的是裸模块映射（没有 revision/modules 外壳）：识别出来走一次迁移。
    const legacyModules =
      !parsed.modules && RAIN_MODULE_KEY in parsed
        ? (parsed as unknown as Record<string, EntryRow[]>)
        : null
    const modules = parsed.modules ?? legacyModules
    if (!modules || typeof modules !== 'object') {
      throw new Error('invalid shape')
    }
    const migrated = commitState(modules, Number(parsed.revision) || 1)
    // 只有旧格式（裸映射 / 无版本号 / 缺暴雨待办外壳）才在读取时补写一次；已是新格式则原样用内存重算结果。
    const needsMigration =
      legacyModules !== null || !parsed.revision || !Array.isArray(parsed.rainfallTodos)
    if (needsMigration) {
      writeRaw(migrated)
    }
    return migrated
  } catch {
    const state = seedState()
    writeRaw(state)
    return state
  }
}

function writeRaw(state: AppState): void {
  if (!hasStorage()) {
    return
  }
  // 先持久化成功才回头改缓存；setItem 抛错（配额、隐私模式）时缓存保持旧状态。
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

let cache: AppState | null = null

export function getState(): AppState {
  if (cache === null) {
    cache = readFromStorage()
  }
  return cache
}

function setCache(state: AppState): void {
  cache = state
  for (const listener of listeners) {
    listener(state)
  }
}

const listeners = new Set<(state: AppState) => void>()

/** 状态变化订阅：本页事务提交、其它标签页写入都会触发，页面据此重新拉取，不残留旧结果。 */
export function subscribe(listener: (state: AppState) => void): Unsubscribe {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let storageWired = false

function wireStorageEvents(): void {
  if (storageWired || typeof window === 'undefined' || !window.addEventListener) {
    return
  }
  storageWired = true
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) {
      return
    }
    // 另一终端已提交：以存储为准刷新缓存并通知本页。
    cache = readFromStorage()
    for (const listener of listeners) {
      listener(cache)
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  wireStorageEvents()
  return getState().modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 非雨量模块的简单写入口；仍走整状态原子提交。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  const state = getState()
  const next = commitState({ ...state.modules, [key]: rows }, state.revision + 1)
  writeRaw(next)
  setCache(next)
}

export function resetRows(key: string): EntryRow[] {
  const state = getState()
  const rows = clone(SEED_ROWS[key] ?? [])
  const next = commitState({ ...state.modules, [key]: rows }, state.revision + 1)
  writeRaw(next)
  setCache(next)
  return next.modules[key]
}

export type TransactionBody<T> = (
  modules: Record<string, EntryRow[]>,
) => T

/**
 * 事务：锁内重读最新状态 → 克隆后交给业务函数改 → commitState 统一补水/重算 → 单次落库 → 换缓存。
 * 业务函数抛错或落库失败都不会写入任何内容：列表、汇总、预警待办一起回退。
 */
export function transact<T>(body: TransactionBody<T>): Promise<T> {
  wireStorageEvents()
  const run = (): T => {
    const fresh = readFromStorage()
    const working = clone(fresh.modules)
    const result = body(working)
    const next = commitState(working, fresh.revision + 1)
    writeRaw(next)
    setCache(next)
    return result
  }

  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks && typeof locks.request === 'function') {
    // Web Locks 保证多标签页（多终端）的补录事务严格串行，第二个终端一定读到第一个终端的结果。
    return locks.request(LOCK_NAME, run)
  }
  // 非浏览器环境（构建/测试）没有 Web Locks：单进程内同步串行执行。
  return Promise.resolve(run())
}

export function storageKey(): string {
  return STORAGE_KEY
}
