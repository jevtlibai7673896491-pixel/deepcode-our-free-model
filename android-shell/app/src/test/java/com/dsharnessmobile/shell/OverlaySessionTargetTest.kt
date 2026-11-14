package com.dsharnessmobile.shell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 悬浮窗「先开一个会话」误报回归（2026-11-14）。
 *
 * 用户口述：「他一直提醒我先开一个会话，但是我已经开了」。根因不是提示文案，而是目标会话
 * 的唯一来源是 JS 插件投影：投影没到 ⇒ `activeSessionId` 恒空 ⇒ 发送/录音/看实时三条路径
 * 全被硬门槛挡住。修复 = 投影退化为快取，引擎 `session/list` 成为兜底权威。
 *
 * 本测试两层：
 *  A. 纯函数层：`OverlaySessionTarget` 的解析与选择规则（可跑、可证伪）；
 *  B. 调用点契约：壳侧源码里三条路径都必须走 `ensureSession`，硬门槛不得复活。
 */
class OverlaySessionTargetTest {

  // ── A. 解析 ────────────────────────────────────────────────────────

  private fun session(id: String, title: String?, running: Boolean = false, updatedAt: Long = 0): JSONObject {
    val o = JSONObject().put("sessionId", id)
    if (running) o.put("running", true)
    if (updatedAt != 0L) o.put("updatedAt", updatedAt)
    if (title != null) o.put("projections", JSONObject().put("values", JSONObject().put("title", title)))
    return o
  }

  private fun value(vararg items: JSONObject) =
    JSONObject().put("items", JSONArray(items.toList()))

  @Test
  fun readsSessionIdTitleAndRunning() {
    val items = OverlaySessionTarget.itemsFrom(value(session("s-1", "修复悬浮窗"), session("s-2", "另一个会话", running = true)))
    assertEquals(2, items.size)
    assertEquals("s-1", items[0].id)
    assertEquals("修复悬浮窗", items[0].title)
    assertFalse(items[0].running)
    assertTrue(items[1].running)
  }

  @Test
  fun titleFallsBackToIdPrefixWhenProjectionMissing() {
    val items = OverlaySessionTarget.itemsFrom(value(session("3f9c8a7b1d2e4f", null)))
    assertEquals("3f9c8a7b1d2e", items[0].title) // id 前 12 位
  }

  @Test
  fun titleProjectionOfLiteralNullIsIgnored() {
    val items = OverlaySessionTarget.itemsFrom(value(session("abcdef123456789", "null")))
    assertEquals("abcdef123456", items[0].title)
  }

  @Test
  fun itemsWithoutSessionIdAreDropped() {
    val bad = JSONObject().put("projections", JSONObject().put("values", JSONObject().put("title", "无 id")))
    val items = OverlaySessionTarget.itemsFrom(value(bad, session("s-9", "ok")))
    assertEquals(1, items.size)
    assertEquals("s-9", items[0].id)
  }

  @Test
  fun toleratesObjectStringArrayAndGarbage() {
    val obj = value(session("a1", "A"))
    assertEquals(1, OverlaySessionTarget.itemsFrom(obj).size)
    // 网关把 value 序列化成字符串的形态（历史有过）
    assertEquals(1, OverlaySessionTarget.itemsFrom(obj.toString()).size)
    // 直接是数组
    assertEquals(1, OverlaySessionTarget.itemsFrom(obj.getJSONArray("items")).size)
    // 空/异常输入不抛、返回空
    assertEquals(0, OverlaySessionTarget.itemsFrom(null).size)
    assertEquals(0, OverlaySessionTarget.itemsFrom("").size)
    assertEquals(0, OverlaySessionTarget.itemsFrom("{损坏").size)
    assertEquals(0, OverlaySessionTarget.itemsFrom(JSONObject().put("items", JSONArray())).size)
  }

  @Test
  fun timestampReadsUpdatedAtThenActivityThenCreated() {
    assertEquals(111L, OverlaySessionTarget.itemsFrom(value(session("a", "A", updatedAt = 111)))[0].updatedAt)
    val raw = JSONObject().put("sessionId", "b").put("lastActivityAt", 222)
    assertEquals(222L, OverlaySessionTarget.itemsFrom(value(raw))[0].updatedAt)
    val raw2 = JSONObject().put("sessionId", "c").put("createdAt", "333")
    assertEquals(333L, OverlaySessionTarget.itemsFrom(value(raw2))[0].updatedAt)
    assertEquals(0L, OverlaySessionTarget.itemsFrom(value(session("d", "D")))[0].updatedAt)
  }

  // ── A. 选择 ────────────────────────────────────────────────────────

  @Test
  fun keepWinsWhenStillListed() {
    val items = OverlaySessionTarget.itemsFrom(value(session("s-1", "一"), session("s-2", "二", running = true)))
    assertEquals("s-1", OverlaySessionTarget.pick(items, keep = "s-1")?.id)
  }

