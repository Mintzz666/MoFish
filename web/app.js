import {SPECIES,MAX_FISH,initial,makeFish,validate,catchUp,eat,canonicalState} from './model.js';
import {createLocalStore,keys} from './storage.js';
import cloudConfig from './config.js';
import {readCloudConfig} from './cloud/config.js';
import {createCloudStack} from './cloud/client.js';
import {createSyncEngine,STATUS} from './cloud/sync.js';
import {parseAuthCallback} from './cloud/auth.js';
import {createAccountUI} from './ui/account.js';

const $=id=>document.getElementById(id);
const canvas=$('tank'),ctx=canvas.getContext('2d');

// ------------------------------------------------------------------ 本地状态与云栈接线
const store=createLocalStore(localStorage);
const config=readCloudConfig(cloudConfig);
const stack=createCloudStack({config,store,emailRedirectTo:location.origin+location.pathname});
let accountUI=null;

let state,loadWarning=false,toastTimer;
{
  let raw=null,saved=null;
  try{raw=localStorage.getItem(keys.guest());saved=store.readGuest();}catch{loadWarning=true;}
  state=saved||initial();
  if(raw!==null&&!saved)loadWarning=true;
}

function populate(){runtime=state.fish.map(f=>({id:f.id,x:W*(.2+Math.random()*.6),y:H*(.35+Math.random()*.42),a:Math.random()*Math.PI*2,speed:25+Math.random()*15,phase:Math.random()*6,turn:0}));}
let active=state.fish[0]?.id;

const engine=createSyncEngine({
  api:stack.api,
  store,
  getState:()=>state,
  setState:next=>{state=next;populate();refresh();},
  initialState:()=>initial(),
  isOnline:()=>navigator.onLine!==false,
  onStatus:s=>{
    const label={[STATUS.GUEST]:'本机存档',[STATUS.CLOUD_OFF]:'本机存档',[STATUS.SYNCING]:'同步中…',[STATUS.SYNCED]:'已同步到云端',[STATUS.OFFLINE]:'离线 · 已存本机',[STATUS.ERROR]:'同步失败 · 已存本机',[STATUS.CONFLICT]:'有冲突待处理',[STATUS.SIGNED_OUT]:'登录已失效 · 已存本机'}[s.status]||'本机存档';
    $('save-status').textContent=label;
    if(s.message&&s.status!==STATUS.SYNCED&&s.status!==STATUS.SYNCING)toast(s.message);
    if(accountUI)accountUI.render();
  },
  onNotice:message=>toast(message)
});

// 未登录（游客）时保留原有的本地离线成长；已登录时成长由服务端按时间结算，
// 避免同一段时间在本地和云端各加一次。见 web/cloud/sync.js 顶部说明。
const hasSession=Boolean(store.readSession());
const absent=hasSession?0:catchUp(state);

// ------------------------------------------------------------------ 渲染与交互（沿用首版实现）
let W=1000,H=480,last=0,runtime=[],foods=[],ripples=[],audioCtx,audioNodes,mutedByVisibility=false;
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
function toast(s){$('toast').textContent=s;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3300);}

/** 本机落盘：游客写 mofish.v1，登录后写该账号+鱼缸的缓存键。不发任何网络请求。 */
let persistedCanonical = canonicalState(state);
function persistLocal(){
  if(engine.isCloud){
    const snap=engine.snapshot;
    if(snap.user&&snap.aquariumId)store.writeAccountState(snap.user.id,snap.aquariumId,state);
    persistedCanonical=canonicalState(state);
    return true;
  }
  const ok=store.writeGuest(state);
  if(ok)persistedCanonical=canonicalState(state);
  return ok;
}
/** 是否有尚未写进 localStorage 的变化（游客存档不希望在“什么都没做”时被创建）。 */
function hasLocalChanges(){return canonicalState(state)!==persistedCanonical;}
function save(){
  state.savedAt=Date.now();
  const ok=persistLocal();
  // 云端写入走 2.5 秒去抖，并且只在内容真的变化时才发请求。
  if(engine.isCloud)engine.markDirty();
  if(ok&&!engine.isCloud)$('save-status').textContent='已保存到本机';
  if(!ok&&!engine.isCloud)$('save-status').textContent='未能保存，请导出';
  return ok;
}

