import type { EntryRow } from '../types'

/**
 * 雨量领域层：观测登记、时段汇总、暴雨预警待办的全部业务规则都在这里，且都是纯函数。
 * local-service 负责事务与持久化，本文件不碰 localStorage。
 *
 * 口径约定：
 * - 唯一键：站点编号（去空白）+ 规范化后的观测时段。同一站点同一时段只能存在一条。
 * - 历史重复记录合并：以最早登记的记录为基底，保留它的编号与「原采样时间」；
 *   时段雨量/观测人取最近一次更新（修正优先，否则取最后补录）；状态取审核进度最高者，
 *   任一记录为「异常值」则合并结果仍为异常值，需人工复核。合并幂等，被合并的 id 记入 _mergedFrom。
 * - 日累计雨量：同站点同日期、全部非异常值记录的时段雨量合计；异常值不参与汇总与预警。
 * - 暴雨预警待办：同站点当日累计 ≥ 50mm（暴雨，24h 量级），按 100/250 升级大暴雨/特大暴雨；
 *   回落到阈值以下自动销项。待办与雨量行在同一次写入中落库。
 */

export const RAIN_MODULE_KEY = 'rainfall'

export const STORM_THRESHOLD = 50
export const DOWNPOUR_THRESHOLD = 100
export const EXTREME_THRESHOLD = 250

const RAIN_STATUSES = ['已采集', '待审核', '已通过', '异常值'] as const
const STATUS_RANK: Record<string, number> = { 已采集: 0, 待审核: 1, 已通过: 2 }

// 旧数据没有时间戳时用的确定性基准，保证合并结果可预测（2026-01-01T00:00:00Z）。
const BASE_EPOCH = 1767225600000

export type RainRow = EntryRow

export type RainInput = {
  station: string
  period: string
  amount: number
  observer: string
}

export type RainDaySummary = {
  station: string
  day: string
  total: number
  maxAmount: number
  periods: number
  level: string
}

export type RainfallTodo = {
  id: string
  station: string
  day: string
  dailyTotal: number
  maxAmount: number
  periods: number
  level: string
  createdAt: number
}

const round1 = (value: number): number => Math.round(value * 10) / 10

export function dayString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 规范化观测时段：
 * 接受 `YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm-HH:mm`，容忍 / 日期分隔、—–~～ 等时段连接符与多余空白。
 * 规范化后同一观测时段的文本写法不同也会被判为重复。
 */
