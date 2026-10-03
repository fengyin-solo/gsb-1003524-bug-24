import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  resetRows,
  saveRows,
  subscribe,
  transact,
} from '@/data/local-store'
import {
  buildDaySummaries,
  buildRainfallTodos,
  buildViewRows,
  dayString,
  rainChangeStatus,
  rainCorrect,
  rainRegister,
  rainfallStats,
  RAIN_MODULE_KEY,
} from '@/data/rainfall/domain'
import type {
  RainDaySummary,
  RainInput,
  RainfallTodo,
  RainRow,
} from '@/data/rainfall/domain'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 雨量页面额外展示的「原采样时间」列（合并重复记录后仍可追溯最早一次采样）。
export const RAIN_EXTRA_FIELDS = ['原采样时间']

function rainfallEntries(filters: Record<string, string>): PageResult {
  const projected = buildViewRows(listRows(RAIN_MODULE_KEY) as RainRow[])
  const matched = filterRows(projected, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === RAIN_MODULE_KEY) {
    return rainfallEntries(filters)
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export type RainfallSnapshot = {
  items: EntryRow[]
  total: number
  stats: { label: string; value: number }[]
  daySummaries: RainDaySummary[]
  todos: RainfallTodo[]
}

/** 雨量页一屏所需：列表投影、时段汇总、统计卡、暴雨预警待办，同源计算不会再对不上。 */
export function rainfallSnapshot(
  filters: Record<string, string> = {},
  today: string = dayString(new Date()),
): RainfallSnapshot {
  const rows = listRows(RAIN_MODULE_KEY) as RainRow[]
  const page = rainfallEntries(filters)
  const stats = rainfallStats(rows, today)
  return {
    items: page.items,
    total: page.total,
    stats: [
      { label: '今日观测站次', value: stats.stationVisits },
      { label: '暴雨站点数', value: stats.stormStations },
      { label: '待审核记录', value: stats.pending },
    ],
    daySummaries: buildDaySummaries(rows),
    todos: buildRainfallTodos(rows),
  }
}

export function listRainfallTodos(): RainfallTodo[] {
  return buildRainfallTodos(listRows(RAIN_MODULE_KEY) as RainRow[])
}

/** 页面订阅：本页事务落库或其它终端写入后回调，页面重新拉取，不残留旧结果。 */
export function subscribeRainfall(listener: () => void): () => void {
  return subscribe(listener)
}

/** 通用动作：非雨量模块保持原语义；雨量动作走事务，保证修正/状态与汇总、待办同次落库。 */
export async function runAction(key: string, id: number, action: string): Promise<ActionResult> {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === RAIN_MODULE_KEY) {
    try {
      await transact((modules) => {
        rainChangeStatus(modules[RAIN_MODULE_KEY] as RainRow[], id, target)
      })
      return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : `${meta.entity}${action}失败，列表、汇总和预警待办已一起回退`,
      }
    }
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export type WriteResult<T = unknown> =
  | ({ ok: true; message: string } & T)
  | { ok: false; message: string }

/**
 * 登记雨量记录：
 * 站点+时段唯一校验在事务内基于最新存储执行，两个终端同时补录只有先拿锁的那条落库，
 * 后一个收到「已登记」错误且整笔回退。
 */
export async function registerRainfall(input: RainInput): Promise<WriteResult<{ id: number; code: string }>> {
  try {
    const result = await transact((modules) =>
      rainRegister(modules[RAIN_MODULE_KEY] as RainRow[], input, Date.now()),
    )
    return {
      ok: true,
      id: result.id,
      code: result.code,
      message: `雨量记录 ${result.code} 已登记（观测时段 ${result.period}）`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '雨量记录登记失败，已回退',
    }
  }
}

/** 修正时段雨量：与日累计、暴雨待办在同一事务里一起提交；失败则列表、汇总、待办一起回退。 */
export async function correctRainfall(
  id: number,
  input: Pick<RainInput, 'amount' | 'observer'>,
): Promise<WriteResult<{ code: string }>> {
  try {
    const result = await transact((modules) =>
      rainCorrect(modules[RAIN_MODULE_KEY] as RainRow[], id, input, Date.now()),
    )
    return { ok: true, code: result.code, message: `雨量记录 ${result.code} 已修正，汇总与预警待办已同步重算` }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '雨量记录修正失败，列表、汇总和预警待办已一起回退',
    }
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const fields = key === RAIN_MODULE_KEY ? [...meta.fields, ...RAIN_EXTRA_FIELDS] : meta.fields
  const header = ['编号', ...fields, '当前状态']
  const lines = [header.join(',')]
  const rows = key === RAIN_MODULE_KEY ? buildViewRows(listRows(key) as RainRow[]) : listRows(key)
  for (const row of rows) {
    lines.push([row.id, ...fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = meta.key === RAIN_MODULE_KEY
      ? buildViewRows(rows[meta.key] as RainRow[])
      : rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
