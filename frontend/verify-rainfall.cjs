/**
 * 雨量数据流验证脚本（不进生产包）：用 esbuild 把 TS 源码打成 CJS 在 Node 里跑，
 * 浏览器 API（localStorage / navigator.locks / storage 事件）用内存 shim 模拟，
 * 支持构造「两个终端」（各自缓存 + 同一共享存储）验证并发补录。
 */
const { build } = require('esbuild')
const path = require('path')
const vm = require('vm')

const SRC = path.join(__dirname, 'src')

function createBrowserEnv() {
  const storeMap = new Map()
  const listeners = []
  const localStorage = {
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => {
      storeMap.set(k, String(v))
    },
    removeItem: (k) => storeMap.delete(k),
    clear: () => storeMap.clear(),
    _snapshot: () => new Map(storeMap),
  }
  const windowObj = {
    localStorage,
    addEventListener: (_type, fn) => listeners.push(fn),
  }
  const sandbox = {
    console,
    Math,
    JSON,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Infinity,
    NaN,
    isNaN,
    parseInt,
    parseFloat,
    Promise,
    setTimeout,
    clearTimeout,
    window: windowObj,
    navigator: { locks: undefined },
    document: undefined,
  }
  sandbox.globalThis = sandbox
  return {
    sandbox,
    storage: localStorage,
    emitStorage(key) {
      for (const fn of listeners) fn({ key })
    },
    async runTwoTerminals(body) {
      const envA = createBrowserEnv.call(null)
      // 共享同一份存储，独立缓存、独立监听者。
      const shared = envA.storage
      const listenersA = []
      envA.sandbox.window.addEventListener = (_t, fn) => listenersA.push(fn)
      const envB = {
        sandbox: {
          console, Math, JSON, Date, Number, String, Boolean, Array, Object, Set, Map,
          Infinity, NaN, isNaN, parseInt, parseFloat, Promise, setTimeout, clearTimeout,
          navigator: { locks: undefined },
          document: undefined,
        },
      }
      envB.sandbox.globalThis = envB.sandbox
      envB.sandbox.window = {
        localStorage: shared,
        addEventListener: (_t, fn) => listeners.push(fn),
      }
      // B 的 storage 事件直接调用 A 的监听者（模拟浏览器在另一标签派发 storage 事件）。
      const crossEmit = (key) => {
        for (const fn of listenersA) fn({ key })
      }
      await body({ envA, envB, shared, crossEmit })
    },
  }
}

