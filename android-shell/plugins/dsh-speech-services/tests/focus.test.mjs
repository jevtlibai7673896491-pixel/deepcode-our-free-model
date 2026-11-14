import test from 'node:test'
import assert from 'node:assert/strict'
import {focusedSession,followCurrentSession,openPendingConversation} from '../src/client/focus.mjs'
const snapshot={current:'left',byId:{left:{displayTitle:'左边'},right:{displayTitle:'右边'}}}
test('active workbench lane overrides main chat; removed lanes cannot receive speech',()=>{
 assert.deepEqual(focusedSession(snapshot,'right'),{id:'right',title:'右边'})
 assert.deepEqual(focusedSession(snapshot,'deleted'),{id:'left',title:'左边'})
 assert.deepEqual(focusedSession({current:'deleted',byId:{}},null),{id:'',title:''})
})
test('follows actual session changes, ignores hidden WebView, disposes and disables cleanly',()=>{
 let state=snapshot,config={status:'ready',value:{enabled:true}},lane='',visible=true,queued=[]
 let subscription,settingsSubscription,mutation;const calls=[],listeners=new Map()
 const doc={visibilityState:'visible',documentElement:{},querySelectorAll(){return lane?[{getClientRects:()=>visible?[{}]:[],getAttribute:()=>lane}]:[]},addEventListener(k,v){listeners.set(k,v)},removeEventListener(k){listeners.delete(k)}}
 const env={document:doc,window:{androidBridge:{speechSession(...a){calls.push(a)}},addEventListener(){},removeEventListener(){}},queueMicrotask(fn){queued.push(fn)},MutationObserver:class{constructor(fn){mutation=fn}observe(){}disconnect(){}}}
 const clean=followCurrentSession({sessions:{list:{getSnapshot:()=>state,subscribe(fn){subscription=fn;return()=>{subscription=null}}}}},{getSnapshot:()=>config,subscribe(fn){settingsSubscription=fn;return()=>{settingsSubscription=null}}},env)
 const flush=()=>{const q=queued;queued=[];q.forEach(fn=>fn())}
 assert.deepEqual(calls,[['left','左边',true]])
 mutation();mutation();flush();assert.equal(calls.length,1)
 state={phase:'pending',current:undefined,byId:{}};subscription();flush();assert.equal(calls.length,1)
 state={...snapshot,phase:'ready'};subscription();flush();assert.equal(calls.length,1)
 lane='right';mutation();flush();assert.deepEqual(calls.at(-1),['right','右边',true])
 doc.visibilityState='hidden';lane='';subscription();flush();assert.equal(calls.length,2)
 doc.visibilityState='visible';listeners.get('visibilitychange')();flush();assert.deepEqual(calls.at(-1),['left','左边',true])
 lane='right';visible=false;mutation();flush();assert.equal(calls.length,3)
 config={status:'ready',value:{enabled:false}};settingsSubscription();flush();assert.deepEqual(calls.at(-1),['left','左边',false])
 mutation();clean();flush();assert.deepEqual(calls.at(-1),['','',false]);assert.equal(subscription,null);assert.equal(settingsSubscription,null)
})

test('native reply click opens the exact session in full chat without changing deck assignments',()=>{
 let request='right';const calls=[]
 const bridge={speechOpenRequest:()=>request,speechOpenAck(id){calls.push(['ack',id]);request=''}}
 const ctx={sessions:{list:{getSnapshot:()=>snapshot},open:id=>calls.push(['open',id])},
  uiSession:{adapter:{resolve:id=>({id})}},uiConversation:{binding:id=>({activate:view=>calls.push(['activate',id,view])})},
  slots:{entries:()=>[{store:'conversation'}],resolveStore:(_,binding)=>({actions:{setView:view=>calls.push(['view',binding.id,view])}})}}
 assert.equal(openPendingConversation(ctx,bridge),true)
 assert.deepEqual(calls,[['open','right'],['activate','right','chat'],['view','right','chat'],['ack','right']])
 assert.equal(openPendingConversation(ctx,bridge),false)
 request='deleted';assert.equal(openPendingConversation(ctx,bridge),false);assert.equal(request,'deleted')
 ctx.slots.entries=()=>[];request='left';assert.equal(openPendingConversation(ctx,bridge),false)
})

// ── 2026-11-14「先开一个会话」误报回归：投影拿不到 current 时用 DOM 标记兜底 ──────────
test('session marker on <html> rescues a projection without current',()=>{
 const marked={documentElement:{getAttribute:name=>name==='data-dsh-session-id'?'left':null}}
 assert.deepEqual(focusedSession({byId:{left:{displayTitle:'左边'}}},null,marked),{id:'left',title:'左边'})
 // 快照有 current 时仍以快照为真源（标记不夺权）
 assert.deepEqual(focusedSession(snapshot,'',marked),{id:'left',title:'左边'})
 // 标记指向已不存在的会话：不猜，返回空
 assert.deepEqual(focusedSession({byId:{}},null,marked),{id:'',title:''})
 // 既无快照也无标记：空（这才是真正的「没有会话」）
 assert.deepEqual(focusedSession({byId:{}},null,undefined),{id:'',title:''})
})
test('a resolvable session still publishes during a reconnect projection gap',()=>{
 let state={phase:'pending',current:'left',byId:{left:{displayTitle:'左边'}}},queued=[]
 let subscription
 const calls=[]
 const doc={visibilityState:'visible',documentElement:{},querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}}
 const env={document:doc,window:{androidBridge:{speechSession(...a){calls.push(a)}},addEventListener(){},removeEventListener(){}},queueMicrotask(fn){queued.push(fn)},MutationObserver:class{observe(){}disconnect(){}}}
 const clean=followCurrentSession({sessions:{list:{getSnapshot:()=>state,subscribe(fn){subscription=fn;return()=>{subscription=null}}}}},{getSnapshot:()=>({status:'ready',value:{enabled:true}}),subscribe(){return()=>{}}},env)
 const flush=()=>{const q=queued;queued=[];q.forEach(fn=>fn())}
 assert.deepEqual(calls,[['left','左边',true]])
 // 重连窗口（phase 非 ready）但 current 还在：照常上报，壳侧不会因此以为「没有会话」
 state={phase:'pending',current:'left',byId:{left:{displayTitle:'左边2'}}};subscription();flush()
 assert.deepEqual(calls.at(-1),['left','左边2',true])
 clean()
})
