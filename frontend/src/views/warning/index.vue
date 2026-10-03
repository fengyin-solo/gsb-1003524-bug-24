<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">维护预警阈值配置，围绕配置编号、站点编号、监测类型、蓝色阈值做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警阈值配置</button>
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="todo-panel">
      <h3 class="panel-title">暴雨预警待办（雨量模块日累计 ≥ 50mm，登记/修正时自动联动）</h3>
      <ul v-if="rainTodos.length" class="todo-list">
        <li v-for="todo in rainTodos" :key="todo.id" class="todo-item">
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无预警阈值数据，可先登记预警阈值配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警阈值记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listRainfallTodos,
  moduleMeta,
  runAction as applyAction,
  subscribeRainfall,
} from '@/api/local-service'
import type { RainfallTodo } from '@/data/rainfall/domain'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('warning')
const columns = ["配置编号", "站点编号", "监测类型", "蓝色阈值", "黄色阈值", "橙色阈值", "红色阈值", "生效状态"]
const actions = ["发布生效", "调整阈值", "停用配置"]
const statuses = ["草稿", "已生效", "已调整", "已停用"]
const stats = [{"label": "配置总数", "value": 0}, {"label": "已生效数", "value": 0}, {"label": "本月调整数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const rainTodos = ref<RainfallTodo[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '预警阈值配置登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = await applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    rainTodos.value = listRainfallTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警阈值列表读取失败'
  }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  // 雨量登记/修正与预警待办同次落库后，本页订阅刷新，避免待办残留旧值。
  unsubscribe = subscribeRainfall(reload)
  reload()
})

onUnmounted(() => {
  unsubscribe?.()
})
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
</style>
