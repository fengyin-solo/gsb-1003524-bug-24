import type { EntryRow } from './types'

/**
 * 雨量领域逻辑：登记记录、按「站点 × 日期」的时段汇总、暴雨预警待办都在这里派生。
 * 该文件为纯函数模块，不接触 localStorage，方便在事务里对草稿反复派生、失败即整体丢弃。
 */

export const RAINFALL_MODULE_KEY = 'rainfall'
/** 本地存储结构版本：旧版（纯 entries 数组）读到后会迁移一次。 */
export const RAINFALL_STORAGE_VERSION = 2
/** 暴雨口径：某站某日有效时段雨量累计 ≥ 50mm 计为一个暴雨站次并生成预警待办。 */
export const STORM_DAILY_THRESHOLD_MM = 50

export const RAINFALL_STATUSES = ['已采集', '待审核', '已通过', '异常值'] as const
export type RainfallStatus = (typeof RAINFALL_STATUSES)[number]

export type RainfallRecord = {
  id: number
  /** 记录编号，如 RAIN-0001 */
  recordNo: string
  /** 站点编号 */
  stationNo: string
  /** 观测日期 YYYY-MM-DD */
  date: string
  /** 观测时段起始小时（0-23），时段固定为 1 小时 */
  startHour: number
  /** 时段雨量（mm） */
  amount: number
  /** 原始采样时间（本地时间 YYYY-MM-DD HH:mm:ss），登记后不可修改 */
  sampledAt: string
  /** 观测人 */
  observer: string
  status: RainfallStatus
}

export type RainfallDailySummary = {
  stationNo: string
  date: string
  /** 当日累计雨量（异常时段不参与累计） */
  dailyAmount: number
  /** 参与汇总的时段数 */
  periodCount: number
  /** 是否达到暴雨口径 */
  storm: boolean
}

export type RainfallWarning = {
  id: number
  stationNo: string
  date: string
  /** 触发时/最近一次派生的日累计雨量 */
  dailyAmount: number
  status: '待处理' | '已解除'
  createdAt: string
  resolvedAt?: string
}