function resize(){const rect=canvas.getBoundingClientRect(),oldW=W,oldH=H;W=rect.width;H=rect.height;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=W*dpr;canvas.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);runtime.forEach(f=>{f.x=f.x/oldW*W;f.y=f.y/oldH*H;});foods=[];}
new ResizeObserver(resize).observe(canvas);resize();populate();
function fishSVG(f){const s=SPECIES[f.species];return `<svg aria-hidden="true" viewBox="0 0 70 44"><path d="M53 22 68 9v26Z" fill="${s.accent}"/><path d="M5 22Q27-3 55 22 27 47 5 22Z" fill="${s.color}"/><path d="m28 11 8-7 10 10" fill="${s.accent}"/><circle cx="14" cy="20" r="2" fill="#234744"/></svg>`;}
function refresh(){
 $('fish-counter').textContent=`${state.fish.length} / ${MAX_FISH} 位小伙伴`;$('add-fish').disabled=state.fish.length>=MAX_FISH;
 $('plant-counter').textContent=`${state.plants} / 8 株水草`;$('add-plant').disabled=state.plants>=8;
 $('night').setAttribute('aria-pressed',String(state.night));$('sound').setAttribute('aria-pressed',String(!!audioCtx&&audioCtx.state==='running'));
 $('scene-label').textContent=state.night?'月光 · 好梦水域':'日光 · 静谧水域';
 const list=$('fish-list');list.replaceChildren();state.fish.forEach(f=>{const b=document.createElement('button');b.className='fish-card';b.innerHTML=fishSVG(f);const info=document.createElement('span'),name=document.createElement('b'),detail=document.createElement('small'),progress=document.createElement('div');name.textContent=f.name;detail.textContent=SPECIES[f.species].name+' · '+(f.growth>=.7?'自在大鱼':f.growth>=.3?'慢慢成长':'小小幼鱼');progress.className='growth';progress.innerHTML=`<i style="width:${Math.max(3,f.growth*100)}%"></i>`;info.append(name,detail,progress);b.append(info);b.setAttribute('aria-label',`查看${f.name}的信息`);b.onclick=()=>openFish(f.id);list.append(b);});
}
function openFish(id){const f=state.fish.find(f=>f.id===id);if(!f)return;active=id;$('fish-title').textContent=f.name;$('fish-info').textContent=`${SPECIES[f.species].name} · 陪伴第 ${Math.max(1,Math.floor((Date.now()-f.born)/86400000)+1)} 天 · 已吃 ${f.meals} 口鱼食 · 成长 ${Math.round(f.growth*100)}%`;$('fish-name').value=f.name;$('fish-dialog').showModal();}
$('rename').onclick=()=>{const f=state.fish.find(f=>f.id===active);if(f){f.name=$('fish-name').value.trim().slice(0,16)||f.name;save();refresh();$('fish-dialog').close();toast('名字记住啦。');}};
function drop(x,y){if(foods.length>36){toast('让小鱼先吃完这一口吧。');return;}for(let i=0;i<5;i++)foods.push({x:x+(Math.random()-.5)*28,y:y+(Math.random()-.5)*15,age:0});ripples.push({x,y,age:0});$('tank-tip').textContent='小鱼正在赶来，今天也有好好吃饭';setTimeout(()=>$('tank-tip').textContent='轻触水面，投下一点小欢喜',4000);}
canvas.addEventListener('pointerdown',e=>{const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;const near=runtime.find(f=>Math.hypot(f.x-x,f.y-y)<22);if(near)openFish(near.id);else drop(x,y);});
canvas.addEventListener('keydown',e=>{if(e.code==='Space'||e.code==='Enter'){e.preventDefault();drop(W*.5,H*.45);}});
$('feed').onclick=()=>drop(W*(.35+Math.random()*.3),H*.33);
$('add-fish').onclick=()=>{if(state.fish.length>=MAX_FISH)return;const f=makeFish(state.fish.length);state.fish.push(f);runtime.push({id:f.id,x:W*.5,y:H*.5,a:Math.random()*6,speed:25+Math.random()*15,phase:Math.random()*6});save();refresh();toast('新朋友游进了你的水世界。');};
$('add-plant').onclick=()=>{if(state.plants<8){state.plants++;save();refresh();toast('水底又多了一点绿。');}};
$('night').onclick=()=>{state.night=!state.night;save();refresh();};
function stopAudio(){if(audioNodes){audioNodes.forEach(n=>{try{n.stop();}catch{}n.disconnect();});audioNodes=null;}}
async function setSound(on){try{if(!on){await audioCtx?.suspend();state.sound=false;}else{if(!audioCtx){audioCtx=new(window.AudioContext||window.webkitAudioContext)();const buffer=audioCtx.createBuffer(1,audioCtx.sampleRate*3,audioCtx.sampleRate),data=buffer.getChannelData(0);let previous=0;for(let i=0;i<data.length;i++){previous=(previous+Math.random()*.04-.02)/1.02;data[i]=previous*3;}const source=audioCtx.createBufferSource();source.buffer=buffer;source.loop=true;const filter=audioCtx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=650;const gain=audioCtx.createGain();gain.gain.value=.12;source.connect(filter).connect(gain).connect(audioCtx.destination);source.start();audioNodes=[source];}await audioCtx.resume();state.sound=true;}save();refresh();}catch{state.sound=false;toast('当前浏览器暂时无法播放水声。');}}
$('sound').onclick=()=>setSound(!(audioCtx?.state==='running'));
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if($('aquarium').requestFullscreen)await $('aquarium').requestFullscreen();else toast('可以将网页添加到主屏幕，获得更沉浸的体验。');}catch{toast('此浏览器暂不支持全屏。');}};
$('storage-button').onclick=()=>$('storage-dialog').showModal();
$('export').onclick=()=>{save();const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`mofish-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('存档已导出，请妥善保存。');};
$('import').onclick=()=>$('import-file').click();
$('import-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>100000)throw Error();const next=validate(JSON.parse(await file.text()));if(!confirm('导入将替换当前鱼缸。确认已经备份，并继续导入吗？'))return;state=next;catchUp(state);foods=[];populate();if(audioCtx)await audioCtx.suspend();const persisted=save();refresh();toast(persisted?'鱼缸已搬过来，小鱼也都在。':'已导入，但无法自动保存，请保留导出的存档。');}catch{toast('这份存档无法读取，请选择MoFish导出的 JSON 文件。');}finally{e.target.value='';}};
// Organic silhouettes are drawn in code; no external art or fonts are needed.
function drawFish(r,f,t){const s=SPECIES[f.species],size=(W<500?18:24)*(1+f.growth*.5),wiggle=Math.sin(t*4+r.phase);ctx.save();ctx.translate(r.x,r.y);ctx.rotate(r.a);ctx.scale(size,size);ctx.globalAlpha=state.night?.8:.95;
 const grad=ctx.createLinearGradient(0,-.5,0,.5);grad.addColorStop(0,s.color);grad.addColorStop(1,s.accent);
 ctx.fillStyle=s.accent;ctx.beginPath();ctx.moveTo(-.7,0);ctx.quadraticCurveTo(-1.15,-.22+wiggle*.15,-1.5,-.52+wiggle*.17);ctx.quadraticCurveTo(-1.35,0+wiggle*.14,-1.5,.52+wiggle*.17);ctx.quadraticCurveTo(-1.1,.23+wiggle*.15,-.7,0);ctx.fill();
 ctx.fillStyle=grad;ctx.beginPath();ctx.moveTo(.95,0);ctx.bezierCurveTo(.55,-.5,-.45,-.55,-.9,0);ctx.bezierCurveTo(-.4,.53,.6,.42,.95,0);ctx.fill();
 ctx.fillStyle=s.color+'80';ctx.beginPath();ctx.moveTo(-.45,-.27);ctx.quadraticCurveTo(-.4,-.75,.15,-.45);ctx.lineTo(.3,-.25);ctx.fill();ctx.beginPath();ctx.moveTo(.08,.2);ctx.quadraticCurveTo(-.1,.7+wiggle*.1,-.5,.5);ctx.lineTo(-.3,.15);ctx.fill();
 ctx.strokeStyle='#ffffff26';ctx.lineWidth=.025;ctx.beginPath();ctx.ellipse(0,0,.6,.23,0,Math.PI,Math.PI*2);ctx.stroke();ctx.fillStyle='#17383b';ctx.beginPath();ctx.arc(.61,-.1,.065,0,7);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(.63,-.12,.022,0,7);ctx.fill();ctx.restore();}
function drawPlant(x,height,t,seed){const base=H-26;ctx.save();ctx.translate(x,base);for(let j=0;j<5;j++){const lean=(j-2)*height*.19,top=height*(.58+j%3*.2),sway=Math.sin(t*.6+seed+j)*9;ctx.strokeStyle=['#365c49','#48735a','#6f9170','#3b705c','#73967b'][j];ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(0,0);ctx.bezierCurveTo(lean*.3,-top*.3,lean+sway,-top*.6,lean+sway,-top);ctx.stroke();for(let k=1;k<6;k++){const u=k/6,px=lean*u+sway*u*u,py=-top*u,dir=k%2?1:-1;ctx.fillStyle=['#487356','#5b8668','#799675'][k%3];ctx.globalAlpha=.78;ctx.beginPath();ctx.moveTo(px,py);ctx.quadraticCurveTo(px+dir*25,py-22,px+dir*22,py-37);ctx.quadraticCurveTo(px+dir*2,py-30,px,py);ctx.fill();}}ctx.restore();}
function render(ts){if(document.hidden){last=0;requestAnimationFrame(render);return;}const t=ts/1000,dt=last?Math.min((ts-last)/1000,.05):0;last=ts;const speedScale=reduceMotion?.45:1;const bg=ctx.createLinearGradient(0,0,0,H);bg.addColorStop(0,state.night?'#102936':'#25565a');bg.addColorStop(.5,state.night?'#10292e':'#16464a');bg.addColorStop(1,state.night?'#102424':'#102f34');ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
 // Soft, moving shafts of light.
 for(let j=0;j<5;j++){const x=W*(.12+j*.2)+Math.sin(t*.08+j)*20;const g=ctx.createLinearGradient(x,0,x+80,H);g.addColorStop(0,state.night?'#b9d5ed07':'#d5ead810');g.addColorStop(1,'#cee5dd00');ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(x-35,0);ctx.lineTo(x+25,0);ctx.lineTo(x+150,H);ctx.lineTo(x-60,H);ctx.fill();}
 for(let j=0;j<37;j++){const x=((Math.sin(j*87)*.5+.5)*W+Math.sin(t*.15+j)*7),y=(j*73-t*(j%3+1)*3)%(H+20);ctx.fillStyle='#e0ecbd';ctx.globalAlpha=.12+j%4*.045;ctx.beginPath();ctx.arc(x,(y+H+20)%(H+20),j%3===0?1.4:.7,0,7);ctx.fill();}ctx.globalAlpha=1;
 // Sand, pebbles, and planted corners.
 const sand=ctx.createLinearGradient(0,H-45,0,H);sand.addColorStop(0,state.night?'#59634b':'#9a9a71');sand.addColorStop(1,state.night?'#3d4c40':'#6d7b5d');ctx.fillStyle=sand;ctx.beginPath();ctx.moveTo(0,H-32);ctx.bezierCurveTo(W*.25,H-53,W*.65,H-19,W,H-39);ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.fill();
 for(let j=0;j<90;j++){ctx.fillStyle=j%2?'#d2c49a44':'#314e3c55';ctx.beginPath();ctx.ellipse((j*137.1)%W,H-5-(j*13%23),1.1+j%2,.7,0,0,7);ctx.fill();}
 for(let i=0;i<state.plants;i++){const positions=[.06,.88,.96,.15,.76,.28,.64,.4];drawPlant(W*positions[i],(W<500?85:110)+(i%3)*28,t,i*2);}
 for(let j=0;j<4;j++){ctx.fillStyle=['#49615b','#5a7066','#66796b','#3b5551'][j];ctx.beginPath();ctx.ellipse(W*(.73+j*.035),H-29,15+j*4,8+j*4,-.3+j*.2,0,7);ctx.fill();}
 for(const food of foods){food.age+=dt;food.y+=dt*7;ctx.fillStyle='#d9c18b';ctx.beginPath();ctx.arc(food.x,food.y,2.3,0,7);ctx.fill();}foods=foods.filter(f=>f.age<20&&f.y<H-38);
 let eaten=false;
 for(let i=0;i<runtime.length;i++){const r=runtime[i],f=state.fish[i];let target=null,best=Infinity;for(const food of foods){const dist=Math.hypot(food.x-r.x,food.y-r.y);if(dist<best){target=food;best=dist;}}
 let desired=r.a;if(target){desired=Math.atan2(target.y-r.y,target.x-r.x);if(best<15){foods.splice(foods.indexOf(target),1);eat(f);eaten=true;}}else{desired+=Math.sin(t*.48+r.phase)*dt*.7;if(r.x<45)desired=0;if(r.x>W-45)desired=Math.PI;if(r.y<H*.27)desired=Math.PI*.5;if(r.y>H-75)desired=-Math.PI*.5;}
 const delta=Math.atan2(Math.sin(desired-r.a),Math.cos(desired-r.a));r.a+=Math.max(-dt*2,Math.min(dt*2,delta));const v=r.speed*(target?1.65:1)*speedScale;r.x+=Math.cos(r.a)*v*dt;r.y+=Math.sin(r.a)*v*dt;r.x=Math.max(15,Math.min(W-15,r.x));r.y=Math.max(55,Math.min(H-50,r.y));drawFish(r,f,t);}
 for(const ripple of ripples){ripple.age+=dt;ctx.strokeStyle=`rgba(211,233,217,${Math.max(0,.35-ripple.age*.25)})`;ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(ripple.x,ripple.y,8+ripple.age*35,3+ripple.age*15,0,0,7);ctx.stroke();}ripples=ripples.filter(r=>r.age<1.4);
 for(let j=0;j<9;j++){const y=H-((t*12+j*51)%H);ctx.strokeStyle='#b8e4d334';ctx.lineWidth=.7;ctx.beginPath();ctx.arc(W*.91+Math.sin(t+j)*5,y,1.5+j%3,0,7);ctx.stroke();}
 const vignette=ctx.createRadialGradient(W*.5,H*.4,H*.1,W*.5,H*.4,W*.7);vignette.addColorStop(0,'#00000000');vignette.addColorStop(1,'#001a2448');ctx.fillStyle=vignette;ctx.fillRect(0,0,W,H);if(eaten){refresh();engine.markDirty();}requestAnimationFrame(render);}
refresh();requestAnimationFrame(render);
// 15 秒一次只写 localStorage，且只在内容真的变了才写；不发起任何网络请求。
// 关键：启动时不主动写游客存档——否则一个从没玩过本机模式的访客，会在首次登录时被
// 误判成「本机已有一份存档」，从而弹出本不必要「保留哪一份」的选择。
setInterval(()=>{if(!document.hidden&&hasLocalChanges())persistLocal();},15000);
document.addEventListener('visibilitychange',()=>{if(document.hidden){save();mutedByVisibility=audioCtx?.state==='running';if(mutedByVisibility)audioCtx.suspend();}else{if(engine.isCloud){engine.syncNow({reason:'visible'}).then(()=>refresh()).catch(()=>{});}else{const hours=catchUp(state);if(hours>.02)refresh();}if(mutedByVisibility)audioCtx?.resume().then(refresh).catch(()=>{});mutedByVisibility=false;}});
window.addEventListener('pagehide',()=>{if(engine.isCloud){persistLocal();engine.flush({reason:'pagehide',keepalive:true});}else save();});
window.addEventListener('online',()=>{engine.handleOnline();refresh();});
window.addEventListener('offline',()=>{engine.handleOffline();});

// ------------------------------------------------------------------ 账号界面与邮件回调
accountUI=createAccountUI({
  auth:stack.auth,
  engine,
  store,
  config,
  onSessionChange:()=>{
    if(!engine.isCloud){
      const guest=store.readGuest()||initial();
      catchUp(guest);
      state=guest;
      populate();
    }
    refresh();
  }
});

const callback=parseAuthCallback({hash:location.hash,search:location.search});
if(callback.kind!=='none'){
  // 立刻把 token 从地址栏移除，避免留在历史记录、截图或后续请求的 Referer 里。
  try{history.replaceState(null,'',location.pathname);}catch{}
  accountUI.handleCallback(callback).catch(()=>toast('链接处理失败，请重新申请邮件。'));
}

if(config.mode==='ready'&&callback.kind!=='session'){
  stack.auth.getSession().then(async restored=>{
    if(restored.ok)await engine.setSession(restored.session);
    else if(restored.reason==='refresh_failed')accountUI.setNotice('登录状态已失效，请重新登录。','warn');
  }).catch(()=>{});
}

if(loadWarning)toast('自动存档暂不可用，或旧存档无法读取；请用导出保留进度。');
else if(absent>.1)toast(`欢迎回来！离开的 ${Math.round(absent*10)/10} 小时里，小鱼又长大了一点。`);
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').then(()=>navigator.serviceWorker.ready).then(()=>{$('offline-status').textContent='离线资源已就绪：下次断网也可以打开鱼缸。';}).catch(()=>{$('offline-status').textContent='当前环境不支持离线缓存，请联网使用。';});else $('offline-status').textContent='此浏览器不支持离线缓存，请联网使用。';
