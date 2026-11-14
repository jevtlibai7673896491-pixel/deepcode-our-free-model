package com.dsharnessmobile.shell

/** Process-local projection of the actual visible chat. Never creates or selects a session. */
internal object SpeechSessionFocus {
 var foreground=false
  set(value){field=value;OverlayService.instance?.let{svc->svc.main.post{svc.refreshBallKeyFocus();svc.speech.foregroundChanged()}}}
 @Volatile private var openId=""
 @Volatile private var openAt=0L
 fun requestOpen(id:String){openId=id;openAt=android.os.SystemClock.uptimeMillis()}
 fun pendingOpen():String=if(android.os.SystemClock.uptimeMillis()-openAt<15_000)openId else ""
 fun ackOpen(id:String){if(openId==id)openId=""}
 var id=""; private set
 var title=""; private set
 var enabled=false; private set
 fun update(id:String,title:String,enabled:Boolean){
  // 会话身份（id/title）与语音开关（enabled）解耦：关掉语音不该让悬浮窗「忘记」当前会话，
  // 否则发送/录音/看实时会误报「先开一个会话」（2026-11-14 用户回归实测）。teardown 仍推空 id。
  this.id=id;this.title=title;this.enabled=enabled
  OverlayService.instance?.followSpeechSession()
 }
}