async function loadModule(env, relPath) {
  const result = await build({
    entryPoints: [path.join(SRC, relPath)],
    bundle: true,
    format: 'cjs',
    write: false,
    platform: 'browser',
    alias: { '@': SRC },
    external: [],
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  const moduleObj = { exports: {} }
  const context = vm.createContext({
    ...env.sandbox,
    module: moduleObj,
    exports: moduleObj.exports,
    require: (name) => {
      if (name === 'vue') return {}
      throw new Error(`unexpected require ${name}`)
    },
  })
  vm.runInContext(code, context, { filename: relPath })
  return moduleObj.exports
}

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function approx(a, b) {
  return Math.abs(a - b) < 1e-6
}

async function main() {
  // ---------- 1. 领域层纯函数 ----------
  console.log('领域层：合并 / 汇总 / 登记 / 修正 / 回退')
  const env = createBrowserEnv()
  const domain = await loadModule(env, 'data/rainfall/domain.ts')

  const rows = [
    {
      id: 1, status: '已采集', pending: true, abnormal: false,
      记录编号: 'R-OLD-1', 站点编号: ' S01 ', 观测时段: '2026/10/03 08:00～14:00',
      时段雨量: 30, 观测人: '甲', _sampleTime: '2026-10-03 08:05',
      _createdAt: 1000, _updatedAt: 1000,
    },
    {
      id: 2, status: '待审核', pending: true, abnormal: false,
      记录编号: 'R-DUP-2', 站点编号: 'S01', 观测时段: '2026-10-03 08:00-14:00',
      时段雨量: 25, 观测人: '乙', _sampleTime: '2026-10-03 12:00',
      _createdAt: 2000, _updatedAt: 5000,
    },
    {
      id: 3, status: '已通过', pending: false, abnormal: false,
      记录编号: 'R-3', 站点编号: 'S01', 观测时段: '2026-10-03 14:00-20:00',
      时段雨量: 26, 观测人: '甲',
      _createdAt: 3000, _updatedAt: 3000,
    },
    {
      id: 4, status: '异常值', pending: true, abnormal: true,
      记录编号: 'R-BAD', 站点编号: 'S02', 观测时段: '2026-10-03 08:00-20:00',
      时段雨量: 999, 观测人: '丙',
      _createdAt: 4000, _updatedAt: 4000,
    },
  ]

  const hydrated = domain.hydrateRainfall(rows)
  check('历史重复合并后只剩 3 条（2 条同站点同时段合 1）', hydrated.length === 3, `实际 ${hydrated.length}`)
  const merged = hydrated.find((r) => String(r.站点编号) === 'S01' && String(r.观测时段).includes('08:00'))
  check('合并保留最早登记的记录编号', merged && merged.记录编号 === 'R-OLD-1')
  check('合并保留原采样时间', merged && merged._sampleTime === '2026-10-03 08:05', String(merged && merged._sampleTime))
  check('合并取最近更新的雨量值（修正覆盖）= 25', merged && Number(merged.时段雨量) === 25, String(merged && merged.时段雨量))
  check('合并取最近更新的观测人 = 乙', merged && merged.观测人 === '乙')
  check('合并取最高审核状态 = 待审核', merged && merged.status === '待审核', String(merged && merged.status))
  check('合并幂等：再跑一次仍 3 条', domain.hydrateRainfall(hydrated).length === 3)

  const summaries = domain.buildDaySummaries(hydrated)
  const s01 = summaries.find((s) => s.station === 'S01' && s.day === '2026-10-03')
  check('S01 日累计 = 30→25 + 26 = 51', s01 && approx(s01.total, 51), String(s01 && s01.total))
  check('S01 最大时段 = 26', s01 && approx(s01.maxAmount, 26))
  check('S01 时段数 = 2', s01 && s01.periods === 2)
  check('S01 量级 = 暴雨', s01 && s01.level === '暴雨', String(s01 && s01.level))
  check('异常值不参与汇总：无 S02', !summaries.some((s) => s.station === 'S02'))

  const todos = domain.buildRainfallTodos(hydrated)
  check('暴雨待办 1 条且指向 S01', todos.length === 1 && todos[0].station === 'S01', JSON.stringify(todos))

  const stats = domain.rainfallStats(hydrated, '2026-10-03')
  check('今日观测站次 = 2（S01 两条计入，S02 异常不计）', stats.stationVisits === 2, String(stats.stationVisits))
  check('暴雨站点数 = 1', stats.stormStations === 1, String(stats.stormStations))
  check('待审核记录 = 1（合并条待审核，另一条已通过，异常不计）', stats.pending === 1, String(stats.pending))

  // 修正到阈值以下：待办应自动销项
  const working = hydrated.map((r) => ({ ...r }))
  domain.rainCorrect(working, merged.id, { amount: 5, observer: '乙' }, 9000)
  const corrected = working.find((r) => r.id === merged.id)
  check('修正后雨量更新为 5', Number(corrected.时段雨量) === 5)
  check('修正后退回待审核', corrected.status === '待审核')
  const todos2 = domain.buildRainfallTodos(domain.hydrateRainfall(working))
  check('累计降到 31（<50）后待办销项', todos2.length === 0, JSON.stringify(todos2))

  // 合并组内任一异常 -> 合并结果异常
  const abnGroup = domain.hydrateRainfall([
    { id: 1, status: '已通过', pending: false, abnormal: false, 记录编号: 'A', 站点编号: 'X', 观测时段: '2026-10-03 08:00-14:00', 时段雨量: 10, 观测人: 'a' },
    { id: 2, status: '异常值', pending: true, abnormal: true, 记录编号: 'B', 站点编号: 'X', 观测时段: '2026-10-03 08:00-14:00', 时段雨量: 10, 观测人: 'b' },
  ])
  check('合并组含异常值则结果仍为异常值（保留原采样时间）', abnGroup[0].status === '异常值' && abnGroup[0]._sampleTime === '2026-10-03 08:00-14:00')

  // 时段规范化与输入校验
  check('时段规范化：/ 与 ～ 归一', domain.normalizePeriod('2026/10/03 08:00～20:00') === '2026-10-03 08:00-20:00')
  let threw = false
  try { domain.normalizePeriod('2026-13-40') } catch { threw = true }
  check('非法日期报错', threw)
  threw = false
  try { domain.normalizePeriod('2026-10-03 20:00-08:00') } catch { threw = true }
  check('结束早于开始报错', threw)
  threw = false
  try { domain.parseAmount(-1) } catch { threw = true }
  check('负雨量报错', threw)

  // 同站点同时段直接登记第二条 -> 拒绝
  const dupRows = domain.hydrateRainfall([
    { id: 1, status: '已采集', pending: true, abnormal: false, 记录编号: 'A', 站点编号: 'S01', 观测时段: '2026-10-03 08:00-14:00', 时段雨量: 1, 观测人: 'a' },
  ])
  threw = false
  try { domain.rainRegister(dupRows, { station: 's01', period: '2026-10-03 08:00-14:00', amount: 2, observer: 'b' }, 1) } catch { threw = true }
  check('领域层拒绝重复登记（大小写空白规范化后仍判重）', threw)

  // ---------- 2. 持久化事务：原子性 + 落库失败整体回退 ----------
  console.log('持久化：事务原子提交 / 失败整体回退 / 旧数据迁移')
  const env2 = createBrowserEnv()
  const store = await loadModule(env2, 'data/local-store.ts')

  // 预置一份「旧格式」裸模块映射
  env2.storage.setItem(store.storageKey(), JSON.stringify({
    station: [],
    rainfall: [
      { id: 1, status: '已采集', pending: true, abnormal: false, 记录编号: 'OLD', 站点编号: 'S09', 观测时段: '2026-10-03 08:00-20:00', 时段雨量: 60, 观测人: '旧' },
    ],
  }))
  // 首次读取触发迁移并一次性写回
  store.allRows()
  const stateAfterMigrate = JSON.parse(env2.storage.getItem(store.storageKey()))
  check('旧裸映射迁移后具备 revision/modules/rainfallTodos 外壳',
    stateAfterMigrate.revision >= 1 && Array.isArray(stateAfterMigrate.modules.rainfall) && Array.isArray(stateAfterMigrate.rainfallTodos))
  check('迁移时旧雨量记录已补水（_sampleTime 保留观测时段）',
    stateAfterMigrate.modules.rainfall[0]._sampleTime === '2026-10-03 08:00-20:00')
  check('迁移时暴雨待办已生成', stateAfterMigrate.rainfallTodos.length === 1)

  const before = JSON.parse(env2.storage.getItem(store.storageKey()))
  let rollback = null
  try {
    await store.transact((modules) => {
      modules.rainfall.push({
        id: 999, status: '已采集', pending: true, abnormal: false,
        记录编号: 'TMP', 站点编号: 'S99', 观测时段: '2026-10-03 08:00-14:00',
        时段雨量: 1, 观测人: 't',
      })
      throw new Error('模拟业务失败')
    })
  } catch (e) {
    rollback = e
  }
  check('事务内抛错向外传递', rollback instanceof Error)
  const after = JSON.parse(env2.storage.getItem(store.storageKey()))
  check('失败后存储原样不动（列表/汇总/待办一起回退）',
    JSON.stringify(after) === JSON.stringify(before))

  // 落库失败（setItem 抛配额错）也不得改缓存
  const env3 = createBrowserEnv()
  const store3 = await loadModule(env3, 'data/local-store.ts')
  // 先热读完成种子落库，再让「下一次」setItem 失败，精准模拟事务提交时配额耗尽。
  const goodBefore = store3.listRows('rainfall').length
  const origSetItem = env3.sandbox.window.localStorage.setItem
  let failOnce = true
  env3.sandbox.window.localStorage.setItem = (k, v) => {
    if (failOnce) { failOnce = false; throw new Error('QuotaExceededError') }
    origSetItem(k, v)
  }
  let quotaErr = null
  try {
    await store3.transact((modules) => {
      modules.rainfall.push({
        id: 999, status: '已采集', pending: true, abnormal: false,
        记录编号: 'TMP2', 站点编号: 'S98', 观测时段: '2026-10-03 08:00-14:00',
        时段雨量: 1, 观测人: 't',
      })
    })
  } catch (e) { quotaErr = e }
  check('setItem 失败时事务报错', quotaErr instanceof Error)
  check('setItem 失败后内存缓存回退（不留半条）', store3.listRows('rainfall').length === goodBefore)

  // ---------- 3. 两个终端同时补录 ----------
  console.log('并发：两个终端同时补录同站点同时段，只保留一条')
  const envA = createBrowserEnv()
  const storeA = await loadModule(envA, 'data/local-store.ts')
  // 终端 B：与 A 共享 storage，但独立缓存与模块实例；Web Locks 用串行 shim 模拟。
  const sharedStorage = envA.sandbox.window.localStorage
  const listenersA = []
  envA.sandbox.window.addEventListener = (_t, fn) => listenersA.push(fn)

  function makeTerminalB() {
    const listenersB = []
    const winB = {
      localStorage: sharedStorage,
      addEventListener: (_t, fn) => listenersB.push(fn),
    }
    const sandboxB = {
      console, Math, JSON, Date, Number, String, Boolean, Array, Object, Set, Map,
      Infinity, NaN, isNaN, parseInt, parseFloat, Promise, setTimeout, clearTimeout,
      window: winB, navigator: {}, document: undefined,
    }
    sandboxB.globalThis = sandboxB
    return { sandbox: sandboxB, listeners: listenersB }
  }

  // 简单 Web Locks shim：同名锁排队，回调同步执行。
  function installLockShim(sandbox, queueRef) {
    sandbox.navigator.locks = {
      request(name, cb) {
        return new Promise((resolve, reject) => {
          queueRef.queue.push({ name, cb, resolve, reject })
          queueRef.pump()
        })
      },
    }
  }
  const lockQueue = {
    busy: false,
    queue: [],
    pump() {
      if (this.busy) return
      const job = this.queue.shift()
      if (!job) return
      this.busy = true
      // 用微任务模拟「拿锁→重读→执行→释放」，保证两个 request 先排队再依次执行。
      Promise.resolve().then(() => {
        try {
          const r = job.cb()
          Promise.resolve(r).then(
            (v) => { this.busy = false; job.resolve(v); this.pump() },
            (e) => { this.busy = false; job.reject(e); this.pump() },
          )
        } catch (e) {
          this.busy = false
          job.reject(e)
          this.pump()
        }
      })
    },
  }
  installLockShim(envA.sandbox, lockQueue)
  const termB = makeTerminalB()
  installLockShim(termB.sandbox, lockQueue)
  const storeB = await loadModule({ sandbox: termB.sandbox }, 'data/local-store.ts')

  const input = { station: 'S77', period: '2026-10-03 08:00-14:00', amount: 12, observer: '终端' }
  // 清掉种子雨量数据，保证计数确定
  await storeA.transact((modules) => { modules.rainfall = [] })
  // B 先热读一次（拥有独立旧缓存），随后两边「同时」发起登记
  storeB.listRows('rainfall')
  const [resA, resB] = await Promise.all([
    storeA.transact((modules) => domain.rainRegister(modules.rainfall, input, 100))
      .then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, message: e.message })),
    storeB.transact((modules) => domain.rainRegister(modules.rainfall, input, 200))
      .then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, message: e.message })),
  ])
  const winners = [resA, resB].filter((r) => r && r.ok)
  const losers = [resA, resB].filter((r) => r && !r.ok)
  check('两个并发补录恰好一个成功', winners.length === 1 && losers.length === 1,
    `A=${JSON.stringify(resA)} B=${JSON.stringify(resB)}`)
  check('失败方拿到「已登记」提示且整笔回退', losers[0] && String(losers[0].message).includes('已登记'))

  // 两边都重新从存储读（模拟 B 收到 storage 事件后的刷新）
  const finalRowsA = JSON.parse(sharedStorage.getItem(storeA.storageKey())).modules.rainfall
  check('存储中同站点同时段只有一条', finalRowsA.length === 1 && finalRowsA[0].站点编号 === 'S77',
    JSON.stringify(finalRowsA.map((r) => ({ id: r.id, code: r.记录编号 }))))

  // ---------- 4. 服务层端到端 ----------
  console.log('服务层：登记 → 列表/汇总/导出一致 → 修正联动 → 待办销项')
  const env4 = createBrowserEnv()
  const service = await loadModule(env4, 'api/local-service.ts')
  await service.transact?.((modules) => { modules.rainfall = [] }) // 不存在的导出则跳过
  // service 没转出 transact；用 local-store 清种子
  const store4 = await loadModule(env4, 'data/local-store.ts')
  await store4.transact((modules) => { modules.rainfall = [] })

  const reg = await service.registerRainfall({ station: '61203', period: '2026-10-03 08:00-14:00', amount: 30, observer: '甲' })
  check('登记成功', reg.ok && reg.code, JSON.stringify(reg))
  const regDup = await service.registerRainfall({ station: '61203', period: '2026-10-03 08:00-14:00', amount: 5, observer: '乙' })
  check('重复登记被服务层拒绝', !regDup.ok && regDup.message.includes('不能重复登记'))

  await service.registerRainfall({ station: '61203', period: '2026-10-03 14:00-20:00', amount: 25, observer: '甲' })
  const snap1 = service.rainfallSnapshot({}, '2026-10-03')
  check('列表两行日累计均为 55.0',
    snap1.items.every((r) => r.日累计雨量 === '55.0'),
    snap1.items.map((r) => r.日累计雨量).join(','))
  check('暴雨站点数卡片 = 1', snap1.stats.find((s) => s.label === '暴雨站点数').value === 1)
  check('时段汇总 1 行累计 55.0', snap1.daySummaries.length === 1 && snap1.daySummaries[0].total === 55)
  check('预警待办 1 条', snap1.todos.length === 1)

  // 导出与列表同源
  const csv = service.exportEntries('rainfall').content
  check('导出清单含日累计 55.0 与原采样时间列',
    csv.includes('55.0') && csv.includes('原采样时间') && csv.includes('2026-10-03 08:00-14:00'))

  // 修正第一条 30 -> 10：日累计应变 35，暴雨站点与待办应消失
  const targetId = snap1.items.find((r) => String(r.观测时段).includes('08:00')).id
  const corr = await service.correctRainfall(Number(targetId), { amount: 10, observer: '甲改' })
  check('修正成功', corr.ok, JSON.stringify(corr))
  const snap2 = service.rainfallSnapshot({}, '2026-10-03')
  check('修正后两行日累计均为 35.0',
    snap2.items.every((r) => r.日累计雨量 === '35.0'),
    snap2.items.map((r) => `${r.时段雨量}:${r.日累计雨量}`).join(','))
  check('修正后暴雨站点数 = 0', snap2.stats.find((s) => s.label === '暴雨站点数').value === 0)
  check('修正后预警待办销项 = 0 条', snap2.todos.length === 0)
  check('修正后记录退回待审核',
    snap2.items.find((r) => Number(r.id) === Number(targetId)).status === '待审核')
  check('修正后原采样时间仍保留',
    snap2.items.find((r) => Number(r.id) === Number(targetId)).原采样时间 === '2026-10-03 08:00-14:00')

  // 状态流转失败（重复操作）不落库：挑一条「已采集」记录连续提交两次审核
  const collected = snap2.items.find((r) => r.status === '已采集')
  const act1 = await service.runAction('rainfall', Number(collected.id), '提交审核')
  const act2 = await service.runAction('rainfall', Number(collected.id), '提交审核')
  check('重复提交审核被拒', act1.ok && !act2.ok && act2.message.includes('重复操作'))

  // 标记异常后该站该日不再产生待办
  await service.runAction('rainfall', Number(collected.id), '标记异常')
  const snap3 = service.rainfallSnapshot({}, '2026-10-03')
  check('异常行在列表中日累计显示 — 且不参与汇总',
    snap3.items.find((r) => Number(r.id) === Number(collected.id)).日累计雨量 === '—')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
