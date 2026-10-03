import {
  STORM_DAILY_THRESHOLD_MM,
  buildRecord,
  findDuplicate,
  formatAmount,
  intensityLabel,
  nowDateTimeLabel,
  periodLabel,
  displaySampledAt,
  type RainfallRecord,
  type RainfallState,
  type RainfallStatus,
  type RainfallWarning,
} from '@/data/rainfall-domain'
import { commitRainfallTransaction, getRainfallState } from '@/data/local-store'
import type { ActionResult } from '@/data/types'

/**
 * 雨量服务：观测登记、修正、状态流转、预警解除都通过同一个事务提交，
 * 修正记录与重算时段汇总、暴雨待办在同一次落库里完成；事务抛错时三者一起回退。
 */

export type RainfallViewRow = {
  id: number
  recordNo: string
  stationNo: string
  period: string
  amount: string
  dailyAmount: string
  intensity: string
  sampledAt: string
  observer: string
  status: RainfallStatus
}

export type RainfallOverview = {
  stats: { label: string; value: number }[]
  rows: RainfallViewRow[]
  summaries: RainfallState['summaries']
  warnings: RainfallWarning[]
}

export type RainfallDraft = {
  stationNo: string
  date: string
  startHour: number
  amount: string
  observer: string
}

const STATUS_ACTIONS: Record<string, RainfallStatus> = {
  提交审核: '待审核',
  确认通过: '已通过',
  标记异常: '异常值',
}

const PENDING_STATUSES: RainfallStatus[] = ['已采集', '待审核']

function toViewRow(record: RainfallRecord, state: RainfallState): RainfallViewRow {
  const summary = state.summaries.find(
    (item) => item.stationNo === record.stationNo && item.date === record.date,
  )
  return {
    id: record.id,
    recordNo: record.recordNo,
    stationNo: record.stationNo,
    period: periodLabel(record.date, record.startHour),
    amount: formatAmount(record.amount),
    dailyAmount: summary ? formatAmount(summary.dailyAmount) : '—',
    intensity: intensityLabel(record.amount),
    sampledAt: displaySampledAt(record.sampledAt),
    observer: record.observer,
    status: record.status,
  }
}

/** 读最新状态并组装页面所需的列表、汇总指标和暴雨待办。 */
export function getRainfallOverview(
  filters: Record<string, string> = {},
  statsDate: string,
): RainfallOverview {
  const state = getRainfallState()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const records = state.records.filter((record) => {
    const view = toViewRow(record, state)
    return pairs.every(([field, value]) => String(view[field as keyof RainfallViewRow] ?? '').includes(value.trim()))
  })

  const todayRecords = state.records.filter((record) => record.date === statsDate)
  const todayStormStations = new Set(
    state.summaries
      .filter((summary) => summary.date === statsDate && summary.storm)
      .map((summary) => summary.stationNo),
  )
  const pendingRecords = state.records.filter((record) => PENDING_STATUSES.includes(record.status))

  return {
    stats: [
      { label: `观测站次（${statsDate}）`, value: todayRecords.length },
      { label: `暴雨站点数（日累计≥${STORM_DAILY_THRESHOLD_MM}mm）`, value: todayStormStations.size },
      { label: '待审核记录', value: pendingRecords.length },
    ],
    rows: records.map((record) => toViewRow(record, state)),
    summaries: state.summaries,
    warnings: state.warnings.filter((warning) => warning.status === '待处理'),
  }
}

function validateDraft(draft: RainfallDraft): { amount: number } | string {
  if (!draft.stationNo.trim()) {
    return '请填写站点编号'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) {
    return '请选择观测日期'
  }
  if (!Number.isInteger(draft.startHour) || draft.startHour < 0 || draft.startHour > 23) {
    return '观测时段无效'
  }
  const amount = Number(draft.amount)
  if (draft.amount.trim() === '' || !Number.isFinite(amount) || amount < 0) {
    return '时段雨量需为不小于 0 的数字（mm）'
  }
  if (!draft.observer.trim()) {
    return '请填写观测人'
  }
  return { amount: Math.round(amount * 10) / 10 }
}

/**
 * 登记一条雨量记录。唯一性在事务提交时基于磁盘最新数据校验，
 * 两个终端同时补录同一站同一时段：后落库的事务版本号不匹配/命中重复，整体拒绝，只保留一条。
 */
