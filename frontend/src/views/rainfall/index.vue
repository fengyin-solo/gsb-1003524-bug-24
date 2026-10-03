<template>
  <section class="page" data-module="rainfall">
    <header class="page-head">
      <div>
        <h2>雨量观测管理</h2>
        <p class="page-desc">维护雨量记录，围绕记录编号、站点编号、观测时段、时段雨量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记雨量记录</button>
        <button class="btn" type="button" @click="exportRows">导出雨量观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in snapshot.stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="todo-panel">
      <h3 class="panel-title">暴雨预警待办（日累计 ≥ 50mm，与登记/修正同次落库）</h3>
      <ul v-if="snapshot.todos.length" class="todo-list">
        <li v-for="todo in snapshot.todos" :key="todo.id" class="todo-item">
          <span class="todo-level" :class="todo.level">{{ todo.level }}</span>
          <span>站点 {{ todo.station }}</span>
          <span>{{ todo.day }}</span>
          <span>日累计 {{ todo.dailyTotal.toFixed(1) }}mm</span>
          <span>最大时段 {{ todo.maxAmount.toFixed(1) }}mm</span>
          <span>{{ todo.periods }} 个时段</span>
        </li>
      </ul>
      <p v-else class="todo-empty">暂无暴雨预警待办</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <h3 class="panel-title">时段汇总（同站点同日累计，异常值不参与）</h3>
    <table class="data-table summary-table">
      <thead>
        <tr>
          <th>站点编号</th>
          <th>日期</th>
          <th>日累计雨量(mm)</th>
          <th>最大时段雨量(mm)</th>
          <th>时段数</th>
          <th>当日量级</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in snapshot.daySummaries" :key="`${item.station}-${item.day}`">
          <td>{{ item.station }}</td>
          <td>{{ item.day }}</td>
          <td>{{ item.total.toFixed(1) }}</td>
          <td>{{ item.maxAmount.toFixed(1) }}</td>
          <td>{{ item.periods }}</td>
          <td>{{ item.level }}</td>
        </tr>
        <tr v-if="!snapshot.daySummaries.length">
          <td colspan="6" class="empty-state">暂无可汇总的雨量记录</td>
        </tr>
      </tbody>
    </table>

    <h3 class="panel-title">雨量记录列表</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in snapshot.items" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
        <tr v-if="!snapshot.items.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无雨量观测数据，可先登记雨量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ snapshot.total }} 条雨量观测记录（含同站点同时段历史重复合并结果，原采样时间保留）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="formOpen" class="modal-mask" @click.self="closeForm">
      <form class="modal-card" @submit.prevent="submitForm">
        <h3 class="panel-title">{{ formMode === 'create' ? '登记雨量记录' : `修正雨量记录 ${form.code}` }}</h3>
        <p v-if="formMode === 'correct'" class="form-hint">
          站点与观测时段不可修改；修正后记录退回「待审核」，日累计、暴雨站点数与预警待办同次重算。
        </p>
        <label class="form-field">
          <span>站点编号</span>
          <input v-model="form.station" :disabled="formMode === 'correct'" placeholder="如 61203" />
        </label>
        <label class="form-field">
          <span>观测时段</span>
          <input
            v-model="form.period"
            :disabled="formMode === 'correct'"
            placeholder="YYYY-MM-DD 或 YYYY-MM-DD HH:mm-HH:mm"
          />
        </label>
        <label class="form-field">
          <span>时段雨量(mm)</span>
          <input v-model.number="form.amount" type="number" step="0.1" min="0" placeholder="如 25.5" />
        </label>
        <label class="form-field">
          <span>观测人</span>
          <input v-model="form.observer" placeholder="观测人姓名" />
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="form-actions">
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="submit" :disabled="submitting">
            {{ submitting ? '提交中…' : formMode === 'create' ? '登记' : '保存修正' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'

import {
  correctRainfall,
  downloadEntries,
  moduleMeta,
  rainfallSnapshot,
  registerRainfall,
  runAction as applyAction,
  subscribeRainfall,
} from '@/api/local-service'
import type { RainfallSnapshot } from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'

const meta = moduleMeta('rainfall')
const columns = [
  "记录编号",
  "站点编号",
  "观测时段",
  "时段雨量",
  "日累计雨量",
  "降雨强度",
  "观测人",
  "原采样时间",
  "记录状态",
]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]

function emptySnapshot(): RainfallSnapshot {
  return { items: [], total: 0, stats: [], daySummaries: [], todos: [] }
}

const snapshot = reactive<RainfallSnapshot>(emptySnapshot())
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["记录编号", "站点编号", "观测时段"]
const statusSummary = ref<{ status: string; count: number }[]>([])

const formOpen = ref(false)
const submitting = ref(false)
const formError = ref('')
const formMode = ref<'create' | 'correct'>('create')
const form = reactive({ id: 0, code: '', station: '', period: '', amount: '' as number | '', observer: '' })

function refreshStatusSummary() {
  statusSummary.value = statuses.map((status: string) => ({
    status,
    count: snapshot.items.filter((row) => String(row.status) === status).length,
  }))
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = rainfallSnapshot(filters.value)
    snapshot.items = payload.items
    snapshot.total = payload.total
    snapshot.stats = payload.stats
    snapshot.daySummaries = payload.daySummaries
    snapshot.todos = payload.todos
    refreshStatusSummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '雨量观测列表读取失败'
  }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  // 订阅存储变更：其它终端补录/修正，或本页事务提交后，列表、汇总、待办统一刷新，不残留旧结果。
  unsubscribe = subscribeRainfall(reload)
  reload()
})

onUnmounted(() => {
  unsubscribe?.()
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  formMode.value = 'create'
  form.id = 0
  form.code = ''
  form.station = ''
  form.period = ''
  form.amount = ''
  form.observer = ''
  formError.value = ''
  formOpen.value = true
}

function openCorrect(row: EntryRow) {
  formMode.value = 'correct'
  form.id = Number(row.id)
  form.code = String(row.记录编号 ?? '')
  form.station = String(row.站点编号 ?? '')
  form.period = String(row.观测时段 ?? '')
  form.amount = Number(row.时段雨量)
  form.observer = String(row.观测人 ?? '')
  formError.value = ''
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
}

async function submitForm() {
  formError.value = ''
  submitting.value = true
  try {
    const result =
      formMode.value === 'create'
        ? await registerRainfall({
            station: form.station,
            period: form.period,
            amount: Number(form.amount),
            observer: form.observer,
          })
        : await correctRainfall(form.id, {
            amount: Number(form.amount),
            observer: form.observer,
          })
    if (!result.ok) {
      formError.value = result.message
      return
    }
    formOpen.value = false
    reload()
  } finally {
    submitting.value = false
  }
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result: ActionResult = await applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}
</script>

<style scoped>
.todo-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.panel-title {
  font-size: 14px;
  margin: 0 0 8px;
}
.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.todo-item {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 13px;
}
.todo-level {
  border-radius: 999px;
  padding: 1px 10px;
  color: #fff;
  background: #b54708;
}
.todo-level.大暴雨 {
  background: #b42318;
}
.todo-level.特大暴雨 {
  background: #7a271a;
}
.todo-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.summary-table {
  margin-bottom: 16px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  width: 420px;
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.form-hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.form-field input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: #1f2937;
}
.form-field input:disabled {
  background: #f1f5f9;
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
