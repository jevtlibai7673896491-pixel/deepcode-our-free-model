/** Only a native, user-clicked reply can enqueue this process-local request. */
export function openPendingConversation(ctx,bridge){
 const id=bridge.speechOpenRequest?.();if(!id)return false
 if(!ctx.sessions.list.getSnapshot().byId?.[id])return false
 const entry=ctx.slots.entries('conversation.session')[0];if(!entry)return false
 const binding=ctx.uiSession.adapter.resolve(id)
 const store=ctx.slots.resolveStore(entry.store,binding)
 ctx.sessions.open(id)
 ctx.uiConversation.binding(id).activate('chat')
 store.actions.setView('chat')
 bridge.speechOpenAck(id)
 return true
}
/**
 * Project the active workbench lane, otherwise the ordinary current chat.
 *
 * 2026-11-14 回归：「先开一个会话」误报的真因是这里——壳侧只认这条投影，而 `snapshot.current`
 * 在某些客户端版本/重连窗口里会短暂缺失（页面自己用 `<html data-dsh-session-id>` 发布同一份真源，
 * 见 dsh-client-ui-responsive/src/client/mobile/session-marker.ts）。因此再补一层 DOM 标记兜底：
 * 只有当快照与标记都拿不到会话时，才认定为「没有会话」。
 */
export function focusedSession(snapshot, laneId, doc) {
 const marker = doc?.documentElement?.getAttribute?.('data-dsh-session-id') || ''
 const id = laneId && snapshot?.byId?.[laneId] ? laneId : (snapshot?.current || marker)
 const row = id && snapshot?.byId?.[id]
 return row ? {id, title: row.displayTitle || '当前会话'} : {id:'',title:''}
}
export function followCurrentSession(ctx,scope,env=globalThis){
 const doc=env.document,bridge=env.window?.androidBridge
 if(!doc || typeof bridge?.speechSession!=='function')return ()=>{}
 let last='',queued=false,closed=false
 const sync=()=>{
  queued=false;if(closed || doc.visibilityState==='hidden')return
  const config=scope.getSnapshot();if(config.status!=='ready')return
  if(config.value?.enabled===true)openPendingConversation(ctx,bridge)
  const lane=[...doc.querySelectorAll('[data-deck-lane][data-active="true"]')].find(e=>e.getClientRects().length)
  const snapshot=ctx.sessions.list.getSnapshot()
  const enabled=config.value?.enabled===true
  // A reconnect projection can temporarily mask current; it is not a user selection.
  // 但只有「拿不到 id」时才放弃本轮上报：拿到 id 就照常同步，避免整体停摆。
  const {id,title}=focusedSession(snapshot,lane?.getAttribute('data-deck-lane'),doc)
  if(!id && snapshot.phase && snapshot.phase!=='ready')return
  const key=JSON.stringify([id,title,enabled])
  if(last===key)return
  bridge.speechSession(id,title,enabled);last=key
 }
 const schedule=()=>{if(!queued&&!closed){queued=true;env.queueMicrotask(sync)}}
 const observer=new env.MutationObserver(schedule)
 observer.observe(doc.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-active','data-deck-lane','hidden','style','class']})
 const off=ctx.sessions.list.subscribe(schedule),offConfig=scope.subscribe(schedule)
 doc.addEventListener('visibilitychange',schedule);env.window.addEventListener('focus',schedule)
 sync()
 return ()=>{closed=true;off();offConfig();observer.disconnect();doc.removeEventListener('visibilitychange',schedule);env.window.removeEventListener('focus',schedule);bridge.speechSession('','',false)}
}
