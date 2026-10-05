/* Project integration: observe official preview snapshots; reuse native menu actions.
 * Derived from the Codex production integration. Native WebGAL save format is retained. */
(() => {
 'use strict';
 const status=window.releaseRuntime={version:1,checkpoints:[],errors:[],introBlocks:0};
 let stage=null,busy=false,checkpointSeen=0,loadSeen=0,failedChapter=null;
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 const visible=e=>e&&e.getClientRects().length&&(busy?getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden':e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
 const direct=e=>[...e.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim();
 function textButton(text,root=document){return [...root.querySelectorAll('div,button,span')].find(e=>visible(e)&&direct(e)===text);}
 async function until(fn,ms=12000){const end=performance.now()+ms;do{const v=fn();if(v)return v;await delay(40);}while(performance.now()<end);throw Error('Native UI timed out at '+(status.step||'unknown'));}
 async function clickText(text){const e=await until(()=>['存档','读档'].includes(text)?[...document.querySelectorAll('[class*="singleButton"]')].find(e=>e.querySelector('[class*="button_text"]')?.textContent.trim()===text):textButton(text));e.click();await delay(80);}
 function closeMenu(){const e=textButton('返回');if(e)e.click();else document.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2}));}
 const nativeSocket=window.WebSocket;
 window.WebSocket=new Proxy(nativeSocket,{construct(Target,args){
  const socket=new Target(...args),send=socket.send.bind(socket);
  socket.send=function(packet){
   if(typeof packet==='string'&&String(args[0]).includes('/api/webgalsync'))try{const e=JSON.parse(packet);if(e.type==='stage.snapshot.updated'){stage=e.payload.stageState;queueMicrotask(tick);}}catch{}
   return send(packet);
  };return socket;
 }});
 function variable(name){const vars=stage?.GameVar??stage?.gameVar??{};return Number(Array.isArray(vars)?vars.find(v=>v.key===name||v.name===name)?.value:vars[name])||0;}
 async function nativePage(page){
  if(document.querySelector('#Save_content_page_'+page+',#Load_content_page_'+page))return;
  const e=await until(()=>[...document.querySelectorAll('[class*="Save_Load_top_button_text"]')].find(e=>e.textContent.trim()===String(page)));
  status.pageCandidate=e.parentElement.outerHTML; e.click();await delay(600);
  status.pageIds=[...document.querySelectorAll('[id^="Save_content_page"]')].map(e=>e.id);
 }
 async function checkpoint(ch){
  failedChapter=null;delete document.documentElement.dataset.releaseSaveFailed;
  busy=true;document.documentElement.dataset.releaseAutoSaving='true';
  try{
   status.step='checkpoint-choice';await until(()=>[...document.querySelectorAll('#chooseContainer div')].find(e=>!e.children.length&&e.textContent.trim()==='章节自动存档中'));await delay(200);
   status.step='open-save';await clickText('存档');await delay(1200);status.step='page1';await nativePage(1);status.step='save-slot';
   const slot=await until(()=>document.querySelector('#Save_content_page_1')?.children[ch-1]);
   const oldTime=slot.querySelector('[class*="Save_Load_content_element_top_date"]')?.textContent;
   slot.click();await delay(250);
   if(oldTime){const yes=await until(()=>[...document.querySelectorAll('#globalDialogContainer div')].find(e=>direct(e)==='是'));yes.click();}
   status.step='save-image';await until(()=>slot.querySelector('img[alt="Save_img_preview"]'));
   // Native storage writes are asynchronous; wait for its image update and serial flush.
   await delay(350);closeMenu();await delay(120);
   status.checkpoints.push({chapter:ch,slot:ch,at:Date.now(),overwrote:!!oldTime});
   status.step='resume';const choice=await until(()=>[...document.querySelectorAll('#chooseContainer div')].find(e=>!e.children.length&&e.textContent.trim()==='章节自动存档中'));
   choice.click();
  }catch(error){status.errors.push(String(error));console.error('[release checkpoint]',error);
   // Keep the native blocking choice in place; never continue without a successful save.
   failedChapter=ch;document.documentElement.dataset.releaseSaveFailed='true';
   if(!document.getElementById('productionSaveRetry')){
    const retry=document.createElement('button');retry.id='productionSaveRetry';retry.textContent='章节保存失败，点击重试';
    retry.style.cssText='position:fixed;right:18px;top:18px;z-index:2147483647;padding:16px;background:#702d3a;color:white;border:1px solid white;font:16px system-ui;cursor:pointer';
    retry.addEventListener('click',()=>{retry.remove();closeMenu();void checkpoint(ch);});document.body.append(retry);
   }
  }finally{busy=false;delete document.documentElement.dataset.releaseAutoSaving;}
 }
 async function openLoad(){busy=true;try{await clickText('读档');await nativePage(1);}catch(e){status.errors.push(String(e));}finally{busy=false;}}
 function tick(){
  if(variable('_release_news'))document.documentElement.dataset.releaseNews='true';else delete document.documentElement.dataset.releaseNews;
  if(variable('_release_credits'))document.documentElement.dataset.releaseCredits='true';else delete document.documentElement.dataset.releaseCredits;
  const castIntro=document.getElementById('introContainer');
  if(variable('_release_credits')&&castIntro&&getComputedStyle(castIntro).display!=='none')document.documentElement.dataset.releaseCreditsPage='true';else delete document.documentElement.dataset.releaseCreditsPage;
  const nativePageRoot=document.querySelector('[id^=Save_content_page_],[id^=Load_content_page_]');
  if(nativePageRoot&&!nativePageRoot.id.endsWith('_1')){const first=[...document.querySelectorAll('[class*=Save_Load_top_button_text]')].find(e=>e.textContent.trim()==='1');if(first)first.click();}
  const ch=variable('_release_checkpoint');if(!ch)checkpointSeen=0;
  if(ch)document.documentElement.dataset.releaseCheckpoint=String(ch);else delete document.documentElement.dataset.releaseCheckpoint;
  if(ch&&ch!==checkpointSeen&&!busy){checkpointSeen=ch;void checkpoint(ch);}
  const load=variable('_release_open_load');if(!load)loadSeen=0;
  if(load&&!loadSeen&&!busy){loadSeen=load;void openLoad();}
 }
 // Only native checkpoint writes block trusted input. Chapter cards are removed.
 function guard(event){
  if(!busy&&!failedChapter)return;
  if(event.target instanceof Element&&event.target.closest('#productionSaveRetry'))return;
  if(!event.isTrusted)return; // Native menu integration remains usable during autosave.
  if(event.type==='keydown'&&['F11','F12'].includes(event.key))return;
  if(event.type==='keyup'&&event.key==='Control')return;
  event.preventDefault();event.stopImmediatePropagation();status.introBlocks++;
 }
 for(const event of ['pointerdown','pointerup','mousedown','mouseup','click','contextmenu','keydown','keyup','wheel','touchstart','touchend'])window.addEventListener(event,guard,{capture:true,passive:false});
 setInterval(tick,100);
})();
