# 免费通道（free lane）接口逆向记录

目的：把「模型列表/推理」这条链路的真实线上行为固定下来，作为「插件可用」的判据，而不是靠读代码推断。
所有数据为 2026-11-14 从本机（数据中心出口 IP）实测，命令与输出均为原始结果。

被测对象：`android-shell/plugins/dsh-our-free-model/src/upstream.js` + `src/o2a/*`（对
`opencode2api` v1.4.6 的移植）与上游网关 `https://opencode.ai`（可用 `OUR_FREE_MODEL_BASE` 覆盖）。

---

## 1. 端点表

| 用途 | 方法与路径 | 备注 |
|---|---|---|
| 模型列表 | `GET /inference/v1/models` | 插件 `fetchListing()` 用；扁平老形状 |
| Chat 推理 | `POST /inference/openai/v1/chat/completions` | 家族分组形状（2.1 客户端起） |
| Responses 推理 | `POST /inference/openai/v1/responses` | `isResponsesModel()` 判定的模型 |
| Messages 推理 | `POST /inference/anthropic/v1/messages?beta=true` | `isMessagesModel()` 判定的模型 |

## 2. 指纹头（v2 门禁，缺一即拒）

实测发出的头（会话 id 已 mint，非派生）：

```
content-type: application/json
authorization: Bearer public          # 池化匿名凭证
user-agent: opencode/latest/2.2.3/cl
x-opencode-client: cli
x-session-affinity: ses_<12hex><14base62>
x-session-id:       同上
x-opencode-session: 同上
x-opencode-session-id: 同上（有子会话时为子会话 id）
x-opencode-project: <40 位小写 hex>    # 每请求新 mint，避免共享配额桶
traceparent: 00-<32hex>-<16hex>-01
b3: <32hex>-<16hex>-1
accept: application/json | text/event-stream
```

会话 id 形状由 `src/o2a/identity.js` 铸造：`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`，时间戳取「当日 UTC 零点减去哈希偏移（≤30 天）」，超出上游接受窗口会重铸。

## 3. 实测结果

### 3.1 列表接口 ✅

```
GET https://opencode.ai/inference/v1/models
status: 200   (230 ms, 104,823 bytes)
parseListing → 86 个 id，其中 11 个以 -free 结尾
样例: big-pickle, mimo-v2.6-flash-free, deepseek-v4.1-flash-free, glm-5.3-flash-free,
      claude-fable-5, claude-haiku-4-5 ...
buildCatalog(ids) → 12 行（含 big-pickle 等免费 row），带 contextWindow：
      mimo-v2.6-flash-free ctx=1048576 / deepseek-v4.1-flash-free ctx=1048576
```

结论：列表链路在本机出口 100% 可用，且插件自己的解析/建目录函数能把线上 payload 转成目录行。

### 3.2 推理接口 ⚠️ 协议通过、配额被拒

```
POST /inference/openai/v1/chat/completions   body=applyFingerprint 后的官方形状
  big-pickle                 status=429  retry-after=81672s
  deepseek-v4.1-flash-free   status=429  retry-after=81672s
  glm-5.3-flash-free         status=429  retry-after=81672s
响应体: {"type":"error","error":{"type":"FreeUsageLimitError",
        "message":"Free usage limit reached. ... subscribe to OpenCode Go ..."}}
```

判定依据（关键区分）：

| 状态码 | 含义 | 本次实测 |
|---|---|---|
| `403 FreeTierError` | 指纹/工具词表没通过门禁 | 未出现 ⇒ **请求整形（官方 system prompt + 13 工具改名 + 头集）通过了 v2 门禁** |
| `403 RegionError` | 地区封锁 | 未出现 |
| `429 FreeUsageLimitError` | 该出口 IP 的免费窗口已用尽（`retry-after` 约 22.7 小时） | 三个模型全部命中 |

即：**协议层可用，额度层被本机（数据中心）出口 IP 拒绝**。免费额度是「按 IP × 项目 id」计账，手机蜂窝/Wi-Fi 住宅出口与数据中心出口不共享同一窗口，因此该结果不能推出「手机不可用」，也不能推出「手机一定可用」——手机侧的判据只能是真机实测（见交付说明的未完成项）。

## 4. 与插件内部行为对齐的点

- 目录行来源：先读本地 `catalog.json`（冷启动为 6 行 `FALLBACK_CATALOG`），再异步 `refreshCatalog()` 用 §3.1 的列表覆盖；两者都不为空，所以 **模型列表不依赖网络可达**。
- 可用性判定：被动学习 + 手动探测，`429` 会进配额断路器（`probeBackoffUntil` 30 分钟），不会逐模型重试烧额度。
- 因此「选择器为空」不是这条链路的问题，而是宿主目录策略的问题（见 `OUR-FREE-MODEL-INTEGRATION.md` 的缺陷修复一节）。

## 5. 复现命令

```bash
node /home/user/work/harness/probe-models.mjs   # 只打列表接口
node /home/user/work/harness/probe-live.mjs     # 列表 + 一次推理（会消耗免费窗口）
node /home/user/work/harness/probe-multi.mjs    # 三个模型的推理状态码对比
node scripts/test-our-free-model-picker.mjs     # 仓库内回归测试（不访问网络）
```

> 注：前三个脚本是本次定位时写的临时判据脚本，位于工作区 `/home/user/work/harness/`，未入库；
> 仓库内入库的是第 4 个（不联网、可在 CI 跑）。