  @Test
  fun runningSessionWinsOverFirstWhenNothingKept() {
    val items = OverlaySessionTarget.itemsFrom(value(session("s-1", "一"), session("s-2", "二", running = true), session("s-3", "三")))
    assertEquals("s-2", OverlaySessionTarget.pick(items)?.id)
  }

  @Test
  fun firstSessionWinsWhenNoneRunning() {
    val items = OverlaySessionTarget.itemsFrom(value(session("s-1", "一"), session("s-2", "二")))
    assertEquals("s-1", OverlaySessionTarget.pick(items)?.id)
  }

  @Test
  fun emptyListHasNoTarget() {
    assertNull(OverlaySessionTarget.pick(emptyList()))
    assertNull(OverlaySessionTarget.pick(OverlaySessionTarget.itemsFrom(null)))
  }

  @Test
  fun labelUsesTitleThenIdPrefix() {
    assertEquals("修复悬浮窗", OverlaySessionTarget.label("s-1", "修复悬浮窗"))
    assertEquals("s-1", OverlaySessionTarget.label("s-1", "   "))
    assertEquals("s-1", OverlaySessionTarget.label("s-1", "null"))
  }

  @Test
  fun noSessionMessageIsNotTheOldMisleadingOne() {
    // 旧硬门槛文案：会话其实存在时也这么喊，是用户投诉的原句。新提示只在真的没有会话时出现。
    assertFalse(OverlaySessionTarget.NO_SESSION_MESSAGE.contains("先在 DeepCode 打开一个会话"))
    assertNotNull(OverlaySessionTarget.LIST_FAILED_MESSAGE)
    assertTrue(OverlaySessionTarget.NO_SESSION_MESSAGE.contains("新建"))
  }

  // ── B. 调用点契约 ─────────────────────────────────────────────────

  private fun source(name: String): String {
    val candidates = listOf(
      File("src/main/java/com/dsharnessmobile/shell", name),
      File("app/src/main/java/com/dsharnessmobile/shell", name),
    )
    val f = candidates.firstOrNull { it.isFile }
      ?: throw AssertionError("找不到壳侧源码 $name（工作目录 = ${File(".").absolutePath}）")
    return f.readText()
  }

  private fun codeOnly(src: String): String = src.lineSequence()
    .filterNot {
      val t = it.trimStart()
      t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
    }
    .joinToString("\n")

  private fun memberBody(src: String, signature: String): String {
    val idx = src.indexOf(signature)
    if (idx < 0) throw AssertionError("找不到成员签名 $signature")
    val rest = src.substring(idx + signature.length)
    val cut = listOf("\n  override fun ", "\n  private fun ", "\n  internal fun ", "\n  fun ")
      .map { rest.indexOf(it) }
      .filter { it >= 0 }
      .minOrNull() ?: rest.length
    return rest.substring(0, cut)
  }

  @Test
  fun sendPathResolvesSessionThroughEngineInsteadOfHardGate() {
    val body = memberBody(codeOnly(source("OverlayService.kt")), "internal fun requestSend()")
    assertTrue("发送必须先解析会话", body.contains("ensureSession"))
    assertFalse("不得再用空 activeSessionId 当硬门槛", body.contains("flashStatus(\"先在 DeepCode 打开一个会话\")"))
  }

  @Test
  fun stopPathResolvesSessionThroughEngine() {
    val body = memberBody(codeOnly(source("OverlayService.kt")), "internal fun requestStop()")
    assertTrue(body.contains("ensureSession"))
  }

  @Test
  fun speechPathsResolveSessionThroughEngine() {
    val src = codeOnly(source("SpeechOverlay.kt"))
    val record = memberBody(src, "fun activateAndToggle()")
    assertTrue("录音必须走兜底解析", record.contains("ensureSession"))
    assertTrue("看 AI 实时必须有独立入口", src.contains("fun startCaptions("))
    val captions = memberBody(src, "fun startCaptions(")
    assertTrue("实时视图不得要求插件投影 enabled", !captions.contains("SpeechSessionFocus.enabled"))
  }

  @Test
  fun projectionBlankStillFallsBackToEngine() {
    val body = memberBody(codeOnly(source("OverlayService.kt")), "internal fun followSpeechSession()")
    assertTrue("投影为空时必须触发引擎兜底", body.contains("ensureSession"))
  }

  @Test
  fun panelExposesLiveAiButtonAndSessionRow() {
    val src = codeOnly(source("OverlayPanel.kt"))
    assertTrue(src.contains("svc.toggleCaptions()"))
    assertTrue(src.contains("refreshSessionRow"))
    val button = codeOnly(source("CompanionButton.kt"))
    assertTrue(button.contains("\"captions\"->"))
  }

  @Test
  fun speechSessionFocusKeepsIdWhenSpeechIsOff() {
    // 投影里 enabled（语音开关）与 id（会话身份）是两件事：关语音不该让悬浮窗「忘记会话」。
    val src = codeOnly(source("SpeechSessionFocus.kt"))
    val apply = memberBody(src, "fun update(")
    assertFalse("不得因 enabled=false 清空会话 id", apply.contains("if(enabled)id else"))
  }
}
