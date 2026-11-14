# Our Free Model 内置改动清单（整壳接入，选项 1）

源：`Ebony-Vinyl/dsh-our-free-model` v2.8.3（794 文件）→ 目标：`android-shell/plugins/dsh-our-free-model/`
原则：插件保持 Node 形态跑在内嵌 Termux DSH 里；只搬 UI 与本地转发端口；不重写 Kotlin 业务。
排除：`src/engine-parts/*.part`（28M）、`vendor/magpie/bin/*.exe`（70M，win32-x64）、`packages/**`（standalone/desktop 独立产品）、源 `docs/scripts/worker/catalog/feed`。

## 类 A：adapter / src（Host+Client 入口与业务核心）

| 源文件 | 目标文件 | 改什么 |
|---|---|---|
| `index.js` | `android-shell/plugins/dsh-our-free-model/index.js` | 原样拷贝；`inject=['llm']`、`registerAdapter` 不改 |
| `client.js` | `.../client.js` | 原样拷贝；`inject=['slots','locale']`、settings.section 不改 |
| `adapter/kernel.js, dsh-llm.d.ts` | `.../adapter/` | 原样拷贝；唯一 `@deepseek-ai/*` 缝，不改 |
| `src/*.js`（56 文件）+ `src/core/**, src/providers/**, src/route/**, src/o2a/**, src/token-saver/**` | `.../src/` | 全量拷贝，**排除** `src/engine-parts/**`；`open-external.js` 不改（Android 上 `xdg-open` 缺失时已返回 false，登录走复制 URL） |

自检 A：`node --check index.js/client.js/src/adapter.js` + `node -e import('./index.js')` 输出 `name=our-free-model inject=[llm] version=2.8.3`。

## 类 B：locale / vendor（本地化与渠道包）

| 源文件 | 目标文件 | 改什么 |
|---|---|---|
| `locale/zh.json, en.json` | `.../locale/` | 原样拷贝 |
| `vendor/channel-pack/pack.js`（2.8M）+ `qoder-auth-wasm.wasm`（292K）+ `NOTICE.md/LICENSE` | `.../vendor/channel-pack/` | 原样拷贝（10 渠道预构建包，WASM 平台无关） |
| `vendor/magpie/engine.json, LICENSE, NOTICE.md` | `.../vendor/magpie/` | 只拷元数据，**不拷** `bin/magpie-win32-x64.exe`（70M）；magpie 车道 `available=false` 降级，`magpieEnabled` 默认关时不启动 |
| `icon.svg, LICENSE` | `.../` | 原样拷贝 |

自检 B：`node --check vendor/channel-pack/pack.js`；WASM 魔数 `00 61 73 6d`；体积清单见下。

## 类 C：注册与装配（让插件真挂载）

| 源文件 | 目标文件 | 改什么 |
|---|---|---|
| `cordis.patch.yml` | `.../cordis.patch.yml` | 原样拷贝（`insert: our-free-model / dsh-our-free-model`） |
| `package.json` | `.../package.json` | 保留 name/version/main/peerDeps；`files` 改为实际载荷（去掉 `src/engine-parts` 与 magpie exe，补 `src/core,src/o2a,src/token-saver` 等实际子目录） |
| —（新建） | `scripts/inject-our-free-model.py` | 快照注入脚本：把插件载荷写入 `snapshot.tar.xz` 的 `home/.dsh/profiles/{web,headless}/node_modules/dsh-our-free-model/`，并向两 profile 的 `cordis.patch.yml` 追加 insert；tar 流处理不物化 symlink |
| —（新建） | `.github/workflows/build-apk.yml` | 四步：装 JDK17/SDK+Node22 → 组装（下载公开 snapshot 校验 SHA + 注入）→ `assembleDebug` → 上传 artifact |
| —（新建） | 本文件 | 改动清单本身 |

自检 C：本地下载 snapshot（157M，SHA `ed24dfcc...`）→ 跑注入脚本 → `tar -tJf` 含插件文件且两 profile patch 含 insert → Node 再次 import 目标目录 `index.js` 成功。

## 体积（必须塞的才报）

- 类 A+B 实际载荷：约 5.5M（index 134K + client 616K + src 约 2M + pack.js 2.8M + wasm 292K + 其余 <200K）
- 排除：engine-parts 28M + magpie exe 70M = 98M 未塞

## 附录：pack.js 不入库（安全）

- 来源：`Ebony-Vinyl/dsh-our-free-model` 提交 `edfdaf2cb64bb39c7c682b90c96ef9e3fef3be15`（v2.8.3 之后 HEAD）。
- 原因：`vendor/channel-pack/pack.js` 第 63124 行含第三方 `GEMINI_DEFAULT_CLIENT_SECRET` 常量，GitHub push protection 判定为 secret 并拒绝推送。
- 处理：不入库（`.gitignore` 已列），构建链（`.github/workflows/build-apk.yml` 第 2 步）从上游该固定提交 raw 取回并校验
  `sha256=df0047685e14d1e4f75aa16f07e6f26258d991c923ff40f199dbb453c0096fd6`。
- 影响：`index.js:1131` 对该文件是 `void import(...).catch(...)` 动态加载，缺失时仅 `channelPack.state='failed'`，
  `llm` 适配器与模型列表不受影响；构建时补齐后行为与上游一致。

- 同类不入库文件（第 2 个）：`src/subscriptions.js`（第 34 行 `GOCSPX-…` 常量），
  sha256=`ec1e01728f03bfd446f77dedf5615f50405b1c0679bf646c3a75cdf8bd0a86e2`，同样由第 2 步取回校验。

