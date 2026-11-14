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