export function normalizePeriod(input: string): string {
  const raw = String(input ?? '')
    .trim()
    .replace(/[—–~～]/g, '-')
    .replace(/\s+/g, ' ')
  const matched = raw.match(
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2}):(\d{1,2}))?$/,
  )
  if (!matched) {
    throw new Error('观测时段格式应为「YYYY-MM-DD」或「YYYY-MM-DD HH:mm-HH:mm」')
  }
  const [, y, mo, d, sh, sm, eh, em] = matched
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error('观测时段里的日期不存在，请核对后重新填写')
  }
  const datePart = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  if (sh === undefined) {
    return datePart
  }
  const startH = Number(sh)
  const startM = Number(sm)
  const endH = Number(eh)
  const endM = Number(em)
  const validTime = (h: number, m: number) => h >= 0 && h < 24 && m >= 0 && m < 60
  if (!validTime(startH, startM) || !validTime(endH, endM)) {
    throw new Error('观测时段里的时刻应为 00:00-23:59 之间')
  }
  const startMin = startH * 60 + startM
  const endMin = endH * 60 + endM
  if (endMin <= startMin) {
    throw new Error('观测时段的结束时刻应晚于开始时刻')
  }
  const timePart = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}-${String(
    endH,
  ).padStart(2, '0')}:${String(endM).padStart(2, '0')}`
  return `${datePart} ${timePart}`
}

export function periodDay(period: string): string {
  return normalizePeriod(period).slice(0, 10)
}

export function parseAmount(value: unknown): number {
  const amount = Number(value)
  if (!Number.isFinite(amount)) {
    throw new Error('时段雨量应为数字（单位 mm）')
  }
  if (amount < 0) {
    throw new Error('时段雨量不能为负数')
  }
  return round1(amount)
}

/** 按量级参考分档（24h 降水量标准），仅作展示与提示。 */
export function rainGrade(amount: number): string {
  if (amount < 0.1) return '无雨'
  if (amount < 10) return '小雨'
  if (amount < 25) return '中雨'
  if (amount < 50) return '大雨'
  if (amount < 100) return '暴雨'
  if (amount < 250) return '大暴雨'
  return '特大暴雨'
}

export function dayGrade(total: number): string {
  if (total >= EXTREME_THRESHOLD) return '特大暴雨'
  if (total >= DOWNPOUR_THRESHOLD) return '大暴雨'
  if (total >= STORM_THRESHOLD) return '暴雨'
  return rainGrade(total)
}

export function isAbnormal(row: RainRow): boolean {
  return String(row.status) === '异常值'
}

function numericAmount(row: RainRow): number | null {
  const amount = Number(row.时段雨量)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

export function duplicateKey(station: string, period: string): string {
  // 站点编号按大写比较：s01 与 S01 视为同一站点，避免换个大小写就绕过重复登记。
  return `${String(station).trim().toUpperCase()}@${normalizePeriod(period)}`
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 入库前补水：为历史数据补内部字段，并合并同站点同时段的重复登记。
 * 幂等：已合并（带 _mergedFrom）的记录不会被再次拆分。
 */
export function hydrateRainfall(rows: readonly EntryRow[]): RainRow[] {
  const stamped = rows.map((row) => {
    const id = Number(row.id)
    const period = normalizePeriodSafe(String(row.观测时段 ?? ''))
    const sampleTime = String(row._sampleTime ?? period)
    const createdAt = asNumber(row._createdAt, BASE_EPOCH + id * 1000)
    const updatedAt = asNumber(row._updatedAt, createdAt)
    const station = String(row.站点编号 ?? '').trim()
    return {
      ...row,
      站点编号: station,
      观测时段: period,
      时段雨量: numericAmount(row) ?? row.时段雨量,
      _sampleTime: sampleTime,
      _createdAt: createdAt,
      _updatedAt: updatedAt,
      _dupKey: `${station.toUpperCase()}@${period}`,
    } as RainRow
  })

  const groups = new Map<string, RainRow[]>()
  for (const row of stamped) {
    const key = String(row._dupKey)
    const group = groups.get(key)
    if (group) {
      group.push(row)
    } else {
      groups.set(key, [row])
    }
  }

  const merged: RainRow[] = []
  for (const group of groups.values()) {
    merged.push(group.length === 1 ? group[0] : mergeGroup(group))
  }

  merged.sort((a, b) => {
    const pa = String(a.观测时段)
    const pb = String(b.观测时段)
    if (pa !== pb) return pa < pb ? -1 : 1
    return String(a.站点编号) < String(b.站点编号) ? -1 : 1
  })

  // 历史数据里 pending 可能与状态脱节（如已通过却仍挂待处理）：统一按状态重算，看板/待办才准。
  for (const row of merged) {
    const abnormal = isAbnormal(row)
    row.abnormal = abnormal
    row.pending = String(row.status) !== '已通过' && !abnormal
  }
  return merged
}

function normalizePeriodSafe(period: string): string {
  try {
    return normalizePeriod(period)
  } catch {
    return String(period ?? '').trim()
  }
}

/**
 * 合并一组同站点同时段的历史记录：
 * - 基底 = 最早登记（_createdAt 最小，id 兜底），原采样时间与记录编号沿用基底；
 * - 雨量值/观测人 = 最近一次更新（_updatedAt 最大，后补录优先），体现修正覆盖；
 * - 状态 = 审核进度最高；任一为异常值则保留异常值。
 */
function mergeGroup(group: RainRow[]): RainRow {
  const byRegistration = [...group].sort(
    (a, b) => asNumber(a._createdAt, 0) - asNumber(b._createdAt, 0) || Number(a.id) - Number(b.id),
  )
  const base = byRegistration[0]
  const latest = [...group].sort(
    (a, b) => asNumber(b._updatedAt, 0) - asNumber(a._updatedAt, 0) || Number(b.id) - Number(a.id),
  )[0]

  const hasAbnormal = group.some((row) => isAbnormal(row))
  const bestRank = group.reduce((max, row) => {
    const rank = STATUS_RANK[String(row.status)]
    return rank === undefined ? max : Math.max(max, rank)
  }, -1)
  const status = hasAbnormal
    ? '异常值'
    : RAIN_STATUSES[bestRank] ?? String(base.status)

  return {
    ...base,
    时段雨量: latest.时段雨量,
    观测人: latest.观测人,
    status,
    pending: status !== '已通过' && status !== '异常值',
    abnormal: status === '异常值',
    _sampleTime: String(base._sampleTime ?? base.观测时段),
    _updatedAt: group.reduce((max, row) => Math.max(max, asNumber(row._updatedAt, 0)), 0),
    _mergedFrom: group
      .map((row) => Number(row.id))
      .sort((a, b) => a - b)
      .join(','),
  }
}

type ValidRow = RainRow & { 时段雨量: number }

function validRows(rows: readonly RainRow[]): ValidRow[] {
  return rows.filter((row): row is ValidRow => !isAbnormal(row) && numericAmount(row) !== null)
}

/** 同站点同日期的日累计，异常值不参与。 */
function dailyTotals(rows: readonly RainRow[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const row of validRows(rows)) {
    const key = `${String(row.站点编号)}@${String(row.观测时段).slice(0, 10)}`
    totals.set(key, round1((totals.get(key) ?? 0) + Number(row.时段雨量)))
  }
  return totals
}

/** 列表投影：补算日累计雨量与降雨强度，保证列表、汇总、导出三处口径一致。 */
export function buildViewRows(rows: readonly RainRow[]): EntryRow[] {
  const totals = dailyTotals(rows)
  return rows.map((row) => {
    const amount = numericAmount(row)
    const abnormal = isAbnormal(row)
    const total = totals.get(`${String(row.站点编号)}@${String(row.观测时段).slice(0, 10)}`)
    return {
      ...row,
      时段雨量: amount === null ? row.时段雨量 : amount.toFixed(1),
      日累计雨量: abnormal || total === undefined ? '—' : total.toFixed(1),
      降雨强度: abnormal || amount === null ? '—' : rainGrade(amount),
      原采样时间: String(row._sampleTime ?? row.观测时段),
      记录状态: String(row.status),
    }
  })
}

/** 时段汇总：按站点 + 日期聚合。 */
export function buildDaySummaries(rows: readonly RainRow[]): RainDaySummary[] {
  const map = new Map<string, RainDaySummary & { maxAmount: number }>()
  for (const row of validRows(rows)) {
    const station = String(row.站点编号)
    const day = String(row.观测时段).slice(0, 10)
    const key = `${station}@${day}`
    const amount = Number(row.时段雨量)
    const current = map.get(key)
    if (current) {
      current.total = round1(current.total + amount)
      current.maxAmount = Math.max(current.maxAmount, amount)
      current.periods += 1
      current.level = dayGrade(current.total)
    } else {
      map.set(key, {
        station,
        day,
        total: round1(amount),
        maxAmount: amount,
        periods: 1,
        level: dayGrade(amount),
      })
    }
  }
  return [...map.values()].sort((a, b) =>
    a.day !== b.day ? (a.day < b.day ? 1 : -1) : a.station < b.station ? -1 : 1,
  )
}

/** 暴雨预警待办：达到暴雨量级的站点-日期，key 稳定，量级随修正自动升降/销项。 */
export function buildRainfallTodos(rows: readonly RainRow[]): RainfallTodo[] {
  const firstSeen = new Map<string, number>()
  for (const row of validRows(rows)) {
    const key = `${String(row.站点编号)}@${String(row.观测时段).slice(0, 10)}`
    const createdAt = asNumber(row._createdAt, BASE_EPOCH)
    firstSeen.set(key, Math.min(firstSeen.get(key) ?? Infinity, createdAt))
  }
  return buildDaySummaries(rows)
    .filter((item) => item.total >= STORM_THRESHOLD)
    .map((item) => ({
      id: `RAIN-TODO-${item.station}-${item.day}`,
      station: item.station,
      day: item.day,
      dailyTotal: item.total,
      maxAmount: item.maxAmount,
      periods: item.periods,
      level: item.level,
      createdAt: firstSeen.get(`${item.station}@${item.day}`) ?? BASE_EPOCH,
    }))
}

/** 顶部三张统计卡：今日观测站次、今日暴雨站点数、待审核记录。 */
export function rainfallStats(
  rows: readonly RainRow[],
  today: string,
): { stationVisits: number; stormStations: number; pending: number } {
  const todays = validRows(rows).filter((row) => String(row.观测时段).slice(0, 10) === today)
  const stormToday = new Set(
    buildDaySummaries(todays)
      .filter((item) => item.total >= STORM_THRESHOLD)
      .map((item) => item.station),
  )
  return {
    stationVisits: todays.length,
    stormStations: stormToday.size,
    pending: rows.filter((row) => String(row.status) === '待审核').length,
  }
}

export function validateRainInput(input: RainInput): RainInput {
  const station = String(input.station ?? '').trim()
  if (!station) {
    throw new Error('请填写站点编号')
  }
  const period = normalizePeriod(String(input.period ?? ''))
  const amount = parseAmount(input.amount)
  const observer = String(input.observer ?? '').trim()
  if (!observer) {
    throw new Error('请填写观测人')
  }
  return { station, period, amount, observer }
}

/** 登记：同站点同时段已存在（任何状态）一律拒绝，重复补录由调用方串行化后只保留第一条。 */
export function rainRegister(
  rows: RainRow[],
  input: RainInput,
  now: number,
): { id: number; code: string; period: string } {
  const data = validateRainInput(input)
  const key = duplicateKey(data.station, data.period)
  const existing = rows.find((row) => String(row._dupKey) === key)
  if (existing) {
    throw new Error(
      `站点 ${data.station} 在 ${data.period} 已登记（记录编号 ${String(
        existing.记录编号,
      )}），同一站点同一时段不能重复登记；如需变更请使用「修正雨量」`,
    )
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const day = data.period.slice(0, 10)
  const sameDayCount = rows.filter((row) => String(row.观测时段).slice(0, 10) === day).length
  const code = `RAIN-${day.replace(/-/g, '')}-${String(sameDayCount + 1).padStart(2, '0')}`
  rows.push({
    id,
    status: '已采集',
    pending: true,
    abnormal: false,
    记录编号: code,
    站点编号: data.station,
    观测时段: data.period,
    时段雨量: data.amount,
    观测人: data.observer,
    记录状态: '已采集',
    _sampleTime: data.period,
    _createdAt: now,
    _updatedAt: now,
    _dupKey: key,
  })
  return { id, code, period: data.period }
}

/** 修正：只允许改时段雨量/观测人；修正后退回「待审核」重新走审核，汇总与待办由事务同次重算。 */
export function rainCorrect(
  rows: readonly RainRow[],
  id: number,
  input: Pick<RainInput, 'amount' | 'observer'>,
  now: number,
): { code: string } {
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`没有找到编号为 ${id} 的雨量记录`)
  }
  const amount = parseAmount(input.amount)
  const observer = String(input.observer ?? '').trim()
  if (!observer) {
    throw new Error('请填写观测人')
  }
  row.时段雨量 = amount
  row.观测人 = observer
  row.status = '待审核'
  row.pending = true
  row.abnormal = false
  row.记录状态 = '待审核'
  row._updatedAt = now
  return { code: String(row.记录编号) }
}

/** 状态流转：找不到、重复操作都抛错，由事务保证不落半条。 */
export function rainChangeStatus(
  rows: readonly RainRow[],
  id: number,
  target: string,
): { code: string } {
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`没有找到编号为 ${id} 的雨量记录`)
  }
  if (String(row.status) === target) {
    throw new Error(`雨量记录已经是「${target}」，不用重复操作`)
  }
  row.status = target
  row.记录状态 = target
  row.abnormal = target === '异常值'
  // 已通过、异常值都是终态，不再挂待处理；已采集/待审核保持待处理。
  row.pending = target !== '已通过' && target !== '异常值'
  return { code: String(row.记录编号) }
}
