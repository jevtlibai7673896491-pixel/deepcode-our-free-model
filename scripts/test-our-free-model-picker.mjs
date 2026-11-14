#!/usr/bin/env node
/**
 * 回归测试：免费模型的模型选择器可见性（Android 宿主）。
 *
 * 背景（实测定位，2026-11-14）：插件挂载、设置面板可见，但模型选择器为空。
 * 根因在宿主侧的模型目录策略 `androidModelProviderConfigured`
 * （`app/src/main/assets/patched/model-catalog-host-015.js`）：
 * 它按「可配置提供商目录项声明的 settings 命名空间」判断一个 provider 是否
 * configured；插件把设置存在自己的 JSON store、从不注册命名空间，于是
 * `namespaces.find(...)` 落空 → 该 provider 被判 unconfigured → 整组连同
 * 所有模型被静默丢弃（`groups=0`、`failures=0`）。
 *
 * 本测试做两件事，全部跑真实代码，不 mock 语义：
 *  1. 从 `plugins/dsh-our-free-model/index.js` 里取出**目录项决策代码块**执行，
 *     断言「命名空间未注册 → 不声明」「已注册 → 声明」。
 *  2. 用宿主自己的 `buildModelCatalog` + 插件自己的 adapter，断言修复后
 *     目录里出现 `our-free-model` 组且模型数 ≥ 1。
 *
 * 运行：node scripts/test-our-free-model-picker.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(ROOT, 'android-shell/plugins/dsh-our-free-model')
const PATCHED = path.join(ROOT, 'android-shell/app/src/main/assets/patched/model-catalog-host-015.js')

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  —  ${detail}`}`)
  if (!ok) failed++
}

// ── 1. 插件源码里的目录项决策块 ───────────────────────────────────────────────
const source = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')
const from = source.indexOf('const directoryNs =')
const to = source.indexOf('  ctx.llm.registerModelDiscovery?.', from)
if (from < 0 || to < 0) {
  console.error('FAIL  未能从 index.js 取出目录项决策块（源码结构变了？）')
  process.exit(1)
}
const block = source.slice(from, to)
const decisionOf = (namespaces) => {
  const calls = []
  const logger = { debug: () => {} }
  const ctx = {
    fiber: { entry: { options: { id: 'our-free-model' } } },
    settings: { describe: () => namespaces },
    llm: { registerConfigurableProviders: (entries) => calls.push(entries) },
  }
  const ROUTE_MAIN = 'our-free-model'
  const ROUTE_LABELS = { 'our-free-model': 'Our Free Model' }
  const name = 'our-free-model'
  new Function('ctx', 'logger', 'ROUTE_MAIN', 'ROUTE_LABELS', 'name', `${block}`)(ctx, logger, ROUTE_MAIN, ROUTE_LABELS, name)
  return calls
}

const noNamespace = decisionOf([{ ns: 'llm-pi-ai', value: {} }, { ns: 'droid-agent', value: {} }])
check('命名空间未注册时不声明目录项（避免被宿主判 unconfigured）', noNamespace.length === 0, `registerConfigurableProviders 调用 ${noNamespace.length} 次`)

const withNamespace = decisionOf([{ ns: 'our-free-model', value: {} }])
check('命名空间已注册时仍声明目录项（保留宿主目录面）', withNamespace.length === 1 && withNamespace[0][0].provider === 'our-free-model', JSON.stringify(withNamespace[0] ?? null))

const noSettingsService = decisionOf(undefined)
check('宿主无 settings 服务时降级为不声明', Array.isArray(noSettingsService) && noSettingsService.length === 0)

// ── 2. 宿主自己的 buildModelCatalog + 插件真实 adapter ────────────────────────
const { createModelRuntime } = await import(path.join(PLUGIN, 'src/core/runtime.js'))
const { ROUTE_MAIN, ROUTE_REGION } = await import(path.join(PLUGIN, 'src/adapter.js'))
const store = (init) => { let value = init; return { get: () => value, update: (patch) => { value = { ...value, ...patch } }, edit: (fn) => { value = fn(value) }, flush() {}, dispose() {}, watch() {} } }
const runtime = createModelRuntime({
  settings: store({}), stats: store({ days: {} }), availability: store({ results: {}, egress: null }),
  catalogStore: store({ version: 1, at: 0, entries: undefined }),
  logger: { info() {}, warn() {}, debug() {} },
})
const adapter = runtime.adapter

const patched = fs.readFileSync(PATCHED, 'utf8')
const start = patched.indexOf('async function androidModelProviderConfigured')
const end = patched.indexOf('//#endregion', start)
if (start < 0 || end < 0) {
  console.error('FAIL  未能从宿主 patched 文件取出 catalog 策略')
  process.exit(1)
}
const { buildModelCatalog } = new Function(`${patched.slice(start, end)}; return { buildModelCatalog };`)()

const ctxFor = (declareDirectory) => ({
  llm: {
    listProviders: () => [{ id: ROUTE_MAIN, name: 'Our Free Model' }, { id: ROUTE_REGION, name: 'Our Free Model · region-limited' }],
    listModels: (provider) => adapter.listModels(provider),
    resolveModelInfo: (provider, model) => adapter.resolveModel(provider, model),
    listConfigurableProviders: () => declareDirectory
      ? [{ provider: ROUTE_MAIN, displayName: 'Our Free Model', settingsNs: 'our-free-model', settingsPath: [] }]
      : [],
  },
  settings: { describe: () => [{ ns: 'llm-pi-ai', value: {} }] },
  get: () => undefined,
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
})

const broken = await buildModelCatalog(ctxFor(true), { provider: 'deepseek', model: 'deepseek-chat' })
check('复现原缺陷：声明了未注册命名空间 → 目录里 0 组（模型全被丢弃）', broken.groups.length === 0 && broken.failures.length === 0, `groups=${broken.groups.length} failures=${broken.failures.length}`)

const fixed = await buildModelCatalog(ctxFor(false), { provider: 'deepseek', model: 'deepseek-chat' })
const group = fixed.groups.find((g) => g.id === ROUTE_MAIN)
check('修复后：目录出现 our-free-model 组', group !== undefined)
check('修复后：该组模型数 ≥ 1', (group?.models.length ?? 0) >= 1, `${group?.models.length ?? 0} 个，前 3：${(group?.models ?? []).slice(0, 3).map((m) => m.id).join(', ')}`)
check('修复后：无 provider 失败项', fixed.failures.length === 0, JSON.stringify(fixed.failures))

// ── 3. 选中该模型后宿主拿到的调用面 ──────────────────────────────────────────
const callable = await adapter.prepareCall(ROUTE_MAIN, 'deepseek-v4.1-flash-free')
check('prepareCall 返回可流式调用的句柄', typeof callable?.stream === 'function', `model.contextWindow=${callable?.model?.context?.contextWindow ?? '?'}`)
check('resolveModel 返回上下文窗口与最大输出', Number.isFinite(callable?.model?.context?.contextWindow) && Number.isFinite(callable?.model?.defaultMaxTokens), `ctx=${callable?.model?.context?.contextWindow} maxTokens=${callable?.model?.defaultMaxTokens}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