## 缺陷修复：模型选择器里没有免费模型（2026-11-14）

### 现象
插件已挂载、设置面板可见，但模型选择器里没有任何 `our-free-model` 的模型。

### 定位（全部为可复现证据，不靠推断）
1. **插件侧健康**：离线实例化插件运行时，`state().catalog` = 6 行（`FALLBACK_CATALOG`），
   `membership['our-free-model']` = 6，`adapter.listModels('our-free-model')` 返回 6 条。
   说明模型数据本来就有，不是抓取失败。
2. **宿主侧丢弃**：Android 的模型目录策略 `androidModelProviderConfigured`
   （`app/src/main/assets/patched/model-catalog-host-015.js`，在 `buildModelCatalog` 里对每个 provider 调用）：
   ```js
   const entry = declarations.find(item => item.provider === provider)
   if (!entry) return true
   const namespace = namespaces.find(item => item.ns === entry.settingsNs)
   let profile = namespace?.value
   for (const key of entry.settingsPath) profile = profile?.[key]
   if (!profile || typeof profile !== 'object') return false
   ```
   插件在 `index.js` 里声明了目录项 `settingsNs: 'our-free-model'`（`settingsPath: []`），
   但它把设置存在自己的 JSON store，**从不向宿主 `ctx.settings` 注册命名空间**；
   `SettingsService.describe()` 只返回注册过的命名空间 ⇒ `namespace` 为 `undefined` ⇒
   该 provider 被判 `unconfigured` ⇒ 整组连模型一起被过滤，且**不记 failures**（静默消失）。
3. **复算**：把上述函数与 `buildModelCatalog` 原文取出执行，配合插件真实 adapter：
   修复前 `groups=0 / failures=0`；不声明目录项时 `groups=1`（6 个模型）。

### 修复
`android-shell/plugins/dsh-our-free-model/index.js`：目录项改为**条件声明** ——
只有当宿主 `ctx.settings.describe()` 里确实存在该命名空间且其值是对象时才调用
`registerConfigurableProviders`；否则跳过（日志 debug 一行）。路由本身始终通过
`ctx.llm.registerAdapter` 注册，因此在任何宿主上都留在模型目录里。

### 回归测试
`scripts/test-our-free-model-picker.mjs`（9 条断言，不联网）：
- 命名空间未注册 → 不声明；已注册 → 仍声明；无 settings 服务 → 降级不声明；
- 宿主 `buildModelCatalog` + 插件真实 adapter：复现原缺陷 `groups=0`，修复后 `groups=1`、模型 6 条、无 failures；
- `prepareCall` 返回可流式句柄，`resolveModel` 给出 `contextWindow=1048576 / defaultMaxTokens=32768`。

## 缺陷修复 2：无 Bun 时推理直接失败 + 组合链只剩 code:transport（2026-11-14）

### 现象
1. 推理报：`OpenCode 免费车道推理需要本机 Bun：请安装 Bun… (OUR_FREE_MODEL_FREE_TRANSPORT=node restores the legacy transport)`。
2. 组合链报：`the chain "推荐免费组" exhausted every candidate: deepseek-v4.1-flash-free (unavailable/transient · cooldown 30s · via code:transport); …`

### 根因
`src/egress.js` 的 `egressFetch()` 对官方免费车道的 **POST 推理**是硬性要求 Bun：
`findBunExecutable()` 为空时直接抛 `laneConfig` 错误 → `src/http.js` 把它包成 `CODE.transport` →
`src/route/classify.js` 归类 `unavailable/transient`（30s 冷却）→ 组合链逐个候选阵亡 →
`src/adapter.js` 的 `describeVerdict()` 只打印类别与 `via code:transport`，把「缺个可选二进制」
说成了「上游传输故障」。Android/Termux 里没有 Bun，于是免费车道在任何设备上都等于关闭。

### 修复（3 处）
1. `src/egress.js`：`auto`（默认）在找不到 Bun 时**自动降级到 Node 传输**（与 `=node` 同一条路径：
   有代理走 `laneProxiedFetch`，无代理走本进程 `fetch`），每进程只提示一次；新增
   `freeLaneTransportReport()` 暴露 `requested / effective / bun` 三个字段。
   显式 `OUR_FREE_MODEL_FREE_TRANSPORT=bun` 仍然要求 Bun 并抛原本那句可执行文案（不是静默改变语义）。
2. `index.js`：启动日志从「无法推理」改为「自动使用 Node 传输（可用）」；`/summary` 增加
   `freeLane.transportEffective` 与 `bunRequired: false`，设置页不再把可选依赖渲染成阻断项。
3. `src/adapter.js`：组合链的每个候选失败项现在附带该候选自己的错误句子（`failureDetail()`，
   截断 180 字），`exhausted every candidate` 不再只有 `via code:transport`。

### 证据
- 线上：`egressFetch()` 对 `POST https://opencode.ai/inference/openai/v1/chat/completions`
  在无 Bun 的机器上返回网关自己的 `429 FreeUsageLimitError`（294 ms），即请求已走完传输、
  通过客户端门禁并计入该 IP 的额度窗口 —— 不再是 lane-config 错误。
- 离线：`scripts/test-our-free-model-transport.mjs` 10 条断言全 PASS（auto 降级生效、
  只提示一次、显式 bun 仍抛 laneConfig、显式 node 生效、非法取值报错、报告字段、链路文案）。
  已接入 CI 第 2 步。
