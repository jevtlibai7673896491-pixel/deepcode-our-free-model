package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject

/**
 * 悬浮窗目标会话解析（纯函数，无 Android 依赖，可 JVM 单测）。
 *
 * 背景（2026-11-14 回归）：悬浮窗的 `activeSessionId` 曾经只有一个写入方 —— JS 插件
 * `dsh-speech-services/src/client/focus.mjs` 经 `bridge.speechSession(id,title,enabled)` 推来的
 * 进程内投影（`SpeechSessionFocus`）。只要该投影没到（插件作用域未 ready / 文档不可见 /
 * 服务端会话快照处于重连态 / 插件关闭），`activeSessionId` 就永远是空串，于是「发送」
 * 「录音」「看 AI 实时」三条路径齐声喊「先在 DeepCode 打开一个会话」——而用户其实早已开了会话。
 *
 * 修复口径：投影只是**快取**，权威真源是引擎的 `session/list` RPC。本类负责把引擎的
 * `items` 归一化成候选列表并按确定性规则选一个目标会话，供 OverlayService 兜底解析。
 *
 * 选择规则（保守、可解释、可测）：
 *  1. 现有目标仍在列表里 → 保持不动（不因刷新抖动换会话）；
 *  2. 否则优先运行中的会话（用户正在看的那个大概率在跑）；
 *  3. 否则取列表第一项（DSH 会话列表按最近活动排序）。
 */
internal object OverlaySessionTarget {

  /** 一个可选目标会话。`title` 已按 UI 口径裁剪（空标题退回 id 前 12 位）。 */
  data class Item(
    val id: String,
    val title: String,
    val running: Boolean,
    val updatedAt: Long,
  )

  /** 无会话时的用户提示（与「未投影」区分开，绝不冒充「没有会话」）。 */
  const val NO_SESSION_MESSAGE = "还没有会话：在 DeepCode 里新建一个会话"

  /** 引擎/插件都读不到时的提示。 */
  const val LIST_FAILED_MESSAGE = "读取会话列表失败，请确认 DeepCode 已打开"

  /** `projections.values.title` → 标题；缺失或 "null" 时退回 id 前 12 位。 */
  fun titleOf(item: JSONObject): String {
    val raw = item.optJSONObject("projections")
      ?.optJSONObject("values")
      ?.optString("title")
      ?.trim()
      .orEmpty()
    if (raw.isNotEmpty() && raw != "null") return raw
    return item.optString("sessionId").take(12)
  }

  /** 时间戳口径：优先 updatedAt，其次 lastActivityAt / createdAt，缺失记 0。 */
  private fun updatedAtOf(item: JSONObject): Long {
    for (key in arrayOf("updatedAt", "lastActivityAt", "createdAt")) {
      val v = item.opt(key)
      if (v is Number) return v.toLong()
      if (v is String) v.toLongOrNull()?.let { return it }
    }
    return 0L
  }

  /** 一条 item → Item（空 id 视为无效，返回 null）。 */
  fun itemOf(item: JSONObject): Item? {
    val id = item.optString("sessionId").trim()
    if (id.isEmpty()) return null
    return Item(id = id, title = titleOf(item), running = item.optBoolean("running"), updatedAt = updatedAtOf(item))
  }

  /** 引擎 `session/list` 的 `value` → 候选列表（容忍 JSONObject/String/JSONArray 多形态）。 */
  fun itemsFrom(value: Any?): List<Item> {
    val array = when (value) {
      is JSONArray -> value
      is JSONObject -> value.optJSONArray("items") ?: return emptyList()
      is String -> {
        val text = value.trim()
        if (text.isEmpty()) return emptyList()
        val parsed = runCatching { JSONObject(text) }.getOrNull()
        if (parsed != null) return itemsFrom(parsed)
        runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
      }
      else -> return emptyList()
    }
    val out = ArrayList<Item>(array.length())
    for (i in 0 until array.length()) {
      val raw = array.optJSONObject(i) ?: continue
      itemOf(raw)?.let { out.add(it) }
    }
    return out
  }

  /** 选目标会话：见类注释三条规则；空列表返回 null。 */
  fun pick(items: List<Item>, keep: String = ""): Item? {
    if (items.isEmpty()) return null
    if (keep.isNotEmpty()) items.firstOrNull { it.id == keep }?.let { return it }
    items.firstOrNull { it.running }?.let { return it }
    return items.first()
  }

  /** 会话行/提示用的短标签：有标题用标题，否则用 id 前 8 位。 */
  fun label(id: String, title: String): String {
    if (title.isNotBlank() && title != "null") return title
    return id.take(8)
  }
}
