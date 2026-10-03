<template>
  <section class="page" data-module="rainfall">
    <header class="page-head">
      <div>
        <h2>雨量观测管理</h2>
        <p class="page-desc">维护雨量记录，围绕记录编号、站点编号、观测时段、时段雨量做登记、修正与状态流转；修正记录与时段汇总、暴雨待办同次落库。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记雨量记录</button>
        <button class="btn" type="button" @click="exportRows">导出雨量观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field.key" class="filter-item">
        <span>{{ field.label }}</span>
        <input v-model="filters[field.key]" :placeholder="`按${field.label}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column.key">{{ column.label }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td v-for="column in columns" :key="column.key">{{ row[column.key] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openCorrect(row)">修正雨量</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无雨量观测数据，可先登记雨量记录</td>
        </tr>
      </tbody>
    </table>

    <section class="todo-panel">
      <h3>暴雨预警待办（日累计雨量 ≥ 50mm）</h3>
      <table v-if="warningRows.length" class="data-table">
        <thead>
          <tr>
            <th>站点编号</th>
            <th>日期</th>
            <th>日累计雨量(mm)</th>
            <th>生成时间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in warningRows" :key="todo.id">
            <td>{{ todo.stationNo }}</td>
            <td>{{ todo.date }}</td>
            <td>{{ todo.dailyAmount.toFixed(1) }}</td>
            <td>{{ todo.createdAt }}</td>
            <td>{{ todo.status }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="resolveWarning(todo)">核实解除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">当前没有待处理的暴雨预警</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条雨量观测记录 · 同站同时段重复登记只保留一条（合并时保留最早采样时间）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="formVisible" class="modal-mask" @click.self="closeForm">
      <form class="modal-card" @submit.prevent="submitForm">
        <h3 class="modal-title">{{ formMode === 'create' ? '登记雨量记录' : `修正雨量记录 ${editingNo}` }}</h3>
        <label class="form-item">
          <span>站点编号</span>
          <input v-model.trim="form.stationNo" placeholder="如 STAT-01" :disabled="formMode === 'correct'" />
        </label>
        <div class="form-row">
          <label class="form-item">
            <span>观测日期</span>
            <input v-model="form.date" type="date" :disabled="formMode === 'correct'" />
          </label>
          <label class="form-item">
            <span>观测时段（起始小时）</span>
            <select v-model.number="form.startHour" :disabled="formMode === 'correct'">
              <option v-for="hour in 24" :key="hour - 1" :value="hour - 1">
                {{ String(hour - 1).padStart(2, '0') }}:00-{{ String(hour % 24).padStart(2, '0') }}:00
              </option>
            </select>
          </label>
        </div>
        <label class="form-item">
          <span>时段雨量（mm）</span>
          <input v-model.trim="form.amount" type="number" min="0" step="0.1" placeholder="如 12.5" />
        </label>
        <label class="form-item">
          <span>观测人</span>
          <input v-model.trim="form.observer" placeholder="观测人姓名" />
        </label>
        <label v-if="formMode === 'correct'" class="form-item">
          <span>原采样时间（不可修改）</span>
          <input :value="editingSampledAt" disabled />
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="submit">{{ formMode === 'create' ? '登记' : '保存修正' }}</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'

import {
  changeRainfallStatus,
  correctRainfall,
  downloadRainfallCsv,
  getRainfallOverview,
  registerRainfall,
  resolveRainfallWarning,
  type RainfallDraft,
  type RainfallViewRow,
} from '@/api/rainfall-service'
import type { RainfallWarning } from '@/data/rainfall-domain'
import { todayLabel } from '@/data/rainfall-domain'

const columns: { key: keyof RainfallViewRow; label: string }[] = [
  { key: 'recordNo', label: '记录编号' },
  { key: 'stationNo', label: '站点编号' },
  { key: 'period', label: '观测时段' },
  { key: 'amount', label: '时段雨量(mm)' },
  { key: 'dailyAmount', label: '日累计雨量(mm)' },
  { key: 'intensity', label: '降雨强度' },
  { key: 'sampledAt', label: '采样时间' },
  { key: 'observer', label: '观测人' },
]
const filterFields = [
  { key: 'recordNo', label: '记录编号' },
  { key: 'stationNo', label: '站点编号' },
  { key: 'period', label: '观测时段' },
] as const
const actions = ['提交审核', '确认通过', '标记异常']
const statuses = ['已采集', '待审核', '已通过', '异常值']

const stats = ref<{ label: string; value: number }[]>([])
const rows = ref<RainfallViewRow[]>([])
const warningRows = ref<RainfallWarning[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = reactive<Record<string, string>>({
  recordNo: '',
  stationNo: '',
  period: '',
})

const statusSummary = ref<{ status: string; count: number }[]>([])

const formVisible = ref(false)
const formMode = ref<'create' | 'correct'>('create')
const editingId = ref<number | null>(null)
const editingNo = ref('')
const editingSampledAt = ref('')
const formError = ref('')
const form = reactive<RainfallDraft>({
  stationNo: '',
  date: todayLabel(),
  startHour: 8,
  amount: '',
  observer: '',
})

function reload() {
  errorMessage.value = ''
  try {
    const overview = getRainfallOverview(filters, todayLabel())
    stats.value = overview.stats
    rows.value = overview.rows
    warningRows.value = overview.warnings
    total.value = overview.rows.length
    statusSummary.value = statuses.map((status) => ({
      status,
      count: overview.rows.filter((row) => row.status === status).length,
    }))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '雨量观测列表读取失败'
  }
}

function resetFilters() {
  for (const key of Object.keys(filters)) {
    filters[key] = ''
  }
  reload()
}

function exportRows() {
  errorMessage.value = ''
  try {
    downloadRainfallCsv(filters)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出失败'
  }
}

function resetForm(date: string) {
  form.stationNo = ''
  form.date = date
  form.startHour = 8
  form.amount = ''
  form.observer = ''
  formError.value = ''
}

function openCreate() {
  formMode.value = 'create'
  editingId.value = null
  editingNo.value = ''
  editingSampledAt.value = ''
  resetForm(todayLabel())
  formVisible.value = true
}

function openCorrect(row: RainfallViewRow) {
  formMode.value = 'correct'
  editingId.value = row.id
  editingNo.value = row.recordNo
  editingSampledAt.value = row.sampledAt
  // 时段标识从「YYYY-MM-DD HH:00-HH:00」解析回填
  const matched = row.period.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):00-/)
  form.stationNo = row.stationNo
  form.date = matched?.[1] ?? todayLabel()
  form.startHour = Number(matched?.[2] ?? 0)
  form.amount = row.amount
  form.observer = row.observer
  formError.value = ''
  formVisible.value = true
}

function closeForm() {
  formVisible.value = false
}

function submitForm() {
  if (formMode.value === 'create') {
    const result = registerRainfall({ ...form })
    if (!result.ok) {
      formError.value = result.message
      return
    }
    errorMessage.value = result.message
  } else if (editingId.value !== null) {
    const result = correctRainfall(editingId.value, { amount: form.amount, observer: form.observer })
    if (!result.ok) {
      formError.value = result.message
      return
    }
    errorMessage.value = result.message
  }
  formVisible.value = false
  reload()
}

function runAction(action: string, row: RainfallViewRow) {
  const result = changeRainfallStatus(row.id, action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function resolveWarning(todo: RainfallWarning) {
  const result = resolveRainfallWarning(todo.id)
  errorMessage.value = result.message
  if (!result.ok) {
    return
  }
  reload()
}

// 另一个终端落库后本页自动刷新，避免重进/停留时残留旧的列表、汇总与待办。
function handleStorageChange() {
  reload()
}

onMounted(() => {
  reload()
  window.addEventListener('rainfall:storage-changed', handleStorageChange)
})
onUnmounted(() => {
  window.removeEventListener('rainfall:storage-changed', handleStorageChange)
})
</script>