export function registerRainfall(draft: RainfallDraft): ActionResult {
  const validated = validateDraft(draft)
  if (typeof validated === 'string') {
    return { ok: false, message: validated }
  }
  const state = getRainfallState()
  const baseVersion = state.version
  const stationNo = draft.stationNo.trim()
  try {
    commitRainfallTransaction(
      baseVersion,
      (mutating) => {
        const duplicate = findDuplicate(mutating.records, stationNo, draft.date, draft.startHour)
        if (duplicate) {
          throw new Error(
            `${stationNo} ${periodLabel(draft.date, draft.startHour)} 已登记（${duplicate.recordNo}），请直接修正该时段雨量`,
          )
        }
        const record = buildRecord({
          id: mutating.nextRecordId,
          stationNo,
          date: draft.date,
          startHour: draft.startHour,
          amount: validated.amount,
          observer: draft.observer.trim(),
          sampledAt: nowDateTimeLabel(),
        })
        mutating.nextRecordId += 1
        mutating.records.push(record)
      },
      nowDateTimeLabel(),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : '登记失败，数据未保存'
    return {
      ok: false,
      message: /另一终端|已登记/.test(message) ? message : `登记失败，列表、汇总和预警待办均已回退（${message}）`,
    }
  }
  return { ok: true, message: '雨量记录已登记，时段汇总与暴雨待办已同步更新' }
}

/** 修正某条时段雨量：只改雨量与观测人，原采样时间保持不动；汇总与待办同事务重算。 */
export function correctRainfall(
  id: number,
  patch: { amount: string; observer: string },
): ActionResult {
  const state = getRainfallState()
  const baseVersion = state.version
  const target = state.records.find((record) => record.id === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  const amount = Number(patch.amount)
  if (patch.amount.trim() === '' || !Number.isFinite(amount) || amount < 0) {
    return { ok: false, message: '时段雨量需为不小于 0 的数字（mm）' }
  }
  if (!patch.observer.trim()) {
    return { ok: false, message: '请填写观测人' }
  }
  try {
    commitRainfallTransaction(
      baseVersion,
      (mutating) => {
        const index = mutating.records.findIndex((record) => record.id === id)
        if (index < 0) {
          throw new Error(`没有找到编号为 ${id} 的雨量记录`)
        }
        mutating.records[index] = {
          ...mutating.records[index],
          amount: Math.round(amount * 10) / 10,
          observer: patch.observer.trim(),
          // sampledAt 刻意不覆盖：修正不能抹掉原采样时间
        }
      },
      nowDateTimeLabel(),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : '修正失败，数据未保存'
    return {
      ok: false,
      message: /另一终端/.test(message) ? message : `修正失败，列表、汇总和预警待办均已回退（${message}）`,
    }
  }
  return { ok: true, message: '时段雨量已修正，日累计与暴雨站点数已同步重算' }
}

/** 状态流转（提交审核/确认通过/标记异常）：同样走事务，汇总（异常时段剔除）与待办同步。 */
export function changeRainfallStatus(id: number, action: string): ActionResult {
  const targetStatus = STATUS_ACTIONS[action]
  if (!targetStatus) {
    return { ok: false, message: `雨量记录没有登记「${action}」这个动作` }
  }
  const state = getRainfallState()
  const baseVersion = state.version
  const target = state.records.find((record) => record.id === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  if (target.status === targetStatus) {
    return { ok: false, message: `雨量记录已经是「${targetStatus}」，不用重复操作` }
  }
  try {
    commitRainfallTransaction(
      baseVersion,
      (mutating) => {
        const index = mutating.records.findIndex((record) => record.id === id)
        if (index < 0) {
          throw new Error(`没有找到编号为 ${id} 的雨量记录`)
        }
        mutating.records[index] = { ...mutating.records[index], status: targetStatus }
      },
      nowDateTimeLabel(),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : `${action}失败，数据未保存`
    return {
      ok: false,
      message: /另一终端/.test(message) ? message : `${action}失败，列表、汇总和预警待办均已回退（${message}）`,
    }
  }
  return { ok: true, message: `雨量记录已${action}，当前状态「${targetStatus}」` }
}

/** 人工解除暴雨待办：解除动作也在同一事务里，失败时待办仍保持待处理。 */
export function resolveRainfallWarning(id: number): ActionResult {
  const state = getRainfallState()
  const baseVersion = state.version
  const target = state.warnings.find((warning) => warning.id === id)
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的暴雨待办` }
  }
  if (target.status !== '待处理') {
    return { ok: false, message: '该暴雨待办已解除' }
  }
  try {
    commitRainfallTransaction(
      baseVersion,
      (mutating) => {
        const index = mutating.warnings.findIndex((warning) => warning.id === id)
        if (index < 0 || mutating.warnings[index].status !== '待处理') {
          throw new Error('该暴雨待办状态已变化，请刷新后重试')
        }
        mutating.warnings[index] = {
          ...mutating.warnings[index],
          status: '已解除',
          resolvedAt: nowDateTimeLabel(),
        }
      },
      nowDateTimeLabel(),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : '解除失败，待办未变化'
    return {
      ok: false,
      message: /另一终端/.test(message) ? message : `解除失败，预警待办已回退（${message}）`,
    }
  }
  return { ok: true, message: '暴雨待办已解除' }
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出清单：与页面列表、汇总同读已提交的结构化状态，不再拼任何旧字符串字段。 */
export function exportRainfallCsv(filters: Record<string, string> = {}): { filename: string; content: string } {
  const overview = getRainfallOverview(filters, '')
  const header = ['记录编号', '站点编号', '观测时段', '时段雨量(mm)', '日累计雨量(mm)', '降雨强度', '采样时间', '观测人', '记录状态']
  const lines = [header.join(',')]
  for (const row of overview.rows) {
    lines.push(
      [
        row.recordNo,
        row.stationNo,
        row.period,
        row.amount,
        row.dailyAmount,
        row.intensity,
        row.sampledAt,
        row.observer,
        row.status,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: '雨量观测-清单.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadRainfallCsv(filters: Record<string, string> = {}): void {
  const { filename, content } = exportRainfallCsv(filters)
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