export type RainfallState = {
  /** 乐观锁版本：每次成功事务 +1，用于拦截另一终端的并发写入 */
  version: number
  records: RainfallRecord[]
  summaries: RainfallDailySummary[]
  warnings: RainfallWarning[]
  nextRecordId: number
  nextWarningId: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 当前本地日期 YYYY-MM-DD。 */
export function todayLabel(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** 当前本地时间 YYYY-MM-DD HH:mm:ss，作为登记时的原始采样时间。 */
export function nowDateTimeLabel(now: Date = new Date()): string {
  return `${todayLabel(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

/** 观测时段完整标签：2026-10-03 08:00-09:00。 */
export function periodLabel(date: string, startHour: number): string {
  return `${date} ${pad2(startHour)}:00-${pad2((startHour + 1) % 24)}:00`
}

export function displaySampledAt(sampledAt: string): string {
  return sampledAt.replace('T', ' ')
}

/** 降雨强度按 1 小时时段雨量分级（时段固定 1 小时，mm 即 mm/h）。 */
export function intensityLabel(amount: number): string {
  let grade: string
  if (amount < 2.5) {
    grade = '小雨'
  } else if (amount < 8) {
    grade = '中雨'
  } else if (amount < 16) {
    grade = '大雨'
  } else {
    grade = '暴雨'
  }
  return `${amount.toFixed(1)} mm/h（${grade}）`
}

export function formatAmount(amount: number): string {
  return amount.toFixed(1)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStatus(value: unknown): value is RainfallStatus {
  return typeof value === 'string' && (RAINFALL_STATUSES as readonly string[]).includes(value)
}

/** 校验外部存储/输入里的单条记录结构是否合法。 */
export function isRainfallRecord(value: unknown): value is RainfallRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const row = value as Record<string, unknown>
  return (
    isFiniteNumber(row.id) &&
    typeof row.recordNo === 'string' &&
    row.recordNo.trim() !== '' &&
    typeof row.stationNo === 'string' &&
    row.stationNo.trim() !== '' &&
    DATE_RE.test(String(row.date)) &&
    isFiniteNumber(row.startHour) &&
    row.startHour >= 0 &&
    row.startHour <= 23 &&
    isFiniteNumber(row.amount) &&
    row.amount >= 0 &&
    typeof row.sampledAt === 'string' &&
    DATETIME_RE.test(row.sampledAt) &&
    typeof row.observer === 'string' &&
    isStatus(row.status)
  )
}

export function isRainfallState(value: unknown): value is RainfallState {
  if (!value || typeof value !== 'object') {
    return false
  }
  const state = value as Record<string, unknown>
  return (
    isFiniteNumber(state.version) &&
    Array.isArray(state.records) &&
    state.records.every(isRainfallRecord) &&
    Array.isArray(state.warnings) &&
    isFiniteNumber(state.nextRecordId) &&
    isFiniteNumber(state.nextWarningId)
  )
}

/**
 * 历史重复记录合并口径（同一站点 + 同一观测日期 + 同一时段视为重复）：
 * - 只保留一条，沿用最早登记（id/记录编号最小）那条的记录身份与**原始采样时间**；
 * - 时段雨量、观测人取采样时间最新（相同则 id 最大）的一条，后录视为对先录的修正；
 * - 状态取审核进度最靠前的一条；
 * - 汇总与预警待办在合并后统一重算，不保留任何重复计数。
 */
export function mergeDuplicates(records: RainfallRecord[]): {
  records: RainfallRecord[]
  mergedCount: number
} {
  const groups = new Map<string, RainfallRecord[]>()
  for (const record of records) {
    const key = `${record.stationNo}|${record.date}|${record.startHour}`
    const group = groups.get(key)
    if (group) {
      group.push(record)
    } else {
      groups.set(key, [record])
    }
  }
  const merged: RainfallRecord[] = []
  for (const group of groups.values()) {
    const bySampled = [...group].sort((a, b) => a.sampledAt.localeCompare(b.sampledAt) || a.id - b.id)
    const earliest = bySampled[0]
    const newest = bySampled[bySampled.length - 1]
    const statusRank: Record<RainfallStatus, number> = {
      已通过: 4,
      待审核: 3,
      已采集: 2,
      异常值: 1,
    }
    merged.push({
      ...earliest,
      amount: newest.amount,
      observer: newest.observer,
      status: [...group].sort((a, b) => statusRank[b.status] - statusRank[a.status])[0].status,
    })
  }
  merged.sort((a, b) =>
    a.date.localeCompare(b.date) || a.startHour - b.startHour || a.stationNo.localeCompare(b.stationNo),
  )
  return { records: merged, mergedCount: records.length - merged.length }
}

/** 时段汇总：按「站点 × 日期」累计；标记为异常值的时段不参与累计与暴雨判定。 */
export function buildSummaries(records: RainfallRecord[]): RainfallDailySummary[] {
  const map = new Map<string, RainfallDailySummary>()
  for (const record of records) {
    if (record.status === '异常值') {
      continue
    }
    const key = `${record.stationNo}|${record.date}`
    const current = map.get(key) ?? {
      stationNo: record.stationNo,
      date: record.date,
      dailyAmount: 0,
      periodCount: 0,
      storm: false,
    }
    current.dailyAmount += record.amount
    current.periodCount += 1
    map.set(key, current)
  }
  return [...map.values()]
    .map((summary) => ({
      ...summary,
      dailyAmount: Math.round(summary.dailyAmount * 10) / 10,
      storm: summary.dailyAmount >= STORM_DAILY_THRESHOLD_MM,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.stationNo.localeCompare(b.stationNo))
}

function summaryKey(summary: Pick<RainfallDailySummary, 'stationNo' | 'date'>): string {
  return `${summary.stationNo}|${summary.date}`
}

/**
 * 预警待办与汇总同口径派生：
 * - 达暴雨口径且无历史记录：新建「待处理」；
 * - 待处理中但累计已回落：自动「已解除」；
 * - 人工已解除的同日待办不复活（次日是新 key，会再生成）。
 */
export function reconcileWarnings(
  summaries: RainfallDailySummary[],
  existing: RainfallWarning[],
  nextId: { value: number },
  createdAt: string = nowDateTimeLabel(),
): RainfallWarning[] {
  const byKey = new Map(existing.map((warning) => [summaryKey(warning), warning]))
  const next = [...existing]
  for (const warning of next) {
    if (warning.status !== '待处理') {
      continue
    }
    const summary = summaries.find((item) => summaryKey(item) === summaryKey(warning))
    if (!summary || !summary.storm) {
      warning.status = '已解除'
      warning.resolvedAt = createdAt
    } else {
      warning.dailyAmount = summary.dailyAmount
    }
  }
  for (const summary of summaries) {
    if (!summary.storm) {
      continue
    }
    const key = summaryKey(summary)
    if (!byKey.has(key)) {
      const warning: RainfallWarning = {
        id: nextId.value++,
        stationNo: summary.stationNo,
        date: summary.date,
        dailyAmount: summary.dailyAmount,
        status: '待处理',
        createdAt,
      }
      byKey.set(key, warning)
      next.push(warning)
    }
  }
  return next.sort((a, b) => b.date.localeCompare(a.date) || a.stationNo.localeCompare(b.stationNo) || a.id - b.id)
}

/** 在事务草稿上重算汇总与待办：登记/修正/状态流转都走这里，保证三者同生共死。 */
export function applyDerivations(state: RainfallState, now: string = nowDateTimeLabel()): RainfallState {
  state.summaries = buildSummaries(state.records)
  const idCursor = { value: state.nextWarningId }
  state.warnings = reconcileWarnings(state.summaries, state.warnings, idCursor, now)
  state.nextWarningId = idCursor.value
  return state
}

export function createRecordId(id: number): string {
  return `RAIN-${String(id).padStart(4, '0')}`
}

/**
 * 从持久化数据引导雨量状态：
 * 没有合法状态（首次使用或旧版字符串种子）时从种子初始化；已有状态则跑一次合并去重与派生。
 */
export function bootstrapRainfallState(existing: unknown, seedRecords: RainfallRecord[]): {
  state: RainfallState
  changed: boolean
} {
  if (!isRainfallState(existing)) {
    const merged = mergeDuplicates(seedRecords.map((record) => ({ ...record })))
    const seeded: RainfallState = {
      version: 1,
      records: merged.records,
      summaries: [],
      warnings: [],
      nextRecordId: merged.records.reduce((max, record) => Math.max(max, record.id), 0) + 1,
      nextWarningId: 1,
    }
    applyDerivations(seeded)
    return { state: seeded, changed: true }
  }
  const state: RainfallState = {
    ...existing,
    records: existing.records.map((record) => ({ ...record })),
    warnings: existing.warnings.map((warning) => ({ ...warning })),
  }
  const { records, mergedCount } = mergeDuplicates(state.records)
  state.records = records
  const before = JSON.stringify({ summaries: state.summaries ?? [], warnings: state.warnings })
  applyDerivations(state)
  const after = JSON.stringify({ summaries: state.summaries, warnings: state.warnings })
  state.nextRecordId = Math.max(state.nextRecordId, ...state.records.map((record) => record.id + 1), 1)
  return { state, changed: mergedCount > 0 || before !== after }
}

/** 构造一条雨量记录（登记事务内调用）。 */
export function buildRecord(input: {
  id: number
  stationNo: string
  date: string
  startHour: number
  amount: number
  observer: string
  sampledAt: string
  status?: RainfallStatus
}): RainfallRecord {
  return {
    id: input.id,
    recordNo: createRecordId(input.id),
    stationNo: input.stationNo,
    date: input.date,
    startHour: input.startHour,
    amount: input.amount,
    sampledAt: input.sampledAt,
    observer: input.observer,
    status: input.status ?? '已采集',
  }
}

export function findDuplicate(
  records: RainfallRecord[],
  stationNo: string,
  date: string,
  startHour: number,
  ignoreId?: number,
): RainfallRecord | undefined {
  return records.find(
    (record) =>
      record.stationNo === stationNo &&
      record.date === date &&
      record.startHour === startHour &&
      record.id !== ignoreId,
  )
}

/** 同步一份通用 EntryRow 给运营概览等通用页面计数。 */
export function recordToEntryRow(record: RainfallRecord, dailyAmount: number | undefined): EntryRow {
  return {
    id: record.id,
    status: record.status,
    pending: record.status === '已采集' || record.status === '待审核',
    abnormal: record.status === '异常值',
    记录编号: record.recordNo,
    站点编号: record.stationNo,
    观测时段: periodLabel(record.date, record.startHour),
    时段雨量: formatAmount(record.amount),
    日累计雨量: dailyAmount === undefined ? '—' : formatAmount(dailyAmount),
    降雨强度: intensityLabel(record.amount),
    采样时间: displaySampledAt(record.sampledAt),
    观测人: record.observer,
    记录状态: record.status,
  }
}
