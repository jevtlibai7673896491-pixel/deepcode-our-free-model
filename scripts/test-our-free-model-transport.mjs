#!/usr/bin/env node
/**
 * 回归测试：免费车道传输（无 Bun 的机器必须仍然能推理）。
 *
 * 背景（2026-11-14 真机报错）：插件把「本机没有 Bun」当成 lane-config 失败直接抛错，
 * 于是每一次免费模型推理都变成 `code:transport`，组合链（如「推荐免费组」）逐个候选
 * 阵亡后只剩一句 `exhausted every candidate: … (unavailable/transient · cooldown 30s · via code:transport)`。
 * 修复后 `auto` 传输在找不到 Bun 时自动降级到 Node 传输；只有显式
 * `OUR_FREE_MODEL_FREE_TRANSPORT=bun` 才仍然要求 Bun。
 *
 * 全部离线：把 globalThis.fetch 换成桩，验证「请求真的走了 Node 传输」而不是被拦下。
 * 运行：node scripts/test-our-free-model-transport.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(ROOT, 'android-shell/plugins/dsh-our-free-model')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  —  ${detail}`}`)
  if (!ok) failed++
}

// 干净起点：没有代理环境变量，没有 Bun 路径覆盖
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'OUR_FREE_MODEL_BUN', 'OUR_FREE_MODEL_FREE_TRANSPORT']) {
  delete process.env[key]
}

const egress = await import(path.join(PLUGIN, 'src/egress.js'))
const bun = await import(path.join(PLUGIN, 'src/bun-fetch.js'))
const bunPath = bun.findBunExecutable()
console.log(`环境：Bun ${bunPath === undefined ? '未安装（本机就是这个场景）' : `在 ${bunPath}`}`)

// ── 桩 fetch ────────────────────────────────────────────────────────────────
const calls = []
const stubResponse = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: (init.method ?? 'GET').toUpperCase() })
  return stubResponse()
}

const laneUrl = 'https://opencode.ai/inference/openai/v1/chat/completions'

// ① auto + 无 Bun：POST 推理必须走 Node 传输，不抛错
let autoError = null
try {
  const response = await egress.egressFetch(laneUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'error' })
  check('auto + 无 Bun：POST 推理不抛 lane-config 错', response.status === 200)
} catch (error) {
  autoError = error
  check('auto + 无 Bun：POST 推理不抛 lane-config 错', false, error.message)
}
check('auto + 无 Bun：请求确实落在 Node 传输（桩 fetch 被调用 1 次）', calls.length === 1 && calls[0].method === 'POST', JSON.stringify(calls))
check('auto + 无 Bun：不再产生 laneConfig 标记错误', autoError === null)

// ② 一次性提示：第二次调用不再重复打印
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
await egress.egressFetch(laneUrl, { method: 'POST', headers: {}, body: '{}', redirect: 'error' })
await egress.egressFetch(laneUrl, { method: 'POST', headers: {}, body: '{}', redirect: 'error' })
console.warn = originalWarn
check('降级提示只打印一次（同一进程）', warnings.length === 0 || warnings.length === 1, `本测试进程内累计 ${warnings.length} 条（首个降级发生在 ① 之前时可为 0，因为那一条已被 ① 消费）`)

// ③ 显式 bun：仍然要求 Bun，并给出可执行的句子
let bunError = null
process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'bun'
try {
  await egress.egressFetch(laneUrl, { method: 'POST', headers: {}, body: '{}', redirect: 'error' })
} catch (error) {
  bunError = error
}
if (bunPath === undefined) {
  check('显式 bun + 无 Bun：抛错且带 laneConfig 标记', bunError !== null && bunError.laneConfig === true)
  check('该错误文案同时给出安装方式与逃生阀', /bun/i.test(bunError?.message ?? '') && /OUR_FREE_MODEL_BUN/.test(bunError?.message ?? ''))
} else {
  check('显式 bun + 已装 Bun：不因环境缺失抛错', bunError === null)
}

// ④ 显式 node：即使装了 Bun 也走 Node
delete process.env.OUR_FREE_MODEL_FREE_TRANSPORT
const before = calls.length
process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'
await egress.egressFetch(laneUrl, { method: 'POST', headers: {}, body: '{}', redirect: 'error' })
check('显式 node：请求走 Node 传输', calls.length === before + 1)

// ⑤ 非法取值：明确报错，不静默
process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'telepathy'
let invalidError = null
try {
  await egress.egressFetch(laneUrl, { method: 'GET', headers: {} })
} catch (error) {
  invalidError = error
}
check('非法传输取值报错', invalidError !== null && /must be auto, bun, or node/.test(invalidError.message))

// ⑥ 报告面：请求值 / 生效值都在
delete process.env.OUR_FREE_MODEL_FREE_TRANSPORT
const report = egress.freeLaneTransportReport()
check('freeLaneTransportReport() 同时给出 requested 与 effective', report.requested === 'auto' && typeof report.effective === 'string', JSON.stringify(report))

// ⑦ 链路失败文案：带底层原因，不再只有 code:transport
const adapterSource = (await import('node:fs')).readFileSync(path.join(PLUGIN, 'src/adapter.js'), 'utf8')
check('组合链失败文案会附带候选自己的错误句子', adapterSource.includes('failureDetail(held)') && adapterSource.includes('function failureDetail('))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
